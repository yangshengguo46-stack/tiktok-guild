import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
function profile(t) { const directory=mkdtempSync(path.join(os.tmpdir(),'broker-unit-')); t.after(()=>rmSync(directory,{recursive:true,force:true})); return directory; }

import { createBrokerHandlers } from '../src/handlers.mjs';
import { createBrokerRouter } from '../src/router.mjs';

function composition(t) {
  const profileDir = profile(t);
  const page = { async close() {} };
  let launches = 0;
  let discoveries = 0;
  const sessionOwner = {
    getStatus: () => ({ state: launches ? 'running' : 'stopped', visible: false, launch_count: launches }),
    async ensureActive() {
      launches += 1;
      return { pages: () => [page], newPage: async () => ({ async close() {} }) };
    },
    async close() {},
  };
  return {
    profileDir,
    sessionOwner,
    brokerAccountRef: 'affiliate:mira.creator_01',
    brokerIdentityText: 'Mira',
    guildDiscovery: async () => {
      discoveries += 1;
      return {
        guild_id: '103785', guild_name: 'Atlantis', registered_country: 'AE',
        portal_region: 'MENA', account_role: 4, roles: [], discoveries,
      };
    },
    liveReader: async () => ({
      data: { conversations: [] }, evidence: [],
      completeness: { state: 'complete', missing: [] }, pagination: null,
    }),
    sendMessage: async ({ senderAccountRef }) => ({
      status: 'verified', sender_account_ref: senderAccountRef,
      recipient: { creator_id: '738001' }, message_fingerprint: 'test',
      read_back: { visible: true, matched: true },
    }),
  };
}

test('broker handlers expose only broker-scoped tools and fail closed on another sender', async t => {
  const fixture = composition(t);
  const handlers = createBrokerHandlers({
    composition: fixture,
    sendMessage: fixture.sendMessage,
    guildDiscovery: fixture.guildDiscovery,
    liveReader: fixture.liveReader,
    refSalt: Buffer.from('broker-test'),
  });
  assert.deepEqual(Object.keys(handlers), ['broker_workspace', 'broker_messaging']);

  const discovered = await handlers.broker_workspace({});
  assert.equal(discovered.structuredContent.domain, 'broker_workspace');
  const brokerRef = discovered.structuredContent.data.guild_ref;

  const rejectedPlan = await handlers.broker_messaging({
    guild_ref: brokerRef,
    child: 'prepare_message',
    params: {
      workflow_id: 'broker-msg-001',
      sender_account_ref: 'affiliate:other.creator',
      creator_id: '738001',
      content: '你好',
      idempotency_key: 'broker-msg-idem-001',
    },
  });
  assert.equal(rejectedPlan.structuredContent.status, 'error');
  assert.equal(rejectedPlan.structuredContent.errors[0].code, 'authorization_required');

  const plan = await handlers.broker_messaging({
    guild_ref: brokerRef,
    child: 'prepare_message',
    params: {
      workflow_id: 'broker-msg-002',
      sender_account_ref: 'affiliate:mira.creator_01',
      creator_id: '738001',
      content: '你好',
      idempotency_key: 'broker-msg-idem-002',
    },
  });
  assert.equal(plan.structuredContent.domain, 'broker_messaging');
  const sent = await handlers.broker_messaging({
    guild_ref: brokerRef,
    child: 'send_message',
    params: { workflow_id: 'broker-msg-002' },
  });
  assert.equal(sent.structuredContent.status, 'ok');
});

test('broker router lists explicit broker tool names', async t => {
  const fixture = composition(t);
  const handlers = createBrokerHandlers({
    composition: fixture,
    sendMessage: fixture.sendMessage,
    guildDiscovery: fixture.guildDiscovery,
    liveReader: fixture.liveReader,
    refSalt: Buffer.from('router-test'),
  });
  const route = createBrokerRouter({ handlers });
  const listed = await route({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.deepEqual(listed.result.tools.map(({ name }) => name), ['broker_workspace', 'broker_messaging']);
  const unknown = await route({
    jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: 'guild_messaging', arguments: {} },
  });
  assert.equal(unknown.error.code, -32602);
});

test('broker messaging reuses one page across sends and leaves it open', async t => {
  const workspacePage = { async close() {} };
  const messagingPage = { closeCalls: 0, async close() { this.closeCalls += 1; } };
  let newPageCalls = 0;
  const sentPages = [];
  const context = {
    pages: () => [workspacePage],
    newPage: async () => {
      newPageCalls += 1;
      return messagingPage;
    },
  };
  const composition = {
    profileDir: profile(t),
    sessionOwner: {
      getStatus: () => ({ state: 'running', visible: true }),
      async ensureActive() { return context; },
      async close() {},
    },
    brokerAccountRef: 'affiliate:mira.creator_01',
    brokerIdentityText: 'Mira',
    liveReader: async () => ({
      data: { conversations: [] }, evidence: [],
      completeness: { state: 'complete', missing: [] }, pagination: null,
    }),
  };
  const handlers = createBrokerHandlers({
    composition,
    guildDiscovery: async () => ({
      guild_id: '103785', guild_name: 'Atlantis', registered_country: 'AE',
      portal_region: 'MENA', account_role: 0, roles: [],
    }),
    sendMessage: async ({ page, creatorId }) => {
      sentPages.push(page);
      return {
        status: 'verified', sender_account_ref: 'affiliate:mira.creator_01',
        recipient: { creator_id: creatorId }, message_fingerprint: 'test',
        read_back: { visible: true, matched: true },
      };
    },
    refSalt: Buffer.from('reuse-page-test'),
  });

  const discovered = await handlers.broker_workspace({});
  const guildRef = discovered.structuredContent.data.guild_ref;
  for (const [index, creatorId] of ['738001', '738002'].entries()) {
    const workflowId = `reuse-page-${index + 1}`;
    const prepared = await handlers.broker_messaging({
      guild_ref: guildRef,
      child: 'prepare_message',
      params: {
        workflow_id: workflowId,
        sender_account_ref: 'affiliate:mira.creator_01',
        creator_id: creatorId,
        content: '你好',
        idempotency_key: `reuse-page-idem-${index + 1}`,
      },
    });
    assert.equal(prepared.structuredContent.status, 'ok');
    const sent = await handlers.broker_messaging({
      guild_ref: guildRef,
      child: 'send_message',
      params: { workflow_id: workflowId },
    });
    assert.equal(sent.structuredContent.status, 'ok');
  }
  assert.equal(newPageCalls, 1);
  assert.deepEqual(sentPages, [messagingPage, messagingPage]);
  assert.equal(messagingPage.closeCalls, 0);
});
