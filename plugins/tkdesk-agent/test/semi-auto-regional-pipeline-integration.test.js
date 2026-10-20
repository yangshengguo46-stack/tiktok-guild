import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseStore } from "../mcp/core/database.js";
import {
  attachDiscoveryWorkflowEvidence,
  discoveryWorkflowPolicy
} from "../mcp/core/discovery-workflow-policy.js";
import {
  runOriginalRegionalFeedDataProcessorRound
} from "../mcp/core/original-cascade-runtime.js";

const DATA_PROCESSOR_STAGES = Object.freeze([
  "basic",
  "country",
  "ranking",
  "room_enter",
  "anchor_level"
]);

const LANES = Object.freeze([
  Object.freeze({
    workId: 1,
    countryCode: "SA",
    proxyServer: "http://127.0.0.1:18881",
    proxyExitCountry: "SA"
  }),
  Object.freeze({
    workId: 2,
    countryCode: "QA",
    proxyServer: "http://127.0.0.1:18882",
    proxyExitCountry: "QA"
  }),
  Object.freeze({
    workId: 3,
    countryCode: "EG",
    proxyServer: "http://127.0.0.1:18883",
    proxyExitCountry: "EG"
  })
]);

function verifiedRoute() {
  return {
    routeProfileId: "semi-auto-regional-integration-route",
    verificationStatus: "verified",
    verifiedAt: "2026-08-23T00:00:00.000Z",
    marketRegion: "MENA",
    discoveryCountry: "US",
    discoveryProxyServer: "http://127.0.0.1:18880",
    discoveryProxyExitCountry: "US",
    collectionLanes: LANES.map(({ countryCode, proxyServer }) => ({
      countryCode,
      proxyServer
    })),
    collectionProxyExitCountries: LANES.map((lane) => lane.countryCode)
  };
}

function feedResult({ workId, countryCode }) {
  const lane = LANES[workId - 1];
  const suffix = String(workId);
  const collectionLaneEvidence = {
    workId,
    countryCode,
    exitCountry: countryCode,
    affinity: "original_proxy_settings_work_id"
  };
  return {
    status: "ready",
    workId,
    rankingScopeCountryCode: countryCode,
    collectionLaneEvidence,
    receivedRooms: 1,
    channelId: 21,
    triggerKind: "original_pc_web_feed",
    adapterEvidenceVersion: "original-pc-web-feed-v1",
    candidates: [{
      userId: `741234567890123450${suffix}`,
      secUid: `MS4wLjABAAAA_semi_${countryCode}`,
      handle: `${countryCode.toLowerCase()}.semi.creator`,
      displayName: `${countryCode} Semi Creator`,
      roomId: `749876543210987650${suffix}`,
      followerCount: 50_000 + workId,
      viewerCount: 100 + workId,
      creatorCountryCode: countryCode,
      countryCode,
      workId,
      seller: false,
      live: true,
      observedAt: "2026-08-23T00:00:00.000Z",
      rankingScopeMarketRegion: "MENA",
      rankingScopeCountryCode: countryCode,
      rankingScopeCountryEvidence: "verified_work_id_country_lane",
      collectionLaneEvidence
    }]
  };
}

function mobileTemplateResult({ workId, countryCode, displayName }) {
  const lane = LANES[workId - 1];
  const suffix = String(workId);
  const collectionLaneEvidence = {
    workId,
    countryCode,
    exitCountry: countryCode,
    affinity: "original_proxy_settings_work_id"
  };
  return {
    status: "ready",
    evidenceVersion: "tkdesk.original-country-template-bundle.v1",
    fixedTemplateFingerprint: `fixture-${countryCode}`,
    marketRegion: "MENA",
    countryCode,
    displayName,
    workId,
    collectionLaneEvidence,
    templateLabels: ["TopURL", "HotListURL", "RankRecordURL"],
    templateRowCounts: {
      TopURL: 1,
      HistoryRankURL: null,
      HotListURL: 1,
      RankRecordURL: 1
    },
    templateMergeKeyKind: "normalized_display_id",
    candidates: [{
      userId: `741234567890123450${suffix}`,
      secUid: `MS4wLjABAAAA_semi_${countryCode}`,
      handle: `${countryCode.toLowerCase()}.semi.creator`,
      displayId: `${countryCode.toLowerCase()}.semi.creator`,
      roomId: `749876543210987650${suffix}`,
      followerCount: 50_000 + workId,
      seller: false,
      workId,
      rankingScopeMarketRegion: "MENA",
      rankingScopeCountryCode: countryCode,
      collectionLaneEvidence,
      topCode: 1,
      topScore: String(100 + workId),
      historyRankScore: null,
      hotListScore: String(200 + workId),
      rankRecordScore: String(300 + workId)
    }]
  };
}

function persistSemiAutoBatch(store, runId, policy, batch) {
  for (const rawCandidate of batch) {
    const candidate = attachDiscoveryWorkflowEvidence(rawCandidate, policy);
    const data = {
      workflowMode: candidate.workflowMode,
      qualificationQueryState: candidate.qualificationQueryState,
      automaticQualificationPerformed: candidate.automaticQualificationPerformed,
      workId: candidate.workId,
      collectionLaneEvidence: candidate.collectionLaneEvidence,
      dataProcessorStatus: candidate.dataProcessorStatus,
      dataProcessorComplete: candidate.dataProcessorComplete,
      dataProcessorReason: candidate.dataProcessorReason,
      dataProcessorStages: candidate.dataProcessorStages,
      dataProcessorEvidenceVersion: candidate.dataProcessorEvidenceVersion,
      currentScore: candidate.currentScore,
      topScore: candidate.topScore,
      hotListScore: candidate.hotListScore,
      rankRecordScore: candidate.rankRecordScore,
      rankingScore: candidate.rankingScore,
      discoverySourceKinds: candidate.discoverySourceKinds,
      mobileTemplateEvidence: candidate.mobileTemplateEvidence,
      highQuality: candidate.highQuality
    };
    store.upsertProspect({
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
      live: candidate.live,
      highQuality: candidate.highQuality,
      observedAt: candidate.observedAt,
      data,
      observation: {
        runId,
        source: "tiktok_live",
        observedAt: candidate.observedAt,
        marketRegion: "MENA",
        creatorCountryCode: candidate.creatorCountryCode,
        followerCount: candidate.followerCount,
        live: candidate.live,
        highQuality: candidate.highQuality,
        roomId: candidate.roomId,
        data,
        evidence: candidate.rawEvidence
      }
    });
  }
}

test("semi-auto production seam unions SA/QA/EG PC Feed and MobileProcessor templates before DataProcessor and SQLite", async (t) => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "tkdesk-semi-regional-pipeline-"));
  t.after(() => rm(dataDirectory, { recursive: true, force: true }));
  const store = new DatabaseStore(path.join(dataDirectory, "tkdesk.sqlite")).init();
  t.after(() => store.close());
  const run = store.createRun({
    runId: "semi-regional-production-seam",
    source: "tiktok_live",
    mode: "semi_auto",
    status: "running",
    filters: {
      discoveryMethod: "regional_gift_ranking",
      marketRegion: "MENA",
      countryCodes: ["SA", "QA", "EG"],
      highQualityMode: true,
      maxCandidates: 3
    }
  });
  const policy = discoveryWorkflowPolicy(run);
  assert.deepEqual(policy.requiredRouteSessionTargets, ["tiktok_discovery"]);
  assert.equal(policy.automaticQualification, false);
  assert.equal(policy.recursiveRankingExpansion, false);

  const usageBefore = store.getQualificationUsage();
  let feedCalls = 0;
  let templateCalls = 0;
  let dataProcessorCalls = 0;
  const round = await runOriginalRegionalFeedDataProcessorRound({
    database: store,
    runId: run.runId,
    selectedLanes: LANES.map((lane) => ({ ...lane })),
    verifiedRoute: verifiedRoute(),
    marketRegion: "MENA",
    filters: run.filters,
    maxCandidates: 3,
    feedLimit: 30,
    fetchFeedOnce: async ({ workId, countryCode }) => {
      feedCalls += 1;
      return feedResult({ workId, countryCode });
    },
    fetchCountryTemplatesOnce: async ({ workId, countryCode, displayName }) => {
      templateCalls += 1;
      assert.equal(displayName, "MENA(中东)");
      return mobileTemplateResult({ workId, countryCode, displayName });
    },
    laneForCandidate: (route, candidate) => {
      const lane = LANES[candidate.workId - 1];
      return route.collectionLanes[candidate.workId - 1]?.countryCode === lane?.countryCode
        ? lane
        : null;
    },
    enrichOnce: async ({ seed, countryCode }) => {
      dataProcessorCalls += 1;
      assert.equal(seed.collectionLaneEvidence.countryCode, countryCode);
      return {
        status: "ready",
        workId: seed.workId,
        collectionLaneEvidence: seed.collectionLaneEvidence,
        completedStages: [...DATA_PROCESSOR_STAGES],
        stageEvidence: DATA_PROCESSOR_STAGES.map((stage) => ({ stage, state: "ready" })),
        adapterEvidenceVersion: "original-data-processor-enrichment-v3",
        enrichment: {
          userId: seed.userId,
          secUid: seed.secUid,
          roomId: seed.roomId,
          followerCount: seed.followerCount,
          userCount: seed.viewerCount,
          creatorCountryCode: countryCode,
          region: countryCode,
          currentScore: 25,
          topScore: seed.topScore,
          historyRankScore: seed.historyRankScore,
          hotListScore: seed.hotListScore,
          rankRecordScore: seed.rankRecordScore,
          rankingScore: 30,
          topCode: 1,
          ranking: "MENA weekly",
          creatorLevel: "12"
        }
      };
    },
    onBatch: async (batch) => persistSemiAutoBatch(store, run.runId, policy, batch)
  });

  assert.equal(round.status, "ready");
  assert.equal(round.candidates.length, 3);
  assert.equal(feedCalls, 3);
  assert.equal(templateCalls, 3);
  assert.equal(dataProcessorCalls, 3);
  assert.equal(round.mobileTemplateComplete, true);
  assert.equal(round.mobileTemplateAttempts, 3);
  assert.equal(
    round.triggerKind,
    "original_pc_web_feed_and_mobile_processor_fixed_country_lists"
  );
  assert.equal(round.feedQueue.counts.completed, 3);
  const persisted = store.queryProspects({ runId: run.runId, source: "tiktok_live", limit: 10 });
  assert.equal(persisted.length, 3);
  assert.deepEqual(
    persisted.map((candidate) => candidate.creatorCountryCode).sort(),
    ["EG", "QA", "SA"]
  );
  for (const candidate of persisted) {
    const data = candidate.latestDiscoveryObservation.data;
    assert.equal(data.workflowMode, "semi_auto");
    assert.equal(data.qualificationQueryState, "not_queried");
    assert.equal(data.automaticQualificationPerformed, false);
    assert.equal(data.dataProcessorStatus, "ready");
    assert.equal(data.dataProcessorComplete, true);
    assert.deepEqual(data.dataProcessorStages, DATA_PROCESSOR_STAGES);
    assert.equal(data.dataProcessorEvidenceVersion, "original-data-processor-enrichment-v3");
    const workId = data.workId;
    assert.equal(data.topScore, String(100 + workId));
    assert.equal(data.hotListScore, String(200 + workId));
    assert.equal(data.rankRecordScore, String(300 + workId));
    assert.deepEqual(data.discoverySourceKinds, [
      "original_pc_web_feed",
      "original_mobile_processor_fixed_country_lists"
    ]);
    assert.equal(data.mobileTemplateEvidence.mergeKeyKind, "normalized_display_id");
    assert.deepEqual(data.mobileTemplateEvidence.templateRowCounts, {
      TopURL: 1,
      HistoryRankURL: null,
      HotListURL: 1,
      RankRecordURL: 1
    });
    assert.equal(data.highQuality, true);
    assert.equal(candidate.latestQualificationObservation, null);
  }

  const usageAfter = store.getQualificationUsage();
  assert.equal(usageAfter.hourlyUsed, usageBefore.hourlyUsed);
  assert.equal(usageAfter.dailyUsed, usageBefore.dailyUsed);
  assert.equal(
    store.database.prepare("SELECT COUNT(*) AS count FROM qualification_batches").get().count,
    0,
    "no collection-backstage adapter attempt may be reserved"
  );
  assert.equal(
    store.database.prepare("SELECT COUNT(*) AS count FROM prospect_observations WHERE source = 'collection_backstage'").get().count,
    0
  );
  assert.equal(
    store.originalDiscoveryQueueStatus(run.runId, { seedKind: "ranking" }).total,
    0,
    "semi-auto must not enqueue recursive ranking work"
  );
});

test("regional production seam stops before Feed and fails closed on route drift", async (t) => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "tkdesk-semi-regional-boundaries-"));
  t.after(() => rm(dataDirectory, { recursive: true, force: true }));
  const store = new DatabaseStore(path.join(dataDirectory, "tkdesk.sqlite")).init();
  t.after(() => store.close());
  const pausedRun = store.createRun({
    runId: "semi-regional-paused",
    source: "tiktok_live",
    mode: "semi_auto",
    status: "paused",
    filters: { discoveryMethod: "regional_gift_ranking", marketRegion: "MENA", countryCodes: ["SA"] }
  });
  let transportCalls = 0;
  const paused = await runOriginalRegionalFeedDataProcessorRound({
    database: store,
    runId: pausedRun.runId,
    selectedLanes: [{ ...LANES[0] }],
    verifiedRoute: verifiedRoute(),
    marketRegion: "MENA",
    shouldStop: () => true,
    fetchFeedOnce: async () => {
      transportCalls += 1;
      return feedResult({ workId: 1, countryCode: "SA" });
    },
    laneForCandidate: () => LANES[0],
    enrichOnce: async () => {
      transportCalls += 1;
      throw new Error("DataProcessor must not run after pause");
    }
  });
  assert.equal(paused.status, "stopped");
  assert.equal(transportCalls, 0);
  assert.equal(store.queryProspects({ runId: pausedRun.runId }).length, 0);
  assert.equal(store.originalDiscoveryQueueStatus(pausedRun.runId).total, 0);

  const driftRun = store.createRun({
    runId: "semi-regional-route-drift",
    source: "tiktok_live",
    mode: "semi_auto",
    status: "running",
    filters: { discoveryMethod: "regional_gift_ranking", marketRegion: "MENA", countryCodes: ["SA"] }
  });
  await assert.rejects(
    runOriginalRegionalFeedDataProcessorRound({
      database: store,
      runId: driftRun.runId,
      selectedLanes: [{ ...LANES[0] }],
      verifiedRoute: { ...verifiedRoute(), discoveryProxyExitCountry: "CN" },
      marketRegion: "MENA",
      fetchFeedOnce: async () => {
        transportCalls += 1;
        return feedResult({ workId: 1, countryCode: "SA" });
      },
      laneForCandidate: () => LANES[0],
      enrichOnce: async () => {
        transportCalls += 1;
        throw new Error("DataProcessor must not run after route drift");
      }
    }),
    (error) => error.code === "collection_route_mismatch"
  );
  assert.equal(transportCalls, 0);
  assert.equal(store.queryProspects({ runId: driftRun.runId }).length, 0);
  assert.equal(store.originalDiscoveryQueueStatus(driftRun.runId).total, 0);
});

test("PC Feed readiness cannot hide an unavailable MobileProcessor template source", async (t) => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "tkdesk-mobile-template-partial-"));
  t.after(() => rm(dataDirectory, { recursive: true, force: true }));
  const store = new DatabaseStore(path.join(dataDirectory, "tkdesk.sqlite")).init();
  t.after(() => store.close());
  const run = store.createRun({
    runId: "mobile-template-partial",
    source: "tiktok_live",
    mode: "semi_auto",
    status: "running",
    filters: { discoveryMethod: "regional_gift_ranking", marketRegion: "MENA", countryCodes: ["SA"] }
  });
  const round = await runOriginalRegionalFeedDataProcessorRound({
    database: store,
    runId: run.runId,
    selectedLanes: [{ ...LANES[0] }],
    verifiedRoute: verifiedRoute(),
    marketRegion: "MENA",
    maxCandidates: 1,
    fetchFeedOnce: async () => feedResult({ workId: 1, countryCode: "SA" }),
    fetchCountryTemplatesOnce: async () => ({
      status: "capability_not_ready",
      capability: "regional_gift_ranking",
      reason: "ranking_mobile_authorization_required",
      candidates: []
    }),
    laneForCandidate: () => LANES[0],
    enrichOnce: async ({ seed }) => ({
      status: "ready",
      workId: 1,
      collectionLaneEvidence: seed.collectionLaneEvidence,
      completedStages: ["basic", "country", "ranking", "top_score", "anchor_level"],
      adapterEvidenceVersion: "original-data-processor-enrichment-v3",
      enrichment: {
        ...seed,
        creatorCountryCode: "SA",
        rankingScore: "50",
        topScore: "40",
        topCode: 1,
        creatorLevel: "1"
      }
    })
  });

  assert.equal(round.status, "partial");
  assert.equal(round.mobileTemplateComplete, false);
  assert.equal(round.mobileTemplateAttempts, 1);
  assert.equal(round.partialCounts.ranking_mobile_authorization_required, 1);
  assert.equal(round.candidates.length, 1, "partial PC evidence may persist but cannot certify parity");
  assert.notEqual(round.status, "ready");
});

test("PC Feed business rejection retains safe status and sanitized text in diagnostic reasons", async (t) => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "tkdesk-feed-business-code-"));
  t.after(() => rm(dataDirectory, { recursive: true, force: true }));
  const store = new DatabaseStore(path.join(dataDirectory, "tkdesk.sqlite")).init();
  t.after(() => store.close());
  const run = store.createRun({
    runId: "feed-business-code",
    source: "tiktok_live",
    mode: "semi_auto",
    status: "running",
    filters: { discoveryMethod: "regional_gift_ranking", marketRegion: "MENA", countryCodes: ["SA"] }
  });
  const round = await runOriginalRegionalFeedDataProcessorRound({
    database: store,
    runId: run.runId,
    selectedLanes: [{ ...LANES[0] }],
    verifiedRoute: verifiedRoute(),
    marketRegion: "MENA",
    fetchFeedOnce: async () => ({
      status: "capability_not_ready",
      reason: "feed_business_rejected",
      businessStatusCode: 20003,
      businessMessage: "Login required token=DO_NOT_KEEP",
      requestUrl: "must-not-leak",
      candidates: []
    }),
    laneForCandidate: () => LANES[0],
    enrichOnce: async () => { throw new Error("no candidate should reach enrichment"); }
  });
  assert.equal(round.status, "capability_not_ready");
  assert.deepEqual(round.reasons, [{ workId: 1, reason: "feed_business_rejected", businessStatusCode: 20003, businessMessage: "Login required [REDACTED]" }]);
});

test("PC and Mobile rows with one stable ID but different DisplayID fail closed instead of merging", async (t) => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "tkdesk-display-id-conflict-"));
  t.after(() => rm(dataDirectory, { recursive: true, force: true }));
  const store = new DatabaseStore(path.join(dataDirectory, "tkdesk.sqlite")).init();
  t.after(() => store.close());
  const run = store.createRun({ runId: "display-id-conflict", source: "tiktok_live", mode: "semi_auto" });
  const round = await runOriginalRegionalFeedDataProcessorRound({
    database: store,
    runId: run.runId,
    selectedLanes: [{ ...LANES[0] }],
    verifiedRoute: verifiedRoute(),
    marketRegion: "MENA",
    maxCandidates: 2,
    fetchFeedOnce: async () => feedResult({ workId: 1, countryCode: "SA" }),
    fetchCountryTemplatesOnce: async ({ displayName }) => {
      const result = mobileTemplateResult({ workId: 1, countryCode: "SA", displayName });
      return {
        ...result,
        candidates: result.candidates.map((candidate) => ({
          ...candidate,
          handle: "different.handle",
          displayId: "different.handle"
        }))
      };
    },
    laneForCandidate: () => LANES[0],
    enrichOnce: async ({ seed }) => ({
      status: "ready",
      workId: 1,
      collectionLaneEvidence: seed.collectionLaneEvidence,
      completedStages: ["basic", "country", "anchor_level"],
      adapterEvidenceVersion: "original-data-processor-enrichment-v3",
      enrichment: { ...seed, creatorCountryCode: "SA", creatorLevel: "1" }
    })
  });

  assert.equal(round.mobileTemplateComplete, true);
  assert.equal(round.discoveryIdentityConflicts, 1);
  assert.equal(round.partialCounts.discovery_identity_conflict, 1);
  assert.equal(round.candidates.length, 1);
  assert.equal(round.candidates[0].handle, "sa.semi.creator");
  assert.deepEqual(round.candidates[0].discoverySourceKinds, ["original_pc_web_feed"]);
});
