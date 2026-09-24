#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { spawnForeground } from '../src/process.mjs';
import { GUILD_EXTENSIONS_CONFIG } from '../src/constants.mjs';
import { ensureGuildSoul } from '../src/guild-soul.mjs';
import { formatDoctorReport, runDoctor } from './doctor.mjs';

export async function startRuntime({
  packageRoot,
  installSoul = ensureGuildSoul,
  doctor = (options) => runDoctor(options),
  start = spawnForeground,
} = {}) {
  const root = path.resolve(packageRoot);
  const opsRoot = path.join(root, 'ops', 'guild-runtime');
  const pnpmBinRoot = path.join(opsRoot, '.runtime', 'tools', 'pnpm', 'node_modules', '.bin');
  await installSoul({ packageRoot: root });
  const report = await doctor({ packageRoot: root });
  if (!report.ok) {
    const failed = report.checks.filter(({ ok }) => !ok).map(({ name }) => name).join(', ');
    throw new Error(`Doctor failed: ${failed}.\n${formatDoctorReport(report)}`);
  }
  const childEnv = {
    ...process.env,
    CI: 'true',
    // The workbench is local-only during this phase, so /setup does not block
    // product verification. The backend ignores this flag in explicit production mode.
    DEER_FLOW_AUTH_DISABLED: '1',
    PATH: `${pnpmBinRoot}${path.delimiter}${process.env.PATH ?? ''}`,
    DEER_FLOW_CONFIG_PATH: path.join(opsRoot, 'config', 'config.yaml'),
    DEER_FLOW_EXTENSIONS_CONFIG_PATH: path.join(opsRoot, 'config', GUILD_EXTENSIONS_CONFIG),
    DEER_FLOW_SKILLS_PATH: path.join(root, 'skills'),
    DEER_FLOW_HOME: path.join(root, 'backend', '.deer-flow'),
    DEER_FLOW_SOCIAL_ASSETS_PATH: path.join(
      root,
      'docs',
      'product',
      'creator-agent-final-persona-rev1',
    ),
  };
  const environmentMarker = (childEnv.DEER_FLOW_ENV ?? childEnv.ENVIRONMENT ?? '').trim().toLowerCase();
  if (childEnv.DEER_FLOW_AUTH_DISABLED === '1' && !['prod', 'production'].includes(environmentMarker)) {
    console.warn(
      'Guild runtime local mode: authentication setup is bypassed with a synthetic admin. '
        + 'Remove DEER_FLOW_AUTH_DISABLED before production deployment.',
    );
  }
  const code = await start('make', ['start'], {
    cwd: root,
    env: childEnv,
  });
  if (code !== 0 && code !== 130 && code !== 143) throw new Error(`DeerFlow exited with code ${code}.`);
  return { code };
}

function isMain() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMain()) {
  const packageRoot = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)));
  startRuntime({ packageRoot }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
