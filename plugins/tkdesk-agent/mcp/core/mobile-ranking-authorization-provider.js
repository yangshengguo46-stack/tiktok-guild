import { request as playwrightRequest } from "playwright";
import {
  CoreConfigStore,
  DEFAULT_CORE_COUNTRY_PROFILES
} from "./core-config-store.js";
import { originalTopCodeContracts } from "./original-country-config.js";

const AUTHORIZATION_REQUIRED_CODE = "ranking_mobile_authorization_required";
const PROVIDER_FAILED_CODE = "ranking_mobile_authorization_provider_failed";
const REQUEST_REJECTED_CODE = "ranking_mobile_authorization_request_rejected";
const TRANSIENT_TRANSPORT_CODE = "ranking_mobile_authorization_transport_failed";
const ALLOWED_METHOD = "GET";
const ALLOWED_TIMEOUT_MS = 60_000;
const ALLOWED_REDIRECTS = 0;
const ALLOWED_NON_CREDENTIAL_HEADERS = Object.freeze({ "sdk-version": "2" });
const NUMERIC_ID = /^\d{5,32}$/;
const MIN_AUTHORIZATION_BYTES = 16;
const MAX_AUTHORIZATION_BYTES = 4096;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const SAFE_AUTHORIZATION_STATES = new Set([
  "ready",
  "missing",
  "expired",
  "unsupported_country",
  "market_mismatch",
  "invalid"
]);

function providerError(message, code, authorizationState = null) {
  const error = new Error(message);
  error.name = "MobileRankingAuthorizationError";
  error.code = code;
  if (authorizationState) error.authorizationState = authorizationState;
  return error;
}

function normalizedCountry(value) {
  const text = typeof value === "string" ? value.trim().toUpperCase() : "";
  return /^[A-Z]{2}$/.test(text) ? text : null;
}

function normalizedMarket(value) {
  const text = typeof value === "string" ? value.trim().toUpperCase() : "";
  return /^[A-Z0-9_-]{2,32}$/.test(text) ? text : null;
}

function safeAuthorizationState(value) {
  return typeof value === "string" && SAFE_AUTHORIZATION_STATES.has(value) ? value : "invalid";
}

function allowedRankRequests(profile) {
  const contracts = originalTopCodeContracts(profile.topCode);
  return new Set([
    "16:0",
    "16:-1",
    "15:0",
    "15:-1",
    `${contracts.topScore.rankTypeCode}:${contracts.topScore.gapInterval}`,
    ...(contracts.historyRankScore.state === "requested"
      ? [`${contracts.historyRankScore.rankTypeCode}:${contracts.historyRankScore.gapInterval}`]
      : [])
  ]);
}

function safeLoopbackProxy(value) {
  try {
    const url = new URL(String(value));
    if (!["http:", "https:", "socks5:"].includes(url.protocol)
      || !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname.toLowerCase())
      || url.username
      || url.password
      || !url.port
      || (url.pathname && url.pathname !== "/")
      || url.search
      || url.hash) {
      return null;
    }
    return `${url.protocol}//${url.hostname}:${url.port}`;
  } catch {
    return null;
  }
}

function profileFor({ marketRegion, countryCode, endpointProfileId } = {}) {
  const market = normalizedMarket(marketRegion);
  const country = normalizedCountry(countryCode);
  if (!market || !country || typeof endpointProfileId !== "string") return null;
  return DEFAULT_CORE_COUNTRY_PROFILES.find((candidate) => (
    candidate.marketRegion === market
    && candidate.countryCode === country
    && candidate.profileId === endpointProfileId
  )) ?? null;
}

function safePublicStatus(state, reason = null, source = "user_owned_core_config") {
  return Object.freeze({
    state,
    usable: state === "ready",
    reason,
    source,
    secretValuesExposed: false
  });
}

function authorizationStateFromCoreStatus(coreStatus, scope, resolveProfile = profileFor) {
  if (coreStatus?.state === "uninitialized") return "missing";
  if (coreStatus?.state !== "ready") return "invalid";
  const authorization = coreStatus.mobileAuthorization;
  if (!authorization?.usable) return safeAuthorizationState(authorization?.state ?? "missing");
  const market = normalizedMarket(scope?.marketRegion);
  const country = normalizedCountry(scope?.countryCode);
  if (!market || market !== authorization.marketRegion) return "market_mismatch";
  if (!country || !authorization.countryCodes?.includes(country)) return "unsupported_country";
  if (!resolveProfile(scope)) return "unsupported_country";
  return "ready";
}

function expectedQuery(profile, url) {
  const anchorId = url.searchParams.get("anchor_id");
  const roomId = url.searchParams.get("room_id");
  const rankType = url.searchParams.get("rank_type");
  const regionType = url.searchParams.get("region_type");
  const gapInterval = url.searchParams.get("gap_interval");
  if (!NUMERIC_ID.test(anchorId ?? "")
    || !NUMERIC_ID.test(roomId ?? "")
    || regionType !== String(profile.regionTypeCode)
    || !allowedRankRequests(profile).has(`${rankType}:${gapInterval}`)) {
    return null;
  }
  return new Map([
    ["anchor_id", anchorId],
    ["room_id", roomId],
    ["rank_type", rankType],
    ["region_type", regionType],
    ["gap_interval", gapInterval],
    ...Object.entries(profile.baseParams)
  ]);
}

function requestAllowed(request, { profile, proxyServer }) {
  if (!request || typeof request !== "object" || Array.isArray(request)
    || request.method !== ALLOWED_METHOD
    || request.proxyServer !== proxyServer
    || request.timeoutMs !== ALLOWED_TIMEOUT_MS
    || request.maxRedirects !== ALLOWED_REDIRECTS) {
    return false;
  }
  let url;
  let canonical;
  try {
    url = new URL(request.url);
    canonical = new URL(profile.canonicalUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "https:"
    || url.origin !== canonical.origin
    || url.pathname !== canonical.pathname
    || url.username
    || url.password
    || url.hash) {
    return false;
  }
  const expected = expectedQuery(profile, url);
  if (!expected || url.searchParams.size !== expected.size) return false;
  for (const [key, value] of expected) {
    if (url.searchParams.getAll(key).length !== 1 || url.searchParams.get(key) !== value) return false;
  }
  if (!request.headers || typeof request.headers !== "object" || Array.isArray(request.headers)) return false;
  const actualHeaders = Object.entries(request.headers)
    .map(([key, value]) => [String(key).toLowerCase(), String(value)])
    .sort(([left], [right]) => left.localeCompare(right));
  const expectedHeaders = Object.entries({
    "user-agent": profile.mobileUserAgent,
    ...ALLOWED_NON_CREDENTIAL_HEADERS
  }).sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify(actualHeaders) === JSON.stringify(expectedHeaders);
}

function responseStatus(response) {
  const value = typeof response?.status === "function" ? response.status() : response?.status;
  return Number.isSafeInteger(value) ? value : null;
}

function businessStatus(payload) {
  const value = payload?.status_code ?? payload?.statusCode ?? payload?.code;
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && /^(0|[1-9]\d*)$/.test(value) && Number.isSafeInteger(Number(value))) return Number(value);
  return null;
}

function validAuthorizationBuffer(value) {
  if (!Buffer.isBuffer(value)
    || value.length < MIN_AUTHORIZATION_BYTES
    || value.length > MAX_AUTHORIZATION_BYTES) {
    return false;
  }
  return value.every((byte) => byte >= 0x21 && byte <= 0x7e);
}

async function responseBody(response) {
  if (typeof response?.body === "string") return response.body;
  if (response?.body instanceof Uint8Array) return Buffer.from(response.body).toString("utf8");
  if (typeof response?.text === "function") return response.text();
  return "";
}

export function isMobileRankingAuthorizationError(error) {
  return error?.name === "MobileRankingAuthorizationError"
    && [
      AUTHORIZATION_REQUIRED_CODE,
      PROVIDER_FAILED_CODE,
      REQUEST_REJECTED_CODE,
      TRANSIENT_TRANSPORT_CODE
    ].includes(error?.code);
}

export function createMobileRankingAuthorizationProvider({
  coreConfigStore = null,
  dataDirectory = null,
  requestContextFactory = playwrightRequest,
  profileResolver = null,
  clock = () => Date.now()
} = {}) {
  const resolveProfile = typeof profileResolver === "function" ? profileResolver : profileFor;
  const store = coreConfigStore ?? (dataDirectory ? new CoreConfigStore({ dataDirectory }) : null);
  // Observations contain no credential or response data and are process-local.
  // A rejected host remains fenced even when an older successful call returns.
  const observations = new Map();
  const hostFor = profile => profile ? new URL(profile.canonicalUrl).hostname : null;
  const onlineStatus = (scope = {}) => {
    const observation = observations.get(hostFor(resolveProfile(scope)));
    const current = observation?.state === "rejected"
      || (observation?.state === "verified" && clock() - observation.at >= 0 && clock() - observation.at < 300_000);
    return Object.freeze({
      state: current ? observation.state : "unknown",
      reason: current ? observation.reason : null,
      observedAt: observation ? new Date(observation.at).toISOString() : null,
      verificationScope: "fixed_endpoint_authorization",
      persistsAcrossRestart: false
    });
  };
  const assertHostAvailable = host => {
    if (observations.get(host)?.state === "rejected") {
      throw providerError("移动榜单授权已被上游拒绝，需要重新维护", AUTHORIZATION_REQUIRED_CODE, "upstream_rejected");
    }
  };
  const rejectHost = (host, reason) => {
    if (observations.get(host)?.state !== "rejected") observations.set(host, { state: "rejected", reason, at: clock() });
  };

  return Object.freeze({
    onlineStatus,
    async status(scope = {}) {
      let configurationState = "invalid";
      let source = "user_owned_core_config";
      let reason = "provider_unconfigured";
      if (store && typeof store.status === "function") {
        try {
          const coreStatus = await store.status(scope);
          configurationState = authorizationStateFromCoreStatus(coreStatus, scope, resolveProfile);
          source = coreStatus.mobileAuthorization?.provenance === "user_authorized_original_bundle" ? "user_authorized_original_bundle" : source;
          reason = configurationState === "ready" ? null : configurationState;
        } catch { reason = "core_status_failed"; }
      }
      // Read the observation again after an asynchronous configuration read.
      const latest = onlineStatus(scope);
      const rejected = latest.state === "rejected";
      return Object.freeze({
        ...safePublicStatus(configurationState === "ready" && !rejected ? "ready" : "authorization_required", rejected ? "upstream_rejected" : reason, source),
        configurationState,
        onlineAuthorization: latest,
        onlineVerified: configurationState === "ready" && latest.state === "verified"
      });
    },

    async openLease(scope = {}) {
      const profile = resolveProfile(scope);
      const proxyServer = safeLoopbackProxy(scope.proxyServer);
      if (!profile || !proxyServer) throw providerError("移动榜单授权请求范围无效", REQUEST_REJECTED_CODE);
      const host = hostFor(profile);
      assertHostAvailable(host);
      if (!store || typeof store.resolveMobileAuthorization !== "function") {
        throw providerError("移动榜单授权尚未配置", AUTHORIZATION_REQUIRED_CODE, "missing");
      }
      let resolved;
      try {
        resolved = await store.resolveMobileAuthorization({ marketRegion: profile.marketRegion,
          countryCode: profile.countryCode, endpointProfileId: profile.profileId });
      } catch { throw providerError("移动榜单授权读取失败", PROVIDER_FAILED_CODE); }
      const sourceValue = resolved?.value;
      try { assertHostAvailable(host); } catch (error) { sourceValue?.fill?.(0); throw error; }
      if (resolved?.status !== "ready") {
        sourceValue?.fill?.(0);
        throw providerError("移动榜单授权不可用", AUTHORIZATION_REQUIRED_CODE, safeAuthorizationState(resolved?.status));
      }
      if (resolved.kind !== "x-tt-token" || !validAuthorizationBuffer(sourceValue)) {
        sourceValue?.fill?.(0);
        throw providerError("移动榜单授权结构无效", PROVIDER_FAILED_CODE);
      }
      const authorizationValue = Buffer.from(sourceValue);
      sourceValue.fill(0);
      let context = null;
      try {
        if (!requestContextFactory || typeof requestContextFactory.newContext !== "function") {
          throw providerError("移动榜单请求执行器不可用", PROVIDER_FAILED_CODE);
        }
        context = await requestContextFactory.newContext({
          proxy: { server: proxyServer }, userAgent: profile.mobileUserAgent,
          extraHTTPHeaders: { ...ALLOWED_NON_CREDENTIAL_HEADERS, [resolved.kind]: authorizationValue.toString("utf8") },
          ignoreHTTPSErrors: false
        });
        assertHostAvailable(host);
        if (!context || typeof context.get !== "function" || typeof context.dispose !== "function") {
          throw providerError("移动榜单请求执行器无效", PROVIDER_FAILED_CODE);
        }
      } catch (error) {
        try { await context?.dispose?.(); } catch { /* Public errors never copy executor diagnostics. */ }
        if (isMobileRankingAuthorizationError(error)) throw error;
        throw providerError("移动榜单授权会话创建失败", PROVIDER_FAILED_CODE);
      } finally { authorizationValue.fill(0); }

      let closed = false;
      let tail = Promise.resolve();
      return Object.freeze({
        execute(request) {
          if (closed) return Promise.reject(providerError("移动榜单授权会话已关闭", PROVIDER_FAILED_CODE));
          if (!requestAllowed(request, { profile, proxyServer })) {
            return Promise.reject(providerError("移动榜单请求不符合固定安全配置", REQUEST_REJECTED_CODE));
          }
          const operation = tail.then(async () => {
            assertHostAvailable(host);
            try {
              const response = await context.get(request.url, { timeout: ALLOWED_TIMEOUT_MS,
                failOnStatusCode: false, maxRedirects: ALLOWED_REDIRECTS });
              const status = responseStatus(response);
              if (status === 401 || status === 403) {
                rejectHost(host, `http_${status}`);
                throw providerError("移动榜单授权已被上游拒绝", AUTHORIZATION_REQUIRED_CODE, "upstream_rejected");
              }
              const body = await responseBody(response);
              if (Buffer.byteLength(body, "utf8") > MAX_RESPONSE_BYTES) {
                throw providerError("移动榜单响应超过上限", REQUEST_REJECTED_CODE);
              }
              let payload;
              try { payload = JSON.parse(body); } catch { /* Transport owns response parsing failures. */ }
              const code = businessStatus(payload);
              if (status >= 200 && status < 300 && code === 20003) {
                rejectHost(host, "business_20003");
                throw providerError("移动榜单登录状态已被上游拒绝", AUTHORIZATION_REQUIRED_CODE, "upstream_rejected");
              }
              if (status >= 200 && status < 300 && code === 0 && observations.get(host)?.state !== "rejected") {
                observations.set(host, { state: "verified", reason: null, at: clock() });
              }
              return { status, body };
            } catch (error) {
              if (isMobileRankingAuthorizationError(error)) throw error;
              throw providerError("移动榜单请求暂时失败", TRANSIENT_TRANSPORT_CODE);
            }
          });
          tail = operation.catch(() => {});
          return operation;
        },
        reportAuthorizationRequired() { rejectHost(host, "transport_authorization_required"); },
        async close() {
          if (closed) return;
          closed = true;
          await tail;
          const disposable = context;
          context = null;
          try { await disposable?.dispose?.(); } catch {
            throw providerError("移动榜单授权会话关闭失败", PROVIDER_FAILED_CODE);
          }
        }
      });
    }
  });
}

export const MOBILE_RANKING_AUTHORIZATION_PROVIDER_PROFILE = Object.freeze({
  providerKind: "user_owned_core_config",
  fixedMethod: ALLOWED_METHOD,
  requestTimeoutMs: ALLOWED_TIMEOUT_MS,
  maxRedirects: ALLOWED_REDIRECTS,
  supportedCountries: Object.freeze([...new Set(
    DEFAULT_CORE_COUNTRY_PROFILES.map((profile) => profile.countryCode)
  )].sort()),
  supportedMarketRegions: Object.freeze([...new Set(
    DEFAULT_CORE_COUNTRY_PROFILES.map((profile) => profile.marketRegion)
  )].sort()),
  executableProfileCount: DEFAULT_CORE_COUNTRY_PROFILES.length,
  secretValuesExposed: false
});
