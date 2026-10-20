import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

const EXPECTED_TOOLS = [
  "guild_workspace",
  "guild_creators",
  "guild_recruitment",
  "guild_messaging",
  "guild_operations",
  "guild_revenue",
  "guild_governance",
  "guild_intelligence",
  "guild_onboarding"
];

function startServer() {
  const child = spawn(process.execPath, ["src/server.mjs"], {
    cwd: new URL("..", import.meta.url),
    stdio: ["pipe", "pipe", "pipe"]
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  let buffer = "";
  let stderr = "";
  const pending = new Map();
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    while (buffer.includes("\n")) {
      const newline = buffer.indexOf("\n");
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    }
  });

  let nextId = 1;
  const call = (method, params = undefined) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) })}\n`);
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`MCP response timed out. stderr=${stderr}`));
    }, 2_000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      resolve(message);
    });
  });

  return { child, call };
}

test("the server exposes nine hierarchical domains", async (t) => {
  const server = startServer();
  t.after(() => server.child.kill("SIGTERM"));

  const initialized = await server.call("initialize");
  assert.equal(initialized.result.protocolVersion, "2025-06-18");
  assert.equal(initialized.result.serverInfo.version, "0.15.0");

  const listed = await server.call("tools/list");
  assert.deepEqual(listed.result.tools.map(({ name }) => name), EXPECTED_TOOLS);
  assert.equal(listed.result.tools.some(({ name }) => name.includes("bootstrap")), false);
  const onboarding = listed.result.tools.find(({ name }) => name === "guild_onboarding");
  assert.deepEqual(onboarding.inputSchema.required, ["guild_ref", "child"]);

  const unknown = await server.call("tools/call", {
    name: "bootstrap_guild",
    arguments: {}
  });
  assert.equal(unknown.error.code, -32602);
});
