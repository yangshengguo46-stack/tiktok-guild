import crypto from "node:crypto";
import { httpResponseDiagnostics, transportFailureDiagnostics } from "./http-response-diagnostics.js";
import { sanitizeTikTokText } from "../adapters/tiktok-live.js";
import {
  originalCountryConfigurationForRoute,
  originalExecutableProfiles
} from "./original-country-config.js";
import {
  originalWebLiveProfileForCountry
} from "./original-web-live-config.js";

const ORIGINAL_FEED_CHANNEL_IDS = Object.freeze([21, 1, 2, 3, 44]);
// V10's archived source now returns 10011. The official LIVE page and a
// same-lane HTTP comparison on 2026-09-26 verified this replacement source.
// Keep the archived country catalog intact; only the runtime Feed contract changes.
const FEED_ORIGIN = "https://webcast.tiktok.com";
const FEED_REQUEST_FROM = "live_mt_pc_web_rec_tab_refresh";
const FEED_CHANNEL_IDS = Object.freeze([87]);
const FEED_COMPATIBILITY_VERSION = "tiktok-web-feed-20260926";
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const FEED_SEED_DEDUPE_TTL_SECONDS = 300;
const NUMERIC_ID = /^\d{5,32}$/;
const HANDLE = /^[a-z\d._]{1,64}$/i;

const FEED_ADAPTER_EVIDENCE_VERSION = "original-pc-web-feed-v4";

function notReady(reason, details = {}) {
  return Object.freeze({
    status: "capability_not_ready",
    capability: "original_country_live_feed",
    source: "tiktok_webcast_country_live_feed",
    reason,
    candidates: [],
    ...details
  });
}

function normalizedCountry(value) {
  const text = typeof value === "string" ? value.trim().toUpperCase() : "";
  return /^[A-Z]{2}$/.test(text) ? text : null;
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

function exactWorkId(value) {
  return Number.isSafeInteger(value) && value >= 1 && value <= 3 ? value : null;
}

function collectionLane(verifiedRoute, targetCountry, requestedWorkId) {
  if (verifiedRoute?.collectionLanes !== undefined) {
    const rawLanes = verifiedRoute.collectionLanes;
    const rawExitCountries = verifiedRoute?.collectionProxyExitCountries;
    if (!Array.isArray(rawLanes)
      || rawLanes.length < 1
      || rawLanes.length > 3
      || (rawExitCountries !== undefined
        && (!Array.isArray(rawExitCountries) || rawExitCountries.length !== rawLanes.length))) {
      return { ok: false, reason: "feed_lane_route_invalid" };
    }
    const lanes = [];
    const countries = new Set();
    const proxies = new Set();
    for (let laneIndex = 0; laneIndex < rawLanes.length; laneIndex += 1) {
      const rawLane = rawLanes[laneIndex];
      const countryCode = normalizedCountry(rawLane?.countryCode);
      const arrayExitCountry = normalizedCountry(rawExitCountries?.[laneIndex]);
      const inlineExitCountry = normalizedCountry(rawLane?.observedExitCountry);
      const exitCountry = inlineExitCountry ?? arrayExitCountry;
      if (!rawLane || typeof rawLane !== "object" || Array.isArray(rawLane)
        || (rawLane.workId !== undefined && rawLane.workId !== laneIndex + 1)
        || !countryCode
        || !exitCountry
        || (rawLane.verified !== undefined && rawLane.verified !== true)) {
        return { ok: false, reason: "feed_lane_route_invalid" };
      }
      if (inlineExitCountry && arrayExitCountry && inlineExitCountry !== arrayExitCountry) {
        return { ok: false, reason: "feed_route_country_mismatch" };
      }
      if (exitCountry !== countryCode) {
        return { ok: false, reason: "feed_route_country_mismatch" };
      }
      const proxyServer = safeLoopbackProxy(rawLane.proxyServer);
      if (!proxyServer) return { ok: false, reason: "feed_proxy_not_allowed" };
      if (countries.has(countryCode) || proxies.has(proxyServer)) {
        return { ok: false, reason: "feed_lane_route_invalid" };
      }
      countries.add(countryCode);
      proxies.add(proxyServer);
      lanes.push({ countryCode, exitCountry, proxyServer });
    }
    const workId = exactWorkId(requestedWorkId);
    if (workId === null || workId > lanes.length) {
      return { ok: false, reason: "feed_work_id_invalid" };
    }
    const laneIndex = workId - 1;
    const lane = lanes[laneIndex];
    if (targetCountry && lane.countryCode !== targetCountry) {
      return { ok: false, reason: "feed_route_country_mismatch" };
    }
    return {
      ok: true,
      proxyServer: lane.proxyServer,
      countryCode: lane.countryCode,
      workId,
      collectionLaneEvidence: Object.freeze({
        topology: "original_country_lane",
        workId,
        laneIndex,
        countryCode: lane.countryCode,
        exitCountry: lane.exitCountry,
        affinity: "sticky_work_id"
      })
    };
  }

  // The singular route remains available only for legacy diagnostics.  Once a
  // WorkID is present, silently collapsing it to one proxy would break the
  // original program's sticky-lane semantics.
  if (requestedWorkId !== undefined && requestedWorkId !== null) {
    return { ok: false, reason: "feed_lane_route_invalid" };
  }
  const exitCountry = normalizedCountry(
    verifiedRoute?.collectionProxyExitCountry ?? verifiedRoute?.proxyExitCountry
  );
  if (!exitCountry || (targetCountry && exitCountry !== targetCountry)) {
    return { ok: false, reason: "feed_route_country_mismatch" };
  }
  const proxyServer = safeLoopbackProxy(verifiedRoute?.collectionProxyServer);
  if (!proxyServer) return { ok: false, reason: "feed_proxy_not_allowed" };
  return {
    ok: true,
    proxyServer,
    countryCode: exitCountry,
    workId: null,
    collectionLaneEvidence: Object.freeze({
      topology: "legacy_single_lane",
      workId: null,
      laneIndex: null,
      countryCode: exitCountry,
      exitCountry,
      affinity: "single_route"
    })
  };
}

function fixedFeedUrl(channelId, profile) {
  const url = new URL(profile.path, FEED_ORIGIN);
  for (const [key, value] of Object.entries(profile.publicQuery)) url.searchParams.set(key, value);
  url.searchParams.set("channel_id", String(channelId));
  url.searchParams.set("req_from", FEED_REQUEST_FROM);
  return url.href;
}

function boundedInteger(value, fallback, minimum, maximum) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : fallback;
}

function numericId(value) {
  const text = typeof value === "string" || typeof value === "number"
    ? String(value).trim()
    : "";
  return NUMERIC_ID.test(text) ? text : null;
}

function text(value, limit) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const output = String(value).trim();
  return output ? output.slice(0, limit) : null;
}

function nonNegativeInteger(value) {
  const number = typeof value === "string" && /^\d+$/.test(value.trim())
    ? Number(value.trim())
    : value;
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function nullableBoolean(value) {
  return typeof value === "boolean" ? value : null;
}

function projectFeedSeeds(payload, {
  limit,
  marketRegion,
  routeMemberCountryCodes,
  feedOrigin,
  feedPath,
  countryCode,
  observedAt,
  workId,
  collectionLaneEvidence
}) {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.data)) return null;
  const results = [];
  const seen = new Set();
  for (const item of payload.data) {
    if (results.length >= limit) break;
    const room = item?.data ?? item;
    const owner = room?.owner;
    if (!room || !owner || typeof room !== "object" || typeof owner !== "object") continue;
    const roomId = numericId(room.id_str ?? room.id ?? room.room_id_str ?? room.room_id);
    const userId = numericId(owner.id_str ?? owner.id ?? room.owner_user_id);
    const rawHandle = text(owner.display_id ?? owner.unique_id, 64)?.replace(/^@/, "") ?? null;
    const handle = rawHandle && HANDLE.test(rawHandle) ? rawHandle : null;
    if (!roomId || !userId || !handle) continue;
    const identity = `user:${userId}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    const rawSecUid = text(owner.sec_uid, 256);
    const secUid = rawSecUid && /^[a-z\d_-]{8,256}$/i.test(rawSecUid) ? rawSecUid : null;
    const rawCreatorCountryCode = text(owner.region ?? owner.country_code, 16)?.toUpperCase() ?? null;
    if (rawCreatorCountryCode && !routeMemberCountryCodes.has(rawCreatorCountryCode)) continue;
    const creatorCountryCode = routeMemberCountryCodes.has(rawCreatorCountryCode)
      ? rawCreatorCountryCode
      : null;
    results.push({
      candidateId: null,
      candidateKey: `tiktok:user:${userId}`,
      userId,
      secUid,
      handle,
      displayName: text(owner.nickname, 160),
      profileUrl: `https://www.tiktok.com/@${encodeURIComponent(handle)}`,
      roomId,
      followerCount: nonNegativeInteger(owner.follow_info?.follower_count),
      viewerCount: nonNegativeInteger(room.user_count),
      live: true,
      seller: nullableBoolean(room.has_commerce_goods),
      liveTag: text(room.hashtag?.id, 80),
      creatorCountryCode,
      countryCode: creatorCountryCode,
      rankingScopeMarketRegion: marketRegion,
      rankingScopeCountryCode: countryCode,
      rankingScopeCountryEvidence: "verified_collection_proxy_exit_and_versioned_web_live_profile",
      workId,
      collectionLaneEvidence,
      source: "tiktok_webcast_country_live_feed",
      sourceUrl: `${feedOrigin}${feedPath}`,
      observedAt,
      confidence: 0.98,
      discovery: {
        triggerKind: "original_pc_web_feed",
        channelIdObserved: null,
        displayIdDedupeTtlSeconds: FEED_SEED_DEDUPE_TTL_SECONDS,
        adapterEvidenceVersion: FEED_ADAPTER_EVIDENCE_VERSION
      },
      rawEvidence: {
        source: "tiktok_webcast_feed_room_projection",
        roomId,
        userId,
        observedAt
      }
    });
  }
  return results;
}

function responseStatus(response) {
  const value = typeof response?.status === "function" ? response.status() : response?.status;
  return Number.isSafeInteger(value) ? value : null;
}

function responseUrl(response) {
  const value = typeof response?.url === "function" ? response.url() : response?.url;
  return typeof value === "string" ? value : "";
}

async function responseBody(response) {
  if (typeof response?.body === "string") return response.body;
  if (response?.body instanceof Uint8Array) return Buffer.from(response.body).toString("utf8");
  if (typeof response?.text === "function") return response.text();
  return "";
}

function finalResponseAllowed(response, profile) {
  try {
    const url = new URL(responseUrl(response));
    return url.protocol === "https:"
      && url.origin === FEED_ORIGIN
      && url.pathname === profile.path;
  } catch {
    return false;
  }
}

export function createTikTokLiveFeedTransport({
  requestExecutor = null,
  randomInt = crypto.randomInt
} = {}) {
  const execute = typeof requestExecutor === "function"
    ? requestExecutor
    : () => { const error = new Error("feed session executor unavailable"); error.code = "COUNTRY_FEED_SESSION_UNAVAILABLE"; throw error; };
  return Object.freeze({
    async fetchOnce({
      verifiedRoute,
      marketRegion,
      countryCode,
      displayName = null,
      workId,
      limit = 30,
      shouldStop = () => false
    } = {}) {
      const normalizedMarket = typeof marketRegion === "string" ? marketRegion.trim().toUpperCase() : "";
      const requestedTargetCountry = normalizedCountry(countryCode);
      if (!normalizedMarket
        || (countryCode !== undefined && countryCode !== null && !requestedTargetCountry)) {
        return notReady("feed_country_profile_not_configured");
      }
      const lane = collectionLane(verifiedRoute, requestedTargetCountry, workId);
      if (!lane.ok) return notReady(lane.reason);
      const normalizedTargetCountry = requestedTargetCountry ?? lane.countryCode;
      const webLiveProfile = originalWebLiveProfileForCountry({
        marketRegion: normalizedMarket,
        countryCode: normalizedTargetCountry,
        displayName
      });
      const routeConfiguration = originalCountryConfigurationForRoute(normalizedMarket);
      if (!webLiveProfile || !routeConfiguration) {
        return notReady("feed_country_profile_not_configured");
      }
      if (shouldStop()) return notReady("collection_stopped");
      const boundedLimit = boundedInteger(limit, 30, 1, 100);
      const channelId = FEED_CHANNEL_IDS[randomInt(FEED_CHANNEL_IDS.length)];
      let response;
      const startedAt = Date.now();
      try {
        response = await execute(Object.freeze({
          method: "GET",
          stage: "feed",
          sessionTarget: "tiktok_discovery",
          requiresAuthenticatedSession: true,
          sessionBinding: "discovery_cookie_country_http_lease",
          workId: lane.workId,
          countryCode: lane.countryCode,
          url: fixedFeedUrl(channelId, webLiveProfile),
          proxyServer: lane.proxyServer,
          userAgent: webLiveProfile.publicQuery.browser_version,
          timeoutMs: REQUEST_TIMEOUT_MS,
          maxResponseBytes: MAX_RESPONSE_BYTES,
          maxRedirects: 0,
          headers: Object.freeze({ accept: "application/json, text/plain, */*" })
        }), { verifiedRoute });
      } catch (error) {
        const reason = ["COUNTRY_FEED_SESSION_UNAVAILABLE", "SESSION_REQUEST_PAGE_UNAVAILABLE", "SESSION_REQUEST_URL_NOT_ALLOWED", "SESSION_REQUEST_HEADERS_NOT_ALLOWED", "SESSION_REQUEST_INVALID"].includes(error?.code)
          ? "feed_session_unavailable"
          : error?.code === "SESSION_REQUEST_AUTHENTICATION_REQUIRED"
            ? "feed_authentication_required"
            : error?.code === "SESSION_REQUEST_RUN_CLOSED"
              ? "feed_session_run_closed"
            : ["SESSION_REQUEST_PROXY_MISMATCH", "SESSION_REQUEST_PROXY_INVALID", "SESSION_REQUEST_PROXY_UNVERIFIED", "SESSION_ROUTE_RESTART_REQUIRED"].includes(error?.code)
              ? "feed_route_country_mismatch"
              : "feed_transport_failed";
        return notReady(reason, { diagnostics: transportFailureDiagnostics(error, startedAt) });
      }
      const status = responseStatus(response);
      if (status === null) return notReady("feed_http_status_missing");
      if (status >= 300 && status < 400) return notReady("feed_redirect_rejected");
      if (status !== 200 || !finalResponseAllowed(response, webLiveProfile)) {
        return notReady("feed_http_rejected", { httpStatus: status });
      }
      const body = await responseBody(response);
      const diagnostics = httpResponseDiagnostics(response, body, startedAt);
      if (Buffer.byteLength(body, "utf8") > MAX_RESPONSE_BYTES) {
        return notReady("feed_response_too_large");
      }
      let payload;
      try {
        payload = JSON.parse(body);
      } catch {
        return notReady("feed_response_not_json", { diagnostics });
      }
      if (Number(payload?.status_code ?? payload?.statusCode) !== 0) {
        // Keep only the platform's human-readable reason, never its raw response
        // or request identifiers. Sanitize before truncating credential values.
        const message = [payload?.status_msg, payload?.status_message, payload?.message,
          payload?.data?.message, payload?.data?.prompts]
          .find((value) => typeof value === "string" && value.trim());
        const businessMessage = message
          ? sanitizeTikTokText(message).replace(/[\r\n\t]+/g, " ").trim().slice(0, 240)
          : null;
        return notReady("feed_business_rejected", {
          diagnostics,
          businessStatusCode: Number.isSafeInteger(Number(payload?.status_code ?? payload?.statusCode))
            ? Number(payload?.status_code ?? payload?.statusCode)
            : null,
          ...(businessMessage ? { businessMessage } : {})
        });
      }
      const observedAt = new Date().toISOString();
      const candidates = projectFeedSeeds(payload, {
        limit: boundedLimit,
        marketRegion: normalizedMarket,
        routeMemberCountryCodes: new Set(routeConfiguration.memberCountryCodes),
        feedOrigin: FEED_ORIGIN,
        feedPath: webLiveProfile.path,
        countryCode: normalizedTargetCountry,
        observedAt,
        workId: lane.workId,
        collectionLaneEvidence: lane.collectionLaneEvidence
      });
      if (!candidates) return notReady("feed_shape_mismatch");
      for (const candidate of candidates) candidate.discovery.channelIdObserved = channelId;
      return {
        status: "ready",
        source: "tiktok_webcast_country_live_feed",
        triggerKind: "original_pc_web_feed",
        adapterEvidenceVersion: FEED_ADAPTER_EVIDENCE_VERSION,
        marketRegion: normalizedMarket,
        sourceDisplayName: webLiveProfile.displayName,
        rankingScopeCountryCode: normalizedTargetCountry,
        rankingScopeCountryEvidence: "verified_collection_proxy_exit_and_versioned_web_live_profile",
        workId: lane.workId,
        collectionLaneEvidence: lane.collectionLaneEvidence,
        channelId,
        receivedRooms: Array.isArray(payload.data) ? payload.data.length : 0,
        found: candidates.length,
        diagnostics,
        candidates
      };
    }
  });
}

export const TIKTOK_LIVE_FEED_PROFILE = Object.freeze({
  profileId: "tksoft-core-web-live-catalog-v1",
  supportedCountries: Object.freeze([...new Set(
    originalExecutableProfiles().map((profile) => profile.countryCode)
  )]),
  supportedMarkets: Object.freeze([...new Set(
    originalExecutableProfiles().map((profile) => profile.marketRegion)
  )]),
  executableProfileCount: originalExecutableProfiles().length,
  channelIds: FEED_CHANNEL_IDS,
  originalChannelIds: ORIGINAL_FEED_CHANNEL_IDS,
  requestCompatibilityVersion: FEED_COMPATIBILITY_VERSION,
  successPollDelayMs: 3_000,
  errorPollDelayMs: 60_000,
  displayIdDedupeTtlSeconds: FEED_SEED_DEDUPE_TTL_SECONDS,
  requestTimeoutMs: REQUEST_TIMEOUT_MS,
  authenticatedSessionTarget: "tiktok_discovery",
  sessionBinding: "discovery_cookie_country_http_lease",
  proxyRoute: "verified_collection_country",
  adapterEvidenceVersion: FEED_ADAPTER_EVIDENCE_VERSION
});
