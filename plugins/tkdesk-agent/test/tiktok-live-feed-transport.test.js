import assert from "node:assert/strict";
import test from "node:test";
import {
  TIKTOK_LIVE_FEED_PROFILE,
  createTikTokLiveFeedTransport
} from "../mcp/core/tiktok-live-feed-transport.js";

test("non-JSON Feed diagnostics describe empty or HTML bodies without exposing content", async () => {
  for (const body of ["", "<html>SECRET_TOKEN_VALUE@example.com</html>"]) {
    const transport = createTikTokLiveFeedTransport({ requestExecutor: async request => ({
      status: 200, url: request.url, body, contentType: "text/html; token=SECRET_TOKEN_VALUE", elapsedMs: 42
    }) });
    const result = await transport.fetchOnce({ verifiedRoute: route(), marketRegion: "MENA", countryCode: "SA" });
    assert.equal(result.reason, "feed_response_not_json");
    assert.ok(result.diagnostics, "safe HTTP diagnostics are missing");
    assert.equal(result.diagnostics.httpStatus, 200);
    assert.equal(result.diagnostics.contentType, "text/html");
    assert.equal(result.diagnostics.bodyBytes, Buffer.byteLength(body));
    assert.equal(result.diagnostics.bodyKind, body ? "html" : "empty");
    assert.equal(result.diagnostics.elapsedMs, 42);
    assert.doesNotMatch(JSON.stringify(result), /SECRET_TOKEN_VALUE|example.com|<html>/);
  }
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
    collectionLanes: [
      { workId: 1, countryCode: "SA", proxyServer: "http://127.0.0.1:17891" },
      { workId: 2, countryCode: "QA", proxyServer: "http://127.0.0.1:17892" },
      { workId: 3, countryCode: "EG", proxyServer: "http://127.0.0.1:17893" }
    ],
    collectionProxyExitCountries: ["SA", "QA", "EG"],
    ...overrides
  };
}

function payload() {
  return {
    status_code: 0,
    data: [
      {
        type: 1,
        data: {
          id_str: "7498765432109876543",
          user_count: 321,
          has_commerce_goods: true,
          hashtag: { id: "998877" },
          owner: {
            id_str: "7412345678901234567",
            display_id: "seed.creator",
            nickname: "Seed Creator",
            sec_uid: "MS4wLjABAAAA_seed_creator",
            region: "SA",
            follow_info: { follower_count: 4567 },
            avatar_thumb: { url_list: ["https://image.example/?token=DO_NOT_KEEP"] },
            email: "owner@example.com"
          },
          stream_url: { rtmp_pull_url: "https://stream.example/?signature=DO_NOT_KEEP" }
        }
      }
    ],
    extra: { logid: "DO_NOT_KEEP" }
  };
}

function payloadForCountry(countryCode) {
  const value = payload();
  value.data[0].data.owner.region = countryCode;
  return value;
}

const authenticatedDiscoverySession = Object.freeze({
  state: "authenticated",
  authenticated: true
});

function executor({ status = 200, body = JSON.stringify(payload()), finalUrl = null, error = null } = {}) {
  const requests = [];
  return {
    requests,
    async execute(request) {
      requests.push(request);
      if (error) throw error;
      return {
        status,
        url: finalUrl ?? request.url,
        body
      };
    }
  };
}

function countryWorkerLauncher() {
  const launches = [];
  const browsers = [];
  return {
    launches,
    browsers,
    async launch(options) {
      launches.push(options);
      const browser = {
        closed: false,
        async newPage(pageOptions) {
          return {
            pageOptions,
            async goto(url, gotoOptions) {
              browser.url = url;
              browser.gotoOptions = gotoOptions;
              return {
                status: () => 200,
                url: () => url,
                text: async () => JSON.stringify(payload())
              };
            }
          };
        },
        async close() { browser.closed = true; }
      };
      browsers.push(browser);
      return browser;
    }
  };
}

test("Feed rejection returns bounded sanitized platform text without raw response fields", async () => {
  const fake = executor({ body: JSON.stringify({
    status_code: 10011,
    data: { message: "Login required; token=DO_NOT_KEEP https://www.tiktok.com/login?sessionid=DO_NOT_KEEP" },
    cookie: "DO_NOT_KEEP",
    extra: { logid: "DO_NOT_KEEP" }
  }) });
  const result = await createTikTokLiveFeedTransport({ requestExecutor: fake.execute }).fetchOnce({
    verifiedRoute: route(), discoverySession: authenticatedDiscoverySession,
    marketRegion: "MENA", countryCode: "SA", limit: 1
  });
  assert.equal(result.reason, "feed_business_rejected");
  assert.equal(result.businessStatusCode, 10011);
  assert.equal(result.businessMessage, "Login required; [REDACTED] https://www.tiktok.com/login");
  assert.deepEqual(result.candidates, []);
  assert.equal(fake.requests.length, 1, "a rejected request must not be retried");
  assert.equal(JSON.stringify(result).includes("DO_NOT_KEEP"), false);
});

test("Feed rejection diagnostic ignores objects and bounds platform message length", async () => {
  for (const [message, expected] of [[{ token: "DO_NOT_KEEP" }, undefined], ["x".repeat(500), "x".repeat(240)]]) {
    const fake = executor({ body: JSON.stringify({ status_code: 10011, status_msg: message }) });
    const result = await createTikTokLiveFeedTransport({ requestExecutor: fake.execute }).fetchOnce({
      verifiedRoute: route(), discoverySession: authenticatedDiscoverySession,
      marketRegion: "MENA", countryCode: "SA", limit: 1
    });
    assert.equal(result.businessMessage, expected);
  }
});

test("compatible PC web feed preserves original regional parameters on the current recommendation source", async () => {
  const fake = executor();
  const result = await createTikTokLiveFeedTransport({
    requestExecutor: fake.execute,
    randomInt: () => 0
  }).fetchOnce({
    verifiedRoute: route(),
    discoverySession: authenticatedDiscoverySession,
    marketRegion: "MENA",
    countryCode: "SA",
    limit: 30
  });

  assert.equal(result.status, "ready");
  assert.equal(result.channelId, 87);
  assert.equal(fake.requests.length, 1);
  const request = fake.requests[0];
  assert.equal(request.method, "GET");
  assert.equal(request.sessionTarget, "tiktok_discovery");
  assert.equal(request.requiresAuthenticatedSession, true);
  assert.equal(request.sessionBinding, "discovery_cookie_country_http_lease");
  assert.equal(request.proxyServer, "http://127.0.0.1:17891");
  assert.equal(request.timeoutMs, 60_000);
  assert.equal(request.maxResponseBytes, 16 * 1024 * 1024);
  assert.equal(request.maxRedirects, 0);
  assert.deepEqual(request.headers, { accept: "application/json, text/plain, */*" });
  const url = new URL(request.url);
  assert.equal(url.origin, "https://webcast.tiktok.com");
  assert.equal(url.pathname, "/webcast/feed/");
  assert.equal(url.searchParams.get("channel_id"), "87");
  assert.equal(url.searchParams.get("region"), "AE");
  assert.equal(url.searchParams.get("priority_region"), "AE");
  assert.equal(url.searchParams.get("req_from"), "live_mt_pc_web_rec_tab_refresh");
  assert.equal(url.searchParams.get("device_platform"), "web_pc");
  assert.equal(result.found, 1);
  assert.deepEqual(result.candidates[0], {
    candidateId: null,
    candidateKey: "tiktok:user:7412345678901234567",
    userId: "7412345678901234567",
    secUid: "MS4wLjABAAAA_seed_creator",
    handle: "seed.creator",
    displayName: "Seed Creator",
    profileUrl: "https://www.tiktok.com/@seed.creator",
    roomId: "7498765432109876543",
    followerCount: 4567,
    viewerCount: 321,
    live: true,
    seller: true,
    liveTag: "998877",
    creatorCountryCode: "SA",
    countryCode: "SA",
    rankingScopeMarketRegion: "MENA",
    rankingScopeCountryCode: "SA",
    rankingScopeCountryEvidence: "verified_collection_proxy_exit_and_versioned_web_live_profile",
    workId: null,
    collectionLaneEvidence: {
      topology: "legacy_single_lane",
      workId: null,
      laneIndex: null,
      countryCode: "SA",
      exitCountry: "SA",
      affinity: "single_route"
    },
    source: "tiktok_webcast_country_live_feed",
    sourceUrl: "https://webcast.tiktok.com/webcast/feed/",
    observedAt: result.candidates[0].observedAt,
    confidence: 0.98,
    discovery: {
      triggerKind: "original_pc_web_feed",
      channelIdObserved: 87,
      displayIdDedupeTtlSeconds: 300,
      adapterEvidenceVersion: "original-pc-web-feed-v4"
    },
    rawEvidence: {
      source: "tiktok_webcast_feed_room_projection",
      roomId: "7498765432109876543",
      userId: "7412345678901234567",
      observedAt: result.candidates[0].observedAt
    }
  });
  assert.doesNotMatch(JSON.stringify(result), /DO_NOT_KEEP|owner@example\.com|stream\.example|image\.example|127\.0\.0\.1/i);
});

test("production feed refuses to open a cookie-free browser when its session executor is missing", async () => {
  const fake = countryWorkerLauncher();
  const result = await createTikTokLiveFeedTransport({
    chromiumLauncher: fake,
    randomInt: () => 0
  }).fetchOnce({
    verifiedRoute: route(),
    marketRegion: "MENA",
    countryCode: "SA"
  });
  assert.equal(result.reason, "feed_session_unavailable");
  assert.equal(fake.launches.length, 0);
});

test("country feed lanes select one country proxy per WorkID without using global routeCountry", async () => {
  const fake = executor();
  const transport = createTikTokLiveFeedTransport({ requestExecutor: fake.execute, randomInt: () => 0 });
  for (const [workId, countryCode] of [[1, "SA"], [2, "QA"], [3, "EG"]]) {
    const result = await transport.fetchOnce({
      verifiedRoute: exactRoute({ routeCountry: "US" }),
      discoverySession: authenticatedDiscoverySession,
      marketRegion: "MENA",
      countryCode,
      workId
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
    assert.equal(result.candidates[0].workId, workId);
    assert.deepEqual(result.candidates[0].collectionLaneEvidence, result.collectionLaneEvidence);
    assert.doesNotMatch(JSON.stringify(result), /127\.0\.0\.1|1789[1-3]/i);
  }
  assert.deepEqual(fake.requests.map((value) => value.proxyServer), [
    "http://127.0.0.1:17891",
    "http://127.0.0.1:17892",
    "http://127.0.0.1:17893"
  ]);
});

test("country feed route accepts one to three lanes and rejects invalid WorkID or per-lane drift", async () => {
  const fake = executor();
  const transport = createTikTokLiveFeedTransport({ requestExecutor: fake.execute });
  const validFake = executor();
  const oneLane = exactRoute({
    collectionLanes: [
      {
        countryCode: "SA",
        proxyServer: "http://127.0.0.1:17891",
        observedExitCountry: "SA",
        verified: true
      }
    ],
    collectionProxyExitCountries: undefined
  });
  assert.equal((await createTikTokLiveFeedTransport({ requestExecutor: validFake.execute }).fetchOnce({
    verifiedRoute: oneLane,
    discoverySession: authenticatedDiscoverySession,
    marketRegion: "MENA",
    countryCode: "SA",
    workId: 1
  })).status, "ready");
  const cases = [
    [{ verifiedRoute: exactRoute() }, "feed_work_id_invalid"],
    [{ verifiedRoute: exactRoute(), workId: 0 }, "feed_work_id_invalid"],
    [{ verifiedRoute: exactRoute(), workId: 4 }, "feed_work_id_invalid"],
    [{
      verifiedRoute: exactRoute({ collectionProxyExitCountries: ["SA", "US", "EG"] }),
      workId: 2
    }, "feed_route_country_mismatch"],
    [{
      verifiedRoute: oneLane,
      workId: 2
    }, "feed_work_id_invalid"],
    [{
      verifiedRoute: exactRoute({ collectionLanes: [
        { workId: 1, countryCode: "SA", proxyServer: "http://127.0.0.1:17891" },
        { workId: 3, countryCode: "QA", proxyServer: "http://127.0.0.1:17892" }
      ], collectionProxyExitCountries: ["SA", "QA"] }),
      workId: 2
    }, "feed_lane_route_invalid"],
    [{ verifiedRoute: route(), workId: 1 }, "feed_lane_route_invalid"]
  ];
  for (const [input, reason] of cases) {
    const result = await transport.fetchOnce({
      discoverySession: authenticatedDiscoverySession,
      marketRegion: "MENA",
      countryCode: "SA",
      ...input
    });
    assert.equal(result.reason, reason);
  }
  assert.equal(fake.requests.length, 0);
});

test("feed transport rejects route/proxy/profile changes before country-worker request", async () => {
  const fake = executor();
  const transport = createTikTokLiveFeedTransport({ requestExecutor: fake.execute });
  const cases = [
    [route({ proxyExitCountry: "US" }), "MENA", "SA", "feed_route_country_mismatch"],
    [route({ collectionProxyServer: "http://user:pass@127.0.0.1:17891" }), "MENA", "SA", "feed_proxy_not_allowed"],
    [route({ collectionProxyServer: "http://remote.example:17891" }), "MENA", "SA", "feed_proxy_not_allowed"],
    [route(), "CCA", "SA", "feed_country_profile_not_configured"],
    [route({ routeCountry: "US", proxyExitCountry: "US" }), "MENA", "US", "feed_country_profile_not_configured"]
  ];
  for (const [verifiedRoute, marketRegion, countryCode, reason] of cases) {
    const result = await transport.fetchOnce({
      verifiedRoute,
      discoverySession: authenticatedDiscoverySession,
      marketRegion,
      countryCode
    });
    assert.equal(result.reason, reason);
  }
  assert.equal(fake.requests.length, 0);
});

test("original Web LIVE variants drive UK and CCA country-worker locale fields", async () => {
  const cases = [
    {
      marketRegion: "UK",
      countryCode: "GB",
      proxyServer: "http://127.0.0.1:17901",
      expectedDisplayName: "UK(英国)",
      expectedQuery: {
        app_language: "en",
        browser_language: "en-GB",
        priority_region: "GB",
        region: "GB",
        tz_name: "Europe/London",
        webcast_language: "en"
      }
    },
    {
      marketRegion: "CCA",
      countryCode: "KZ",
      proxyServer: "http://127.0.0.1:17902",
      expectedDisplayName: "CCA(哈萨克斯坦-日榜)",
      expectedQuery: {
        app_language: "ru-RU",
        browser_language: "ru",
        priority_region: "KZ",
        region: "KZ",
        tz_name: "Asia/Urumqi",
        webcast_language: "ru-RU"
      }
    }
  ];
  for (const item of cases) {
    const fake = executor({ body: JSON.stringify(payloadForCountry(item.countryCode)) });
    const result = await createTikTokLiveFeedTransport({
      requestExecutor: fake.execute,
      randomInt: () => 0
    }).fetchOnce({
      verifiedRoute: {
        collectionLanes: [{
          workId: 1,
          countryCode: item.countryCode,
          proxyServer: item.proxyServer,
          observedExitCountry: item.countryCode,
          verified: true
        }],
        collectionProxyExitCountries: [item.countryCode]
      },
      marketRegion: item.marketRegion,
      countryCode: item.countryCode,
      workId: 1
    });
    assert.equal(result.status, "ready");
    assert.equal(result.marketRegion, item.marketRegion);
    assert.equal(result.sourceDisplayName, item.expectedDisplayName);
    assert.equal(result.candidates[0].rankingScopeMarketRegion, item.marketRegion);
    assert.equal(result.candidates[0].creatorCountryCode, item.countryCode);
    const requestUrl = new URL(fake.requests[0].url);
    for (const [key, value] of Object.entries(item.expectedQuery)) {
      assert.equal(requestUrl.searchParams.get(key), value, `${item.marketRegion}:${key}`);
    }
    assert.equal(fake.requests[0].requiresAuthenticatedSession, true);
    assert.equal(fake.requests[0].sessionBinding, "discovery_cookie_country_http_lease");
  }
});

test("feed transport fails closed on redirect, malformed JSON, and shape mismatch", async () => {
  for (const [fake, reason] of [
    [executor({ finalUrl: "https://evil.example/webcast/feed/" }), "feed_http_rejected"],
    [executor({ body: "not json" }), "feed_response_not_json"],
    [executor({ body: JSON.stringify({ status_code: 0, data: {} }) }), "feed_shape_mismatch"]
  ]) {
    const result = await createTikTokLiveFeedTransport({ requestExecutor: fake.execute }).fetchOnce({
      verifiedRoute: route(),
      discoverySession: authenticatedDiscoverySession,
      marketRegion: "MENA",
      countryCode: "SA"
    });
    assert.equal(result.reason, reason);
  }
});

test("feed declares cookie binding without treating a caller's login flag as authentication proof", async () => {
  const fake = executor();
  const transport = createTikTokLiveFeedTransport({ requestExecutor: fake.execute });
  const result = await transport.fetchOnce({
    verifiedRoute: route(),
    discoverySession: { state: "running_unchecked", authenticated: null },
    marketRegion: "MENA",
    countryCode: "SA"
  });
  assert.equal(result.status, "ready");
  assert.equal(fake.requests.length, 1);
  assert.equal(fake.requests[0].requiresAuthenticatedSession, true);
  assert.equal(fake.requests[0].sessionBinding, "discovery_cookie_country_http_lease");

  const missingWorker = await createTikTokLiveFeedTransport().fetchOnce({
    verifiedRoute: route(),
    marketRegion: "MENA",
    countryCode: "SA"
  });
  assert.equal(missingWorker.reason, "feed_session_unavailable");
});

test("feed country-worker failure does not get relabelled as an authenticated-session result", async () => {
  const failure = new Error("must not leak route details");
  const fake = executor({ error: failure });
  const result = await createTikTokLiveFeedTransport({ requestExecutor: fake.execute }).fetchOnce({
    verifiedRoute: route(),
    marketRegion: "MENA",
    countryCode: "SA"
  });
  assert.equal(result.reason, "feed_transport_failed");
  assert.doesNotMatch(JSON.stringify(result), /route details|127\.0\.0\.1|17891/i);
});

test("feed profile exposes cadence and channel enum without endpoint/proxy material", () => {
  assert.deepEqual(TIKTOK_LIVE_FEED_PROFILE.channelIds, [87]);
  assert.deepEqual(TIKTOK_LIVE_FEED_PROFILE.originalChannelIds, [21, 1, 2, 3, 44]);
  assert.equal(TIKTOK_LIVE_FEED_PROFILE.requestCompatibilityVersion, "tiktok-web-feed-20260926");
  assert.equal(TIKTOK_LIVE_FEED_PROFILE.successPollDelayMs, 3_000);
  assert.equal(TIKTOK_LIVE_FEED_PROFILE.errorPollDelayMs, 60_000);
  assert.equal(TIKTOK_LIVE_FEED_PROFILE.displayIdDedupeTtlSeconds, 300);
  assert.equal(TIKTOK_LIVE_FEED_PROFILE.authenticatedSessionTarget, "tiktok_discovery");
  assert.equal(TIKTOK_LIVE_FEED_PROFILE.sessionBinding, "discovery_cookie_country_http_lease");
  assert.equal(TIKTOK_LIVE_FEED_PROFILE.proxyRoute, "verified_collection_country");
  assert.equal(TIKTOK_LIVE_FEED_PROFILE.executableProfileCount, 147);
  assert.equal(TIKTOK_LIVE_FEED_PROFILE.supportedMarkets.length, 27);
  assert.equal(TIKTOK_LIVE_FEED_PROFILE.supportedCountries.length, 146);
  assert.equal(TIKTOK_LIVE_FEED_PROFILE.adapterEvidenceVersion, "original-pc-web-feed-v4");
  assert.doesNotMatch(JSON.stringify(TIKTOK_LIVE_FEED_PROFILE), /https?:\/\/|127\.0\.0\.1/i);
});

test("all 36 display configurations and 147 country rows drive the actual fixed Feed boundary", async () => {
  const { originalCountryCatalog } = await import("../mcp/core/original-country-config.js");
  const { originalWebLiveProfileForCountry } = await import("../mcp/core/original-web-live-config.js");
  const catalog = originalCountryCatalog();
  let rows = 0;
  let variants = 0;
  const countries = new Set();
  for (const group of catalog.configurations) {
    for (const variant of group.displayVariants) {
      variants += 1;
      for (const countryCode of variant.selectionCountryCodes) {
        rows += 1; countries.add(countryCode);
        const lane = { workId: 1, countryCode, proxyServer: "http://127.0.0.1:18101" };
        const fake = executor({ body: JSON.stringify({ status_code: 0, data: [] }) });
        const result = await createTikTokLiveFeedTransport({ requestExecutor: fake.execute }).fetchOnce({
          verifiedRoute: { collectionLanes: [lane], collectionProxyExitCountries: [countryCode] },
          marketRegion: group.routeCode, countryCode, workId: 1, displayName: variant.displayName
        });
        const expected = originalWebLiveProfileForCountry({ marketRegion: group.routeCode, countryCode, displayName: variant.displayName });
        assert.equal(result.status, "ready", `${variant.displayName}:${countryCode}`);
        assert.equal(result.sourceDisplayName, variant.displayName);
        const actual = new URL(fake.requests[0].url);
        for (const field of ["app_language", "browser_language", "priority_region", "region", "tz_name", "webcast_language"]) {
          assert.equal(actual.searchParams.get(field), expected.publicQuery[field], `${variant.displayName}:${countryCode}:${field}`);
        }
      }
    }
  }
  assert.equal(catalog.configurations.length, 27);
  assert.equal(variants, 36);
  assert.equal(rows, 147);
  assert.equal(countries.size, 146);
});

test("Feed distinguishes closed leases and route drift from ordinary network errors", async () => {
  for (const [code, reason] of [["SESSION_REQUEST_RUN_CLOSED", "feed_session_run_closed"], ["SESSION_REQUEST_PROXY_MISMATCH", "feed_route_country_mismatch"], ["SESSION_REQUEST_FAILED", "feed_transport_failed"]]) {
    const error = new Error("hidden diagnostic"); error.code = code;
    const fake = executor({ error });
    const result = await createTikTokLiveFeedTransport({ requestExecutor: fake.execute }).fetchOnce({ verifiedRoute: route(), marketRegion: "MENA", countryCode: "SA" });
    assert.equal(result.reason, reason);
    assert.doesNotMatch(JSON.stringify(result), /hidden diagnostic/);
  }
});
