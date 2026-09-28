#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { constants as fsConstants, existsSync } from 'node:fs';
import { access, copyFile, lstat, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  DEERFLOW_COMMIT,
  DEERFLOW_PNPM_VERSION,
  BROKER_OPERATOR_ROOT,
  BROKER_TOOL_NAMES,
  GUILD_OPERATOR_ROOT,
  GUILD_EXTENSIONS_CONFIG,
  GUILD_TOOL_NAMES,
  TKDESK_ROOT,
  TKDESK_TOOL_NAMES,
} from '../src/constants.mjs';
import { runCommand } from '../src/process.mjs';
import { loadRuntimeConfig, validateRuntimeConfig } from '../src/runtime-config.mjs';
import { buildRuntimeEnvironment } from '../src/runtime-environment.mjs';
import { inspectDirectMcpCatalog, inspectGatewayMcpConfig } from '../src/mcp-catalog.mjs';

export const REQUIRED_DOCTOR_CHECKS = Object.freeze([
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
]);
export const LIVE_DOCTOR_CHECKS = Object.freeze([
  'gateway_mcp_config', 'guild_direct_catalog', 'broker_direct_catalog', 'tkdesk_direct_catalog',
]);

const CREATOR_AGENT_PERSONA_IDS = Object.freeze([
  'relaxed_wit',
  'clear_direct',
  'curious_explorer',
  'observant_warmth',
  'quiet_depth',
  'warm_candid',
]);
const CREATOR_AGENT_PERSONA_VERSION = '1.0.1';
const PERSONA_BEHAVIOR_FIELDS = Object.freeze([
  'attention',
  'voice',
  'humor',
  'disagreement',
  'care',
  'initiative',
]);
const APPROVED_CATALOG_SHA256 = Object.freeze({
  guild: 'd92e46f6ecb1dd55961ee8e77acd594d9096d417acb2110fe548b73c28d58b21',
  broker: '86d60336f5694d6342f70017351a2a9ee4120c2451e47cc1e23d1af936954f98',
  tkdesk: 'bc175ef6a46ee75d25e02516a7b39324c938863a9e746c8a7830e0011fb7cf49',
});
const APPROVED_ASSET_MANIFEST_SHA256 = 'cb1246bdc1a8c2c68dcf3d1df89d0d67e727a60ef1e2db8fe823998d55d69b24';
const FORBIDDEN_OUTREACH = /send_message|send_invitation|follow|comment|gift|publish/iu;

async function requireSuccess(command, args, options, run = runCommand) {
  const result = await run(command, args, options);
  if (result.code !== 0) {
    throw new Error(result.stderr?.trim() || result.stdout?.trim() || `${command} exited ${result.code}`);
  }
  return result.stdout.trim();
}

function assertNodeVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)/u.exec(version);
  if (!match) throw new Error(`invalid Node.js version ${version}`);
  const [, major, minor] = match.map(Number);
  if (major < 22 || (major === 22 && minor < 16)) throw new Error('Node.js 22.16 or newer is required');
}

async function requireDirectory(directory) {
  const info = await stat(directory);
  if (!info.isDirectory()) throw new Error(`${directory} is not a directory`);
}

function exactValues(actual, expected, label) {
  if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    throw new Error(`${label} does not match the approved ordered values`);
  }
}

function boundedText(value, maximum) {
  return typeof value === 'string' && value.trim().length > 0 && [...value].length <= maximum;
}

export async function inspectForkAncestor({ forkRoot, commit = DEERFLOW_COMMIT, run = runCommand }) {
  const root = path.resolve(forkRoot);
  const result = await run('git', ['-C', root, 'merge-base', '--is-ancestor', commit, 'HEAD'], { cwd: root });
  if (result.code !== 0) throw new Error(`Pinned upstream commit ${commit} is not an ancestor of HEAD`);
  return { detail: `${commit} is an ancestor of HEAD` };
}

export async function inspectMigrationRevision({ migrationPath }) {
  const source = await readFile(migrationPath, 'utf8');
  const revision = /^revision\s*=\s*["']([^"']+)["']/mu.exec(source)?.[1];
  const downRevision = /^down_revision\s*=\s*["']([^"']+)["']/mu.exec(source)?.[1];
  if (revision !== '0026_social_runtime' || downRevision !== '0025_creator_agent_relationship') {
    throw new Error('Migration 0026 must revise 0025_creator_agent_relationship');
  }
  return { detail: '0026_social_runtime revises 0025_creator_agent_relationship' };
}

export async function inspectNativeSocialRuntime({ forkRoot }) {
  const root = path.resolve(forkRoot);
  const required = [
    'backend/packages/harness/deerflow/social/runtime.py',
    'backend/packages/harness/deerflow/social/assets.py',
    'backend/packages/harness/deerflow/social/tools.py',
    'backend/packages/harness/deerflow/persistence/social/sql.py',
    'backend/app/channels/social.py',
    'backend/packages/harness/deerflow/persistence/migrations/versions/0026_social_runtime.py',
  ];
  for (const relative of required) {
    const info = await lstat(path.join(root, relative));
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Invalid native social module: ${relative}`);
  }
  await inspectMigrationRevision({ migrationPath: path.join(root, required.at(-1)) });
  return { detail: 'native social runtime, channel, persistence, and migration 0026 are present' };
}

async function collectAssetFiles(root, current = root, result = []) {
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const absolute = path.join(current, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`asset symlink is not allowed: ${path.relative(root, absolute)}`);
    if (entry.isDirectory()) await collectAssetFiles(root, absolute, result);
    else if (entry.isFile()) result.push(path.relative(root, absolute).split(path.sep).join('/'));
  }
  return result;
}

export async function inspectAssetManifest({ assetsRoot }) {
  const rootInfo = await lstat(assetsRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('asset root must be a real directory');
  const manifestBytes = await readFile(path.join(assetsRoot, 'MANIFEST.json'));
  if (createHash('sha256').update(manifestBytes).digest('hex') !== APPROVED_ASSET_MANIFEST_SHA256) {
    throw new Error('CreatorAgent approved manifest hash changed');
  }
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) throw new Error('asset manifest files are missing');
  const declared = new Map();
  for (const entry of manifest.files) {
    if (!entry || typeof entry !== 'object' || Object.keys(entry).sort().join(',') !== 'bytes,path,sha256') {
      throw new Error('invalid asset manifest entry');
    }
    const unsafe = typeof entry.path !== 'string'
      || path.posix.isAbsolute(entry.path)
      || entry.path.split('/').some((part) => part === '.' || part === '..')
      || entry.path === 'MANIFEST.json'
      || declared.has(entry.path);
    if (unsafe || !Number.isInteger(entry.bytes) || entry.bytes < 0 || !/^[0-9a-f]{64}$/u.test(entry.sha256)) {
      throw new Error(`invalid asset manifest metadata: ${entry.path}`);
    }
    declared.set(entry.path, entry);
  }
  const actual = (await collectAssetFiles(assetsRoot)).sort();
  const expected = [...declared.keys(), 'MANIFEST.json'].sort();
  exactValues(actual, expected, 'CreatorAgent asset file set');
  let totalBytes = 0;
  for (const [relative, entry] of declared) {
    const data = await readFile(path.join(assetsRoot, relative));
    totalBytes += data.byteLength;
    if (data.byteLength !== entry.bytes || createHash('sha256').update(data).digest('hex') !== entry.sha256) {
      throw new Error(`CreatorAgent asset hash mismatch: ${relative}`);
    }
  }
  return { detail: `${declared.size} manifest files (${totalBytes} bytes)` };
}

export async function inspectPersonaCatalog({ assetsRoot }) {
  const personaRoot = path.join(assetsRoot, 'personas');
  const files = (await readdir(personaRoot)).filter((name) => name.endsWith('.json')).sort();
  exactValues(files, CREATOR_AGENT_PERSONA_IDS.map((id) => `${id}.json`).sort(), 'CreatorAgent persona files');
  for (const id of CREATOR_AGENT_PERSONA_IDS) {
    const persona = JSON.parse(await readFile(path.join(personaRoot, `${id}.json`), 'utf8'));
    const valid = persona?.id === id
      && persona?.version === CREATOR_AGENT_PERSONA_VERSION
      && persona?.kind === 'behavioral_persona_not_identity'
      && boundedText(persona.core, 512)
      && persona.behavior
      && typeof persona.behavior === 'object'
      && !Array.isArray(persona.behavior)
      && Object.keys(persona.behavior).sort().join(',') === [...PERSONA_BEHAVIOR_FIELDS].sort().join(',')
      && PERSONA_BEHAVIOR_FIELDS.every((field) => boundedText(persona.behavior[field], 256))
      && Array.isArray(persona.interests)
      && persona.interests.length >= 1
      && persona.interests.length <= 8
      && persona.interests.every((interest) => boundedText(interest, 128));
    if (!valid) throw new Error('Catalog must contain exactly the six approved CreatorAgent personas at version 1.0.1');
  }
  return { detail: '6 CreatorAgent personas at version 1.0.1' };
}

async function sqliteSourceState(databasePath) {
  const state = [];
  for (const suffix of ['', '-wal', '-shm']) {
    const source = `${databasePath}${suffix}`;
    try {
      const info = await lstat(source, { bigint: true });
      if (!info.isFile() || info.isSymbolicLink()) {
        throw new Error(`DeerFlow database file must be a real file: ${path.basename(source)}`);
      }
      const digest = createHash('sha256').update(await readFile(source)).digest('hex');
      state.push({
        suffix,
        size: info.size.toString(),
        mtimeNs: info.mtimeNs.toString(),
        ino: info.ino.toString(),
        digest,
      });
    } catch (error) {
      if (suffix && error?.code === 'ENOENT') state.push({ suffix, missing: true });
      else throw error;
    }
  }
  return state;
}

async function copyStableSqliteSnapshot(databasePath, snapshotPath) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const before = await sqliteSourceState(databasePath);
    await Promise.all(['', '-wal', '-shm'].map((suffix) => rm(`${snapshotPath}${suffix}`, { force: true })));
    try {
      for (const entry of before) {
        // SQLite's WAL shared-memory index is a disposable, process-local sidecar.
        // Never copy it from the live database: a temporary read/write warm-up
        // below will build a fresh index beside the copied database and WAL.
        if (!entry.missing && entry.suffix !== '-shm') {
          await copyFile(`${databasePath}${entry.suffix}`, `${snapshotPath}${entry.suffix}`);
        }
      }
    } catch (error) {
      if (attempt === 3) throw error;
      continue;
    }
    const after = await sqliteSourceState(databasePath);
    if (JSON.stringify(after) === JSON.stringify(before)) return;
  }
  throw new Error('DeerFlow database changed while creating a read-only doctor snapshot');
}

export async function inspectDatabaseRevision({ databasePath, statPath = lstat, run = runCommand }) {
  const info = await statPath(databasePath);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('DeerFlow database must be a real SQLite file');
  const snapshotRoot = await mkdtemp(path.join(os.tmpdir(), 'deerflow-doctor-sqlite-'));
  const snapshotPath = path.join(snapshotRoot, 'deerflow.db');
  try {
    await copyStableSqliteSnapshot(databasePath, snapshotPath);
    // A database whose header selects WAL mode cannot always be opened directly
    // with mode=ro when the copied snapshot has no -shm file (macOS/sqlite3
    // returns SQLITE_CANTOPEN before it can build the shared-memory index). The
    // snapshot is disposable, so warm it once with a read-only SQLite connection
    // that is allowed to create only its local sidecars. query_only prevents any
    // SQL write; the live database and its DB/WAL/SHM files are never opened.
    await requireSuccess(
      'sqlite3',
      [`${pathToFileURL(snapshotPath).href}?mode=rw`, 'PRAGMA query_only=ON; SELECT 1;'],
      { cwd: snapshotRoot },
      run,
    );
    const revision = await requireSuccess(
      'sqlite3',
      [`${pathToFileURL(snapshotPath).href}?mode=ro`, 'SELECT version_num FROM alembic_version;'],
      { cwd: snapshotRoot },
      run,
    );
    if (revision !== '0026_social_runtime') {
      throw new Error(`DeerFlow database is ${revision || 'unversioned'}, expected 0026_social_runtime`);
    }
  } finally {
    await rm(snapshotRoot, { recursive: true, force: true });
  }
  return { detail: 'database at 0026_social_runtime' };
}

export async function inspectPinnedPnpm({ frontendRoot }) {
  const packageJson = JSON.parse(await readFile(path.join(frontendRoot, 'package.json'), 'utf8'));
  if (packageJson.packageManager !== `pnpm@${DEERFLOW_PNPM_VERSION}`) {
    throw new Error(`DeerFlow packageManager must be pnpm@${DEERFLOW_PNPM_VERSION}`);
  }
  return { detail: `pnpm ${DEERFLOW_PNPM_VERSION}` };
}

async function loadApprovedCatalog(file, expectedHash, expectedCount, label) {
  const raw = await readFile(file);
  if (createHash('sha256').update(raw).digest('hex') !== expectedHash) {
    throw new Error(`${label} approved catalog hash changed`);
  }
  const catalog = JSON.parse(raw.toString('utf8'));
  if (!Array.isArray(catalog.tools) || catalog.tools.length !== expectedCount) {
    throw new Error(`${label} catalog must contain exactly ${expectedCount} tools`);
  }
  const names = [];
  for (const tool of catalog.tools) {
    if (
      !tool
      || typeof tool !== 'object'
      || Object.keys(tool).sort().join(',') !== 'input_schema_sha256,name'
      || typeof tool.name !== 'string'
      || !/^[0-9a-f]{64}$/u.test(tool.input_schema_sha256)
    ) {
      throw new Error(`${label} catalog has an invalid name or schema digest`);
    }
    names.push(tool.name);
  }
  if (new Set(names).size !== names.length) throw new Error(`${label} catalog has duplicate tools`);
  return names;
}

export async function inspectApprovedCatalogs({ opsRoot }) {
  const config = JSON.parse(await readFile(path.join(opsRoot, 'config', GUILD_EXTENSIONS_CONFIG), 'utf8'));
  const guildNames = await loadApprovedCatalog(
    path.join(opsRoot, 'fixtures', 'mcp', 'guild-tools.json'),
    APPROVED_CATALOG_SHA256.guild,
    9,
    'Guild Operator',
  );
  const tkdeskNames = await loadApprovedCatalog(
    path.join(opsRoot, 'fixtures', 'mcp', 'tkdesk-tools.json'),
    APPROVED_CATALOG_SHA256.tkdesk,
    TKDESK_TOOL_NAMES.length,
    'TKDesk',
  );
  const brokerNames = await loadApprovedCatalog(
    path.join(opsRoot, 'fixtures', 'mcp', 'broker-tools.json'),
    APPROVED_CATALOG_SHA256.broker,
    2,
    'Broker Operator',
  );
  exactValues(guildNames, GUILD_TOOL_NAMES, 'Guild Operator catalog');
  exactValues(config.mcpServers.guild_operator.enabled_tools, guildNames, 'Guild Operator allowlist');
  exactValues(brokerNames, BROKER_TOOL_NAMES, 'Broker Operator catalog');
  exactValues(config.mcpServers.broker_operator.enabled_tools, brokerNames, 'Broker Operator allowlist');
  exactValues(tkdeskNames, TKDESK_TOOL_NAMES, 'TKDesk catalog');
  exactValues(config.mcpServers.tkdesk.enabled_tools, tkdeskNames, 'TKDesk allowlist');
  for (const required of ['reopen_login', 'initialize_collection_backstage', 'prepare_discovery_live', 'prepare_handoff', 'commit_handoff']) {
    if (!tkdeskNames.includes(required)) throw new Error(`TKDesk is missing ${required}`);
  }
  const forbidden = [...guildNames, ...brokerNames, ...tkdeskNames].filter((name) => FORBIDDEN_OUTREACH.test(name));
  if (forbidden.length > 0) throw new Error(`Approved catalogs expose forbidden outreach tools: ${forbidden.join(', ')}`);
  return {
    guild: '9 approved tools; ordinary backstage writes are agent-operated, creator removal remains approval-gated',
    broker: '2 approved tools; isolated broker profile and broker-scoped messaging only',
    tkdesk: `${TKDESK_TOOL_NAMES.length} approved tools; recovery and handoff present, outreach absent`,
  };
}

function defaultAdapters(packageRoot, { gatewayUrl, environment, timeoutMs }) {
  let loadedConfig;
  let approvedCatalogs;
  const getConfig = async () => {
    loadedConfig ??= await loadRuntimeConfig({ packageRoot });
    return loadedConfig;
  };
  const getCatalogs = async () => {
    const config = await getConfig();
    approvedCatalogs ??= await inspectApprovedCatalogs({ opsRoot: config.opsRoot });
    return approvedCatalogs;
  };
  const tkdeskLauncher = path.join(TKDESK_ROOT, 'scripts', 'launch_mcp');
  const migrationPath = path.join(packageRoot, 'backend/packages/harness/deerflow/persistence/migrations/versions/0026_social_runtime.py');
  const directCatalog = async (serverName) => {
    const config = await getConfig();
    return inspectDirectMcpCatalog({ serverName, server: config.extensions.mcpServers[serverName],
      environment: buildRuntimeEnvironment({ packageRoot, environment }), timeoutMs });
  };

  return {
    node: async () => {
      assertNodeVersion(process.versions.node);
      return { detail: `Node.js ${process.versions.node}` };
    },
    git: async () => ({ detail: await requireSuccess('git', ['--version']) }),
    runtime_config: async () => {
      const config = await getConfig();
      validateRuntimeConfig(config, { exists: existsSync, nodeVersion: process.versions.node });
      return { detail: 'fork-native guild, broker, and collection MCP config is valid' };
    },
    guild_operator_root: async () => {
      await requireDirectory(GUILD_OPERATOR_ROOT);
      return { detail: GUILD_OPERATOR_ROOT };
    },
    broker_operator_root: async () => {
      await requireDirectory(BROKER_OPERATOR_ROOT);
      return { detail: BROKER_OPERATOR_ROOT };
    },
    tkdesk_root: async () => {
      await requireDirectory(TKDESK_ROOT);
      return { detail: TKDESK_ROOT };
    },
    tkdesk_launcher: async () => {
      await access(tkdeskLauncher, fsConstants.X_OK);
      return { detail: tkdeskLauncher };
    },
    guild_dependencies: async () => {
      await requireSuccess('npm', ['ls', '--omit=dev', '--json'], { cwd: GUILD_OPERATOR_ROOT });
      return { detail: 'Guild Operator dependencies are installed' };
    },
    broker_dependencies: async () => {
      await requireSuccess('npm', ['ls', '--omit=dev', '--json'], { cwd: BROKER_OPERATOR_ROOT });
      return { detail: 'Broker Operator dependencies are installed' };
    },
    fork_upstream_ancestor: async () => inspectForkAncestor({ forkRoot: packageRoot }),
    native_social_runtime: async () => {
      await inspectMigrationRevision({ migrationPath });
      return inspectNativeSocialRuntime({ forkRoot: packageRoot });
    },
    creator_agent_assets: async () => {
      const config = await getConfig();
      return inspectAssetManifest({ assetsRoot: config.personaAssetsRoot });
    },
    persona_catalog: async () => {
      const config = await getConfig();
      return inspectPersonaCatalog({ assetsRoot: config.personaAssetsRoot });
    },
    database_revision: async () => inspectDatabaseRevision({
      databasePath: path.join(packageRoot, 'backend', '.deer-flow', 'data', 'deerflow.db'),
    }),
    deerflow_pnpm: async () => inspectPinnedPnpm({ frontendRoot: path.join(packageRoot, 'frontend') }),
    guild_mcp: async () => ({ detail: (await getCatalogs()).guild }),
    broker_mcp: async () => ({ detail: (await getCatalogs()).broker }),
    tkdesk_mcp: async () => ({ detail: (await getCatalogs()).tkdesk }),
    gateway_mcp_config: async () => inspectGatewayMcpConfig({ gatewayUrl,
      expectedServers: (await getConfig()).extensions.mcpServers, timeoutMs }),
    guild_direct_catalog: () => directCatalog('guild_operator'),
    broker_direct_catalog: () => directCatalog('broker_operator'),
    tkdesk_direct_catalog: () => directCatalog('tkdesk'),
  };
}

export async function runDoctor({ packageRoot, adapters = {}, live = false,
  gatewayUrl = process.env.DEER_FLOW_GUILD_GATEWAY_URL ?? 'http://127.0.0.1:2026',
  environment = process.env, timeoutMs = 10000 }) {
  const resolvedRoot = path.resolve(packageRoot);
  const checks = [];
  const allAdapters = { ...defaultAdapters(resolvedRoot, { gatewayUrl, environment, timeoutMs }), ...adapters };
  for (const name of [...REQUIRED_DOCTOR_CHECKS, ...(live ? LIVE_DOCTOR_CHECKS : [])]) {
    const evidence = name === 'gateway_mcp_config' ? 'gateway-config'
      : LIVE_DOCTOR_CHECKS.includes(name) ? 'direct-discovery' : 'static';
    try {
      const result = await allAdapters[name]({ packageRoot: resolvedRoot });
      checks.push({ name, ok: true, evidence, detail: result?.detail ?? 'ok' });
    } catch (error) {
      checks.push({ name, ok: false, evidence, detail: error.message });
    }
  }
  return { ok: checks.every(({ ok }) => ok), checks,
    ...(live ? { gatewayLoadedCatalog: { status: 'unverified', reason: 'Gateway has no read-only loaded-catalog endpoint; direct probes use separate processes.' } } : {}),
  };
}

export function formatDoctorReport(report) {
  return report.checks.map(({ name, ok, evidence, detail }) => `${ok ? '✓' : '✗'} ${name} [${evidence ?? 'static'}]: ${detail}`).join('\n')
    + (report.gatewayLoadedCatalog ? `\n? gateway_loaded_catalog: ${report.gatewayLoadedCatalog.status}; ${report.gatewayLoadedCatalog.reason}` : '');
}

function isMain() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMain()) {
  const packageRoot = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)));
  const flags = process.argv.slice(2);
  if (flags.some((flag) => !['--live', '--static'].includes(flag)) || (flags.includes('--live') && flags.includes('--static'))) {
    console.error('Usage: doctor.mjs [--static|--live]');
    process.exit(1);
  }
  runDoctor({ packageRoot, live: flags.includes('--live') })
    .then((report) => {
      console.log(formatDoctorReport(report));
      if (!report.ok) process.exitCode = 1;
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
