import assert from 'node:assert/strict';
import test from 'node:test';

import { inspectPinnedPnpm, runDoctor } from '../scripts/doctor.mjs';
import { startRuntime } from '../scripts/start.mjs';

const REQUIRED_CHECKS = [
  'node',
  'git',
  'runtime_config',
  'guild_operator_root',
  'tkdesk_root',
  'tkdesk_launcher',
  'guild_dependencies',
  'deerflow_head',
  'product_patches',
  'deerflow_pnpm',
  'guild_mcp',
  'tkdesk_mcp',
];

test('doctor reports every required failed check by name', async () => {
  const adapters = Object.fromEntries(REQUIRED_CHECKS.map((name) => [name, async () => {
    throw new Error(`${name} failed`);
  }]));

  const report = await runDoctor({
    packageRoot: '/tmp/deerflow-native-guild',
    adapters,
  });

  assert.equal(report.ok, false);
  assert.deepEqual(report.checks.map(({ name }) => name), REQUIRED_CHECKS);
  assert.deepEqual(report.checks.map(({ ok }) => ok), REQUIRED_CHECKS.map(() => false));
  for (const check of report.checks) assert.match(check.detail, new RegExp(check.name));
});

test('doctor reports a complete healthy runtime', async () => {
  const adapters = Object.fromEntries(REQUIRED_CHECKS.map((name) => [name, async () => ({
    detail: `${name} ok`,
  })]));

  const report = await runDoctor({
    packageRoot: '/tmp/deerflow-native-guild',
    adapters,
  });

  assert.equal(report.ok, true);
  assert.deepEqual(report.checks.map(({ ok }) => ok), REQUIRED_CHECKS.map(() => true));
});

test('pnpm inspection runs inside the pinned DeerFlow frontend', async () => {
  const calls = [];
  const result = await inspectPinnedPnpm({
    pnpmBinary: '/tmp/runtime/pnpm',
    frontendRoot: '/tmp/runtime/deer-flow/frontend',
    run: async (command, args, options) => {
      calls.push({ command, args, options });
      return { code: 0, stdout: '10.26.2\n', stderr: '' };
    },
  });

  assert.deepEqual(result, { detail: 'pnpm 10.26.2' });
  assert.deepEqual(calls, [{
    command: '/tmp/runtime/pnpm',
    args: ['--version'],
    options: { cwd: '/tmp/runtime/deer-flow/frontend' },
  }]);
});

test('start never invokes DeerFlow when doctor fails', async () => {
  let starts = 0;
  await assert.rejects(
    startRuntime({
      packageRoot: '/tmp/deerflow-native-guild',
      doctor: async () => ({
        ok: false,
        checks: [{ name: 'guild_mcp', ok: false, detail: 'catalog mismatch' }],
      }),
      start: async () => { starts += 1; return 0; },
    }),
    /doctor failed.*guild_mcp/i,
  );
  assert.equal(starts, 0);
});

test('start exports only the native DeerFlow paths and launches make start', async () => {
  const calls = [];
  await startRuntime({
    packageRoot: '/tmp/deerflow-native-guild',
    doctor: async () => ({ ok: true, checks: [] }),
    start: async (command, args, options) => {
      calls.push({ command, args, options });
      return 0;
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'make');
  assert.deepEqual(calls[0].args, ['start']);
  assert.equal(calls[0].options.cwd, '/tmp/deerflow-native-guild/.runtime/deer-flow');
  assert.equal(calls[0].options.env.DEER_FLOW_CONFIG_PATH, '/tmp/deerflow-native-guild/config/config.yaml');
  assert.equal(calls[0].options.env.DEER_FLOW_EXTENSIONS_CONFIG_PATH, '/tmp/deerflow-native-guild/config/extensions_config.json');
  assert.equal(calls[0].options.env.DEER_FLOW_SKILLS_PATH, '/tmp/deerflow-native-guild/skills');
  assert.equal(calls[0].options.env.DEER_FLOW_HOME, '/tmp/deerflow-native-guild/.runtime/deerflow-home');
  assert.equal(calls[0].options.env.CI, 'true');
  assert.equal(
    calls[0].options.env.PATH.startsWith('/tmp/deerflow-native-guild/.runtime/tools/pnpm/node_modules/.bin:'),
    true,
  );
});
