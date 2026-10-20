import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { DatabaseStore } from '../mcp/core/database.js';
import { resumeOriginalDueRankingSeeds, enqueueQualifiedOriginalRankingSeeds } from '../mcp/core/original-cascade-runtime.js';

test('qualified league seeds are ready on the first scan while countdown suppresses duplicate observations', async t => {
  const dir = await mkdtemp('/tmp/tkdesk-ranking-countdown-');
  let now = new Date('2026-09-27T00:00:00Z');
  const database = new DatabaseStore(`${dir}/test.sqlite`, { clock: () => now }).init();
  t.after(async () => { database.close(); await rm(dir, { recursive: true, force: true }); });
  const runId = 'league-ready';
  database.createRun({ runId, source: 'tiktok_live', mode: 'full_auto' });
  const candidate = { candidateId: 'b-available', userId: '100000001', roomId: '200000001', handle: 'qualified',
    qualificationStatus: 'available', workId: 1, rankingScopeCountryCode: 'SA', originalRankingCountdownSeconds: 86400 };
  enqueueQualifiedOriginalRankingSeeds({ database, runId, candidates: [candidate] });
  const [claim] = database.claimDueOriginalDiscoverySeeds({ runId, seedKind: 'ranking', limit: 1 });
  assert.ok(claim, 'league countdown must not defer the first expansion until tomorrow');
  database.completeOriginalDiscoverySeed(claim.queueId, { claimToken: claim.claimToken });
  now = new Date('2026-09-27T00:11:00Z');
  assert.equal(enqueueQualifiedOriginalRankingSeeds({ database, runId, candidates: [candidate] }).duplicates, 1);
  assert.equal(database.getDiscoverySeed(claim.queueId).status, 'completed');
});

test('eligible reobservation repairs only legacy pending ranking delays and preserves an active lease', async t => {
  const dir = await mkdtemp('/tmp/tkdesk-ranking-legacy-');
  const database = new DatabaseStore(`${dir}/test.sqlite`, { clock: () => new Date('2026-09-27T00:00:00Z') }).init();
  t.after(async () => { database.close(); await rm(dir, { recursive: true, force: true }); });
  const runId = 'league-legacy';
  database.createRun({ runId, source: 'tiktok_live', mode: 'full_auto' });
  const candidate = { candidateId: 'c-available', userId: '100000001', roomId: '200000001', handle: 'qualified',
    qualificationStatus: 'available', rankingScopeCountryCode: 'SA', originalRankingCountdownSeconds: 86400 };
  database.enqueueOriginalDiscoverySeed({ runId, seedKind: 'ranking', identityKey: 'SA:user:100000001', payload: { candidateId: candidate.candidateId }, countdownSeconds: 86400 });
  enqueueQualifiedOriginalRankingSeeds({ database, runId, candidates: [candidate] });
  const [claim] = database.claimDueOriginalDiscoverySeeds({ runId, seedKind: 'ranking', limit: 1 });
  assert.ok(claim, 'eligible legacy pending seeds remain deferred');
  enqueueQualifiedOriginalRankingSeeds({ database, runId, candidates: [candidate] });
  assert.equal(database.getDiscoverySeed(claim.queueId).claimToken, claim.claimToken);
  assert.equal(database.getDiscoverySeed(claim.queueId).status, 'processing');
});

test('ranking dependency failure must preserve concurrent Feed/Data claim ownership', async t => {
  const dir = await mkdtemp('/tmp/tkdesk-final-review-db-');
  let now = new Date('2026-09-26T00:00:00Z');
  const database = new DatabaseStore(`${dir}/test.sqlite`, { clock: () => now }).init();
  t.after(async () => { database.close(); await rm(dir, { recursive: true, force: true }); });
  const runId = 'review';
  database.createRun({ runId, source: 'tiktok_live', mode: 'full_auto' });
  const lane = { workId: 1, countryCode: 'SA', proxyServer: 'http://127.0.0.1:18101', proxyExitCountry: 'SA' };
  const candidate = { candidateId: 'available', userId: '100000000', roomId: '200000000', handle: 'qualified', qualificationStatus: 'available', workId: 1, rankingScopeCountryCode: 'SA' };
  enqueueQualifiedOriginalRankingSeeds({ database, runId, candidates: [candidate] });
  now = new Date('2026-09-26T00:03:01Z');
  database.enqueueOriginalDiscoverySeed({ runId, seedKind: 'feed', identityKey: 'SA:in-flight-data', payload: { handle: 'in-flight-data' } });
  const [claim] = database.claimDueOriginalDiscoverySeeds({ runId, seedKind: 'feed', limit: 1 });
  const result = await resumeOriginalDueRankingSeeds({
    database, runId, qualifiedCandidates: [candidate], verifiedRoute: { collectionLanes: [lane] },
    marketRegion: 'MENA', selectedCountryCodes: ['SA'], laneForCandidate: () => lane,
    rankingTransport: { fetchPair: async () => ({ status: 'capability_not_ready', reason: 'ranking_mobile_authorization_required', candidates: [] }) },
    enrichOnce: async () => { throw new Error('must not enrich missing ranking'); }
  });
  assert.equal(result.mobileSessionRequired, true);
  const after = database.getDiscoverySeed(claim.queueId);
  assert.equal(after.status, 'processing', 'Ranking must not release the independent Data claim');
  assert.equal(after.claimToken, claim.claimToken);
  database.completeOriginalDiscoverySeed(claim.queueId, { claimToken: claim.claimToken });
});


for (const scenario of ["throw", "bounded", "missing_lane", "stale_ownership"]) {
  test(`ranking ${scenario} cleanup preserves concurrent claims and token fences`, async t => {
    const dir = await mkdtemp('/tmp/tkdesk-final-ranking-db-');
    let now = new Date('2026-09-26T00:00:00Z');
    const database = new DatabaseStore(`${dir}/test.sqlite`, { clock: () => now }).init();
    t.after(async () => { database.close(); await rm(dir, { recursive: true, force: true }); });
    const runId = 'review';
    database.createRun({ runId, source: 'tiktok_live', mode: 'full_auto' });
    const lane = { workId: 1, countryCode: 'SA', proxyServer: 'http://127.0.0.1:18101', proxyExitCountry: 'SA' };
    const candidate = { candidateId: 'available', userId: '100000000', roomId: '200000000', handle: 'qualified', qualificationStatus: 'available', workId: 1, rankingScopeCountryCode: 'SA' };
    enqueueQualifiedOriginalRankingSeeds({ database, runId, candidates: [candidate] });
    now = new Date('2026-09-26T00:03:01Z');
    database.enqueueOriginalDiscoverySeed({ runId, seedKind: 'feed', identityKey: 'SA:in-flight-data', payload: { handle: 'in-flight-data' } });
    const [feedClaim] = database.claimDueOriginalDiscoverySeeds({ runId, seedKind: 'feed', limit: 1 });
    let replacement;
    const options = {
      database, runId, qualifiedCandidates: [candidate], verifiedRoute: { collectionLanes: [lane] },
      marketRegion: 'MENA', selectedCountryCodes: ['SA'], laneForCandidate: () => scenario === 'missing_lane' ? null : lane,
      receivedCount: () => scenario === 'bounded' ? 100 : 0,
      rankingTransport: { fetchPair: async () => {
        if (scenario === 'throw') throw Object.assign(new Error('ranking transport failed'), { code: 'TEST_TRANSPORT_FAILURE' });
        if (scenario === 'stale_ownership') {
          const [owned] = database.listDiscoverySeeds({ runId, seedKind: 'ranking', status: 'processing' });
          database.releaseOriginalDiscoverySeed(owned.queueId, { claimToken: owned.claimToken });
          [replacement] = database.claimDueOriginalDiscoverySeeds({ runId, seedKind: 'ranking', limit: 1 });
        }
        return { status: 'capability_not_ready', reason: 'ranking_mobile_authorization_required', candidates: [] };
      } },
      enrichOnce: async () => { throw new Error('must not enrich missing ranking'); }
    };
    if (scenario === 'throw') await assert.rejects(resumeOriginalDueRankingSeeds(options), { code: 'TEST_TRANSPORT_FAILURE' });
    else await resumeOriginalDueRankingSeeds(options);
    assert.equal(database.getDiscoverySeed(feedClaim.queueId).status, 'processing');
    assert.equal(database.getDiscoverySeed(feedClaim.queueId).claimToken, feedClaim.claimToken);
    database.completeOriginalDiscoverySeed(feedClaim.queueId, { claimToken: feedClaim.claimToken });
    if (replacement) {
      assert.equal(database.getDiscoverySeed(replacement.queueId).claimToken, replacement.claimToken);
      database.completeOriginalDiscoverySeed(replacement.queueId, { claimToken: replacement.claimToken });
    } else {
      const [ranking] = database.listDiscoverySeeds({ runId, seedKind: 'ranking' });
      assert.equal(ranking.status, 'pending');
      assert.equal(ranking.claimToken, null);
    }
  });
}
