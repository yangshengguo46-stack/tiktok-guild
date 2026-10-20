import assert from "node:assert/strict";
import test from "node:test";
import { collectTikTokLiveRanking } from "../mcp/adapters/tiktok-live-ranking.js";
import { buildOriginalWorkId4RankingSeeds } from "../mcp/core/original-cascade-runtime.js";
import {
  ORIGINAL_COUNTRY_CATALOG_PROFILE,
  ORIGINAL_FIXED_TEMPLATE_BASE_PARAMS,
  originalExecutableProfileForCountry
} from "../mcp/core/original-country-config.js";
import {
  TIKTOK_RANKING_TRANSPORT_PROFILE,
  createTikTokRankingTransport
} from "../mcp/core/tiktok-ranking-transport.js";

const seed = Object.freeze({
  anchorId: "7412345678901234567",
  roomId: "7498765432109876543"
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

function rankBody(handle, id) {
  return JSON.stringify({
    status_code: 0,
    data: {
      rank_view: {
        ranks: [{
          score: "123",
          room_id_str: seed.roomId,
          rank_user: { display_id: handle, id_str: id }
        }]
      }
    }
  });
}

function commerceRankingBody() {
  return JSON.stringify({
    status_code: 0,
    data: {
      rank_view: {
        ranks: [
          {
            score: "400",
            room_id_str: "7498765432109876401",
            has_commerce_goods: true,
            rank_user: { display_id: "row.true", id_str: "7412345678901234401", country_code: "SA" }
          },
          {
            score: "300",
            room_id_str: "7498765432109876402",
            rank_user: {
              display_id: "user.false",
              id_str: "7412345678901234402",
              country_code: "SA",
              has_commerce_goods: false
            }
          },
          {
            score: "200",
            room_id_str: "7498765432109876403",
            room: { has_commerce_goods: true, owner: { token: "must-not-project" } },
            rank_user: { display_id: "room.true", id_str: "7412345678901234403", country_code: "SA" }
          },
          {
            score: "100",
            room_id_str: "7498765432109876404",
            rank_user: { display_id: "seller.unknown", id_str: "7412345678901234404", country_code: "SA" }
          }
        ]
      }
    }
  });
}

function originalRankingBody({
  score = "0009007199254740993123",
  label = "MENA 周榜",
  countdown = "00042"
} = {}) {
  return JSON.stringify({
    status_code: 0,
    data: {
      rank_view: {
        sub_tabs: [
          { title_text: { pieces: [{ string_value: "其他" }] } },
          { title_text: { pieces: label === null ? [] : [{ string_value: label }] } }
        ],
        owner_rank: { score },
        countdown
      }
    }
  });
}

function originalTopBody(score = 321) {
  return JSON.stringify({
    status_code: 0,
    data: { rank_view: { owner_rank: { score } } }
  });
}

function originalWholeListBody(score, {
  userId = seed.anchorId,
  roomId = seed.roomId
} = {}) {
  return JSON.stringify({
    status_code: 0,
    data: {
      rank_view: {
        ranks: [{
          score,
          room_id_str: roomId,
          rank_user: { id_str: userId, display_id: "seed.creator" }
        }]
      }
    }
  });
}

test("original transport fixes endpoint, query semantics, country proxy, and gap order", async () => {
  const requests = [];
  const transport = createTikTokRankingTransport({
    requestExecutor: async (request) => {
      requests.push(request);
      const gap = new URL(request.url).searchParams.get("gap_interval");
      return { status: 200, body: rankBody(gap === "0" ? "current" : "previous", gap === "0" ? "1" : "2") };
    },
    wait: async () => {}
  });

  const result = await transport.fetchPair({
    seed,
    verifiedRoute: route(),
    marketRegion: "MENA",
    countryCode: "SA"
  });

  assert.equal(result.status, "ready");
  assert.deepEqual(result.gapIntervals, [0, -1]);
  assert.equal(result.rankTypeCode, 16);
  assert.equal(result.regionTypeCode, 1);
  assert.equal(result.snapshots.length, 2);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests.map((request) => request.proxyServer), [
    "http://127.0.0.1:17891",
    "http://127.0.0.1:17891"
  ]);
  assert.deepEqual(requests.map((request) => {
    const url = new URL(request.url);
    return {
      origin: url.origin,
      path: url.pathname,
      entries: [...url.searchParams.entries()]
    };
  }), [0, -1].map((gap) => ({
    origin: "https://webcast16-normal-useast8.tiktokv.us",
    path: "/webcast/ranklist/list/v2/",
    entries: [
      ["anchor_id", seed.anchorId],
      ["room_id", seed.roomId],
      ["rank_type", "16"],
      ["region_type", "1"],
      ["gap_interval", String(gap)],
      ["use_simple_user", "true"],
      ["league_phase", "0"],
      ["ac", "wifi"],
      ["channel", "googleplay"],
      ["aid", "1233"],
      ["app_name", "musical_ly"],
      ["version_code", "320701"],
      ["version_name", "32.7.1"]
    ]
  })));
  for (const request of requests) {
    assert.equal(request.method, "GET");
    assert.equal(request.timeoutMs, 60_000);
    assert.equal(request.maxRedirects, 0);
    assert.equal(request.headers["sdk-version"], "2");
    assert.equal(Object.hasOwn(request.headers, "authorization"), false);
    assert.equal(Object.hasOwn(request.headers, "cookie"), false);
    assert.equal(Object.hasOwn(request.headers, "x-tt-token"), false);
  }
  assert.equal(result.snapshots[0].sourceEvidence.countryCode, "SA");
  assert.equal(
    result.snapshots[0].sourceEvidence.countryScopeEvidence,
    "verified_collection_proxy_exit_and_dynamic_candidate_rank_request"
  );
  assert.doesNotMatch(JSON.stringify(result), /anchor_id=|room_id=|127\.0\.0\.1|[?&](?:rank_type|region_type|gap_interval)=/i);
});

test("safe ranking projection carries tri-state commerce evidence into WorkID4 candidates", async () => {
  const transport = createTikTokRankingTransport({
    requestExecutor: async () => ({ status: 200, body: commerceRankingBody() }),
    wait: async () => {}
  });
  const routePolicy = exactRoute();
  const pair = await transport.fetchPair({
    seed: { ...seed, workId: 1 },
    verifiedRoute: routePolicy,
    marketRegion: "MENA",
    countryCode: "SA"
  });

  assert.equal(pair.status, "ready");
  const projectedRows = pair.snapshots[0].payload.data.rank_view.ranks;
  assert.deepEqual(projectedRows.map((row) => ({
    row: row.has_commerce_goods,
    user: row.rank_user.has_commerce_goods,
    room: row.room.has_commerce_goods
  })), [
    { row: true, user: null, room: null },
    { row: null, user: false, room: null },
    { row: null, user: null, room: true },
    { row: null, user: null, room: null }
  ]);
  assert.equal(JSON.stringify(pair).includes("must-not-project"), false);

  const normalized = await collectTikTokLiveRanking({
    marketRegion: "MENA",
    countryCode: "SA",
    rankingViewKind: "top",
    limit: 30,
    provider: async () => pair
  });
  assert.equal(normalized.status, "ready");
  assert.deepEqual(
    normalized.candidates.map((candidate) => candidate.seller),
    [true, false, true, null],
    "missing commerce evidence must remain unknown instead of becoming false"
  );

  const workId4 = buildOriginalWorkId4RankingSeeds({
    candidates: normalized.candidates,
    sourceSeed: { workId: 1 },
    normalizedRanking: normalized,
    lane: { workId: 1, countryCode: "SA", proxyExitCountry: "SA" },
    marketRegion: "MENA"
  });
  assert.ok(workId4.every((candidate) => candidate.workId === 4));
  assert.deepEqual(workId4.map((candidate) => candidate.seller), [true, false, true, null]);
});

test("original single-anchor score chain fixes MENA requests and projects exact fields", async () => {
  const requests = [];
  const transport = createTikTokRankingTransport({
    requestExecutor: async (request) => {
      requests.push(request);
      const url = new URL(request.url);
      const rankType = url.searchParams.get("rank_type");
      if (rankType === "16") return { status: 200, body: originalRankingBody() };
      if (rankType === "15") {
        return {
          status: 200,
          body: originalWholeListBody(url.searchParams.get("gap_interval") === "0" ? "41" : "39")
        };
      }
      return { status: 200, body: originalTopBody() };
    },
    wait: async () => {}
  });

  const result = await transport.fetchOriginalScores({
    seed: { ...seed, hotListScore: "41", rankRecordScore: "39" },
    verifiedRoute: route(),
    marketRegion: "MENA",
    countryCode: "SA",
    endpoint: "https://example.invalid/untrusted",
    rankTypeCode: 15,
    gapInterval: -1,
    threshold: 999
  });

  assert.equal(result.status, "ready");
  assert.equal(result.evidenceVersion, "tkdesk.original-anchor-scores.v4");
  assert.equal(result.topCode, 1);
  assert.equal(result.currentScore, null);
  assert.equal(result.topScore, 321);
  assert.equal(result.historyRankScore, null);
  assert.equal(result.hotListScore, "41");
  assert.equal(result.rankRecordScore, "39");
  assert.equal(result.rankingScore, "9007199254740993123");
  assert.equal(result.ranking, "MENA 周榜");
  assert.equal(result.countdown, "42");
  assert.deepEqual(result.stageEvidence.historyRankScore, {
    state: "skipped",
    reason: "top_code_1",
    topCode: 1
  });
  assert.deepEqual(result.stageEvidence.hotListScore, {
    state: "prefilled",
    sourceStage: "HotListURL",
    sourceKind: "original_mobile_processor_fixed_country_lists"
  });
  assert.deepEqual(requests.map((request) => {
    const url = new URL(request.url);
    return {
      rankType: url.searchParams.get("rank_type"),
      regionType: url.searchParams.get("region_type"),
      gap: url.searchParams.get("gap_interval"),
      anchorId: url.searchParams.get("anchor_id"),
      roomId: url.searchParams.get("room_id")
    };
  }), [
    { rankType: "16", regionType: "1", gap: "0", anchorId: seed.anchorId, roomId: seed.roomId },
    { rankType: "0", regionType: "1", gap: "0", anchorId: seed.anchorId, roomId: seed.roomId }
  ]);
  assert.equal(requests.every((request) => request.proxyServer === "http://127.0.0.1:17891"), true);
  assert.equal(requests.every((request) => !Object.keys(request.headers).some(
    (header) => /cookie|token|authorization/i.test(header)
  )), true);
  assert.doesNotMatch(
    JSON.stringify(result),
    /https?:\/\/|127\.0\.0\.1|anchor_id=|room_id=|threshold|rank_type|gap_interval/i
  );
});

test("TopCode 2 uses the source endpoint and executes ranking, top, then history", async () => {
  const requests = [];
  const result = await createTikTokRankingTransport({
    requestExecutor: async (request) => {
      requests.push(request);
      const url = new URL(request.url);
      if (url.searchParams.get("rank_type") === "16") {
        return { status: 200, body: originalRankingBody({ score: "11", label: "UK 日榜" }) };
      }
      if (url.searchParams.get("rank_type") === "15") {
        return {
          status: 200,
          body: originalWholeListBody(url.searchParams.get("gap_interval") === "0" ? "44" : "55")
        };
      }
      return {
        status: 200,
        body: originalTopBody(url.searchParams.get("gap_interval") === "0" ? "22" : "33")
      };
    },
    wait: async () => {}
  }).fetchOriginalScores({
    seed: { ...seed, hotListScore: "44", rankRecordScore: "55" },
    verifiedRoute: route({
      routeCountry: "GB",
      proxyExitCountry: "GB",
      collectionProxyExitCountry: "GB"
    }),
    marketRegion: "UK",
    countryCode: "GB"
  });

  assert.equal(result.status, "ready");
  assert.equal(result.topCode, 2);
  assert.equal(result.topScore, "22");
  assert.equal(result.historyRankScore, "33");
  assert.equal(result.hotListScore, "44");
  assert.equal(result.rankRecordScore, "55");
  assert.equal(result.stageEvidence.historyRankScore.state, "ready");
  assert.deepEqual(requests.map((request) => {
    const url = new URL(request.url);
    return [url.host, url.searchParams.get("rank_type"), url.searchParams.get("gap_interval")];
  }), [
    ["webcast16-normal-no1a.tiktokv.eu", "16", "0"],
    ["webcast16-normal-no1a.tiktokv.eu", "8", "0"],
    ["webcast16-normal-no1a.tiktokv.eu", "8", "-1"]
  ]);
});

test("candidate enrichment never substitutes dynamic HotList or RankRecord requests", async () => {
  const requests = [];
  const result = await createTikTokRankingTransport({
    requestExecutor: async (request) => {
      requests.push(request);
      const url = new URL(request.url);
      const rankType = url.searchParams.get("rank_type");
      if (rankType === "16") return { status: 200, body: originalRankingBody({ score: "10" }) };
      return { status: 200, body: originalTopBody("20") };
    },
    wait: async () => {}
  }).fetchOriginalScores({
    seed,
    verifiedRoute: route(),
    marketRegion: "MENA",
    countryCode: "SA"
  });

  assert.equal(result.status, "ready");
  assert.equal(result.hotListScore, null);
  assert.equal(result.rankRecordScore, null);
  assert.equal(result.stageEvidence.hotListScore.reason, "mobile_discovery_prefill_missing");
  assert.equal(result.stageEvidence.rankRecordScore.reason, "mobile_discovery_prefill_missing");
  assert.equal(requests.some((request) => new URL(request.url).searchParams.get("rank_type") === "15"), false);
});

test("candidate enrichment skips Top and History already prefilled by MobileProcessor", async () => {
  const requests = [];
  const result = await createTikTokRankingTransport({
    requestExecutor: async (request) => {
      requests.push(request);
      return { status: 200, body: originalRankingBody({ score: "55", label: "current" }) };
    },
    wait: async () => {}
  }).fetchOriginalScores({
    seed: {
      ...seed,
      topScore: "101",
      historyRankScore: "202",
      hotListScore: "303",
      rankRecordScore: "404"
    },
    verifiedRoute: route({
      routeCountry: "BY",
      proxyExitCountry: "BY",
      collectionProxyExitCountry: "BY"
    }),
    marketRegion: "CCA",
    countryCode: "BY"
  });

  assert.equal(result.status, "ready");
  assert.equal(requests.length, 1);
  assert.equal(new URL(requests[0].url).searchParams.get("rank_type"), "16");
  assert.equal(result.topScore, "101");
  assert.equal(result.historyRankScore, "202");
  assert.equal(result.hotListScore, "303");
  assert.equal(result.rankRecordScore, "404");
  assert.equal(result.stageEvidence.topScore.reason, "already_prefilled");
  assert.equal(result.stageEvidence.historyRankScore.reason, "already_prefilled");
});

test("zero Top and History remain original missing sentinels while a Ranking label skips Ranking", async () => {
  const requests = [];
  const result = await createTikTokRankingTransport({
    requestExecutor: async (request) => {
      requests.push(request);
      return { status: 200, body: originalTopBody("88") };
    },
    wait: async () => {}
  }).fetchOriginalScores({
    seed: {
      ...seed,
      ranking: "未知",
      rankingTitleState: "original_unknown_sentinel",
      rankingScore: "77",
      topScore: "0",
      historyRankScore: 0
    },
    verifiedRoute: route({
      routeCountry: "BY",
      proxyExitCountry: "BY",
      collectionProxyExitCountry: "BY"
    }),
    marketRegion: "CCA",
    countryCode: "BY"
  });

  assert.equal(result.status, "ready");
  assert.deepEqual(requests.map((request) => {
    const url = new URL(request.url);
    return [url.searchParams.get("rank_type"), url.searchParams.get("gap_interval")];
  }), [["8", "0"], ["8", "-1"]]);
  assert.equal(result.rankingScore, "77");
  assert.equal(result.ranking, "未知");
  assert.equal(result.rankingTitleState, "original_unknown_sentinel");
  assert.equal(result.stageEvidence.ranking.reason, "already_prefilled");
});

test("all 36 original display variants execute their safe four-list country template contract", async () => {
  const variants = ORIGINAL_COUNTRY_CATALOG_PROFILE.configurations.flatMap((configuration) => (
    configuration.displayVariants.map((variant) => ({ configuration, variant }))
  ));
  assert.equal(variants.length, 36);
  const fixedTemplateFingerprints = new Set();
  for (const { configuration, variant } of variants) {
    const countryCode = variant.selectionCountryCodes[0];
    const profile = originalExecutableProfileForCountry({
      marketRegion: configuration.routeCode,
      countryCode,
      displayName: variant.displayName
    });
    assert.ok(profile, variant.displayName);
    const requests = [];
    const result = await createTikTokRankingTransport({
    requestExecutor: async (request) => {
      requests.push(request);
      const url = new URL(request.url);
      const rankType = url.searchParams.get("rank_type");
      const gap = url.searchParams.get("gap_interval");
      const score = rankType === "15" ? (gap === "0" ? "30" : "40") : (gap === "0" ? "10" : "20");
      return { status: 200, body: originalWholeListBody(score) };
    },
    wait: async () => {}
    }).fetchOriginalCountryTemplateBundle({
      verifiedRoute: route({
        routeCountry: countryCode,
        proxyExitCountry: countryCode,
        collectionProxyExitCountry: countryCode
      }),
      marketRegion: configuration.routeCode,
      countryCode,
      displayName: variant.displayName
    });
    assert.equal(result.status, "ready", variant.displayName);
    assert.equal(result.evidenceVersion, "tkdesk.original-country-template-bundle.v1");
    assert.match(result.fixedTemplateFingerprint, /^[a-f0-9]{64}$/);
    fixedTemplateFingerprints.add(result.fixedTemplateFingerprint);
    assert.deepEqual(result.templateLabels, configuration.topCode === 1
      ? ["TopURL", "HotListURL", "RankRecordURL"]
      : ["TopURL", "HistoryRankURL", "HotListURL", "RankRecordURL"]);
    assert.deepEqual(result.templateRowCounts, {
      TopURL: 1,
      HistoryRankURL: configuration.topCode === 1 ? null : 1,
      HotListURL: 1,
      RankRecordURL: 1
    });
    assert.equal(requests.length, configuration.topCode === 1 ? 3 : 4);
    for (const request of requests) {
      const url = new URL(request.url);
      assert.equal(url.searchParams.get("anchor_id"), profile.safeFixedTemplateScope.anchorId);
      assert.equal(url.searchParams.get("room_id"), profile.safeFixedTemplateScope.roomId);
      for (const [key, value] of Object.entries(ORIGINAL_FIXED_TEMPLATE_BASE_PARAMS)) {
        assert.equal(url.searchParams.get(key), value);
      }
      assert.equal(Object.keys(request.headers).some((key) => /cookie|token|authorization/i.test(key)), false);
    }
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].hotListScore, "30");
    assert.equal(result.candidates[0].rankRecordScore, "40");
    assert.equal(result.candidates[0].historyRankScore, configuration.topCode === 1 ? null : "20");
  }
  assert.equal(fixedTemplateFingerprints.size, 36);
});

test("fixed country lists union overlapping identities and fail closed on cross-identity links", async () => {
  const rowsBody = (rows) => JSON.stringify({
    status_code: 0,
    data: { rank_view: { ranks: rows } }
  });
  const userA = "7412345678901234101";
  const roomA = "7498765432109876101";
  const userB = "7412345678901234102";
  const roomB = "7498765432109876102";
  const result = await createTikTokRankingTransport({
    requestExecutor: async (request) => {
      const url = new URL(request.url);
      const rankType = url.searchParams.get("rank_type");
      const gap = url.searchParams.get("gap_interval");
      if (rankType === "0") return {
        status: 200,
        body: rowsBody([
          { score: "10", room_id_str: roomA, rank_user: { id_str: userA, display_id: "user.a" } },
          { score: "11", room_id_str: roomB, rank_user: { id_str: userB, display_id: "user.b" } }
        ])
      };
      if (gap === "0") return {
        status: 200,
        body: rowsBody([
          { score: "30", room_id_str: roomA, rank_user: { id_str: userA, display_id: "user.a" } },
          // userA and roomB already identify different candidates; this row is discarded.
          { score: "999", room_id_str: roomB, rank_user: { id_str: userA, display_id: "conflict" } }
        ])
      };
      return {
        status: 200,
        body: rowsBody([
          { score: "40", room_id_str: roomA, rank_user: { id_str: userA, display_id: "user.a" } }
        ])
      };
    },
    wait: async () => {}
  }).fetchOriginalCountryTemplateBundle({
    verifiedRoute: route(),
    marketRegion: "MENA",
    countryCode: "SA",
    displayName: "MENA(中东)"
  });

  assert.equal(result.status, "ready");
  assert.equal(result.templateMergeKeyKind, "normalized_display_id");
  assert.equal(result.candidates.length, 2);
  const a = result.candidates.find((candidate) => candidate.userId === userA);
  const b = result.candidates.find((candidate) => candidate.userId === userB);
  assert.deepEqual(
    { top: a.topScore, hot: a.hotListScore, record: a.rankRecordScore },
    { top: "10", hot: "30", record: "40" }
  );
  assert.equal(b.topScore, "11");
  assert.equal(b.hotListScore, null);
  assert.doesNotMatch(JSON.stringify(result), /conflict|999/);
});

test("fixed country lists use normalized DisplayID as the original primary merge key", async () => {
  const rowsBody = (displayId, score) => JSON.stringify({
    status_code: 0,
    data: {
      rank_view: {
        ranks: [{ score, rank_user: { display_id: displayId } }]
      }
    }
  });
  let call = 0;
  const result = await createTikTokRankingTransport({
    requestExecutor: async () => {
      call += 1;
      return { status: 200, body: rowsBody(call === 1 ? "@Creator.Name" : "creator.name", String(call * 10)) };
    },
    wait: async () => {}
  }).fetchOriginalCountryTemplateBundle({
    verifiedRoute: route(),
    marketRegion: "MENA",
    countryCode: "SA",
    displayName: "MENA(中东)"
  });

  assert.equal(result.status, "ready");
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].templateMergeKeyKind, "normalized_display_id");
  assert.deepEqual(
    {
      top: result.candidates[0].topScore,
      hot: result.candidates[0].hotListScore,
      record: result.candidates[0].rankRecordScore
    },
    { top: "10", hot: "20", record: "30" }
  );
});

test("multi-variant fixed country templates require the selected original display variant", async () => {
  const result = await createTikTokRankingTransport({
    requestExecutor: async () => {
      throw new Error("must not execute");
    },
    wait: async () => {}
  }).fetchOriginalCountryTemplateBundle({
    verifiedRoute: route({
      routeCountry: "MX",
      proxyExitCountry: "MX",
      collectionProxyExitCountry: "MX"
    }),
    marketRegion: "LATAM",
    countryCode: "MX"
  });

  assert.equal(result.status, "capability_not_ready");
  assert.equal(result.reason, "ranking_country_template_display_variant_required");
});

test("original score projection preserves unknowns and rejects unsafe or negative numeric scores", async () => {
  let calls = 0;
  const result = await createTikTokRankingTransport({
    requestExecutor: async (request) => {
      calls += 1;
      const rankType = new URL(request.url).searchParams.get("rank_type");
      if (rankType === "16") {
        return {
          status: 200,
          body: originalRankingBody({
            score: 9_007_199_254_740_992,
            label: null,
            countdown: -1
          })
        };
      }
      return { status: 200, body: originalTopBody("-1") };
    },
    wait: async () => {}
  }).fetchOriginalScores({
    seed,
    verifiedRoute: route(),
    marketRegion: "MENA",
    countryCode: "SA"
  });

  assert.equal(result.status, "ready");
  assert.equal(result.rankingScore, null);
  assert.equal(result.ranking, "未知");
  assert.equal(result.rankingTitleState, "original_unknown_sentinel");
  assert.equal(result.stageEvidence.ranking.titleMissing, true);
  assert.equal(result.stageEvidence.ranking.rankingTitleState, "original_unknown_sentinel");
  assert.equal(result.ranking, "未知");
  assert.equal(result.countdown, null);
  assert.equal(result.topScore, null);
  assert.equal(result.hotListScore, null);
  assert.equal(result.rankRecordScore, null);
  assert.equal(calls, 2);
});

test("original score chain uses one opaque lease and fails closed before network without authorization", async () => {
  const requests = [];
  let opened = 0;
  let closed = 0;
  const authorizationProvider = {
    async openLease() {
      opened += 1;
      return {
        async execute(request) {
          requests.push(request);
          const rankType = new URL(request.url).searchParams.get("rank_type");
          if (rankType === "16") return { status: 200, body: originalRankingBody({ score: "10" }) };
          return { status: 200, body: originalTopBody("20") };
        },
        async close() { closed += 1; }
      };
    }
  };
  const ready = await createTikTokRankingTransport({ authorizationProvider }).fetchOriginalScores({
    seed,
    verifiedRoute: route(),
    marketRegion: "MENA",
    countryCode: "SA"
  });
  assert.equal(ready.status, "ready");
  assert.equal(opened, 1);
  assert.equal(closed, 1);
  assert.equal(requests.length, 2);

  const unavailable = await createTikTokRankingTransport().fetchOriginalScores({
    seed,
    verifiedRoute: route(),
    marketRegion: "MENA",
    countryCode: "SA"
  });
  assert.equal(unavailable.status, "capability_not_ready");
  assert.equal(unavailable.reason, "ranking_mobile_authorization_required");
  assert.equal(unavailable.stage, "authorization");
  assert.equal(unavailable.attempts, 0);
  assert.doesNotMatch(JSON.stringify(unavailable), /https?:\/\/|127\.0\.0\.1/i);
});

test("original score chain accepts only the exact data.rank_view response contract", async () => {
  let calls = 0;
  const result = await createTikTokRankingTransport({
    requestExecutor: async () => {
      calls += 1;
      return {
        status: 200,
        body: JSON.stringify({
          status_code: 0,
          data: { rankView: { ownerRank: { score: "123" } } }
        })
      };
    },
    wait: async () => {}
  }).fetchOriginalScores({
    seed,
    verifiedRoute: route(),
    marketRegion: "MENA",
    countryCode: "SA"
  });
  assert.equal(result.status, "capability_not_ready");
  assert.equal(result.reason, "ranking_rank_view_missing");
  assert.equal(result.stage, "ranking");
  assert.equal(calls, 1);
});

test("ranking WorkID 4 safely adapts MobileSettings[0] fallback by ranking-scope country", async () => {
  const requests = [];
  const transport = createTikTokRankingTransport({
    requestExecutor: async (request) => {
      requests.push(request);
      return { status: 200, body: rankBody("main.node.creator", "7412345678901234568") };
    },
    wait: async () => {}
  });
  const result = await transport.fetchPair({
    seed: { ...seed, workId: 4, rankingScopeCountryCode: "QA" },
    verifiedRoute: exactRoute(),
    marketRegion: "MENA"
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
  assert.equal(requests.length, 2);
  assert.equal(requests.every(
    (request) => request.proxyServer === "http://127.0.0.1:17892"
  ), true);
  assert.equal(result.snapshots.every(
    (snapshot) => snapshot.sourceEvidence.workId === 4
      && snapshot.sourceEvidence.countryCode === "QA"
      && snapshot.sourceEvidence.collectionLaneEvidence.topology === "mobile_settings_country_lane_compatibility"
  ), true);
  assert.doesNotMatch(JSON.stringify(result), /127\.0\.0\.1|1789[02]/i);
});

test("ranking derives each country lane from seed WorkID and keeps both gap requests sticky", async () => {
  const requests = [];
  const transport = createTikTokRankingTransport({
    requestExecutor: async (request) => {
      requests.push(request);
      return { status: 200, body: rankBody("ranked.creator", "7412345678901234568") };
    },
    wait: async () => {}
  });

  for (const [workId, countryCode] of [[1, "SA"], [2, "QA"], [3, "EG"]]) {
    const start = requests.length;
    const result = await transport.fetchPair({
      seed: { ...seed, workId },
      verifiedRoute: exactRoute({ routeCountry: "US" }),
      marketRegion: "MENA",
      countryCode
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
    assert.equal(requests.slice(start).length, 2);
    assert.equal(requests.slice(start).every(
      (request) => request.proxyServer === `http://127.0.0.1:${17890 + workId}`
    ), true);
    assert.equal(result.snapshots.every(
      (snapshot) => snapshot.sourceEvidence.workId === workId
        && snapshot.sourceEvidence.collectionLaneEvidence.workId === workId
    ), true);
    assert.doesNotMatch(JSON.stringify(result), /127\.0\.0\.1|1789[1-3]/i);
  }
});

test("country ranking route rejects invalid WorkID, per-lane drift, and unsafe WorkID 4 fallback", async () => {
  let calls = 0;
  const transport = createTikTokRankingTransport({
    requestExecutor: async () => {
      calls += 1;
      return { status: 200, body: rankBody("never", "1") };
    }
  });
  const base = {
    seed,
    verifiedRoute: exactRoute(),
    marketRegion: "MENA",
    countryCode: "SA"
  };
  const cases = [
    [base, "ranking_work_id_invalid"],
    [{ ...base, workId: 5 }, "ranking_work_id_invalid"],
    [{ ...base, seed: { ...seed, workId: 1 }, workId: 2 }, "ranking_work_id_invalid"],
    [{
      ...base,
      seed: { ...seed, workId: 2 },
      countryCode: "QA",
      verifiedRoute: exactRoute({ collectionProxyExitCountries: ["SA", "US", "EG"] })
    }, "ranking_route_country_mismatch"],
    [{
      ...base,
      seed: { ...seed, workId: 1 },
      verifiedRoute: exactRoute({ collectionProxyExitCountries: ["SA"] })
    }, "ranking_lane_route_invalid"],
    [{
      ...base,
      seed: { ...seed, workId: 4 },
      countryCode: undefined
    }, "ranking_route_country_mismatch"],
    [{
      ...base,
      seed: { ...seed, workId: 4, rankingScopeCountryCode: "OM" },
      countryCode: undefined
    }, "ranking_route_country_mismatch"],
    [{
      ...base,
      seed: { ...seed, workId: 4, rankingScopeCountryCode: "QA" },
      countryCode: undefined,
      verifiedRoute: exactRoute({ collectionLanes: [
        { workId: 1, countryCode: "SA", proxyServer: "http://127.0.0.1:17891" },
        { workId: 2, countryCode: "QA", proxyServer: "http://remote.example:17892" },
        { workId: 3, countryCode: "EG", proxyServer: "http://127.0.0.1:17893" }
      ] })
    }, "ranking_proxy_not_allowed"],
    [{
      ...base,
      seed: { ...seed, workId: 4, rankingScopeCountryCode: "QA" },
      countryCode: "SA"
    }, "ranking_route_country_mismatch"],
    [{ ...base, seed: { ...seed, workId: 1 }, verifiedRoute: route() }, "ranking_lane_route_invalid"]
  ];
  for (const [input, reason] of cases) {
    assert.equal((await transport.fetchPair(input)).reason, reason);
  }
  assert.equal(calls, 0);
});

test("transport retries only network errors and 5xx using original initial plus three attempts", async () => {
  const waits = [];
  let calls = 0;
  const transport = createTikTokRankingTransport({
    requestExecutor: async (request) => {
      calls += 1;
      const gap = new URL(request.url).searchParams.get("gap_interval");
      if (gap === "0" && calls === 1) throw new Error("network secret should not escape");
      if (gap === "0" && calls < 4) return { status: 503, body: "temporary" };
      return { status: 200, body: rankBody(gap === "0" ? "current" : "previous", gap === "0" ? "1" : "2") };
    },
    wait: async (milliseconds) => { waits.push(milliseconds); }
  });
  const result = await transport.fetchPair({
    seed,
    verifiedRoute: route(),
    marketRegion: "MENA",
    countryCode: "SA"
  });
  assert.equal(result.status, "ready");
  assert.equal(calls, 5);
  assert.deepEqual(waits, [1_000, 2_000, 3_000]);
  assert.equal(result.snapshots[0].attempts, 4);
  assert.equal(result.snapshots[1].attempts, 1);
});

test("business auth rejection fails closed without retry or partial pair", async () => {
  let calls = 0;
  const transport = createTikTokRankingTransport({
    requestExecutor: async () => {
      calls += 1;
      return { status: 200, body: JSON.stringify({ status_code: 20003, status_msg: "User doesn't login" }) };
    },
    wait: async () => {}
  });
  const result = await transport.fetchPair({
    seed,
    verifiedRoute: route(),
    marketRegion: "MENA",
    countryCode: "SA"
  });
  assert.equal(result.status, "capability_not_ready");
  assert.equal(result.reason, "ranking_mobile_authorization_required");
  assert.equal(result.gapInterval, 0);
  assert.equal(result.attempts, 1);
  assert.equal(calls, 1);
  assert.equal(Object.hasOwn(result, "snapshots"), false);
  assert.doesNotMatch(JSON.stringify(result), /User doesn't login|https?:\/\//i);
});

test("opaque authorization provider opens one lease for both gaps and always closes it", async () => {
  const requests = [];
  let opened = 0;
  let closed = 0;
  const authorizationProvider = {
    async openLease(scope) {
      opened += 1;
      assert.deepEqual(scope, {
        marketRegion: "MENA",
        countryCode: "SA",
        endpointProfileId: "tkdesk-country-bundle-mena-v1",
        proxyServer: "http://127.0.0.1:17891"
      });
      return {
        async execute(request) {
          requests.push(request);
          const gap = new URL(request.url).searchParams.get("gap_interval");
          return { status: 200, body: rankBody(gap === "0" ? "current" : "previous", gap === "0" ? "1" : "2") };
        },
        async close() { closed += 1; }
      };
    }
  };
  const result = await createTikTokRankingTransport({ authorizationProvider }).fetchPair({
    seed,
    verifiedRoute: route(),
    marketRegion: "MENA",
    countryCode: "SA"
  });
  assert.equal(result.status, "ready");
  assert.equal(opened, 1);
  assert.equal(closed, 1);
  assert.equal(requests.length, 2);
  assert.equal(requests.every((request) => !Object.keys(request.headers).some(
    (header) => /cookie|token|authorization/i.test(header)
  )), true);
});

test("unavailable authorization provider fails before network without retry", async () => {
  let calls = 0;
  const error = new Error("fixture detail must not escape");
  error.name = "MobileRankingAuthorizationError";
  error.code = "ranking_mobile_authorization_required";
  const result = await createTikTokRankingTransport({
    authorizationProvider: {
      async openLease() {
        calls += 1;
        throw error;
      }
    },
    wait: async () => { throw new Error("must not retry"); }
  }).fetchPair({
    seed,
    verifiedRoute: route(),
    marketRegion: "MENA",
    countryCode: "SA"
  });
  assert.equal(result.reason, "ranking_mobile_authorization_required");
  assert.equal(result.attempts, 0);
  assert.equal(calls, 1);
  assert.doesNotMatch(JSON.stringify(result), /fixture detail/i);
});

test("typed authorization expiry during either gap is not retried and never returns a partial pair", async () => {
  let executions = 0;
  let closed = 0;
  const error = new Error("fixture authorization expired");
  error.name = "MobileRankingAuthorizationError";
  error.code = "ranking_mobile_authorization_required";
  const result = await createTikTokRankingTransport({
    authorizationProvider: {
      async openLease() {
        return {
          async execute(request) {
            executions += 1;
            const gap = new URL(request.url).searchParams.get("gap_interval");
            if (gap === "-1") throw error;
            return { status: 200, body: rankBody("current", "1") };
          },
          async close() { closed += 1; }
        };
      }
    },
    wait: async () => { throw new Error("must not retry"); }
  }).fetchPair({
    seed,
    verifiedRoute: route(),
    marketRegion: "MENA",
    countryCode: "SA"
  });
  assert.equal(result.reason, "ranking_mobile_authorization_required");
  assert.equal(result.gapInterval, -1);
  assert.equal(result.attempts, 1);
  assert.equal(executions, 2);
  assert.equal(closed, 1);
  assert.equal(Object.hasOwn(result, "snapshots"), false);
  assert.doesNotMatch(JSON.stringify(result), /fixture authorization expired/i);
});

test("safe typed provider transport errors retain bounded transient retries", async () => {
  let executions = 0;
  const waits = [];
  const transient = new Error("safe provider transport failure");
  transient.name = "MobileRankingAuthorizationError";
  transient.code = "ranking_mobile_authorization_transport_failed";
  const result = await createTikTokRankingTransport({
    authorizationProvider: {
      async openLease() {
        return {
          async execute() {
            executions += 1;
            if (executions < 4) throw transient;
            return { status: 200, body: rankBody(executions === 4 ? "current" : "previous", String(executions)) };
          },
          async close() {}
        };
      }
    },
    wait: async (milliseconds) => { waits.push(milliseconds); }
  }).fetchPair({
    seed,
    verifiedRoute: route(),
    marketRegion: "MENA",
    countryCode: "SA"
  });
  assert.equal(result.status, "ready");
  assert.equal(executions, 5);
  assert.deepEqual(waits, [1_000, 2_000, 3_000]);
});

test("nonzero business status wins over a stale rank_view shape", async () => {
  for (const statusCode of [10011, 20003, 98765]) {
    let calls = 0;
    const transport = createTikTokRankingTransport({
      requestExecutor: async () => {
        calls += 1;
        return {
          status: 200,
          body: JSON.stringify({
            status_code: statusCode,
            status_msg: "fixture secret detail",
            data: { rank_view: { ranks: [{ rank_user: { display_id: "must-not-pass", id_str: "1" } }] } }
          })
        };
      },
      wait: async () => {}
    });
    const result = await transport.fetchPair({
      seed,
      verifiedRoute: route(),
      marketRegion: "MENA",
      countryCode: "SA"
    });
    assert.equal(result.reason, statusCode === 98765
      ? "ranking_business_rejected"
      : "ranking_mobile_authorization_required");
    assert.equal(calls, 1);
    assert.equal(Object.hasOwn(result, "snapshots"), false);
    assert.doesNotMatch(JSON.stringify(result), /fixture secret detail|must-not-pass/i);
  }
});

test("route, country, seed, and proxy are fixed fail-closed boundaries", async () => {
  let calls = 0;
  const transport = createTikTokRankingTransport({
    requestExecutor: async () => {
      calls += 1;
      return { status: 200, body: rankBody("never", "1") };
    }
  });
  const cases = [
    [{ ...seed, anchorId: "abc" }, route(), "MENA", "SA", "ranking_seed_invalid"],
    [seed, route({ proxyExitCountry: "US" }), "MENA", "SA", "ranking_route_country_mismatch"],
    [seed, route({ collectionProxyServer: "http://user:pass@127.0.0.1:17891" }), "MENA", "SA", "ranking_proxy_not_allowed"],
    [seed, route({ collectionProxyServer: "http://remote.example:17891" }), "MENA", "SA", "ranking_proxy_not_allowed"],
    [seed, route(), "CCA", "SA", "ranking_country_profile_not_configured"],
    [seed, route({ routeCountry: "ZZ", proxyExitCountry: "ZZ" }), "MENA", "ZZ", "ranking_country_profile_not_configured"]
  ];
  for (const [candidateSeed, verifiedRoute, marketRegion, countryCode, reason] of cases) {
    const result = await transport.fetchPair({ candidateSeed, seed: candidateSeed, verifiedRoute, marketRegion, countryCode });
    assert.equal(result.reason, reason);
  }
  assert.equal(calls, 0);
});

test("missing opaque provider performs zero network requests", async () => {
  let contexts = 0;
  const requestContextFactory = {
    async newContext() {
      contexts += 1;
      throw new Error("must not open an unauthenticated context");
    }
  };
  const result = await createTikTokRankingTransport({ requestContextFactory }).fetchPair({
    seed,
    verifiedRoute: route(),
    marketRegion: "MENA",
    countryCode: "SA"
  });
  assert.equal(result.status, "capability_not_ready");
  assert.equal(result.reason, "ranking_mobile_authorization_required");
  assert.equal(result.attempts, 0);
  assert.equal(contexts, 0);
});

test("transport profile exposes semantics but not endpoint or proxy material", () => {
  assert.equal(TIKTOK_RANKING_TRANSPORT_PROFILE.supportedCountries.includes("SA"), true);
  assert.equal(TIKTOK_RANKING_TRANSPORT_PROFILE.supportedCountries.includes("GB"), true);
  assert.equal(TIKTOK_RANKING_TRANSPORT_PROFILE.supportedMarketRegions.length, 27);
  assert.equal(TIKTOK_RANKING_TRANSPORT_PROFILE.executableProfileCount, 147);
  assert.deepEqual(TIKTOK_RANKING_TRANSPORT_PROFILE.originalScoreTopCodes, [1, 2]);
  assert.deepEqual(TIKTOK_RANKING_TRANSPORT_PROFILE.gapIntervals, [0, -1]);
  assert.equal(TIKTOK_RANKING_TRANSPORT_PROFILE.maximumRetries, 3);
  assert.doesNotMatch(JSON.stringify(TIKTOK_RANKING_TRANSPORT_PROFILE), /https?:\/\/|127\.0\.0\.1/i);
});
