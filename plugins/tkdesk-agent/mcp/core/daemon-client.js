import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { DAEMON_VERSION, PROTOCOL_VERSION, defaultDataDirectory, runtimePaths } from "./runtime-paths.js";

const START_TIMEOUT_MS = 20_000;
const RPC_TIMEOUT_MS = 120_000;
const RETRYABLE_RPC_METHODS = new Set([
  "ping",
  "status",
  "core_configuration_status",
  "mobile_authorization_status",
  "session_status",
  "collection_route_status",
  "get_run",
  "list_runs",
  "preview_candidates",
  "query_candidates",
  "creator_research_status",
  "audit_events"
]);

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export function isTransportRetryAllowed(method) {
  return RETRYABLE_RPC_METHODS.has(String(method));
}

async function readState(statePath) {
  try {
    const value = JSON.parse(await readFile(statePath, "utf8"));
    if (!Number.isInteger(value.port) || !value.secret) return null;
    return value;
  } catch {
    return null;
  }
}

async function readPluginVersion(pluginRoot) {
  try {
    const manifest = JSON.parse(await readFile(path.join(pluginRoot, ".codex-plugin", "plugin.json"), "utf8"));
    return String(manifest.version || DAEMON_VERSION);
  } catch {
    return DAEMON_VERSION;
  }
}

export function requestRpc(state, method, params = {}, timeoutMs = RPC_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify({
      id: crypto.randomUUID(),
      method,
      params
    }));
    const request = http.request({
      host: "127.0.0.1",
      port: state.port,
      path: "/rpc",
      method: "POST",
      headers: {
        authorization: `Bearer ${state.secret}`,
        "content-type": "application/json",
        "content-length": payload.length
      },
      timeout: timeoutMs
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        let body;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          reject(new Error(`守护进程返回了无效响应（HTTP ${response.statusCode}）`));
          return;
        }
        if (response.statusCode !== 200 || body.error) {
          const error = new Error(body.error?.message || `守护进程请求失败（HTTP ${response.statusCode}）`);
          error.code = body.error?.code;
          error.details = body.error?.details;
          reject(error);
          return;
        }
        resolve(body.result);
      });
    });
    request.on("timeout", () => request.destroy(new Error(`守护进程调用 ${method} 超时`)));
    request.on("error", reject);
    request.end(payload);
  });
}

async function pingState(state, expectedPluginVersion) {
  try {
    const result = await requestRpc(state, "ping", {}, 1_500);
    return result?.protocolVersion === PROTOCOL_VERSION
      && result?.daemonVersion === DAEMON_VERSION
      && (!expectedPluginVersion || result?.pluginVersion === expectedPluginVersion);
  } catch {
    return false;
  }
}

async function removeStaleLock(lockPath) {
  try {
    const info = await stat(lockPath);
    if (Date.now() - info.mtimeMs > START_TIMEOUT_MS) await unlink(lockPath);
  } catch {
    // A missing lock is the common path.
  }
}

async function acquireStartLock(lockPath) {
  await removeStaleLock(lockPath);
  try {
    return await open(lockPath, "wx", 0o600);
  } catch (error) {
    if (error.code === "EEXIST") return null;
    throw error;
  }
}

function launchDaemon({ pluginRoot, dataDirectory, logPath }) {
  const logDescriptor = openSync(logPath, "a", 0o600);
  try {
    const child = spawn(process.execPath, [path.join(pluginRoot, "daemon", "server.js")], {
      detached: true,
      stdio: ["ignore", logDescriptor, logDescriptor],
      env: {
        ...process.env,
        TKDESK_AGENT_DATA_DIR: dataDirectory,
        TKDESK_AGENT_PLUGIN_ROOT: pluginRoot
      }
    });
    child.unref();
  } finally {
    closeSync(logDescriptor);
  }
}

export async function ensureDaemon({
  pluginRoot,
  dataDirectory = defaultDataDirectory(),
  timeoutMs = START_TIMEOUT_MS
} = {}) {
  if (!pluginRoot) throw new Error("缺少插件根目录，无法启动 TKDesk 守护进程");
  const paths = runtimePaths(dataDirectory);
  const expectedPluginVersion = await readPluginVersion(pluginRoot);
  await mkdir(paths.runtimeDirectory, { recursive: true, mode: 0o700 });

  let state = await readState(paths.statePath);
  if (state && await pingState(state, expectedPluginVersion)) return state;

  const deadline = Date.now() + timeoutMs;
  const lock = await acquireStartLock(paths.lockPath);
  if (lock) {
    try {
      state = await readState(paths.statePath);
      if (state) {
        try {
          await requestRpc(state, "shutdown", {}, 1_000);
          const shutdownDeadline = Date.now() + 5_000;
          while (Date.now() < shutdownDeadline && await pingState(state)) await delay(100);
        } catch { /* stale process/state */ }
        await unlink(paths.statePath).catch(() => {});
      }
      launchDaemon({ pluginRoot, dataDirectory, logPath: paths.logPath });
      while (Date.now() < deadline) {
        state = await readState(paths.statePath);
        if (state && await pingState(state, expectedPluginVersion)) return state;
        await delay(150);
      }
      throw new Error(`TKDesk 守护进程启动超时。请查看日志：${paths.logPath}`);
    } finally {
      await lock.close();
      await unlink(paths.lockPath).catch(() => {});
    }
  }

  while (Date.now() < deadline) {
    state = await readState(paths.statePath);
    if (state && await pingState(state, expectedPluginVersion)) return state;
    await delay(150);
  }
  throw new Error(`TKDesk 守护进程启动超时。请查看日志：${paths.logPath}`);
}

export class DaemonClient {
  constructor({ pluginRoot, dataDirectory = defaultDataDirectory() }) {
    this.pluginRoot = pluginRoot;
    this.dataDirectory = dataDirectory;
    this.state = null;
    this.pluginVersion = null;
  }

  async call(method, params = {}, timeoutMs = RPC_TIMEOUT_MS) {
    this.pluginVersion ??= await readPluginVersion(this.pluginRoot);
    if (!this.state || !await pingState(this.state, this.pluginVersion)) {
      this.state = await ensureDaemon({ pluginRoot: this.pluginRoot, dataDirectory: this.dataDirectory });
    }
    try {
      return await requestRpc(this.state, method, params, timeoutMs);
    } catch (error) {
      if (!isTransportRetryAllowed(method)
        || !["ECONNREFUSED", "ECONNRESET", "EPIPE"].includes(error.code)) throw error;
      this.state = await ensureDaemon({ pluginRoot: this.pluginRoot, dataDirectory: this.dataDirectory });
      return requestRpc(this.state, method, params, timeoutMs);
    }
  }
}
