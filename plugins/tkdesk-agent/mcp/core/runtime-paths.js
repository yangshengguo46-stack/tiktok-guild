import os from "node:os";
import path from "node:path";

export const PROTOCOL_VERSION = "tkdesk.discovery.rpc.v6";
export const DAEMON_VERSION = "0.9.0";

export function defaultDataDirectory() {
  if (process.env.TKDESK_AGENT_DATA_DIR) return path.resolve(process.env.TKDESK_AGENT_DATA_DIR);
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "TKDesk Agent");
  if (process.platform === "win32") return path.join(process.env.LOCALAPPDATA || os.homedir(), "TKDesk Agent");
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "tkdesk-agent");
}

export function runtimePaths(dataDirectory = defaultDataDirectory()) {
  const runtimeDirectory = path.join(dataDirectory, "runtime");
  const coreDirectory = path.join(dataDirectory, "core");
  return {
    dataDirectory,
    runtimeDirectory,
    coreDirectory,
    statePath: path.join(runtimeDirectory, "daemon.json"),
    lockPath: path.join(runtimeDirectory, "daemon.lock"),
    logPath: path.join(runtimeDirectory, "daemon.log"),
    coreBundlePath: path.join(coreDirectory, "Core.tkd"),
    databasePath: path.join(dataDirectory, "tkdesk.sqlite3"),
    profilesDirectory: path.join(dataDirectory, "browser-profiles"),
    exportsDirectory: path.join(dataDirectory, "exports"),
    handoffsDirectory: path.join(dataDirectory, "handoffs")
  };
}
