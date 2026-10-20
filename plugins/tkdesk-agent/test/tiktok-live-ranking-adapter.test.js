import assert from "node:assert/strict";
import test from "node:test";
import {
  TikTokLiveRankingError,
  captureTikTokRoomSeedFromPage,
  captureTikTokRankingSnapshotFromPage,
  collectTikTokLiveRanking,
  isAllowedTikTokRankingSourceUrl,
  isAllowedTikTokRoomSeedSourceUrl,
  mergeTikTokRankingPair,
  normalizeTikTokRankingSnapshot,
  projectTikTokRoomSeed,
  redactTikTokRankingText,
  redactTikTokRankingValue
} from "../mcp/adapters/tiktok-live-ranking.js";

const SOURCE_URL = "https://webcast16-normal-useast8.tiktokv.us/webcast/ranklist/list/v2/?rank_type=16&region_type=1&gap_interval=0&aid=1988&signature=SIGNED_SECRET";
const OBSERVED_AT = "2026-08-23T03:04:05.000Z";

function snapshot(ranks, overrides = {}) {
  return {
    sourceUrl: SOURCE_URL,
    payload: {
      data: {
        rank_view: {
          ranks,
          countdown: 321,
          ...overrides.rankView
        }
      }
    },
    sourceEvidence: {
      marketRegion: "MENA",
      rankScoreType: "leaderboard_score",
      period: "daily",
      subtab: "gift",
      observedAt: OBSERVED_AT,
      ...overrides.sourceEvidence
    },
    ...overrides.envelope
  };
}

test("ranking source allowlist accepts only exact official HTTPS ranklist endpoints", () => {
  assert.equal(isAllowedTikTokRankingSourceUrl(SOURCE_URL), true);
  assert.equal(isAllowedTikTokRankingSourceUrl("https://webcast.tiktok.com/webcast/ranklist/list/v2/?aid=1988"), true);
  assert.equal(isAllowedTikTokRankingSourceUrl("https://webcast-va.tiktok.com/webcast/ranklist/list/v2/?aid=1988"), true);
  assert.equal(isAllowedTikTokRankingSourceUrl("https://webcast16-normal-useast8.tiktokv.us/webcast/ranklist/list/v2/?rank_type=8"), true);
  assert.equal(isAllowedTikTokRankingSourceUrl("https://webcast16-normal-no1a.tiktokv.eu/webcast/ranklist/list/v2/?rank_type=8"), true);
  assert.equal(isAllowedTikTokRankingSourceUrl("https://www.tiktok.com/api-live/ranklist/list/v2/?aid=1988"), true);
  assert.equal(isAllowedTikTokRankingSourceUrl("https://www.tiktok.com/api/live/ranklist/list/v2/?aid=1988"), true);
  assert.equal(isAllowedTikTokRankingSourceUrl("https://webcast.us.tiktok.com/webcast/ranklist/online_audience/?aid=1988"), false);

  for (const value of [
    "http://webcast.us.tiktok.com/webcast/ranklist/room/",
    "https://webcast.us.tiktok.com.evil.example/webcast/ranklist/room/",
    "https://evil-webcast.tiktok.com/webcast/ranklist/room/",
    "https://evil.tiktokv.us/webcast/ranklist/list/v2/",
    "https://webcast16-normal-useast8.tiktokv.us/webcast/ranklist/other/",
    "https://webcast.us.tiktok.com:8443/webcast/ranklist/room/",
    "https://user:password@webcast.us.tiktok.com/webcast/ranklist/room/",
    "https://webcast.us.tiktok.com/webcast/ranklist/room/",
    "https://webcast.us.tiktok.com/webcast/user/",
    "https://www.tiktok.com/live",
    "https://webcast.us.tiktok.com/webcast/ranklist/room/#token=secret",
    "javascript:alert(1)",
    "not a url"
  ]) {
    assert.equal(isAllowedTikTokRankingSourceUrl(value), false, value);
  }
});

test("normalizes rank_view rows in leaderboard order and preserves raw score evidence", () => {
  const result = normalizeTikTokRankingSnapshot(snapshot([
    {
      score: "00042",
      room_id_str: "room-1",
      rank_user: {
        display_id: "Alice.Live",
        id_str: "900719925474099312345",
        nickname: "Alice",
        country_code: "SA",
        follower_count: "999999",
        has_commerce_goods: true
      }
    },
    {
      score: 999_999,
      room_id_str: "room-2",
      rank_user: { display_id: "bob", id_str: "2", country_code: "SA" }
    },
    {
      score: 800_000,
      room_id_str: "room-3",
      rank_user: { display_id: "carol", id_str: "3", country_code: "SA" }
    }
  ]), { marketRegion: "MENA", countryCode: "SA", limit: 2, observedAt: "2000-01-01T00:00:00Z" });

  assert.equal(result.status, "ready");
  assert.equal(result.totalRanks, 3);
  assert.deepEqual(result.candidates.map((candidate) => candidate.handle), ["Alice.Live", "bob"]);
  assert.deepEqual(result.candidates.map((candidate) => candidate.rank), [1, 2]);
  assert.equal(result.candidates[0].rankScoreRaw, "00042");
  assert.equal(result.candidates[0].followerCount, 999_999);
  assert.equal(result.candidates[0].seller, true);
  assert.equal(result.candidates[1].seller, null);
  assert.equal(result.candidates[1].rankScoreRaw, 999_999);
  assert.equal(result.candidates[0].rankScoreType, "leaderboard_score");
  assert.equal(result.candidates[0].period, "daily");
  assert.equal(result.candidates[0].subtab, "gift");
  assert.equal(result.candidates[0].countdown, 321);
  assert.equal(result.candidates[0].observedAt, OBSERVED_AT);
  assert.equal(result.candidates[0].source, "tiktok_live_regional_gift_ranking");
  assert.deepEqual(result.candidates[0].rankEvidence, {
    scoreRaw: "00042",
    scoreType: "leaderboard_score",
    period: "daily",
    subtab: "gift",
    countdown: 321,
    rankTypeCode: 16,
    regionTypeCode: 1,
    gapInterval: 0,
    rankingViewKind: "top",
    adapterEvidenceVersion: "regional-ranking-request-semantics-v2",
    source: "tiktok_rank_view",
    observedAt: OBSERVED_AT
  });
  assert.equal(Object.hasOwn(result.candidates[0], "diamondValue"), false);
  assert.doesNotMatch(JSON.stringify(result), /SIGNED_SECRET|sourceUrl|signature|[?#]/i);
});

test("selected market and country are provider inputs and hard evidence filters, not copied tags", async () => {
  let providerRequest;
  const result = await collectTikTokLiveRanking({
    marketRegion: "mena",
    collectionCountry: "sa",
    period: "daily",
    subtab: "gift",
    limit: 10,
    observedAt: OBSERVED_AT,
    provider: {
      async fetchRankSnapshot(request) {
        providerRequest = request;
        return snapshot([
          { score: 90, rank_user: { display_id: "sa_creator", id_str: "1", country_code: "SA" } },
          { score: 1_000, rank_user: { display_id: "ae_creator", id_str: "2", country_code: "AE" } },
          { score: 800, rank_user: { display_id: "unknown_country", id_str: "3" } }
        ]);
      }
    }
  });

  assert.deepEqual(providerRequest, {
    marketRegion: "MENA",
    countryCode: "SA",
    period: "daily",
    subtab: "gift",
    rankingViewKind: null,
    limit: 10
  });
  assert.equal(Object.isFrozen(providerRequest), true);
  assert.deepEqual(result.candidates.map((candidate) => candidate.handle), ["sa_creator"]);
  assert.equal(result.excludedByGeography, 2);
  assert.equal(result.candidates[0].countryCode, "SA");
  assert.equal(result.candidates[0].creatorCountry, "SA");
  assert.equal(result.candidates[0].marketRegion, null);
  assert.equal(result.candidates[0].rankingScopeMarketRegion, "MENA");
});

test("unknown fields stay unknown and score type never defaults to diamonds", () => {
  const value = normalizeTikTokRankingSnapshot({
    sourceUrl: SOURCE_URL,
    payload: {
      data: {
        rank_view: {
          ranks: [{ rank_user: { id_str: "42" } }]
        }
      }
    }
  }, { observedAt: OBSERVED_AT });

  const candidate = value.candidates[0];
  assert.equal(candidate.handle, null);
  assert.equal(candidate.roomId, null);
  assert.equal(candidate.followerCount, null);
  assert.equal(candidate.seller, null);
  assert.equal(candidate.rank, 1);
  assert.equal(candidate.rankScoreRaw, null);
  assert.equal(candidate.rankScoreType, "unknown");
  assert.equal(candidate.period, null);
  assert.equal(candidate.subtab, null);
  assert.equal(candidate.countdown, null);
  assert.equal(candidate.marketRegion, null);
  assert.equal(candidate.countryCode, null);
  assert.equal(candidate.creatorCountry, null);
  assert.equal(candidate.rankingScopeCountryCode, null);
  assert.equal(candidate.rankTypeCode, 16);
  assert.equal(candidate.regionTypeCode, 1);
  assert.equal(candidate.gapInterval, 0);
  assert.equal(candidate.rankingViewKind, "top");
  assert.equal(candidate.rankEvidence.adapterEvidenceVersion, "regional-ranking-request-semantics-v2");
  assert.equal(candidate.observedAt, OBSERVED_AT);
  assert.equal(Object.hasOwn(candidate, "diamonds"), false);
});

test("row evidence overrides snapshot evidence and explicit ordinal rank survives filtering", () => {
  const value = normalizeTikTokRankingSnapshot(snapshot([
    {
      rank: "7",
      score: "12",
      market_region: "CCA",
      rank_user: { display_id: "one", id_str: "1", country_code: "KZ" }
    },
    {
      rank: 8,
      score: "11",
      market_region: "MENA",
      rank_user: { display_id: "two", id_str: "2", country_code: "SA" }
    }
  ], { sourceEvidence: { countryCode: "SA" } }), {
    marketRegion: "MENA",
    countryCode: "SA",
    observedAt: OBSERVED_AT
  });

  assert.equal(value.excludedByGeography, 1);
  assert.equal(value.candidates.length, 1);
  assert.equal(value.candidates[0].handle, "two");
  assert.equal(value.candidates[0].rank, 8);
});

test("missing provider, source, or rank_view fails closed with no candidate fallback", async () => {
  assert.deepEqual(await collectTikTokLiveRanking(), {
    status: "capability_not_ready",
    capability: "regional_gift_ranking",
    source: "tiktok_live_regional_gift_ranking",
    reason: "rank_snapshot_provider_missing",
    candidates: []
  });

  const missingSource = await collectTikTokLiveRanking({
    provider: async () => ({ payload: { data: { rank_view: { ranks: [] } } } })
  });
  assert.equal(missingSource.status, "capability_not_ready");
  assert.equal(missingSource.reason, "rank_source_missing");

  const lookalike = normalizeTikTokRankingSnapshot({
    sourceUrl: "https://webcast.us.tiktok.com.evil.example/webcast/ranklist/room/?token=LEAK",
    payload: { data: { rank_view: { ranks: [] } } }
  });
  assert.equal(lookalike.reason, "rank_source_not_allowed");
  assert.doesNotMatch(JSON.stringify(lookalike), /LEAK|evil\.example|sourceUrl/i);

  const visibleLiveCards = normalizeTikTokRankingSnapshot({
    sourceUrl: SOURCE_URL,
    payload: {
      items: [{ href: "https://www.tiktok.com/@alice/live", text: "LIVE · 12 viewers" }],
      candidates: [{ handle: "alice", score: 10_000_000 }]
    }
  });
  assert.equal(visibleLiveCards.reason, "rank_view_missing");
  assert.deepEqual(visibleLiveCards.candidates, []);

  const notObserved = await collectTikTokLiveRanking({
    provider: async () => ({
      status: "capability_not_ready",
      reason: "rank_snapshot_not_observed",
      candidates: []
    })
  });
  assert.equal(notObserved.status, "capability_not_ready");
  assert.equal(notObserved.reason, "rank_snapshot_not_observed");
});

test("provider failures expose sanitized errors without URLs, tokens, cookies, or email", async () => {
  await assert.rejects(
    collectTikTokLiveRanking({
      provider: async () => {
        const error = new Error(
          "GET https://webcast.us.tiktok.com/webcast/ranklist/room/SIGNED_PATH?signature=QUERY_SECRET "
          + "Authorization: Bearer BEARER_SECRET email=owner@example.com"
        );
        error.code = "token=CODE_SECRET";
        error.details = {
          sourceUrl: "https://webcast.us.tiktok.com/webcast/ranklist/room/?cookie=COOKIE_SECRET",
          password: "PASSWORD_SECRET",
          nested: "refresh_token=NESTED_SECRET"
        };
        throw error;
      }
    }),
    (error) => {
      assert.equal(error instanceof TikTokLiveRankingError, true);
      assert.equal(error.code, "TIKTOK_RANKING_PROVIDER_ERROR");
      assert.match(error.message, /\[REDACTED_URL\]/);
      const exposed = JSON.stringify({
        message: error.message,
        code: error.code,
        details: error.details,
        stack: error.stack
      });
      assert.doesNotMatch(
        exposed,
        /SIGNED_PATH|QUERY_SECRET|BEARER_SECRET|owner@example\.com|CODE_SECRET|COOKIE_SECRET|PASSWORD_SECRET|NESTED_SECRET|webcast\.us\.tiktok\.com|[?#]/i
      );
      return true;
    }
  );
});

test("generic redactors remove nested URL and credential values", () => {
  const redacted = redactTikTokRankingValue({
    message: "failed at https://www.tiktok.com/path?token=SECRET",
    callbackUrl: "https://www.tiktok.com/callback?code=CALLBACK_SECRET",
    accessToken: "TOKEN_SECRET",
    values: ["Bearer ARRAY_SECRET", { email: "owner@example.com" }]
  });
  assert.equal(redacted.callbackUrl, "[REDACTED_URL]");
  assert.equal(redacted.accessToken, "[REDACTED]");
  const exposed = JSON.stringify(redacted);
  assert.doesNotMatch(exposed, /SECRET|owner@example\.com|https?:\/\//i);
  assert.equal(redactTikTokRankingText("ordinary ranking failure"), "ordinary ranking failure");
});

test("room seed capture accepts only official room/feed responses and projects no session material", async () => {
  assert.equal(
    isAllowedTikTokRoomSeedSourceUrl("https://webcast.tiktok.com/webcast/room/enter/?signature=SECRET"),
    true
  );
  assert.equal(isAllowedTikTokRoomSeedSourceUrl("https://webcast.tiktok.com/webcast/feed/?aid=1988"), true);
  assert.equal(isAllowedTikTokRoomSeedSourceUrl("https://webcast-va.tiktok.com/webcast/room/enter/"), false);
  assert.equal(isAllowedTikTokRoomSeedSourceUrl("https://webcast.tiktok.com.evil.example/webcast/room/enter/"), false);
  assert.equal(isAllowedTikTokRoomSeedSourceUrl("https://webcast.tiktok.com/webcast/room/enter/other"), false);

  const payload = {
    data: {
      id_str: "7498765432109876543",
      user_count: 321,
      owner: {
        id_str: "7412345678901234567",
        display_id: "seed.creator",
        sec_uid: "MS4wLjABAAAA_seed_creator",
        region: "US",
        follow_info: { follower_count: 4567 },
        avatar_thumb: { url_list: ["https://image.example/?token=AVATAR_SECRET"] },
        email: "owner@example.com"
      }
    },
    extra: { token: "RAW_SECRET" }
  };
  assert.deepEqual(projectTikTokRoomSeed(payload), {
    roomId: "7498765432109876543",
    anchorId: "7412345678901234567",
    handle: "seed.creator",
    secUid: "MS4wLjABAAAA_seed_creator",
    followerCount: 4567,
    viewerCount: 321,
    creatorCountryCode: "US"
  });

  const listeners = new Set();
  const navigations = [];
  const page = {
    on(event, listener) { if (event === "response") listeners.add(listener); },
    off(event, listener) { if (event === "response") listeners.delete(listener); },
    async goto(url) {
      navigations.push(url);
      if (url.endsWith("/@seed.creator/live")) {
        await Promise.all([...listeners].map((listener) => listener({
          url: () => "https://webcast.tiktok.com/webcast/room/enter/?signature=ROOM_SECRET",
          status: () => 200,
          json: async () => payload
        })));
      }
    },
    waitForTimeout: async () => {},
    locator() {
      return {
        count: async () => 1,
        nth: () => ({ getAttribute: async () => "/@seed.creator/live" })
      };
    }
  };
  const captured = await captureTikTokRoomSeedFromPage({
    page,
    responseWaitMs: 50,
    observedAt: OBSERVED_AT
  });
  assert.deepEqual(navigations, ["https://www.tiktok.com/live", "https://www.tiktok.com/@seed.creator/live"]);
  assert.equal(captured.status, "ready");
  assert.equal(captured.anchorId, "7412345678901234567");
  assert.equal(captured.roomId, "7498765432109876543");
  assert.equal(captured.observedAt, OBSERVED_AT);
  assert.doesNotMatch(JSON.stringify(captured), /ROOM_SECRET|RAW_SECRET|AVATAR_SECRET|owner@example\.com|https?:\/\//i);
});

test("current and previous original rankings merge in current-first order with per-gap observations", () => {
  const make = (gapInterval, ranks) => normalizeTikTokRankingSnapshot({
    sourceUrl: `https://webcast16-normal-useast8.tiktokv.us/webcast/ranklist/list/v2/?rank_type=16&region_type=1&gap_interval=${gapInterval}`,
    payload: { data: { rank_view: { ranks } } },
    sourceEvidence: {
      marketRegion: "MENA",
      countryCode: "SA",
      countryScopeEvidence: "verified_collection_proxy_exit_and_original_top_url",
      observedAt: OBSERVED_AT
    }
  }, { marketRegion: "MENA", countryCode: "SA", limit: 100 });
  const current = make(0, [
    { score: "300", room_id_str: "room-a", rank_user: { display_id: "alpha", id_str: "101" } },
    { score: "200", room_id_str: "room-b", rank_user: { display_id: "beta", sec_uid: "sec_beta_123" } }
  ]);
  const previous = make(-1, [
    { score: "900", room_id_str: "room-a-old", rank_user: { display_id: "alpha.old", id_str: "101" } },
    { score: "800", room_id_str: "room-c", rank_user: { display_id: "gamma", id_str: "303" } }
  ]);
  const merged = mergeTikTokRankingPair([previous, current], { limit: 10 });
  assert.equal(merged.status, "ready");
  assert.deepEqual(merged.gapIntervals, [0, -1]);
  assert.deepEqual(merged.candidates.map((candidate) => candidate.handle), ["alpha", "beta", "gamma"]);
  assert.deepEqual(merged.candidates[0].rankingObservations.map((item) => item.gapInterval), [0, -1]);
  assert.equal(merged.candidates[0].rankScoreRaw, "300");
  assert.equal(merged.candidates[0].handle, "alpha");
  assert.equal(merged.totalRanksByGap["0"], 2);
  assert.equal(merged.totalRanksByGap["-1"], 2);
  assert.equal(merged.rankingPairComplete, true);
});

test("Playwright capture passively accepts only qualified rank responses and returns no raw query", async () => {
  const listeners = new Set();
  const navigations = [];
  const response = (url, payload) => ({ url: () => url, json: async () => payload });
  const emit = async (value) => {
    await Promise.all([...listeners].map((listener) => listener(value)));
  };
  const page = {
    on(event, listener) { if (event === "response") listeners.add(listener); },
    off(event, listener) { if (event === "response") listeners.delete(listener); },
    async goto(url) {
      navigations.push(url);
      if (url.endsWith("/@alice/live")) {
        await emit(response(
          "https://webcast.us.tiktok.com/webcast/ranklist/online_audience/?rank_type=16&region_type=1&gap_interval=0&token=AUDIENCE_SECRET",
          { data: { rank_view: { ranks: [{ score: 999, rank_user: { display_id: "audience" } }] } } }
        ));
        await emit(response(
          "https://webcast.us.tiktok.com/webcast/ranklist/list/v2/?rank_type=16&region_type=1&token=MISSING_GAP_SECRET",
          { data: { rank_view: { ranks: [{ score: 888, rank_user: { display_id: "missing_gap" } }] } } }
        ));
        await emit(response(
          "https://webcast16-normal-useast8.tiktokv.us/webcast/ranklist/list/v2/?rank_type=16&region_type=1&gap_interval=0&signature=CAPTURE_SECRET",
          {
            data: {
              rank_view: {
                ranks: [{
                  score: "123",
                  room_id_str: "room-1",
                  rank_user: {
                    display_id: "winner",
                    id_str: "1",
                    country_code: "SA",
                    avatar_thumb: { url_list: ["https://image.example/avatar?token=AVATAR_SECRET"] }
                  }
                }]
              }
            },
            extra: { logid: "SHOULD_NOT_SURVIVE" }
          }
        ));
      }
    },
    waitForTimeout: async () => {},
    locator() {
      return {
        count: async () => 1,
        nth: () => ({ getAttribute: async () => "/@alice/live" })
      };
    }
  };

  const captured = await captureTikTokRankingSnapshotFromPage({
    page,
    responseWaitMs: 50,
    requestedCountryCode: "SA",
    observedAt: OBSERVED_AT,
    sourceEvidence: {
      marketRegion: "MENA",
      countryCode: "SA",
      rankScoreType: "leaderboard_score",
      period: "daily",
      subtab: "gift"
    }
  });
  assert.deepEqual(navigations, ["https://www.tiktok.com/live", "https://www.tiktok.com/@alice/live"]);
  assert.equal(captured.sourceUrl, "https://webcast16-normal-useast8.tiktokv.us/webcast/ranklist/list/v2/");
  assert.equal(captured.sourceEvidence.countryCode, null);
  assert.equal(captured.sourceEvidence.countryScopeEvidence, null);
  assert.equal(captured.sourceEvidence.rankTypeCode, 16);
  assert.equal(captured.sourceEvidence.regionTypeCode, 1);
  assert.equal(captured.sourceEvidence.gapInterval, 0);
  assert.equal(captured.sourceEvidence.rankingViewKind, "top");
  assert.equal(captured.payload.data.rank_view.ranks[0].rank_user.display_id, "winner");
  const exposed = JSON.stringify(captured);
  assert.doesNotMatch(
    exposed,
    /CAPTURE_SECRET|AUDIENCE_SECRET|MISSING_GAP_SECRET|AVATAR_SECRET|SHOULD_NOT_SURVIVE|rank_type|region_type|gap_interval|signature|[?#]/i
  );

  const normalized = normalizeTikTokRankingSnapshot(captured, {
    marketRegion: "MENA",
    countryCode: "SA",
    observedAt: OBSERVED_AT
  });
  assert.equal(normalized.status, "ready");
  assert.equal(normalized.candidates[0].handle, "winner");
  assert.equal(normalized.candidates[0].rankScoreRaw, "123");
  assert.equal(normalized.rankingScopeCountryCode, null);
  assert.equal(normalized.rankingScopeCountryEvidence, null);
  assert.equal(normalized.rankingViewKind, "top");
});

test("rejects unknown request semantics and accepts the original rank_type 16 list", () => {
  const unsupported = normalizeTikTokRankingSnapshot({
    ...snapshot([]),
    sourceUrl: "https://webcast16-normal-useast8.tiktokv.us/webcast/ranklist/list/v2/?rank_type=99&region_type=1&gap_interval=0"
  });
  assert.equal(unsupported.status, "capability_not_ready");
  assert.equal(unsupported.reason, "ranking_view_not_supported");

  const unprovenTopCode = normalizeTikTokRankingSnapshot({
    ...snapshot([]),
    sourceUrl: "https://webcast16-normal-useast8.tiktokv.us/webcast/ranklist/list/v2/?rank_type=1&region_type=1&gap_interval=0"
  });
  assert.equal(unprovenTopCode.status, "capability_not_ready");
  assert.equal(unprovenTopCode.reason, "ranking_view_not_supported");

  const creatorRanking = normalizeTikTokRankingSnapshot({
    ...snapshot([{ score: 10, rank_user: { display_id: "one", id_str: "1" } }]),
    sourceUrl: "https://webcast16-normal-useast8.tiktokv.us/webcast/ranklist/list/v2/?rank_type=16&region_type=1&gap_interval=0"
  });
  assert.equal(creatorRanking.status, "ready");
  assert.equal(creatorRanking.rankingViewKind, "top");

  const unsupportedRegionType = normalizeTikTokRankingSnapshot({
    ...snapshot([]),
    sourceUrl: "https://webcast16-normal-useast8.tiktokv.us/webcast/ranklist/list/v2/?rank_type=16&region_type=2&gap_interval=0"
  });
  assert.equal(unsupportedRegionType.status, "capability_not_ready");
  assert.equal(unsupportedRegionType.reason, "ranking_region_type_not_supported");

  const unsupportedGap = normalizeTikTokRankingSnapshot({
    ...snapshot([]),
    sourceUrl: "https://webcast16-normal-useast8.tiktokv.us/webcast/ranklist/list/v2/?rank_type=16&region_type=1&gap_interval=1"
  });
  assert.equal(unsupportedGap.status, "capability_not_ready");
  assert.equal(unsupportedGap.reason, "ranking_view_not_supported");
});

test("classifies only the original list-producing request combinations", () => {
  for (const [rankTypeCode, gapInterval, rankingViewKind] of [
    [16, 0, "top"],
    [16, -1, "top"]
  ]) {
    const value = normalizeTikTokRankingSnapshot({
      ...snapshot([{ score: 1, rank_user: { display_id: "one", id_str: "1" } }]),
      sourceUrl: `https://webcast16-normal-useast8.tiktokv.us/webcast/ranklist/list/v2/?rank_type=${rankTypeCode}&region_type=1&gap_interval=${gapInterval}`
    });
    assert.equal(value.status, "ready");
    assert.equal(value.rankTypeCode, rankTypeCode);
    assert.equal(value.regionTypeCode, 1);
    assert.equal(value.gapInterval, gapInterval);
    assert.equal(value.rankingViewKind, rankingViewKind);
    assert.equal(value.listProducing, true);
  }
});

test("requires complete parser-authored request evidence and rejects metadata mismatches", () => {
  const canonicalSource = "https://webcast16-normal-useast8.tiktokv.us/webcast/ranklist/list/v2/";
  const missing = normalizeTikTokRankingSnapshot({
    ...snapshot([]),
    sourceUrl: canonicalSource
  });
  assert.equal(missing.reason, "ranking_query_not_observed");

  const parserEvidence = normalizeTikTokRankingSnapshot({
    ...snapshot([{ score: 1, rank_user: { display_id: "one", id_str: "1" } }], {
      sourceEvidence: {
        rankTypeCode: 16,
        regionTypeCode: 1,
        gapInterval: 0,
        rankingViewKind: "top"
      }
    }),
    sourceUrl: canonicalSource
  });
  assert.equal(parserEvidence.status, "ready");
  assert.equal(parserEvidence.rankingViewKind, "top");

  const mismatch = normalizeTikTokRankingSnapshot(snapshot([], {
    sourceEvidence: {
      rankTypeCode: 16,
      regionTypeCode: 1,
      gapInterval: -1,
      rankingViewKind: "top"
    }
  }));
  assert.equal(mismatch.reason, "ranking_query_evidence_mismatch");

  const duplicate = normalizeTikTokRankingSnapshot({
    ...snapshot([]),
    sourceUrl: "https://webcast16-normal-useast8.tiktokv.us/webcast/ranklist/list/v2/?rank_type=16&rank_type=15&region_type=1&gap_interval=0"
  });
  assert.equal(duplicate.reason, "ranking_query_incomplete");
});

test("capture waits for the requested list view instead of taking the first ranking response", async () => {
  const listeners = new Set();
  const emit = (url, handle) => Promise.all([...listeners].map((listener) => listener({
    url: () => url,
    json: async () => ({
      data: { rank_view: { ranks: [{ score: 10, rank_user: { display_id: handle, id_str: handle } }] } }
    })
  })));
  const page = {
    on(event, listener) { if (event === "response") listeners.add(listener); },
    off(event, listener) { if (event === "response") listeners.delete(listener); },
    async goto() {
      await emit(
        "https://webcast16-normal-useast8.tiktokv.us/webcast/ranklist/list/v2/?rank_type=15&region_type=1&gap_interval=0",
        "hot"
      );
      await emit(
        "https://webcast16-normal-useast8.tiktokv.us/webcast/ranklist/list/v2/?rank_type=16&region_type=1&gap_interval=0",
        "top"
      );
    },
    waitForTimeout: async () => {},
    locator: () => ({ count: async () => 0 })
  };
  const captured = await captureTikTokRankingSnapshotFromPage({
    page,
    responseWaitMs: 50,
    requestedRankingViewKind: "top"
  });
  assert.equal(captured.sourceEvidence.rankingViewKind, "top");
  assert.equal(captured.payload.data.rank_view.ranks[0].rank_user.display_id, "top");
});

test("requested period and subtab must be proven by the observed ranking response", async () => {
  const periodMismatch = await collectTikTokLiveRanking({
    marketRegion: "MENA",
    countryCode: "SA",
    period: "weekly",
    provider: async () => snapshot([], { sourceEvidence: { countryCode: "SA", period: "daily" } })
  });
  assert.equal(periodMismatch.status, "capability_not_ready");
  assert.equal(periodMismatch.reason, "ranking_period_mismatch");

  const subtabUnknown = await collectTikTokLiveRanking({
    marketRegion: "MENA",
    countryCode: "SA",
    subtab: "gift",
    provider: async () => snapshot([], { sourceEvidence: { countryCode: "SA", subtab: null } })
  });
  assert.equal(subtabUnknown.status, "capability_not_ready");
  assert.equal(subtabUnknown.reason, "ranking_subtab_not_observed");
});

test("ranking scope country can filter a list but never fabricates creator country", () => {
  const value = normalizeTikTokRankingSnapshot(snapshot([
    { score: "100", rank_user: { display_id: "scope_only", id_str: "1" } }
  ], { sourceEvidence: { countryCode: "SA" } }), {
    marketRegion: "MENA",
    countryCode: "SA",
    observedAt: OBSERVED_AT
  });

  assert.equal(value.candidates.length, 1);
  assert.equal(value.rankingScopeCountryCode, "SA");
  assert.equal(value.candidates[0].rankingScopeCountryCode, "SA");
  assert.equal(value.candidates[0].countryCode, null);
  assert.equal(value.candidates[0].creatorCountry, null);
});

test("Playwright capture does not treat online audience or incomplete requests as ranking", async () => {
  const listeners = new Set();
  const page = {
    on(event, listener) { if (event === "response") listeners.add(listener); },
    off(event, listener) { if (event === "response") listeners.delete(listener); },
    async goto() {
      const emit = (url) => Promise.all([...listeners].map((listener) => listener({
        url: () => url,
        json: async () => ({ data: { rank_view: { ranks: [{ score: 1, rank_user: { display_id: "wrong" } }] } } })
      })));
      await emit("https://webcast.us.tiktok.com/webcast/ranklist/online_audience/?rank_type=1&region_type=1&gap_interval=0");
      await emit("https://webcast.us.tiktok.com/webcast/ranklist/list/v2/?rank_type=1&region_type=1");
    },
    waitForTimeout: async () => {},
    locator: () => ({ count: async () => 0 })
  };
  const result = await captureTikTokRankingSnapshotFromPage({ page, responseWaitMs: 50 });
  assert.equal(result.status, "capability_not_ready");
  assert.equal(result.reason, "ranking_query_incomplete");
  assert.deepEqual(result.candidates, []);
});
