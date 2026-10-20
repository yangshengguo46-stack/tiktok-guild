#!/usr/bin/env node

import crypto from "node:crypto";
import { createInterface } from "node:readline/promises";
import { CoreConfigStore } from "../mcp/core/core-config-store.js";
import { defaultDataDirectory } from "../mcp/core/runtime-paths.js";

const PROVENANCE = "user_owned_local_secure_terminal";
const MAX_SECRET_BYTES = 4_096;

function provisionError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function requireSecureTerminal() {
  if (process.argv.length !== 2) {
    throw provisionError(
      "本工具不接受任何命令行参数；请直接运行脚本并在本机终端中交互操作",
      "provision_arguments_rejected"
    );
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY || typeof process.stdin.setRawMode !== "function") {
    throw provisionError(
      "本工具仅接受本机 TTY 交互；管道、重定向和普通 stdin 均被拒绝",
      "provision_tty_required"
    );
  }
}

async function askVisible(question) {
  const terminal = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  try {
    return String(await terminal.question(question)).trim();
  } finally {
    terminal.close();
  }
}

function askHiddenBuffer(question) {
  return new Promise((resolve, reject) => {
    const bytes = [];
    const wasRaw = Boolean(process.stdin.isRaw);
    const wasPaused = process.stdin.isPaused();
    let finished = false;

    const restore = () => {
      process.stdin.removeListener("data", onData);
      if (!wasRaw) process.stdin.setRawMode(false);
      if (wasPaused) process.stdin.pause();
    };
    const finish = (callback) => {
      if (finished) return;
      finished = true;
      restore();
      process.stdout.write("\n");
      callback();
    };
    const fail = (message, code) => finish(() => {
      bytes.fill(0);
      reject(provisionError(message, code));
    });
    const onData = (chunk) => {
      const data = Buffer.from(chunk);
      try {
        for (const byte of data) {
          if (byte === 3) {
            fail("用户取消了本机授权配置", "provision_cancelled");
            return;
          }
          if (byte === 13 || byte === 10) {
            finish(() => {
              const value = Buffer.from(bytes);
              bytes.fill(0);
              resolve(value);
            });
            return;
          }
          if (byte === 8 || byte === 127) {
            if (bytes.length) {
              bytes[bytes.length - 1] = 0;
              bytes.pop();
            }
            continue;
          }
          if (byte < 0x21 || byte > 0x7e) {
            fail("授权值只能包含可打印 ASCII 字符", "provision_secret_character_invalid");
            return;
          }
          if (bytes.length >= MAX_SECRET_BYTES) {
            fail("授权值过长", "provision_secret_too_long");
            return;
          }
          bytes.push(byte);
        }
      } finally {
        data.fill(0);
        if (Buffer.isBuffer(chunk) && chunk !== data) chunk.fill(0);
      }
    };

    process.stdout.write(question);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}

function authorizationSummary(status) {
  const authorization = status.mobileAuthorization ?? {};
  return {
    coreState: status.state,
    authorizationState: authorization.state ?? "invalid",
    configured: authorization.configured === true,
    usable: authorization.usable === true,
    marketRegion: authorization.marketRegion ?? null,
    countryCodes: Array.isArray(authorization.countryCodes) ? authorization.countryCodes : [],
    installedAt: authorization.installedAt ?? null,
    expiresAt: authorization.expiresAt ?? null,
    secretValuesExposed: false
  };
}

async function showStatus(store) {
  process.stdout.write(`${JSON.stringify(authorizationSummary(await store.status()), null, 2)}\n`);
}

async function installAuthorization(store) {
  const marketRegion = (await askVisible("大区 [MENA]：")) || "MENA";
  const countryInput = (await askVisible("授权国家（逗号分隔）[SA,QA,EG]：")) || "SA,QA,EG";
  const countryCodes = countryInput.split(",").map((value) => value.trim()).filter(Boolean);
  const expiresAt = (await askVisible("过期时间（ISO 8601，可留空）：")) || null;

  let first = null;
  let second = null;
  try {
    first = await askHiddenBuffer("输入用户自有移动授权（不会回显）：");
    second = await askHiddenBuffer("再次输入确认（不会回显）：");
    if (first.length !== second.length || !crypto.timingSafeEqual(first, second)) {
      throw provisionError("两次输入不一致，未保存", "provision_secret_mismatch");
    }
    const status = await store.installMobileAuthorization({
      value: first,
      marketRegion,
      countryCodes,
      expiresAt,
      provenance: PROVENANCE
    });
    process.stdout.write("移动授权已加密保存；明文未写入数据库、日志或命令历史。\n");
    process.stdout.write(`${JSON.stringify(authorizationSummary(status), null, 2)}\n`);
  } finally {
    first?.fill(0);
    second?.fill(0);
  }
}

async function clearAuthorization(store) {
  const confirmation = await askVisible("输入 CLEAR 确认清除本机移动授权：");
  if (confirmation !== "CLEAR") {
    process.stdout.write("已取消，未修改配置。\n");
    return;
  }
  const status = await store.clearMobileAuthorization();
  process.stdout.write("本机移动授权已清除。\n");
  process.stdout.write(`${JSON.stringify(authorizationSummary(status), null, 2)}\n`);
}

async function main() {
  requireSecureTerminal();
  const store = new CoreConfigStore({ dataDirectory: defaultDataDirectory() });

  process.stdout.write([
    "TKDesk Agent 本机移动授权配置",
    "1) 安装或更新用户自有授权",
    "2) 查看脱敏状态",
    "3) 清除授权",
    "0) 退出",
    ""
  ].join("\n"));
  const selection = await askVisible("选择：");
  if (selection === "1") await installAuthorization(store);
  else if (selection === "2") await showStatus(store);
  else if (selection === "3") await clearAuthorization(store);
  else if (selection !== "0") throw provisionError("无效选择", "provision_selection_invalid");
}

main().catch((error) => {
  const code = /^[a-z0-9_]{1,80}$/i.test(String(error?.code || ""))
    ? String(error.code)
    : "provision_failed";
  process.stderr.write(`配置失败（${code}）。未输出或保存输入的授权明文。\n`);
  process.exitCode = 1;
});
