import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { inspectPersonaCatalog, inspectPinnedPnpm, runDoctor } from '../scripts/doctor.mjs';
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
  'persona_catalog',
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
      installSoul: async () => {},
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
  const soulInstalls = [];
  await startRuntime({
    packageRoot: '/tmp/deerflow-native-guild',
    installSoul: async (options) => { soulInstalls.push(options); },
    doctor: async () => ({ ok: true, checks: [] }),
    start: async (command, args, options) => {
      calls.push({ command, args, options });
      return 0;
    },
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(soulInstalls, [{ packageRoot: '/tmp/deerflow-native-guild' }]);
  assert.equal(calls[0].command, 'make');
  assert.deepEqual(calls[0].args, ['start']);
  assert.equal(calls[0].options.cwd, '/tmp/deerflow-native-guild/.runtime/deer-flow');
  assert.equal(calls[0].options.env.DEER_FLOW_CONFIG_PATH, '/tmp/deerflow-native-guild/config/config.yaml');
  assert.equal(calls[0].options.env.DEER_FLOW_EXTENSIONS_CONFIG_PATH, '/tmp/deerflow-native-guild/config/extensions_config.json');
  assert.equal(calls[0].options.env.DEER_FLOW_SKILLS_PATH, '/tmp/deerflow-native-guild/skills');
  assert.equal(calls[0].options.env.DEER_FLOW_HOME, '/tmp/deerflow-native-guild/.runtime/deerflow-home');
  assert.equal(
    calls[0].options.env.DEER_FLOW_GUILD_PERSONAS_PATH,
    '/tmp/deerflow-native-guild/config/personas.json',
  );
  assert.equal(calls[0].options.env.CI, 'true');
  assert.equal(
    calls[0].options.env.PATH.startsWith('/tmp/deerflow-native-guild/.runtime/tools/pnpm/node_modules/.bin:'),
    true,
  );
});

const PERSONA_IDS = [
  'relaxed_wit',
  'clear_direct',
  'curious_explorer',
  'observant_warmth',
  'quiet_depth',
  'warm_candid',
];

function persona(id, version = '1.0.1') {
  return {
    id,
    version,
    core: `${id} core`,
    behavior: {
      attention: 'attention',
      voice: 'voice',
      humor: 'humor',
      disagreement: 'disagreement',
      care: 'care',
      initiative: 'initiative',
    },
    interests: ['interest'],
  };
}

async function withCatalog(catalog, callback) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'deerflow-personas-'));
  const catalogPath = path.join(directory, 'personas.json');
  await writeFile(catalogPath, JSON.stringify(catalog), 'utf8');
  try {
    return await callback(catalogPath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('persona catalog inspection accepts the exact six versioned assets', async () => {
  await withCatalog({
    schema_version: '1.0',
    personas: PERSONA_IDS.map((id) => persona(id)),
  }, async (catalogPath) => {
    assert.deepEqual(await inspectPersonaCatalog({ catalogPath }), {
      detail: '6 CreatorAgent personas at version 1.0.1',
    });
  });
});

test('persona catalog inspection rejects extra, duplicate, and wrong-version assets', async () => {
  const invalidCatalogs = [
    [...PERSONA_IDS.map((id) => persona(id)), persona('extra_persona')],
    [...PERSONA_IDS.slice(0, -1).map((id) => persona(id)), persona('relaxed_wit')],
    PERSONA_IDS.map((id) => persona(id, id === 'quiet_depth' ? '1.0.0' : '1.0.1')),
  ];

  for (const personas of invalidCatalogs) {
    await withCatalog({ schema_version: '1.0', personas }, async (catalogPath) => {
      await assert.rejects(
        inspectPersonaCatalog({ catalogPath }),
        /exactly the six approved CreatorAgent personas at version 1\.0\.1/i,
      );
    });
  }
});

test('persona catalog inspection rejects malformed and oversized asset bodies', async () => {
  const valid = PERSONA_IDS.map((id) => persona(id));
  const invalidCatalogs = [
    { schema_version: '1.0', personas: valid, extra: true },
    {
      schema_version: '1.0',
      personas: valid.map((asset, index) => (index === 0 ? { ...asset, identity: 'forbidden' } : asset)),
    },
    {
      schema_version: '1.0',
      personas: valid.map((asset, index) => (index === 0
        ? { ...asset, behavior: { ...asset.behavior, care: '' } }
        : asset)),
    },
    {
      schema_version: '1.0',
      personas: valid.map((asset, index) => (index === 0 ? { ...asset, core: 'x'.repeat(513) } : asset)),
    },
    {
      schema_version: '1.0',
      personas: valid.map((asset, index) => (index === 0 ? { ...asset, interests: [] } : asset)),
    },
  ];

  for (const catalog of invalidCatalogs) {
    await withCatalog(catalog, async (catalogPath) => {
      await assert.rejects(inspectPersonaCatalog({ catalogPath }), /invalid persona catalog/i);
    });
  }

  await withCatalog({
    schema_version: '1.0',
    personas: valid.map((asset, index) => (index === 0
      ? { ...asset, core: 'x'.repeat(33_000) }
      : asset)),
  }, async (catalogPath) => {
    await assert.rejects(inspectPersonaCatalog({ catalogPath }), /32 KiB/i);
  });
});
