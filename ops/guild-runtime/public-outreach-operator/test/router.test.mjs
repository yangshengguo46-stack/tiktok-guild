import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ACCOUNT_CHILDREN,
  TASK_CHILDREN,
  TOOL_DEFINITIONS,
  REQUIRED_RESULT_FIELDS,
} from '../src/contracts.mjs';
import { createPublicOutreachRouter } from '../src/router.mjs';

function call(name, argumentsValue = {}) {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name, arguments: argumentsValue },
  };
}

test('initialize returns the versioned public outreach server contract', async () => {
  const route = createPublicOutreachRouter({ configured: false });
  const response = await route({ jsonrpc: '2.0', id: 1, method: 'initialize' });

  assert.equal(response.result.protocolVersion, '2025-06-18');
  assert.equal(response.result.serverInfo.name, 'public-outreach-operator');
  assert.equal(response.result.capabilities.tools.listChanged, false);
});

test('tools/list exposes only the two public outreach tool families', async () => {
  const route = createPublicOutreachRouter({ configured: false });
  const response = await route({ jsonrpc: '2.0', id: 2, method: 'tools/list' });

  assert.deepEqual(response.result.tools.map(({ name }) => name), [
    'public_outreach_accounts',
    'public_outreach_tasks',
  ]);
  assert.deepEqual(response.result.tools[0].inputSchema.properties.child.enum, [...ACCOUNT_CHILDREN]);
  assert.deepEqual(response.result.tools[1].inputSchema.properties.child.enum, [...TASK_CHILDREN]);
  assert.deepEqual(TOOL_DEFINITIONS.map(({ name }) => name), response.result.tools.map(({ name }) => name));
});

test('unknown tools and malformed arguments fail with JSON-RPC parameter errors', async () => {
  const route = createPublicOutreachRouter({ configured: false });

  const unknown = await route(call('other_operator'));
  assert.equal(unknown.error.code, -32602);
  assert.match(unknown.error.message, /Unknown tool/u);

  const malformed = await route(call('public_outreach_accounts', 'not-an-object'));
  assert.equal(malformed.error.code, -32602);
  assert.match(malformed.error.message, /arguments/u);

  const unknownChild = await route(call('public_outreach_accounts', { child: 'send_message' }));
  assert.equal(unknownChild.error.code, -32602);
  assert.match(unknownChild.error.message, /child/u);
});

test('unconfigured operator fails closed without invoking an adapter', async () => {
  let invoked = false;
  const route = createPublicOutreachRouter({
    configured: false,
    adapter: {
      async listSenderAccounts() {
        invoked = true;
        return [];
      },
    },
  });

  const response = await route(call('public_outreach_accounts', { child: 'list' }));
  assert.equal(response.result.isError, true);
  assert.equal(response.result.structuredContent.errors[0].code, 'operator_unconfigured');
  assert.equal(response.result.structuredContent.completeness.state, 'unavailable');
  assert.equal(invoked, false);
  for (const field of REQUIRED_RESULT_FIELDS) {
    assert.ok(Object.hasOwn(response.result.structuredContent, field), `missing ${field}`);
  }
});

test('configured handlers return the common task and completeness envelope', async () => {
  const route = createPublicOutreachRouter({
    configured: true,
    adapter: {
      async listSenderAccounts() {
        return [{
          sender_account_id: 'web:001',
          channel: 'web',
          status: 'healthy',
        }];
      },
    },
  });

  const response = await route(call('public_outreach_accounts', { child: 'list' }));
  const content = response.result.structuredContent;
  assert.equal(content.status, 'ok');
  assert.deepEqual(content.data.accounts, [{
    sender_account_id: 'web:001',
    channel: 'web',
    status: 'healthy',
  }]);
  assert.equal(content.completeness.state, 'complete');
  for (const field of REQUIRED_RESULT_FIELDS) {
    assert.ok(Object.hasOwn(content, field), `missing ${field}`);
  }
});
