import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, chmod, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDatabase } from '../mcp/core/database.js';
const api = await import('../mcp/core/tikhub-enrichment.js').catch(() => ({}));
const KEY = 'TEST_ONLY_RESEARCH_PROVIDER_KEY';
const creator = { candidateId: 'creator-test', handle: 'creator.test', userId: '6914237923885843458' };
const profile = { code: 200, request_id: 'profile-test', data: { status_code: 0, user: {
  uid: creator.userId, unique_id: creator.handle, sec_uid: 'MS4wLjABTEST_PUBLIC_CREATOR_ID',
  nickname: 'Test creator', signature: 'مرحبا بالعالم', follower_count: 1200, total_favorited: 3400, aweme_count: 4, region: 'SA'
} } };
const posts = { code: 200, request_id: 'posts-test', data: { status_code: 0, has_more: 1, aweme_list: [
  { aweme_id: '7689848338484579093', desc: 'مساء الخير', create_time: 1790500000, author: { uid: creator.userId, unique_id: creator.handle },
    statistics: { play_count: 1000, digg_count: 50, comment_count: 3, share_count: 2 }, video: { duration: 30000 } }
] } };
async function fixture(t, options = {}) {
  assert.equal(typeof api.createTikHubEnrichment, 'function');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'tkdesk-research-'));
  await mkdir(path.join(directory, 'providers'), { mode: 0o700 });
  const configPath = path.join(directory, 'providers', 'tikhub.json');
  await writeFile(configPath, JSON.stringify({ apiKey: KEY, research: { enabled: true, dailyRequestLimit: 10, ...options.research } }), { mode: 0o600 });
  const store = createDatabase(path.join(directory, 'tkdesk.sqlite3'));
  store.upsertProspect({ ...creator, source: 'tiktok_live', invitationEligibility: 'available', data: { language: null } });
  let now = Date.parse('2026-09-28T00:00:00Z'); let calls = 0;
  const fetchImpl = options.fetchImpl ?? (async url => {
    calls++; return Response.json(String(url).includes('handler_user_profile') ? profile : posts);
  });
  const make = () => api.createTikHubEnrichment({ store, dataDirectory: directory, fetchImpl, clock: () => now, timeoutMs: options.timeoutMs ?? 1000 });
  const research = make();
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  return { research, store, configPath, make, calls: () => calls, advance: n => { now += n; } };
}

test('missing credentials and default cache-only mode leave the core usable without paid calls', async t => {
  const f = await fixture(t);
  const before = f.store.getProspect(creator.candidateId);
  assert.equal((await f.research.research({ candidateId: creator.candidateId })).state, 'unavailable');
  assert.equal(f.calls(), 0);
  await rm(f.configPath);
  assert.equal((await f.research.status()).configured, false);
  const result = await f.research.research({ candidateId: creator.candidateId, allowPaid: true, requestId: 'missing-key' });
  assert.equal(result.coreUsable, true); assert.equal(result.reason, 'configuration_missing');
  assert.deepEqual(f.store.getProspect(creator.candidateId), before);
});

test('fixed two reads cache attributed public evidence without changing qualification or inventing language', async t => {
  const requests = [];
  const f = await fixture(t, { fetchImpl: async (url, options) => {
    requests.push({ url: new URL(url), options });
    return Response.json(String(url).includes('handler_user_profile') ? profile : posts);
  } });
  const before = f.store.getProspect(creator.candidateId);
  const result = await f.research.research({ candidateId: creator.candidateId, includePosts: true, allowPaid: true, requestId: 'full-read' });
  assert.equal(result.state, 'ready'); assert.equal(result.paidRequests, 2);
  assert.equal(result.profile.data.bio, profile.data.user.signature);
  assert.equal(result.posts.data.posts[0].metrics.views, 1000);
  assert.equal(result.posts.data.posts[0].durationSeconds, 30);
  assert.equal(result.posts.data.completeHistory, false);
  assert.equal(result.languageAssessment, 'requires_text_assessment');
  assert.equal(result.profile.data.inferredLanguage, undefined);
  assert.equal(result.profile.source, 'tikhub_public_research');
  assert.ok(result.profile.observedAt); assert.equal(result.profile.providerRequestId, 'profile-test');
  assert.deepEqual(f.store.getProspect(creator.candidateId), before);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url.searchParams.get('unique_id'), creator.handle);
  assert.equal(requests[1].url.searchParams.get('sec_user_id'), profile.data.user.sec_uid);
  assert.equal(requests[1].url.searchParams.get('max_cursor'), '0');
  assert.equal(requests[1].url.searchParams.get('sort_type'), '0');
  for (const r of requests) {
    assert.equal(r.url.origin, 'https://api.tikhub.io');
    assert.equal(r.options.redirect, 'error'); assert.equal(r.options.headers.Authorization, `Bearer ${KEY}`);
    assert.equal(r.options.headers.Cookie, undefined);
    assert.equal(r.url.pathname.includes('rank'), false);
  }
  const cached = await f.make().research({ candidateId: creator.candidateId, includePosts: true });
  assert.equal(cached.state, 'ready'); assert.equal(cached.paidRequests, 0); assert.equal(cached.cacheHit, true);
  assert.equal((await f.research.status()).budget.attemptedToday, 2);
  assert.equal(JSON.stringify({ result, cached, status: await f.research.status() }).includes(KEY), false);
});

test('durable idempotence and simultaneous requests make only one paid operation', async t => {
  let release; let calls = 0;
  const f = await fixture(t, { fetchImpl: async () => { calls++; await new Promise(resolve => { release = resolve; }); return Response.json(profile); } });
  const first = f.research.research({ candidateId: creator.candidateId, allowPaid: true, requestId: 'one' });
  while (!release) await new Promise(resolve => setTimeout(resolve, 1));
  const second = await f.make().research({ candidateId: creator.candidateId, allowPaid: true, requestId: 'two' });
  assert.equal(second.reason, 'research_in_progress'); assert.equal(calls, 1);
  release(); const result = await first; assert.equal(result.state, 'ready');
  assert.equal((await f.make().research({ candidateId: creator.candidateId, allowPaid: true, requestId: 'one' })).idempotentReplay, true);
  const conflict = await f.research.research({ candidateId: creator.candidateId, includePosts: true, allowPaid: true, requestId: 'one' });
  assert.equal(conflict.reason, 'request_id_conflict'); assert.equal(calls, 1);
});

test('budget survives restart and partial profile result remains useful when posts budget is exhausted', async t => {
  const f = await fixture(t, { research: { dailyRequestLimit: 1 } });
  const r = await f.research.research({ candidateId: creator.candidateId, includePosts: true, allowPaid: true, requestId: 'budget' });
  assert.equal(r.state, 'partial'); assert.equal(r.paidRequests, 1); assert.equal(r.reason, 'daily_budget_exhausted');
  const next = await f.make().research({ candidateId: creator.candidateId, includePosts: true, allowPaid: true, requestId: 'budget-next' });
  assert.equal(next.state, 'partial'); assert.equal(f.calls(), 1);
  assert.equal((await f.make().status()).budget.attemptedToday, 1);
});

test('provider errors, identity mismatch and unsafe configuration never leak credentials or silently retry', async t => {
  for (const scenario of ['echo', 'wrong_identity', 'wrong_posts']) {
    let calls = 0;
    const f = await fixture(t, { fetchImpl: async url => {
      calls++;
      if (scenario === 'echo') throw new Error(`Authorization: Bearer ${KEY}`);
      if (String(url).includes('handler_user_profile')) return Response.json(scenario === 'wrong_identity'
        ? { ...profile, data: { user: { ...profile.data.user, unique_id: 'someone.else' } } } : profile);
      return Response.json({ ...posts, data: { aweme_list: [{ ...posts.data.aweme_list[0], author: { unique_id: 'someone.else' } }] } });
    } });
    const r = await f.research.research({ candidateId: creator.candidateId, includePosts: true, allowPaid: true, requestId: scenario });
    assert.notEqual(r.state, 'ready'); assert.equal(JSON.stringify(r).includes(KEY), false);
    const n = calls;
    await f.make().research({ candidateId: creator.candidateId, includePosts: true, allowPaid: true, requestId: `${scenario}-retry` });
    assert.equal(calls, n, 'uncertain paid read must be fenced');
  }
  const f = await fixture(t); await chmod(f.configPath, 0o644);
  assert.equal((await f.research.status()).configured, false);
  assert.equal(f.calls(), 0);
});

test('body timeout and oversize response are bounded, sanitized, and counted once', async t => {
  for (const scenario of ['timeout', 'oversize']) {
    let calls = 0;
    const f = await fixture(t, { timeoutMs: 20, fetchImpl: async () => {
      calls++;
      return new Response(new ReadableStream({ start(controller) {
        if (scenario === 'oversize') { controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1)); controller.close(); }
      } }));
    } });
    const r = await f.research.research({ candidateId: creator.candidateId, allowPaid: true, requestId: scenario });
    assert.equal(r.state, 'unavailable'); assert.equal(r.paidRequests, 1); assert.equal(calls, 1);
    assert.equal((await f.make().status()).budget.attemptedToday, 1);
  }
});

test('expired research cache refreshes only by explicit paid request and disabled provider stays optional', async t => {
  const f = await fixture(t, { research: { cacheTtlSeconds: 300 } });
  await f.research.research({ candidateId: creator.candidateId, allowPaid: true, requestId: 'first' });
  f.advance(301000);
  assert.equal((await f.make().research({ candidateId: creator.candidateId })).state, 'unavailable');
  assert.equal(f.calls(), 1);
  assert.equal((await f.make().research({ candidateId: creator.candidateId, allowPaid: true, requestId: 'refresh' })).state, 'ready');
  assert.equal(f.calls(), 2);
  const r = await f.research.research({ candidateId: creator.candidateId, allowPaid: true, requestId: 'cached-operation' });
  assert.equal(r.cacheHit, true);
  const conflict = await f.research.research({ candidateId: creator.candidateId, includePosts: true, allowPaid: true, requestId: 'cached-operation' });
  assert.equal(conflict.reason, 'request_id_conflict');
  await writeFile(f.configPath, JSON.stringify({ apiKey: KEY, research: { enabled: false } }), { mode: 0o600 });
  f.advance(301000);
  assert.equal((await f.make().research({ candidateId: creator.candidateId, allowPaid: true, requestId: 'disabled' })).reason, 'research_disabled');
  assert.equal(f.calls(), 2);
});

test('known immutable creator id cannot be hidden or swapped in a public profile', async t => {
  for (const uid of [undefined, '118481569702383616']) {
    const f = await fixture(t, { fetchImpl: async () => Response.json({ ...profile, data: { user: { ...profile.data.user, uid } } }) });
    const result = await f.research.research({ candidateId: creator.candidateId, allowPaid: true, requestId: 'identity' });
    assert.equal(result.reason, 'identity_mismatch'); assert.equal(result.profile, null);
  }
});

test('successful provider echoes cannot put the credential into projected ids, cache or output', async t => {
  const f = await fixture(t, { fetchImpl: async () => Response.json({ ...profile, request_id: KEY,
    data: { user: { ...profile.data.user, sec_uid: KEY, nickname: KEY, signature: KEY } } }) });
  const result = await f.research.research({ candidateId: creator.candidateId, allowPaid: true, requestId: 'echo-success' });
  assert.equal(result.state, 'ready');
  assert.equal(JSON.stringify(result).includes(KEY), false);
  const cache = f.store.database.prepare('SELECT result_json FROM tikhub_research_cache').all();
  assert.equal(JSON.stringify(cache).includes(KEY), false);
});
