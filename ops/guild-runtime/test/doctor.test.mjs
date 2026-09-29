import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  inspectApprovedCatalogs,
  inspectAssetManifest,
  inspectDatabaseRevision,
  inspectForkAncestor,
  inspectMigrationRevision,
  inspectNativeSocialRuntime,
  inspectPersonaCatalog,
  inspectPinnedPnpm,
  inspectXcuitestDriverRegistration,
  runDoctor,
} from '../scripts/doctor.mjs';
import { createServer } from 'node:http';
import { startRuntime } from '../scripts/start.mjs';
import { runCommand } from '../src/process.mjs';

const FORK_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const OPS_ROOT = path.join(FORK_ROOT, 'ops', 'guild-runtime');
const ASSETS_ROOT = path.join(FORK_ROOT, 'docs', 'product', 'creator-agent-final-persona-rev1');
const PINNED_COMMIT = '769589e8daee14c2587a634b6b43bd96471a41a1';

const REQUIRED_CHECKS = [
  'node',
  'git',
  'runtime_config',
  'guild_operator_root',
  'broker_operator_root',
  'tkdesk_root',
  'tkdesk_launcher',
  'guild_dependencies',
  'broker_dependencies',
  'fork_upstream_ancestor',
  'native_social_runtime',
  'creator_agent_assets',
  'persona_catalog',
  'database_revision',
  'deerflow_pnpm',
  'guild_mcp',
  'broker_mcp',
  'tkdesk_mcp',
];

test('doctor reports every required check by name and never stops at the first failure', async () => {
  const adapters = Object.fromEntries(REQUIRED_CHECKS.map((name) => [name, async () => {
    throw new Error(`${name} failed`);
  }]));
  const report = await runDoctor({ packageRoot: FORK_ROOT, adapters });
  assert.equal(report.ok, false);
  assert.deepEqual(report.checks.map(({ name }) => name), REQUIRED_CHECKS);
  assert.deepEqual(report.checks.map(({ ok }) => ok), REQUIRED_CHECKS.map(() => false));
});

test('live doctor marks an unavailable Gateway instead of passing static snapshots as running tools', async (t) => {
  const server = createServer((_request, response) => { response.writeHead(503).end(); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const adapters = Object.fromEntries(REQUIRED_CHECKS.map((name) => [name, async () => ({ detail: 'static fixture' })]));
  for (const name of ['guild_direct_catalog', 'broker_direct_catalog', 'tkdesk_direct_catalog']) {
    adapters[name] = async () => ({ detail: 'direct fixture' });
  }
  const report = await runDoctor({
    packageRoot: FORK_ROOT,
    live: true,
    gatewayUrl: `http://127.0.0.1:${server.address().port}`,
    adapters,
  });
  assert.equal(report.ok, false);
  assert.match(report.checks.find(({ name }) => name === 'gateway_mcp_config')?.detail ?? '', /unavailable.*503/iu);
  assert.equal(report.gatewayLoadedCatalog.status, 'unverified');
});

test('live doctor rejects the running configuration when broker is missing', async (t) => {
  const extensions = JSON.parse(await readFile(path.join(OPS_ROOT, 'config', 'extensions_config.guild.json'), 'utf8'));
  delete extensions.mcpServers.broker_operator;
  const server = createServer((_request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ mcp_servers: extensions.mcpServers }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const adapters = Object.fromEntries(REQUIRED_CHECKS.map((name) => [name, async () => ({ detail: 'static fixture' })]));
  for (const name of ['guild_direct_catalog', 'broker_direct_catalog', 'tkdesk_direct_catalog']) {
    adapters[name] = async () => ({ detail: 'direct fixture' });
  }
  const report = await runDoctor({ packageRoot: FORK_ROOT, live: true,
    gatewayUrl: `http://127.0.0.1:${server.address().port}`, adapters });
  assert.equal(report.ok, false);
  assert.match(report.checks.find(({ name }) => name === 'gateway_mcp_config')?.detail ?? '', /missing.*broker_operator/iu);
});

test('live doctor marks public outreach catalog evidence as direct discovery', async () => {
  const adapters = Object.fromEntries(REQUIRED_CHECKS.map((name) => [name, async () => ({ detail: 'static fixture' })]));
  for (const name of [
    'public_outreach_operator_root',
    'public_outreach_config',
    'public_outreach_playwright',
    'public_outreach_appium',
    'public_outreach_profile_root',
    'public_outreach_devices',
    'public_outreach_direct_catalog',
    'guild_direct_catalog',
    'broker_direct_catalog',
    'tkdesk_direct_catalog',
  ]) {
    adapters[name] = async () => ({ detail: 'direct fixture' });
  }
  const report = await runDoctor({ packageRoot: FORK_ROOT, live: true, adapters });
  const check = report.checks.find(({ name }) => name === 'public_outreach_direct_catalog');
  assert.equal(check?.ok, true);
  assert.equal(check?.evidence, 'direct-discovery');
});

test('doctor accepts a registered XCUITest driver from the Appium JSON catalog', async () => {
  const result = await inspectXcuitestDriverRegistration({
    operatorRoot: '/fixture/operator',
    run: async (command, args, options) => {
      assert.match(command, /node_modules[\\/]\.bin[\\/]appium$/u);
      assert.deepEqual(args, ['driver', 'list', '--json']);
      assert.equal(options.cwd, '/fixture/operator');
      return {
        code: 0,
        stdout: JSON.stringify({ xcuitest: { installed: true, version: '12.13.3' } }),
        stderr: '',
      };
    },
  });
  assert.deepEqual(result, { detail: 'xcuitest@12.13.3 registered in the Appium driver catalog' });
});

test('doctor keeps an unregistered XCUITest driver unavailable', async () => {
  await assert.rejects(
    inspectXcuitestDriverRegistration({
      operatorRoot: '/fixture/operator',
      run: async () => ({
        code: 0,
        stdout: JSON.stringify({ xcuitest: { installed: false } }),
        stderr: '',
      }),
    }),
    /registration_required.*npm run ios:install-driver/u,
  );
});

test('fork inspection checks ancestry instead of requiring HEAD to equal the pin', async () => {
  const calls = [];
  const result = await inspectForkAncestor({
    forkRoot: FORK_ROOT,
    commit: PINNED_COMMIT,
    run: async (command, args, options) => {
      calls.push({ command, args, options });
      return { code: 0, stdout: '', stderr: '' };
    },
  });
  assert.deepEqual(result, { detail: `${PINNED_COMMIT} is an ancestor of HEAD` });
  assert.deepEqual(calls, [{
    command: 'git',
    args: ['-C', FORK_ROOT, 'merge-base', '--is-ancestor', PINNED_COMMIT, 'HEAD'],
    options: { cwd: FORK_ROOT },
  }]);
});

test('doctor validates the immutable imported package and its six native personas', async () => {
  assert.deepEqual(await inspectAssetManifest({ assetsRoot: ASSETS_ROOT }), {
    detail: '76 manifest files (473848 bytes)',
  });
  assert.deepEqual(await inspectPersonaCatalog({ assetsRoot: ASSETS_ROOT }), {
    detail: '6 CreatorAgent personas at version 1.0.1',
  });
});

test('asset inspection rejects a modified package even when its manifest is re-signed', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'deerflow-resigned-assets-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(ASSETS_ROOT, root, { recursive: true });
  const relative = 'personas/quiet_depth.json';
  const target = path.join(root, relative);
  const changed = Buffer.concat([await readFile(target), Buffer.from(' ')]);
  await writeFile(target, changed);
  const manifestPath = path.join(root, 'MANIFEST.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const entry = manifest.files.find(({ path: name }) => name === relative);
  entry.bytes = changed.byteLength;
  const { createHash } = await import('node:crypto');
  entry.sha256 = createHash('sha256').update(changed).digest('hex');
  await writeFile(manifestPath, JSON.stringify(manifest), 'utf8');

  await assert.rejects(inspectAssetManifest({ assetsRoot: root }), /approved manifest/i);
});

test('approved MCP catalogs are checked statically without starting either server', async () => {
  const tkdesk = JSON.parse(await readFile(path.join(OPS_ROOT, 'fixtures', 'mcp', 'tkdesk-tools.json'), 'utf8'));
  assert.deepEqual(await inspectApprovedCatalogs({ opsRoot: OPS_ROOT }), {
    guild: '9 approved tools; ordinary backstage writes are agent-operated, creator removal remains approval-gated',
    broker: '2 approved tools; isolated broker profile and broker-scoped messaging only',
    tkdesk: `${tkdesk.tools.length} approved tools; recovery and handoff present, outreach absent`,
  });
});

test('persona inspection rejects a changed version even when the JSON remains valid', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'deerflow-personas-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(path.join(ASSETS_ROOT, 'personas'), path.join(root, 'personas'), { recursive: true });
  const target = path.join(root, 'personas', 'quiet_depth.json');
  const document = JSON.parse(await readFile(target, 'utf8'));
  document.version = '1.0.0';
  await writeFile(target, JSON.stringify(document), 'utf8');
  await assert.rejects(
    inspectPersonaCatalog({ assetsRoot: root }),
    /exactly the six approved CreatorAgent personas at version 1\.0\.1/i,
  );
});

test('database migration inspection pins revision 0026 after 0025', async () => {
  const migrationPath = path.join(
    FORK_ROOT,
    'backend/packages/harness/deerflow/persistence/migrations/versions/0026_social_runtime.py',
  );
  assert.deepEqual(await inspectMigrationRevision({ migrationPath }), {
    detail: '0026_social_runtime revises 0025_creator_agent_relationship',
  });
});

test('native social source inspection finds the runtime, channel gate, persistence and migration', async () => {
  assert.deepEqual(await inspectNativeSocialRuntime({ forkRoot: FORK_ROOT }), {
    detail: 'native social runtime, channel, persistence, and migration 0026 are present',
  });
});

test('database revision inspection warms a WAL snapshot when the source has no sidecars', async (t) => {
  const databaseRoot = await mkdtemp(path.join(os.tmpdir(), 'deerflow-doctor-wal-db-'));
  t.after(() => rm(databaseRoot, { recursive: true, force: true }));
  const databasePath = path.join(databaseRoot, 'deerflow.db');
  const seed = [
    'PRAGMA journal_mode=WAL;',
    'CREATE TABLE alembic_version(version_num TEXT);',
    "INSERT INTO alembic_version VALUES ('0026_social_runtime');",
    'PRAGMA wal_checkpoint(TRUNCATE);',
  ].join(' ');
  const seeded = await runCommand('sqlite3', [databasePath, seed], { cwd: databaseRoot });
  assert.equal(seeded.code, 0, seeded.stderr);
  await Promise.all(['-wal', '-shm'].map((suffix) => rm(`${databasePath}${suffix}`, { force: true })));
  const before = await readdir(databaseRoot);

  assert.deepEqual(await inspectDatabaseRevision({ databasePath }), {
    detail: 'database at 0026_social_runtime',
  });
  assert.deepEqual(await readdir(databaseRoot), before);
});

test('database revision inspection queries a disposable snapshot without changing the source directory', async (t) => {
  const databaseRoot = await mkdtemp(path.join(os.tmpdir(), 'deerflow-doctor-source-db-'));
  t.after(() => rm(databaseRoot, { recursive: true, force: true }));
  const databasePath = path.join(databaseRoot, 'deerflow.db');
  await writeFile(databasePath, 'source database bytes');
  await writeFile(`${databasePath}-wal`, 'source wal bytes');
  await writeFile(`${databasePath}-shm`, 'source shm bytes');
  const snapshotState = async () => {
    const names = (await readdir(databaseRoot)).sort();
    return Promise.all(names.map(async (name) => {
      const file = path.join(databaseRoot, name);
      const info = await stat(file, { bigint: true });
      return {
        name,
        size: info.size.toString(),
        mtimeNs: info.mtimeNs.toString(),
        sha256: createHash('sha256').update(await readFile(file)).digest('hex'),
      };
    }));
  };
  const before = await snapshotState();
  const calls = [];
  assert.deepEqual(await inspectDatabaseRevision({
    databasePath,
    run: async (command, args, options) => {
      calls.push({ command, args, options });
      const uri = new URL(args[0]);
      uri.search = '';
      const snapshotPath = fileURLToPath(uri);
      assert.equal(await readFile(`${snapshotPath}-wal`, 'utf8'), 'source wal bytes');
      if (calls.length === 1) {
        assert.equal(uri.search, '');
        assert.equal(new URL(args[0]).searchParams.get('mode'), 'rw');
        assert.equal(args[1], 'PRAGMA query_only=ON; SELECT 1;');
        assert.equal(existsSync(`${snapshotPath}-shm`), false);
        await writeFile(`${snapshotPath}-shm`, 'sqlite side effect');
        return { code: 0, stdout: '1\n', stderr: '' };
      }
      assert.equal(new URL(args[0]).searchParams.get('mode'), 'ro');
      assert.equal(args[1], 'SELECT version_num FROM alembic_version;');
      assert.equal(await readFile(`${snapshotPath}-shm`, 'utf8'), 'sqlite side effect');
      return { code: 0, stdout: '0026_social_runtime\n', stderr: '' };
    },
  }), { detail: 'database at 0026_social_runtime' });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(({ command }) => command), ['sqlite3', 'sqlite3']);
  assert.notEqual(calls[1].args[0], `${pathToFileURL(databasePath).href}?mode=ro`);
  const after = await snapshotState();
  assert.deepEqual(after, before);
});

test('pnpm inspection reads the fork frontend package-manager pin without executing pnpm', async () => {
  assert.deepEqual(await inspectPinnedPnpm({ frontendRoot: path.join(FORK_ROOT, 'frontend') }), {
    detail: 'pnpm 10.26.2',
  });
});

test('start never invokes DeerFlow when doctor fails', async () => {
  let starts = 0;
  await assert.rejects(
    startRuntime({
      packageRoot: FORK_ROOT,
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

test('start preserves ops-owned SOUL and launches make start at the fork root', async () => {
  const calls = [];
  const soulInstalls = [];
  await startRuntime({
    packageRoot: FORK_ROOT,
    installSoul: async (options) => { soulInstalls.push(options); },
    doctor: async () => ({ ok: true, checks: [] }),
    start: async (command, args, options) => {
      calls.push({ command, args, options });
      return 0;
    },
  });

  assert.deepEqual(soulInstalls, [{ packageRoot: FORK_ROOT }]);
  assert.equal(calls[0].command, 'make');
  assert.deepEqual(calls[0].args, ['start']);
  assert.equal(calls[0].options.cwd, FORK_ROOT);
  assert.equal(calls[0].options.env.DEER_FLOW_CONFIG_PATH, path.join(OPS_ROOT, 'config', 'config.yaml'));
  assert.equal(
    calls[0].options.env.DEER_FLOW_EXTENSIONS_CONFIG_PATH,
    path.join(OPS_ROOT, 'config', 'extensions_config.guild.json'),
  );
  assert.equal(calls[0].options.env.DEER_FLOW_SKILLS_PATH, path.join(FORK_ROOT, 'skills'));
  assert.equal(calls[0].options.env.DEER_FLOW_HOME, path.join(FORK_ROOT, 'backend', '.deer-flow'));
  assert.equal(calls[0].options.env.DEER_FLOW_SOCIAL_ASSETS_PATH, ASSETS_ROOT);
  assert.equal(calls[0].options.env.CI, 'true');
});
