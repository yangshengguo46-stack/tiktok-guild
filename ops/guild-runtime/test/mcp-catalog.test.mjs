import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createServer } from 'node:http';

import { inspectDirectMcpCatalog, inspectGatewayMcpConfig } from '../src/mcp-catalog.mjs';
import { buildRuntimeEnvironment } from '../src/runtime-environment.mjs';

async function catalogFixture(t, names, checkEnvironment = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'guild-live-catalog-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'rpc.mjs');
  await writeFile(file, `
    import { createInterface } from 'node:readline';
    if (${JSON.stringify(checkEnvironment)} && (process.env.TIKTOK_BROKER_ACCOUNT_REF !== 'affiliate:mira.creator_01'
      || process.env.TIKTOK_BROKER_IDENTITY_TEXT !== 'Mira' || process.env.OBSERVED_DEFAULT !== 'Mira')) process.exit(23);
    createInterface({ input: process.stdin }).on('line', (line) => {
      const x = JSON.parse(line);
      if (!x.id) return;
      const result = x.method === 'tools/list' ? { tools: ${JSON.stringify(names)}.map(name => ({ name, inputSchema: { type: 'object' } })) }
        : { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fixture', version: '1' } };
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: x.id, result }) + '\\n');
    });
  `, 'utf8');
  return { command: process.execPath, args: [file], cwd: root,
    enabled_tools: ['broker_workspace', 'broker_messaging'] };
}

test('direct discovery rejects a server whose real RPC catalog omits an approved broker tool', async (t) => {
  const server = await catalogFixture(t, ['broker_workspace']);
  await assert.rejects(inspectDirectMcpCatalog({ serverName: 'broker_operator', server, environment: process.env }),
    /direct catalog drift.*missing.*broker_messaging/u);
});

test('direct discovery uses the startup broker identity and filters only through the configured allowlist', async (t) => {
  const server = await catalogFixture(t, ['broker_messaging', 'unapproved_extra', 'broker_workspace'], true);
  server.env = { OBSERVED_DEFAULT: '$TIKTOK_BROKER_IDENTITY_TEXT' };
  const environment = buildRuntimeEnvironment({ packageRoot: server.cwd, environment: { PATH: process.env.PATH, HOME: os.homedir() } });
  const result = await inspectDirectMcpCatalog({ serverName: 'broker_operator', server, environment });
  assert.match(result.detail, /2 approved tools.*3 raw tools/u);
  assert.match(result.detail, /Gateway loading unverified/u);
});

test('direct discovery rejects duplicate raw names before applying the allowlist', async (t) => {
  const server = await catalogFixture(t, ['broker_workspace', 'broker_messaging', 'broker_messaging']);
  await assert.rejects(inspectDirectMcpCatalog({ serverName: 'broker_operator', server, environment: process.env }),
    /duplicate raw tool names/u);
});

test('Gateway catalog errors do not echo an invalid response body', async (t) => {
  const server = createServer((_request, response) => response.end('private-token-in-invalid-response'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await assert.rejects(inspectGatewayMcpConfig({ gatewayUrl: `http://127.0.0.1:${server.address().port}`, expectedServers: {} }), (error) => {
    assert.match(error.message, /unavailable.*invalid JSON response/u);
    assert.doesNotMatch(error.message, /private-token/u);
    return true;
  });
});

test('Gateway configuration detects environment key drift while respecting masked values', async (t) => {
  const expected = { broker_operator: { enabled: true, required: true, command: 'node', cwd: '/fixture',
    type: 'stdio', tool_name_prefix: false, args: ['server.mjs'], enabled_tools: ['broker_workspace'] } };
  const actual = structuredClone(expected);
  actual.broker_operator.env = { TIKTOK_BROKER_ACCOUNT_REF: '***' };
  const server = createServer((_request, response) => response.end(JSON.stringify({ mcp_servers: actual })));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await assert.rejects(inspectGatewayMcpConfig({ gatewayUrl: `http://127.0.0.1:${server.address().port}`, expectedServers: expected }),
    /configuration drift.*broker_operator.env keys/u);
});
