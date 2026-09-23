#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { probeMcpServer, runCommand } from '../src/process.mjs';
import { runDoctor } from './doctor.mjs';

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, stableValue(nested)]),
  );
}

function schemaDigest(schema) {
  return createHash('sha256').update(JSON.stringify(stableValue(schema))).digest('hex');
}

function snapshotCatalog(catalog) {
  return {
    tools: catalog.tools.map((tool) => ({
      name: tool.name,
      input_schema_sha256: tool.input_schema_sha256 ?? schemaDigest(tool.inputSchema),
    })),
  };
}

async function defaultProbeCatalogs(packageRoot) {
  const extensions = JSON.parse(
    await readFile(path.join(packageRoot, 'config', 'extensions_config.json'), 'utf8'),
  );
  const guildConfig = extensions.mcpServers.guild_operator;
  const tkdeskConfig = extensions.mcpServers.tkdesk;
  const [guild, tkdesk] = await Promise.all([
    probeMcpServer({
      command: guildConfig.command === 'node' ? process.execPath : guildConfig.command,
      args: guildConfig.args,
      cwd: guildConfig.cwd,
    }),
    probeMcpServer({
      command: tkdeskConfig.command,
      args: tkdeskConfig.args,
      cwd: tkdeskConfig.cwd,
      env: { ...process.env, TKDESK_AGENT_SOURCE_ROOT: tkdeskConfig.cwd },
    }),
  ]);
  return { guild, tkdesk };
}

export async function runAcceptance({
  packageRoot,
  doctor = (options) => runDoctor(options),
  probeCatalogs = () => defaultProbeCatalogs(packageRoot),
  runTests = runCommand,
} = {}) {
  const root = path.resolve(packageRoot);
  const mission = await readFile(path.join(root, 'config', 'guild-soul.md'), 'utf8');
  assert.ok(mission.trim().length > 0, 'guild mission is empty');
  const runtimeMission = await readFile(path.join(root, '.runtime', 'deerflow-home', 'SOUL.md'), 'utf8');
  assert.ok(runtimeMission.trim().length > 0, 'runtime guild mission is empty');
  assert.equal(existsSync(path.join(root, 'skills/public/guild-recruitment-lead/SKILL.md')), false);
  const extensions = JSON.parse(await readFile(path.join(root, 'config', 'extensions_config.json'), 'utf8'));
  assert.deepEqual(Object.keys(extensions.mcpServers), ['guild_operator', 'tkdesk']);

  const testResult = await runTests(process.execPath, ['--test'], { cwd: root });
  if (testResult.code !== 0) throw new Error(`Package tests failed: ${testResult.stderr || testResult.stdout}`);

  const doctorReport = await doctor({ packageRoot: root });
  if (!doctorReport.ok) {
    const failed = doctorReport.checks.filter(({ ok }) => !ok).map(({ name }) => name).join(', ');
    throw new Error(`Doctor failed: ${failed}`);
  }

  const expectedGuild = JSON.parse(await readFile(path.join(root, 'fixtures', 'mcp', 'guild-tools.json'), 'utf8'));
  const expectedTkdesk = JSON.parse(await readFile(path.join(root, 'fixtures', 'mcp', 'tkdesk-tools.json'), 'utf8'));
  const actual = await probeCatalogs();
  const guild = snapshotCatalog(actual.guild);
  const tkdesk = snapshotCatalog(actual.tkdesk);
  assert.deepEqual(guild, expectedGuild, 'Guild Operator tool catalog or schema changed');
  assert.deepEqual(tkdesk, expectedTkdesk, 'TKDesk tool catalog or schema changed');

  return {
    ok: true,
    mcpServers: 2,
    guildTools: guild.tools.length,
    tkdeskTools: tkdesk.tools.length,
    nativeGuildLead: true,
  };
}

function isMain() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMain()) {
  const packageRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
  runAcceptance({ packageRoot })
    .then((report) => console.log(JSON.stringify(report, null, 2)))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
