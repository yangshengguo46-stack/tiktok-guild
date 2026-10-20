import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  SESSION_TARGET_NAMES,
  SessionManager,
  isAllowedAgentNavigationUrl,
  isAllowedSessionUrl,
  probeProxyExitCountry,
  sanitizeSessionUrl
} from "../mcp/core/session-manager.js";
import { createTikTokLiveFeedTransport } from "../mcp/core/tiktok-live-feed-transport.js";

// Removing login-cookie binding, lane isolation, or disposal must break these tests.
async function feedSessionFixture(t) {
  const launcher = fakeLauncher();
  const calls = [];
  const response = { status: 200, body: '{"status_code":0,"data":[]}' };
  const manager = new SessionManager({
    dataDirectory: await tempDirectory(t), chromiumLauncher: launcher, platform: "linux",
    requestContextFactory: {
      async newContext(options) {
        const call = { options, disposed: false, observedCookies: [], responsesDisposed: 0, jar: options.storageState.cookies[0]?.value };
        calls.push(call);
        return {
          async get(url, options) {
            call.url = url; call.getOptions = options;
            call.observedCookies.push(call.jar);
            call.jar = "rotated-by-first-response";
            if (response.wait) await response.wait;
            if (response.error || response.errorsRemaining > 0) {
              if (response.errorsRemaining > 0) response.errorsRemaining--;
              throw new Error(response.errorMessage ?? "COOKIE_TEST_SECRET signed_url");
            }
            return { status: () => response.status, url: () => url,
              body: async () => Buffer.from(response.body),
              headerValue: response.apiHeaders ? undefined : async () => response.contentType ?? null,
              headers: () => ({ "content-type": response.contentType, "set-cookie": "COOKIE_TEST_SECRET" }),
              dispose: async () => { call.responsesDisposed++; } };
          },
          async dispose() { call.disposed = true; }
        };
      }
    }
  });
  t.after(() => manager.stopAll());
  const route = validRoute({
    verificationStatus: "verified", discoveryProxyExitCountry: "US",
    collectionLanes: [
      { countryCode: "SA", proxyServer: "http://127.0.0.1:17891", observedExitCountry: "SA" },
      { countryCode: "QA", proxyServer: "http://127.0.0.1:17892", observedExitCountry: "QA" },
      { countryCode: "EG", proxyServer: "http://127.0.0.1:17893", observedExitCountry: "EG" }
    ], collectionProxyExitCountries: ["SA", "QA", "EG"]
  });
  await manager.start("tiktok_discovery", { route, startUrl: "https://www.tiktok.com/" });
  const context = launcher.calls[0].context;
  context.cookies = async () => [
    { name: "sessionid", value: "COOKIE_TEST_SECRET", domain: ".tiktok.com", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "None" },
    { name: "backstage", value: "BACKSTAGE_SECRET", domain: "live-backstage.tiktok.com", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "None" }
  ];
  context.pages()[0].dom.authenticated = true;
  await manager.checkLogin("tiktok_discovery");
  const request = {
    method: "GET", stage: "feed", sessionTarget: "tiktok_discovery", requiresAuthenticatedSession: true,
    url: "https://webcast.us.tiktok.com/webcast/feed/?aid=1988&channel_id=21",
    proxyServer: "http://127.0.0.1:17891", workId: 1, countryCode: "SA",
    timeoutMs: 60_000, maxResponseBytes: 16 * 1024 * 1024, maxRedirects: 0,
    headers: { accept: "application/json, text/plain, */*" }
  };
  return { manager, route, request, context, calls, response };
}

test("native country HTTP returns content type and timing but never private headers", async t => {
  const f = await feedSessionFixture(t);
  f.response.contentType = "text/html; sessionid=COOKIE_TEST_SECRET";
  const result = await f.manager.executeCountryFeedRequest(f.request, f.route);
  assert.equal(result.contentType, "text/html");
  assert.ok(Number.isSafeInteger(result.elapsedMs));
  assert.doesNotMatch(JSON.stringify(result), /COOKIE_TEST_SECRET|BACKSTAGE_SECRET|sessionid/);
});

test("native APIRequestContext responses project their content type without headerValue", async t => {
  const f = await feedSessionFixture(t);
  f.response.apiHeaders = true;
  f.response.contentType = "application/json; charset=utf-8";
  const result = await f.manager.executeCountryFeedRequest(f.request, f.route);
  assert.equal(result.contentType, "application/json");
  assert.doesNotMatch(JSON.stringify(result), /set-cookie|COOKIE_TEST_SECRET/);
});

test("native transport errors preserve only a safe timeout category", async t => {
  const f = await feedSessionFixture(t);
  f.response.error = true;
  f.response.errorMessage = "request timed out COOKIE_TEST_SECRET https://example.com/?token=SECRET";
  await assert.rejects(f.manager.executeCountryFeedRequest(f.request, f.route), error => {
    assert.ok(error.transportDiagnostics, "safe transport measurements are missing");
    assert.equal(error.transportDiagnostics.category, "timeout");
    assert.doesNotMatch(JSON.stringify(error), /COOKIE_TEST_SECRET|example.com|token=SECRET/);
    return error.code === "SESSION_REQUEST_FAILED";
  });
});

test("PC Feed binds discovery cookies to each verified country HTTP lane without exporting them", async (t) => {
  const f = await feedSessionFixture(t);
  const transport = createTikTokLiveFeedTransport({
    requestExecutor: (request, { verifiedRoute }) => f.manager.executeCountryFeedRequest(request, verifiedRoute),
    randomInt: () => 0
  });
  for (const [workId, countryCode] of [[1, "SA"], [2, "QA"], [3, "EG"]]) {
    const result = await transport.fetchOnce({ verifiedRoute: f.route, marketRegion: "MENA", countryCode, workId });
    assert.equal(result.status, "ready");
    assert.doesNotMatch(JSON.stringify(result), /COOKIE_TEST_SECRET|BACKSTAGE_SECRET|sessionid/);
  }
  assert.deepEqual(f.calls.map(c => c.options.proxy.server), ["http://127.0.0.1:17891", "http://127.0.0.1:17892", "http://127.0.0.1:17893"]);
  for (const call of f.calls) {
    assert.deepEqual(call.options.storageState.origins, []);
    assert.deepEqual(call.options.storageState.cookies.map(c => c.name), ["sessionid"]);
    assert.equal(call.options.extraHTTPHeaders.referer, "https://www.tiktok.com/");
    // V10's HTTP language is fixed even when the selected Core query is Arabic.
    assert.equal(new URL(call.url).searchParams.get("browser_language"), "ar");
    assert.equal(call.options.extraHTTPHeaders["accept-language"], "en-US,en;q=0.9");
    assert.equal(call.getOptions.maxRedirects, 0);
    assert.equal(call.disposed, true);
  }
  assert.equal(f.context.closed, false);
});

test("country Feed rejects login and lane drift before reading cookies or dispatching", async (t) => {
  const f = await feedSessionFixture(t);
  const attempts = [
    [f.request, { ...f.route, verificationStatus: "unverified" }],
    [f.request, { ...f.route, discoveryProxyServer: "http://127.0.0.1:19999" }],
    [{ ...f.request, proxyServer: "http://127.0.0.1:19999" }, f.route],
    [{ ...f.request, workId: 2 }, f.route],
    [{ ...f.request, url: "https://www.tiktok.com/api-live/user/room/" }, f.route],
    [{ ...f.request, headers: { cookie: "BAD" } }, f.route],
    [f.request, { ...f.route, collectionProxyExitCountries: ["US", "QA", "EG"] }]
  ];
  let reads = 0;
  f.context.cookies = async () => { reads++; return []; };
  for (const [request, route] of attempts) await assert.rejects(f.manager.executeCountryFeedRequest(request, route));
  f.manager.sessions.get("tiktok_discovery").authenticated = false;
  await assert.rejects(f.manager.executeCountryFeedRequest(f.request, f.route));
  assert.equal(reads, 0);
  assert.equal(f.calls.length, 0);
});

test("country Feed permits the currently observed official Feed host on the same authenticated lane", async (t) => {
  const f = await feedSessionFixture(t);
  const request = { ...f.request, url: f.request.url.replace("webcast.us.tiktok.com", "webcast.tiktok.com") };
  const result = await f.manager.executeCountryFeedRequest(request, f.route);
  assert.equal(result.status, 200);
  assert.equal(new URL(f.calls[0].url).hostname, "webcast.tiktok.com");
  assert.equal(f.calls[0].options.proxy.server, f.request.proxyServer);
  assert.deepEqual(f.calls[0].options.storageState.cookies.map(c => c.name), ["sessionid"]);
  assert.equal(f.calls[0].disposed, true);
  await assert.rejects(f.manager.executeCountryFeedRequest({ ...request,
    url: request.url.replace("webcast.tiktok.com", "webcast.tiktok.com.evil.example") }, f.route));
});

test("country Feed disposes HTTP leases on oversized, redirect, or secret-bearing transport failure", async (t) => {
  const f = await feedSessionFixture(t);
  for (const mode of ["oversized", "redirect", "error"]) {
    f.response.status = mode === "redirect" ? 302 : 200;
    f.response.body = mode === "oversized" ? "12345" : "{}";
    f.response.error = mode === "error";
    await assert.rejects(f.manager.executeCountryFeedRequest({ ...f.request, maxResponseBytes: 4 }, f.route), error => {
      assert.doesNotMatch(error.message, /COOKIE_TEST_SECRET|signed_url/);
      return true;
    });
    assert.equal(f.calls.at(-1).disposed, true);
  }
  assert.equal(f.calls.length, 3); // No automatic replay.
});

class FakePage {
  constructor(url = "about:blank", dom = {}) {
    this.currentUrl = url;
    this.dom = { captcha: false, authentication: false, authenticated: false, ...dom };
    this.authenticatedRequestResult = null;
    this.evaluateCalls = [];
    this.closed = false;
  }

  url() { return this.currentUrl; }
  isClosed() { return this.closed; }
  async title() { return "Fake page"; }
  async goto(url) { this.currentUrl = url; }
  async bringToFront() {}
  async evaluate(_callback, argument) {
    this.evaluateCalls.push(argument);
    if (argument?.requestUrl) return this.authenticatedRequestResult;
    return this.dom;
  }
  async route(_pattern, callback) { this.routeHandler = callback; }
  async close() { this.closed = true; }
}

class FakeContext {
  constructor(page = new FakePage()) {
    this.pageList = [page];
    this.listeners = new Map();
    this.routeHandler = null;
    this.closed = false;
  }

  pages() { return this.pageList; }
  async newPage() {
    const page = new FakePage();
    this.pageList.push(page);
    this.listeners.get("page")?.(page);
    return page;
  }
  on(event, callback) { this.listeners.set(event, callback); }
  async route(_pattern, callback) { this.routeHandler = callback; }
  async close() {
    this.closed = true;
    this.listeners.get("close")?.();
  }
}

class FakeBrowser extends EventEmitter {
  constructor(context) {
    super();
    this.context = context;
    this.closed = false;
  }

  contexts() { return [this.context]; }
  async close() {
    this.closed = true;
    this.emit("disconnected");
  }
}

function fakeLauncher({ cdpUrl = "https://www.tiktok.com/login", cdpDom = {}, cdpPages = null } = {}) {
  const calls = [];
  const cdpCalls = [];
  return {
    calls,
    cdpCalls,
    cdpUrl,
    cdpDom,
    async launchPersistentContext(profileDirectory, options) {
      const context = new FakeContext();
      calls.push({ profileDirectory, options, context });
      return context;
    },
    async connectOverCDP(endpoint, options) {
      const context = new FakeContext(new FakePage(this.cdpUrl, this.cdpDom));
      if (cdpPages !== null) context.pageList = cdpPages.map((url) => new FakePage(url, this.cdpDom));
      const browser = new FakeBrowser(context);
      cdpCalls.push({ endpoint, options, context, browser });
      return browser;
    }
  };
}

class FakeChromeProcess extends EventEmitter {
  constructor(pid = 41_000) {
    super();
    this.pid = pid;
    this.killed = false;
  }

  close(code = 0) {
    this.pid = undefined;
    this.emit("exit", code, null);
  }

  kill(signal) {
    this.killed = signal;
    queueMicrotask(() => this.close(0));
    return true;
  }
}

function fakeManualChromeLauncher() {
  const calls = [];
  return {
    calls,
    launch(executable, args, options) {
      const child = new FakeChromeProcess(41_000 + calls.length);
      calls.push({ executable, args, options, child });
      return child;
    }
  };
}

function validRoute(overrides = {}) {
  const requestedFirstLane = Array.isArray(overrides.collectionLanes)
    ? overrides.collectionLanes[0]
    : null;
  const firstCountry = overrides.routeCountry
    ?? overrides.backstageCountry
    ?? requestedFirstLane?.countryCode
    ?? "SA";
  const firstProxyServer = overrides.collectionProxyServer
    ?? overrides.proxyServer
    ?? requestedFirstLane?.proxyServer
    ?? "socks5://127.0.0.1:10801";
  const collectionLanes = overrides.collectionLanes ?? [{
    countryCode: firstCountry,
    proxyServer: firstProxyServer
  }];
  const canonicalFirstLane = collectionLanes[0];
  return {
    marketRegion: "MENA",
    marketCountryCodes: ["SA", "AE", "EG", "QA"],
    discoveryCountry: "US",
    discoveryProxyExitCountry: "US",
    discoveryProxyServer: "socks5://127.0.0.1:10800",
    ...overrides,
    collectionLanes,
    collectionProxyExitCountries: overrides.collectionProxyExitCountries
      ?? collectionLanes.map((lane) => lane.countryCode),
    routeCountry: overrides.routeCountry ?? canonicalFirstLane.countryCode,
    backstageCountry: overrides.backstageCountry ?? canonicalFirstLane.countryCode,
    proxyExitCountry: overrides.proxyExitCountry ?? canonicalFirstLane.countryCode,
    collectionProxyServer: overrides.collectionProxyServer ?? canonicalFirstLane.proxyServer,
    proxyServer: overrides.proxyServer ?? canonicalFirstLane.proxyServer
  };
}

async function tempDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tkdesk-sessions-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20
    });
  });
  return directory;
}

test("target allowlists are exact, HTTPS-only, and cross-site isolated", () => {
  assert.equal(isAllowedSessionUrl("tiktok_discovery", "https://www.tiktok.com/login"), true);
  assert.equal(isAllowedSessionUrl("tiktok_discovery", "https://live-backstage.tiktok.com/"), false);
  assert.equal(isAllowedSessionUrl("collection_backstage", "https://live-backstage.tiktok.com/portal/anchor/relation"), true);
  assert.equal(isAllowedSessionUrl("collection_backstage", "https://svip.tiktokzb.com/"), false);
  assert.equal(isAllowedSessionUrl("svip_legacy", "https://svip.tiktokzb.com/index.html#/login"), true);
  assert.equal(isAllowedSessionUrl("svip_legacy", "https://vip.tiktokzb.com/"), false);
  assert.equal(isAllowedSessionUrl("svip_legacy", "https://svip.tiktokzb.com.evil.example/"), false);
  assert.equal(isAllowedSessionUrl("tiktok_discovery", "http://www.tiktok.com/"), false);
});

test("collection sub-backend agent tab cannot navigate into guild-wide operations", () => {
  assert.equal(
    isAllowedAgentNavigationUrl("collection_backstage", "https://live-backstage.tiktok.com/portal/anchor/relation"),
    true
  );
  assert.equal(
    isAllowedAgentNavigationUrl("collection_backstage", "https://live-backstage.tiktok.com/portal/overview"),
    false
  );
  assert.equal(
    isAllowedAgentNavigationUrl("collection_backstage", "https://live-backstage.tiktok.com/portal/revenue/task"),
    false
  );
});

test("session URLs never expose query strings or hashes", () => {
  assert.equal(
    sanitizeSessionUrl("https://accounts.tiktok.com/callback?code=secret-token#/access_token=also-secret"),
    "https://accounts.tiktok.com/callback"
  );
});

test("proxy exit probing normalizes the server before invoking an injected probe", async () => {
  let observedProxy = null;
  const country = await probeProxyExitCountry(" SOCKS5://LOCALHOST:1080 ", {
    probe: async (proxyServer) => {
      observedProxy = proxyServer;
      return { countryCode: "sa" };
    }
  });
  assert.equal(observedProxy, "socks5://localhost:1080");
  assert.equal(country, "SA");
  await assert.rejects(
    probeProxyExitCountry("http://127.0.0.1:1080", { probe: async () => "XX" }),
    (error) => error.code === "PROXY_EXIT_COUNTRY_UNAVAILABLE"
  );
});

test("default proxy exit probing uses a disposable proxied browser and discards trace details", async () => {
  const calls = [];
  let closed = false;
  const country = await probeProxyExitCountry("http://127.0.0.1:1080", {
    chromiumLauncher: {
      async launch(options) {
        calls.push(options);
        return {
          async newPage() {
            return {
              async goto(url, navigation) {
                calls.push({ url, navigation });
                return {
                  ok: () => true,
                  text: async () => "fl=abc\nip=203.0.113.7\nloc=AE\ntls=TLSv1.3\n"
                };
              }
            };
          },
          async close() { closed = true; }
        };
      }
    }
  });
  assert.equal(country, "AE");
  assert.deepEqual(calls[0], {
    headless: true,
    proxy: { server: "http://127.0.0.1:1080" }
  });
  assert.equal(calls[1].url, "https://www.cloudflare.com/cdn-cgi/trace");
  assert.equal(closed, true);
  assert.equal(JSON.stringify({ country }).includes("203.0.113.7"), false);
});

test("each target launches in a physically separate persistent profile", async (t) => {
  const dataDirectory = await tempDirectory(t);
  const launcher = fakeLauncher();
  const manager = new SessionManager({ dataDirectory, chromiumLauncher: launcher, platform: "linux" });
  t.after(() => manager.stopAll());

  await manager.start("tiktok_discovery");
  await manager.start("collection_backstage");
  await manager.start("svip_legacy");

  assert.equal(launcher.calls.length, 3);
  const directories = launcher.calls.map((call) => call.profileDirectory);
  assert.equal(new Set(directories).size, SESSION_TARGET_NAMES.length);
  assert.ok(directories[0].endsWith(path.join("browser-profiles", "tiktok_discovery")));
  assert.ok(directories[1].endsWith(path.join("browser-profiles", "collection_backstage")));
  assert.ok(directories[2].endsWith(path.join("browser-profiles", "svip_legacy")));
  for (const call of launcher.calls) {
    assert.equal(call.options.headless, false);
    assert.equal("storageState" in call.options, false);
    assert.equal("ignoreDefaultArgs" in call.options, false);
  }

  const statuses = await manager.status();
  assert.equal(statuses.tiktok_discovery.running, true);
  assert.equal(statuses.collection_backstage.running, true);
  assert.equal(statuses.svip_legacy.running, true);
});

test("discovery uses its US node while collection backstage shares WorkID1", async (t) => {
  const launcher = fakeLauncher();
  const manager = new SessionManager({
    dataDirectory: await tempDirectory(t),
    chromiumLauncher: launcher,
    platform: "linux"
  });
  t.after(() => manager.stopAll());

  const route = validRoute();
  await manager.start("tiktok_discovery", { route });
  await manager.start("collection_backstage", { route });
  await manager.start("svip_legacy");

  assert.deepEqual(launcher.calls[0].options.proxy, { server: "socks5://127.0.0.1:10800" });
  assert.deepEqual(launcher.calls[1].options.proxy, { server: "socks5://127.0.0.1:10801" });
  assert.equal("proxy" in launcher.calls[2].options, false);

  const discovery = await manager.status("tiktok_discovery");
  const collection = await manager.status("collection_backstage");
  assert.match(discovery.routeFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(discovery.routeCountry, "US");
  assert.equal(discovery.restartRequired, false);
  assert.match(collection.routeFingerprint, /^[a-f0-9]{64}$/);
  assert.notEqual(collection.routeFingerprint, discovery.routeFingerprint);
  assert.equal(collection.routeCountry, "SA");
  assert.equal(collection.restartRequired, false);

  await assert.rejects(
    manager.start("svip_legacy", { route }),
    (error) => error.code === "SESSION_ROUTE_NOT_SUPPORTED"
  );
  assert.equal(launcher.calls.length, 3);
});

test("authenticated requests execute inside the verified page without exporting browser credentials", async (t) => {
  const launcher = fakeLauncher();
  const manager = new SessionManager({
    dataDirectory: await tempDirectory(t),
    chromiumLauncher: launcher,
    platform: "linux"
  });
  t.after(() => manager.stopAll());

  await manager.start("tiktok_discovery", {
    route: validRoute(),
    startUrl: "https://www.tiktok.com/"
  });
  const page = launcher.calls[0].context.pages()[0];
  page.dom = { captcha: false, authentication: false, authenticated: true };
  assert.equal((await manager.checkLogin("tiktok_discovery")).state, "authenticated");
  assert.equal((await manager.status("tiktok_discovery")).authenticatedRequestReady, true);

  page.authenticatedRequestResult = {
    status: 200,
    url: "https://www.tiktok.com/api-live/user/room/",
    body: "{\"status_code\":0}"
  };
  const response = await manager.executeAuthenticatedRequest("tiktok_discovery", {
    method: "GET",
    stage: "basic",
    sessionTarget: "tiktok_discovery",
    requiresAuthenticatedSession: true,
    url: "https://www.tiktok.com/api-live/user/room/?aid=1988&uniqueId=sample.creator",
    proxyServer: "socks5://127.0.0.1:10800",
    timeoutMs: 60_000,
    maxResponseBytes: 4 * 1024 * 1024,
    maxRedirects: 0,
    headers: { accept: "application/json" }
  });
  assert.deepEqual(response, {
    status: 200,
    url: "https://www.tiktok.com/api-live/user/room/",
    body: "{\"status_code\":0}"
  });
  const browserInput = page.evaluateCalls.at(-1);
  assert.equal(browserInput.requestUrl.includes("sample.creator"), true);
  assert.deepEqual(browserInput.headers, { accept: "application/json" });
  assert.equal("proxyServer" in browserInput, false);
  assert.doesNotMatch(JSON.stringify(browserInput), /cookie|token|authorization|storage/i);
});

test("authenticated request execution fails closed before fetch on login, proxy, URL, or header drift", async (t) => {
  const launcher = fakeLauncher();
  const manager = new SessionManager({
    dataDirectory: await tempDirectory(t),
    chromiumLauncher: launcher,
    platform: "linux"
  });
  t.after(() => manager.stopAll());
  await manager.start("tiktok_discovery", {
    route: validRoute(),
    startUrl: "https://www.tiktok.com/"
  });
  const page = launcher.calls[0].context.pages()[0];
  const baseRequest = {
    method: "GET",
    stage: "feed",
    sessionTarget: "tiktok_discovery",
    requiresAuthenticatedSession: true,
    url: "https://webcast.us.tiktok.com/webcast/feed/?aid=1988&channel_id=21",
    proxyServer: "socks5://127.0.0.1:10800",
    timeoutMs: 60_000,
    maxResponseBytes: 16 * 1024 * 1024,
    maxRedirects: 0,
    headers: { accept: "application/json" }
  };

  await assert.rejects(
    manager.executeAuthenticatedRequest("tiktok_discovery", baseRequest),
    (error) => error.code === "SESSION_REQUEST_AUTHENTICATION_REQUIRED"
  );
  page.dom = { captcha: false, authentication: false, authenticated: true };
  assert.equal((await manager.checkLogin("tiktok_discovery")).state, "authenticated");
  const evaluationsAfterLogin = page.evaluateCalls.length;

  await assert.rejects(
    manager.executeAuthenticatedRequest("tiktok_discovery", {
      ...baseRequest,
      proxyServer: "http://127.0.0.1:17891"
    }),
    (error) => error.code === "SESSION_REQUEST_PROXY_MISMATCH"
  );
  await assert.rejects(
    manager.executeAuthenticatedRequest("tiktok_discovery", {
      ...baseRequest,
      url: "https://evil.example/webcast/feed/"
    }),
    (error) => error.code === "SESSION_REQUEST_URL_NOT_ALLOWED"
  );
  await assert.rejects(
    manager.executeAuthenticatedRequest("tiktok_discovery", {
      ...baseRequest,
      headers: { cookie: "must-never-cross" }
    }),
    (error) => error.code === "SESSION_REQUEST_HEADERS_NOT_ALLOWED"
  );
  assert.equal(page.evaluateCalls.length, evaluationsAfterLogin);
});

test("authenticated page fetch rejects redirects and oversized responses without returning their body", async (t) => {
  const launcher = fakeLauncher();
  const manager = new SessionManager({
    dataDirectory: await tempDirectory(t),
    chromiumLauncher: launcher,
    platform: "linux"
  });
  t.after(() => manager.stopAll());
  await manager.start("tiktok_discovery", {
    route: validRoute(),
    startUrl: "https://www.tiktok.com/"
  });
  const page = launcher.calls[0].context.pages()[0];
  page.dom = { captcha: false, authentication: false, authenticated: true };
  await manager.checkLogin("tiktok_discovery");
  const request = {
    method: "GET",
    stage: "country",
    sessionTarget: "tiktok_discovery",
    requiresAuthenticatedSession: true,
    url: "https://webcast.us.tiktok.com/webcast/gift/list/?aid=1988&room_id=7000000000000000001",
    proxyServer: "socks5://127.0.0.1:10800",
    timeoutMs: 60_000,
    maxResponseBytes: 4 * 1024 * 1024,
    maxRedirects: 0,
    headers: {}
  };
  page.authenticatedRequestResult = { failure: "redirect_rejected" };
  await assert.rejects(
    manager.executeAuthenticatedRequest("tiktok_discovery", request),
    (error) => error.code === "SESSION_REQUEST_REDIRECT_REJECTED"
  );
  page.authenticatedRequestResult = { failure: "response_too_large" };
  await assert.rejects(
    manager.executeAuthenticatedRequest("tiktok_discovery", request),
    (error) => error.code === "SESSION_REQUEST_RESPONSE_TOO_LARGE"
  );
});

test("collection backstage fingerprints only WorkID1 while discovery remains independent", async (t) => {
  const launcher = fakeLauncher();
  const manager = new SessionManager({
    dataDirectory: await tempDirectory(t),
    chromiumLauncher: launcher,
    platform: "linux"
  });
  t.after(() => manager.stopAll());

  const saRoute = validRoute({
    collectionLanes: [
      { countryCode: "SA", proxyServer: "socks5://127.0.0.1:10801" },
      { countryCode: "QA", proxyServer: "socks5://127.0.0.1:10802" },
      { countryCode: "EG", proxyServer: "socks5://127.0.0.1:10803" }
    ]
  });
  await manager.start("tiktok_discovery", { route: saRoute });
  await manager.start("collection_backstage", { route: saRoute });
  const discoveryFingerprint = (await manager.status("tiktok_discovery")).routeFingerprint;
  const collectionFingerprint = (await manager.status("collection_backstage")).routeFingerprint;

  const changedLaterLanes = validRoute({
    collectionLanes: [
      { countryCode: "SA", proxyServer: "socks5://127.0.0.1:10801" },
      { countryCode: "QA", proxyServer: "socks5://127.0.0.1:10902" },
      { countryCode: "EG", proxyServer: "socks5://127.0.0.1:10903" }
    ]
  });
  const unchangedDiscovery = await manager.start("tiktok_discovery", { route: changedLaterLanes });
  const unchangedCollection = await manager.start("collection_backstage", { route: changedLaterLanes });

  assert.equal(unchangedDiscovery.restartRequired, false);
  assert.equal(unchangedDiscovery.routeCountry, "US");
  assert.equal(unchangedDiscovery.routeFingerprint, discoveryFingerprint);
  assert.equal(unchangedCollection.restartRequired, false);
  assert.equal(unchangedCollection.routeCountry, "SA");
  assert.equal(unchangedCollection.routeFingerprint, collectionFingerprint);

  const changedFirstLane = validRoute({
    collectionLanes: [
      { countryCode: "QA", proxyServer: "socks5://127.0.0.1:10802" },
      { countryCode: "SA", proxyServer: "socks5://127.0.0.1:10801" },
      { countryCode: "EG", proxyServer: "socks5://127.0.0.1:10803" }
    ]
  });
  const independentDiscovery = await manager.start("tiktok_discovery", { route: changedFirstLane });
  const mismatchedCollection = await manager.start("collection_backstage", { route: changedFirstLane });

  assert.equal(independentDiscovery.restartRequired, false);
  assert.equal(independentDiscovery.routeFingerprint, discoveryFingerprint);
  assert.equal(mismatchedCollection.restartRequired, true);
  assert.equal(mismatchedCollection.routeCountry, "SA");

  assert.equal(launcher.calls.length, 2);
  assert.doesNotThrow(() => manager.page("tiktok_discovery"));
  assert.throws(
    () => manager.page("collection_backstage"),
    (error) => error.code === "SESSION_ROUTE_RESTART_REQUIRED"
  );
});

test("a running routed automation session fails closed when a different route is requested", async (t) => {
  const launcher = fakeLauncher();
  const manager = new SessionManager({
    dataDirectory: await tempDirectory(t),
    chromiumLauncher: launcher,
    platform: "linux"
  });
  t.after(() => manager.stopAll());

  await manager.start("tiktok_discovery", { route: validRoute() });
  const mismatched = await manager.start("tiktok_discovery", {
    route: validRoute({
      discoveryCountry: "CA",
      discoveryProxyExitCountry: "CA",
      discoveryProxyServer: "http://127.0.0.1:10802"
    })
  });

  assert.equal(mismatched.restartRequired, true);
  assert.equal(mismatched.routeCountry, "US");
  assert.equal(launcher.calls.length, 1);
  assert.throws(
    () => manager.page("tiktok_discovery"),
    (error) => error.code === "SESSION_ROUTE_RESTART_REQUIRED"
  );
  assert.equal((await manager.checkLogin("tiktok_discovery")).state, "route_restart_required");
});

test("bindExistingRoute compares a live holder without launching another browser", async (t) => {
  const launcher = fakeLauncher();
  const manager = new SessionManager({
    dataDirectory: await tempDirectory(t),
    chromiumLauncher: launcher,
    platform: "linux"
  });
  t.after(() => manager.stopAll());

  await manager.start("tiktok_discovery", { route: validRoute() });
  const result = await manager.bindExistingRoute("tiktok_discovery", {
    route: validRoute({
      discoveryCountry: "CA",
      discoveryProxyExitCountry: "CA",
      discoveryProxyServer: "http://127.0.0.1:10802"
    })
  });

  assert.equal(result.state, "route_restart_required");
  assert.equal(result.running, true);
  assert.equal(result.restartRequired, true);
  assert.equal(result.routeCountry, "US");
  assert.equal(launcher.calls.length, 1);
  assert.throws(() => manager.page("tiktok_discovery"), (error) => error.code === "SESSION_ROUTE_RESTART_REQUIRED");
});

test("bindExistingRoute never opens a browser when no live holder exists", async (t) => {
  const launcher = fakeLauncher();
  const manager = new SessionManager({
    dataDirectory: await tempDirectory(t),
    chromiumLauncher: launcher,
    platform: "linux"
  });
  t.after(() => manager.stopAll());

  const result = await manager.bindExistingRoute("collection_backstage", { route: validRoute() });
  assert.equal(result.state, "stopped");
  assert.equal(result.running, false);
  assert.equal(result.reopenRequired, false);
  assert.equal(launcher.calls.length, 0);
  assert.equal(launcher.cdpCalls.length, 0);
});

test("bindExistingRoute does not relaunch a profile closed after a passive status read", async (t) => {
  const automation = fakeLauncher();
  const manual = fakeManualChromeLauncher();
  const manager = new SessionManager({
    dataDirectory: await tempDirectory(t),
    chromiumLauncher: automation,
    platform: "darwin",
    manualBrowserAvailabilityCheck: async () => {},
    manualBrowserLauncher: manual.launch.bind(manual),
    debugPortAllocator: async () => 49_234
  });
  t.after(() => manager.stopAll());

  await manager.start("tiktok_discovery", { route: validRoute() });
  assert.equal((await manager.status("tiktok_discovery")).running, true);

  // Models the check_login TOCTOU: its passive status observed a live browser,
  // but the user closed that browser before route binding began.
  manual.calls[0].child.close(0);
  const result = await manager.bindExistingRoute("tiktok_discovery", { route: validRoute() });

  assert.equal(result.state, "stopped");
  assert.equal(result.running, false);
  assert.equal(result.reopenRequired, true);
  assert.equal(manual.calls.length, 1);
  assert.equal(automation.calls.length, 0);
  assert.equal(automation.cdpCalls.length, 0);
});

test("bindExistingRoute upgrades a stale collection fingerprint only after exact live identity proof", async (t) => {
  const dataDirectory = await tempDirectory(t);
  const profileDirectory = path.join(dataDirectory, "browser-profiles", "collection_backstage");
  const firstManual = fakeManualChromeLauncher();
  const ownership = { alive: true, lock: false };
  const startedAt = "Sat Aug 22 16:04:00 2026";
  const processInspector = async () => ({
    alive: ownership.alive,
    executable: ownership.alive ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : null,
    command: ownership.alive
      ? `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=${profileDirectory} --remote-debugging-address=127.0.0.1 --remote-debugging-port=49236 --proxy-server=socks5://127.0.0.1:10801`
      : null,
    startedAt: ownership.alive ? startedAt : null
  });
  const singletonLockInspector = async () => ({
    exists: ownership.lock,
    pid: ownership.lock ? 41_000 : null,
    parseable: true
  });
  const first = new SessionManager({
    dataDirectory,
    chromiumLauncher: fakeLauncher(),
    platform: "darwin",
    manualBrowserAvailabilityCheck: async () => {},
    manualBrowserLauncher: firstManual.launch.bind(firstManual),
    debugPortAllocator: async () => 49_236,
    processInspector,
    singletonLockInspector
  });
  const original = await first.start("collection_backstage", { route: validRoute() });
  ownership.lock = true;
  await first.stopAll();

  const staleFingerprint = "0".repeat(64);
  const statePath = first.manualStatePath("collection_backstage");
  const staleState = JSON.parse(await readFile(statePath, "utf8"));
  staleState.routeFingerprint = staleFingerprint;
  await writeFile(statePath, `${JSON.stringify(staleState, null, 2)}\n`, { mode: 0o600 });

  const secondManual = fakeManualChromeLauncher();
  const secondAutomation = fakeLauncher();
  const second = new SessionManager({
    dataDirectory,
    chromiumLauncher: secondAutomation,
    platform: "darwin",
    manualBrowserAvailabilityCheck: async () => {},
    manualBrowserLauncher: secondManual.launch.bind(secondManual),
    processInspector,
    singletonLockInspector
  });
  t.after(() => second.stopAll());

  const rebound = await second.bindExistingRoute("collection_backstage", { route: validRoute() });
  assert.equal(rebound.state, "running");
  assert.equal(rebound.running, true);
  assert.equal(rebound.restartRequired, false);
  assert.equal(rebound.routeCountry, "SA");
  assert.equal(rebound.routeFingerprint, original.routeFingerprint);
  assert.notEqual(rebound.routeFingerprint, staleFingerprint);
  assert.equal(secondManual.calls.length, 0);
  assert.equal(secondAutomation.calls.length, 0);
  assert.equal(secondAutomation.cdpCalls.length, 0);

  const upgradedState = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(upgradedState.routeFingerprint, original.routeFingerprint);
  assert.equal(upgradedState.routeCountry, "SA");
  assert.equal(upgradedState.debugPort, 49_236);
  assert.equal(upgradedState.processStartedAt, startedAt);

  ownership.alive = false;
  ownership.lock = false;
  firstManual.calls[0].child.close(0);
});

test("bindExistingRoute binds a legacy unbound live Chrome only after exact proxy and process proof", async (t) => {
  const dataDirectory = await tempDirectory(t);
  const profileDirectory = path.join(dataDirectory, "browser-profiles", "tiktok_discovery");
  const firstManual = fakeManualChromeLauncher();
  const ownership = { alive: false, lock: false };
  const startedAt = "Sat Aug 22 16:04:30 2026";
  const processInspector = async () => ({
    alive: ownership.alive,
    executable: ownership.alive ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : null,
    command: ownership.alive
      ? `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=${profileDirectory} --remote-debugging-address=127.0.0.1 --remote-debugging-port=49237 --proxy-server=socks5://127.0.0.1:10800`
      : null,
    startedAt: ownership.alive ? startedAt : null
  });
  const singletonLockInspector = async () => ({
    exists: ownership.lock,
    pid: ownership.lock ? 41_000 : null,
    parseable: true
  });
  const first = new SessionManager({
    dataDirectory,
    chromiumLauncher: fakeLauncher(),
    platform: "darwin",
    manualBrowserAvailabilityCheck: async () => {},
    manualBrowserLauncher: firstManual.launch.bind(firstManual),
    debugPortAllocator: async () => 49_237,
    processInspector,
    singletonLockInspector
  });
  const original = await first.start("tiktok_discovery", { route: validRoute() });
  ownership.alive = true;
  ownership.lock = true;
  await first.stopAll();

  const statePath = first.manualStatePath("tiktok_discovery");
  const legacyState = JSON.parse(await readFile(statePath, "utf8"));
  legacyState.routeFingerprint = null;
  legacyState.routeCountry = null;
  await writeFile(statePath, `${JSON.stringify(legacyState, null, 2)}\n`, { mode: 0o600 });

  const secondAutomation = fakeLauncher();
  const second = new SessionManager({
    dataDirectory,
    chromiumLauncher: secondAutomation,
    platform: "darwin",
    manualBrowserAvailabilityCheck: async () => {},
    manualBrowserLauncher: fakeManualChromeLauncher().launch,
    processInspector,
    singletonLockInspector
  });
  t.after(() => second.stopAll());

  const rebound = await second.bindExistingRoute("tiktok_discovery", { route: validRoute() });
  assert.equal(rebound.state, "running");
  assert.equal(rebound.restartRequired, false);
  assert.equal(rebound.routeCountry, "US");
  assert.equal(rebound.routeFingerprint, original.routeFingerprint);
  assert.equal(secondAutomation.calls.length, 0);
  assert.equal(secondAutomation.cdpCalls.length, 0);

  const upgradedState = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(upgradedState.routeCountry, "US");
  assert.equal(upgradedState.routeFingerprint, original.routeFingerprint);

  ownership.alive = false;
  ownership.lock = false;
  firstManual.calls[0].child.close(0);
});

test("bindExistingRoute verifies the exact proxy argv of a recovered live Chrome", async (t) => {
  const dataDirectory = await tempDirectory(t);
  const profileDirectory = path.join(dataDirectory, "browser-profiles", "tiktok_discovery");
  const firstManual = fakeManualChromeLauncher();
  const ownership = { alive: false, lock: false };
  let commandProxy = "socks5://127.0.0.1:10800";
  const processInspector = async () => ({
    alive: ownership.alive,
    executable: ownership.alive ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : null,
    command: ownership.alive
      ? `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=${profileDirectory} --remote-debugging-address=127.0.0.1 --remote-debugging-port=49235 --proxy-server=${commandProxy}`
      : null,
    startedAt: ownership.alive ? "Sat Aug 22 16:05:00 2026" : null
  });
  const singletonLockInspector = async () => ({
    exists: ownership.lock,
    pid: ownership.lock ? 41_000 : null,
    parseable: true
  });
  const first = new SessionManager({
    dataDirectory,
    chromiumLauncher: fakeLauncher(),
    platform: "darwin",
    manualBrowserAvailabilityCheck: async () => {},
    manualBrowserLauncher: firstManual.launch.bind(firstManual),
    debugPortAllocator: async () => 49_235,
    processInspector,
    singletonLockInspector
  });
  await first.start("tiktok_discovery", { route: validRoute() });
  ownership.alive = true;
  ownership.lock = true;
  await first.stopAll();

  commandProxy = "socks5://127.0.0.1:10999";
  const secondManual = fakeManualChromeLauncher();
  const secondAutomation = fakeLauncher();
  const second = new SessionManager({
    dataDirectory,
    chromiumLauncher: secondAutomation,
    platform: "darwin",
    manualBrowserAvailabilityCheck: async () => {},
    manualBrowserLauncher: secondManual.launch.bind(secondManual),
    processInspector,
    singletonLockInspector
  });
  t.after(() => second.stopAll());

  const result = await second.bindExistingRoute("tiktok_discovery", { route: validRoute() });
  assert.equal(result.state, "route_restart_required");
  assert.equal(result.running, true);
  assert.equal(result.restartRequired, true);
  assert.equal(secondManual.calls.length, 0);
  assert.equal(secondAutomation.calls.length, 0);
  assert.equal(secondAutomation.cdpCalls.length, 0);

  ownership.alive = false;
  ownership.lock = false;
  firstManual.calls[0].child.close(0);
});

test("macOS start_login opens ordinary Chrome with a loopback-only attach endpoint and does not connect yet", async (t) => {
  const dataDirectory = await tempDirectory(t);
  const automation = fakeLauncher();
  const manual = fakeManualChromeLauncher();
  const manager = new SessionManager({
    dataDirectory,
    chromiumLauncher: automation,
    platform: "darwin",
    chromeExecutable: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    manualBrowserAvailabilityCheck: async () => {},
    manualBrowserLauncher: manual.launch.bind(manual),
    debugPortAllocator: async () => 49_221
  });
  t.after(() => manager.stopAll());

  const started = await manager.start("tiktok_discovery");
  assert.equal(automation.calls.length, 0);
  assert.equal(automation.cdpCalls.length, 0);
  assert.equal(manual.calls.length, 1);
  assert.equal(started.mode, "manual_login");
  assert.equal(started.manualLoginInProgress, true);
  assert.equal(started.takeoverReady, false);

  const call = manual.calls[0];
  assert.equal(call.executable, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
  assert.ok(call.args.includes(`--user-data-dir=${manager.profileDirectory("tiktok_discovery")}`));
  assert.ok(call.args.includes("--remote-debugging-address=127.0.0.1"));
  assert.ok(call.args.includes("--remote-debugging-port=49221"));
  assert.ok(call.args.includes("--new-window"));
  assert.ok(call.args.includes("https://www.tiktok.com/login"));
  assert.equal(call.args.some((arg) => /enable-automation|use-mock-keychain|password-store|remote-allow-origins/i.test(arg)), false);
});

test("macOS routed Chrome persists only the route fingerprint and country", async (t) => {
  const dataDirectory = await tempDirectory(t);
  const manual = fakeManualChromeLauncher();
  const manager = new SessionManager({
    dataDirectory,
    chromiumLauncher: fakeLauncher(),
    platform: "darwin",
    chromeExecutable: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    manualBrowserAvailabilityCheck: async () => {},
    manualBrowserLauncher: manual.launch.bind(manual),
    debugPortAllocator: async () => 49_231
  });
  t.after(() => manager.stopAll());

  const status = await manager.start("collection_backstage", { route: validRoute() });
  assert.ok(manual.calls[0].args.includes("--proxy-server=socks5://127.0.0.1:10801"));
  assert.equal(status.routeCountry, "SA");
  assert.match(status.routeFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(status.restartRequired, false);

  const state = JSON.parse(await readFile(manager.manualStatePath("collection_backstage"), "utf8"));
  assert.equal(state.routeCountry, "SA");
  assert.equal(state.routeFingerprint, status.routeFingerprint);
  const serialized = JSON.stringify(state);
  assert.doesNotMatch(serialized, /proxyServer|marketRegion|marketCountryCodes|backstageCountry|proxyExitCountry|10801/);
});

test("reopen adds an official recovery tab without restarting verified Chrome or touching human tabs", async (t) => {
  const dataDirectory = await tempDirectory(t);
  const manual = fakeManualChromeLauncher();
  const automation = fakeLauncher({ cdpUrl: "chrome-error://chromewebdata/" });
  const chromeExecutable = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const manager = new SessionManager({
    dataDirectory,
    chromiumLauncher: automation,
    platform: "darwin",
    chromeExecutable,
    manualBrowserAvailabilityCheck: async () => {},
    manualBrowserLauncher: manual.launch.bind(manual),
    debugPortAllocator: async () => 49_240 + manual.calls.length,
    processInspector: async (pid) => {
      const call = manual.calls.find((_, index) => pid === 41_000 + index);
      return call ? {
        alive: !call.child.killed,
        executable: chromeExecutable,
        command: `${chromeExecutable} ${call.args.join(" ")}`,
        startedAt: `Sat Aug 22 16:03:0${manual.calls.indexOf(call)} 2026`
      } : { alive: false };
    }
  });
  t.after(() => manager.stopAll());

  await manager.start("tiktok_discovery", { route: validRoute() });
  await manager.start("collection_backstage", { route: validRoute() });
  const profileDirectory = manager.profileDirectory("collection_backstage");
  await mkdir(profileDirectory, { recursive: true });
  await writeFile(path.join(profileDirectory, "retained-login-marker"), "unchanged");

  const reopened = await manager.reopen("collection_backstage", { route: validRoute() });

  assert.equal(manual.calls.length, 2);
  assert.equal(manual.calls[0].child.killed, false);
  assert.equal(manual.calls[1].child.killed, false);
  assert.equal(await readFile(path.join(profileDirectory, "retained-login-marker"), "utf8"), "unchanged");
  assert.equal(automation.cdpCalls.length, 1);
  const humanPage = automation.cdpCalls[0].context.pages()[0];
  const recoveryPage = automation.cdpCalls[0].context.pages()[1];
  assert.equal(humanPage.url(), "chrome-error://chromewebdata/");
  assert.equal(humanPage.closed, false);
  assert.equal(recoveryPage.url(), "https://live-backstage.tiktok.com/portal/anchor/relation");
  assert.equal(recoveryPage.closed, false);
  assert.equal(typeof recoveryPage.routeHandler, "function");
  assert.equal(reopened.running, true);
  assert.equal(reopened.routeCountry, "SA");
  assert.deepEqual(reopened.pages.map((page) => page.url), ["https://live-backstage.tiktok.com/portal/anchor/relation"]);

  recoveryPage.dom.authenticated = true;
  const verified = await manager.checkLogin("collection_backstage");
  assert.equal(verified.state, "authenticated");
  assert.equal(recoveryPage.closed, true);
  assert.equal(humanPage.closed, false);
  assert.equal(automation.cdpCalls[0].context.pages().length, 3);
});

test("reopen refuses to attach to a collection Chrome process whose start identity changed", async (t) => {
  const dataDirectory = await tempDirectory(t);
  const manual = fakeManualChromeLauncher();
  const chromeExecutable = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  let processStartedAt = "Sat Aug 22 16:03:00 2026";
  const manager = new SessionManager({
    dataDirectory,
    chromiumLauncher: fakeLauncher(),
    platform: "darwin",
    chromeExecutable,
    manualBrowserAvailabilityCheck: async () => {},
    manualBrowserLauncher: manual.launch.bind(manual),
    debugPortAllocator: async () => 49_245,
    processInspector: async () => ({
      alive: true,
      executable: chromeExecutable,
      command: `${chromeExecutable} --user-data-dir=${path.join(dataDirectory, "browser-profiles", "collection_backstage")} --remote-debugging-address=127.0.0.1 --remote-debugging-port=49245 --proxy-server=socks5://127.0.0.1:10801`,
      startedAt: processStartedAt
    })
  });
  t.after(() => manager.stopAll());

  await manager.start("collection_backstage", { route: validRoute() });
  processStartedAt = "Sat Aug 22 16:03:01 2026";

  await assert.rejects(manager.reopen("collection_backstage", { route: validRoute() }), /身份|核验/);
  assert.equal(manual.calls.length, 1);
  assert.equal(manual.calls[0].child.killed, false);
});

test("reopen can recover a verified Chrome that has no tabs without replacing its profile", async (t) => {
  const dataDirectory = await tempDirectory(t);
  const manual = fakeManualChromeLauncher();
  const automation = fakeLauncher({ cdpPages: [] });
  const chromeExecutable = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const manager = new SessionManager({
    dataDirectory,
    chromiumLauncher: automation,
    platform: "darwin",
    chromeExecutable,
    manualBrowserAvailabilityCheck: async () => {},
    manualBrowserLauncher: manual.launch.bind(manual),
    debugPortAllocator: async () => 49_246,
    processInspector: async () => ({
      alive: true,
      executable: chromeExecutable,
      command: `${chromeExecutable} --user-data-dir=${path.join(dataDirectory, "browser-profiles", "collection_backstage")} --remote-debugging-address=127.0.0.1 --remote-debugging-port=49246 --proxy-server=socks5://127.0.0.1:10801`,
      startedAt: "Sat Aug 22 16:03:00 2026"
    })
  });
  t.after(() => manager.stopAll());

  await manager.start("collection_backstage", { route: validRoute() });
  const reopened = await manager.reopen("collection_backstage", { route: validRoute() });
  assert.equal(manual.calls.length, 1);
  assert.equal(manual.calls[0].child.killed, false);
  assert.equal(automation.cdpCalls[0].context.pages().length, 1);
  assert.equal(reopened.pages[0].url, "https://live-backstage.tiktok.com/portal/anchor/relation");

  const recoveryPage = automation.cdpCalls[0].context.pages()[0];
  recoveryPage.dom.authentication = true;
  assert.equal((await manager.checkLogin("collection_backstage")).state, "authentication_required");
  assert.equal(recoveryPage.closed, false);
  assert.equal(manual.calls[0].child.killed, false);
});

test("routed macOS attach verifies the exact proxy launch argument", async (t) => {
  const dataDirectory = await tempDirectory(t);
  const automation = fakeLauncher({
    cdpUrl: "https://www.tiktok.com/",
    cdpDom: { authenticated: true }
  });
  const manual = fakeManualChromeLauncher();
  const profileDirectory = path.join(dataDirectory, "browser-profiles", "tiktok_discovery");
  let commandProxy = "socks5://127.0.0.1:10800";
  const manager = new SessionManager({
    dataDirectory,
    chromiumLauncher: automation,
    platform: "darwin",
    manualBrowserAvailabilityCheck: async () => {},
    manualBrowserLauncher: manual.launch.bind(manual),
    debugPortAllocator: async () => 49_233,
    processInspector: async () => ({
      alive: true,
      executable: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      command: `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=${profileDirectory} --remote-debugging-address=127.0.0.1 --remote-debugging-port=49233 --proxy-server=${commandProxy}`,
      startedAt: "Sat Aug 22 16:03:00 2026"
    })
  });
  t.after(() => manager.stopAll());

  await manager.start("tiktok_discovery", { route: validRoute() });
  assert.equal((await manager.checkLogin("tiktok_discovery")).state, "authenticated");

  await manager.stopAll();
  commandProxy = "socks5://127.0.0.1:10999";
  const rejected = await manager.checkLogin("tiktok_discovery");
  assert.notEqual(rejected.state, "authenticated");
});

test("checkLogin attaches to the still-running ordinary Chrome without restart and creates only one Agent tab", async (t) => {
  const dataDirectory = await tempDirectory(t);
  const automation = fakeLauncher({
    cdpUrl: "https://www.tiktok.com/",
    cdpDom: { authenticated: true }
  });
  const manual = fakeManualChromeLauncher();
  const profileDirectory = path.join(dataDirectory, "browser-profiles", "tiktok_discovery");
  const processInspector = async () => ({
    alive: true,
    executable: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    command: `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=${profileDirectory} --remote-debugging-address=127.0.0.1 --remote-debugging-port=49222 --new-window`,
    startedAt: "Sat Aug 22 16:00:00 2026"
  });
  const manager = new SessionManager({
    dataDirectory,
    chromiumLauncher: automation,
    platform: "darwin",
    manualBrowserAvailabilityCheck: async () => {},
    manualBrowserLauncher: manual.launch.bind(manual),
    debugPortAllocator: async () => 49_222,
    processInspector
  });

  await manager.start("tiktok_discovery");
  const login = await manager.checkLogin("tiktok_discovery");
  assert.equal(login.state, "authenticated");
  assert.equal(automation.calls.length, 0);
  assert.equal(automation.cdpCalls.length, 1);
  assert.equal(automation.cdpCalls[0].endpoint, "http://127.0.0.1:49222");
  assert.equal(manual.calls[0].child.pid, 41_000);

  const humanPage = automation.cdpCalls[0].context.pages()[0];
  const agentPage = automation.cdpCalls[0].context.pages()[1];
  assert.equal(humanPage.routeHandler, undefined);
  assert.equal(agentPage.url(), "https://www.tiktok.com/");
  assert.equal(typeof agentPage.routeHandler, "function");
  assert.equal(manager.page("tiktok_discovery"), agentPage);

  const running = await manager.status("tiktok_discovery");
  assert.equal(running.mode, "agent_attached");
  assert.equal(running.takeoverReady, false);
  assert.equal(running.pages.length, 1);

  // Closing the dedicated Agent tab must never make page() fall back to the
  // still-open human login tab in the same CDP context.
  await agentPage.close();
  assert.equal(humanPage.isClosed(), false);
  assert.throws(() => manager.page("tiktok_discovery"), /没有可用页面/);
  assert.equal((await manager.status("tiktok_discovery")).pages.length, 0);

  // Restore the fixture's Agent tab for the authenticated-session reuse and
  // graceful-disconnect assertions below.
  agentPage.closed = false;

  agentPage.currentUrl = "https://www.tiktok.com/live";
  agentPage.dom = { captcha: false, authentication: false, authenticated: false };
  const reused = await manager.checkLogin("tiktok_discovery");
  assert.equal(reused.state, "authenticated");
  assert.equal(reused.authenticated, true);

  const stopped = await manager.stopAll();
  assert.equal(automation.cdpCalls[0].browser.closed, true);
  assert.equal(automation.cdpCalls[0].context.closed, false);
  assert.equal(manual.calls[0].child.killed, false);
  assert.deepEqual(stopped.preservedManual, ["tiktok_discovery"]);
});

test("positive authenticated DOM on a login-looking URL wins over the URL fallback", async (t) => {
  const launcher = fakeLauncher();
  const manager = new SessionManager({
    dataDirectory: await tempDirectory(t),
    chromiumLauncher: launcher,
    platform: "linux"
  });
  t.after(() => manager.stopAll());

  await manager.start("tiktok_discovery");
  const page = launcher.calls[0].context.pages()[0];
  page.currentUrl = "https://www.tiktok.com/login";
  page.dom = { captcha: false, authentication: false, authenticated: true };

  const login = await manager.checkLogin("tiktok_discovery");
  assert.equal(login.state, "authenticated");
  assert.equal(login.authenticated, true);
});

test("an unauthenticated manual page is inspected once, disconnected, and never navigated or closed", async (t) => {
  const dataDirectory = await tempDirectory(t);
  const launcher = fakeLauncher({
    cdpUrl: "https://www.tiktok.com/login",
    cdpDom: { authentication: true }
  });
  const manual = fakeManualChromeLauncher();
  const profileDirectory = path.join(dataDirectory, "browser-profiles", "tiktok_discovery");
  const manager = new SessionManager({
    dataDirectory,
    chromiumLauncher: launcher,
    platform: "darwin",
    manualBrowserAvailabilityCheck: async () => {},
    manualBrowserLauncher: manual.launch.bind(manual),
    debugPortAllocator: async () => 49_223,
    processInspector: async () => ({
      alive: true,
      executable: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      command: `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=${profileDirectory} --remote-debugging-address=127.0.0.1 --remote-debugging-port=49223`,
      startedAt: "Sat Aug 22 16:01:00 2026"
    })
  });
  t.after(() => manager.stopAll());

  await manager.start("tiktok_discovery");
  const login = await manager.checkLogin("tiktok_discovery");
  assert.equal(login.state, "authentication_required");
  assert.equal(launcher.cdpCalls.length, 1);
  assert.equal(launcher.cdpCalls[0].browser.closed, true);
  assert.equal(launcher.cdpCalls[0].context.closed, false);
  assert.equal(launcher.cdpCalls[0].context.pages().length, 1);
  assert.equal(launcher.cdpCalls[0].context.pages()[0].closed, false);
  assert.equal(manual.calls[0].child.killed, false);
  assert.equal((await manager.status("tiktok_discovery")).mode, "manual_login");
});

test("concurrent checkLogin calls share exactly one in-place CDP connection", async (t) => {
  const dataDirectory = await tempDirectory(t);
  const profileDirectory = path.join(dataDirectory, "browser-profiles", "tiktok_discovery");
  const baseAutomation = fakeLauncher({
    cdpUrl: "https://www.tiktok.com/",
    cdpDom: { authenticated: true }
  });
  const automation = {
    calls: baseAutomation.calls,
    cdpCalls: baseAutomation.cdpCalls,
    async launchPersistentContext(profileDirectory, options) {
      return baseAutomation.launchPersistentContext(profileDirectory, options);
    },
    async connectOverCDP(endpoint, options) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return baseAutomation.connectOverCDP(endpoint, options);
    }
  };
  const manual = fakeManualChromeLauncher();
  const manager = new SessionManager({
    dataDirectory,
    chromiumLauncher: automation,
    platform: "darwin",
    manualBrowserAvailabilityCheck: async () => {},
    manualBrowserLauncher: manual.launch.bind(manual),
    debugPortAllocator: async () => 49_224,
    processInspector: async () => ({
      alive: true,
      executable: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      command: `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=${profileDirectory} --remote-debugging-address=127.0.0.1 --remote-debugging-port=49224`,
      startedAt: "Sat Aug 22 16:02:00 2026"
    })
  });
  t.after(() => manager.stopAll());

  await manager.start("tiktok_discovery");
  const [first, second] = await Promise.all([
    manager.checkLogin("tiktok_discovery"),
    manager.checkLogin("tiktok_discovery")
  ]);

  assert.equal(automation.calls.length, 0);
  assert.equal(automation.cdpCalls.length, 1);
  assert.deepEqual(first, second);
  assert.equal(first.state, "authenticated");
});

test("manual login status reports only the sanitized launched URL", async (t) => {
  const manual = fakeManualChromeLauncher();
  const manager = new SessionManager({
    dataDirectory: await tempDirectory(t),
    chromiumLauncher: fakeLauncher(),
    platform: "darwin",
    manualBrowserAvailabilityCheck: async () => {},
    manualBrowserLauncher: manual.launch.bind(manual)
  });
  t.after(() => manager.stopAll());

  const status = await manager.start("tiktok_discovery", {
    startUrl: "https://www.tiktok.com/login?redirect_url=private-value#short-lived-code"
  });
  assert.equal(status.pages[0].url, "https://www.tiktok.com/login");
  assert.equal(JSON.stringify(status).includes("private-value"), false);
  assert.equal(JSON.stringify(status).includes("short-lived-code"), false);

  const persisted = await readFile(manager.manualStatePath("tiktok_discovery"), "utf8");
  assert.equal(persisted.includes("private-value"), false);
  assert.equal(persisted.includes("short-lived-code"), false);
  assert.equal((await stat(manager.manualStatePath("tiktok_discovery"))).mode & 0o777, 0o600);
});

test("a new daemon recovers a verified live manual Chrome owner and never starts a second browser", async (t) => {
  const dataDirectory = await tempDirectory(t);
  const firstManual = fakeManualChromeLauncher();
  const profileDirectory = path.join(dataDirectory, "browser-profiles", "tiktok_discovery");
  const ownership = { alive: false, lock: false };
  const processInspector = async (pid) => ({
    alive: ownership.alive,
    executable: ownership.alive ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : null,
    command: ownership.alive
      ? `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=${profileDirectory} --remote-debugging-address=127.0.0.1 --remote-debugging-port=49225 --new-window https://www.tiktok.com/login`
      : null,
    startedAt: ownership.alive ? "Sat Aug 22 12:00:00 2026" : null,
    pid
  });
  const singletonLockInspector = async () => ({ exists: ownership.lock, pid: ownership.lock ? 41_000 : null, parseable: true });

  const first = new SessionManager({
    dataDirectory,
    chromiumLauncher: fakeLauncher(),
    platform: "darwin",
    manualBrowserAvailabilityCheck: async () => {},
    manualBrowserLauncher: firstManual.launch.bind(firstManual),
    debugPortAllocator: async () => 49_225,
    processInspector,
    singletonLockInspector
  });
  await first.start("tiktok_discovery");
  ownership.alive = true;
  ownership.lock = true;
  await first.stopAll();

  const secondManual = fakeManualChromeLauncher();
  const secondAutomation = fakeLauncher({
    cdpUrl: "https://www.tiktok.com/",
    cdpDom: { authenticated: true }
  });
  const second = new SessionManager({
    dataDirectory,
    chromiumLauncher: secondAutomation,
    platform: "darwin",
    manualBrowserAvailabilityCheck: async () => {},
    manualBrowserLauncher: secondManual.launch.bind(secondManual),
    processInspector,
    singletonLockInspector
  });
  t.after(() => second.stopAll());

  const recovered = await second.status("tiktok_discovery");
  assert.equal(recovered.mode, "manual_login");
  assert.equal(recovered.manualOwnerVerified, true);
  assert.equal((await second.checkLogin("tiktok_discovery")).state, "authenticated");
  await second.start("tiktok_discovery");
  assert.equal(secondManual.calls.length, 0);
  assert.equal(secondAutomation.calls.length, 0);
  assert.equal(secondAutomation.cdpCalls.length, 1);

  ownership.alive = false;
  ownership.lock = false;
  firstManual.calls[0].child.close(0);
  await second.stopAll();
  assert.equal(secondAutomation.calls.length, 0);
});

test("a recovered live routed Chrome requires a profile-preserving restart for a different discovery route", async (t) => {
  const dataDirectory = await tempDirectory(t);
  const profileDirectory = path.join(dataDirectory, "browser-profiles", "tiktok_discovery");
  const firstManual = fakeManualChromeLauncher();
  const ownership = { alive: false, lock: false };
  const processInspector = async () => ({
    alive: ownership.alive,
    executable: ownership.alive ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : null,
    command: ownership.alive
      ? `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=${profileDirectory} --remote-debugging-address=127.0.0.1 --remote-debugging-port=49232 --proxy-server=socks5://127.0.0.1:10800`
      : null,
    startedAt: ownership.alive ? "Sat Aug 22 13:00:00 2026" : null
  });
  const singletonLockInspector = async () => ({
    exists: ownership.lock,
    pid: ownership.lock ? 41_000 : null,
    parseable: true
  });
  const first = new SessionManager({
    dataDirectory,
    chromiumLauncher: fakeLauncher(),
    platform: "darwin",
    manualBrowserAvailabilityCheck: async () => {},
    manualBrowserLauncher: firstManual.launch.bind(firstManual),
    debugPortAllocator: async () => 49_232,
    processInspector,
    singletonLockInspector
  });
  await first.start("tiktok_discovery", { route: validRoute() });
  await mkdir(profileDirectory, { recursive: true });
  await writeFile(path.join(profileDirectory, "login-marker"), "preserved");
  ownership.alive = true;
  ownership.lock = true;
  await first.stopAll();

  const secondManual = fakeManualChromeLauncher();
  const secondAutomation = fakeLauncher();
  const second = new SessionManager({
    dataDirectory,
    chromiumLauncher: secondAutomation,
    platform: "darwin",
    manualBrowserAvailabilityCheck: async () => {},
    manualBrowserLauncher: secondManual.launch.bind(secondManual),
    processInspector,
    singletonLockInspector
  });
  t.after(() => second.stopAll());

  const result = await second.start("tiktok_discovery", {
    route: validRoute({
      discoveryCountry: "CA",
      discoveryProxyExitCountry: "CA",
      discoveryProxyServer: "http://127.0.0.1:10802"
    })
  });
  assert.equal(result.restartRequired, true);
  assert.equal(result.routeCountry, "US");
  assert.equal(secondManual.calls.length, 0);
  assert.equal(secondAutomation.calls.length, 0);
  assert.equal(secondAutomation.cdpCalls.length, 0);
  assert.equal((await second.checkLogin("tiktok_discovery")).state, "route_restart_required");
  assert.equal(await readFile(path.join(profileDirectory, "login-marker"), "utf8"), "preserved");

  ownership.alive = false;
  ownership.lock = false;
  firstManual.calls[0].child.close(0);
});

test("a legacy live SingletonLock owner without a loopback endpoint fails closed and never launches another browser", async (t) => {
  const dataDirectory = await tempDirectory(t);
  const profileDirectory = path.join(dataDirectory, "browser-profiles", "tiktok_discovery");
  const manual = fakeManualChromeLauncher();
  const automation = fakeLauncher();
  const manager = new SessionManager({
    dataDirectory,
    chromiumLauncher: automation,
    platform: "darwin",
    manualBrowserAvailabilityCheck: async () => {},
    manualBrowserLauncher: manual.launch.bind(manual),
    singletonLockInspector: async () => ({ exists: true, pid: 48_581, parseable: true }),
    processInspector: async () => ({
      alive: true,
      executable: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      command: `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=${profileDirectory}`,
      startedAt: "Sat Aug 22 12:10:00 2026"
    })
  });
  t.after(() => manager.stopAll());

  assert.equal((await manager.checkLogin("tiktok_discovery")).state, "manual_login_restart_required");
  await manager.start("tiktok_discovery");
  assert.equal(manual.calls.length, 0);
  assert.equal(automation.calls.length, 0);
});

test("an unverified live lock owner fails closed without takeover, lock deletion, or second launch", async (t) => {
  const dataDirectory = await tempDirectory(t);
  const manual = fakeManualChromeLauncher();
  const automation = fakeLauncher();
  const manager = new SessionManager({
    dataDirectory,
    chromiumLauncher: automation,
    platform: "darwin",
    manualBrowserAvailabilityCheck: async () => {},
    manualBrowserLauncher: manual.launch.bind(manual),
    singletonLockInspector: async () => ({ exists: true, pid: 777, parseable: true }),
    processInspector: async () => ({
      alive: true,
      executable: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      command: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --profile-directory=Default",
      startedAt: "Sat Aug 22 12:20:00 2026"
    })
  });
  t.after(() => manager.stopAll());

  const result = await manager.checkLogin("tiktok_discovery");
  assert.equal(result.state, "manual_login_owner_unverified");
  assert.equal(result.requiresUserAction, true);
  await manager.start("tiktok_discovery");
  assert.equal(manual.calls.length, 0);
  assert.equal(automation.calls.length, 0);
});

test("profile argv prefix lookalikes and URL text never authorize reset signals", async (t) => {
  const chromeExecutable = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const cases = [
    {
      name: "underscore suffix",
      commandFor: (profile) => `${chromeExecutable} --user-data-dir=${profile}_other`
    },
    {
      name: "child directory suffix",
      commandFor: (profile) => `${chromeExecutable} --user-data-dir=${profile}/child`
    },
    {
      name: "URL text prefix",
      commandFor: (profile) => `${chromeExecutable} https://www.tiktok.com/?next=--user-data-dir=${profile}`
    }
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const dataDirectory = await tempDirectory(t);
      const profileDirectory = path.join(dataDirectory, "browser-profiles", "tiktok_discovery");
      const signals = [];
      const manager = new SessionManager({
        dataDirectory,
        chromiumLauncher: fakeLauncher(),
        platform: "darwin",
        singletonLockInspector: async () => ({ exists: true, pid: 9_001, parseable: true }),
        processInspector: async () => ({
          alive: true,
          executable: chromeExecutable,
          command: entry.commandFor(profileDirectory),
          startedAt: "Sat Aug 22 12:25:00 2026"
        }),
        processSignaler: (pid, signal) => signals.push({ pid, signal })
      });

      await assert.rejects(manager.reset("tiktok_discovery"), /拒绝终止任何进程/);
      assert.equal(signals.length, 0);
    });
  }
});

test("an executable lookalike never authorizes a reset signal", async (t) => {
  const dataDirectory = await tempDirectory(t);
  const chromeExecutable = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const profileDirectory = path.join(dataDirectory, "browser-profiles", "tiktok_discovery");
  const signals = [];
  const manager = new SessionManager({
    dataDirectory,
    chromiumLauncher: fakeLauncher(),
    platform: "darwin",
    singletonLockInspector: async () => ({ exists: true, pid: 9_002, parseable: true }),
    processInspector: async () => ({
      alive: true,
      executable: `${chromeExecutable} Helper`,
      command: `${chromeExecutable} Helper --user-data-dir=${profileDirectory}`,
      startedAt: "Sat Aug 22 12:26:00 2026"
    }),
    processSignaler: (pid, signal) => signals.push({ pid, signal })
  });

  await assert.rejects(manager.reset("tiktok_discovery"), /拒绝终止任何进程/);
  assert.equal(signals.length, 0);
});

test("reset rechecks process identity immediately before SIGTERM and fails closed on TOCTOU", async (t) => {
  const dataDirectory = await tempDirectory(t);
  const chromeExecutable = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const profileDirectory = path.join(dataDirectory, "browser-profiles", "tiktok_discovery");
  const signals = [];
  let inspections = 0;
  const manager = new SessionManager({
    dataDirectory,
    chromiumLauncher: fakeLauncher(),
    platform: "darwin",
    singletonLockInspector: async () => ({ exists: true, pid: 9_003, parseable: true }),
    processInspector: async () => {
      inspections += 1;
      return {
        alive: true,
        executable: chromeExecutable,
        command: `${chromeExecutable} --user-data-dir=${profileDirectory}`,
        startedAt: inspections === 1 ? "Sat Aug 22 12:27:00 2026" : "Sat Aug 22 12:28:00 2026"
      };
    },
    processSignaler: (pid, signal) => signals.push({ pid, signal })
  });

  await assert.rejects(manager.reset("tiktok_discovery"), /关闭前发生变化/);
  assert.equal(inspections, 2);
  assert.equal(signals.length, 0);
});

test("reset signals only the exact in-memory dedicated Chrome process", async (t) => {
  const manual = fakeManualChromeLauncher();
  const dataDirectory = await tempDirectory(t);
  const profileDirectory = path.join(dataDirectory, "browser-profiles", "svip_legacy");
  const manager = new SessionManager({
    dataDirectory,
    chromiumLauncher: fakeLauncher(),
    platform: "darwin",
    manualBrowserAvailabilityCheck: async () => {},
    manualBrowserLauncher: manual.launch.bind(manual),
    singletonLockInspector: async () => ({ exists: false, pid: null, parseable: true }),
    processInspector: async () => {
      const alive = Boolean(manual.calls[0]?.child.pid);
      return {
        alive,
        executable: alive ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : null,
        command: alive
          ? `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=${profileDirectory}`
          : null,
        startedAt: alive ? "Sat Aug 22 12:30:00 2026" : null
      };
    }
  });

  await manager.start("svip_legacy");
  await manager.reset("svip_legacy");
  assert.equal(manual.calls[0].child.killed, "SIGTERM");
});

test("daemon stopAll preserves a still-open ordinary Chrome login process", async (t) => {
  const manual = fakeManualChromeLauncher();
  const manager = new SessionManager({
    dataDirectory: await tempDirectory(t),
    chromiumLauncher: fakeLauncher(),
    platform: "darwin",
    manualBrowserAvailabilityCheck: async () => {},
    manualBrowserLauncher: manual.launch.bind(manual)
  });

  await manager.start("svip_legacy");
  const stopped = await manager.stopAll();
  assert.deepEqual(stopped.stopped, []);
  assert.deepEqual(stopped.preservedManual, ["svip_legacy"]);
  assert.equal(manual.calls[0].child.killed, false);
});

test("page returns the in-process Page reference and reports unavailable sessions", async (t) => {
  const launcher = fakeLauncher();
  const manager = new SessionManager({ dataDirectory: await tempDirectory(t), chromiumLauncher: launcher, platform: "linux" });
  t.after(() => manager.stopAll());

  assert.throws(() => manager.page("tiktok_discovery"), /会话尚未启动/);
  await manager.start("tiktok_discovery", { startUrl: "https://www.tiktok.com/live" });
  const expectedPage = launcher.calls[0].context.pages()[0];
  assert.equal(manager.page("tiktok_discovery"), expectedPage);

  expectedPage.closed = true;
  launcher.calls[0].context.pageList = [];
  assert.throws(() => manager.page("tiktok_discovery"), /没有可用页面/);
});

test("navigation guard blocks foreign documents without blocking subresources", async (t) => {
  const launcher = fakeLauncher();
  const manager = new SessionManager({ dataDirectory: await tempDirectory(t), chromiumLauncher: launcher, platform: "linux" });
  t.after(() => manager.stopAll());
  await manager.start("svip_legacy");
  const handler = launcher.calls[0].context.routeHandler;

  let result = "";
  await handler({
    request: () => ({ resourceType: () => "document", url: () => "https://www.tiktok.com/" }),
    abort: async () => { result = "aborted"; },
    continue: async () => { result = "continued"; }
  });
  assert.equal(result, "aborted");

  await handler({
    request: () => ({ resourceType: () => "script", url: () => "https://cdn.example/app.js" }),
    abort: async () => { result = "aborted"; },
    continue: async () => { result = "continued"; }
  });
  assert.equal(result, "continued");
});

test("login checking is conservative and pauses for manual CAPTCHA", async (t) => {
  const launcher = fakeLauncher();
  const manager = new SessionManager({ dataDirectory: await tempDirectory(t), chromiumLauncher: launcher, platform: "linux" });
  t.after(() => manager.stopAll());

  await manager.start("tiktok_discovery");
  const tiktokPage = launcher.calls[0].context.pages()[0];
  tiktokPage.currentUrl = "https://www.tiktok.com/login?redirect=secret";
  tiktokPage.dom = { captcha: true, authentication: true, authenticated: false };
  const verification = await manager.checkLogin("tiktok_discovery");
  assert.equal(verification.state, "manual_verification");
  assert.equal(verification.requiresUserAction, true);
  assert.equal(verification.url.includes("secret"), false);

  tiktokPage.currentUrl = "https://www.tiktok.com/foryou";
  tiktokPage.dom = { captcha: false, authentication: false, authenticated: false };
  assert.equal((await manager.checkLogin("tiktok_discovery")).state, "unknown");

  tiktokPage.dom.authenticated = true;
  assert.equal((await manager.checkLogin("tiktok_discovery")).state, "authenticated");
});

test("collection sub-backend and legacy authenticated DOM markers prove authenticated state", async (t) => {
  const launcher = fakeLauncher();
  const manager = new SessionManager({ dataDirectory: await tempDirectory(t), chromiumLauncher: launcher, platform: "linux" });
  t.after(() => manager.stopAll());

  await manager.start("collection_backstage");
  const backstagePage = launcher.calls[0].context.pages()[0];
  backstagePage.currentUrl = "https://live-backstage.tiktok.com/portal/anchor/relation";
  backstagePage.dom.authenticated = true;
  assert.equal((await manager.checkLogin("collection_backstage")).state, "authenticated");

  await manager.start("svip_legacy");
  const legacyPage = launcher.calls[1].context.pages()[0];
  legacyPage.currentUrl = "https://svip.tiktokzb.com/index.html#/anchorList";
  legacyPage.dom.authenticated = true;
  assert.equal((await manager.checkLogin("svip_legacy")).state, "authenticated");
});

test("stale legacy application URL cannot override an explicit unauthenticated DOM result", async (t) => {
  const launcher = fakeLauncher();
  const manager = new SessionManager({ dataDirectory: await tempDirectory(t), chromiumLauncher: launcher, platform: "linux" });
  t.after(() => manager.stopAll());

  await manager.start("svip_legacy");
  const legacyPage = launcher.calls[0].context.pages()[0];
  legacyPage.currentUrl = "https://svip.tiktokzb.com/index.html#/anchorList";
  legacyPage.dom = { captcha: false, authentication: false, authenticated: false };

  const status = await manager.checkLogin("svip_legacy");
  assert.equal(status.state, "unknown");
  assert.equal(status.authenticated, null);
  assert.equal(status.requiresUserAction, false);
});

test("reset removes only the selected profile and stopAll closes remaining sessions", async (t) => {
  const dataDirectory = await tempDirectory(t);
  const launcher = fakeLauncher();
  const manager = new SessionManager({ dataDirectory, chromiumLauncher: launcher, platform: "linux" });
  await manager.start("tiktok_discovery");
  await manager.start("collection_backstage");

  const tiktokDirectory = manager.profileDirectory("tiktok_discovery");
  const backstageDirectory = manager.profileDirectory("collection_backstage");
  await mkdir(tiktokDirectory, { recursive: true });
  await mkdir(backstageDirectory, { recursive: true });
  await writeFile(path.join(tiktokDirectory, "marker"), "tiktok");
  await writeFile(path.join(backstageDirectory, "marker"), "backstage");

  await manager.reset("tiktok_discovery");
  assert.equal(launcher.calls[0].context.closed, true);
  await assert.rejects(readFile(path.join(tiktokDirectory, "marker")));
  assert.equal(await readFile(path.join(backstageDirectory, "marker"), "utf8"), "backstage");
  assert.equal((await manager.status("collection_backstage")).running, true);

  const stopped = await manager.stopAll();
  assert.deepEqual(stopped.stopped, ["collection_backstage"]);
  assert.equal(launcher.calls[1].context.closed, true);
});


test("run reuses rotating jars, initializes a lane once concurrently, and refreshes next run", async (t) => {
  const f = await feedSessionFixture(t);
  await f.manager.beginCountryWorkerRun("a");
  await Promise.all([f.manager.executeCountryFeedRequest(f.request, f.route), f.manager.executeCountryFeedRequest(f.request, f.route)]);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].observedCookies, ["COOKIE_TEST_SECRET", "rotated-by-first-response"]);
  assert.equal(f.calls[0].disposed, false);
  assert.equal(f.calls[0].responsesDisposed, 2);
  await f.manager.executeCountryFeedRequest({ ...f.request, workId: 2, countryCode: "QA", proxyServer: "http://127.0.0.1:17892" }, f.route);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].observedCookies[0], "COOKIE_TEST_SECRET");
  await f.manager.endCountryWorkerRun("a");
  assert.equal(f.calls.every(c => c.disposed), true);
  await f.manager.beginCountryWorkerRun("b");
  await f.manager.endCountryWorkerRun("a"); // stale cleanup cannot close b
  await f.manager.executeCountryFeedRequest(f.request, f.route);
  assert.equal(f.calls.length, 3);
  assert.equal(f.calls[2].observedCookies[0], "COOKIE_TEST_SECRET");
});

test("Data owns a separate authenticated jar and WorkID4 uses country physical lane", async (t) => {
  const f = await feedSessionFixture(t);
  await f.manager.beginCountryWorkerRun("data");
  await f.manager.executeCountryFeedRequest(f.request, f.route);
  const request = { ...f.request, stage: "basic", url: "https://www.tiktok.com/api-live/user/room/?uniqueId=creator", workId: 4,
    countryCode: "QA", proxyServer: "http://127.0.0.1:17892", headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36" } };
  await f.manager.executeCountryDataRequest(request, f.route);
  await f.manager.executeCountryDataRequest({ ...request, workId: 2, stage: "country", url: "https://webcast.us.tiktok.com/webcast/gift/list/?room_id=1" }, f.route);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].options.proxy.server, request.proxyServer);
  assert.equal(f.calls[1].getOptions.headers["user-agent"], request.headers["user-agent"]);
  assert.deepEqual(f.calls[1].observedCookies, ["COOKIE_TEST_SECRET", "rotated-by-first-response"]);
  await assert.rejects(f.manager.executeCountryDataRequest({ ...request, url: "https://api16-normal-c-useast1a.tiktokv.com/webcast/user/" }, f.route));
  await assert.rejects(f.manager.executeCountryDataRequest({ ...request, stage: "anchor_level" }, f.route));
});

test("run invalidates cached jars on authentication and collection route drift", async (t) => {
  for (const mode of ["auth", "route", "context"]) {
    const f = await feedSessionFixture(t);
    await f.manager.beginCountryWorkerRun(mode);
    await f.manager.executeCountryFeedRequest(f.request, f.route);
    if (mode === "auth") f.manager.sessions.get("tiktok_discovery").authenticated = false;
    if (mode === "context") f.manager.sessions.get("tiktok_discovery").context = { cookies: f.context.cookies };
    const route = mode === "route" ? { ...f.route, collectionLanes: f.route.collectionLanes.map((l, i) => i === 2 ? { ...l, proxyServer: "http://127.0.0.1:18993" } : l) } : f.route;
    await assert.rejects(f.manager.executeCountryFeedRequest(f.request, route));
    assert.equal(f.calls[0].disposed, true);
    assert.equal(f.calls.length, 1);
    f.manager.sessions.get("tiktok_discovery").context = f.context;
  }
});

test("run cleanup drains a request and pending initialization without leaking or admitting more work", async (t) => {
  const f = await feedSessionFixture(t);
  await f.manager.beginCountryWorkerRun("drain");
  let release;
  f.response.wait = new Promise(resolve => { release = resolve; });
  const request = f.manager.executeCountryFeedRequest(f.request, f.route);
  // Immediately end while cookie extraction/context creation is still pending.
  const ending = f.manager.endCountryWorkerRun("drain");
  await assert.rejects(f.manager.executeCountryFeedRequest(f.request, f.route));
  release();
  await Promise.allSettled([request]);
  await ending;
  assert.equal(f.calls.every(c => c.disposed), true);
});


test("an authentication-rejected HTTP response invalidates its run jar without replay", async (t) => {
  const f = await feedSessionFixture(t);
  await f.manager.beginCountryWorkerRun("reject");
  f.response.status = 401;
  await assert.rejects(f.manager.executeCountryFeedRequest(f.request, f.route), { code: "SESSION_REQUEST_AUTHENTICATION_REQUIRED" });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].disposed, true);
  await assert.rejects(f.manager.executeCountryFeedRequest(f.request, f.route));
  assert.equal(f.calls.length, 1);
});

test("stopAll drains run initialization and disposes the HTTP context exactly once", async (t) => {
  const f = await feedSessionFixture(t);
  await f.manager.beginCountryWorkerRun("stop");
  let release;
  const paused = new Promise(resolve => { release = resolve; });
  const cookies = f.context.cookies;
  f.context.cookies = async (...args) => { await paused; return cookies(...args); };
  const pending = f.manager.executeCountryFeedRequest(f.request, f.route);
  const stopping = f.manager.stopAll();
  release();
  await pending;
  await stopping;
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].disposed, true);
});

test("a first 401 fences concurrently queued same-lane PC and Data requests before they send", async (t) => {
  for (const family of ["pc", "data"]) {
    const f = await feedSessionFixture(t);
    await f.manager.beginCountryWorkerRun(`queued-auth-reject-${family}`);
    f.response.status = 401;
    const request = family === "pc" ? f.request : {
      ...f.request, stage: "basic", url: "https://www.tiktok.com/api-live/user/room/?uniqueId=creator"
    };
    const send = () => family === "pc"
      ? f.manager.executeCountryFeedRequest(request, f.route)
      : f.manager.executeCountryDataRequest(request, f.route);
    const results = await Promise.allSettled([send(), send()]);
    assert.deepEqual(results.map(result => result.status), ["rejected", "rejected"]);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].observedCookies.length, 1, `${family}: queued request must not reach HTTP get after the first 401`);
    assert.equal(f.calls[0].disposed, true);
  }
});


test("PC and Data retain the same jar for retry after network, oversize, and redirect errors", async (t) => {
  for (const family of ["pc", "data"]) {
    for (const mode of ["network", "oversize", "redirect"]) {
      const f = await feedSessionFixture(t);
      await f.manager.beginCountryWorkerRun(`retry-${family}-${mode}`);
      const request = family === "pc" ? f.request : {
        ...f.request, stage: "basic", url: "https://www.tiktok.com/api-live/user/room/?uniqueId=creator"
      };
      const send = candidate => family === "pc"
        ? f.manager.executeCountryFeedRequest(candidate, f.route)
        : f.manager.executeCountryDataRequest(candidate, f.route);
      f.response.error = mode === "network";
      f.response.status = mode === "redirect" ? 302 : 200;
      const firstRequest = mode === "oversize" ? { ...request, maxResponseBytes: 1 } : request;
      await assert.rejects(send(firstRequest));
      assert.equal(f.calls[0].disposed, false, `${family}/${mode} must retain retryable jar`);
      f.response.error = false;
      f.response.status = 200;
      assert.equal((await send(request)).status, 200);
      assert.equal(f.calls.length, 1);
      assert.equal(f.calls[0].observedCookies.length, 2);
      await f.manager.endCountryWorkerRun(`retry-${family}-${mode}`);
      assert.equal(f.calls[0].disposed, true);
    }
  }
});

test("queued PC and Data successors may send after a predecessor network failure", async (t) => {
  for (const family of ["pc", "data"]) {
    const f = await feedSessionFixture(t);
    await f.manager.beginCountryWorkerRun(`queued-network-${family}`);
    f.response.errorsRemaining = 1;
    const request = family === "pc" ? f.request : {
      ...f.request, stage: "basic", url: "https://www.tiktok.com/api-live/user/room/?uniqueId=creator"
    };
    const send = () => family === "pc"
      ? f.manager.executeCountryFeedRequest(request, f.route)
      : f.manager.executeCountryDataRequest(request, f.route);
    const results = await Promise.allSettled([send(), send()]);
    assert.deepEqual(results.map(result => result.status), ["rejected", "fulfilled"]);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].observedCookies.length, 2);
    assert.equal(f.calls[0].disposed, false);
  }
});

test("a transient HTTP-context initialization failure may initialize afresh on retry", async (t) => {
  const f = await feedSessionFixture(t);
  await f.manager.beginCountryWorkerRun("retry-initialization");
  const original = f.manager.requestContextFactory.newContext;
  let attempts = 0;
  f.manager.requestContextFactory.newContext = async options => {
    if (++attempts === 1) throw new Error("temporary initialization failure");
    return original(options);
  };
  await assert.rejects(f.manager.executeCountryFeedRequest(f.request, f.route), { code: "SESSION_REQUEST_FAILED" });
  assert.equal((await f.manager.executeCountryFeedRequest(f.request, f.route)).status, 200);
  assert.equal(attempts, 2);
  assert.equal(f.calls.length, 1);
});

for (const upstream of ["http401", "http403", "business20003"]) {
  test(`country ${upstream} revokes discovery readiness and fences queued PC/Data jars until fresh login`, async t => {
    const f = await feedSessionFixture(t);
    await f.manager.beginCountryWorkerRun(`header-rejection-${upstream}`);
    f.response.status = upstream === "http401" ? 401 : upstream === "http403" ? 403 : 200;
    f.response.body = upstream === "business20003" ? '{"status_code":20003}' : '{}';
    const data = { ...f.request, stage: "basic", url: "https://www.tiktok.com/api-live/user/room/?uniqueId=creator" };
    const results = await Promise.allSettled([
      f.manager.executeCountryFeedRequest(f.request, f.route), f.manager.executeCountryFeedRequest(f.request, f.route),
      f.manager.executeCountryDataRequest(data, f.route), f.manager.executeCountryDataRequest(data, f.route)
    ]);
    assert.ok(results.every(result => result.status === "rejected"));
    assert.equal((await f.manager.status("tiktok_discovery")).authenticatedRequestReady, false);
    assert.ok(f.calls.every(call => call.observedCookies.length <= 1 && call.disposed));
    assert.equal(f.manager.countryWorkerRun.invalidated, true);
    f.response.status = 200; f.response.body = '{"status_code":0,"data":[]}';
    await f.manager.checkLogin("tiktok_discovery");
    await f.manager.beginCountryWorkerRun(`fresh-login-${upstream}`);
    const before = f.calls.length;
    await f.manager.executeCountryFeedRequest(f.request, f.route);
    assert.equal(f.calls.length, before + 1, "new run must initialize a fresh browser-bound jar");
    assert.equal((await f.manager.status("tiktok_discovery")).authenticatedRequestReady, true);
  });
}

for (const replacement of ["session", "fresh_login"]) {
  test(`late old HTTP401 cannot revoke a ${replacement} authentication`, async t => {
    const f = await feedSessionFixture(t);
    await f.manager.beginCountryWorkerRun(`late-${replacement}`);
    let release;
    f.response.wait = new Promise(resolve => { release = resolve; });
    f.response.status = 401;
    const pending = f.manager.executeCountryFeedRequest(f.request, f.route);
    for (let attempt = 0; attempt < 100 && !f.calls[0]?.observedCookies.length; attempt++) await new Promise(r => setImmediate(r));
    assert.equal(f.calls[0].observedCookies.length, 1);
    if (replacement === "session") {
      const previous = f.manager.sessions.get("tiktok_discovery");
      f.manager.sessions.set("tiktok_discovery", { ...previous, context: { ...f.context, pages: () => f.context.pages(), close: async () => {} }, authenticated: true });
    } else await f.manager.checkLogin("tiktok_discovery");
    release();
    await assert.rejects(pending, { code: "SESSION_REQUEST_AUTHENTICATION_REQUIRED" });
    assert.equal((await f.manager.status("tiktok_discovery")).authenticatedRequestReady, true);
    assert.equal(f.manager.countryWorkerRun.invalidated, true);
  });
}

test("country business10011 does not revoke cookies or discovery readiness", async t => {
  const f = await feedSessionFixture(t);
  await f.manager.beginCountryWorkerRun("business-parameter-rejection");
  f.response.body = '{"status_code":10011}';
  await f.manager.executeCountryFeedRequest(f.request, f.route);
  await f.manager.executeCountryFeedRequest(f.request, f.route);
  assert.equal(f.calls.length, 1);
  assert.equal(f.manager.countryWorkerRun.invalidated, false);
  assert.equal((await f.manager.status("tiktok_discovery")).authenticatedRequestReady, true);
});

for (const family of ["pc", "data"]) {
  test(`one-off ${family} authorization rejection revokes discovery readiness without a worker run`, async t => {
    const f = await feedSessionFixture(t); f.response.status = 403;
    const request = family === "pc" ? f.request : { ...f.request, stage: "basic", url: "https://www.tiktok.com/api-live/user/room/?uniqueId=creator" };
    const pending = family === "pc" ? f.manager.executeCountryFeedRequest(request, f.route) : f.manager.executeCountryDataRequest(request, f.route);
    await assert.rejects(pending, { code: "SESSION_REQUEST_AUTHENTICATION_REQUIRED" });
    const status = await f.manager.status("tiktok_discovery");
    assert.equal(status.authenticatedRequestReady, false);
    assert.equal(status.authorizationFailure.reason, "http_403");
    assert.ok(status.authorizationFailure.observedAt); assert.equal(f.calls[0].disposed, true);
  });
}

test("authorization rejection fences a different-family initializer already awaiting its context", async t => {
  const f = await feedSessionFixture(t); await f.manager.beginCountryWorkerRun("cross-family-initializer");
  let release; const wait = new Promise(resolve => { release = resolve; });
  const original = f.manager.requestContextFactory.newContext;
  let initializationStarted; const started = new Promise(resolve => { initializationStarted = resolve; });
  f.manager.requestContextFactory.newContext = async options => {
    const context = await original(options);
    if (Object.keys(options.extraHTTPHeaders).length === 0) { initializationStarted(); await wait; }
    return context;
  };
  const data = f.manager.executeCountryDataRequest({ ...f.request, stage: "basic", url: "https://www.tiktok.com/api-live/user/room/?uniqueId=creator" }, f.route);
  await started; f.response.status = 401;
  const feed = f.manager.executeCountryFeedRequest(f.request, f.route);
  for (let attempt = 0; attempt < 100 && !f.manager.countryWorkerRun.invalidated; attempt++) await new Promise(r => setImmediate(r));
  const invalidated = f.manager.countryWorkerRun.invalidated; release();
  assert.equal(invalidated, true);
  const results = await Promise.allSettled([data, feed]);
  assert.ok(results.every(result => result.status === "rejected"));
  assert.equal(f.calls[0].observedCookies.length, 0); assert.equal(f.calls.every(call => call.disposed), true);
});

for (const change of ["session replacement", "upstream rejection"]) {
  test(`late checkLogin evidence cannot authenticate after ${change}`, async t => {
    const f = await feedSessionFixture(t); const previous = f.manager.sessions.get("tiktok_discovery");
    const page = f.context.pages()[0]; const evaluate = page.evaluate.bind(page);
    let release; const wait = new Promise(resolve => { release = resolve; });
    let inspectionStarted; const started = new Promise(resolve => { inspectionStarted = resolve; });
    page.evaluate = async (...args) => { inspectionStarted(); await wait; return evaluate(...args); };
    const check = f.manager.checkLogin("tiktok_discovery"); await started;
    if (change === "session replacement") f.manager.sessions.set("tiktok_discovery", { ...previous, authenticated: false });
    else { f.response.status = 401; await assert.rejects(f.manager.executeCountryFeedRequest(f.request, f.route)); }
    release(); const result = await check;
    assert.equal(result.state, "unknown"); assert.equal((await f.manager.status("tiktok_discovery")).authenticatedRequestReady, false);
  });
}


test("native fresh login fences the old run rather than reusing its earlier cookie jar", async t => {
  const f = await feedSessionFixture(t); await f.manager.beginCountryWorkerRun("old-login-generation");
  await f.manager.executeCountryFeedRequest(f.request, f.route); const before = f.calls[0].observedCookies.length;
  await f.manager.checkLogin("tiktok_discovery");
  await assert.rejects(f.manager.executeCountryFeedRequest(f.request, f.route));
  assert.equal(f.calls[0].observedCookies.length, before); assert.equal(f.calls[0].disposed, true);
  assert.equal((await f.manager.status("tiktok_discovery")).authenticatedRequestReady, true);
  await f.manager.beginCountryWorkerRun("new-login-generation"); await f.manager.executeCountryFeedRequest(f.request, f.route);
  assert.equal(f.calls.length, 2);
});

for (const family of ["pc", "data"]) {
  for (const [label, status, code] of [
    ["HTTP429-business20003", 429, 20003],
    ["HTTP503-business20003", 503, 20003],
    ["HTTP200-array-coercion", 200, [20003]]
  ]) {
    test(`${family} ${label} must not revoke discovery credentials`, async t => {
      const f = await feedSessionFixture(t); await f.manager.beginCountryWorkerRun(`strict-business-${family}-${label}`);
      f.response.status = status; f.response.body = JSON.stringify({ status_code: code });
      const request = family === "pc" ? f.request : { ...f.request, stage: "basic", url: "https://www.tiktok.com/api-live/user/room/?uniqueId=creator" };
      const execute = family === "pc" ? f.manager.executeCountryFeedRequest.bind(f.manager) : f.manager.executeCountryDataRequest.bind(f.manager);
      const result = await execute(request, f.route);
      assert.equal(result.status, status);
      assert.equal((await f.manager.status("tiktok_discovery")).authenticatedRequestReady, true);
      assert.equal(f.manager.countryWorkerRun.invalidated, false);
      assert.equal(f.calls[0].disposed, false);
      await execute(request, f.route); assert.equal(f.calls.length, 1);
    });
  }
  test(`${family} canonical string20003 at HTTP200 revokes discovery credentials`, async t => {
    const f = await feedSessionFixture(t); f.response.body = '{"status_code":"20003"}';
    const request = family === "pc" ? f.request : { ...f.request, stage: "basic", url: "https://www.tiktok.com/api-live/user/room/?uniqueId=creator" };
    const execute = family === "pc" ? f.manager.executeCountryFeedRequest.bind(f.manager) : f.manager.executeCountryDataRequest.bind(f.manager);
    await assert.rejects(execute(request, f.route), { code: "SESSION_REQUEST_AUTHENTICATION_REQUIRED" });
    assert.equal((await f.manager.status("tiktok_discovery")).authenticatedRequestReady, false);
  });
}
