#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { constants as fsConstants, existsSync } from 'node:fs';
import { access, lstat, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  DEERFLOW_COMMIT,
  DEERFLOW_PNPM_VERSION,
  GUILD_OPERATOR_ROOT,
  GUILD_TOOL_NAMES,
  TKDESK_ROOT,
} from '../src/constants.mjs';
import { runCommand } from '../src/process.mjs';
import { loadRuntimeConfig, validateRuntimeConfig } from '../src/runtime-config.mjs';

export const REQUIRED_DOCTOR_CHECKS = Object.freeze([
  'node',
  'git',
  'runtime_config',
  'guild_operator_root',
  'tkdesk_root',
  'tkdesk_launcher',
  'guild_dependencies',
  'fork_upstream_ancestor',
  'native_social_runtime',
  'creator_agent_assets',
  'persona_catalog',
  'database_revision',
  'deerflow_pnpm',
  'guild_mcp',
  'tkdesk_mcp',
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
  guild: 'c5311d17e659729e5cf9f8096a6b84120c09b2d2f367a6a78420d98e9f194f0b',
  tkdesk: '7073e1a6587f3a9da962fb3a9e0a98d9a01f917ca9c8b2728b623cea1ffe0056',
});
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
  const manifest = JSON.parse(await readFile(path.join(assetsRoot, 'MANIFEST.json'), 'utf8'));
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

export async function inspectDatabaseRevision({ databasePath, statPath = lstat, run = runCommand }) {
  const info = await statPath(databasePath);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('DeerFlow database must be a real SQLite file');
  const forkRoot = path.resolve(path.dirname(databasePath), '../../..');
  const revision = await requireSuccess(
    'sqlite3',
    [`${pathToFileURL(databasePath).href}?mode=ro`, 'SELECT version_num FROM alembic_version;'],
    { cwd: forkRoot },
    run,
  );
  if (revision !== '0026_social_runtime') {
    throw new Error(`DeerFlow database is ${revision || 'unversioned'}, expected 0026_social_runtime`);
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
  const config = JSON.parse(await readFile(path.join(opsRoot, 'config', 'extensions_config.json'), 'utf8'));
  const guildNames = await loadApprovedCatalog(
    path.join(opsRoot, 'fixtures', 'mcp', 'guild-tools.json'),
    APPROVED_CATALOG_SHA256.guild,
    8,
    'Guild Operator',
  );
  const tkdeskNames = await loadApprovedCatalog(
    path.join(opsRoot, 'fixtures', 'mcp', 'tkdesk-tools.json'),
    APPROVED_CATALOG_SHA256.tkdesk,
    28,
    'TKDesk',
  );
  exactValues(guildNames, GUILD_TOOL_NAMES, 'Guild Operator catalog');
  exactValues(config.mcpServers.guild_operator.enabled_tools, guildNames, 'Guild Operator allowlist');
  for (const required of ['prepare_handoff', 'commit_handoff']) {
    if (!tkdeskNames.includes(required)) throw new Error(`TKDesk is missing ${required}`);
  }
  const forbidden = [...guildNames, ...tkdeskNames].filter((name) => FORBIDDEN_OUTREACH.test(name));
  if (forbidden.length > 0) throw new Error(`Approved catalogs expose forbidden outreach tools: ${forbidden.join(', ')}`);
  return {
    guild: '8 approved read-only tools',
    tkdesk: '28 approved tools; handoff present and outreach absent',
  };
}

function defaultAdapters(packageRoot) {
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
  const guildLauncher = path.join(GUILD_OPERATOR_ROOT, 'src', 'server.mjs');
  const tkdeskLauncher = path.join(TKDESK_ROOT, 'scripts', 'launch_mcp');
  const migrationPath = path.join(packageRoot, 'backend/packages/harness/deerflow/persistence/migrations/versions/0026_social_runtime.py');

  return {
    node: async () => {
      assertNodeVersion(process.versions.node);
      return { detail: `Node.js ${process.versions.node}` };
    },
    git: async () => ({ detail: await requireSuccess('git', ['--version']) }),
    runtime_config: async () => {
      const config = await getConfig();
      validateRuntimeConfig(config, { exists: existsSync, nodeVersion: process.versions.node });
      return { detail: 'fork-native two-MCP config is valid' };
    },
    guild_operator_root: async () => {
      await requireDirectory(GUILD_OPERATOR_ROOT);
      return { detail: GUILD_OPERATOR_ROOT };
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
    tkdesk_mcp: async () => ({ detail: (await getCatalogs()).tkdesk }),
  };
}

export async function runDoctor({ packageRoot, adapters = {} }) {
  const resolvedRoot = path.resolve(packageRoot);
  const checks = [];
  const allAdapters = { ...defaultAdapters(resolvedRoot), ...adapters };
  for (const name of REQUIRED_DOCTOR_CHECKS) {
    try {
      const result = await allAdapters[name]({ packageRoot: resolvedRoot });
      checks.push({ name, ok: true, detail: result?.detail ?? 'ok' });
    } catch (error) {
      checks.push({ name, ok: false, detail: error.message });
    }
  }
  return { ok: checks.every(({ ok }) => ok), checks };
}

export function formatDoctorReport(report) {
  return report.checks.map(({ name, ok, detail }) => `${ok ? '✓' : '✗'} ${name}: ${detail}`).join('\n');
}

function isMain() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMain()) {
  const packageRoot = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)));
  runDoctor({ packageRoot })
    .then((report) => {
      console.log(formatDoctorReport(report));
      if (!report.ok) process.exitCode = 1;
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
