import crypto from "node:crypto";
import path from "node:path";
import { spawn } from "node:child_process";

export const CORE_MASTER_KEY_BYTES = 32;
export const CORE_KEYCHAIN_SERVICE = "com.tkdesk.agent.core-bundle";

const DEFAULT_SECURITY_EXECUTABLE = "/usr/bin/security";
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_COMMAND_OUTPUT_BYTES = 16 * 1024;
const ITEM_NOT_FOUND_EXIT_CODES = new Set([44]);
const BASE64_KEY_PATTERN = /^[A-Za-z0-9+/]{43}=$/;

function keyProviderError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function asBuffer(value) {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === "string") return Buffer.from(value, "utf8");
  return Buffer.alloc(0);
}

function trimAsciiWhitespace(buffer) {
  let start = 0;
  let end = buffer.length;
  while (start < end && [9, 10, 13, 32].includes(buffer[start])) start += 1;
  while (end > start && [9, 10, 13, 32].includes(buffer[end - 1])) end -= 1;
  return buffer.subarray(start, end);
}

function decodeStoredKey(stdout) {
  const encoded = trimAsciiWhitespace(stdout);
  const text = encoded.toString("ascii");
  if (!BASE64_KEY_PATTERN.test(text)) {
    throw keyProviderError("钥匙串中的 Core 主密钥格式无效", "core_keychain_key_invalid");
  }
  const key = Buffer.from(text, "base64");
  if (key.length !== CORE_MASTER_KEY_BYTES || key.toString("base64") !== text) {
    key.fill(0);
    throw keyProviderError("钥匙串中的 Core 主密钥长度无效", "core_keychain_key_invalid");
  }
  return key;
}

function itemWasNotFound(result) {
  if (ITEM_NOT_FOUND_EXIT_CODES.has(result.exitCode)) return true;
  const message = result.stderr.toString("utf8");
  return /(?:could not be found|item not found|errsecitemnotfound|-25300)/i.test(message);
}

export function coreKeychainAccount(dataDirectory) {
  if (!dataDirectory) throw keyProviderError("缺少 Core 数据目录", "core_data_directory_required");
  const digest = crypto.createHash("sha256").update(path.resolve(dataDirectory), "utf8").digest("hex");
  return `core-v1-${digest.slice(0, 32)}`;
}

export function runSecurityCommand(executable, args, { stdin = null, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let outputBytes = 0;
    const stdoutChunks = [];
    const stderrChunks = [];
    const child = spawn(executable, args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const collect = (target) => (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_COMMAND_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        finish(() => reject(keyProviderError(
          "macOS 钥匙串返回内容过大",
          "core_keychain_command_failed"
        )));
        return;
      }
      target.push(Buffer.from(chunk));
    };
    child.stdout.on("data", collect(stdoutChunks));
    child.stderr.on("data", collect(stderrChunks));
    child.once("error", () => finish(() => reject(keyProviderError(
      "无法启动 macOS 钥匙串命令",
      "core_keychain_unavailable"
    ))));
    child.once("close", (exitCode) => finish(() => resolve({
      exitCode: Number.isInteger(exitCode) ? exitCode : -1,
      stdout: Buffer.concat(stdoutChunks),
      stderr: Buffer.concat(stderrChunks)
    })));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => reject(keyProviderError(
        "macOS 钥匙串操作超时",
        "core_keychain_timeout"
      )));
    }, timeoutMs);
    timer.unref?.();
    if (stdin === null) {
      child.stdin.end();
    } else {
      child.stdin.end(stdin);
    }
  });
}

export class MacOSKeychainKeyProvider {
  constructor({
    dataDirectory,
    platform = process.platform,
    service = CORE_KEYCHAIN_SERVICE,
    account = null,
    securityExecutable = DEFAULT_SECURITY_EXECUTABLE,
    runner = runSecurityCommand,
    randomBytes = crypto.randomBytes
  } = {}) {
    this.platform = platform;
    this.service = service;
    this.account = account ?? coreKeychainAccount(dataDirectory);
    this.securityExecutable = securityExecutable;
    this.runner = runner;
    this.randomBytes = randomBytes;
  }

  assertSupported() {
    if (this.platform !== "darwin") {
      throw keyProviderError(
        "Core 主密钥仅支持 macOS Keychain；不会降级到本地明文密钥文件",
        "core_keychain_unsupported"
      );
    }
  }

  async run(args, options = {}) {
    this.assertSupported();
    let result;
    try {
      result = await this.runner(this.securityExecutable, args, options);
    } catch (error) {
      if (String(error?.code || "").startsWith("core_keychain_")) throw error;
      throw keyProviderError("macOS 钥匙串不可用", "core_keychain_unavailable");
    }
    return {
      exitCode: Number.isInteger(result?.exitCode) ? result.exitCode : -1,
      stdout: asBuffer(result?.stdout),
      stderr: asBuffer(result?.stderr)
    };
  }

  async getKey() {
    const result = await this.run([
      "find-generic-password",
      "-a", this.account,
      "-s", this.service,
      "-w"
    ]);
    try {
      if (result.exitCode === 0) return decodeStoredKey(result.stdout);
      if (itemWasNotFound(result)) return null;
      throw keyProviderError("无法读取 macOS 钥匙串中的 Core 主密钥", "core_keychain_read_failed");
    } finally {
      result.stdout.fill(0);
      result.stderr.fill(0);
    }
  }

  async getOrCreateKey() {
    const existing = await this.getKey();
    if (existing) return existing;

    const generatedValue = this.randomBytes(CORE_MASTER_KEY_BYTES);
    const generated = Buffer.from(generatedValue);
    if (generatedValue !== generated && generatedValue instanceof Uint8Array) generatedValue.fill(0);
    if (generated.length !== CORE_MASTER_KEY_BYTES) {
      generated.fill(0);
      throw keyProviderError("Core 随机主密钥长度无效", "core_key_generation_failed");
    }
    const passwordInput = Buffer.from(`${generated.toString("base64")}\n`, "ascii");
    try {
      // `-w` is deliberately last. macOS security(1) then reads the value from
      // stdin, so the key never appears in argv, an environment variable, or a
      // daemon log. Do not add `-A`: Keychain keeps its normal access control.
      const result = await this.run([
        "add-generic-password",
        "-a", this.account,
        "-s", this.service,
        "-l", "TKDesk Agent Core Encryption Key",
        "-w"
      ], { stdin: passwordInput });
      try {
        if (result.exitCode === 0) return Buffer.from(generated);
      } finally {
        result.stdout.fill(0);
        result.stderr.fill(0);
      }

      // A concurrent process may have created the item after our initial read.
      // Never overwrite an existing key: retrieve and use the winning item.
      const raced = await this.getKey();
      if (raced) return raced;
      throw keyProviderError("无法创建 macOS 钥匙串 Core 主密钥", "core_keychain_create_failed");
    } finally {
      passwordInput.fill(0);
      generated.fill(0);
    }
  }

  async deleteKey() {
    const result = await this.run([
      "delete-generic-password",
      "-a", this.account,
      "-s", this.service
    ]);
    try {
      if (result.exitCode === 0) return true;
      if (itemWasNotFound(result)) return false;
      throw keyProviderError("无法删除 macOS 钥匙串中的 Core 主密钥", "core_keychain_delete_failed");
    } finally {
      result.stdout.fill(0);
      result.stderr.fill(0);
    }
  }

  async status() {
    if (this.platform !== "darwin") return Object.freeze({ state: "unsupported", available: false });
    try {
      const key = await this.getKey();
      if (!key) return Object.freeze({ state: "missing", available: false });
      key.fill(0);
      return Object.freeze({ state: "ready", available: true });
    } catch {
      return Object.freeze({ state: "unavailable", available: false });
    }
  }
}

export function createDefaultCoreKeyProvider({ dataDirectory } = {}) {
  return new MacOSKeychainKeyProvider({ dataDirectory });
}
