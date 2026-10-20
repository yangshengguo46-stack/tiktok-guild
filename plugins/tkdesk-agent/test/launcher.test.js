import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(command, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

async function createPluginStub(root) {
  await mkdir(path.join(root, ".codex-plugin"), { recursive: true });
  await mkdir(path.join(root, "mcp"), { recursive: true });
  await writeFile(
    path.join(root, ".codex-plugin", "plugin.json"),
    '{"name":"tkdesk-agent","version":"0.0.0"}\n'
  );
  await writeFile(path.join(root, "mcp", "server.js"), "// launcher test stub\n");
}

async function createFakeNode(filePath) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(
    filePath,
    '#!/bin/sh\nif [ "${1:-}" = "-e" ]; then exit 0; fi\nprintf "%s\\n" "${1:-}"\n'
  );
  await chmod(filePath, 0o755);
}

test("MCP manifest resolves through a stable command instead of a versioned cache path", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "tkdesk-manifest-launcher-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));

  const manifest = JSON.parse(await readFile(path.join(pluginRoot, ".mcp.json"), "utf8"));
  const config = manifest.mcpServers.tkdesk;
  assert.equal(config.command, "/bin/sh");
  assert.equal(config.cwd, "/");
  assert.equal(config.env_vars.includes("TKDESK_AGENT_SOURCE_ROOT"), true);
  assert.doesNotMatch(JSON.stringify(config), /tkdesk-agent\/0\.2\.4|\.codex\/plugins\/cache\/personal\/tkdesk-agent\/\d/);

  const home = path.join(temporaryRoot, "home");
  const sourceLauncher = path.join(home, "plugins", "tkdesk-agent", "scripts", "launch_mcp");
  await mkdir(path.dirname(sourceLauncher), { recursive: true });
  await writeFile(sourceLauncher, '#!/bin/sh\nprintf "stable:%s\\n" "$0"\n');
  await chmod(sourceLauncher, 0o755);

  const environment = { ...process.env, HOME: home };
  delete environment.TKDESK_AGENT_SOURCE_ROOT;
  const result = await run(config.command, config.args, {
    cwd: config.cwd,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"]
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.trim(), `stable:${sourceLauncher}`);
});

test("cached launcher prefers an explicit stable source root", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "tkdesk-cached-launcher-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));

  const sourceRoot = path.join(temporaryRoot, "stable source");
  const cachedRoot = path.join(temporaryRoot, "cache", "personal", "tkdesk-agent", "0.2.4+old");
  const cachedLauncher = path.join(cachedRoot, "scripts", "launch_mcp");
  const fakeNode = path.join(temporaryRoot, "runtime", "fake node");
  await createPluginStub(sourceRoot);
  await mkdir(path.dirname(cachedLauncher), { recursive: true });
  await copyFile(path.join(pluginRoot, "scripts", "launch_mcp"), cachedLauncher);
  await chmod(cachedLauncher, 0o755);
  await createFakeNode(fakeNode);

  const result = await run(cachedLauncher, [], {
    env: {
      ...process.env,
      HOME: path.join(temporaryRoot, "empty-home"),
      TKDESK_AGENT_SOURCE_ROOT: sourceRoot,
      TKDESK_NODE_PATH: fakeNode
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.trim(), path.join(sourceRoot, "mcp", "server.js"));
});

test("launcher remains self-contained when no stable source checkout exists", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "tkdesk-package-launcher-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));

  const packagedRoot = path.join(temporaryRoot, "packaged-plugin");
  const packagedLauncher = path.join(packagedRoot, "scripts", "launch_mcp");
  const fakeNode = path.join(temporaryRoot, "runtime", "node");
  await createPluginStub(packagedRoot);
  await mkdir(path.dirname(packagedLauncher), { recursive: true });
  await copyFile(path.join(pluginRoot, "scripts", "launch_mcp"), packagedLauncher);
  await chmod(packagedLauncher, 0o755);
  await createFakeNode(fakeNode);

  const environment = {
    ...process.env,
    HOME: path.join(temporaryRoot, "empty-home"),
    TKDESK_NODE_PATH: fakeNode
  };
  delete environment.TKDESK_AGENT_SOURCE_ROOT;
  const result = await run(packagedLauncher, [], {
    env: environment,
    stdio: ["ignore", "pipe", "pipe"]
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.trim(), path.join(packagedRoot, "mcp", "server.js"));
});
