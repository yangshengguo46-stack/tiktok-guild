import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  DEERFLOW_COMMIT,
  DEERFLOW_REPOSITORY,
  GUILD_OPERATOR_ROOT,
  GUILD_EXTENSIONS_CONFIG,
  GUILD_TOOL_NAMES,
  MCP_SERVER_NAMES,
  TKDESK_ROOT,
  TKDESK_TOOL_NAMES,
} from './constants.mjs';

const FORBIDDEN_OUTREACH = /send_message|send_invitation|follow|comment|gift|publish/iu;

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
  const opsRoot = path.join(root, 'ops', 'guild-runtime');
  const configRoot = path.join(opsRoot, 'config');
  return {
    packageRoot: root,
    opsRoot,
    manifest: await readJson(path.join(configRoot, 'local-manifest.json')),
    extensions: await readJson(path.join(configRoot, GUILD_EXTENSIONS_CONFIG)),
    configPath: path.join(configRoot, 'config.yaml'),
    extensionsPath: path.join(configRoot, GUILD_EXTENSIONS_CONFIG),
    runtimeHome: path.join(root, 'backend', '.deer-flow'),
    personaAssetsRoot: path.join(root, 'docs', 'product', 'creator-agent-final-persona-rev1'),
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
  if (Object.hasOwn(manifest, 'product_patches') || Object.hasOwn(manifest, 'runtime_root')) {
    throw new Error('The fork root must not declare an obsolete product patch or nested runtime.');
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
  exactValues(tkdesk.enabled_tools, TKDESK_TOOL_NAMES, 'TKDesk tools');
  if (!guild.required || !tkdesk.required || guild.tool_name_prefix !== false || tkdesk.tool_name_prefix !== false) {
    throw new Error('Approved MCP servers must be required and expose stable unprefixed tool names.');
  }
  const forbidden = [...guild.enabled_tools, ...tkdesk.enabled_tools].filter((name) => FORBIDDEN_OUTREACH.test(name));
  if (forbidden.length > 0) {
    throw new Error(`Approved MCP allowlists contain forbidden outreach tools: ${forbidden.join(', ')}`);
  }

  for (const executable of [guild.args[0], tkdesk.command]) {
    if (!exists(executable)) throw new Error(`Required plugin executable does not exist: ${executable}`);
  }

  return { valid: true, config };
}
