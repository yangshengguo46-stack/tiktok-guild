import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadRuntimeConfig, validateRuntimeConfig } from '../src/runtime-config.mjs';

const FORK_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const OPS_ROOT = path.join(FORK_ROOT, 'ops', 'guild-runtime');

function validExists(target) {
  return target === '/Users/yangyucheng/plugins/tiktok-live-guild-operator/src/server.mjs'
    || target === '/Users/yangyucheng/plugins/tkdesk-agent/scripts/launch_mcp';
}

test('runtime config resolves the DeerFlow fork root and ops-owned state', async () => {
  const config = await loadRuntimeConfig({ packageRoot: FORK_ROOT });

  assert.equal(config.packageRoot, FORK_ROOT);
  assert.equal(config.opsRoot, OPS_ROOT);
  assert.equal(config.configPath, path.join(OPS_ROOT, 'config', 'config.yaml'));
  assert.equal(config.extensionsPath, path.join(OPS_ROOT, 'config', 'extensions_config.json'));
  assert.equal(config.runtimeHome, path.join(FORK_ROOT, 'backend', '.deer-flow'));
  assert.equal(
    config.personaAssetsRoot,
    path.join(FORK_ROOT, 'docs', 'product', 'creator-agent-final-persona-rev1'),
  );
});

test('accepts the direct two-plugin runtime without patch or nested-checkout declarations', async () => {
  const config = await loadRuntimeConfig({ packageRoot: FORK_ROOT });
  const result = validateRuntimeConfig(config, { exists: validExists, nodeVersion: '22.16.0' });

  assert.equal(result.valid, true);
  assert.deepEqual(Object.keys(result.config.extensions.mcpServers), ['guild_operator', 'tkdesk']);
  assert.equal(Object.hasOwn(result.config.manifest, 'product_patches'), false);
  assert.equal(Object.hasOwn(result.config.manifest, 'runtime_root'), false);
});

test('rejects obsolete product-patch and nested-runtime declarations', async () => {
  for (const obsolete of [
    { product_patches: ['patches/0001-product.patch'] },
    { runtime_root: '.runtime' },
  ]) {
    const config = await loadRuntimeConfig({ packageRoot: FORK_ROOT });
    Object.assign(config.manifest, obsolete);
    assert.throws(
      () => validateRuntimeConfig(config, { exists: validExists, nodeVersion: '22.16.0' }),
      /fork root.*patch|nested runtime|obsolete/i,
    );
  }
});

test('rejects an extra MCP server or an approved-server write tool', async () => {
  const extraServer = await loadRuntimeConfig({ packageRoot: FORK_ROOT });
  extraServer.extensions.mcpServers.worker = { type: 'stdio', command: 'node', args: ['worker.mjs'] };
  assert.throws(
    () => validateRuntimeConfig(extraServer, { exists: validExists, nodeVersion: '22.16.0' }),
    /MCP servers/u,
  );

  const writeTool = await loadRuntimeConfig({ packageRoot: FORK_ROOT });
  writeTool.extensions.mcpServers.guild_operator.enabled_tools.push('guild_send_message');
  assert.throws(
    () => validateRuntimeConfig(writeTool, { exists: validExists, nodeVersion: '22.16.0' }),
    /Guild tools/u,
  );
});

test('rejects missing plugin executables, old Node, and a changed upstream pin', async () => {
  const missing = await loadRuntimeConfig({ packageRoot: FORK_ROOT });
  assert.throws(
    () => validateRuntimeConfig(missing, { exists: () => false, nodeVersion: '22.16.0' }),
    /does not exist/u,
  );

  const oldNode = await loadRuntimeConfig({ packageRoot: FORK_ROOT });
  assert.throws(
    () => validateRuntimeConfig(oldNode, { exists: validExists, nodeVersion: '22.15.9' }),
    /Node.js 22.16/u,
  );

  const wrongCommit = await loadRuntimeConfig({ packageRoot: FORK_ROOT });
  wrongCommit.manifest.deerflow.commit = '0000000000000000000000000000000000000000';
  assert.throws(
    () => validateRuntimeConfig(wrongCommit, { exists: validExists, nodeVersion: '22.16.0' }),
    /DeerFlow commit/u,
  );
});
