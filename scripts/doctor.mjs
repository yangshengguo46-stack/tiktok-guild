#!/usr/bin/env node
import { constants as fsConstants } from 'node:fs';
import { existsSync } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEERFLOW_COMMIT,
  DEERFLOW_PNPM_VERSION,
  DEERFLOW_REPOSITORY,
  GUILD_OPERATOR_ROOT,
  GUILD_TOOL_NAMES,
  TKDESK_ROOT,
} from '../src/constants.mjs';
import { probeMcpServer, runCommand } from '../src/process.mjs';
import { verifyProductPatches } from '../src/product-patches.mjs';
import { loadRuntimeConfig, validateRuntimeConfig } from '../src/runtime-config.mjs';

export const REQUIRED_DOCTOR_CHECKS = Object.freeze([
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
]);

async function pathExists(candidate) {
  try {
    await access(candidate);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function requireSuccess(command, args, options) {
  const result = await runCommand(command, args, options);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `${command} exited ${result.code}`);
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

function exactToolNames(tools, expected, label) {
  const names = tools.map(({ name }) => name);
  if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) {
    throw new Error(`${label} catalog does not match the approved tools`);
  }
}

export async function inspectPinnedPnpm({
  pnpmBinary,
  frontendRoot,
  run = runCommand,
}) {
  const result = await run(pnpmBinary, ['--version'], { cwd: frontendRoot });
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `pnpm exited ${result.code}`);
  }
  const version = result.stdout.trim();
  if (version !== DEERFLOW_PNPM_VERSION) {
    throw new Error(`DeerFlow pnpm is ${version}, expected ${DEERFLOW_PNPM_VERSION}`);
  }
  return { detail: `pnpm ${version}` };
}

function defaultAdapters(packageRoot) {
  let loadedConfig;
  const getConfig = async () => {
    loadedConfig ??= await loadRuntimeConfig({ packageRoot });
    return loadedConfig;
  };
  const runtimeCheckout = path.join(packageRoot, '.runtime', 'deer-flow');
  const pnpmBinary = path.join(
    packageRoot,
    '.runtime',
    'tools',
    'pnpm',
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
  );
  const guildLauncher = path.join(GUILD_OPERATOR_ROOT, 'src', 'server.mjs');
  const tkdeskLauncher = path.join(TKDESK_ROOT, 'scripts', 'launch_mcp');

  return {
    node: async () => {
      assertNodeVersion(process.versions.node);
      return { detail: `Node.js ${process.versions.node}` };
    },
    git: async () => ({ detail: await requireSuccess('git', ['--version']) }),
    runtime_config: async () => {
      const config = await getConfig();
      validateRuntimeConfig(config, { exists: existsSync, nodeVersion: process.versions.node });
      for (const candidate of [guildLauncher, tkdeskLauncher]) {
        if (!await pathExists(candidate)) throw new Error(`missing ${candidate}`);
      }
      return { detail: 'native two-MCP config is valid' };
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
    deerflow_head: async () => {
      const remote = await requireSuccess('git', ['-C', runtimeCheckout, 'config', '--get', 'remote.origin.url']);
      if (remote !== DEERFLOW_REPOSITORY) throw new Error('DeerFlow remote is not official');
      const head = await requireSuccess('git', ['-C', runtimeCheckout, 'rev-parse', 'HEAD']);
      if (head.toLowerCase() !== DEERFLOW_COMMIT) throw new Error(`DeerFlow HEAD is ${head}, expected ${DEERFLOW_COMMIT}`);
      return { detail: head };
    },
    product_patches: async () => {
      const config = await getConfig();
      const patches = config.manifest.product_patches ?? [];
      await verifyProductPatches({
        packageRoot,
        destination: runtimeCheckout,
        patches,
        run: runCommand,
      });
      return { detail: `${patches.length} product patch(es) applied` };
    },
    deerflow_pnpm: async () => {
      await access(pnpmBinary, fsConstants.X_OK);
      return inspectPinnedPnpm({
        pnpmBinary,
        frontendRoot: path.join(runtimeCheckout, 'frontend'),
      });
    },
    guild_mcp: async () => {
      const result = await probeMcpServer({
        command: process.execPath,
        args: [guildLauncher],
        cwd: GUILD_OPERATOR_ROOT,
      });
      exactToolNames(result.tools, GUILD_TOOL_NAMES, 'Guild Operator');
      return { detail: `${result.tools.length} approved read-only tools` };
    },
    tkdesk_mcp: async () => {
      const result = await probeMcpServer({
        command: tkdeskLauncher,
        cwd: TKDESK_ROOT,
        env: { ...process.env, TKDESK_AGENT_SOURCE_ROOT: TKDESK_ROOT },
      });
      const names = result.tools.map(({ name }) => name);
      for (const required of ['prepare_handoff', 'commit_handoff']) {
        if (!names.includes(required)) throw new Error(`TKDesk is missing ${required}`);
      }
      const forbidden = names.filter((name) => /send_message|send_invitation|follow|comment|gift|publish/iu.test(name));
      if (forbidden.length > 0) throw new Error(`TKDesk exposes forbidden outreach tools: ${forbidden.join(', ')}`);
      return { detail: `${names.length} tools; handoff present and outreach absent` };
    },
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
  const packageRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
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
