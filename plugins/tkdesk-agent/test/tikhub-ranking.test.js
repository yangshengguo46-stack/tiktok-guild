import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, chmod, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const api = await import('../mcp/core/tikhub-ranking.js').catch(() => ({}));
const KEY = 'TEST_ONLY_PROVIDER_KEY_NEVER_PUBLIC';
const seed = { anchorId: '6914237923885843458', roomId: '7689848338484579093', countryCode: 'SA' };
const row = { rank: 1, score: '9007199254740993123', room_id_str: '0', rank_user: { id: 118481569702383620, id_str: '118481569702383616', display_id: 'saaifz', nickname: 'Creator', follow_info: { follower_count: 49055 } } };
function envelope(overrides = {}) {
  return { code: 200, request_id: 'test-request', time_stamp: 1790439478,
    data: { status_code: 0, data: { rank_view: { rank_type: 16, countdown: 16834, rank_extra_info: { class_extra: { class_type: 400 } }, ranks: [row] } } }, ...overrides };
}
async function fixture(t, fetchImpl = async () => Response.json(envelope())) {
  assert.equal(typeof api.createTikHubRankingTransport, 'function', 'TikHub adapter is not implemented');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tkdesk-tikhub-test-'));
  await mkdir(path.join(dir, 'providers'), { mode: 0o700 });
  const file = path.join(dir, 'providers', 'tikhub.json');
  await writeFile(file, JSON.stringify({ apiKey: KEY, ranking: { enabled: true } }), { mode: 0o600 });
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { transport: api.createTikHubRankingTransport({ dataDirectory: dir, fetchImpl }), file };
}

test('TikHub fixed request uses only provider key and preserves identity, score and unknown geography', async t => {
  let captured;
  const { transport } = await fixture(t, async (url, options) => { captured = { url: String(url), options }; return Response.json(envelope()); });
  const result = await transport.fetchSnapshot({ seed, rankingKind: 'league', rankingPeriod: 'current' });
  const u = new URL(captured.url);
  assert.equal(u.origin + u.pathname, 'https://api.tikhub.io/api/v1/tiktok/app/v3/fetch_live_daily_rank');
  assert.deepEqual(Object.fromEntries(u.searchParams), { anchor_id: '6914237923885843458', room_id: '7689848338484579093', rank_type: '16', region_type: '1', gap_interval: '0' });
  assert.equal(captured.options.headers.Authorization, `Bearer ${KEY}`);
  assert.equal(Object.hasOwn(captured.options.headers, 'Cookie'), false);
  assert.equal(captured.options.redirect, 'error');
  assert.equal(result.totalRanks, 1);
  const c = result.candidates[0];
  assert.equal(c.userId, '118481569702383616');
  assert.equal(c.rankScoreRaw, '9007199254740993123');
  assert.equal(c.followerCount, 49055);
  assert.equal(c.live, false);
  assert.equal(c.creatorCountryCode, null);
  assert.equal(c.rankingScopeCountryCode, null);
  assert.equal(c.rankingContextCountryCode, 'SA');
  assert.equal(c.rankingClassType, 400);
  assert.equal(c.rankScoreUnit, 'unknown_rank_score');
  assert.equal(c.source, 'tikhub_live_rankings');
  assert.equal(JSON.stringify({ result, status: await transport.status() }).includes(KEY), false);
});

test('historical daily request retains distinct type and period rather than original league parity', async t => {
  let query;
  const e = envelope(); e.data.data.rank_view.rank_type = 8;
  const { transport } = await fixture(t, async url => { query = new URL(url).searchParams; return Response.json(e); });
  const result = await transport.fetchSnapshot({ seed, rankingKind: 'daily', rankingPeriod: 'previous' });
  assert.equal(query.get('rank_type'), '8'); assert.equal(query.get('gap_interval'), '-1');
  assert.equal(result.candidates[0].rankingPeriod, 'previous');
  assert.equal(result.originalParity, false);
});

test('provider rejects unknown selectors and malformed seeds before network or charging', async t => {
  let calls = 0; const { transport } = await fixture(t, async () => { calls++; return Response.json(envelope()); });
  for (const request of [{ seed, rankingKind: 'anything' }, { seed, rankingPeriod: 'next' }, { seed: { ...seed, roomId: '0' } }, { seed: { ...seed, anchorId: 6914237923885843000 } }]) {
    await assert.rejects(transport.fetchSnapshot(request), e => e.code === 'tikhub_request_invalid');
  }
  assert.equal(calls, 0);
});

test('missing or insecure provider credential fails without a paid request', async t => {
  let calls = 0; const { transport, file } = await fixture(t, async () => { calls++; return Response.json(envelope()); });
  await chmod(file, 0o644);
  assert.equal((await transport.status()).state, 'configuration_invalid');
  await assert.rejects(transport.fetchSnapshot({ seed }), e => e.code === 'tikhub_configuration_invalid');
  await rm(file);
  assert.equal((await transport.status()).state, 'missing');
  await assert.rejects(transport.fetchSnapshot({ seed }), e => e.code === 'tikhub_configuration_missing');
  assert.equal(calls, 0);
});

test('operator can disable paid ranking while retaining the optional research credential', async t => {
  let calls = 0;
  const { transport, file } = await fixture(t, async () => { calls++; return Response.json(envelope()); });
  await writeFile(file, JSON.stringify({ apiKey: KEY, ranking: { enabled: false }, research: { enabled: true } }), { mode: 0o600 });
  assert.equal((await transport.status()).state, 'disabled');
  await assert.rejects(transport.fetchSnapshot({ seed }), error => error.code === 'tikhub_ranking_disabled');
  assert.equal(calls, 0);
  await writeFile(file, JSON.stringify({ apiKey: KEY, research: { enabled: true } }), { mode: 0o600 });
  assert.equal((await transport.status()).state, 'disabled', 'ranking must require its own explicit opt-in');
  await assert.rejects(transport.fetchSnapshot({ seed }), error => error.code === 'tikhub_ranking_disabled');
  assert.equal(calls, 0);
});

test('provider errors cannot leak echoed authorization headers and are never retried', async t => {
  let calls = 0; const { transport } = await fixture(t, async () => { calls++; return Response.json({ detail: { code: 403, message: KEY, headers: { Authorization: `Bearer ${KEY}` } } }, { status: 403 }); });
  await assert.rejects(transport.fetchSnapshot({ seed }), e => {
    assert.equal(e.code, 'tikhub_permission_required');
    assert.equal(JSON.stringify({ message: e.message, details: e.details, stack: e.stack }).includes(KEY), false);
    return true;
  });
  assert.equal(calls, 1);
});

test('HTTP success does not hide TikTok business errors, wrong boards or malformed payloads', async t => {
  const bodies = [envelope({ data: { status_code: 1 } }), envelope({ data: { status_code: 0, data: {} } }), envelope()];
  bodies[2].data.data.rank_view.rank_type = 8;
  const { transport } = await fixture(t, async () => Response.json(bodies.shift()));
  for (const code of ['tikhub_upstream_rejected', 'tikhub_rank_view_missing', 'tikhub_rank_type_mismatch']) {
    await assert.rejects(transport.fetchSnapshot({ seed }), e => e.code === code);
  }
});

test('projection drops masked identities, unsafe numeric scores and unrelated nested payloads', async t => {
  const e = envelope();e.data.data.rank_view.ranks = [row, { ...row, rank: 2 }, { ...row, rank_user: { display_id: 's***', id_str: '12' } }, { score: 9007199254740992, rank: 3, rank_user: { display_id: 'unknown.score', id: 6914237923885843000 }, token: KEY }];
  const { transport } = await fixture(t, async () => Response.json(e));
  const r = await transport.fetchSnapshot({ seed });
  assert.equal(r.candidates.length, 2);
  assert.equal(r.candidates[1].rankScoreRaw, null);
  assert.equal(r.candidates[1].userId, null);
  assert.equal(r.candidates[1].live, null);
  assert.equal(JSON.stringify(r).includes(KEY), false);
});

test('transport redirects and oversized responses are rejected', async t => {
  const { transport } = await fixture(t, async () => new Response('x'.repeat(4 * 1024 * 1024 + 1)));
  await assert.rejects(transport.fetchSnapshot({ seed }), e => e.code === 'tikhub_response_too_large');
  const { transport: redirects } = await fixture(t, async () => new Response('', { status: 302, headers: { Location: 'https://other.invalid' } }));
  await assert.rejects(redirects.fetchSnapshot({ seed }), e => e.code === 'tikhub_redirect_rejected');
});

test('snapshot collector checkpoints paid attempts and imports one fixed bounded batch', async t => {
  const { transport } = await fixture(t);
  assert.equal(typeof api.collectTikHubRankingSnapshots, 'function');
  let checkpoint = {};const rows = [];
  const result = await api.collectTikHubRankingSnapshots({ transport, seeds: [seed], maxCandidates: 10, checkpoint,
    saveCheckpoint: value => { checkpoint = structuredClone(value); }, onBatch: batch => rows.push(...batch.items) });
  assert.equal(result.complete, true);
  assert.equal(result.snapshotsFetched, 1);
  assert.equal(rows[0].handle, 'saaifz');
  assert.equal(checkpoint.snapshots[0].state, 'committed');
  assert.equal(checkpoint.snapshots[0].candidates[0].userId, '118481569702383616');
  assert.equal(JSON.stringify(checkpoint).includes(KEY), false);
});

test('resume reuses committed snapshots and never replays an uncertain billed attempt', async t => {
  let calls = 0; const { transport } = await fixture(t, async () => { calls++; return Response.json(envelope()); });
  let checkpoint = {}; let received = 0;
  const options = { transport, seeds: [seed], rankingPeriod: 'both', maxCandidates: 10, checkpoint,
    saveCheckpoint: value => { checkpoint = structuredClone(value); }, onBatch: batch => { received += batch.items.length; }, shouldStop: () => received > 0 };
  await api.collectTikHubRankingSnapshots(options);
  assert.equal(calls, 1);
  const r = await api.collectTikHubRankingSnapshots({ ...options, checkpoint, shouldStop: () => false });
  assert.equal(calls, 2); assert.equal(r.complete, true);
  const uncertain = structuredClone(checkpoint); uncertain.snapshots[1] = { state: 'attempted' };
  await assert.rejects(api.collectTikHubRankingSnapshots({ ...options, checkpoint: uncertain, shouldStop: () => false }), e => e.code === 'tikhub_paid_attempt_unresolved');
  assert.equal(calls, 2);
});

test('collector applies follower filters, cap and cross-snapshot dedup without asserting country', async t => {
  const e = envelope(); e.data.data.rank_view.ranks.push({ ...row, rank: 2, rank_user: { ...row.rank_user, display_id: 'small.creator', id_str: '118481569702383617', follow_info: { follower_count: 1 } } });
  let calls = 0; const { transport } = await fixture(t, async () => { calls++; return Response.json(e); });
  const rows=[];
  const r=await api.collectTikHubRankingSnapshots({ transport, seeds: [seed], rankingPeriod: 'both', maxCandidates: 1, filters: { minFollowers: 100 }, onBatch: b => rows.push(...b.items), saveCheckpoint: () => {} });
  assert.equal(calls, 1); assert.equal(rows.length, 1);assert.equal(r.selectionComplete,true);assert.equal(r.complete,false);
});

test('current and previous observations both survive deduplication of the same creator', async t => {
  const { transport } = await fixture(t, async url => {
    const e=envelope();e.data.data.rank_view.ranks[0]={...row,score:new URL(url).searchParams.get('gap_interval')==='-1'?'17':'99'};return Response.json(e);
  });
  let final;
  const r=await api.collectTikHubRankingSnapshots({transport,seeds:[seed],rankingPeriod:'both',maxCandidates:10,saveCheckpoint:()=>{},onBatch:b=>{final=b.items.at(-1);}});
  assert.equal(r.found,1);
  assert.ok(final, 'historical snapshot must update the existing creator');
  assert.deepEqual(final.rankingObservations.map(o=>({gapInterval:o.gapInterval,scoreRaw:o.scoreRaw})),[{gapInterval:0,scoreRaw:'99'},{gapInterval:-1,scoreRaw:'17'}]);
});
