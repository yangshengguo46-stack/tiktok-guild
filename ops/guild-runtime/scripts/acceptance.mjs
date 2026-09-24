#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runCommand } from '../src/process.mjs';
import { GUILD_EXTENSIONS_CONFIG } from '../src/constants.mjs';
import { inspectApprovedCatalogs, runDoctor } from './doctor.mjs';

export async function runAcceptance({
  packageRoot,
  doctor = (options) => runDoctor(options),
  runTests = runCommand,
} = {}) {
  const root = path.resolve(packageRoot);
  const opsRoot = path.join(root, 'ops', 'guild-runtime');
  const mission = await readFile(path.join(opsRoot, 'config', 'guild-soul.md'), 'utf8');
  assert.ok(mission.trim().length > 0, 'guild mission is empty');
  const runtimeMission = await readFile(path.join(root, 'backend', '.deer-flow', 'SOUL.md'), 'utf8');
  assert.ok(runtimeMission.trim().length > 0, 'runtime guild mission is empty');
  assert.equal(existsSync(path.join(root, 'skills/public/guild-recruitment-lead/SKILL.md')), false);
  const extensions = JSON.parse(await readFile(path.join(opsRoot, 'config', GUILD_EXTENSIONS_CONFIG), 'utf8'));
  assert.deepEqual(Object.keys(extensions.mcpServers), ['guild_operator', 'tkdesk']);

  const testResult = await runTests(process.execPath, ['--test'], { cwd: opsRoot });
  if (testResult.code !== 0) throw new Error(`Package tests failed: ${testResult.stderr || testResult.stdout}`);

  const doctorReport = await doctor({ packageRoot: root });
  if (!doctorReport.ok) {
    const failed = doctorReport.checks.filter(({ ok }) => !ok).map(({ name }) => name).join(', ');
    throw new Error(`Doctor failed: ${failed}`);
  }

  await inspectApprovedCatalogs({ opsRoot });
  const guild = JSON.parse(await readFile(path.join(opsRoot, 'fixtures', 'mcp', 'guild-tools.json'), 'utf8'));
  const tkdesk = JSON.parse(await readFile(path.join(opsRoot, 'fixtures', 'mcp', 'tkdesk-tools.json'), 'utf8'));

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
  const packageRoot = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)));
  runAcceptance({ packageRoot })
    .then((report) => console.log(JSON.stringify(report, null, 2)))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
