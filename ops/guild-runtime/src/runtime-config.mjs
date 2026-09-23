import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  DEERFLOW_COMMIT,
  DEERFLOW_REPOSITORY,
  GUILD_OPERATOR_ROOT,
  GUILD_TOOL_NAMES,
  MCP_SERVER_NAMES,
  TKDESK_ROOT,
} from './constants.mjs';

function exactValues(actual, expected, label) {
  if (!Array.isArray(actual)
    || actual.length !== expected.length
    || actual.some((value, index) => value !== expected[index])) {
    throw new Error(`${label} must match the approved ordered values.`);
  }
}

function parseNodeVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)/u.exec(value ?? '');
  if (!match) throw new Error(`Invalid Node.js version: ${value}`);
  return match.slice(1).map(Number);
}

function nodeAtLeast(actual, minimum) {
  for (let index = 0; index < minimum.length; index += 1) {
    if (actual[index] > minimum[index]) return true;
    if (actual[index] < minimum[index]) return false;
  }
  return true;
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

export async function loadRuntimeConfig({ packageRoot }) {
  const root = path.resolve(packageRoot);
  const configRoot = path.join(root, 'config');
  return {
    packageRoot: root,
    manifest: await readJson(path.join(configRoot, 'local-manifest.json')),
    extensions: await readJson(path.join(configRoot, 'extensions_config.json')),
    configPath: path.join(configRoot, 'config.yaml'),
    extensionsPath: path.join(configRoot, 'extensions_config.json'),
  };
}

export function validateRuntimeConfig(config, { exists, nodeVersion }) {
  const manifest = config?.manifest;
  if (manifest?.deerflow?.repository !== DEERFLOW_REPOSITORY) {
    throw new Error('DeerFlow repository must be the approved official remote.');
  }
  if (manifest.deerflow.commit !== DEERFLOW_COMMIT) {
    throw new Error('DeerFlow commit must match the approved pinned commit.');
  }

  const actualNode = parseNodeVersion(nodeVersion);
  if (!nodeAtLeast(actualNode, [22, 16, 0])) {
    throw new Error('Node.js 22.16 or newer is required.');
  }

  const servers = config?.extensions?.mcpServers;
  exactValues(Object.keys(servers ?? {}), MCP_SERVER_NAMES, 'MCP servers');

  const guild = servers.guild_operator;
  if (guild.command !== 'node'
    || guild.cwd !== GUILD_OPERATOR_ROOT
    || guild.args?.[0] !== `${GUILD_OPERATOR_ROOT}/src/server.mjs`) {
    throw new Error('Guild Operator command must point directly to the existing plugin server.');
  }
  exactValues(guild.enabled_tools, GUILD_TOOL_NAMES, 'Guild tools');

  const tkdesk = servers.tkdesk;
  if (tkdesk.command !== `${TKDESK_ROOT}/scripts/launch_mcp`
    || tkdesk.cwd !== TKDESK_ROOT) {
    throw new Error('TKDesk command must point directly to the existing plugin launcher.');
  }

  for (const executable of [guild.args[0], tkdesk.command]) {
    if (!exists(executable)) throw new Error(`Required plugin executable does not exist: ${executable}`);
  }

  return { valid: true, config };
}
