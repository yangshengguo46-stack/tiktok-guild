import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the package exposes one v0.15 MCP with unified agent operations", async () => {
  const manifest = JSON.parse(await readFile(new URL("../.codex-plugin/plugin.json", import.meta.url)));
  const mcp = JSON.parse(await readFile(new URL("../.mcp.json", import.meta.url)));

  assert.equal(manifest.name, "tiktok-live-guild-operator");
  assert.match(manifest.version, /^0\.15\.0(?:\+codex\.[A-Za-z0-9.-]+)?$/u);
  assert.equal(manifest.mcpServers, "./.mcp.json");
  assert.deepEqual(manifest.interface.capabilities, ["Browser control", "Read", "Agent-operated writes", "Approval-gated creator removal"]);
  assert.deepEqual(Object.keys(mcp.mcpServers), ["tiktok-live-guild-operator"]);
  assert.equal(mcp.mcpServers["tiktok-live-guild-operator"].args[0], "./src/server.mjs");
});
