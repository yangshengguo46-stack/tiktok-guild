import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  loadRuntimeConfig,
  validateRuntimeConfig,
} from '../src/runtime-config.mjs';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function validExists(target) {
  return target === '/Users/yangyucheng/plugins/tiktok-live-guild-operator/src/server.mjs'
    || target === '/Users/yangyucheng/plugins/tkdesk-agent/scripts/launch_mcp';
}

test('accepts the direct two-plugin runtime', async () => {
  const config = await loadRuntimeConfig({ packageRoot: PACKAGE_ROOT });
  const result = validateRuntimeConfig(config, {
    exists: validExists,
    nodeVersion: '22.16.0',
  });

  assert.equal(result.valid, true);
  assert.deepEqual(Object.keys(result.config.extensions.mcpServers), [
    'guild_operator',
    'tkdesk',
  ]);
});

test('rejects an extra MCP server', async () => {
  const config = await loadRuntimeConfig({ packageRoot: PACKAGE_ROOT });
  config.extensions.mcpServers.worker = {
    type: 'stdio',
    command: 'node',
    args: ['worker.mjs'],
  };

  assert.throws(
    () => validateRuntimeConfig(config, { exists: validExists, nodeVersion: '22.16.0' }),
    /MCP servers/u,
  );
});

test('rejects Worker and Rust bridge commands', async () => {
  const config = await loadRuntimeConfig({ packageRoot: PACKAGE_ROOT });

  for (const command of ['guild-mcp-bridge', 'tiktok-recruiter-worker']) {
    config.extensions.mcpServers.guild_operator.command = command;
    assert.throws(
      () => validateRuntimeConfig(config, { exists: validExists, nodeVersion: '22.16.0' }),
      /Guild Operator command/u,
    );
  }
});

test('rejects a Guild write tool', async () => {
  const config = await loadRuntimeConfig({ packageRoot: PACKAGE_ROOT });
  config.extensions.mcpServers.guild_operator.enabled_tools.push('guild_send_message');

  assert.throws(
    () => validateRuntimeConfig(config, { exists: validExists, nodeVersion: '22.16.0' }),
    /Guild tools/u,
  );
});

test('rejects a missing plugin executable', async () => {
  const config = await loadRuntimeConfig({ packageRoot: PACKAGE_ROOT });

  assert.throws(
    () => validateRuntimeConfig(config, { exists: () => false, nodeVersion: '22.16.0' }),
    /does not exist/u,
  );
});

test('requires Node 22.16 or newer', async () => {
  const config = await loadRuntimeConfig({ packageRoot: PACKAGE_ROOT });

  assert.throws(
    () => validateRuntimeConfig(config, { exists: validExists, nodeVersion: '22.15.9' }),
    /Node.js 22.16/u,
  );
});

test('requires the approved DeerFlow commit', async () => {
  const config = await loadRuntimeConfig({ packageRoot: PACKAGE_ROOT });
  config.manifest.deerflow.commit = '0000000000000000000000000000000000000000';

  assert.throws(
    () => validateRuntimeConfig(config, { exists: validExists, nodeVersion: '22.16.0' }),
    /DeerFlow commit/u,
  );
});
