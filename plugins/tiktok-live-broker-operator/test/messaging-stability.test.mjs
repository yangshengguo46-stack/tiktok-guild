import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createBrokerHandlers } from '../src/handlers.mjs';
import { assertSenderIdentity } from '../src/messaging/live-write.mjs';

async function fixture(t, { profileDir, sendMessage, maxWorkflows, workflowTtlMs } = {}) {
  const profile = profileDir ?? await mkdtemp(path.join(os.tmpdir(), 'broker-stability-'));
  if (!profileDir) t.after(() => rm(profile, { recursive: true, force: true }));
  let pages = 0;
  const context = { pages: () => [], newPage: async () => { pages++; await new Promise(r => setImmediate(r)); return { close: async () => {} }; } };
  const handlers = createBrokerHandlers({
    maxWorkflows, workflowTtlMs,
    composition: {
      profileDir: profile,
      sessionOwner: { getStatus: () => ({ state: 'running' }), ensureActive: async () => context },
      brokerAccountRef: 'affiliate:mira.creator_01', brokerIdentityText: 'Mira', liveReader: async () => ({ data: {}, evidence: [] }),
    },
    guildDiscovery: async () => ({ guild_id: '103785' }),
    sendMessage: sendMessage ?? (async () => ({ status: 'unknown', provider_status: null, read_back: { visible: true, matched: true } })),
  });
  const guild_ref = (await handlers.broker_workspace({})).structuredContent.data.guild_ref;
  const prepare = async (workflow, key, content = 'hello') => handlers.broker_messaging({ guild_ref, child: 'prepare_message', params: { workflow_id: workflow, sender_account_ref: 'affiliate:mira.creator_01', recipient_handle: 'exact.creator', content, idempotency_key: key } });
  const send = async workflow => (await handlers.broker_messaging({ guild_ref, child: 'send_message', params: { workflow_id: workflow } })).structuredContent;
  return { profile, handlers, guild_ref, prepare, send, pages: () => pages };
}

test('different workflows on the shared page never overlap provider dispatch', async t => {
  let active = 0, peak = 0;
  const f = await fixture(t, { sendMessage: async () => { active++; peak = Math.max(peak, active); await new Promise(r => setTimeout(r, 25)); active--; return { status: 'unknown' }; } });
  await f.prepare('wf1', 'key1'); await f.prepare('wf2', 'key2');
  await Promise.all([f.send('wf1'), f.send('wf2')]);
  assert.equal(peak, 1);
  assert.equal(f.pages(), 2); // discovery page plus a single retained messaging page
});

test('unknown sends stay consumed after handler restart', async t => {
  let clicks = 0;
  const sender = async () => { clicks++; return { status: 'unknown', provider_status: null }; };
  const f = await fixture(t, { sendMessage: sender });
  await f.prepare('wf1', 'persistent'); await f.send('wf1');
  const restarted = await fixture(t, { profileDir: f.profile, sendMessage: sender });
  await restarted.prepare('wf2', 'persistent');
  const result = await restarted.send('wf2');
  assert.equal(clicks, 1);
  assert.equal(result.errors[0].code, 'duplicate_write');
  const status = (await restarted.handlers.broker_messaging({ guild_ref: restarted.guild_ref, child: 'get_operation_status', params: { idempotency_key: 'persistent' } })).structuredContent;
  assert.equal(status.data.state, 'unknown');
});

test('same key with changed content is a payload conflict', async t => {
  const f = await fixture(t);
  await f.prepare('wf1', 'conflict'); await f.send('wf1');
  await f.prepare('wf2', 'conflict', 'different');
  const result = await f.send('wf2');
  assert.equal(result.errors[0].code, 'idempotency_conflict');
});

test('a display marker in unrelated page text is not a sender identity', () => {
  assert.throws(() => assertSenderIdentity('Someone wrote about Mira', 'Mira'), e => e.code === 'authorization_required');
  assert.throws(() => assertSenderIdentity('MiraExtra', 'Mira'), e => e.code === 'authorization_required');
});

test('operation status and reconciliation after restart never need browser discovery', async t => {
  const f = await fixture(t);
  await f.prepare('wf1', 'readonly'); await f.send('wf1');
  let starts=0;
  const restarted=createBrokerHandlers({ composition:{ profileDir:f.profile,
    sessionOwner:{getStatus:()=>({state:'stopped'}),ensureActive:async()=>{starts++;throw new Error('must not start');}},
    brokerAccountRef:'affiliate:mira.creator_01',brokerIdentityText:'Mira',liveReader:async()=>({data:{}}) } });
  for (const child of ['get_operation_status','reconcile_message']) {
    const result=(await restarted.broker_messaging({guild_ref:f.guild_ref,child,params:{idempotency_key:'readonly'}})).structuredContent;
    assert.equal(result.status,'ok');
    assert.equal(result.data.state,'unknown');
  }
  assert.equal(starts,0);
});


test('message workflows have a hard capacity and expire without releasing reserved keys', async t => {
  const f=await fixture(t,{maxWorkflows:1,workflowTtlMs:80});
  assert.equal((await f.prepare('wf1','one')).structuredContent.status,'ok');
  assert.equal((await f.prepare('wf2','two')).structuredContent.errors[0].code,'workflow_capacity');
  await f.send('wf1');assert.equal((await f.prepare('wf2','two')).structuredContent.status,'ok');
  await new Promise(r=>setTimeout(r,90));assert.equal((await f.prepare('wf3','three')).structuredContent.status,'ok');
  assert.equal((await f.send('wf2')).errors[0].code,'guild_binding_not_found');
  assert.equal((await f.handlers.broker_messaging({guild_ref:f.guild_ref,child:'get_operation_status',params:{idempotency_key:'one'}})).structuredContent.data.state,'unknown');
});
