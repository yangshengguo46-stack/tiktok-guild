import assert from "node:assert/strict";
import test from "node:test";
import {
  TIKTOK_DATA_ENRICHMENT_PROFILE,
  createTikTokDataEnrichmentTransport,
  projectAnchorLevelPayload,
  projectBasicUserRoomPayload,
  projectCountryGiftListPayload,
  projectRoomEnterPayload
} from "../mcp/core/tiktok-data-enrichment-transport.js";
import { createTikTokRankingTransport } from "../mcp/core/tiktok-ranking-transport.js";
import { originalDataProcessorCandidate } from "../mcp/core/original-cascade-runtime.js";

test("failed Data stages retain safe HTTP diagnostics instead of raw response text", async () => {
  const transport = createTikTokDataEnrichmentTransport({ requestExecutor: async request => ({
    status: 200, url: request.url, body: "", contentType: "text/html", elapsedMs: 71
  }) });
  const result = await transport.enrichOnce({ seed: { handle: "seed.creator", roomId: "7000000000000000001" },
    verifiedRoute: route(), countryCode: "SA" });
  assert.equal(result.reason, "basic_response_not_json");
  assert.ok(result.stageEvidence.at(-1), "failed-stage evidence is missing");
  assert.equal(result.stageEvidence.at(-1).stage, "basic");
  assert.equal(result.stageEvidence.at(-1).diagnostics.bodyKind, "empty");
  assert.equal(result.stageEvidence.at(-1).diagnostics.elapsedMs, 71);
});

test("Basic projection maps the original user, stats, and conditional live-time fields", () => {
  const payload = {
    data: {
      user: {
        roomId: "7498765432109876543",
        id: "7412345678901234567",
        secUid: "MS4wLjABAAAA_basic_user"
      },
      stats: { followerCount: 456_789 },
      liveRoom: { startTime: 1_724_386_400 },
      email: "DO_NOT_PROJECT@example.com"
    }
  };

  assert.deepEqual(projectBasicUserRoomPayload(payload, {
    entryRoomId: "7000000000000000001"
  }), {
    roomId: "7498765432109876543",
    userId: "7412345678901234567",
    secUid: "MS4wLjABAAAA_basic_user",
    followerCount: 456_789,
    liveTime: 1_724_386_400
  });
  assert.equal(projectBasicUserRoomPayload(payload, { entryRoomId: "0" }).liveTime, null);
  assert.equal(projectBasicUserRoomPayload({ data: {} }), null);
});

test("gift-list projection maps pages[0].region and accepts empty pages as missing country evidence", () => {
  assert.deepEqual(projectCountryGiftListPayload({
    data: { pages: [{ region: "sa", secret: "DO_NOT_PROJECT" }] }
  }), {
    region: "SA",
    creatorCountryCode: "SA",
    countryEvidenceMissing: false
  });
  assert.deepEqual(projectCountryGiftListPayload({ data: { pages: [] } }), {
    region: null,
    creatorCountryCode: null,
    countryEvidenceMissing: true
  });
  assert.equal(projectCountryGiftListPayload({ data: {} }), null);
});

test("room-enter projection sums ranks and applies total only when entry viewers are not positive", () => {
  const payload = {
    data: {
      ranks: [{ score: 120 }, { score: "80" }, { score: 0 }],
      total: 999
    }
  };
  assert.deepEqual(projectRoomEnterPayload(payload, { entryUserCount: 0 }), {
    currentScore: 200,
    userCount: 999
  });
  assert.deepEqual(projectRoomEnterPayload(payload, { entryUserCount: 321 }), {
    currentScore: 200,
    userCount: 321
  });
  assert.equal(projectRoomEnterPayload({ data: { ranks: [{ score: 1.5 }], total: 1 } }), null);
});

test("anchor-level projection selects priority 20 scene 8 and otherwise defaults to string zero", () => {
  assert.deepEqual(projectAnchorLevelPayload({
    data: {
      badge_list: [
        { priority_type: 20, scene_type: 7, privilege_log_extra: { level: "99" } },
        { priority_type: "20", scene_type: "8", privilege_log_extra: { level: "17" } },
        { priority_type: 20, scene_type: 8, privilege_log_extra: { level: "18" } }
      ]
    }
  }), { anchorLevel: "17", creatorLevel: "17" });
  assert.deepEqual(projectAnchorLevelPayload({ data: { badge_list: [] } }), {
    anchorLevel: "0",
    creatorLevel: "0"
  });
  assert.deepEqual(projectAnchorLevelPayload({}), {
    anchorLevel: "0",
    creatorLevel: "0"
  });
});

function route(overrides = {}) {
  return {
    routeCountry: "SA",
    proxyExitCountry: "SA",
    collectionProxyServer: "http://127.0.0.1:17891",
    ...overrides
  };
}

function exactRoute(overrides = {}) {
  return {
    routeCountry: "SA",
    discoveryCountry: "US",
    discoveryProxyServer: "http://127.0.0.1:17890",
    discoveryProxyExitCountry: "US",
    collectionLanes: [
      { workId: 1, countryCode: "SA", proxyServer: "http://127.0.0.1:17891" },
      { workId: 2, countryCode: "QA", proxyServer: "http://127.0.0.1:17892" },
      { workId: 3, countryCode: "EG", proxyServer: "http://127.0.0.1:17893" }
    ],
    collectionProxyExitCountries: ["SA", "QA", "EG"],
    ...overrides
  };
}

function stagePayload(stage, countryCode = "SA") {
  if (stage === "basic") {
    return {
      statusCode: 0,
      data: {
        user: {
          roomId: "7498765432109876543",
          id: "7412345678901234567",
          secUid: "MS4wLjABAAAA_full_chain"
        },
        stats: { followerCount: 123_456 },
        liveRoom: { startTime: 1_724_386_400 }
      }
    };
  }
  if (stage === "country") return { status_code: 0, data: { pages: [{ region: countryCode }] } };
  if (stage === "room_enter") {
    return { status_code: 0, data: { ranks: [{ score: 100 }, { score: 23 }], total: 777 } };
  }
  return {
    status_code: 0,
    data: {
      badge_list: [
        { priority_type: 20, scene_type: 8, privilege_log_extra: { level: "8" } }
      ]
    }
  };
}

test("transport runs four authenticated Data web stages with stage-specific headers", async () => {
  const requests = [];
  const transport = createTikTokDataEnrichmentTransport({
    requestExecutor: async (request) => {
      requests.push(request);
      return { status: 200, url: request.url, body: JSON.stringify(stagePayload(request.stage)) };
    }
  });
  const result = await transport.enrichOnce({
    seed: {
      handle: "seed.creator",
      roomId: "7000000000000000001",
      viewerCount: 0
    },
    verifiedRoute: route(),
    countryCode: "SA",
    discoverySession: { state: "authenticated", authenticated: true }
  });

  assert.equal(result.status, "ready");
  assert.deepEqual(result.completedStages, ["basic", "country", "room_enter", "anchor_level"]);
  assert.deepEqual(result.enrichment, {
    roomId: "7498765432109876543",
    userId: "7412345678901234567",
    secUid: "MS4wLjABAAAA_full_chain",
    followerCount: 123_456,
    liveTime: 1_724_386_400,
    region: "SA",
    creatorCountryCode: "SA",
    countryEvidenceMissing: false,
    currentScore: 123,
    topCode: null,
    topScore: null,
    historyRankScore: null,
    hotListScore: null,
    rankRecordScore: null,
    rankingScore: null,
    ranking: null,
    countdown: null,
    userCount: 777,
    anchorLevel: "8",
    creatorLevel: "8"
  });
  assert.equal(result.adapterEvidenceVersion, "original-data-processor-enrichment-v1");
  assert.equal(requests.length, 4);
  assert.deepEqual(requests.map((request) => request.stage), [
    "basic", "country", "room_enter", "anchor_level"
  ]);
  assert.equal(requests.every((request) => request.method === "GET"), true);
  assert.equal(requests.every((request) => request.proxyServer === "http://127.0.0.1:17891"), true);
  assert.equal(requests.every((request) => request.sessionTarget === "tiktok_discovery"), true);
  assert.equal(requests.every((request) => request.requiresAuthenticatedSession === true), true);
  assert.equal(requests.every(
    (request) => request.sessionBinding === "discovery_initialized_processor_lane"
  ), true);
  assert.equal(requests.every((request) => request.maxRedirects === 0), true);
  assert.equal(requests.every((request) => request.maxResponseBytes === 4 * 1024 * 1024), true);
  assert.equal(requests.every((request) => !Object.keys(request.headers).some(
    (header) => /cookie|token|authorization/i.test(header)
  )), true);

  const [basic, country, roomEnter, anchor] = requests.map((request) => new URL(request.url));
  assert.equal(basic.origin, "https://www.tiktok.com");
  assert.equal(basic.pathname, "/api-live/user/room/");
  assert.equal(basic.searchParams.get("uniqueId"), "seed.creator");
  assert.equal(basic.searchParams.get("sourceType"), "54");
  assert.equal(country.pathname, "/webcast/gift/list/");
  assert.equal(country.searchParams.get("room_id"), "7498765432109876543");
  assert.equal(roomEnter.pathname, "/webcast/ranklist/online_audience/");
  assert.equal(roomEnter.searchParams.get("anchor_id"), "7412345678901234567");
  assert.equal(roomEnter.searchParams.get("room_id"), "7498765432109876543");
  assert.equal(requests[2].headers.accept, "application/json, text/plain, */*");
  assert.equal(requests[0].headers.accept, undefined);
  assert.equal(anchor.pathname, "/webcast/user/");
  assert.equal(anchor.searchParams.get("target_uid"), "7412345678901234567");
  assert.equal(anchor.searchParams.get("browser_language"), "zh-CN");
  assert.doesNotMatch(JSON.stringify(result), /127\.0\.0\.1|cookie|token|authorization/i);
});

test("score-enabled enrichment preserves the original stage order and all six score fields", async () => {
  const sequence = [];
  const rankingCalls = [];
  const transport = createTikTokDataEnrichmentTransport({
    requestExecutor: async (request) => {
      sequence.push(request.stage);
      return { status: 200, url: request.url, body: JSON.stringify(stagePayload(request.stage)) };
    },
    rankingTransport: {
      async fetchOriginalScores(input) {
        rankingCalls.push(input);
        sequence.push("ranking", "top_score");
        return {
          status: "ready",
          source: "tiktok_live_original_anchor_scores",
          evidenceVersion: "tkdesk.original-anchor-scores.v4",
          endpointProfileId: "mena-mobile-v1",
          marketRegion: "MENA",
          countryCode: "SA",
          topCode: 1,
          topScore: "321",
          historyRankScore: null,
          hotListScore: "111",
          rankRecordScore: "99",
          rankingScore: "9007199254740993123",
          ranking: "MENA 周榜",
          countdown: "42",
          stageEvidence: {
            ranking: { state: "ready", requestAttempts: 1 },
            topScore: { state: "ready", requestAttempts: 1 },
            historyRankScore: { state: "skipped", reason: "top_code_1", topCode: 1 },
            hotListScore: { state: "prefilled", sourceStage: "HotListURL" },
            rankRecordScore: { state: "prefilled", sourceStage: "RankRecordURL" }
          }
        };
      }
    }
  });

  const result = await transport.enrichOnce({
    seed: {
      handle: "seed.creator",
      roomId: "7000000000000000001",
      viewerCount: 0,
      workId: 1
    },
    verifiedRoute: exactRoute({ marketRegion: "MENA" }),
    countryCode: "SA",
    discoverySession: { state: "authenticated", authenticated: true }
  });

  assert.equal(result.status, "ready");
  assert.equal(result.adapterEvidenceVersion, "original-data-processor-enrichment-v3");
  assert.deepEqual(sequence, [
    "basic", "country", "ranking", "top_score", "room_enter", "anchor_level"
  ]);
  assert.deepEqual(result.completedStages, [
    "basic", "country", "ranking", "top_score", "room_enter", "anchor_level"
  ]);
  assert.deepEqual({
    currentScore: result.enrichment.currentScore,
    topScore: result.enrichment.topScore,
    historyRankScore: result.enrichment.historyRankScore,
    hotListScore: result.enrichment.hotListScore,
    rankRecordScore: result.enrichment.rankRecordScore,
    rankingScore: result.enrichment.rankingScore
  }, {
    currentScore: 123,
    topScore: "321",
    historyRankScore: null,
    hotListScore: "111",
    rankRecordScore: "99",
    rankingScore: "9007199254740993123"
  });
  assert.equal(result.enrichment.topCode, 1);
  assert.equal(result.enrichment.ranking, "MENA 周榜");
  assert.equal(result.enrichment.countdown, "42");
  assert.deepEqual(
    result.stageEvidence.find((evidence) => evidence.stage === "history_rank"),
    { stage: "history_rank", state: "skipped", reason: "top_code_1", topCode: 1 }
  );
  assert.deepEqual(result.originalScoreEvidence, {
    state: "ready",
    source: "tiktok_live_original_anchor_scores",
    evidenceVersion: "tkdesk.original-anchor-scores.v4",
    endpointProfileId: "mena-mobile-v1",
    marketRegion: "MENA",
    countryCode: "SA",
    topCode: 1
  });
  assert.equal(rankingCalls.length, 1);
  assert.deepEqual({
    anchorId: rankingCalls[0].seed.anchorId,
    roomId: rankingCalls[0].seed.roomId,
    countryCode: rankingCalls[0].countryCode,
    workId: rankingCalls[0].workId
  }, {
    anchorId: "7412345678901234567",
    roomId: "7498765432109876543",
    countryCode: "SA",
    workId: 1
  });
});

test("MobileProcessor prefill crosses the real DataProcessor and ranking transport without duplicate Top/Hot/Record requests", async () => {
  const rankingRequests = [];
  const rankingTransport = createTikTokRankingTransport({
    requestExecutor: async (request) => {
      rankingRequests.push(request);
      return {
        status: 200,
        body: JSON.stringify({
          status_code: 0,
          data: {
            rank_view: {
              owner_rank: { score: "5" },
              countdown: "60",
              sub_tabs: [{}, { title_text: { pieces: [{ string_value: "MENA rank" }] } }]
            }
          }
        })
      };
    },
    wait: async () => {}
  });
  const dataRequests = [];
  const transport = createTikTokDataEnrichmentTransport({
    requestExecutor: async (request) => {
      dataRequests.push(request);
      const payload = request.stage === "room_enter"
        ? { status_code: 0, data: { ranks: [{ score: 0 }], total: 1 } }
        : stagePayload(request.stage);
      return { status: 200, url: request.url, body: JSON.stringify(payload) };
    },
    rankingTransport
  });
  const seed = {
    handle: "seed.creator",
    roomId: "7000000000000000001",
    viewerCount: 0,
    workId: 1,
    rankingDisplayName: "MENA(中东)",
    topCode: 1,
    topScore: "5",
    historyRankScore: null,
    hotListScore: "18",
    rankRecordScore: "7"
  };
  const result = await transport.enrichOnce({
    seed,
    verifiedRoute: exactRoute({ marketRegion: "MENA" }),
    countryCode: "SA"
  });

  assert.equal(result.status, "ready");
  assert.deepEqual(rankingRequests.map((request) => {
    const url = new URL(request.url);
    return [url.searchParams.get("rank_type"), url.searchParams.get("gap_interval")];
  }), [["16", "0"]]);
  assert.equal(rankingRequests.some((request) => (
    new URL(request.url).searchParams.get("rank_type") === "15"
  )), false);
  assert.deepEqual(result.completedStages, [
    "basic", "country", "ranking", "room_enter", "anchor_level"
  ]);
  assert.equal(result.enrichment.currentScore, 0);
  assert.equal(result.enrichment.topScore, "5");
  assert.equal(result.enrichment.hotListScore, "18");
  assert.equal(result.enrichment.rankRecordScore, "7");
  assert.equal(result.enrichment.rankingScore, "5");
  assert.equal(
    result.stageEvidence.find((item) => item.stage === "top_score")?.reason,
    "already_prefilled"
  );
  assert.deepEqual(dataRequests.map((request) => request.stage), [
    "basic", "country", "room_enter", "anchor_level"
  ]);
  const candidate = originalDataProcessorCandidate(seed, result);
  assert.equal(candidate.highQuality, true, "HotList prefill alone crosses the >=10 quality gate");
});

test("a zero entry RoomID still runs Ranking, TopScore, and HistoryRank after Basic discovers a room", async () => {
  const sequence = [];
  const rankingCalls = [];
  const transport = createTikTokDataEnrichmentTransport({
    requestExecutor: async (request) => {
      sequence.push(request.stage);
      return { status: 200, url: request.url, body: JSON.stringify(stagePayload(request.stage, "VN")) };
    },
    rankingTransport: {
      async fetchOriginalScores(input) {
        rankingCalls.push(input);
        sequence.push("ranking", "top_score", "history_rank");
        return {
          status: "ready",
          source: "tiktok_live_original_anchor_scores",
          evidenceVersion: "tkdesk.original-anchor-scores.v4",
          endpointProfileId: "vn-mobile-v1",
          marketRegion: "VN",
          countryCode: "VN",
          topCode: 2,
          topScore: "51",
          historyRankScore: "49",
          hotListScore: "48",
          rankRecordScore: "47",
          rankingScore: "52",
          ranking: "VN 周榜",
          countdown: "30",
          stageEvidence: {
            ranking: { state: "ready", requestAttempts: 1 },
            topScore: { state: "ready", requestAttempts: 1 },
            historyRankScore: { state: "ready", requestAttempts: 1 },
            hotListScore: { state: "prefilled", sourceStage: "HotListURL" },
            rankRecordScore: { state: "prefilled", sourceStage: "RankRecordURL" }
          }
        };
      }
    }
  });

  const result = await transport.enrichOnce({
    seed: { handle: "seed.creator", roomId: "0", viewerCount: null, workId: 1 },
    verifiedRoute: exactRoute({
      routeCountry: "VN",
      marketRegion: "VN",
      collectionLanes: [
        { workId: 1, countryCode: "VN", proxyServer: "http://127.0.0.1:17891" }
      ],
      collectionProxyExitCountries: ["VN"]
    }),
    countryCode: "VN",
    discoverySession: { state: "authenticated", authenticated: true }
  });

  assert.equal(result.status, "ready");
  assert.deepEqual(sequence, [
    "basic", "country", "ranking", "top_score", "history_rank", "anchor_level"
  ]);
  assert.deepEqual(result.completedStages, [
    "basic", "country", "ranking", "top_score", "history_rank", "anchor_level"
  ]);
  assert.equal(sequence.includes("room_enter"), false);
  assert.equal(result.enrichment.liveTime, null);
  assert.equal(result.enrichment.currentScore, null);
  assert.equal(result.enrichment.roomId, "7498765432109876543");
  assert.equal(result.enrichment.topScore, "51");
  assert.equal(result.enrichment.historyRankScore, "49");
  assert.equal(result.enrichment.rankingScore, "52");
  assert.equal(rankingCalls.length, 1);
  assert.deepEqual({
    anchorId: rankingCalls[0].seed.anchorId,
    roomId: rankingCalls[0].seed.roomId,
    countryCode: rankingCalls[0].countryCode,
    workId: rankingCalls[0].workId
  }, {
    anchorId: "7412345678901234567",
    roomId: "7498765432109876543",
    countryCode: "VN",
    workId: 1
  });
});

test("score authorization or transport failure remains partial after room-enter and anchor-level", async () => {
  for (const [failureReason, failureStage] of [
    ["ranking_mobile_authorization_required", "authorization"],
    ["ranking_transport_failed", "ranking"]
  ]) {
    const sequence = [];
    const transport = createTikTokDataEnrichmentTransport({
      requestExecutor: async (request) => {
        sequence.push(request.stage);
        return { status: 200, url: request.url, body: JSON.stringify(stagePayload(request.stage)) };
      },
      rankingTransport: {
        async fetchOriginalScores() {
          sequence.push("ranking");
          return { status: "capability_not_ready", reason: failureReason, stage: failureStage };
        }
      }
    });

    const result = await transport.enrichOnce({
      seed: { handle: "seed.creator", roomId: "7000000000000000001", viewerCount: 0 },
      verifiedRoute: route({ marketRegion: "MENA" }),
      countryCode: "SA",
      discoverySession: { state: "authenticated", authenticated: true }
    });

    assert.equal(result.status, "partial", failureReason);
    assert.equal(result.reason, failureReason);
    assert.equal(result.failedStage, failureStage);
    assert.deepEqual(sequence, ["basic", "country", "ranking", "room_enter", "anchor_level"]);
    assert.deepEqual(result.completedStages, ["basic", "country", "room_enter", "anchor_level"]);
    assert.equal(result.enrichment.currentScore, 123);
    assert.equal(result.enrichment.userCount, 777);
    assert.equal(result.enrichment.anchorLevel, "8");
    assert.equal(result.enrichment.creatorLevel, "8");
    assert.equal(result.adapterEvidenceVersion, "original-data-processor-enrichment-v3");
    assert.deepEqual(result.originalScoreEvidence, {
      state: "unresolved",
      reason: failureReason,
      stage: failureStage,
      secretValuesExposed: false
    });
  }
});

test("a rejected score transport still runs room-enter and anchor-level before returning partial", async () => {
  const sequence = [];
  const transport = createTikTokDataEnrichmentTransport({
    requestExecutor: async (request) => {
      sequence.push(request.stage);
      return { status: 200, url: request.url, body: JSON.stringify(stagePayload(request.stage)) };
    },
    rankingTransport: {
      async fetchOriginalScores() {
        sequence.push("ranking");
        throw new Error("SCORE_TRANSPORT_SECRET_DETAIL");
      }
    }
  });

  const result = await transport.enrichOnce({
    seed: { handle: "seed.creator", roomId: "7000000000000000001", viewerCount: 0 },
    verifiedRoute: route({ marketRegion: "MENA" }),
    countryCode: "SA",
    discoverySession: { state: "authenticated", authenticated: true }
  });

  assert.equal(result.status, "partial");
  assert.equal(result.reason, "ranking_transport_failed");
  assert.deepEqual(sequence, ["basic", "country", "ranking", "room_enter", "anchor_level"]);
  assert.equal(result.enrichment.currentScore, 123);
  assert.equal(result.enrichment.anchorLevel, "8");
  assert.doesNotMatch(JSON.stringify(result), /SCORE_TRANSPORT_SECRET_DETAIL/);
});

test("enrichment WorkID 4 safely adapts MobileSettings[0] fallback by ranking-scope country", async () => {
  const requests = [];
  const transport = createTikTokDataEnrichmentTransport({
    requestExecutor: async (request) => {
      requests.push(request);
      return { status: 200, url: request.url, body: JSON.stringify(stagePayload(request.stage, "QA")) };
    }
  });
  const result = await transport.enrichOnce({
    seed: {
      handle: "rank.expanded.creator",
      roomId: "7000000000000000001",
      viewerCount: 0,
      workId: 4,
      rankingScopeCountryCode: "QA"
    },
    verifiedRoute: exactRoute(),
    discoverySession: { state: "authenticated", authenticated: true }
  });

  assert.equal(result.status, "ready");
  assert.equal(result.workId, 4);
  assert.deepEqual(result.collectionLaneEvidence, {
    topology: "mobile_settings_country_lane_compatibility",
    workId: 4,
    laneIndex: 1,
    countryCode: "QA",
    exitCountry: "QA",
    affinity: "target_country_fallback",
    originalFallbackSource: "mobile_settings_0"
  });
  assert.equal(requests.length, 4);
  assert.equal(requests.every(
    (request) => request.proxyServer === "http://127.0.0.1:17892"
  ), true);
  assert.doesNotMatch(JSON.stringify(result), /127\.0\.0\.1|1789[02]/i);
});

test("enrichment keeps each country WorkID sticky across every stage", async () => {
  const requests = [];
  let activeCountry = "SA";
  const transport = createTikTokDataEnrichmentTransport({
    requestExecutor: async (request) => {
      requests.push(request);
      return { status: 200, url: request.url, body: JSON.stringify(stagePayload(request.stage, activeCountry)) };
    }
  });

  for (const [workId, countryCode] of [[1, "SA"], [2, "QA"], [3, "EG"]]) {
    activeCountry = countryCode;
    const start = requests.length;
    const result = await transport.enrichOnce({
      seed: {
        handle: "seed.creator",
        roomId: "7000000000000000001",
        viewerCount: 0,
        workId
      },
      verifiedRoute: exactRoute({ routeCountry: "US" }),
      countryCode,
      discoverySession: { state: "authenticated", authenticated: true }
    });
    assert.equal(result.status, "ready");
    assert.equal(result.workId, workId);
    assert.deepEqual(result.collectionLaneEvidence, {
      topology: "original_country_lane",
      workId,
      laneIndex: workId - 1,
      countryCode,
      exitCountry: countryCode,
      affinity: "sticky_work_id"
    });
    assert.equal(requests.slice(start).length, 4);
    assert.equal(requests.slice(start).every(
      (request) => request.proxyServer === `http://127.0.0.1:${17890 + workId}`
    ), true);
    assert.doesNotMatch(JSON.stringify(result), /127\.0\.0\.1|1789[1-3]/i);
  }
});

test("country enrichment route rejects invalid WorkID, per-lane drift, and unsafe WorkID 4 fallback", async () => {
  let calls = 0;
  const transport = createTikTokDataEnrichmentTransport({
    requestExecutor: async () => { calls += 1; }
  });
  const base = {
    seed: { handle: "seed.creator", roomId: "0" },
    verifiedRoute: exactRoute(),
    countryCode: "SA",
    discoverySession: { state: "authenticated", authenticated: true }
  };
  const cases = [
    [base, "enrichment_work_id_invalid"],
    [{ ...base, workId: 5 }, "enrichment_work_id_invalid"],
    [{ ...base, seed: { ...base.seed, workId: 2 }, workId: 3 }, "enrichment_work_id_invalid"],
    [{
      ...base,
      seed: { ...base.seed, workId: 2 },
      countryCode: "QA",
      verifiedRoute: exactRoute({ collectionProxyExitCountries: ["SA", "US", "EG"] })
    }, "enrichment_route_country_mismatch"],
    [{
      ...base,
      seed: { ...base.seed, workId: 1 },
      verifiedRoute: exactRoute({ collectionProxyExitCountries: ["SA"] })
    }, "enrichment_lane_route_invalid"],
    [{
      ...base,
      seed: { ...base.seed, workId: 4 },
      countryCode: undefined
    }, "enrichment_route_country_mismatch"],
    [{
      ...base,
      seed: { ...base.seed, workId: 4, rankingScopeCountryCode: "OM" },
      countryCode: undefined
    }, "enrichment_route_country_mismatch"],
    [{
      ...base,
      seed: { ...base.seed, workId: 4, rankingScopeCountryCode: "QA" },
      countryCode: undefined,
      verifiedRoute: exactRoute({ collectionLanes: [
        { workId: 1, countryCode: "SA", proxyServer: "http://127.0.0.1:17891" },
        { workId: 2, countryCode: "QA", proxyServer: "http://remote.example:17892" },
        { workId: 3, countryCode: "EG", proxyServer: "http://127.0.0.1:17893" }
      ] })
    }, "enrichment_proxy_not_allowed"],
    [{
      ...base,
      seed: { ...base.seed, workId: 4, rankingScopeCountryCode: "QA" },
      countryCode: "SA"
    }, "enrichment_route_country_mismatch"],
    [{ ...base, seed: { ...base.seed, workId: 1 }, verifiedRoute: route() }, "enrichment_lane_route_invalid"]
  ];
  for (const [input, reason] of cases) {
    assert.equal((await transport.enrichOnce(input)).reason, reason);
  }
  assert.equal(calls, 0);
});

test("non-live entry skips room-enter, and a stage failure is not retried", async () => {
  const requestedStages = [];
  const transport = createTikTokDataEnrichmentTransport({
    requestExecutor: async (request) => {
      requestedStages.push(request.stage);
      if (request.stage === "country") throw new Error("SECRET_NETWORK_DETAIL");
      return { status: 200, url: request.url, body: JSON.stringify(stagePayload(request.stage)) };
    }
  });
  const result = await transport.enrichOnce({
    seed: { handle: "seed.creator", roomId: "0", viewerCount: null },
    verifiedRoute: route(),
    countryCode: "SA",
    discoverySession: { state: "authenticated", authenticated: true }
  });
  assert.equal(result.status, "partial");
  assert.equal(result.reason, "country_transport_failed");
  assert.equal(result.failedStage, "country");
  assert.equal(result.enrichment.anchorLevel, null);
  assert.equal(result.enrichment.creatorLevel, null);
  assert.deepEqual(requestedStages, ["basic", "country"]);
  assert.doesNotMatch(JSON.stringify(result), /SECRET_NETWORK_DETAIL|127\.0\.0\.1/i);
});

test("transport applies the original follower filter before country and country match before room-enter", async () => {
  const calls = [];
  const transport = createTikTokDataEnrichmentTransport({
    requestExecutor: async (request) => {
      calls.push(request.stage);
      const payload = request.stage === "country"
        ? { status_code: 0, data: { pages: [{ region: "DZ" }] } }
        : stagePayload(request.stage);
      return { status: 200, url: request.url, body: JSON.stringify(payload) };
    }
  });
  const base = {
    seed: { handle: "seed.creator", roomId: "7000000000000000001", viewerCount: 0 },
    verifiedRoute: route(),
    countryCode: "SA",
    discoverySession: { state: "authenticated", authenticated: true }
  };
  const followerFiltered = await transport.enrichOnce({ ...base, minFollowers: 200_000 });
  assert.equal(followerFiltered.status, "filtered");
  assert.equal(followerFiltered.reason, "follower_below_minimum");
  assert.deepEqual(calls, ["basic"]);

  calls.length = 0;
  const countryFiltered = await transport.enrichOnce(base);
  assert.equal(countryFiltered.status, "filtered");
  assert.equal(countryFiltered.reason, "creator_country_mismatch");
  assert.equal(countryFiltered.enrichment.creatorCountryCode, "DZ");
  assert.deepEqual(calls, ["basic", "country"]);
});

test("standalone executor owns authentication while transport rejects unsafe country routes", async () => {
  let calls = 0;
  const transport = createTikTokDataEnrichmentTransport({
    requestExecutor: async (request) => {
      calls += 1;
      return { status: 200, url: request.url, body: JSON.stringify(stagePayload(request.stage)) };
    }
  });
  const base = {
    seed: { handle: "seed.creator", roomId: "0" },
    verifiedRoute: route(),
    countryCode: "SA"
  };
  const independentWorker = await transport.enrichOnce({
    ...base,
    discoverySession: { state: "unknown", authenticated: null }
  });
  assert.equal(independentWorker.status, "ready");
  assert.equal(calls, 3);
  calls = 0;
  assert.equal((await transport.enrichOnce({
    ...base,
    verifiedRoute: route({ proxyExitCountry: "US" }),
    discoverySession: { state: "authenticated", authenticated: true }
  })).reason, "enrichment_route_country_mismatch");
  assert.equal((await transport.enrichOnce({
    ...base,
    verifiedRoute: route({ collectionProxyServer: "http://user:pass@127.0.0.1:17891" }),
    discoverySession: { state: "authenticated", authenticated: true }
  })).reason, "enrichment_proxy_not_allowed");
  assert.equal(calls, 0);
});

test("enrichment profile preserves original conditions without endpoint or credential material", () => {
  assert.deepEqual(TIKTOK_DATA_ENRICHMENT_PROFILE.stages, [
    "basic", "country", "ranking", "top_score", "history_rank", "room_enter", "anchor_level"
  ]);
  assert.equal(TIKTOK_DATA_ENRICHMENT_PROFILE.topCodeSource, "original_country_configuration");
  assert.equal(TIKTOK_DATA_ENRICHMENT_PROFILE.scoreFailureBehavior, "fail_soft_with_partial_evidence");
  assert.equal(TIKTOK_DATA_ENRICHMENT_PROFILE.authenticatedSessionTarget, "tiktok_discovery");
  assert.equal(TIKTOK_DATA_ENRICHMENT_PROFILE.sessionBinding, "discovery_initialized_processor_lane");
  assert.equal(
    TIKTOK_DATA_ENRICHMENT_PROFILE.adapterEvidenceVersion,
    "original-data-processor-enrichment-v3"
  );
  assert.deepEqual(TIKTOK_DATA_ENRICHMENT_PROFILE.anchorLevelBadge, {
    priorityType: 20,
    sceneType: 8,
    defaultLevel: "0"
  });
  assert.equal(TIKTOK_DATA_ENRICHMENT_PROFILE.maximumAttemptsPerStage, 1);
  assert.doesNotMatch(JSON.stringify(TIKTOK_DATA_ENRICHMENT_PROFILE), /https?:\/\/|cookie|token|authorization/i);
});


test("Data executor receives internally resolved lane metadata and verified route", async () => {
  const calls = [];
  const verifiedRoute = exactRoute();
  const transport = createTikTokDataEnrichmentTransport({ requestExecutor: async (request, context) => {
    calls.push({ request, context });
    return { status: 200, url: request.url, body: JSON.stringify(stagePayload(request.stage, "QA")) };
  } });
  const result = await transport.enrichOnce({ seed: { handle: "creator", roomId: "0", workId: 4, rankingScopeCountryCode: "QA" }, verifiedRoute });
  assert.equal(result.status, "ready");
  assert.equal(calls.length, 3);
  for (const { request, context } of calls) {
    assert.equal(context.verifiedRoute, verifiedRoute);
    assert.equal(request.workId, 4);
    assert.equal(request.countryCode, "QA");
    assert.equal(request.requiresAuthenticatedSession, true);
    assert.equal(request.sessionTarget, "tiktok_discovery");
  }
});

test("Data has no anonymous production fallback when authenticated executor is missing", async () => {
  let contexts = 0;
  const transport = createTikTokDataEnrichmentTransport({ requestContextFactory: { async newContext() { contexts++; throw new Error("unexpected anonymous context"); } } });
  await transport.enrichOnce({ seed: { handle: "creator", roomId: "0" }, verifiedRoute: route(), countryCode: "SA" });
  assert.equal(contexts, 0);
});

test("Data forwards the selected display variant and preserves descendant ranking provenance", async () => {
  for (const rankingDisplayName of [null, "descendant-display-variant"]) {
    let observed;
    const transport = createTikTokDataEnrichmentTransport({
      requestExecutor: async request => ({ status: 200, url: request.url, body: JSON.stringify(stagePayload(request.stage)) }),
      rankingTransport: { async fetchOriginalScores(request) { observed = request; return { status: "capability_not_ready", reason: "ranking_mobile_authorization_required" }; } }
    });
    const verifiedRoute = exactRoute({ marketRegion: "MENA" });
    verifiedRoute.collectionLanes[0].displayName = "MENA(中东)";
    await transport.enrichOnce({ seed: { handle: "seed.creator", roomId: "1", workId: 1, rankingDisplayName }, verifiedRoute, countryCode: "SA" });
    assert.equal(observed.displayName, rankingDisplayName ?? "MENA(中东)");
    assert.equal(observed.seed.rankingDisplayName, rankingDisplayName ?? "MENA(中东)");
  }
});

test("Data distinguishes closed leases, lost authentication and route drift from network errors", async () => {
  for (const [code, reason] of [["SESSION_REQUEST_RUN_CLOSED", "enrichment_session_run_closed"], ["SESSION_REQUEST_AUTHENTICATION_REQUIRED", "enrichment_authentication_required"], ["SESSION_REQUEST_PROXY_MISMATCH", "enrichment_route_country_mismatch"], ["SESSION_REQUEST_FAILED", "basic_transport_failed"]]) {
    const transport = createTikTokDataEnrichmentTransport({ requestExecutor: async () => { const error = new Error("hidden diagnostic"); error.code = code; throw error; } });
    const result = await transport.enrichOnce({ seed: { handle: "seed.creator", roomId: "1", workId: 1 }, verifiedRoute: exactRoute(), countryCode: "SA" });
    assert.equal(result.reason, reason);
    assert.doesNotMatch(JSON.stringify(result), /hidden diagnostic/);
  }
});
