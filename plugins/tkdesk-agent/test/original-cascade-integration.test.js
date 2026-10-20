import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseStore } from "../mcp/core/database.js";
import {
  enqueueQualifiedOriginalRankingSeeds,
  expandOriginalQualifiedRankingSeed,
  fetchOriginalCountryFeedLaneRound,
  resumeOriginalDueRankingSeeds,
  runOriginalDataProcessorWorkerPool
} from "../mcp/core/original-cascade-runtime.js";
import { createOriginalRankingQueueSweeper } from "../mcp/core/original-ranking-queue-sweeper.js";
import { createTikTokLiveFeedTransport } from "../mcp/core/tiktok-live-feed-transport.js";

const LANES = Object.freeze([
  Object.freeze({
    workId: 1,
    countryCode: "SA",
    proxyServer: "http://127.0.0.1:18081",
    proxyExitCountry: "SA",
    observedExitCountry: "SA",
    verified: true
  }),
  Object.freeze({
    workId: 2,
    countryCode: "QA",
    proxyServer: "http://127.0.0.1:18082",
    proxyExitCountry: "QA",
    observedExitCountry: "QA",
    verified: true
  }),
  Object.freeze({
    workId: 3,
    countryCode: "EG",
    proxyServer: "http://127.0.0.1:18083",
    proxyExitCountry: "EG",
    observedExitCountry: "EG",
    verified: true
  })
]);

function verifiedRoute() {
  return {
    marketRegion: "MENA",
    collectionLanes: LANES.map((lane) => ({ ...lane })),
    collectionProxyExitCountries: LANES.map((lane) => lane.countryCode)
  };
}

function feedPayload(countryCode, index) {
  return {
    status_code: 0,
    data: [{
      type: 1,
      data: {
        id_str: `74987654321098765${index}`,
        user_count: 100 + index,
        owner: {
          id_str: `74123456789012345${index}`,
          display_id: `${countryCode.toLowerCase()}.lane.creator`,
          nickname: `${countryCode} Lane Creator`,
          sec_uid: `MS4wLjABAAAA_${countryCode}_lane_creator`,
          region: countryCode,
          follow_info: { follower_count: 10_000 + index }
        }
      }
    }]
  };
}

function rankSnapshot({ gapInterval, userId, roomId, handle, score }) {
  return {
    sourceUrl: `https://webcast.us.tiktok.com/webcast/ranklist/list/v2/?rank_type=16&region_type=1&gap_interval=${gapInterval}`,
    payload: {
      data: {
        rank_view: {
          countdown: 2,
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
      observedAt: "2026-08-23T00:00:00.000Z"
    }
  };
}

function rankingPairFor(seed, { userId, roomId, handle }) {
  const lane = LANES.find((item) => item.countryCode === "SA");
  return {
    status: "ready",
    source: "tiktok_live_regional_gift_ranking",
    triggerKind: "original_room_seed_direct_request",
    endpointProfileId: "MENA:SA:TopCode1",
    endpointFingerprint: "sha256:fixed-test-ranking-profile",
    rankTypeCode: 16,
    regionTypeCode: 1,
    workId: seed.workId,
    collectionLaneEvidence: {
      topology: seed.workId === 4
        ? "mobile_settings_country_lane_compatibility"
        : "original_country_lane",
      workId: seed.workId,
      laneIndex: lane.workId - 1,
      countryCode: lane.countryCode,
      exitCountry: lane.proxyExitCountry,
      affinity: seed.workId === 4 ? "target_country_fallback" : "sticky_work_id"
    },
    gapIntervals: [0, -1],
    snapshots: [
      rankSnapshot({ gapInterval: 0, userId, roomId, handle, score: 900 }),
      rankSnapshot({ gapInterval: -1, userId, roomId, handle, score: 800 })
    ]
  };
}

test("daemon feed round starts SA, QA, and EG workers concurrently with isolated WorkID lanes", async () => {
  const proxyCountry = new Map(LANES.map((lane) => [lane.proxyServer, lane.countryCode]));
  const requests = [];
  let active = 0;
  let maximumActive = 0;
  let started = 0;
  let releaseBarrier;
  const allThreeStarted = new Promise((resolve) => { releaseBarrier = resolve; });
  const transport = createTikTokLiveFeedTransport({
    randomInt: () => 0,
    requestExecutor: async (request) => {
      const countryCode = proxyCountry.get(request.proxyServer);
      assert.ok(countryCode, `unexpected proxy ${request.proxyServer}`);
      requests.push({
        countryCode,
        proxyServer: request.proxyServer,
        sessionBinding: request.sessionBinding,
        requiresAuthenticatedSession: request.requiresAuthenticatedSession
      });
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      started += 1;
      if (started === LANES.length) releaseBarrier();
      await allThreeStarted;
      await Promise.resolve();
      active -= 1;
      return {
        status: 200,
        url: request.url,
        body: JSON.stringify(feedPayload(countryCode, LANES.findIndex(
          (lane) => lane.countryCode === countryCode
        ) + 1))
      };
    }
  });

  const results = await fetchOriginalCountryFeedLaneRound({
    selectedLanes: LANES,
    verifiedRoute: verifiedRoute(),
    marketRegion: "MENA",
    limit: 30,
    fetchOnce: (request) => transport.fetchOnce(request)
  });

  assert.equal(maximumActive, 3, "all three country workers must overlap");
  assert.deepEqual(
    requests.map((request) => request.proxyServer).sort(),
    LANES.map((lane) => lane.proxyServer).sort()
  );
  assert.ok(requests.every((request) => (
    request.sessionBinding === "discovery_cookie_country_http_lease"
      && request.requiresAuthenticatedSession === true
  )));
  assert.deepEqual(results.map(({ workId, result }) => ({
    workId,
    status: result.status,
    resultWorkId: result.workId,
    scopeCountry: result.rankingScopeCountryCode,
    exitCountry: result.collectionLaneEvidence.exitCountry,
    creatorCountry: result.candidates[0].creatorCountryCode
  })), [
    { workId: 1, status: "ready", resultWorkId: 1, scopeCountry: "SA", exitCountry: "SA", creatorCountry: "SA" },
    { workId: 2, status: "ready", resultWorkId: 2, scopeCountry: "QA", exitCountry: "QA", creatorCountry: "QA" },
    { workId: 3, status: "ready", resultWorkId: 3, scopeCountry: "EG", exitCountry: "EG", creatorCountry: "EG" }
  ]);
});

test("DataProcessor pool hard-caps caller concurrency at four while preserving order and lane affinity", async () => {
  const routePolicy = verifiedRoute();
  const expectedCountries = ["SA", "QA", "EG", "SA", "QA", "EG", "SA", "QA", "EG", "SA"];
  const seeds = expectedCountries.map((countryCode, index) => ({
    index,
    userId: `7412345678901235${String(index).padStart(3, "0")}`,
    roomId: `7498765432109876${String(index).padStart(3, "0")}`,
    workId: index < 3 ? index + 1 : 4,
    rankingScopeCountryCode: countryCode
  }));
  let active = 0;
  let maximumActive = 0;
  let started = 0;
  let releaseFirstWave;
  let barrierTimer;
  const firstFourStarted = new Promise((resolve) => {
    releaseFirstWave = resolve;
    barrierTimer = setTimeout(resolve, 100);
  });
  const calls = [];

  const results = await runOriginalDataProcessorWorkerPool({
    seeds,
    verifiedRoute: routePolicy,
    maxWorkers: 99,
    laneForCandidate: (route, seed) => {
      if (seed.workId <= 3) {
        const lane = route.collectionLanes[seed.workId - 1] ?? null;
        return lane?.countryCode === seed.rankingScopeCountryCode ? lane : null;
      }
      return route.collectionLanes.find(
        (lane) => lane.countryCode === seed.rankingScopeCountryCode
      ) ?? null;
    },
    enrichOnce: async ({ seed, countryCode }) => {
      calls.push({ index: seed.index, countryCode });
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      started += 1;
      if (started === 4) {
        clearTimeout(barrierTimer);
        releaseFirstWave();
      }
      await firstFourStarted;
      await new Promise((resolve) => setTimeout(resolve, (3 - (seed.index % 3)) * 2));
      active -= 1;
      return {
        status: "ready",
        workId: seed.workId,
        enrichment: { creatorCountryCode: countryCode, sourceIndex: seed.index }
      };
    }
  });

  assert.equal(maximumActive, 4, "maxWorkers=99 must not bypass the original four-worker cap");
  assert.deepEqual(
    results.map((entry) => entry.seed.index),
    seeds.map((seed) => seed.index),
    "out-of-order worker completion must not reorder seed results"
  );
  assert.deepEqual(results.map((entry) => entry.targetCountryCode), expectedCountries);
  assert.deepEqual(
    [...calls].sort((left, right) => left.index - right.index).map((call) => call.countryCode),
    expectedCountries
  );
});

test("automatic startup sweep resumes persisted WorkID4 after country recheck and available qualification", async (t) => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "tkdesk-original-cascade-"));
  const databasePath = path.join(dataDirectory, "cascade.sqlite");
  t.after(() => rm(dataDirectory, { recursive: true, force: true }));
  let now = new Date("2026-08-23T00:00:00.000Z");
  const options = {
    clock: () => now,
    idFactory: (() => {
      let value = 0;
      return () => `cascade-id-${++value}`;
    })()
  };
  const store = new DatabaseStore(databasePath, options).init();
  const runId = "run-original-recursive-cascade";
  store.createRun({
    runId,
    source: "tiktok_live",
    mode: "full_auto",
    status: "partial",
    filters: {
      discoveryMethod: "regional_gift_ranking",
      marketRegion: "MENA",
      countryCodes: ["SA"]
    }
  });

  const rankingCalls = [];
  const fakeRankingTransport = {
    async fetchPair({ seed, countryCode }) {
      rankingCalls.push({
        workId: seed.workId,
        countryCode,
        rankingScopeCountryCode: seed.rankingScopeCountryCode
      });
      return rankingPairFor(seed, seed.workId === 1
        ? {
            userId: "7412345678901234999",
            roomId: "7498765432109876999",
            handle: "derived.sa.creator"
          }
        : {
            userId: "7412345678901234888",
            roomId: "7498765432109876888",
            handle: "second.generation.creator"
          });
    }
  };
  const initialSeed = {
    candidateId: "initial-qualified-seed",
    userId: "7412345678901234001",
    roomId: "7498765432109876001",
    workId: 1,
    rankingScopeCountryCode: "SA"
  };
  let countryRechecks = 0;
  const firstExpansion = await expandOriginalQualifiedRankingSeed({
    seed: initialSeed,
    lane: LANES[0],
    verifiedRoute: verifiedRoute(),
    marketRegion: "MENA",
    rankingTransport: fakeRankingTransport,
    laneForCandidate: (route, seed) => {
      assert.equal(seed.workId, 4);
      return route.collectionLanes.find(
        (lane) => lane.countryCode === seed.rankingScopeCountryCode
      ) ?? null;
    },
    enrichOnce: async ({ seed, countryCode }) => {
      countryRechecks += 1;
      assert.equal(seed.creatorCountryCode, null, "rank scope must not masquerade as creator country");
      assert.equal(countryCode, "SA");
      return {
        status: "ready",
        workId: 4,
        collectionLaneEvidence: seed.collectionLaneEvidence,
        completedStages: ["basic", "country", "ranking", "top_score", "anchor_level"],
        adapterEvidenceVersion: "original-data-processor-enrichment-v3",
        enrichment: {
          userId: seed.userId,
          roomId: seed.roomId,
          creatorCountryCode: "SA",
          followerCount: seed.followerCount,
          countdown: 2
        }
      };
    }
  });
  assert.equal(firstExpansion.status, "ready");
  assert.equal(firstExpansion.pairMetadata.rankingPairComplete, true);
  const [workId4] = firstExpansion.candidates;
  assert.equal(workId4.workId, 4);
  assert.equal(workId4.creatorCountryCode, "SA");
  assert.equal(workId4.rankingScopeCountryCode, "SA");
  assert.equal(workId4.collectionLaneEvidence.sourceWorkId, 1);
  assert.equal(countryRechecks, 1);

  const persisted = store.upsertProspect({
    runId,
    source: "tiktok_live",
    userId: workId4.userId,
    secUid: workId4.secUid,
    handle: workId4.handle,
    roomId: workId4.roomId,
    marketRegion: "MENA",
    creatorCountryCode: workId4.creatorCountryCode,
    followers: workId4.followerCount,
    live: true,
    observedAt: now.toISOString(),
    data: {
      workId: 4,
      collectionLaneEvidence: workId4.collectionLaneEvidence,
      rankingScopeCountryCode: "SA",
      rankingScopeCountryEvidence: workId4.rankingScopeCountryEvidence,
      originalRankingCountdownSeconds: workId4.originalRankingCountdownSeconds,
      dataProcessorStatus: workId4.dataProcessorStatus,
      dataProcessorComplete: workId4.dataProcessorComplete,
      dataProcessorEvidenceVersion: workId4.dataProcessorEvidenceVersion,
      dataProcessorStages: workId4.dataProcessorStages
    }
  });
  store.recordQualificationBatch({
    batchId: "qualified-work-id-4",
    runId,
    records: [{
      candidateId: persisted.prospect.candidateId,
      qualificationStatus: "available",
      marketRegion: "MENA",
      creatorCountryCode: "SA",
      observedAt: now.toISOString()
    }]
  });
  const readQualified = store.getProspect(persisted.prospect.candidateId);
  assert.equal(readQualified.latestQualificationObservation.invitationEligibility, "available");
  const recursiveCandidate = {
    ...readQualified,
    qualificationStatus: readQualified.latestQualificationObservation.invitationEligibility,
    workId: readQualified.data.workId,
    routeCountry: readQualified.data.routeCountry,
    rankingScopeCountryCode: readQualified.data.rankingScopeCountryCode,
    originalRankingCountdownSeconds: readQualified.data.originalRankingCountdownSeconds
  };
  const queued = enqueueQualifiedOriginalRankingSeeds({
    database: store,
    runId,
    candidates: [
      recursiveCandidate,
      {
        ...recursiveCandidate,
        candidateId: "explicitly-ineligible-candidate",
        userId: "7412345678901234777",
        qualificationStatus: "ineligible",
        invitationEligibility: "ineligible",
        latestQualificationObservation: { invitationEligibility: "ineligible" }
      },
      {
        ...recursiveCandidate,
        candidateId: "unresolved-qualification-candidate",
        userId: "7412345678901234666",
        qualificationStatus: "unresolved",
        invitationEligibility: "unresolved",
        latestQualificationObservation: { invitationEligibility: "unresolved" }
      }
    ]
  });
  assert.equal(queued.accepted, 1);
  assert.deepEqual(
    store.listDiscoverySeeds({ runId, seedKind: "ranking" }).map((seed) => seed.payload),
    [{ candidateId: persisted.prospect.candidateId }],
    "only backstage qualificationStatus=available may enter the recursive ranking queue"
  );
  const beforeRestart = store.originalDiscoveryQueueStatus(runId, { seedKind: "ranking" });
  assert.equal(beforeRestart.counts.pending, 1);
  assert.equal(beforeRestart.dueCount, 1);
  assert.equal(beforeRestart.nextDueAt, "2026-08-23T00:00:00.000Z");
  store.close();

  // This is the daemon restart boundary: no in-memory candidate map, claim,
  // timer, or transport survives. Only SQLite state is reused by the new
  // automatic startup sweeper. Countdown suppresses duplicates, not the first scan.
  now = new Date("2026-08-23T00:00:03.000Z");
  const restarted = new DatabaseStore(databasePath, options).init();
  const afterRestartProspect = restarted.getProspect(persisted.prospect.candidateId);
  const resumedCandidate = {
    ...afterRestartProspect,
    qualificationStatus: afterRestartProspect.latestQualificationObservation.invitationEligibility,
    workId: afterRestartProspect.data.workId,
    rankingScopeCountryCode: afterRestartProspect.data.rankingScopeCountryCode,
    originalRankingCountdownSeconds: afterRestartProspect.data.originalRankingCountdownSeconds
  };
  let automaticCountryRechecks = 0;
  const sweeper = createOriginalRankingQueueSweeper({
    database: restarted,
    intervalMs: 60_000,
    clock: () => now,
    preflightRun: async (dueRun) => ({ ready: dueRun.runId === runId }),
    resumeRun: async (dueRun) => {
      const result = await resumeOriginalDueRankingSeeds({
        database: restarted,
        runId: dueRun.runId,
        qualifiedCandidates: [resumedCandidate],
        verifiedRoute: verifiedRoute(),
        marketRegion: "MENA",
        selectedCountryCodes: ["SA"],
        maxCandidates: 30,
        laneForCandidate: (route, seed) => route.collectionLanes.find(
          (lane) => lane.countryCode === seed.rankingScopeCountryCode
        ) ?? null,
        rankingTransport: fakeRankingTransport,
        enrichOnce: async ({ seed, countryCode }) => {
          automaticCountryRechecks += 1;
          assert.equal(seed.workId, 4);
          assert.equal(seed.creatorCountryCode, null);
          assert.equal(countryCode, "SA");
          return {
            status: "ready",
            workId: 4,
            collectionLaneEvidence: seed.collectionLaneEvidence,
            completedStages: ["basic", "country", "ranking", "top_score", "anchor_level"],
            adapterEvidenceVersion: "original-data-processor-enrichment-v3",
            enrichment: {
              userId: seed.userId,
              roomId: seed.roomId,
              creatorCountryCode: "SA",
              followerCount: seed.followerCount,
              countdown: 2
            }
          };
        },
        onBatch: async (candidates) => {
          for (const candidate of candidates) {
            restarted.upsertProspect({
              runId,
              source: "tiktok_live",
              userId: candidate.userId,
              secUid: candidate.secUid,
              handle: candidate.handle,
              roomId: candidate.roomId,
              marketRegion: "MENA",
              creatorCountryCode: candidate.creatorCountryCode,
              followers: candidate.followerCount,
              live: true,
              observedAt: now.toISOString(),
              data: {
                workId: candidate.workId,
                rankingScopeCountryCode: candidate.rankingScopeCountryCode,
                dataProcessorComplete: candidate.dataProcessorComplete,
                dataProcessorStages: candidate.dataProcessorStages
              }
            });
          }
        }
      });
      restarted.updateRun(runId, {
        status: result.complete ? "completed" : "partial",
        result: { automaticRankingResume: result }
      });
      return { completed: true };
    }
  });
  sweeper.start();
  const startupScan = await sweeper.waitForIdle();
  sweeper.stop();
  assert.equal(startupScan.trigger, "startup");
  assert.equal(startupScan.dueRunCount, 1);
  assert.equal(startupScan.resumedRunCount, 1);
  assert.equal(automaticCountryRechecks, 1);
  assert.deepEqual(rankingCalls, [
    { workId: 1, countryCode: "SA", rankingScopeCountryCode: "SA" },
    { workId: 4, countryCode: "SA", rankingScopeCountryCode: "SA" }
  ]);
  assert.equal(
    restarted.originalDiscoveryQueueStatus(runId, { seedKind: "ranking" }).counts.completed,
    1
  );
  const checkpoint = restarted.getCheckpoint(runId, "ranking_expansion", {
    adapter: "tiktok_original_cascade"
  });
  assert.equal(checkpoint.value.lastExpandedCandidateId, persisted.prospect.candidateId);
  assert.equal(checkpoint.value.queue.counts.completed, 1);
  assert.equal(restarted.getRun(runId).result.automaticRankingResume.rankingPairComplete, true);
  assert.equal(
    restarted.queryProspects({ runId, limit: 20 }).some(
      (candidate) => candidate.userId === "7412345678901234888"
        && candidate.data.workId === 4
        && candidate.data.dataProcessorComplete === true
    ),
    true
  );
  restarted.close();
});

test("qualified recursive ranking preserves the selected display variant at the fixed transport seam", async () => {
  const { fetchOriginalQualifiedRankingPair } = await import("../mcp/core/original-cascade-runtime.js");
  let observed;
  await fetchOriginalQualifiedRankingPair({
    seed: { userId: "1", roomId: "2", workId: 4, rankingDisplayName: "seed-provenance" },
    lane: { countryCode: "PR", displayName: "selected-overlap-variant" },
    verifiedRoute: {}, marketRegion: "CCA",
    rankingTransport: { async fetchPair(request) { observed = request; return { status: "capability_not_ready", reason: "ranking_mobile_authorization_required" }; } }
  });
  assert.equal(observed.displayName, "selected-overlap-variant");
  assert.equal(observed.seed.rankingDisplayName, "seed-provenance");
});

for (const maxCandidates of [Infinity, 5_000, 1]) {
  test(`recursive ranking processes a qualified seed with run capacity ${maxCandidates}`, async (t) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "tkdesk-ranking-capacity-"));
    const database = new DatabaseStore(path.join(directory, "state.sqlite3")).init();
    t.after(() => { database.close(); return rm(directory, { recursive: true, force: true }); });
    const runId = database.createRun({ source: "tiktok_live", mode: "full_auto" }).runId;
    const seed = {
      candidateId: "qualified-seed", userId: "7412345678901234001",
      roomId: "7498765432109876001", workId: 1,
      rankingScopeCountryCode: "SA", qualificationStatus: "available"
    };
    const admitted = [];
    const result = await resumeOriginalDueRankingSeeds({
      database, runId, qualifiedCandidates: [seed],
      verifiedRoute: verifiedRoute(), marketRegion: "MENA", selectedCountryCodes: ["SA"],
      maxCandidates,
      laneForCandidate: (route, candidate) => route.collectionLanes.find(
        (lane) => lane.countryCode === candidate.rankingScopeCountryCode
      ),
      rankingTransport: { async fetchPair({ seed }) {
        return rankingPairFor(seed, {
          userId: "7412345678901234999", roomId: "7498765432109876999",
          handle: "derived.sa.creator"
        });
      } },
      enrichOnce: async ({ seed }) => ({
        status: "ready", workId: 4, collectionLaneEvidence: seed.collectionLaneEvidence,
        completedStages: ["basic", "country", "ranking", "top_score", "anchor_level"],
        enrichment: { userId: seed.userId, roomId: seed.roomId,
          creatorCountryCode: "SA", followerCount: seed.followerCount }
      }),
      onBatch: async (batch) => admitted.push(...batch)
    });
    assert.equal(result.expandedSeeds, 1);
    assert.equal(result.found, 1);
    assert.equal(admitted.length, 1);
    assert.equal(admitted[0].workId, 4);
    assert.equal(admitted[0].creatorCountryCode, "SA");
    assert.equal(database.originalDiscoveryQueueStatus(runId, { seedKind: "ranking" }).counts.completed, 1);
  });
}
