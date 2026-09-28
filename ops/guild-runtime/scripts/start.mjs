#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { spawnForeground } from '../src/process.mjs';
import { buildRuntimeEnvironment } from '../src/runtime-environment.mjs';
import { ensureGuildSoul } from '../src/guild-soul.mjs';
import { formatDoctorReport, runDoctor } from './doctor.mjs';

export async function startRuntime({
  packageRoot,
  installSoul = ensureGuildSoul,
  doctor = (options) => runDoctor(options),
  start = spawnForeground,
} = {}) {
  const root = path.resolve(packageRoot);
  await installSoul({ packageRoot: root });
  const report = await doctor({ packageRoot: root });
  if (!report.ok) {
    const failed = report.checks.filter(({ ok }) => !ok).map(({ name }) => name).join(', ');
    throw new Error(`Doctor failed: ${failed}.\n${formatDoctorReport(report)}`);
  }
  const childEnv = buildRuntimeEnvironment({ packageRoot: root });
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
