import crypto from "node:crypto";
import { isMobileRankingAuthorizationError } from "./mobile-ranking-authorization-provider.js";
import {
  mergeRecoveredMobileRankingStages,
  normalizeRecoveredDisplayId,
  normalizeRecoveredRankScore,
  projectRecoveredMobileResponse
} from "./recovered-ranking-core.js";
import {
  ORIGINAL_FIXED_TEMPLATE_BASE_PARAMS,
  originalExecutableProfileForCountry,
  originalExecutableProfiles,
  originalTopCodeContracts
} from "./original-country-config.js";

const RANK_TYPE = 16;
const REGION_TYPE = 1;
const GAP_INTERVALS = Object.freeze([0, -1]);
const ORIGINAL_SCORE_EVIDENCE_VERSION = "tkdesk.original-anchor-scores.v4";
const ORIGINAL_TEMPLATE_BUNDLE_EVIDENCE_VERSION = "tkdesk.original-country-template-bundle.v1";
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_RETRIES = 3;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MOBILE_USER_AGENT = "com.zhiliaoapp.musically/2022602030 (Linux; U; Android 7.1.2; id; SM-G9750; Build/LMY47I;tt-ok/3.12.13.1)";
const NON_CREDENTIAL_HEADERS = Object.freeze({ "sdk-version": "2" });
const NUMERIC_ID = /^\d{5,32}$/;
const ORIGINAL_TOP_BASE_PARAMS = ORIGINAL_FIXED_TEMPLATE_BASE_PARAMS;

const COMPILED_RANKING_PROFILES = originalExecutableProfiles();
const REPRESENTATIVE_PROFILE = originalExecutableProfileForCountry({
  marketRegion: "MENA",
  countryCode: "SA"
});
if (!REPRESENTATIVE_PROFILE) throw new Error("original executable country profiles missing");

function notReady(reason, details = {}) {
  return Object.freeze({
    status: "capability_not_ready",
    capability: "regional_gift_ranking",
    source: "tiktok_live_regional_gift_ranking",
    reason,
    candidates: [],
    ...details
  });
}

function normalizedCountry(value) {
  const text = typeof value === "string" ? value.trim().toUpperCase() : "";
  return /^[A-Z]{2}$/.test(text) ? text : null;
}

function numericId(value) {
  const text = typeof value === "string" || typeof value === "number"
    ? String(value).trim()
    : "";
  return NUMERIC_ID.test(text) ? text : null;
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
  return Number.isSafeInteger(value) && value >= 1 && value <= 4 ? value : null;
}

function requestedWorkId(explicitWorkId, seedWorkId) {
  const explicitPresent = explicitWorkId !== undefined && explicitWorkId !== null;
  const seedPresent = seedWorkId !== undefined && seedWorkId !== null;
  if (explicitPresent && seedPresent && explicitWorkId !== seedWorkId) return null;
  return explicitPresent ? explicitWorkId : seedPresent ? seedWorkId : undefined;
}

function requestedTargetCountry(explicitCountry, seedScopeCountry) {
  const explicitPresent = explicitCountry !== undefined && explicitCountry !== null;
  const scopePresent = seedScopeCountry !== undefined && seedScopeCountry !== null;
  const normalizedExplicit = explicitPresent ? normalizedCountry(explicitCountry) : null;
  const normalizedScope = scopePresent ? normalizedCountry(seedScopeCountry) : null;
  if ((explicitPresent && !normalizedExplicit)
    || (scopePresent && !normalizedScope)
    || (normalizedExplicit && normalizedScope && normalizedExplicit !== normalizedScope)) {
    return { ok: false, countryCode: null };
  }
  return { ok: true, countryCode: normalizedExplicit ?? normalizedScope };
}

function collectionLane(verifiedRoute, targetCountry, workId) {
  if (verifiedRoute?.collectionLanes !== undefined) {
    const rawLanes = verifiedRoute.collectionLanes;
    const rawExitCountries = verifiedRoute?.collectionProxyExitCountries;
    if (!Array.isArray(rawLanes)
      || rawLanes.length < 1
      || rawLanes.length > 3
      || (rawExitCountries !== undefined
        && (!Array.isArray(rawExitCountries) || rawExitCountries.length !== rawLanes.length))) {
      return { ok: false, reason: "ranking_lane_route_invalid" };
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
        return { ok: false, reason: "ranking_lane_route_invalid" };
      }
      if (inlineExitCountry && arrayExitCountry && inlineExitCountry !== arrayExitCountry) {
        return { ok: false, reason: "ranking_route_country_mismatch" };
      }
      if (exitCountry !== countryCode) {
        return { ok: false, reason: "ranking_route_country_mismatch" };
      }
      const proxyServer = safeLoopbackProxy(rawLane.proxyServer);
      if (!proxyServer) return { ok: false, reason: "ranking_proxy_not_allowed" };
      if (countries.has(countryCode) || proxies.has(proxyServer)) {
        return { ok: false, reason: "ranking_lane_route_invalid" };
      }
      countries.add(countryCode);
      proxies.add(proxyServer);
      lanes.push({ countryCode, exitCountry, proxyServer });
    }
    const normalizedWorkId = exactWorkId(workId);
    if (normalizedWorkId === null) return { ok: false, reason: "ranking_work_id_invalid" };
    if (normalizedWorkId === 4) {
      if (!targetCountry) {
        return { ok: false, reason: "ranking_route_country_mismatch" };
      }
      const laneIndex = lanes.findIndex((lane) => lane.countryCode === targetCountry);
      if (laneIndex < 0) return { ok: false, reason: "ranking_route_country_mismatch" };
      const lane = lanes[laneIndex];
      return {
        ok: true,
        proxyServer: lane.proxyServer,
        countryCode: lane.countryCode,
        workId: normalizedWorkId,
        collectionLaneEvidence: Object.freeze({
          topology: "mobile_settings_country_lane_compatibility",
          workId: normalizedWorkId,
          laneIndex,
          countryCode: lane.countryCode,
          exitCountry: lane.exitCountry,
          affinity: "target_country_fallback",
          originalFallbackSource: "mobile_settings_0"
        })
      };
    }
    const laneIndex = normalizedWorkId - 1;
    if (laneIndex >= lanes.length) return { ok: false, reason: "ranking_work_id_invalid" };
    const lane = lanes[laneIndex];
    if (targetCountry && lane.countryCode !== targetCountry) {
      return { ok: false, reason: "ranking_route_country_mismatch" };
    }
    return {
      ok: true,
      proxyServer: lane.proxyServer,
      countryCode: lane.countryCode,
      workId: normalizedWorkId,
      collectionLaneEvidence: Object.freeze({
        topology: "original_country_lane",
        workId: normalizedWorkId,
        laneIndex,
        countryCode: lane.countryCode,
        exitCountry: lane.exitCountry,
        affinity: "sticky_work_id"
      })
    };
  }

  if (workId !== undefined && workId !== null) {
    return { ok: false, reason: "ranking_lane_route_invalid" };
  }
  const exitCountry = normalizedCountry(
    verifiedRoute?.collectionProxyExitCountry ?? verifiedRoute?.proxyExitCountry
  );
  if (!exitCountry || (targetCountry && exitCountry !== targetCountry)) {
    return { ok: false, reason: "ranking_route_country_mismatch" };
  }
  const proxyServer = safeLoopbackProxy(verifiedRoute?.collectionProxyServer);
  if (!proxyServer) return { ok: false, reason: "ranking_proxy_not_allowed" };
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

function validatedProfile(countryCode, marketRegion, displayName = null, resolver = null) {
  const profile = resolver ? resolver(countryCode, marketRegion, displayName) : originalExecutableProfileForCountry({
    marketRegion,
    countryCode,
    displayName
  });
  if (!profile) return null;
  try {
    const url = new URL(profile.canonicalUrl);
    if (url.protocol !== "https:"
      || url.username
      || url.password
      || url.port
      || url.hash
      || url.search
      || url.pathname !== "/webcast/ranklist/list/v2/") {
      return null;
    }
  } catch {
    return null;
  }
  return profile;
}

function endpointFingerprint(profile) {
  return crypto.createHash("sha256")
    .update(`${profile.id}\n${profile.marketRegion}\n${profile.canonicalUrl}\n${JSON.stringify(ORIGINAL_TOP_BASE_PARAMS)}\n${RANK_TYPE}\n${REGION_TYPE}`)
    .digest("hex");
}

function originalScoreContractFingerprint(profile, scoreContracts = profile.requestContracts) {
  return crypto.createHash("sha256")
    .update(`${profile.id}\n${profile.marketRegion}\n${profile.countryCode}\n${profile.canonicalUrl}\n${JSON.stringify(ORIGINAL_TOP_BASE_PARAMS)}\n${JSON.stringify(scoreContracts)}\n${REGION_TYPE}\n${profile.topCode}\n${ORIGINAL_SCORE_EVIDENCE_VERSION}`)
    .digest("hex");
}

function fixedTemplateFingerprint(profile) {
  return crypto.createHash("sha256")
    .update(`${profile.id}\n${profile.marketRegion}\n${profile.displayName}\n${profile.canonicalUrl}\n${JSON.stringify(profile.safeFixedTemplateScope)}\n${JSON.stringify(profile.fixedTemplateContracts)}\n${JSON.stringify(ORIGINAL_TOP_BASE_PARAMS)}\n${ORIGINAL_TEMPLATE_BUNDLE_EVIDENCE_VERSION}`)
    .digest("hex");
}

function fixedRequestUrl(profile, seed, gapInterval, rankTypeCode = RANK_TYPE) {
  const url = new URL(profile.canonicalUrl);
  url.searchParams.set("anchor_id", seed.anchorId);
  url.searchParams.set("room_id", seed.roomId);
  url.searchParams.set("rank_type", String(rankTypeCode));
  url.searchParams.set("region_type", String(REGION_TYPE));
  url.searchParams.set("gap_interval", String(gapInterval));
  for (const [key, value] of Object.entries(ORIGINAL_TOP_BASE_PARAMS)) url.searchParams.set(key, value);
  return url.href;
}

function scalar(value, limit = 256) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).trim();
  return text ? text.slice(0, limit) : null;
}

function normalizedDisplayId(value) {
  return normalizeRecoveredDisplayId(value);
}

function integer(value) {
  const number = typeof value === "string" && /^-?\d+$/.test(value.trim())
    ? Number(value.trim())
    : value;
  return Number.isSafeInteger(number) ? number : null;
}

function commerceGoodsBoolean(value) {
  if (typeof value === "boolean") return value;
  if (value === 1 || value === "1") return true;
  if (value === 0 || value === "0") return false;
  return null;
}

function projectedCommerceGoods(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return commerceGoodsBoolean(value.has_commerce_goods ?? value.hasCommerceGoods);
}

function originalScore(value) {
  return normalizeRecoveredRankScore(value);
}

function originalScoreMissing(value) {
  return value === null || value === 0 || value === "0";
}

function exactOriginalRankView(payload) {
  const rankView = payload?.data?.rank_view;
  return rankView && typeof rankView === "object" && !Array.isArray(rankView)
    ? rankView
    : null;
}

function projectOriginalRanking(payload) {
  const rankView = exactOriginalRankView(payload);
  if (!rankView) return null;
  const piece = Array.isArray(rankView.sub_tabs)
    && rankView.sub_tabs.length > 1
    && Array.isArray(rankView.sub_tabs[1]?.title_text?.pieces)
    ? rankView.sub_tabs[1].title_text.pieces[0]
    : null;
  const label = typeof piece?.string_value === "string"
    ? piece.string_value.slice(0, 256)
    : "未知";
  return Object.freeze({
    rankingScore: originalScore(rankView.owner_rank?.score),
    ranking: label,
    rankingTitleState: typeof piece?.string_value === "string"
      ? "source"
      : "original_unknown_sentinel",
    countdown: originalScore(rankView.countdown)
  });
}

function projectOriginalTopScore(payload) {
  const rankView = exactOriginalRankView(payload);
  if (!rankView) return null;
  return Object.freeze({ topScore: originalScore(rankView.owner_rank?.score) });
}

function projectOriginalTemplateRows(payload) {
  const rankView = exactOriginalRankView(payload);
  const recoveredRows = projectRecoveredMobileResponse(payload, { limit: 5_000 });
  if (!rankView || !recoveredRows) return null;
  return Object.freeze(recoveredRows.map((recovered) => {
    const row = rankView.ranks[recovered.sourceIndex];
    const user = projectedUser(row.rank_user ?? row.rankUser);
    return Object.freeze({
      userId: recovered.userId,
      roomId: recovered.roomId,
      secUid: user.sec_uid ?? null,
      displayId: recovered.displayId,
      nickname: user.nickname ?? null,
      followerCount: user.follower_count ?? null,
      seller: user.has_commerce_goods
        ?? projectedCommerceGoods(row)
        ?? projectedCommerceGoods(row.room ?? row.live_room ?? row.liveRoom),
      score: recovered.score
    });
  }));
}

function mergedOriginalTemplateCandidates(stageRows, {
  marketRegion,
  countryCode,
  displayName,
  topCode,
  workId,
  collectionLaneEvidence
}) {
  return mergeRecoveredMobileRankingStages(stageRows, {
    marketRegion,
    countryCode,
    displayName,
    topCode,
    workId,
    collectionLaneEvidence
  }).candidates;
}

function projectedUser(user) {
  if (!user || typeof user !== "object" || Array.isArray(user)) return {};
  return {
    display_id: scalar(user.display_id ?? user.displayId ?? user.unique_id ?? user.uniqueId, 64),
    id_str: scalar(user.id_str ?? user.idStr ?? user.user_id ?? user.userId ?? user.id, 128),
    sec_uid: scalar(user.sec_uid ?? user.secUid, 256),
    nickname: scalar(user.nickname ?? user.display_name ?? user.displayName, 160),
    country_code: scalar(user.country_code ?? user.countryCode, 16),
    market_region: scalar(user.market_region ?? user.marketRegion, 32),
    follower_count: integer(
      user.follower_count
        ?? user.followerCount
        ?? user.follow_info?.follower_count
        ?? user.followInfo?.followerCount
    ),
    has_commerce_goods: projectedCommerceGoods(user)
  };
}

function projectedRoom(room) {
  return { has_commerce_goods: projectedCommerceGoods(room) };
}

function projectRankPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const rankView = payload.data?.rank_view
    ?? payload.data?.rankView
    ?? payload.rank_view
    ?? payload.rankView
    ?? null;
  if (!rankView || typeof rankView !== "object" || !Array.isArray(rankView.ranks)) return null;
  return {
    data: {
      rank_view: {
        ranks: rankView.ranks.slice(0, 5_000).map((row) => {
          if (!row || typeof row !== "object" || Array.isArray(row)) return null;
          const rankUser = row.rank_user ?? row.rankUser;
          const room = row.room ?? row.live_room ?? row.liveRoom;
          return {
            score: typeof row.score === "string" || typeof row.score === "number" ? row.score : null,
            rank: integer(row.rank ?? row.rank_index ?? row.rankIndex ?? row.position),
            room_id_str: scalar(row.room_id_str ?? row.roomIdStr ?? row.room_id ?? row.roomId, 128),
            score_type: scalar(row.score_type ?? row.scoreType ?? row.rank_score_type ?? row.rankScoreType, 80),
            countdown: integer(row.countdown ?? row.countdown_seconds ?? row.countdownSeconds),
            country_code: scalar(row.country_code ?? row.countryCode, 16),
            market_region: scalar(row.market_region ?? row.marketRegion, 32),
            has_commerce_goods: projectedCommerceGoods(row),
            rank_user: projectedUser(rankUser),
            room: projectedRoom(room)
          };
        }).filter(Boolean),
        countdown: integer(rankView.countdown ?? rankView.countdown_seconds ?? rankView.countdownSeconds),
        score_type: scalar(rankView.score_type ?? rankView.scoreType, 80),
        country_code: scalar(rankView.country_code ?? rankView.countryCode, 16),
        market_region: scalar(rankView.market_region ?? rankView.marketRegion, 32)
      }
    }
  };
}

function businessStatus(payload) {
  return integer(payload?.status_code ?? payload?.statusCode);
}

async function delay(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function responseStatus(response) {
  const value = typeof response?.status === "function" ? response.status() : response?.status;
  return Number.isSafeInteger(value) ? value : null;
}

async function responseBody(response) {
  if (typeof response?.body === "string") return response.body;
  if (response?.body instanceof Uint8Array) return Buffer.from(response.body).toString("utf8");
  if (typeof response?.text === "function") return response.text();
  return "";
}

export function createTikTokRankingTransport({
  authorizationProvider = null,
  requestExecutor = null,
  wait = delay,
  profileResolver = null
} = {}) {
  // requestExecutor is retained as an explicit unit-test seam. Production
  // callers use the opaque authorization provider so credential material never
  // crosses into this transport.
  const resolveProfile = (country, market, display) => validatedProfile(country, market, display, profileResolver);
  const testExecutor = typeof requestExecutor === "function" ? requestExecutor : null;
  function authorizationObserved(lease, result) {
    if (result.reason === "ranking_mobile_authorization_required") lease.reportAuthorizationRequired?.();
    return result;
  }


  async function fetchGap({
    profile,
    proxyServer,
    seed,
    gapInterval,
    shouldStop,
    observedAt,
    countryCode,
    collectionLaneEvidence,
    execute
  }) {
    const laneDetails = {
      workId: seed.workId,
      collectionLaneEvidence
    };
    let finalFailure = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      if (shouldStop()) return notReady("collection_stopped", laneDetails);
      if (attempt > 0) await wait(Math.min(attempt, 3) * 1_000);
      if (shouldStop()) return notReady("collection_stopped", laneDetails);
      let response;
      try {
        response = await execute(Object.freeze({
          method: "GET",
          url: fixedRequestUrl(profile, seed, gapInterval),
          proxyServer,
          timeoutMs: REQUEST_TIMEOUT_MS,
          maxRedirects: 0,
          headers: Object.freeze({
            "user-agent": profile.mobileUserAgent ?? MOBILE_USER_AGENT,
            ...NON_CREDENTIAL_HEADERS
          })
        }));
      } catch (error) {
        if (isMobileRankingAuthorizationError(error)) {
          if (error.code === "ranking_mobile_authorization_transport_failed") {
            finalFailure = "ranking_transport_failed";
            if (attempt < MAX_RETRIES) continue;
            return notReady(finalFailure, { ...laneDetails, gapInterval, attempts: attempt + 1 });
          }
          return notReady(
            error.code === "ranking_mobile_authorization_required"
              ? "ranking_mobile_authorization_required"
              : "ranking_mobile_authorization_provider_failed",
            { ...laneDetails, gapInterval, attempts: attempt + 1 }
          );
        }
        finalFailure = "ranking_transport_failed";
        if (attempt < MAX_RETRIES) continue;
        return notReady(finalFailure, { ...laneDetails, gapInterval, attempts: attempt + 1 });
      }

      const status = responseStatus(response);
      if (status === null) {
        return notReady("ranking_http_status_missing", {
          ...laneDetails,
          gapInterval,
          attempts: attempt + 1
        });
      }
      if (status >= 500) {
        finalFailure = "ranking_service_unavailable";
        if (attempt < MAX_RETRIES) continue;
        return notReady(finalFailure, { ...laneDetails, gapInterval, attempts: attempt + 1 });
      }
      if (status >= 300 && status < 400) {
        return notReady("ranking_redirect_rejected", {
          ...laneDetails,
          gapInterval,
          attempts: attempt + 1
        });
      }
      if (status === 401) {
        return notReady("ranking_mobile_authorization_required", {
          ...laneDetails,
          gapInterval,
          attempts: attempt + 1,
          httpStatus: status
        });
      }
      if (status < 200 || status >= 300) {
        return notReady("ranking_http_rejected", {
          ...laneDetails,
          gapInterval,
          attempts: attempt + 1,
          httpStatus: status
        });
      }

      const body = await responseBody(response);
      if (Buffer.byteLength(body, "utf8") > MAX_RESPONSE_BYTES) {
        return notReady("ranking_response_too_large", {
          ...laneDetails,
          gapInterval,
          attempts: attempt + 1
        });
      }
      let payload;
      try {
        payload = JSON.parse(body);
      } catch {
        return notReady("ranking_response_not_json", {
          ...laneDetails,
          gapInterval,
          attempts: attempt + 1
        });
      }
      const statusCode = businessStatus(payload);
      if (statusCode !== null && statusCode !== 0) {
        return notReady(statusCode === 20003 || statusCode === 10011
          ? "ranking_mobile_authorization_required"
          : "ranking_business_rejected", {
          ...laneDetails,
          gapInterval,
          attempts: attempt + 1,
          businessStatusCode: statusCode
        });
      }
      const projected = projectRankPayload(payload);
      if (!projected) {
        return notReady("ranking_rank_view_missing", {
          ...laneDetails,
          gapInterval,
          attempts: attempt + 1,
          businessStatusCode: statusCode
        });
      }
      return {
        status: "ready",
        sourceUrl: profile.canonicalUrl,
        payload: projected,
        sourceEvidence: {
          marketRegion: profile.marketRegion,
          countryCode,
          countryScopeEvidence: "verified_collection_proxy_exit_and_dynamic_candidate_rank_request",
          workId: seed.workId,
          collectionLaneEvidence,
          rankScoreType: "unknown",
          rankTypeCode: RANK_TYPE,
          regionTypeCode: REGION_TYPE,
          gapInterval,
          rankingViewKind: "top",
          observedAt
        },
        attempts: attempt + 1
      };
    }
    return notReady(finalFailure ?? "ranking_transport_failed", { ...laneDetails, gapInterval });
  }

  async function fetchOriginalScoreStage({
    profile,
    proxyServer,
    seed,
    stage,
    contract,
    projector,
    evidenceContext = {},
    shouldStop,
    execute
  }) {
    let finalFailure = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      if (shouldStop()) return notReady("collection_stopped", { stage });
      if (attempt > 0) await wait(Math.min(attempt, 3) * 1_000);
      if (shouldStop()) return notReady("collection_stopped", { stage });
      let response;
      try {
        response = await execute(Object.freeze({
          method: "GET",
          url: fixedRequestUrl(profile, seed, contract.gapInterval, contract.rankTypeCode),
          proxyServer,
          timeoutMs: REQUEST_TIMEOUT_MS,
          maxRedirects: 0,
          headers: Object.freeze({
            "user-agent": profile.mobileUserAgent ?? MOBILE_USER_AGENT,
            ...NON_CREDENTIAL_HEADERS
          })
        }));
      } catch (error) {
        if (isMobileRankingAuthorizationError(error)) {
          if (error.code === "ranking_mobile_authorization_transport_failed") {
            finalFailure = "ranking_transport_failed";
            if (attempt < MAX_RETRIES) continue;
            return notReady(finalFailure, { stage, attempts: attempt + 1 });
          }
          return notReady(
            error.code === "ranking_mobile_authorization_required"
              ? "ranking_mobile_authorization_required"
              : "ranking_mobile_authorization_provider_failed",
            { stage, attempts: attempt + 1 }
          );
        }
        finalFailure = "ranking_transport_failed";
        if (attempt < MAX_RETRIES) continue;
        return notReady(finalFailure, { stage, attempts: attempt + 1 });
      }

      const status = responseStatus(response);
      if (status === null) return notReady("ranking_http_status_missing", { stage, attempts: attempt + 1 });
      if (status >= 500) {
        finalFailure = "ranking_service_unavailable";
        if (attempt < MAX_RETRIES) continue;
        return notReady(finalFailure, { stage, attempts: attempt + 1 });
      }
      if (status >= 300 && status < 400) {
        return notReady("ranking_redirect_rejected", { stage, attempts: attempt + 1 });
      }
      if (status === 401) {
        return notReady("ranking_mobile_authorization_required", {
          stage,
          attempts: attempt + 1,
          httpStatus: status
        });
      }
      if (status < 200 || status >= 300) {
        return notReady("ranking_http_rejected", {
          stage,
          attempts: attempt + 1,
          httpStatus: status
        });
      }

      const body = await responseBody(response);
      if (Buffer.byteLength(body, "utf8") > MAX_RESPONSE_BYTES) {
        return notReady("ranking_response_too_large", { stage, attempts: attempt + 1 });
      }
      let payload;
      try {
        payload = JSON.parse(body);
      } catch {
        return notReady("ranking_response_not_json", { stage, attempts: attempt + 1 });
      }
      const statusCode = businessStatus(payload);
      if (statusCode !== null && statusCode !== 0) {
        return notReady(statusCode === 20003 || statusCode === 10011
          ? "ranking_mobile_authorization_required"
          : "ranking_business_rejected", {
          stage,
          attempts: attempt + 1,
          businessStatusCode: statusCode
        });
      }
      const projected = projector(payload);
      if (!projected) {
        return notReady("ranking_rank_view_missing", {
          stage,
          attempts: attempt + 1,
          businessStatusCode: statusCode
        });
      }
      return Object.freeze({
        status: "ready",
        value: projected,
        evidence: Object.freeze({
          state: "ready",
          rankTypeCode: contract.rankTypeCode,
          regionTypeCode: REGION_TYPE,
          gapInterval: contract.gapInterval,
          attempts: attempt + 1,
          ...(Array.isArray(projected) ? { rowCount: projected.length } : {}),
          ...(projected?.rankingTitleState
            ? {
                rankingTitleState: projected.rankingTitleState,
                titleMissing: projected.rankingTitleState === "original_unknown_sentinel"
              }
            : {}),
          ...evidenceContext,
          ...(Object.hasOwn(projected, "matched")
            ? { matched: projected.matched, matchState: projected.matchState }
            : {})
        })
      });
    }
    return notReady(finalFailure ?? "ranking_transport_failed", { stage });
  }

  async function resolvedOriginalScoreContext({
    seed,
    verifiedRoute,
    marketRegion,
    countryCode,
    workId,
    displayName
  }) {
    const normalizedMarket = typeof marketRegion === "string" ? marketRegion.trim().toUpperCase() : "";
    const anchorId = numericId(seed?.anchorId ?? seed?.userId);
    const roomId = numericId(seed?.roomId);
    if (!anchorId || !roomId) return notReady("ranking_seed_invalid");
    const selectedWorkId = requestedWorkId(workId, seed?.workId);
    if (selectedWorkId === null) return notReady("ranking_work_id_invalid");
    const requestedCountry = requestedTargetCountry(
      countryCode,
      seed?.rankingScopeCountryCode ?? seed?.rankingScope?.countryCode
    );
    if (!requestedCountry.ok) return notReady("ranking_route_country_mismatch");
    const lane = collectionLane(verifiedRoute, requestedCountry.countryCode, selectedWorkId);
    if (!lane.ok) return notReady(lane.reason);
    const normalizedTargetCountry = requestedCountry.countryCode ?? lane.countryCode;
    const requestedDisplayName = displayName
      ?? seed?.rankingDisplayName
      ?? seed?.rankingScope?.displayName
      ?? null;
    const profile = resolveProfile(
      normalizedTargetCountry,
      normalizedMarket,
      requestedDisplayName
    );
    if (!profile) return notReady("ranking_country_profile_not_configured");
    return {
      status: "ready",
      normalizedMarket,
      normalizedTargetCountry,
      profile,
      lane,
      normalizedSeed: Object.freeze({ anchorId, roomId, workId: lane.workId })
    };
  }

  return Object.freeze({
    async fetchPair({
      seed,
      verifiedRoute,
      marketRegion,
      countryCode,
      workId,
      displayName,
      shouldStop = () => false
    } = {}) {
      const normalizedMarket = typeof marketRegion === "string" ? marketRegion.trim().toUpperCase() : "";
      const anchorId = numericId(seed?.anchorId ?? seed?.userId);
      const roomId = numericId(seed?.roomId);
      if (!anchorId || !roomId) return notReady("ranking_seed_invalid");
      const selectedWorkId = requestedWorkId(workId, seed?.workId);
      if (selectedWorkId === null) return notReady("ranking_work_id_invalid");
      const requestedCountry = requestedTargetCountry(
        countryCode,
        seed?.rankingScopeCountryCode ?? seed?.rankingScope?.countryCode
      );
      if (!requestedCountry.ok) return notReady("ranking_route_country_mismatch");
      const lane = collectionLane(verifiedRoute, requestedCountry.countryCode, selectedWorkId);
      if (!lane.ok) return notReady(lane.reason);
      const normalizedTargetCountry = requestedCountry.countryCode ?? lane.countryCode;
      const profile = resolveProfile(
        normalizedTargetCountry,
        normalizedMarket,
        displayName ?? seed?.rankingDisplayName ?? seed?.rankingScope?.displayName ?? null
      );
      if (!profile) return notReady("ranking_country_profile_not_configured");

      const normalizedSeed = Object.freeze({ anchorId, roomId, workId: lane.workId });
      const observedAt = new Date().toISOString();
      let lease;
      if (authorizationProvider && typeof authorizationProvider.openLease === "function") {
        try {
          lease = await authorizationProvider.openLease({
            marketRegion: normalizedMarket,
            countryCode: normalizedTargetCountry,
            endpointProfileId: profile.id,
            proxyServer: lane.proxyServer
          });
        } catch (error) {
          if (isMobileRankingAuthorizationError(error)) {
            return notReady(
              error.code === "ranking_mobile_authorization_required"
                ? "ranking_mobile_authorization_required"
                : "ranking_mobile_authorization_provider_failed",
              { workId: lane.workId, collectionLaneEvidence: lane.collectionLaneEvidence, attempts: 0 }
            );
          }
          return notReady("ranking_mobile_authorization_provider_failed", {
            workId: lane.workId,
            collectionLaneEvidence: lane.collectionLaneEvidence,
            attempts: 0
          });
        }
      } else if (testExecutor) {
        lease = Object.freeze({ execute: testExecutor, close: async () => {} });
      } else {
        return notReady("ranking_mobile_authorization_required", {
          workId: lane.workId,
          collectionLaneEvidence: lane.collectionLaneEvidence,
          attempts: 0
        });
      }
      if (!lease || typeof lease.execute !== "function" || typeof lease.close !== "function") {
        return notReady("ranking_mobile_authorization_provider_failed", {
          workId: lane.workId,
          collectionLaneEvidence: lane.collectionLaneEvidence,
          attempts: 0
        });
      }
      try {
        const snapshots = [];
        for (const gapInterval of GAP_INTERVALS) {
          const result = await fetchGap({
            profile,
            proxyServer: lane.proxyServer,
            seed: normalizedSeed,
            gapInterval,
            shouldStop,
            observedAt,
            countryCode: normalizedTargetCountry,
            collectionLaneEvidence: lane.collectionLaneEvidence,
            execute: lease.execute.bind(lease)
          });
          if (result.status !== "ready") return authorizationObserved(lease, result);
          snapshots.push(result);
        }
        return Object.freeze({
          status: "ready",
          source: "tiktok_live_regional_gift_ranking",
          triggerKind: "original_room_seed_direct_request",
          endpointProfileId: profile.id,
          endpointFingerprint: endpointFingerprint(profile),
          rankTypeCode: RANK_TYPE,
          regionTypeCode: REGION_TYPE,
          workId: lane.workId,
          collectionLaneEvidence: lane.collectionLaneEvidence,
          gapIntervals: [...GAP_INTERVALS],
          snapshots
        });
      } finally {
        try {
          await lease.close();
        } catch {
          // Closing an opaque authorization lease must never replace or expose
          // the ranking result that already crossed the transport boundary.
        }
      }
    },

    /**
     * Reproduce MobileProcessor.processRequests: fetch the four country-level
     * fixed list templates once, label them TopURL / HistoryRankURL /
     * HotListURL / RankRecordURL, then union their rows into DataProcessor
     * seeds. This is intentionally separate from per-candidate enrichment.
     */
    async fetchOriginalCountryTemplateBundle({
      verifiedRoute,
      marketRegion,
      countryCode,
      workId,
      displayName,
      shouldStop = () => false
    } = {}) {
      const normalizedMarket = typeof marketRegion === "string" ? marketRegion.trim().toUpperCase() : "";
      const normalizedTargetCountry = normalizedCountry(countryCode);
      if (!normalizedMarket || !normalizedTargetCountry) {
        return notReady("ranking_country_profile_not_configured", { stage: "country_templates" });
      }
      const profile = resolveProfile(
        normalizedTargetCountry,
        normalizedMarket,
        displayName ?? null
      );
      if (!profile
        || !numericId(profile.safeFixedTemplateScope?.anchorId)
        || !numericId(profile.safeFixedTemplateScope?.roomId)
        || !profile.fixedTemplateContracts) {
        return notReady("ranking_country_template_not_configured", { stage: "country_templates" });
      }
      if (profile.sourceRecordCount > 1
        && (typeof displayName !== "string" || !displayName.trim())) {
        return notReady("ranking_country_template_display_variant_required", {
          stage: "country_templates"
        });
      }
      const selectedWorkId = requestedWorkId(workId, undefined);
      if (selectedWorkId === null) return notReady("ranking_work_id_invalid", { stage: "country_templates" });
      const lane = collectionLane(verifiedRoute, normalizedTargetCountry, selectedWorkId);
      if (!lane.ok) return notReady(lane.reason, { stage: "country_templates" });
      const templateSeed = Object.freeze({
        anchorId: profile.safeFixedTemplateScope.anchorId,
        roomId: profile.safeFixedTemplateScope.roomId,
        workId: lane.workId
      });
      const observedAt = new Date().toISOString();
      const evidenceContext = Object.freeze({
        observedAt,
        marketRegion: normalizedMarket,
        countryCode: normalizedTargetCountry,
        displayName: profile.displayName,
        listScope: "original_country_fixed_mobile_discovery_template"
      });
      let lease;
      if (authorizationProvider && typeof authorizationProvider.openLease === "function") {
        try {
          lease = await authorizationProvider.openLease({
            marketRegion: normalizedMarket,
            countryCode: normalizedTargetCountry,
            endpointProfileId: profile.id,
            proxyServer: lane.proxyServer
          });
        } catch (error) {
          if (isMobileRankingAuthorizationError(error)) {
            return notReady(
              error.code === "ranking_mobile_authorization_required"
                ? "ranking_mobile_authorization_required"
                : "ranking_mobile_authorization_provider_failed",
              { stage: "authorization", attempts: 0 }
            );
          }
          return notReady("ranking_mobile_authorization_provider_failed", {
            stage: "authorization",
            attempts: 0
          });
        }
      } else if (testExecutor) {
        lease = Object.freeze({ execute: testExecutor, close: async () => {} });
      } else {
        return notReady("ranking_mobile_authorization_required", {
          stage: "authorization",
          attempts: 0
        });
      }
      if (!lease || typeof lease.execute !== "function" || typeof lease.close !== "function") {
        return notReady("ranking_mobile_authorization_provider_failed", {
          stage: "authorization",
          attempts: 0
        });
      }

      try {
        const contracts = profile.fixedTemplateContracts;
        const orderedStages = [
          ["mobile_top_list", contracts.topList],
          ...(contracts.historyList.state === "skipped"
            ? []
            : [["mobile_history_list", contracts.historyList]]),
          ["mobile_hot_list", contracts.hotList],
          ["mobile_rank_record", contracts.rankRecord]
        ];
        const stageRows = [];
        const templateRowCounts = {
          TopURL: null,
          HistoryRankURL: null,
          HotListURL: null,
          RankRecordURL: null
        };
        const stageEvidence = {
          version: ORIGINAL_TEMPLATE_BUNDLE_EVIDENCE_VERSION,
          historyList: contracts.historyList.state === "skipped"
            ? Object.freeze({ state: "skipped", reason: contracts.historyList.reason, topCode: profile.topCode })
            : null
        };
        for (const [stage, contract] of orderedStages) {
          const result = await fetchOriginalScoreStage({
            profile,
            proxyServer: lane.proxyServer,
            seed: templateSeed,
            stage,
            contract,
            projector: projectOriginalTemplateRows,
            evidenceContext,
            shouldStop,
            execute: lease.execute.bind(lease)
          });
          if (result.status !== "ready") return authorizationObserved(lease, result);
          stageRows.push({ stage, rows: result.value });
          stageEvidence[stage] = result.evidence;
          templateRowCounts[contract.templateLabel] = result.evidence.rowCount;
        }
        const candidates = mergedOriginalTemplateCandidates(stageRows, {
          marketRegion: normalizedMarket,
          countryCode: normalizedTargetCountry,
          displayName: profile.displayName,
          topCode: profile.topCode,
          workId: lane.workId,
          collectionLaneEvidence: lane.collectionLaneEvidence
        });
        return Object.freeze({
          status: "ready",
          source: "tiktok_live_original_country_templates",
          triggerKind: "original_mobile_processor_fixed_country_lists",
          evidenceVersion: ORIGINAL_TEMPLATE_BUNDLE_EVIDENCE_VERSION,
          endpointProfileId: profile.id,
          endpointFingerprint: endpointFingerprint(profile),
          fixedTemplateFingerprint: fixedTemplateFingerprint(profile),
          marketRegion: normalizedMarket,
          countryCode: normalizedTargetCountry,
          displayName: profile.displayName,
          topCode: profile.topCode,
          workId: lane.workId,
          collectionLaneEvidence: lane.collectionLaneEvidence,
          templateLabels: Object.freeze(orderedStages.map(([, contract]) => contract.templateLabel)),
          templateRowCounts: Object.freeze(templateRowCounts),
          templateMergeKeyKind: "normalized_display_id",
          stageEvidence: Object.freeze(stageEvidence),
          candidates
        });
      } finally {
        try {
          await lease.close();
        } catch {
          // Authorization material remains inside the opaque lease boundary.
        }
      }
    },

    async fetchOriginalScores({
      seed,
      verifiedRoute,
      marketRegion,
      countryCode,
      workId,
      displayName,
      shouldStop = () => false
    } = {}) {
      const context = await resolvedOriginalScoreContext({
        seed,
        verifiedRoute,
        marketRegion,
        countryCode,
        workId,
        displayName
      });
      if (context.status !== "ready") return context;

      const {
        normalizedMarket,
        normalizedTargetCountry,
        profile,
        lane,
        normalizedSeed
      } = context;
      const observedAt = new Date().toISOString();
      const scoreEvidenceContext = Object.freeze({
        observedAt,
        marketRegion: normalizedMarket,
        countryCode: normalizedTargetCountry,
        listScope: "dynamic_candidate_rank_view"
      });
      const prefilledRankingScore = originalScore(seed?.rankingScore ?? seed?.RankingScore);
      const prefilledRanking = scalar(seed?.ranking ?? seed?.rankingLabel ?? seed?.Ranking, 256);
      const prefilledRankingTitleState = ["source", "original_unknown_sentinel"]
        .includes(seed?.rankingTitleState)
        ? seed.rankingTitleState
        : prefilledRanking === "未知"
          ? "original_unknown_sentinel"
          : prefilledRanking === null ? null : "source";
      const prefilledCountdown = originalScore(
        seed?.countdown ?? seed?.originalRankingCountdownSeconds ?? seed?.Countdown
      );
      const prefilledTopScore = originalScore(seed?.topScore ?? seed?.TopScore);
      const prefilledHistoryRankScore = originalScore(
        seed?.historyRankScore ?? seed?.HistoryRankScore
      );
      // Match the original worker conditions exactly: Ranking is keyed by its
      // display label, while Top/History use zero as the missing sentinel.
      const rankingNeeded = prefilledRanking === null;
      const topNeeded = originalScoreMissing(prefilledTopScore);
      const historyNeeded = profile.topCode !== 1
        && originalScoreMissing(prefilledHistoryRankScore);
      const networkNeeded = rankingNeeded || topNeeded || historyNeeded;
      let lease;
      if (!networkNeeded) {
        lease = Object.freeze({ execute: async () => { throw new Error("prefilled score stage executed"); }, close: async () => {} });
      } else if (authorizationProvider && typeof authorizationProvider.openLease === "function") {
        try {
          lease = await authorizationProvider.openLease({
            marketRegion: normalizedMarket,
            countryCode: normalizedTargetCountry,
            endpointProfileId: profile.id,
            proxyServer: lane.proxyServer
          });
        } catch (error) {
          if (isMobileRankingAuthorizationError(error)) {
            return notReady(
              error.code === "ranking_mobile_authorization_required"
                ? "ranking_mobile_authorization_required"
                : "ranking_mobile_authorization_provider_failed",
              { stage: "authorization", attempts: 0 }
            );
          }
          return notReady("ranking_mobile_authorization_provider_failed", {
            stage: "authorization",
            attempts: 0
          });
        }
      } else if (testExecutor) {
        lease = Object.freeze({ execute: testExecutor, close: async () => {} });
      } else {
        return notReady("ranking_mobile_authorization_required", {
          stage: "authorization",
          attempts: 0
        });
      }
      if (!lease || typeof lease.execute !== "function" || typeof lease.close !== "function") {
        return notReady("ranking_mobile_authorization_provider_failed", {
          stage: "authorization",
          attempts: 0
        });
      }

      try {
        const scoreContracts = profile.requestContracts ?? originalTopCodeContracts(profile.topCode);
        let rankingScore = prefilledRankingScore;
        let rankingLabel = prefilledRanking;
        let rankingTitleState = prefilledRankingTitleState;
        let countdown = prefilledCountdown;
        let rankingEvidence = Object.freeze({
          state: "skipped",
          reason: "already_prefilled",
          sourceStage: "MobileProcessor"
        });
        if (rankingNeeded) {
          const ranking = await fetchOriginalScoreStage({
            profile,
            proxyServer: lane.proxyServer,
            seed: normalizedSeed,
            stage: "ranking",
            contract: scoreContracts.ranking,
            projector: projectOriginalRanking,
            evidenceContext: scoreEvidenceContext,
            shouldStop,
            execute: lease.execute.bind(lease)
          });
          if (ranking.status !== "ready") return authorizationObserved(lease, ranking);
          rankingScore = ranking.value.rankingScore;
          rankingLabel = ranking.value.ranking;
          rankingTitleState = ranking.value.rankingTitleState;
          countdown = ranking.value.countdown;
          rankingEvidence = ranking.evidence;
        }

        let topScoreValue = prefilledTopScore;
        let topScoreEvidence = Object.freeze({
          state: "skipped",
          reason: "already_prefilled",
          sourceStage: "TopURL"
        });
        if (topNeeded) {
          const topScore = await fetchOriginalScoreStage({
            profile,
            proxyServer: lane.proxyServer,
            seed: normalizedSeed,
            stage: "top_score",
            contract: scoreContracts.topScore,
            projector: projectOriginalTopScore,
            evidenceContext: scoreEvidenceContext,
            shouldStop,
            execute: lease.execute.bind(lease)
          });
          if (topScore.status !== "ready") return authorizationObserved(lease, topScore);
          topScoreValue = topScore.value.topScore;
          topScoreEvidence = topScore.evidence;
        }

        let historyRankScore = prefilledHistoryRankScore;
        let historyRankEvidence;
        if (scoreContracts.historyRankScore.state !== "requested") {
          historyRankEvidence = Object.freeze({
            state: "skipped",
            reason: scoreContracts.historyRankScore.reason,
            topCode: profile.topCode
          });
        } else if (!historyNeeded) {
          historyRankEvidence = Object.freeze({
            state: "skipped",
            reason: "already_prefilled",
            sourceStage: "HistoryRankURL"
          });
        } else {
          const historyRank = await fetchOriginalScoreStage({
            profile,
            proxyServer: lane.proxyServer,
            seed: normalizedSeed,
            stage: "history_rank",
            contract: scoreContracts.historyRankScore,
            projector: projectOriginalTopScore,
            evidenceContext: scoreEvidenceContext,
            shouldStop,
            execute: lease.execute.bind(lease)
          });
          if (historyRank.status !== "ready") return authorizationObserved(lease, historyRank);
          historyRankScore = historyRank.value.topScore;
          historyRankEvidence = historyRank.evidence;
        }

        const hotListScore = originalScore(seed?.hotListScore ?? seed?.HotListScore);
        const rankRecordScore = originalScore(seed?.rankRecordScore ?? seed?.RankRecordScore);
        const hotListEvidence = Object.freeze(hotListScore === null
          ? {
              state: "not_collected",
              reason: "mobile_discovery_prefill_missing",
              sourceStage: "HotListURL"
            }
          : {
              state: "prefilled",
              sourceStage: "HotListURL",
              sourceKind: "original_mobile_processor_fixed_country_lists"
            });
        const rankRecordEvidence = Object.freeze(rankRecordScore === null
          ? {
              state: "not_collected",
              reason: "mobile_discovery_prefill_missing",
              sourceStage: "RankRecordURL"
            }
          : {
              state: "prefilled",
              sourceStage: "RankRecordURL",
              sourceKind: "original_mobile_processor_fixed_country_lists"
            });

        return Object.freeze({
          status: "ready",
          source: "tiktok_live_original_anchor_scores",
          evidenceVersion: ORIGINAL_SCORE_EVIDENCE_VERSION,
          endpointProfileId: profile.id,
          endpointFingerprint: endpointFingerprint(profile),
          contractFingerprint: originalScoreContractFingerprint(profile, scoreContracts),
          marketRegion: normalizedMarket,
          countryCode: normalizedTargetCountry,
          topCode: profile.topCode,
          currentScore: null,
          topScore: topScoreValue,
          historyRankScore,
          hotListScore,
          rankRecordScore,
          rankingScore,
          ranking: rankingLabel,
          rankingTitleState,
          countdown,
          stageEvidence: Object.freeze({
            version: ORIGINAL_SCORE_EVIDENCE_VERSION,
            ranking: rankingEvidence,
            topScore: topScoreEvidence,
            historyRankScore: historyRankEvidence,
            currentScore: Object.freeze({
              state: "not_collected",
              reason: "room_enter_stage_owned"
            }),
            hotListScore: hotListEvidence,
            rankRecordScore: rankRecordEvidence
          })
        });
      } finally {
        try {
          await lease.close();
        } catch {
          // Lease close diagnostics remain inside the authorization boundary.
        }
      }
    }
  });
}

export const TIKTOK_RANKING_TRANSPORT_PROFILE = Object.freeze({
  supportedCountries: Object.freeze([...new Set(
    COMPILED_RANKING_PROFILES.map((profile) => profile.countryCode)
  )].sort()),
  supportedMarketRegions: Object.freeze([...new Set(
    COMPILED_RANKING_PROFILES.map((profile) => profile.marketRegion)
  )].sort()),
  executableProfileCount: COMPILED_RANKING_PROFILES.length,
  marketRegion: REPRESENTATIVE_PROFILE.marketRegion,
  endpointProfileId: REPRESENTATIVE_PROFILE.id,
  endpointFingerprint: endpointFingerprint(REPRESENTATIVE_PROFILE),
  rankTypeCode: RANK_TYPE,
  regionTypeCode: REGION_TYPE,
  gapIntervals: GAP_INTERVALS,
  originalScoreEvidenceVersion: ORIGINAL_SCORE_EVIDENCE_VERSION,
  originalTemplateBundleEvidenceVersion: ORIGINAL_TEMPLATE_BUNDLE_EVIDENCE_VERSION,
  originalScoreTopCodes: Object.freeze([...new Set(
    COMPILED_RANKING_PROFILES.map((profile) => profile.topCode)
  )].sort()),
  originalScoreContractFingerprint: originalScoreContractFingerprint(REPRESENTATIVE_PROFILE),
  fixedTemplateDisplayVariantCount: 36,
  representativeFixedTemplateFingerprint: fixedTemplateFingerprint(REPRESENTATIVE_PROFILE),
  requestTimeoutMs: REQUEST_TIMEOUT_MS,
  maximumRetries: MAX_RETRIES
});
