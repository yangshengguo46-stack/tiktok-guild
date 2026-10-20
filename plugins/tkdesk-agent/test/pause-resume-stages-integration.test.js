import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseStore } from "../mcp/core/database.js";
import {
  enqueueQualifiedOriginalRankingSeeds,
  resumeOriginalDueRankingSeeds,
  runOriginalRegionalFeedDataProcessorRound
} from "../mcp/core/original-cascade-runtime.js";
import {
  listOriginalAutoQualificationProspects,
  waitForOriginalQualificationWindow
} from "../mcp/core/original-qualification-runtime.js";

const SA_LANE = Object.freeze({
  workId: 1,
  countryCode: "SA",
  proxyServer: "http://127.0.0.1:19781",
  proxyExitCountry: "SA"
});

function verifiedRoute() {
  return {
    routeProfileId: "pause-resume-production-route",
    verificationStatus: "verified",
    verifiedAt: "2026-08-23T00:00:00.000Z",
    marketRegion: "MENA",
    discoveryCountry: "US",
    discoveryProxyServer: "http://127.0.0.1:19780",
    discoveryProxyExitCountry: "US",
    collectionLanes: [{
      countryCode: SA_LANE.countryCode,
      proxyServer: SA_LANE.proxyServer
    }],
    collectionProxyExitCountries: [SA_LANE.countryCode]
  };
}

function laneEvidence(workId = 1) {
  return {
    workId,
    countryCode: "SA",
    exitCountry: "SA",
    affinity: workId === 4
      ? "target_country_fallback"
      : "original_proxy_settings_work_id"
  };
}

function discoverySeed() {
  return {
    userId: "7412345678901234101",
    secUid: "MS4wLjABAAAA_pause_resume_seed",
    handle: "resume.sa.creator",
    displayId: "resume.sa.creator",
    displayName: "Resume SA Creator",
    roomId: "7498765432109876101",
    followerCount: 45_000,
    viewerCount: 321,
    creatorCountryCode: "SA",
    countryCode: "SA",
    workId: 1,
    live: true,
    seller: false,
    observedAt: "2026-08-23T00:00:00.000Z",
    rankingScopeMarketRegion: "MENA",
    rankingScopeCountryCode: "SA",
    rankingScopeCountryEvidence: "verified_work_id_country_lane",
    collectionLaneEvidence: laneEvidence()
  };
}

function feedResult(candidates = [discoverySeed()]) {
  return {
    status: "ready",
    workId: 1,
    rankingScopeCountryCode: "SA",
    collectionLaneEvidence: laneEvidence(),
    receivedRooms: candidates.length,
    channelId: 21,
    triggerKind: "original_pc_web_feed",
    adapterEvidenceVersion: "original-pc-web-feed-v1",
    candidates
  };
}

function templateResult(displayName, candidates = [{
  ...discoverySeed(),
  viewerCount: null,
  topCode: 1,
  topScore: "120",
  historyRankScore: null,
  hotListScore: "220",
  rankRecordScore: "320"
}]) {
  return {
    status: "ready",
    evidenceVersion: "tkdesk.original-country-template-bundle.v1",
    fixedTemplateFingerprint: "fixture-safe-fixed-template-fingerprint",
    marketRegion: "MENA",
    countryCode: "SA",
    displayName,
    workId: 1,
    collectionLaneEvidence: laneEvidence(),
    templateLabels: ["TopURL", "HotListURL", "RankRecordURL"],
    templateRowCounts: {
      TopURL: candidates.length,
      HistoryRankURL: null,
      HotListURL: candidates.length,
      RankRecordURL: candidates.length
    },
    templateMergeKeyKind: "normalized_display_id",
    candidates
  };
}

function laneForCandidate(route, seed) {
  const lane = route.collectionLanes.find(
    (item) => item.countryCode === seed.rankingScopeCountryCode
  );
  return lane ? { ...lane, workId: seed.workId === 4 ? 1 : seed.workId, proxyExitCountry: "SA" } : null;
}

function readyDataProcessor(seed) {
  return {
    status: "ready",
    workId: seed.workId,
    collectionLaneEvidence: seed.collectionLaneEvidence,
    completedStages: ["basic", "country", "ranking", "top_score", "anchor_level"],
    adapterEvidenceVersion: "original-data-processor-enrichment-v3",
    enrichment: {
      userId: seed.userId,
      secUid: seed.secUid,
      roomId: seed.roomId,
      followerCount: seed.followerCount,
      userCount: seed.viewerCount,
      creatorCountryCode: "SA",
      currentScore: "20",
      countdown: 1
    }
  };
}

function persistCandidate(database, runId, candidate) {
  return database.upsertProspect({
    candidateId: candidate.candidateId,
    runId,
    source: "tiktok_live",
    userId: candidate.userId,
    secUid: candidate.secUid,
    handle: candidate.handle,
    displayName: candidate.displayName,
    roomId: candidate.roomId,
    marketRegion: "MENA",
    creatorCountryCode: candidate.creatorCountryCode,
    followers: candidate.followerCount,
    live: candidate.live ?? true,
    observedAt: candidate.observedAt ?? "2026-08-23T00:00:00.000Z",
    data: {
      workId: candidate.workId,
      rankingScopeCountryCode: candidate.rankingScopeCountryCode,
      topScore: candidate.topScore,
      hotListScore: candidate.hotListScore,
      rankRecordScore: candidate.rankRecordScore,
      dataProcessorComplete: candidate.dataProcessorComplete,
      dataProcessorStages: candidate.dataProcessorStages
    }
  });
}

test("discovery pause persists fetched PC/Mobile seeds and resumes DataProcessor after SQLite restart", async (t) => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "tkdesk-discovery-pause-resume-"));
  const databasePath = path.join(dataDirectory, "tkdesk.sqlite");
  t.after(() => rm(dataDirectory, { recursive: true, force: true }));
  let database = new DatabaseStore(databasePath).init();
  t.after(() => database.close());
  const runId = "run-discovery-pause-resume";
  database.createRun({
    runId,
    source: "tiktok_live",
    mode: "full_auto",
    status: "discovering",
    filters: {
      discoveryMethod: "regional_gift_ranking",
      marketRegion: "MENA",
      countryCodes: ["SA"],
      maxCandidates: 1
    }
  });

  let pauseRequested = false;
  let dataProcessorCalls = 0;
  const paused = await runOriginalRegionalFeedDataProcessorRound({
    database,
    runId,
    selectedLanes: [SA_LANE],
    verifiedRoute: verifiedRoute(),
    marketRegion: "MENA",
    maxCandidates: 1,
    feedRound: 1,
    shouldStop: () => pauseRequested,
    fetchFeedOnce: async () => feedResult(),
    fetchCountryTemplatesOnce: async ({ displayName }) => {
      pauseRequested = true;
      return templateResult(displayName);
    },
    laneForCandidate,
    enrichOnce: async () => {
      dataProcessorCalls += 1;
      throw new Error("DataProcessor must not start after the persisted discovery safe point");
    },
    onBatch: async () => {
      throw new Error("a paused discovery round must not emit candidates");
    }
  });

  assert.equal(paused.status, "stopped");
  assert.equal(paused.reason, "paused_or_cancelled");
  assert.equal(dataProcessorCalls, 0);
  assert.equal(paused.feedQueue.counts.pending, 1);
  const pausedCheckpoint = database.getCheckpoint(runId, "original_seed_queue", {
    adapter: "tiktok_original_cascade"
  });
  assert.equal(pausedCheckpoint.value.discoveryInputsPersisted, true);
  assert.equal(pausedCheckpoint.value.lastStoppedReason, "paused_or_cancelled");
  assert.equal(database.queryProspects({ runId, limit: 10 }).length, 0);

  database.updateRun(runId, { status: "paused" });
  database.close();
  database = new DatabaseStore(databasePath).init();
  database.updateRun(runId, { status: "discovering" });
  let resumedFeedCalls = 0;
  let resumedTemplateCalls = 0;
  const resumed = await runOriginalRegionalFeedDataProcessorRound({
    database,
    runId,
    selectedLanes: [SA_LANE],
    verifiedRoute: verifiedRoute(),
    marketRegion: "MENA",
    maxCandidates: 1,
    feedRound: 1,
    fetchFeedOnce: async () => {
      resumedFeedCalls += 1;
      return feedResult([]);
    },
    fetchCountryTemplatesOnce: async ({ displayName }) => {
      resumedTemplateCalls += 1;
      return templateResult(displayName, []);
    },
    laneForCandidate,
    enrichOnce: async ({ seed }) => {
      dataProcessorCalls += 1;
      return readyDataProcessor(seed);
    },
    onBatch: async (candidates) => {
      for (const candidate of candidates) persistCandidate(database, runId, candidate);
    }
  });

  assert.equal(resumed.status, "ready");
  assert.equal(resumedFeedCalls, 1);
  assert.equal(resumedTemplateCalls, 1);
  assert.equal(dataProcessorCalls, 1);
  assert.equal(resumed.candidates.length, 1);
  assert.equal(resumed.candidates[0].handle, "resume.sa.creator");
  assert.equal(resumed.candidates[0].topScore, "120");
  assert.equal(resumed.candidates[0].hotListScore, "220");
  assert.equal(resumed.candidates[0].rankRecordScore, "320");
  assert.equal(database.originalDiscoveryQueueStatus(runId, { seedKind: "feed" }).counts.completed, 1);
  const persisted = database.queryProspects({ runId, limit: 10 });
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].handle, "resume.sa.creator");
});

test("qualification spacing pause/restart resumes only never-attempted candidates", async (t) => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "tkdesk-qualification-pause-resume-"));
  const databasePath = path.join(dataDirectory, "tkdesk.sqlite");
  t.after(() => rm(dataDirectory, { recursive: true, force: true }));
  let nowMs = Date.parse("2026-08-23T01:00:00.000Z");
  const options = { clock: () => new Date(nowMs) };
  let database = new DatabaseStore(databasePath, options).init();
  t.after(() => database.close());
  const runId = "run-qualification-pause-resume";
  database.createRun({
    runId,
    source: "tiktok_live",
    mode: "full_auto",
    status: "waiting_quota",
    result: { qualification: { unresolvedCandidateIds: [] } }
  });
  const candidateIds = [];
  for (let index = 0; index < 31; index += 1) {
    const candidateId = `qualification-candidate-${String(index).padStart(2, "0")}`;
    candidateIds.push(candidateId);
    database.upsertProspect({
      candidateId,
      runId,
      source: "tiktok_live",
      userId: `7412345678901234${String(index).padStart(3, "0")}`,
      handle: `qualification.creator.${index}`,
      observedAt: new Date(nowMs).toISOString()
    });
  }
  const attempted = database.reserveQualificationBatch({
    batchId: "qualification-batch-before-pause",
    runId,
    candidateIds: candidateIds.slice(0, 30),
    attemptedAt: new Date(nowMs).toISOString(),
    minimumSpacingSeconds: 60,
    details: { automatic: true }
  });
  database.finishQualificationBatch(attempted.batchId, {
    status: "completed",
    results: attempted.items.map((item) => ({
      candidateId: item.candidateId,
      resultStatus: "available"
    }))
  });

  nowMs += 10_000;
  let pauseRequested = false;
  const waited = await waitForOriginalQualificationWindow({
    database,
    runId,
    nextEligibleAt: "2026-08-23T01:01:00.000Z",
    clock: () => nowMs,
    maxSleepMs: 20_000,
    shouldStop: () => pauseRequested,
    sleep: async (milliseconds) => {
      nowMs += milliseconds;
      pauseRequested = true;
    }
  });
  assert.equal(waited, false);
  assert.equal(database.database.prepare(
    "SELECT COUNT(*) AS count FROM qualification_batches"
  ).get().count, 1);
  const pausedCheckpoint = database.getCheckpoint(runId, "qualification_wait", {
    adapter: "collection_backstage"
  });
  assert.equal(pausedCheckpoint.value.state, "stopped");
  assert.equal(pausedCheckpoint.value.lastStoppedReason, "paused_or_cancelled");

  database.updateRun(runId, { status: "paused" });
  database.close();
  database = new DatabaseStore(databasePath, options).init();
  assert.deepEqual(
    listOriginalAutoQualificationProspects({ database, runId, limit: 30 })
      .map((candidate) => candidate.candidateId),
    [candidateIds[30]]
  );
  const resumedWait = await waitForOriginalQualificationWindow({
    database,
    runId,
    nextEligibleAt: "2026-08-23T01:01:00.000Z",
    clock: () => nowMs,
    maxSleepMs: 30_000,
    sleep: async (milliseconds) => { nowMs += milliseconds; }
  });
  assert.equal(resumedWait, true);
  assert.equal(database.getCheckpoint(runId, "qualification_wait", {
    adapter: "collection_backstage"
  }).value.state, "eligible");

  const remaining = listOriginalAutoQualificationProspects({ database, runId, limit: 30 });
  assert.deepEqual(remaining.map((candidate) => candidate.candidateId), [candidateIds[30]]);
  database.reserveQualificationBatch({
    batchId: "qualification-batch-after-resume",
    runId,
    candidateIds: [candidateIds[30]],
    attemptedAt: new Date(nowMs).toISOString(),
    minimumSpacingSeconds: 60,
    details: { automatic: true }
  });
  assert.equal(listOriginalAutoQualificationProspects({ database, runId }).length, 0);
  assert.equal(database.getQualificationUsage().dailyUsed, 2);
  assert.deepEqual(
    database.database.prepare(
      "SELECT batch_id FROM qualification_batches ORDER BY attempted_at, batch_id"
    ).all().map((row) => row.batch_id),
    ["qualification-batch-before-pause", "qualification-batch-after-resume"]
  );
});

function rankSnapshot({ gapInterval, userId, roomId, handle, score }) {
  return {
    sourceUrl: `https://webcast.us.tiktok.com/webcast/ranklist/list/v2/?rank_type=16&region_type=1&gap_interval=${gapInterval}`,
    payload: {
      data: {
        rank_view: {
          countdown: 1,
          ranks: [{
            score,
            room_id_str: roomId,
            rank_user: {
              id_str: userId,
              sec_uid: `MS4wLjABAAAA_${userId}`,
              display_id: handle,
              nickname: handle,
              country_code: "SA",
              follower_count: 88_888
            }
          }]
        }
      }
    },
    sourceEvidence: {
      marketRegion: "MENA",
      countryCode: "SA",
      rankingScopeCountryEvidence: "verified_collection_proxy_exit_and_original_top_url",
      observedAt: "2026-08-23T02:00:02.000Z"
    }
  };
}

test("ranking pause releases its SQLite claim and restart resumes the same seed exactly once", async (t) => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "tkdesk-ranking-pause-resume-"));
  const databasePath = path.join(dataDirectory, "tkdesk.sqlite");
  t.after(() => rm(dataDirectory, { recursive: true, force: true }));
  let nowMs = Date.parse("2026-08-23T02:00:00.000Z");
  const options = { clock: () => new Date(nowMs) };
  let database = new DatabaseStore(databasePath, options).init();
  t.after(() => database.close());
  const runId = "run-ranking-pause-resume";
  database.createRun({
    runId,
    source: "tiktok_live",
    mode: "full_auto",
    status: "partial",
    filters: {
      discoveryMethod: "regional_gift_ranking",
      marketRegion: "MENA",
      countryCodes: ["SA"],
      maxCandidates: 30
    }
  });
  const qualified = {
    candidateId: "qualified-ranking-seed",
    userId: "7412345678901234201",
    roomId: "7498765432109876201",
    handle: "qualified.ranking.seed",
    workId: 1,
    rankingScopeCountryCode: "SA",
    originalRankingCountdownSeconds: 1,
    qualificationStatus: "available"
  };
  enqueueQualifiedOriginalRankingSeeds({
    database,
    runId,
    candidates: [qualified],
    at: new Date(nowMs).toISOString()
  });
  nowMs += 2_000;
  let rankingCalls = 0;
  const paused = await resumeOriginalDueRankingSeeds({
    database,
    runId,
    qualifiedCandidates: [qualified],
    verifiedRoute: verifiedRoute(),
    marketRegion: "MENA",
    selectedCountryCodes: ["SA"],
    laneForCandidate,
    rankingTransport: {
      async fetchPair() {
        rankingCalls += 1;
        throw new Error("ranking transport must not start after pause");
      }
    },
    enrichOnce: async () => {
      throw new Error("ranking DataProcessor must not start after pause");
    },
    shouldStop: () => true
  });
  assert.equal(paused.complete, false);
  assert.equal(paused.stoppedReason, "paused_or_cancelled");
  assert.equal(rankingCalls, 0);
  assert.equal(database.originalDiscoveryQueueStatus(runId, { seedKind: "ranking" }).counts.pending, 1);
  const pausedCheckpoint = database.getCheckpoint(runId, "ranking_expansion", {
    adapter: "tiktok_original_cascade"
  });
  assert.equal(pausedCheckpoint.value.lastStoppedReason, "paused_or_cancelled");

  database.close();
  database = new DatabaseStore(databasePath, options).init();
  const outputCandidates = [];
  const resumed = await resumeOriginalDueRankingSeeds({
    database,
    runId,
    qualifiedCandidates: [qualified],
    verifiedRoute: verifiedRoute(),
    marketRegion: "MENA",
    selectedCountryCodes: ["SA"],
    maxCandidates: 30,
    laneForCandidate,
    rankingTransport: {
      async fetchPair({ seed }) {
        rankingCalls += 1;
        return {
          status: "ready",
          source: "tiktok_live_regional_gift_ranking",
          triggerKind: "original_room_seed_direct_request",
          endpointProfileId: "MENA:SA:TopCode1",
          endpointFingerprint: "sha256:fixed-test-ranking-profile",
          rankTypeCode: 16,
          regionTypeCode: 1,
          workId: seed.workId,
          collectionLaneEvidence: laneEvidence(seed.workId),
          gapIntervals: [0, -1],
          snapshots: [
            rankSnapshot({
              gapInterval: 0,
              userId: "7412345678901234299",
              roomId: "7498765432109876299",
              handle: "ranking.resume.output",
              score: 900
            }),
            rankSnapshot({
              gapInterval: -1,
              userId: "7412345678901234299",
              roomId: "7498765432109876299",
              handle: "ranking.resume.output",
              score: 800
            })
          ]
        };
      }
    },
    enrichOnce: async ({ seed }) => readyDataProcessor(seed),
    onBatch: async (candidates) => {
      outputCandidates.push(...candidates);
      for (const candidate of candidates) persistCandidate(database, runId, candidate);
    }
  });

  assert.equal(resumed.complete, true);
  assert.equal(resumed.expandedSeeds, 1);
  assert.equal(rankingCalls, 1);
  assert.equal(outputCandidates.length, 1);
  assert.equal(outputCandidates[0].handle, "ranking.resume.output");
  const finalQueue = database.originalDiscoveryQueueStatus(runId, { seedKind: "ranking" });
  assert.equal(finalQueue.total, 1);
  assert.equal(finalQueue.counts.completed, 1);
  const finalCheckpoint = database.getCheckpoint(runId, "ranking_expansion", {
    adapter: "tiktok_original_cascade"
  });
  assert.equal(finalCheckpoint.value.lastExpandedCandidateId, qualified.candidateId);
  assert.equal(finalCheckpoint.value.queue.counts.completed, 1);
  assert.equal(database.queryProspects({ runId, limit: 10 }).some(
    (candidate) => candidate.handle === "ranking.resume.output"
      && candidate.data.workId === 4
  ), true);
});
