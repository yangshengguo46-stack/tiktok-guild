import assert from "node:assert/strict";
import test from "node:test";
import {
  MOBILE_RANKING_AUTHORIZATION_PROVIDER_PROFILE,
  createMobileRankingAuthorizationProvider,
  isMobileRankingAuthorizationError
} from "../mcp/core/mobile-ranking-authorization-provider.js";
import { originalExecutableProfileForCountry } from "../mcp/core/original-country-config.js";

const PROFILE_ID = "tkdesk-country-bundle-mena-v1";
const PROXY_SERVER = "http://127.0.0.1:17891";
const FIXTURE_AUTHORIZATION = "fixture-user-owned-authorization-value";

function scope(overrides = {}) {
  return {
    marketRegion: "MENA",
    countryCode: "SA",
    endpointProfileId: PROFILE_ID,
    proxyServer: PROXY_SERVER,
    ...overrides
  };
}

function requestFor(gapInterval = 0, overrides = {}, rankTypeCode = 16) {
  const url = new URL("https://webcast16-normal-useast8.tiktokv.us/webcast/ranklist/list/v2/");
  const params = {
    anchor_id: "7412345678901234567",
    room_id: "7498765432109876543",
    rank_type: String(rankTypeCode),
    region_type: "1",
    gap_interval: String(gapInterval),
    use_simple_user: "true",
    league_phase: "0",
    ac: "wifi",
    channel: "googleplay",
    aid: "1233",
    app_name: "musical_ly",
    version_code: "320701",
    version_name: "32.7.1"
  };
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return {
    method: "GET",
    url: url.href,
    proxyServer: PROXY_SERVER,
    timeoutMs: 60_000,
    maxRedirects: 0,
    headers: {
      "user-agent": "com.zhiliaoapp.musically/2022602030 (Linux; U; Android 7.1.2; id; SM-G9750; Build/LMY47I;tt-ok/3.12.13.1)",
      "sdk-version": "2"
    },
    ...overrides
  };
}

function readyCoreStore({ statusState = "ready", resolveState = "ready" } = {}) {
  const resolvedBuffers = [];
  let statusCalls = 0;
  let resolveCalls = 0;
  return {
    resolvedBuffers,
    get statusCalls() { return statusCalls; },
    get resolveCalls() { return resolveCalls; },
    async status() {
      statusCalls += 1;
      return {
        state: statusState === "invalid" ? "invalid" : "ready",
        mobileAuthorization: {
          state: statusState,
          usable: statusState === "ready",
          marketRegion: "MENA",
          countryCodes: ["SA", "QA", "EG"]
        }
      };
    },
    async resolveMobileAuthorization() {
      resolveCalls += 1;
      if (resolveState !== "ready") return { status: resolveState };
      const value = Buffer.from(FIXTURE_AUTHORIZATION, "utf8");
      resolvedBuffers.push(value);
      return { status: "ready", kind: "x-tt-token", value };
    }
  };
}

function contextFactory({ responseBody = "{}", failCreate = false, failGet = false } = {}) {
  const options = [];
  const requests = [];
  const contexts = [];
  return {
    options,
    requests,
    contexts,
    async newContext(value) {
      options.push(value);
      if (failCreate) throw new Error("fixture context error with sensitive detail");
      const context = {
        disposed: false,
        async get(url, requestOptions) {
          requests.push({ url, requestOptions });
          if (failGet) throw new Error("fixture request failure with sensitive detail");
          return { status: () => 200, text: async () => responseBody };
        },
        async dispose() { context.disposed = true; }
      };
      contexts.push(context);
      return context;
    }
  };
}

test("provider status exposes scope readiness without authorization material", async () => {
  const store = readyCoreStore();
  const provider = createMobileRankingAuthorizationProvider({
    coreConfigStore: store,
    requestContextFactory: contextFactory()
  });
  const ready = await provider.status(scope());
  const unsupported = await provider.status(scope({ countryCode: "OM" }));
  assert.deepEqual(ready, {
    state: "ready",
    usable: true,
    reason: null,
    source: "user_owned_core_config",
    secretValuesExposed: false,
    configurationState: "ready",
    onlineVerified: false,
    onlineAuthorization: { state: "unknown", reason: null, observedAt: null,
      verificationScope: "fixed_endpoint_authorization", persistsAcrossRestart: false }
  });
  assert.equal(unsupported.state, "authorization_required");
  assert.equal(unsupported.usable, false);
  assert.equal(unsupported.reason, "unsupported_country");
  assert.equal(store.resolveCalls, 0);
  assert.doesNotMatch(JSON.stringify([ready, unsupported]), new RegExp(FIXTURE_AUTHORIZATION));
});

test("country-specific endpoint profiles keep MENA, CCA, and BK authorization coverage distinct", async () => {
  for (const [marketRegion, countryCode] of [
    ["MENA", "SA"],
    ["MENA", "QA"],
    ["MENA", "EG"],
    ["CCA", "BY"],
    ["CCA", "KG"],
    ["BK", "RS"]
  ]) {
    const executable = originalExecutableProfileForCountry({ marketRegion, countryCode });
    assert.ok(executable, `${marketRegion}:${countryCode}`);
    const provider = createMobileRankingAuthorizationProvider({
      coreConfigStore: {
        async status() {
          return {
            state: "ready",
            mobileAuthorization: {
              state: "ready",
              usable: true,
              marketRegion,
              countryCodes: [countryCode]
            }
          };
        }
      },
      requestContextFactory: contextFactory()
    });
    const status = await provider.status({
      marketRegion,
      countryCode,
      endpointProfileId: executable.id,
      proxyServer: PROXY_SERVER
    });
    assert.equal(status.state, "ready", `${marketRegion}:${countryCode}`);
  }
  const invalid = originalExecutableProfileForCountry({ marketRegion: "CCA", countryCode: "RS" });
  assert.equal(invalid, null);
});

test("one lease owns one Playwright context and executes only fixed ranking requests", async () => {
  const store = readyCoreStore();
  const factory = contextFactory({ responseBody: "{\"status_code\":0}" });
  const provider = createMobileRankingAuthorizationProvider({
    coreConfigStore: store,
    requestContextFactory: factory
  });
  const lease = await provider.openLease(scope());
  assert.equal(store.resolveCalls, 1);
  assert.equal(store.resolvedBuffers[0].every((byte) => byte === 0), true);
  assert.equal(factory.contexts.length, 1);
  assert.equal(factory.options.length, 1);
  assert.deepEqual(factory.options[0].proxy, { server: PROXY_SERVER });
  assert.equal(Object.hasOwn(factory.options[0], "storageState"), false);
  assert.equal(Object.hasOwn(factory.options[0].extraHTTPHeaders, "cookie"), false);
  assert.equal(Object.hasOwn(factory.options[0].extraHTTPHeaders, "authorization"), false);

  const current = await lease.execute(requestFor(0));
  const previous = await lease.execute(requestFor(-1));
  assert.deepEqual(current, { status: 200, body: "{\"status_code\":0}" });
  assert.deepEqual(previous, { status: 200, body: "{\"status_code\":0}" });
  assert.equal(factory.requests.length, 2);
  assert.equal(factory.requests.every(({ requestOptions }) => (
    requestOptions.timeout === 60_000
      && requestOptions.maxRedirects === 0
      && requestOptions.failOnStatusCode === false
  )), true);
  assert.doesNotMatch(JSON.stringify([current, previous]), new RegExp(FIXTURE_AUTHORIZATION));

  await lease.close();
  assert.equal(factory.contexts[0].disposed, true);
  await lease.close();
  await assert.rejects(
    lease.execute(requestFor(0)),
    (error) => isMobileRankingAuthorizationError(error)
      && error.code === "ranking_mobile_authorization_provider_failed"
  );
});

test("provider allows only the original rank16 and rank15 pairs plus MENA top-code-1 rank0", async () => {
  const factory = contextFactory({ responseBody: "{\"status_code\":0}" });
  const provider = createMobileRankingAuthorizationProvider({
    coreConfigStore: readyCoreStore(),
    requestContextFactory: factory
  });
  const lease = await provider.openLease(scope());

  await lease.execute(requestFor(0));
  await lease.execute(requestFor(-1));
  await lease.execute(requestFor(0, {}, 0));
  await lease.execute(requestFor(0, {}, 15));
  await lease.execute(requestFor(-1, {}, 15));
  assert.equal(factory.requests.length, 5);

  for (const request of [
    requestFor(-1, {}, 0),
    requestFor(0, {}, 8),
    (() => {
      const value = requestFor(0, {}, 0);
      value.url = value.url.replace("region_type=1", "region_type=2");
      return value;
    })()
  ]) {
    await assert.rejects(
      lease.execute(request),
      (error) => isMobileRankingAuthorizationError(error)
        && error.code === "ranking_mobile_authorization_request_rejected"
    );
  }
  assert.equal(factory.requests.length, 5);
  await lease.close();
});

test("provider derives TopCode 2 request allowlist from the selected country profile", async () => {
  const factory = contextFactory({ responseBody: "{\"status_code\":0}" });
  const provider = createMobileRankingAuthorizationProvider({
    coreConfigStore: readyCoreStore(),
    requestContextFactory: factory
  });
  const lease = await provider.openLease(scope({
    marketRegion: "UK",
    countryCode: "GB",
    endpointProfileId: "tkdesk-original-rank-no1a-v1"
  }));
  const ukRequest = (gapInterval, rankTypeCode) => {
    const request = requestFor(gapInterval, {}, rankTypeCode);
    request.url = request.url.replace(
      "webcast16-normal-useast8.tiktokv.us",
      "webcast16-normal-no1a.tiktokv.eu"
    );
    return request;
  };

  await lease.execute(ukRequest(0, 16));
  await lease.execute(ukRequest(0, 8));
  await lease.execute(ukRequest(-1, 8));
  await lease.execute(ukRequest(0, 15));
  await lease.execute(ukRequest(-1, 15));
  await assert.rejects(
    lease.execute(ukRequest(0, 0)),
    (error) => isMobileRankingAuthorizationError(error)
      && error.code === "ranking_mobile_authorization_request_rejected"
  );
  assert.equal(factory.requests.length, 5);
  await lease.close();
});

test("provider rejects route scope before reading authorization", async () => {
  for (const invalidScope of [
    scope({ proxyServer: "http://remote.example:17891" }),
    scope({ proxyServer: "http://user:pass@127.0.0.1:17891" }),
    scope({ countryCode: "ZZ" }),
    scope({ endpointProfileId: "untrusted-profile" })
  ]) {
    const store = readyCoreStore();
    const factory = contextFactory();
    const provider = createMobileRankingAuthorizationProvider({
      coreConfigStore: store,
      requestContextFactory: factory
    });
    await assert.rejects(
      provider.openLease(invalidScope),
      (error) => isMobileRankingAuthorizationError(error)
        && error.code === "ranking_mobile_authorization_request_rejected"
    );
    assert.equal(store.resolveCalls, 0);
    assert.equal(factory.contexts.length, 0);
  }
});

test("lease rejects method, endpoint, query, proxy, and credential-shaped descriptor changes", async () => {
  const store = readyCoreStore();
  const factory = contextFactory();
  const provider = createMobileRankingAuthorizationProvider({
    coreConfigStore: store,
    requestContextFactory: factory
  });
  const lease = await provider.openLease(scope());
  const wrongHost = requestFor(0);
  wrongHost.url = wrongHost.url.replace("webcast16-normal-useast8.tiktokv.us", "example.invalid");
  const extraQuery = requestFor(0);
  extraQuery.url += "&extra=1";
  const credentialHeader = requestFor(0);
  credentialHeader.headers = { ...credentialHeader.headers, authorization: "fixture" };
  for (const request of [
    requestFor(0, { method: "POST" }),
    wrongHost,
    extraQuery,
    requestFor(0, { proxyServer: "http://127.0.0.1:17892" }),
    credentialHeader,
    requestFor(1)
  ]) {
    await assert.rejects(
      lease.execute(request),
      (error) => isMobileRankingAuthorizationError(error)
        && error.code === "ranking_mobile_authorization_request_rejected"
    );
  }
  assert.equal(factory.requests.length, 0);
  await lease.close();
});

test("missing or expired Core authorization is typed and opens no Playwright context", async () => {
  for (const state of ["missing", "expired", "unsupported_country", "market_mismatch", "invalid"]) {
    const store = readyCoreStore({ resolveState: state });
    const factory = contextFactory();
    const provider = createMobileRankingAuthorizationProvider({
      coreConfigStore: store,
      requestContextFactory: factory
    });
    await assert.rejects(
      provider.openLease(scope()),
      (error) => isMobileRankingAuthorizationError(error)
        && error.code === "ranking_mobile_authorization_required"
        && error.authorizationState === state
    );
    assert.equal(factory.contexts.length, 0);
  }
});

test("untrusted Core state labels are collapsed before crossing the provider boundary", async () => {
  const untrusted = "fixture-sensitive-state-label";
  const provider = createMobileRankingAuthorizationProvider({
    coreConfigStore: {
      async status() {
        return { state: "ready", mobileAuthorization: { usable: false, state: untrusted } };
      },
      async resolveMobileAuthorization() { return { status: untrusted }; }
    },
    requestContextFactory: contextFactory()
  });
  const status = await provider.status(scope());
  assert.equal(status.reason, "invalid");
  assert.doesNotMatch(JSON.stringify(status), new RegExp(untrusted));
  await assert.rejects(
    provider.openLease(scope()),
    (error) => error.authorizationState === "invalid"
      && !String(error.message).includes(untrusted)
  );
});

test("authorization buffers are cleared when Playwright context creation fails", async () => {
  const store = readyCoreStore();
  const provider = createMobileRankingAuthorizationProvider({
    coreConfigStore: store,
    requestContextFactory: contextFactory({ failCreate: true })
  });
  await assert.rejects(
    provider.openLease(scope()),
    (error) => isMobileRankingAuthorizationError(error)
      && error.code === "ranking_mobile_authorization_provider_failed"
      && !String(error.message).includes("sensitive detail")
  );
  assert.equal(store.resolvedBuffers[0].every((byte) => byte === 0), true);
});

test("Playwright request diagnostics are replaced by a safe typed transient error", async () => {
  const provider = createMobileRankingAuthorizationProvider({
    coreConfigStore: readyCoreStore(),
    requestContextFactory: contextFactory({ failGet: true })
  });
  const lease = await provider.openLease(scope());
  await assert.rejects(
    lease.execute(requestFor(0)),
    (error) => isMobileRankingAuthorizationError(error)
      && error.code === "ranking_mobile_authorization_transport_failed"
      && !String(error.message).includes("sensitive detail")
  );
  await lease.close();
});

test("public provider profile contains capability metadata only", () => {
  assert.equal(MOBILE_RANKING_AUTHORIZATION_PROVIDER_PROFILE.supportedCountries.includes("SA"), true);
  assert.equal(MOBILE_RANKING_AUTHORIZATION_PROVIDER_PROFILE.supportedCountries.includes("GB"), true);
  assert.equal(MOBILE_RANKING_AUTHORIZATION_PROVIDER_PROFILE.supportedMarketRegions.length, 27);
  assert.equal(MOBILE_RANKING_AUTHORIZATION_PROVIDER_PROFILE.executableProfileCount, 147);
  assert.equal(MOBILE_RANKING_AUTHORIZATION_PROVIDER_PROFILE.secretValuesExposed, false);
  assert.doesNotMatch(
    JSON.stringify(MOBILE_RANKING_AUTHORIZATION_PROVIDER_PROFILE),
    /https?:\/\/|127\.0\.0\.1|cookie|authorization|token/i
  );
});

function observedResponseFactory(response) {
  let requests = 0, created = 0;
  return { get requests() { return requests; }, get created() { return created; },
    async newContext() { created += 1; return { disposed: false, async get() {
      requests += 1;
      if (response.throw) throw new Error("synthetic-network-failure");
      return { status: () => response.status, text: async () => JSON.stringify({ status_code: response.code }) };
    }, async dispose() { this.disposed = true; } }; }
  };
}

for (const rejection of [{ status: 401, code: 0 }, { status: 403, code: 0 }, { status: 200, code: 20003 }]) {
  test(`mobile ${rejection.status}/${rejection.code} fences this host across leases and scoped status`, async () => {
    const store = readyCoreStore(); const factory = observedResponseFactory(rejection);
    const provider = createMobileRankingAuthorizationProvider({ coreConfigStore: store, requestContextFactory: factory });
    const first = await provider.openLease(scope()); const other = await provider.openLease(scope({ countryCode: "QA" }));
    try {
      await assert.rejects(first.execute(requestFor()), { code: "ranking_mobile_authorization_required" });
      await assert.rejects(other.execute(requestFor()), { code: "ranking_mobile_authorization_required" });
      await assert.rejects(provider.openLease(scope()), { code: "ranking_mobile_authorization_required" });
      const status = await provider.status(scope({ countryCode: "QA" }));
      assert.equal(status.usable, false); assert.equal(status.configurationState, "ready");
      assert.equal(status.onlineAuthorization.state, "rejected");
      assert.equal(status.onlineVerified, false); assert.equal(factory.requests, 1); assert.equal(factory.created, 2);
      assert.doesNotMatch(JSON.stringify(status), new RegExp(FIXTURE_AUTHORIZATION));
    } finally { await first.close(); await other.close(); }
  });
}

test("mobile configuration readiness starts online unknown and accepted observations expire without locking out first reads", async () => {
  let time = Date.parse("2026-09-28T00:00:00Z");
  const factory = observedResponseFactory({ status: 200, code: 0 });
  const provider = createMobileRankingAuthorizationProvider({ coreConfigStore: readyCoreStore(), requestContextFactory: factory, clock: () => time });
  const initial = await provider.status(scope());
  assert.equal(initial.configurationState, "ready"); assert.equal(initial.usable, true);
  assert.equal(initial.onlineAuthorization.state, "unknown"); assert.equal(initial.onlineVerified, false); assert.equal(factory.created, 0);
  const lease = await provider.openLease(scope());
  try { await lease.execute(requestFor()); } finally { await lease.close(); }
  const accepted = await provider.status(scope());
  assert.equal(accepted.onlineAuthorization.state, "verified"); assert.equal(accepted.onlineVerified, true);
  assert.equal(accepted.onlineAuthorization.observedAt, "2026-09-28T00:00:00.000Z");
  time += 300_001;
  const expired = await provider.status(scope());
  assert.equal(expired.onlineAuthorization.state, "unknown"); assert.equal(expired.onlineVerified, false); assert.equal(expired.usable, true);
});

test("network, throttling, server and generic business failures do not revoke mobile authorization", async () => {
  for (const response of [{ status: 429, code: 0 }, { status: 503, code: 0 }, { status: 200, code: 98765 }, { status: 200, code: 10011 }, { throw: true }]) {
    const factory = observedResponseFactory(response);
    const provider = createMobileRankingAuthorizationProvider({ coreConfigStore: readyCoreStore(), requestContextFactory: factory });
    const lease = await provider.openLease(scope());
    try {
      if (response.throw) await assert.rejects(lease.execute(requestFor()), { code: "ranking_mobile_authorization_transport_failed" });
      else await lease.execute(requestFor());
    } finally { await lease.close(); }
    const status = await provider.status(scope());
    assert.equal(status.usable, true); assert.equal(status.onlineAuthorization.state, "unknown");
    const next = await provider.openLease(scope()); await next.close();
  }
});

test("ranking transport authorization classification also fences the provider host", async () => {
  const { createTikTokRankingTransport } = await import("../mcp/core/tiktok-ranking-transport.js");
  const factory = observedResponseFactory({ status: 200, code: 10011 });
  const provider = createMobileRankingAuthorizationProvider({ coreConfigStore: readyCoreStore(), requestContextFactory: factory });
  const transport = createTikTokRankingTransport({ authorizationProvider: provider });
  const result = await transport.fetchPair({ seed: { anchorId: "7412345678901234567", roomId: "7498765432109876543" },
    marketRegion: "MENA", countryCode: "SA", verifiedRoute: { routeCountry: "SA", proxyExitCountry: "SA", collectionProxyServer: PROXY_SERVER } });
  assert.equal(result.reason, "ranking_mobile_authorization_required");
  assert.equal((await provider.status(scope())).usable, false);
  assert.equal((await provider.status(scope())).onlineAuthorization.reason, "transport_authorization_required");
  assert.equal(factory.requests, 1);
});

test("mobile queued execute cannot send after the preceding response rejects this host", async () => {
  const factory = observedResponseFactory({ status: 403, code: 0 });
  const provider = createMobileRankingAuthorizationProvider({ coreConfigStore: readyCoreStore(), requestContextFactory: factory });
  const lease = await provider.openLease(scope());
  const results = await Promise.allSettled([lease.execute(requestFor()), lease.execute(requestFor(-1))]);
  assert.ok(results.every(result => result.status === "rejected")); assert.equal(factory.requests, 1); await lease.close();
});

for (const pauseAt of ["resolve", "context"]) {
  test(`mobile host rejection fences openLease already awaiting ${pauseAt}`, async () => {
    const store = readyCoreStore(); const factory = observedResponseFactory({ status: 401, code: 0 });
    const provider = createMobileRankingAuthorizationProvider({ coreConfigStore: store, requestContextFactory: factory });
    const first = await provider.openLease(scope());
    let release; const wait = new Promise(resolve => { release = resolve; });
    let opened; const started = new Promise(resolve => { opened = resolve; });
    let pendingContext;
    if (pauseAt === "resolve") {
      const resolve = store.resolveMobileAuthorization;
      store.resolveMobileAuthorization = async (...args) => { opened(); await wait; return resolve(...args); };
    } else {
      const create = factory.newContext;
      factory.newContext = async (...args) => { pendingContext = await create(...args); opened(); await wait; return pendingContext; };
    }
    const opening = provider.openLease(scope({ countryCode: "QA" })); await started;
    await assert.rejects(first.execute(requestFor()), { code: "ranking_mobile_authorization_required" }); release();
    await assert.rejects(opening, { code: "ranking_mobile_authorization_required" });
    assert.equal(factory.requests, 1);
    if (pendingContext) assert.equal(pendingContext.disposed, true);
    assert.ok(store.resolvedBuffers.every(buffer => buffer.every(byte => byte === 0)));
    await first.close();
  });
}

test("late mobile success cannot clear a sibling lease rejection and a fresh process starts unknown", async () => {
  let release; const wait = new Promise(resolve => { release = resolve; }); let started;
  const startedPromise = new Promise(resolve => { started = resolve; }); let contexts = 0;
  const factory = { async newContext() {
    const index = contexts++;
    return { async get() { if (index === 0) { started(); await wait; } return { status: () => index === 0 ? 200 : 403, text: async () => '{"status_code":0}' }; }, async dispose() {} };
  } };
  const store = readyCoreStore(); const provider = createMobileRankingAuthorizationProvider({ coreConfigStore: store, requestContextFactory: factory });
  const slow = await provider.openLease(scope()); const rejecting = await provider.openLease(scope());
  const pending = slow.execute(requestFor()); await startedPromise;
  await assert.rejects(rejecting.execute(requestFor())); release(); await pending;
  assert.equal((await provider.status(scope())).onlineAuthorization.state, "rejected");
  const fresh = createMobileRankingAuthorizationProvider({ coreConfigStore: store, requestContextFactory: factory });
  assert.equal((await fresh.status(scope())).onlineAuthorization.state, "unknown");
  assert.equal((await fresh.status(scope())).usable, true); await slow.close(); await rejecting.close();
});

test("mobile rejected host does not fence an unrelated fixed host", async () => {
  const { DEFAULT_CORE_COUNTRY_PROFILES } = await import("../mcp/core/core-config-store.js");
  const profileResolver = current => {
    const profile = DEFAULT_CORE_COUNTRY_PROFILES.find(item => item.countryCode === current.countryCode && item.marketRegion === current.marketRegion);
    if (!profile) return null;
    return current.countryCode === "QA" ? { ...profile, canonicalUrl: profile.canonicalUrl.replace("webcast16-normal-useast8.tiktokv.us", "fixture-unrelated.tiktokv.us") } : profile;
  };
  const factory = observedResponseFactory({ status: 401, code: 0 });
  const provider = createMobileRankingAuthorizationProvider({ coreConfigStore: readyCoreStore(), requestContextFactory: factory, profileResolver });
  const rejected = await provider.openLease(scope()); await assert.rejects(rejected.execute(requestFor()));
  assert.equal((await provider.status(scope({ countryCode: "QA" }))).usable, true);
  const unaffected = await provider.openLease(scope({ countryCode: "QA" }));
  await unaffected.close(); await rejected.close(); assert.equal(factory.created, 2);
});


test("mobile online verification rejects coerced success codes, oversized responses and backwards clock evidence", async () => {
  for (const code of [false, "", [], {}, null, "00", " 0", "0.0"]) {
    const factory = observedResponseFactory({ status: 200, code });
    const provider = createMobileRankingAuthorizationProvider({ coreConfigStore: readyCoreStore(), requestContextFactory: factory });
    const lease = await provider.openLease(scope()); await lease.execute(requestFor()); await lease.close();
    assert.equal((await provider.status(scope())).onlineVerified, false, `coercion ${JSON.stringify(code)}`);
  }
  for (const code of [0, "0"]) {
    let time = Date.parse("2026-09-28T00:00:00Z");
    const provider = createMobileRankingAuthorizationProvider({ coreConfigStore: readyCoreStore(), requestContextFactory: observedResponseFactory({ status: 200, code }), clock: () => time });
    const lease = await provider.openLease(scope()); await lease.execute(requestFor()); await lease.close();
    assert.equal((await provider.status(scope())).onlineVerified, true); time -= 1;
    assert.equal((await provider.status(scope())).onlineVerified, false);
  }
  const provider = createMobileRankingAuthorizationProvider({ coreConfigStore: readyCoreStore(), requestContextFactory: contextFactory({ responseBody: JSON.stringify({ status_code: 0, data: "x".repeat(4 * 1024 * 1024) }) }) });
  const lease = await provider.openLease(scope()); await assert.rejects(lease.execute(requestFor())); await lease.close();
  assert.equal((await provider.status(scope())).onlineVerified, false);
});
