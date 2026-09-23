#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { spawnForeground } from '../src/process.mjs';
import { formatDoctorReport, runDoctor } from './doctor.mjs';

export async function startRuntime({
  packageRoot,
  doctor = (options) => runDoctor(options),
  start = spawnForeground,
} = {}) {
  const root = path.resolve(packageRoot);
  const pnpmBinRoot = path.join(root, '.runtime', 'tools', 'pnpm', 'node_modules', '.bin');
  const report = await doctor({ packageRoot: root });
  if (!report.ok) {
    const failed = report.checks.filter(({ ok }) => !ok).map(({ name }) => name).join(', ');
    throw new Error(`Doctor failed: ${failed}.\n${formatDoctorReport(report)}`);
  }
  const code = await start('make', ['start'], {
    cwd: path.join(root, '.runtime', 'deer-flow'),
    env: {
      ...process.env,
      CI: 'true',
      PATH: `${pnpmBinRoot}${path.delimiter}${process.env.PATH ?? ''}`,
      DEER_FLOW_CONFIG_PATH: path.join(root, 'config', 'config.yaml'),
      DEER_FLOW_EXTENSIONS_CONFIG_PATH: path.join(root, 'config', 'extensions_config.json'),
      DEER_FLOW_SKILLS_PATH: path.join(root, 'skills'),
      DEER_FLOW_HOME: path.join(root, '.runtime', 'deerflow-home'),
    },
  });
  if (code !== 0 && code !== 130 && code !== 143) throw new Error(`DeerFlow exited with code ${code}.`);
  return { code };
}

function isMain() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMain()) {
  const packageRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
  startRuntime({ packageRoot }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
