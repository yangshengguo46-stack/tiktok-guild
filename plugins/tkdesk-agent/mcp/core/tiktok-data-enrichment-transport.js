import { httpResponseDiagnostics, transportFailureDiagnostics } from "./http-response-diagnostics.js";
import {
  buildRecoveredOnlineAudienceUrl,
  projectRecoveredOnlineAudience
} from "./recovered-ranking-core.js";

const REQUEST_TIMEOUT_MS = 60_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36";
const HANDLE = /^[a-z\d._]{1,64}$/i;
const DECIMAL_ID = /^\d{1,32}$/;
const LEGACY_ADAPTER_EVIDENCE_VERSION = "original-data-processor-enrichment-v1";
const SCORE_ADAPTER_EVIDENCE_VERSION = "original-data-processor-enrichment-v3";

const BASIC_ENDPOINT = Object.freeze({
  origin: "https://www.tiktok.com",
  path: "/api-live/user/room/"
});
const COUNTRY_ENDPOINT = Object.freeze({
  origin: "https://webcast.us.tiktok.com",
  path: "/webcast/gift/list/"
});
const ROOM_ENTER_ENDPOINT = Object.freeze({
  origin: "https://webcast.us.tiktok.com",
  path: "/webcast/ranklist/online_audience/"
});
const ANCHOR_LEVEL_ENDPOINT = Object.freeze({
  origin: "https://webcast.us.tiktok.com",
  path: "/webcast/user/"
});

const BASIC_PARAMS = Object.freeze({
  aid: "1988",
  app_language: "en",
  app_name: "tiktok_web",
  browser_language: "en",
  browser_name: "Mozilla",
  browser_online: "true",
  browser_platform: "Win32",
  browser_version: "5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36",
  channel: "tiktok_web",
  cookie_enabled: "true",
  device_platform: "web_pc",
  focus_state: "true",
  is_fullscreen: "false",
  is_page_visible: "true",
  os: "windows",
  priority_region: "",
  region: "US",
  screen_height: "1080",
  screen_width: "1920",
  sourceType: "54",
  webcast_language: "en"
});

const ANCHOR_LEVEL_PARAMS = Object.freeze({
  aid: "1988",
  app_name: "tiktok_web",
  browser_language: "zh-CN",
  browser_name: "Mozilla",
  browser_online: "true",
  channel: "tiktok_web"
});

function notReady(reason, details = {}) {
  return Object.freeze({
    status: "capability_not_ready",
    capability: "original_tiktok_data_processor_enrichment",
    source: "tiktok_original_data_processor",
    reason,
    enrichment: null,
    ...details
  });
}

function partial(reason, details) {
  return Object.freeze({
    status: "partial",
    capability: "original_tiktok_data_processor_enrichment",
    source: "tiktok_original_data_processor",
    reason,
    ...details
  });
}

function filtered(reason, details) {
  return Object.freeze({
    status: "filtered",
    capability: "original_tiktok_data_processor_enrichment",
    source: "tiktok_original_data_processor",
    reason,
    ...details
  });
}

function failedStageFromReason(reason) {
  if (reason.startsWith("room_enter_")) return "room_enter";
  if (reason.startsWith("anchor_level_")) return "anchor_level";
  if (reason.startsWith("basic_")) return "basic";
  if (reason.startsWith("country_")) return "country";
  if (reason.startsWith("ranking_")) return "ranking";
  return null;
}

function normalizedCountry(value) {
  const output = typeof value === "string" ? value.trim().toUpperCase() : "";
  return /^[A-Z]{2}$/.test(output) ? output : null;
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
      return { ok: false, reason: "enrichment_lane_route_invalid" };
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
        return { ok: false, reason: "enrichment_lane_route_invalid" };
      }
      if (inlineExitCountry && arrayExitCountry && inlineExitCountry !== arrayExitCountry) {
        return { ok: false, reason: "enrichment_route_country_mismatch" };
      }
      if (exitCountry !== countryCode) {
        return { ok: false, reason: "enrichment_route_country_mismatch" };
      }
      const proxyServer = safeLoopbackProxy(rawLane.proxyServer);
      if (!proxyServer) return { ok: false, reason: "enrichment_proxy_not_allowed" };
      if (countries.has(countryCode) || proxies.has(proxyServer)) {
        return { ok: false, reason: "enrichment_lane_route_invalid" };
      }
      countries.add(countryCode);
      proxies.add(proxyServer);
      lanes.push({ countryCode, exitCountry, proxyServer, displayName: rawLane.displayName ?? null });
    }
    const normalizedWorkId = exactWorkId(workId);
    if (normalizedWorkId === null) return { ok: false, reason: "enrichment_work_id_invalid" };
    if (normalizedWorkId === 4) {
      if (!targetCountry) {
        return { ok: false, reason: "enrichment_route_country_mismatch" };
      }
      const laneIndex = lanes.findIndex((lane) => lane.countryCode === targetCountry);
      if (laneIndex < 0) return { ok: false, reason: "enrichment_route_country_mismatch" };
      const lane = lanes[laneIndex];
      return {
        ok: true,
        proxyServer: lane.proxyServer,
        countryCode: lane.countryCode,
        displayName: lane.displayName,
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
    if (laneIndex >= lanes.length) return { ok: false, reason: "enrichment_work_id_invalid" };
    const lane = lanes[laneIndex];
    if (targetCountry && lane.countryCode !== targetCountry) {
      return { ok: false, reason: "enrichment_route_country_mismatch" };
    }
    return {
      ok: true,
      proxyServer: lane.proxyServer,
      countryCode: lane.countryCode,
      displayName: lane.displayName,
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
    return { ok: false, reason: "enrichment_lane_route_invalid" };
  }
  const exitCountry = normalizedCountry(
    verifiedRoute?.collectionProxyExitCountry ?? verifiedRoute?.proxyExitCountry
  );
  if (!exitCountry || (targetCountry && exitCountry !== targetCountry)) {
    return { ok: false, reason: "enrichment_route_country_mismatch" };
  }
  const proxyServer = safeLoopbackProxy(verifiedRoute?.collectionProxyServer);
  if (!proxyServer) return { ok: false, reason: "enrichment_proxy_not_allowed" };
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

function safeText(value, limit = 256) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const output = String(value).trim();
  return output ? output.slice(0, limit) : null;
}

function decimalId(value, { allowZero = false } = {}) {
  if (typeof value === "number" && !Number.isSafeInteger(value)) return null;
  const output = safeText(value, 32);
  if (!output || !DECIMAL_ID.test(output)) return null;
  if (!allowZero && /^0+$/.test(output)) return null;
  return output;
}

function safeInteger(value, { nonNegative = false } = {}) {
  const output = typeof value === "string" && /^-?\d+$/.test(value.trim())
    ? Number(value.trim())
    : value;
  if (!Number.isSafeInteger(output)) return null;
  return nonNegative && output < 0 ? null : output;
}

function buildUrl(endpoint, params) {
  const url = new URL(endpoint.path, endpoint.origin);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.href;
}

function basicUrl(handle) {
  return buildUrl(BASIC_ENDPOINT, { ...BASIC_PARAMS, uniqueId: handle });
}

function countryUrl(roomId) {
  return buildUrl(COUNTRY_ENDPOINT, { aid: "1988", room_id: roomId });
}

function roomEnterUrl(anchorId, roomId) {
  return buildRecoveredOnlineAudienceUrl(anchorId, roomId);
}

function anchorLevelUrl(targetUid) {
  return buildUrl(ANCHOR_LEVEL_ENDPOINT, { ...ANCHOR_LEVEL_PARAMS, target_uid: targetUid });
}

function endpointMatches(urlValue, endpoint) {
  try {
    const url = new URL(urlValue);
    return url.protocol === "https:"
      && url.origin === endpoint.origin
      && url.pathname === endpoint.path
      && !url.username
      && !url.password
      && !url.hash;
  } catch {
    return false;
  }
}

function businessStatus(payload) {
  const raw = payload?.status_code ?? payload?.statusCode;
  return raw === undefined || raw === null ? 0 : safeInteger(raw);
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

function responseUrl(response, fallback) {
  const value = typeof response?.url === "function" ? response.url() : response?.url;
  return typeof value === "string" && value ? value : fallback;
}

/** Project only the original DataProcessor fields from TikTok's Basic response. */
export function projectBasicUserRoomPayload(payload, { entryRoomId = "0" } = {}) {
  const data = payload?.data;
  const user = data?.user;
  if (!data || typeof data !== "object" || !user || typeof user !== "object") return null;
  const roomId = decimalId(user.roomId, { allowZero: true });
  const userId = decimalId(user.id);
  const rawSecUid = safeText(user.secUid, 256);
  const secUid = rawSecUid && /^[a-z\d_-]{8,256}$/i.test(rawSecUid) ? rawSecUid : null;
  const followerCount = safeInteger(data.stats?.followerCount, { nonNegative: true });
  const normalizedEntryRoomId = decimalId(entryRoomId, { allowZero: true });
  const liveTime = normalizedEntryRoomId && normalizedEntryRoomId !== "0"
    ? safeInteger(data.liveRoom?.startTime, { nonNegative: true })
    : null;
  return Object.freeze({ roomId, userId, secUid, followerCount, liveTime });
}

/** Empty pages are valid evidence absence, matching the original country-mismatch path. */
export function projectCountryGiftListPayload(payload) {
  const pages = payload?.data?.pages;
  if (!Array.isArray(pages)) return null;
  const region = safeText(pages[0]?.region, 32)?.toUpperCase() ?? null;
  return Object.freeze({
    region,
    creatorCountryCode: /^[A-Z]{2}$/.test(region ?? "") ? region : null,
    countryEvidenceMissing: region === null
  });
}

/** Sum every audience score and use total only when the entry viewer count was not positive. */
export function projectRoomEnterPayload(payload, { entryUserCount = null } = {}) {
  return projectRecoveredOnlineAudience(payload, { entryUserCount });
}

/** Match the original priority_type=20 / scene_type=8 badge; default is the string "0". */
export function projectAnchorLevelPayload(payload) {
  const badges = Array.isArray(payload?.data?.badge_list) ? payload.data.badge_list : [];
  const match = badges.find((badge) => safeInteger(badge?.priority_type) === 20
    && safeInteger(badge?.scene_type) === 8);
  const level = safeText(match?.privilege_log_extra?.level, 64) ?? "0";
  return Object.freeze({ anchorLevel: level, creatorLevel: level });
}

export function createTikTokDataEnrichmentTransport({
  requestContextFactory = null,
  requestExecutor = null,
  rankingTransport = null
} = {}) {
  const execute = typeof requestExecutor === "function"
    ? requestExecutor
    : () => { throw new Error("authenticated Data executor unavailable"); };
  const scoreTransportEnabled = typeof rankingTransport?.fetchOriginalScores === "function";
  const adapterEvidenceVersion = scoreTransportEnabled
    ? SCORE_ADAPTER_EVIDENCE_VERSION
    : LEGACY_ADAPTER_EVIDENCE_VERSION;

  async function fetchStage({ stage, endpoint, url, lane, verifiedRoute, project }) {
    let response;
    const startedAt = Date.now();
    try {
      response = await execute(Object.freeze({
        method: "GET",
        stage,
        sessionTarget: "tiktok_discovery",
        requiresAuthenticatedSession: true,
        sessionBinding: "discovery_initialized_processor_lane",
        workId: lane.workId,
        countryCode: lane.countryCode,
        url,
        proxyServer: lane.proxyServer,
        timeoutMs: REQUEST_TIMEOUT_MS,
        maxResponseBytes: MAX_RESPONSE_BYTES,
        maxRedirects: 0,
        headers: Object.freeze(stage === "room_enter"
          ? { "user-agent": USER_AGENT, accept: "application/json, text/plain, */*" }
          : { "user-agent": USER_AGENT })
      }), { verifiedRoute });
    } catch (error) {
      const reason = ["COUNTRY_DATA_SESSION_UNAVAILABLE", "SESSION_REQUEST_PAGE_UNAVAILABLE", "SESSION_REQUEST_URL_NOT_ALLOWED", "SESSION_REQUEST_HEADERS_NOT_ALLOWED", "SESSION_REQUEST_INVALID"].includes(error?.code) ? "enrichment_session_unavailable"
        : error?.code === "SESSION_REQUEST_AUTHENTICATION_REQUIRED" ? "enrichment_authentication_required"
        : error?.code === "SESSION_REQUEST_RUN_CLOSED" ? "enrichment_session_run_closed"
        : ["SESSION_REQUEST_PROXY_MISMATCH", "SESSION_REQUEST_PROXY_INVALID", "SESSION_REQUEST_PROXY_UNVERIFIED", "SESSION_ROUTE_RESTART_REQUIRED"].includes(error?.code)
          ? "enrichment_route_country_mismatch" : `${stage}_transport_failed`;
      return { ok: false, reason, diagnostics: transportFailureDiagnostics(error, startedAt) };
    }
    const status = responseStatus(response);
    if (status === null) return { ok: false, reason: `${stage}_http_status_missing` };
    if (status >= 300 && status < 400) return { ok: false, reason: `${stage}_redirect_rejected` };
    if (status < 200 || status >= 300) {
      return { ok: false, reason: `${stage}_http_rejected`, httpStatus: status };
    }
    if (!endpointMatches(responseUrl(response, url), endpoint)) {
      return { ok: false, reason: `${stage}_response_url_rejected` };
    }
    const body = await responseBody(response);
    const diagnostics = httpResponseDiagnostics(response, body, startedAt);
    if (Buffer.byteLength(body, "utf8") > MAX_RESPONSE_BYTES) {
      return { ok: false, reason: `${stage}_response_too_large` };
    }
    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      return { ok: false, reason: `${stage}_response_not_json`, diagnostics };
    }
    const statusCode = businessStatus(payload);
    if (statusCode !== 0) {
      return {
        ok: false,
        reason: `${stage}_business_rejected`,
        diagnostics,
        businessStatusCode: statusCode
      };
    }
    const value = project(payload);
    if (!value) return { ok: false, reason: `${stage}_shape_mismatch`, diagnostics };
    return {
      ok: true,
      value,
      evidence: Object.freeze({
        stage,
        sourceUrl: `${endpoint.origin}${endpoint.path}`,
        requestAttempts: 1,
        diagnostics
      })
    };
  }

  return Object.freeze({
    async enrichOnce({
      seed,
      verifiedRoute,
      countryCode = null,
      workId,
      minFollowers = null,
      maxFollowers = null,
      shouldStop = () => false
    } = {}) {
      const handle = safeText(seed?.handle ?? seed?.displayId, 64)?.replace(/^@/, "") ?? null;
      const entryRoomId = decimalId(seed?.roomId ?? "0", { allowZero: true });
      const entryUserCount = safeInteger(seed?.userCount ?? seed?.viewerCount);
      if (!handle || !HANDLE.test(handle) || !entryRoomId) return notReady("enrichment_seed_invalid");
      const followerMinimum = minFollowers === null || minFollowers === undefined
        ? null
        : safeInteger(minFollowers, { nonNegative: true });
      const followerMaximum = maxFollowers === null || maxFollowers === undefined
        ? null
        : safeInteger(maxFollowers, { nonNegative: true });
      if ((minFollowers !== null && minFollowers !== undefined && followerMinimum === null)
        || (maxFollowers !== null && maxFollowers !== undefined && followerMaximum === null)
        || (followerMinimum !== null && followerMaximum !== null && followerMinimum > followerMaximum)) {
        return notReady("enrichment_follower_range_invalid");
      }
      const selectedWorkId = requestedWorkId(workId, seed?.workId);
      if (selectedWorkId === null) return notReady("enrichment_work_id_invalid");
      const requestedCountry = requestedTargetCountry(
        countryCode,
        seed?.rankingScopeCountryCode ?? seed?.rankingScope?.countryCode
      );
      if (!requestedCountry.ok) return notReady("enrichment_route_country_mismatch");
      const lane = collectionLane(verifiedRoute, requestedCountry.countryCode, selectedWorkId);
      if (!lane.ok) return notReady(lane.reason);
      const normalizedTargetCountry = requestedCountry.countryCode ?? lane.countryCode;
      if (shouldStop()) return notReady("collection_stopped", {
        workId: lane.workId,
        collectionLaneEvidence: lane.collectionLaneEvidence
      });

      const completedStages = [];
      const stageEvidence = [];
      let originalScoreEvidence = null;
      let scoreFailure = null;
      const enrichment = {
        roomId: null,
        userId: null,
        secUid: null,
        followerCount: null,
        liveTime: null,
        region: null,
        creatorCountryCode: null,
        countryEvidenceMissing: null,
        currentScore: null,
        topCode: null,
        topScore: null,
        historyRankScore: null,
        hotListScore: null,
        rankRecordScore: null,
        rankingScore: null,
        ranking: null,
        countdown: null,
        userCount: entryUserCount,
        // "0" is the original default only after a successful anchor-level
        // response contains no matching badge.  Before that request succeeds,
        // the value is unknown and must remain null.
        anchorLevel: null,
        creatorLevel: null
      };
      const stopped = (reason, failedStage = null) => partial(reason, {
        workId: lane.workId,
        collectionLaneEvidence: lane.collectionLaneEvidence,
        failedStage: failedStage ?? failedStageFromReason(reason),
        completedStages: [...completedStages],
        enrichment: Object.freeze({ ...enrichment }),
        stageEvidence: Object.freeze([...stageEvidence]),
        originalScoreEvidence,
        adapterEvidenceVersion
      });
      const rejected = (reason) => filtered(reason, {
        workId: lane.workId,
        collectionLaneEvidence: lane.collectionLaneEvidence,
        completedStages: [...completedStages],
        enrichment: Object.freeze({ ...enrichment }),
        stageEvidence: Object.freeze([...stageEvidence]),
        originalScoreEvidence,
        adapterEvidenceVersion
      });
      const record = (stage, result) => {
        completedStages.push(stage);
        stageEvidence.push(result.evidence);
        Object.assign(enrichment, result.value);
      };
      const failed = (stage, result) => {
        stageEvidence.push(Object.freeze({ stage, state: "failed", reason: result.reason,
          diagnostics: result.diagnostics ?? null, httpStatus: result.httpStatus ?? null,
          businessStatusCode: result.businessStatusCode ?? null }));
        return stopped(result.reason, stage);
      };

      const basic = await fetchStage({
        stage: "basic",
        endpoint: BASIC_ENDPOINT,
        url: basicUrl(handle),
        lane, verifiedRoute,
        project: (payload) => projectBasicUserRoomPayload(payload, { entryRoomId })
      });
      if (!basic.ok) return failed("basic", basic);
      record("basic", basic);
      if (!enrichment.roomId || !enrichment.userId) return stopped("basic_identity_missing");
      if ((followerMinimum !== null || followerMaximum !== null)
        && enrichment.followerCount === null) {
        return stopped("basic_follower_count_missing");
      }
      if (followerMinimum !== null && enrichment.followerCount < followerMinimum) {
        return rejected("follower_below_minimum");
      }
      if (followerMaximum !== null && enrichment.followerCount > followerMaximum) {
        return rejected("follower_above_maximum");
      }
      if (shouldStop()) return stopped("collection_stopped");

      const country = await fetchStage({
        stage: "country",
        endpoint: COUNTRY_ENDPOINT,
        url: countryUrl(enrichment.roomId),
        lane, verifiedRoute,
        project: projectCountryGiftListPayload
      });
      if (!country.ok) return failed("country", country);
      record("country", country);
      if (enrichment.creatorCountryCode !== normalizedTargetCountry) {
        return rejected(enrichment.countryEvidenceMissing
          ? "creator_country_missing"
          : "creator_country_mismatch");
      }
      if (shouldStop()) return stopped("collection_stopped");

      // The original DataProcessor gates only RoomEnter on the room ID that
      // entered the worker. Basic may discover a valid room for a seed whose
      // entry RoomID was "0"; Ranking, TopScore, and HistoryRank must use that
      // discovered identity instead of being skipped with RoomEnter.
      if (scoreTransportEnabled) {
        let originalScores;
        try {
          originalScores = await rankingTransport.fetchOriginalScores({
            seed: {
              anchorId: enrichment.userId,
              roomId: enrichment.roomId,
              workId: lane.workId,
              rankingScopeCountryCode: normalizedTargetCountry,
              rankingDisplayName: seed?.rankingDisplayName ?? lane.displayName ?? null,
              rankingScore: seed?.rankingScore ?? seed?.RankingScore ?? null,
              ranking: seed?.ranking ?? seed?.rankingLabel ?? seed?.Ranking ?? null,
              rankingTitleState: seed?.rankingTitleState ?? null,
              countdown: seed?.countdown ?? seed?.originalRankingCountdownSeconds ?? null,
              topScore: seed?.topScore ?? seed?.TopScore ?? null,
              historyRankScore: seed?.historyRankScore ?? seed?.HistoryRankScore ?? null,
              hotListScore: seed?.hotListScore ?? seed?.HotListScore ?? null,
              rankRecordScore: seed?.rankRecordScore ?? seed?.RankRecordScore ?? null
            },
            verifiedRoute,
            marketRegion: typeof verifiedRoute?.marketRegion === "string"
              ? verifiedRoute.marketRegion.trim().toUpperCase()
              : null,
            countryCode: normalizedTargetCountry,
            displayName: seed?.rankingDisplayName ?? lane.displayName ?? null,
            workId: lane.workId,
            shouldStop
          });
        } catch {
          // The score transport may wrap an opaque authorization provider.
          // Never let its diagnostic text escape this fail-soft enrichment step.
          originalScores = {
            status: "capability_not_ready",
            reason: "ranking_transport_failed",
            stage: "ranking"
          };
        }
        if (originalScores?.status === "ready") {
          Object.assign(enrichment, {
            topCode: originalScores.topCode ?? null,
            topScore: originalScores.topScore ?? null,
            historyRankScore: originalScores.historyRankScore ?? null,
            hotListScore: originalScores.hotListScore ?? null,
            rankRecordScore: originalScores.rankRecordScore ?? null,
            rankingScore: originalScores.rankingScore ?? null,
            ranking: originalScores.ranking ?? null,
            rankingTitleState: originalScores.rankingTitleState ?? null,
            countdown: originalScores.countdown ?? null
          });
          if (originalScores.stageEvidence?.ranking?.state === "ready") {
            completedStages.push("ranking");
          }
          if (originalScores.stageEvidence?.topScore?.state === "ready") {
            completedStages.push("top_score");
          }
          if (originalScores.stageEvidence?.historyRankScore?.state === "ready") {
            completedStages.push("history_rank");
          }
          stageEvidence.push(
            Object.freeze({ stage: "ranking", ...originalScores.stageEvidence?.ranking }),
            Object.freeze({ stage: "top_score", ...originalScores.stageEvidence?.topScore }),
            Object.freeze({ stage: "history_rank", ...originalScores.stageEvidence?.historyRankScore }),
            Object.freeze({
              stage: "mobile_hot_list_prefill",
              ...originalScores.stageEvidence?.hotListScore
            }),
            Object.freeze({
              stage: "mobile_rank_record_prefill",
              ...originalScores.stageEvidence?.rankRecordScore
            })
          );
          originalScoreEvidence = Object.freeze({
            state: "ready",
            source: originalScores.source ?? null,
            evidenceVersion: originalScores.evidenceVersion ?? null,
            endpointProfileId: originalScores.endpointProfileId ?? null,
            marketRegion: originalScores.marketRegion ?? null,
            countryCode: originalScores.countryCode ?? null,
            topCode: originalScores.topCode ?? null
          });
        } else {
          scoreFailure = {
            reason: originalScores?.reason ?? "ranking_original_scores_unresolved",
            stage: originalScores?.stage ?? "ranking"
          };
          originalScoreEvidence = Object.freeze({
            state: "unresolved",
            reason: scoreFailure.reason,
            stage: scoreFailure.stage,
            secretValuesExposed: false
          });
        }
        if (shouldStop()) return stopped("collection_stopped", scoreFailure?.stage ?? "ranking");
      }

      if (entryRoomId !== "0") {
        const roomEnter = await fetchStage({
          stage: "room_enter",
          endpoint: ROOM_ENTER_ENDPOINT,
          url: roomEnterUrl(enrichment.userId, enrichment.roomId),
          lane, verifiedRoute,
          project: (payload) => projectRoomEnterPayload(payload, { entryUserCount })
        });
        if (!roomEnter.ok) return failed("room_enter", roomEnter);
        record("room_enter", roomEnter);
        if (shouldStop()) return stopped("collection_stopped");
      }

      const anchorLevel = await fetchStage({
        stage: "anchor_level",
        endpoint: ANCHOR_LEVEL_ENDPOINT,
        url: anchorLevelUrl(enrichment.userId),
        lane, verifiedRoute,
        project: projectAnchorLevelPayload
      });
      if (!anchorLevel.ok) return failed("anchor_level", anchorLevel);
      record("anchor_level", anchorLevel);

      if (scoreFailure) return stopped(scoreFailure.reason, scoreFailure.stage);

      return Object.freeze({
        status: "ready",
        source: "tiktok_original_data_processor",
        adapterEvidenceVersion,
        routeCountry: normalizedTargetCountry,
        workId: lane.workId,
        collectionLaneEvidence: lane.collectionLaneEvidence,
        observedAt: new Date().toISOString(),
        completedStages: Object.freeze([...completedStages]),
        enrichment: Object.freeze({ ...enrichment }),
        stageEvidence: Object.freeze([...stageEvidence]),
        originalScoreEvidence
      });
    }
  });
}

export const TIKTOK_DATA_ENRICHMENT_PROFILE = Object.freeze({
  stages: Object.freeze([
    "basic",
    "country",
    "ranking",
    "top_score",
    "history_rank",
    "room_enter",
    "anchor_level"
  ]),
  topCodeSource: "original_country_configuration",
  scoreFailureBehavior: "fail_soft_with_partial_evidence",
  conditionalStage: "room_enter",
  anchorLevelBadge: Object.freeze({ priorityType: 20, sceneType: 8, defaultLevel: "0" }),
  requestTimeoutMs: REQUEST_TIMEOUT_MS,
  maximumAttemptsPerStage: 1,
  authenticatedSessionTarget: "tiktok_discovery",
  sessionBinding: "discovery_initialized_processor_lane",
  proxyRoute: "verified_collection_country",
  adapterEvidenceVersion: SCORE_ADAPTER_EVIDENCE_VERSION
});
