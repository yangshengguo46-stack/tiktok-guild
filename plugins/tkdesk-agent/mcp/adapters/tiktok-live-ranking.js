const RANKING_SOURCE = "tiktok_live_regional_gift_ranking";
const RANK_SCORE_SOURCE = "tiktok_rank_view";
const RANKING_EVIDENCE_VERSION = "regional-ranking-request-semantics-v2";
const ORIGINAL_RANK_TYPE = 16;
const ORIGINAL_REGION_TYPE = 1;
const ORIGINAL_RANK_GAPS = Object.freeze([0, -1]);
const ORIGINAL_REQUEST_TIMEOUT_MS = 60_000;
const ORIGINAL_RETRY_COUNT = 3;
const ORIGINAL_MOBILE_USER_AGENT = "com.zhiliaoapp.musically/2022602030 (Linux; U; Android 7.1.2; id; SM-G9750; Build/LMY47I;tt-ok/3.12.13.1)";
const ORIGINAL_NON_CREDENTIAL_HEADERS = Object.freeze({ "sdk-version": "2" });
const HANDLE_PATTERN = /^[a-z\d._]{1,64}$/i;
const CODE_PATTERN = /^[a-z\d][a-z\d_-]{0,31}$/i;
const NUMERIC_ID_PATTERN = /^\d{5,32}$/;
const SAFE_LABEL_PATTERN = /^[\p{L}\p{N} _./:+-]{1,80}$/u;
const URL_IN_TEXT = /https?:\/\/[^\s<>"'`]+/gi;
const EMAIL_IN_TEXT = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const BEARER_IN_TEXT = /\b(?:authorization\s*[:=]\s*)?bearer\s+(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi;
const SENSITIVE_ASSIGNMENT = /\b(?:access[_-]?token|refresh[_-]?token|id[_-]?token|auth(?:orization)?[_-]?code|oauth[_-]?code|authorization|cookie|password|passwd|secret|token|credential|session[_-]?id|api[_-]?key|csrf|xsrf|email)(?:\s*[:=]\s*|\s+bearer\s+)(?:"[^"]*"|'[^']*'|[^&\s,;}]+)/gi;

const RANKING_ENDPOINTS = new Map([
  ["webcast.tiktok.com", /^\/webcast\/ranklist\/list\/v2(?:\/|$)/],
  ["webcast.us.tiktok.com", /^\/webcast\/ranklist\/list\/v2(?:\/|$)/],
  ["www.tiktok.com", /^\/(?:api-live|api\/live)\/ranklist\/list\/v2(?:\/|$)/]
]);
const OFFICIAL_WEBCAST_HOST = /^webcast(?:[.-][a-z\d-]+)*\.tiktok\.com$/i;
const WEBCAST_RANKING_PATH = /^\/webcast\/ranklist\/list\/v2(?:\/|$)/;
// TKsoft's current country bundle points at TikTok's regional webcast hosts.
// Keep this deliberately narrower than a generic *.tiktokv.us/eu allowlist.
const REGIONAL_WEBCAST_HOST = /^webcast\d+-normal-[a-z\d-]+\.tiktokv\.(?:us|eu)$/i;
const REGIONAL_WEBCAST_RANKING_PATH = /^\/webcast\/ranklist\/list\/v2(?:\/|$)/;
const TIKTOK_PAGE_HOSTS = new Set(["tiktok.com", "www.tiktok.com", "m.tiktok.com"]);
const TIKTOK_LIVE_START_URL = "https://www.tiktok.com/live";
const TIKTOK_ROOM_SOURCE_HOST = "webcast.tiktok.com";
const TIKTOK_ROOM_ENTER_PATH = "/webcast/room/enter/";
const TIKTOK_LIVE_FEED_PATH = "/webcast/feed/";
const REQUIRED_RANK_QUERY_KEYS = Object.freeze(["rank_type", "region_type", "gap_interval"]);
const RANKING_VIEW_BY_REQUEST = new Map([
  // TKsoft's candidate-discovery loop uses rank_type=16 for both the current
  // and previous gap. The gap value, not a separate period query, identifies
  // which snapshot was requested.
  ["16:0", "top"],
  ["16:-1", "top"]
]);
const LIST_PRODUCING_RANKING_VIEWS = new Set([
  "top"
]);

// The current TKsoft bundle has route entries for the three supported target
// countries, all mapped to the same MENA rank host. One run selects one target;
// its three WorkID lanes share that country. Country scope is proved by those
// independently verified exits, never by a fabricated country query parameter.
const ORIGINAL_COUNTRY_RANK_ROUTES = new Map([
  ["SA", Object.freeze({
    marketRegion: "MENA",
    topUrl: "https://webcast16-normal-useast8.tiktokv.us/webcast/ranklist/list/v2/"
  })],
  ["QA", Object.freeze({
    marketRegion: "MENA",
    topUrl: "https://webcast16-normal-useast8.tiktokv.us/webcast/ranklist/list/v2/"
  })],
  ["EG", Object.freeze({
    marketRegion: "MENA",
    topUrl: "https://webcast16-normal-useast8.tiktokv.us/webcast/ranklist/list/v2/"
  })]
]);

const SENSITIVE_KEYS = /(?:^|_)(?:authorization|cookie|password|passwd|secret|token|credential|email|session_id|api_key|csrf|xsrf)(?:$|_)/i;
const URL_KEYS = /(?:url|uri|href|location|redirect)/i;

function normalizedKey(value) {
  return String(value ?? "")
    .replace(/([a-z\d])([A-Z])/g, "$1_$2")
    .replace(/[-\s]+/g, "_")
    .toLowerCase();
}

/**
 * Ranking URLs can be signed and may contain credentials in either their query
 * or path. No URL is useful to an Agent after validation, so redact the whole
 * value instead of attempting a lossy "safe URL" projection.
 */
export function redactTikTokRankingText(value) {
  return String(value ?? "")
    .replace(URL_IN_TEXT, "[REDACTED_URL]")
    .replace(BEARER_IN_TEXT, "[REDACTED]")
    .replace(SENSITIVE_ASSIGNMENT, "[REDACTED]")
    .replace(EMAIL_IN_TEXT, "[REDACTED]");
}

export function redactTikTokRankingValue(value, key = "", depth = 0) {
  if (value === null || value === undefined) return value;
  if (depth > 10) return "[REDACTED]";
  const normalized = normalizedKey(key);
  if (SENSITIVE_KEYS.test(normalized)) return "[REDACTED]";
  if (value instanceof URL || URL_KEYS.test(normalized)) return "[REDACTED_URL]";
  if (typeof value === "string") return redactTikTokRankingText(value);
  if (Array.isArray(value)) {
    return value.map((item) => redactTikTokRankingValue(item, "", depth + 1));
  }
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([nestedKey, nestedValue]) => [
      nestedKey,
      redactTikTokRankingValue(nestedValue, nestedKey, depth + 1)
    ]));
  }
  return value;
}

export class TikTokLiveRankingError extends Error {
  constructor(message, code = "TIKTOK_RANKING_ERROR", details = null) {
    super(redactTikTokRankingText(message));
    this.name = "TikTokLiveRankingError";
    this.code = /^[A-Z0-9_]{1,80}$/.test(String(code))
      ? String(code)
      : "TIKTOK_RANKING_ERROR";
    this.details = redactTikTokRankingValue(details);
  }
}

/**
 * Keep the source boundary deliberately small. This is not a generic
 * `*.tiktok.com` allowlist: only exact known official hosts and ranklist paths
 * are accepted. The URL is validated in memory and is never returned.
 */
export function isAllowedTikTokRankingSourceUrl(rawUrl) {
  try {
    const url = new URL(String(rawUrl));
    const hostname = url.hostname.toLowerCase();
    const pathRule = RANKING_ENDPOINTS.get(hostname)
      ?? (OFFICIAL_WEBCAST_HOST.test(hostname)
        ? WEBCAST_RANKING_PATH
        : REGIONAL_WEBCAST_HOST.test(hostname)
          ? REGIONAL_WEBCAST_RANKING_PATH
          : null);
    if (!pathRule) return false;
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash) return false;
    if (/\/online_audience(?:\/|$)/i.test(url.pathname)) return false;
    return pathRule.test(url.pathname);
  } catch {
    return false;
  }
}

function nullableText(value, limit = 256) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = redactTikTokRankingText(value).trim();
  return text && !text.includes("[REDACTED") ? text.slice(0, limit) : null;
}

function safeLabel(value) {
  const text = nullableText(value, 80);
  return text && SAFE_LABEL_PATTERN.test(text) ? text : null;
}

function normalizedCode(value) {
  const text = nullableText(value, 32);
  return text && CODE_PATTERN.test(text) ? text.toUpperCase() : null;
}

function nullableOrdinal(value) {
  const number = typeof value === "string" && /^\d+$/.test(value.trim())
    ? Number(value.trim())
    : value;
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function nullableCountdown(value) {
  const number = typeof value === "string" && /^\d+$/.test(value.trim())
    ? Number(value.trim())
    : value;
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function nullableNonNegativeInteger(value) {
  const number = typeof value === "string" && /^\d+$/.test(value.trim())
    ? Number(value.trim())
    : value;
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function nullableBoolean(value) {
  if (typeof value === "boolean") return value;
  if (value === 1 || value === "1") return true;
  if (value === 0 || value === "0") return false;
  return null;
}

function nullableSignedInteger(value) {
  const number = typeof value === "string" && /^-?\d+$/.test(value.trim())
    ? Number(value.trim())
    : value;
  return Number.isSafeInteger(number) ? number : null;
}

function rankingRequestSemantics({ rankTypeCode, regionTypeCode, gapInterval } = {}) {
  if (![rankTypeCode, regionTypeCode, gapInterval].every(Number.isSafeInteger)) {
    return { status: "rejected", reason: "ranking_query_invalid" };
  }
  // The original regional country bundle currently uses region_type=1 as a
  // TikTok scope enum. It is not an ISO country code, and unobserved enum
  // values must be calibrated before this adapter accepts them.
  if (regionTypeCode !== 1) {
    return { status: "rejected", reason: "ranking_region_type_not_supported" };
  }
  const rankingViewKind = RANKING_VIEW_BY_REQUEST.get(`${rankTypeCode}:${gapInterval}`) ?? null;
  if (!rankingViewKind) {
    return { status: "rejected", reason: "ranking_view_not_supported" };
  }
  return {
    status: "ready",
    rankTypeCode,
    regionTypeCode,
    gapInterval,
    rankingViewKind,
    listProducing: LIST_PRODUCING_RANKING_VIEWS.has(rankingViewKind)
  };
}

function rawScalar(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    const text = value.trim();
    return text && text.length <= 128 ? redactTikTokRankingText(text) : null;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  return null;
}

function isoTimestamp(value, fallback) {
  if (typeof value !== "string") return fallback;
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? fallback : timestamp.toISOString();
}

function ownValue(object, keys) {
  if (!object || typeof object !== "object") return undefined;
  for (const key of keys) {
    if (Object.hasOwn(object, key)) return object[key];
  }
  return undefined;
}

function firstCode(...values) {
  for (const value of values) {
    const code = normalizedCode(value);
    if (code) return code;
  }
  return null;
}

function firstLabel(...values) {
  for (const value of values) {
    const label = safeLabel(value);
    if (label) return label;
  }
  return null;
}

function handleFromRow(row, user) {
  const raw = ownValue(user, ["display_id", "displayId", "unique_id", "uniqueId"])
    ?? ownValue(row, ["display_id", "displayId", "handle"]);
  const handle = nullableText(raw, 64)?.replace(/^@/, "") ?? null;
  return handle && HANDLE_PATTERN.test(handle) ? handle : null;
}

function sourceEvidence(snapshot) {
  const evidence = snapshot?.sourceEvidence;
  return evidence && typeof evidence === "object" && !Array.isArray(evidence) ? evidence : {};
}

function rankViewFromPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  return payload?.data?.rank_view
    ?? payload?.data?.rankView
    ?? payload?.rank_view
    ?? payload?.rankView
    ?? null;
}

function isAllowedTikTokLivePageUrl(rawUrl) {
  try {
    const url = new URL(String(rawUrl), TIKTOK_LIVE_START_URL);
    if (url.protocol !== "https:" || !TIKTOK_PAGE_HOSTS.has(url.hostname.toLowerCase())) return false;
    return url.pathname === "/live"
      || /^\/@[a-z\d._]{1,64}\/live\/?$/i.test(decodeURIComponent(url.pathname));
  } catch {
    return false;
  }
}

export function isAllowedTikTokRoomSeedSourceUrl(rawUrl) {
  try {
    const url = new URL(String(rawUrl));
    if (url.protocol !== "https:"
      || url.hostname.toLowerCase() !== TIKTOK_ROOM_SOURCE_HOST
      || url.username
      || url.password
      || url.port
      || url.hash) {
      return false;
    }
    return url.pathname === TIKTOK_ROOM_ENTER_PATH
      || url.pathname === TIKTOK_LIVE_FEED_PATH;
  } catch {
    return false;
  }
}

function numericIdentifier(value) {
  const text = typeof value === "string" || typeof value === "number"
    ? String(value).trim()
    : "";
  return NUMERIC_ID_PATTERN.test(text) ? text : null;
}

function projectedRoomSeedFromNode(node) {
  if (!node || typeof node !== "object" || Array.isArray(node)) return null;
  const room = node.room && typeof node.room === "object" ? node.room : node;
  const owner = room.owner ?? room.owner_user ?? room.ownerUser ?? null;
  if (!owner || typeof owner !== "object" || Array.isArray(owner)) return null;
  const roomId = numericIdentifier(
    ownValue(room, ["id_str", "idStr", "room_id_str", "roomIdStr", "room_id", "roomId"])
  );
  const anchorId = numericIdentifier(
    ownValue(owner, ["id_str", "idStr", "user_id", "userId", "id"])
      ?? ownValue(room, ["owner_user_id", "ownerUserId", "anchor_id", "anchorId"])
  );
  if (!roomId || !anchorId) return null;
  const rawHandle = nullableText(
    ownValue(owner, ["display_id", "displayId", "unique_id", "uniqueId"]),
    64
  )?.replace(/^@/, "") ?? null;
  const handle = rawHandle && HANDLE_PATTERN.test(rawHandle) ? rawHandle : null;
  const rawSecUid = nullableText(ownValue(owner, ["sec_uid", "secUid"]), 256);
  const secUid = rawSecUid && /^[a-z\d_-]{8,256}$/i.test(rawSecUid) ? rawSecUid : null;
  return {
    roomId,
    anchorId,
    handle,
    secUid,
    followerCount: nullableNonNegativeInteger(
      ownValue(owner, ["follower_count", "followerCount"])
        ?? ownValue(owner.follow_info ?? owner.followInfo, ["follower_count", "followerCount"])
    ),
    viewerCount: nullableNonNegativeInteger(
      ownValue(room, ["user_count", "userCount", "viewer_count", "viewerCount"])
    ),
    creatorCountryCode: firstCode(
      ownValue(owner, ["country_code", "countryCode", "region"])
    )
  };
}

/**
 * Project a room seed from the two official response shapes observed in the
 * TikTok LIVE web client. Traversal is intentionally bounded and the original
 * response object is never returned or persisted.
 */
export function projectTikTokRoomSeeds(payload, limit = 100) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const boundedLimit = boundedInteger(limit, 100, 1, 1_000);
  const queue = [payload.data ?? payload];
  const results = [];
  const seen = new Set();
  let visited = 0;
  while (queue.length && visited < 2_000 && results.length < boundedLimit) {
    const current = queue.shift();
    visited += 1;
    if (!current || typeof current !== "object") continue;
    if (Array.isArray(current)) {
      for (const item of current.slice(0, 100)) queue.push(item);
      continue;
    }
    const projected = projectedRoomSeedFromNode(current);
    if (projected) {
      const identity = `${projected.anchorId}:${projected.roomId}`;
      if (!seen.has(identity)) {
        seen.add(identity);
        results.push(projected);
      }
    }
    for (const key of ["data", "room", "rooms", "room_list", "roomList", "items", "extra"] ) {
      const child = current[key];
      if (child && typeof child === "object") queue.push(child);
    }
  }
  return results;
}

export function projectTikTokRoomSeed(payload) {
  return projectTikTokRoomSeeds(payload, 1)?.[0] ?? null;
}

function rankingResponseMetadata(rawUrl) {
  if (!isAllowedTikTokRankingSourceUrl(rawUrl)) return null;
  try {
    const url = new URL(String(rawUrl));
    const presentKeys = REQUIRED_RANK_QUERY_KEYS.filter((key) => url.searchParams.has(key));
    const canonicalSource = `${url.origin}${url.pathname}`;
    if (presentKeys.length === 0) {
      return {
        status: "rejected",
        reason: "ranking_query_not_observed",
        sourceUrl: canonicalSource
      };
    }
    if (presentKeys.length !== REQUIRED_RANK_QUERY_KEYS.length
      || REQUIRED_RANK_QUERY_KEYS.some((key) => url.searchParams.getAll(key).length !== 1)) {
      return {
        status: "rejected",
        reason: "ranking_query_incomplete",
        sourceUrl: canonicalSource
      };
    }
    const semantics = rankingRequestSemantics({
      rankTypeCode: nullableSignedInteger(url.searchParams.get("rank_type")),
      regionTypeCode: nullableSignedInteger(url.searchParams.get("region_type")),
      gapInterval: nullableSignedInteger(url.searchParams.get("gap_interval"))
    });
    return {
      ...semantics,
      // Deliberately omit the complete URL and query. This canonical URL is
      // sufficient for the downstream allowlist check and contains no signed
      // material.
      sourceUrl: canonicalSource,
      // The current regional endpoints use region_type=1 as a scope enum, not
      // an ISO country. Country scope must instead come from the verified route
      // or explicit response-row evidence.
      rankingScopeCountryCode: null
    };
  } catch {
    return null;
  }
}

function rankingEvidenceMetadata(evidence) {
  const values = evidence && typeof evidence === "object" && !Array.isArray(evidence)
    ? evidence
    : {};
  const raw = {
    rankTypeCode: ownValue(values, ["rankTypeCode", "rank_type", "rank_type_code"]),
    regionTypeCode: ownValue(values, ["regionTypeCode", "region_type", "region_type_code"]),
    gapInterval: ownValue(values, ["gapInterval", "gap_interval"])
  };
  const present = Object.values(raw).filter((value) => value !== undefined && value !== null && value !== "").length;
  if (present === 0) return null;
  if (present !== 3) return { status: "rejected", reason: "ranking_query_evidence_incomplete" };
  const semantics = rankingRequestSemantics({
    rankTypeCode: nullableSignedInteger(raw.rankTypeCode),
    regionTypeCode: nullableSignedInteger(raw.regionTypeCode),
    gapInterval: nullableSignedInteger(raw.gapInterval)
  });
  if (semantics.status !== "ready") return semantics;
  const assertedKind = safeLabel(ownValue(values, ["rankingViewKind", "ranking_view_kind"]));
  if (assertedKind && assertedKind !== semantics.rankingViewKind) {
    return { status: "rejected", reason: "ranking_view_evidence_mismatch" };
  }
  return semantics;
}

function resolveRankingRequestMetadata(sourceUrl, evidence) {
  const sourceMetadata = rankingResponseMetadata(sourceUrl);
  if (!sourceMetadata) return { status: "rejected", reason: "rank_source_not_allowed" };
  const evidenceMetadata = rankingEvidenceMetadata(evidence);

  if (sourceMetadata.status === "ready") {
    if (evidenceMetadata?.status === "rejected") return evidenceMetadata;
    if (evidenceMetadata?.status === "ready"
      && ["rankTypeCode", "regionTypeCode", "gapInterval", "rankingViewKind"]
        .some((key) => evidenceMetadata[key] !== sourceMetadata[key])) {
      return { status: "rejected", reason: "ranking_query_evidence_mismatch" };
    }
    return sourceMetadata;
  }

  // A capture snapshot deliberately strips the signed query from sourceUrl.
  // In that case the parser-authored numeric evidence is the only acceptable
  // substitute. A partial/malformed query is never repaired from assertions.
  if (sourceMetadata.reason === "ranking_query_not_observed" && evidenceMetadata?.status === "ready") {
    return { ...evidenceMetadata, sourceUrl: sourceMetadata.sourceUrl };
  }
  return sourceMetadata;
}

function projectedRankUser(user) {
  if (!user || typeof user !== "object" || Array.isArray(user)) return {};
  return {
    display_id: ownValue(user, ["display_id", "displayId", "unique_id", "uniqueId"]) ?? null,
    id_str: ownValue(user, ["id_str", "idStr", "user_id", "userId", "id"]) ?? null,
    sec_uid: ownValue(user, ["sec_uid", "secUid"]) ?? null,
    nickname: ownValue(user, ["nickname", "display_name", "displayName"]) ?? null,
    country_code: ownValue(user, ["country_code", "countryCode"]) ?? null,
    market_region: ownValue(user, ["market_region", "marketRegion"]) ?? null,
    follower_count: ownValue(user, ["follower_count", "followerCount"])
      ?? ownValue(user.follow_info ?? user.followInfo, ["follower_count", "followerCount"])
      ?? null,
    has_commerce_goods: ownValue(user, ["has_commerce_goods", "hasCommerceGoods"])
      ?? null
  };
}

function projectRankPayload(payload) {
  const rankView = rankViewFromPayload(payload);
  if (!rankView || !Array.isArray(rankView.ranks)) return null;
  return {
    data: {
      rank_view: {
        ranks: rankView.ranks.map((row) => {
          if (!row || typeof row !== "object" || Array.isArray(row)) return null;
          return {
            score: ownValue(row, ["score"]) ?? null,
            rank: ownValue(row, ["rank", "rank_index", "rankIndex", "position"]) ?? null,
            room_id_str: ownValue(row, ["room_id_str", "roomIdStr", "room_id", "roomId"]) ?? null,
            score_type: ownValue(row, ["score_type", "scoreType", "rank_score_type", "rankScoreType"]) ?? null,
            period: ownValue(row, ["period", "ranking_period", "rankingPeriod"]) ?? null,
            subtab: ownValue(row, ["subtab", "subTab", "sub_tab"]) ?? null,
            countdown: ownValue(row, ["countdown", "countdown_seconds", "countdownSeconds"]) ?? null,
            country_code: ownValue(row, ["country_code", "countryCode"]) ?? null,
            market_region: ownValue(row, ["market_region", "marketRegion"]) ?? null,
            has_commerce_goods: ownValue(row, ["has_commerce_goods", "hasCommerceGoods"])
              ?? ownValue(row.room ?? row.live_room ?? row.liveRoom, ["has_commerce_goods", "hasCommerceGoods"])
              ?? null,
            observed_at: ownValue(row, ["observed_at", "observedAt"]) ?? null,
            rank_user: projectedRankUser(row.rank_user ?? row.rankUser)
          };
        }).filter(Boolean),
        countdown: ownValue(rankView, ["countdown", "countdown_seconds", "countdownSeconds"]) ?? null,
        score_type: ownValue(rankView, ["score_type", "scoreType"]) ?? null,
        period: ownValue(rankView, ["period", "ranking_period", "rankingPeriod"]) ?? null,
        subtab: ownValue(rankView, ["subtab", "subTab", "sub_tab"]) ?? null,
        country_code: ownValue(rankView, ["country_code", "countryCode"]) ?? null,
        market_region: ownValue(rankView, ["market_region", "marketRegion"]) ?? null
      }
    }
  };
}

function projectedCaptureEvidence(value, observedAt, requestMetadata) {
  const evidence = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const rankingScopeCountryCode = requestMetadata?.rankingScopeCountryCode ?? null;
  return {
    marketRegion: normalizedCode(ownValue(evidence, ["marketRegion", "market_region"])),
    // Current regional requests expose a scope enum, not an ISO-2 country.
    // A caller-supplied selection alone is not source proof; the daemon may
    // later add separately verified proxy-route evidence.
    countryCode: rankingScopeCountryCode,
    countryScopeEvidence: rankingScopeCountryCode
      ? "official_rank_request_country_match"
      : null,
    rankScoreType: firstLabel(
      ownValue(evidence, ["rankScoreType", "rank_score_type", "scoreType", "score_type"])
    ) ?? "unknown",
    period: firstLabel(ownValue(evidence, ["period", "rankingPeriod", "ranking_period"])),
    subtab: firstLabel(ownValue(evidence, ["subtab", "subTab", "sub_tab"])),
    rankTypeCode: requestMetadata?.rankTypeCode ?? null,
    regionTypeCode: requestMetadata?.regionTypeCode ?? null,
    gapInterval: requestMetadata?.gapInterval ?? null,
    rankingViewKind: requestMetadata?.rankingViewKind ?? null,
    observedAt: isoTimestamp(ownValue(evidence, ["observedAt", "observed_at"]), observedAt)
  };
}

function boundedInteger(value, fallback, minimum, maximum) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : fallback;
}

async function shortWait(page, milliseconds) {
  if (typeof page?.waitForTimeout === "function") {
    await page.waitForTimeout(milliseconds);
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Capture one original-style UserData seed from TikTok's official room/feed
 * responses. Login state stays inside the existing Chrome page: this helper
 * never reads cookies, storage, request headers, or a signed response URL.
 */
export async function captureTikTokRoomSeedFromPage({
  page,
  maxRooms = 3,
  responseWaitMs = 1_500,
  shouldStop = () => false,
  observedAt = new Date().toISOString()
} = {}) {
  if (!page || typeof page.on !== "function" || typeof page.goto !== "function") {
    return capabilityNotReady("playwright_page_missing");
  }
  const roomLimit = boundedInteger(maxRooms, 3, 1, 3);
  const waitMs = boundedInteger(responseWaitMs, 1_500, 50, 10_000);
  let captured = null;
  let resolveCapture;
  const capturePromise = new Promise((resolve) => { resolveCapture = resolve; });
  const onResponse = async (response) => {
    if (captured || shouldStop()) return;
    if (!isAllowedTikTokRoomSeedSourceUrl(response?.url?.())) return;
    const status = typeof response?.status === "function" ? response.status() : 200;
    if (status !== 200 || typeof response?.json !== "function") return;
    try {
      const seed = projectTikTokRoomSeed(await response.json());
      if (!seed || captured) return;
      captured = Object.freeze({
        status: "ready",
        source: "tiktok_official_room_stream",
        ...seed,
        observedAt: isoTimestamp(observedAt, new Date().toISOString())
      });
      resolveCapture(captured);
    } catch {
      // A malformed response is not a seed. Raw response data and URL details
      // are deliberately not propagated into errors or logs.
    }
  };

  page.on("response", onResponse);
  try {
    if (shouldStop()) return capabilityNotReady("collection_stopped");
    await page.goto(TIKTOK_LIVE_START_URL, {
      waitUntil: "domcontentloaded",
      timeout: 45_000
    }).catch(() => null);
    await Promise.race([capturePromise, shortWait(page, waitMs)]);
    if (captured) return captured;
    if (shouldStop()) return capabilityNotReady("collection_stopped");

    const locator = typeof page.locator === "function"
      ? page.locator('a[href*="/@"][href*="/live"]')
      : null;
    const count = typeof locator?.count === "function"
      ? Math.min(await locator.count().catch(() => 0), roomLimit)
      : 0;
    const rooms = [];
    for (let index = 0; index < count; index += 1) {
      const item = typeof locator.nth === "function" ? locator.nth(index) : null;
      const href = typeof item?.getAttribute === "function"
        ? await item.getAttribute("href").catch(() => null)
        : null;
      if (!href) continue;
      try {
        const absolute = new URL(href, TIKTOK_LIVE_START_URL).href;
        if (isAllowedTikTokLivePageUrl(absolute) && !rooms.includes(absolute)) rooms.push(absolute);
      } catch {
        // Ignore malformed visible room links.
      }
    }

    for (const roomUrl of rooms) {
      if (shouldStop()) return capabilityNotReady("collection_stopped");
      await page.goto(roomUrl, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => null);
      await Promise.race([capturePromise, shortWait(page, waitMs)]);
      if (captured) return captured;
    }
    return capabilityNotReady("room_seed_not_observed");
  } finally {
    if (typeof page.off === "function") page.off("response", onResponse);
    else if (typeof page.removeListener === "function") page.removeListener("response", onResponse);
  }
}

/**
 * Bounded batch variant used by the original full-auto bootstrap. It collects
 * projected room seeds from official feed/room responses and navigates only
 * visible allowlisted LIVE links. No browser credentials leave the page.
 */
export async function captureTikTokRoomSeedsFromPage({
  page,
  maxSeeds = 30,
  responseWaitMs = 1_000,
  maxScrolls = 3,
  shouldStop = () => false,
  observedAt = new Date().toISOString()
} = {}) {
  if (!page || typeof page.on !== "function" || typeof page.goto !== "function") {
    return capabilityNotReady("playwright_page_missing");
  }
  const seedLimit = boundedInteger(maxSeeds, 30, 1, 100);
  const waitMs = boundedInteger(responseWaitMs, 1_000, 50, 10_000);
  const scrollLimit = boundedInteger(maxScrolls, 3, 0, 10);
  const seeds = [];
  const seen = new Set();
  const addSeeds = (values) => {
    for (const seed of values ?? []) {
      if (seeds.length >= seedLimit) break;
      const identity = `${seed.anchorId}:${seed.roomId}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      seeds.push(Object.freeze({
        ...seed,
        observedAt: isoTimestamp(observedAt, new Date().toISOString())
      }));
    }
  };
  const onResponse = async (response) => {
    if (seeds.length >= seedLimit || shouldStop()) return;
    if (!isAllowedTikTokRoomSeedSourceUrl(response?.url?.())) return;
    const status = typeof response?.status === "function" ? response.status() : 200;
    if (status !== 200 || typeof response?.json !== "function") return;
    try {
      addSeeds(projectTikTokRoomSeeds(await response.json(), seedLimit - seeds.length));
    } catch {
      // Ignore malformed response bodies without exposing their contents.
    }
  };

  page.on("response", onResponse);
  try {
    if (shouldStop()) return capabilityNotReady("collection_stopped");
    await page.goto(TIKTOK_LIVE_START_URL, {
      waitUntil: "domcontentloaded",
      timeout: 45_000
    }).catch(() => null);
    await shortWait(page, waitMs);

    for (let scroll = 0; scroll <= scrollLimit && seeds.length < seedLimit; scroll += 1) {
      if (shouldStop()) return capabilityNotReady("collection_stopped");
      const locator = typeof page.locator === "function"
        ? page.locator('a[href*="/@"][href*="/live"]')
        : null;
      const count = typeof locator?.count === "function"
        ? Math.min(await locator.count().catch(() => 0), seedLimit)
        : 0;
      const rooms = [];
      for (let index = 0; index < count; index += 1) {
        const item = typeof locator.nth === "function" ? locator.nth(index) : null;
        const href = typeof item?.getAttribute === "function"
          ? await item.getAttribute("href").catch(() => null)
          : null;
        if (!href) continue;
        try {
          const absolute = new URL(href, TIKTOK_LIVE_START_URL).href;
          if (isAllowedTikTokLivePageUrl(absolute) && !rooms.includes(absolute)) rooms.push(absolute);
        } catch {
          // Ignore malformed visible links.
        }
      }
      for (const roomUrl of rooms) {
        if (shouldStop() || seeds.length >= seedLimit) break;
        await page.goto(roomUrl, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => null);
        await shortWait(page, waitMs);
      }
      if (seeds.length >= seedLimit || scroll === scrollLimit) break;
      await page.goto(TIKTOK_LIVE_START_URL, {
        waitUntil: "domcontentloaded",
        timeout: 45_000
      }).catch(() => null);
      if (typeof page.evaluate === "function") {
        await page.evaluate(() => window.scrollBy(0, Math.max(window.innerHeight * 2, 1_000))).catch(() => null);
      }
      await shortWait(page, waitMs);
    }

    if (!seeds.length) return capabilityNotReady("room_seed_not_observed");
    return Object.freeze({
      status: "ready",
      source: "tiktok_official_room_stream",
      found: seeds.length,
      seeds
    });
  } finally {
    if (typeof page.off === "function") page.off("response", onResponse);
    else if (typeof page.removeListener === "function") page.removeListener("response", onResponse);
  }
}

/**
 * Passively capture the first qualifying regional ranking JSON response from a
 * Playwright page. It never reads browser cookies/storage and never returns a
 * raw request URL or query. `online_audience` is deliberately excluded because
 * it is a room audience list, not the regional gift leaderboard.
 *
 * The helper only performs bounded direct navigation to the official LIVE page
 * and up to three visible `/@handle/live` links. It does not evaluate arbitrary
 * page script or click UI controls.
 */
export async function captureTikTokRankingSnapshotFromPage({
  page,
  startUrl = TIKTOK_LIVE_START_URL,
  maxRooms = 3,
  responseWaitMs = 1_500,
  requestedRankingViewKind = null,
  sourceEvidence: assertedSourceEvidence = null,
  observedAt = new Date().toISOString()
} = {}) {
  if (!page || typeof page.on !== "function" || typeof page.goto !== "function") {
    return capabilityNotReady("playwright_page_missing");
  }
  if (!isAllowedTikTokLivePageUrl(startUrl)) {
    return capabilityNotReady("live_navigation_source_not_allowed");
  }
  const requestedView = safeLabel(requestedRankingViewKind);
  if (requestedRankingViewKind !== null
    && (!requestedView || !LIST_PRODUCING_RANKING_VIEWS.has(requestedView))) {
    return capabilityNotReady("ranking_view_not_supported");
  }

  const roomLimit = boundedInteger(maxRooms, 3, 1, 3);
  const waitMs = boundedInteger(responseWaitMs, 1_500, 50, 10_000);
  let captured = null;
  let lastRejectedReason = null;
  let resolveCapture;
  const capturePromise = new Promise((resolve) => { resolveCapture = resolve; });
  const onResponse = async (response) => {
    if (captured) return;
    const metadata = rankingResponseMetadata(response?.url?.());
    if (!metadata || typeof response?.json !== "function") return;
    if (metadata.status !== "ready") {
      lastRejectedReason = metadata.reason;
      return;
    }
    if (!metadata.listProducing) {
      lastRejectedReason = "ranking_view_not_list_producing";
      return;
    }
    if (requestedView && metadata.rankingViewKind !== requestedView) {
      lastRejectedReason = "ranking_view_mismatch";
      return;
    }
    try {
      const payload = projectRankPayload(await response.json());
      if (!payload) return;
      if (captured) return;
      captured = {
        sourceUrl: metadata.sourceUrl,
        payload,
        sourceEvidence: projectedCaptureEvidence(
          assertedSourceEvidence,
          isoTimestamp(observedAt, new Date().toISOString()),
          metadata
        )
      };
      resolveCapture(captured);
    } catch {
      // A malformed/non-JSON response is simply not a usable snapshot. Do not
      // surface response/request details because the URL may be signed.
    }
  };

  page.on("response", onResponse);
  try {
    await page.goto(String(startUrl), { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => null);
    await Promise.race([capturePromise, shortWait(page, waitMs)]);
    if (captured) return captured;

    const locator = typeof page.locator === "function"
      ? page.locator('a[href*="/@"][href*="/live"]')
      : null;
    const count = typeof locator?.count === "function"
      ? Math.min(await locator.count().catch(() => 0), roomLimit)
      : 0;
    const rooms = [];
    for (let index = 0; index < count; index += 1) {
      const item = typeof locator.nth === "function" ? locator.nth(index) : null;
      const href = typeof item?.getAttribute === "function"
        ? await item.getAttribute("href").catch(() => null)
        : null;
      if (!href) continue;
      try {
        const absolute = new URL(href, TIKTOK_LIVE_START_URL).href;
        if (isAllowedTikTokLivePageUrl(absolute) && !rooms.includes(absolute)) rooms.push(absolute);
      } catch {
        // Ignore malformed visible links.
      }
    }

    for (const roomUrl of rooms) {
      await page.goto(roomUrl, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => null);
      await Promise.race([capturePromise, shortWait(page, waitMs)]);
      if (captured) return captured;
    }
    return capabilityNotReady(lastRejectedReason ?? "rank_snapshot_not_observed");
  } finally {
    if (typeof page.off === "function") page.off("response", onResponse);
    else if (typeof page.removeListener === "function") page.removeListener("response", onResponse);
  }
}

function capabilityNotReady(reason) {
  return Object.freeze({
    status: "capability_not_ready",
    capability: "regional_gift_ranking",
    source: RANKING_SOURCE,
    reason,
    candidates: []
  });
}

function providerFunction(provider) {
  if (typeof provider === "function") return provider;
  if (provider && typeof provider.fetchRankSnapshot === "function") {
    return provider.fetchRankSnapshot.bind(provider);
  }
  return null;
}

function normalizeLimit(value) {
  if (value === null || value === undefined) return 100;
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000) {
    throw new TikTokLiveRankingError(
      "排名采集数量必须是 1 到 1000 之间的整数",
      "INVALID_RANKING_LIMIT"
    );
  }
  return value;
}

/**
 * Normalize a provider-owned snapshot. Requested market/country values are
 * filters only: they are never copied into evidence. A candidate passes a
 * requested geography only when the row or provider's explicit sourceEvidence
 * confirms it.
 */
export function normalizeTikTokRankingSnapshot(snapshot, options = {}) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    return capabilityNotReady("rank_snapshot_missing");
  }
  if (!snapshot.sourceUrl) return capabilityNotReady("rank_source_missing");
  const evidence = sourceEvidence(snapshot);
  const requestMetadata = resolveRankingRequestMetadata(snapshot.sourceUrl, evidence);
  if (requestMetadata.status !== "ready") return capabilityNotReady(requestMetadata.reason);
  if (!requestMetadata.listProducing) return capabilityNotReady("ranking_view_not_list_producing");

  const rankView = rankViewFromPayload(snapshot.payload);
  if (!rankView || !Array.isArray(rankView.ranks)) {
    // A visible LIVE-card list or another unrelated payload must never be
    // relabelled as gift-ranking evidence.
    return capabilityNotReady("rank_view_missing");
  }

  const requestedMarketRegion = normalizedCode(options.marketRegion);
  const requestedCountryCode = normalizedCode(options.countryCode ?? options.collectionCountry);
  const requestedPeriod = safeLabel(options.period);
  const requestedSubtab = safeLabel(options.subtab);
  const requestedRankingViewKind = safeLabel(options.rankingViewKind);
  const limit = normalizeLimit(options.limit);
  const fallbackObservedAt = isoTimestamp(options.observedAt, new Date().toISOString());
  const snapshotObservedAt = isoTimestamp(
    ownValue(evidence, ["observedAt", "observed_at"]),
    fallbackObservedAt
  );
  const snapshotMarket = firstCode(
    ownValue(evidence, ["marketRegion", "market_region"]),
    ownValue(rankView, ["market_region", "marketRegion"])
  );
  const snapshotCountry = firstCode(
    ownValue(evidence, ["countryCode", "country_code", "collectionCountry"]),
    ownValue(rankView, ["country_code", "countryCode"])
  );
  const snapshotScoreType = firstLabel(
    ownValue(evidence, ["rankScoreType", "rank_score_type", "scoreType", "score_type"]),
    ownValue(rankView, ["score_type", "scoreType"])
  ) ?? "unknown";
  const snapshotPeriod = firstLabel(
    ownValue(evidence, ["period", "rankingPeriod", "ranking_period"]),
    ownValue(rankView, ["period", "ranking_period", "rankingPeriod"])
  );
  const snapshotSubtab = firstLabel(
    ownValue(evidence, ["subtab", "subTab", "sub_tab"]),
    ownValue(rankView, ["subtab", "subTab", "sub_tab"])
  );
  const snapshotCountdown = nullableCountdown(
    ownValue(evidence, ["countdown", "countdownSeconds", "countdown_seconds"])
      ?? ownValue(rankView, ["countdown", "countdown_seconds", "countdownSeconds"])
  );
  const snapshotCountryEvidence = firstLabel(
    ownValue(evidence, ["countryScopeEvidence", "country_scope_evidence"])
  );

  if (requestedRankingViewKind && requestMetadata.rankingViewKind !== requestedRankingViewKind) {
    return capabilityNotReady("ranking_view_mismatch");
  }

  // Period/subtab selectors are evidence constraints, not labels that may be
  // copied onto an arbitrary first response. If the observed response cannot
  // prove the requested view, stop instead of returning a misleading list.
  if (requestedPeriod && snapshotPeriod !== requestedPeriod) {
    return capabilityNotReady(snapshotPeriod
      ? "ranking_period_mismatch"
      : "ranking_period_not_observed");
  }
  if (requestedSubtab && snapshotSubtab !== requestedSubtab) {
    return capabilityNotReady(snapshotSubtab
      ? "ranking_subtab_mismatch"
      : "ranking_subtab_not_observed");
  }

  const candidates = [];
  const seen = new Set();
  let excludedByGeography = 0;
  for (let index = 0; index < rankView.ranks.length && candidates.length < limit; index += 1) {
    const row = rankView.ranks[index];
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const user = row.rank_user ?? row.rankUser ?? {};
    const handle = handleFromRow(row, user);
    const userId = nullableText(
      ownValue(user, ["id_str", "idStr", "user_id", "userId", "id"])
        ?? ownValue(row, ["user_id", "userId"]),
      128
    );
    const roomId = nullableText(
      ownValue(row, ["room_id_str", "roomIdStr", "room_id", "roomId"]),
      128
    );
    const rawSecUid = nullableText(ownValue(user, ["sec_uid", "secUid"]), 256);
    const secUid = rawSecUid && /^[a-z\d_-]{8,256}$/i.test(rawSecUid) ? rawSecUid : null;
    const followerCount = nullableNonNegativeInteger(
      ownValue(user, ["follower_count", "followerCount"])
        ?? ownValue(row, ["follower_count", "followerCount"])
    );
    const seller = nullableBoolean(
      ownValue(row, ["has_commerce_goods", "hasCommerceGoods"])
        ?? ownValue(user, ["has_commerce_goods", "hasCommerceGoods"])
        ?? ownValue(row.room ?? row.live_room ?? row.liveRoom, ["has_commerce_goods", "hasCommerceGoods"])
    );
    if (!handle && !userId && !secUid && !roomId) continue;

    const rowMarket = firstCode(
      ownValue(row, ["market_region", "marketRegion"]),
      ownValue(user, ["market_region", "marketRegion"])
    );
    const rowCountry = firstCode(
      ownValue(row, ["country_code", "countryCode"]),
      ownValue(user, ["country_code", "countryCode"])
    );
    const marketFilterEvidence = rowMarket ?? snapshotMarket;
    const countryFilterEvidence = rowCountry ?? snapshotCountry;
    if ((requestedMarketRegion && marketFilterEvidence !== requestedMarketRegion)
      || (requestedCountryCode && countryFilterEvidence !== requestedCountryCode)) {
      excludedByGeography += 1;
      continue;
    }

    const identity = userId
      ? `user:${userId}`
      : secUid
        ? `sec:${secUid}`
      : handle
        ? `handle:${handle.toLowerCase()}`
        : `room:${roomId}`;
    if (seen.has(identity)) continue;
    seen.add(identity);

    const rankScoreType = firstLabel(
      ownValue(row, ["rank_score_type", "rankScoreType", "score_type", "scoreType"]),
      snapshotScoreType
    ) ?? "unknown";
    const period = firstLabel(
      ownValue(row, ["period", "ranking_period", "rankingPeriod"]),
      snapshotPeriod
    );
    const subtab = firstLabel(
      ownValue(row, ["subtab", "subTab", "sub_tab"]),
      snapshotSubtab
    );
    const countdown = nullableCountdown(
      ownValue(row, ["countdown", "countdown_seconds", "countdownSeconds"])
        ?? snapshotCountdown
    );
    const observedAt = isoTimestamp(
      ownValue(row, ["observed_at", "observedAt"]),
      snapshotObservedAt
    );
    const rank = nullableOrdinal(
      ownValue(row, ["rank", "rank_index", "rankIndex", "position"])
    ) ?? index + 1;
    const rankScoreRaw = rawScalar(ownValue(row, ["score"]));

    candidates.push({
      candidateId: null,
      candidateKey: userId
        ? `tiktok:user:${userId}`
        : secUid
          ? `tiktok:sec:${secUid}`
        : handle
          ? `tiktok:handle:${handle.toLowerCase()}`
          : `tiktok:room:${roomId}`,
      handle,
      displayName: nullableText(
        ownValue(user, ["nickname", "display_name", "displayName"])
          ?? ownValue(row, ["display_name", "displayName"]),
        160
      ),
      profileUrl: handle ? `https://www.tiktok.com/@${encodeURIComponent(handle)}` : null,
      userId,
      secUid,
      roomId,
      followerCount,
      seller,
      rank,
      rankScoreRaw,
      rankScoreType,
      period,
      subtab,
      countdown,
      marketRegion: rowMarket,
      countryCode: rowCountry,
      creatorCountry: rowCountry,
      rankingScopeMarketRegion: snapshotMarket,
      rankingScopeCountryCode: snapshotCountry,
      rankingScopeCountryEvidence: snapshotCountryEvidence,
      rankTypeCode: requestMetadata.rankTypeCode,
      regionTypeCode: requestMetadata.regionTypeCode,
      gapInterval: requestMetadata.gapInterval,
      rankingViewKind: requestMetadata.rankingViewKind,
      observedAt,
      source: RANKING_SOURCE,
      rankEvidence: {
        scoreRaw: rankScoreRaw,
        scoreType: rankScoreType,
        period,
        subtab,
        countdown,
        rankTypeCode: requestMetadata.rankTypeCode,
        regionTypeCode: requestMetadata.regionTypeCode,
        gapInterval: requestMetadata.gapInterval,
        rankingViewKind: requestMetadata.rankingViewKind,
        adapterEvidenceVersion: RANKING_EVIDENCE_VERSION,
        source: RANK_SCORE_SOURCE,
        observedAt
      }
    });
  }

  const result = {
    status: "ready",
    capability: "regional_gift_ranking",
    source: RANKING_SOURCE,
    sourceType: RANK_SCORE_SOURCE,
    requestedMarketRegion,
    requestedCountryCode,
    rankingScopeMarketRegion: snapshotMarket,
    rankingScopeCountryCode: snapshotCountry,
    rankingScopeCountryEvidence: snapshotCountryEvidence,
    rankTypeCode: requestMetadata.rankTypeCode,
    regionTypeCode: requestMetadata.regionTypeCode,
    gapInterval: requestMetadata.gapInterval,
    rankingViewKind: requestMetadata.rankingViewKind,
    listProducing: requestMetadata.listProducing,
    adapterEvidenceVersion: RANKING_EVIDENCE_VERSION,
    rankScoreType: snapshotScoreType,
    period: snapshotPeriod,
    subtab: snapshotSubtab,
    countdown: snapshotCountdown,
    observedAt: snapshotObservedAt,
    totalRanks: rankView.ranks.length,
    excludedByGeography,
    candidates
  };
  return redactTikTokRankingValue(result);
}

function rankingObservation(candidate) {
  return {
    gapInterval: candidate.gapInterval,
    rank: candidate.rank,
    scoreRaw: candidate.rankScoreRaw,
    scoreType: candidate.rankScoreType,
    countdown: candidate.countdown,
    observedAt: candidate.observedAt,
    adapterEvidenceVersion: RANKING_EVIDENCE_VERSION,
    source: RANK_SCORE_SOURCE
  };
}

function stableCandidateIdentity(candidate) {
  if (candidate.userId) return `user:${candidate.userId}`;
  if (candidate.secUid) return `sec:${candidate.secUid}`;
  if (candidate.handle) return `handle:${candidate.handle.toLowerCase()}`;
  return null;
}

/**
 * Merge the original rank_type=16 current/previous pair. Current ranks retain
 * precedence; previous-only creators are appended. A room id may link two
 * observations inside this one pair, but is never promoted to a durable
 * identity by itself.
 */
export function mergeTikTokRankingPair(results, { limit = 100 } = {}) {
  const boundedLimit = normalizeLimit(limit);
  if (!Array.isArray(results) || results.length !== 2) {
    return capabilityNotReady("ranking_pair_incomplete");
  }
  const byGap = new Map(results.map((result) => [result?.gapInterval, result]));
  const current = byGap.get(0);
  const previous = byGap.get(-1);
  if (!current || !previous || current.status !== "ready" || previous.status !== "ready") {
    return capabilityNotReady("ranking_pair_incomplete");
  }
  if (current.rankTypeCode !== ORIGINAL_RANK_TYPE
    || previous.rankTypeCode !== ORIGINAL_RANK_TYPE
    || current.regionTypeCode !== ORIGINAL_REGION_TYPE
    || previous.regionTypeCode !== ORIGINAL_REGION_TYPE) {
    return capabilityNotReady("ranking_pair_semantics_mismatch");
  }

  const merged = [];
  const indexByIdentity = new Map();
  const indexByRoom = new Map();
  for (const result of [current, previous]) {
    for (const candidate of result.candidates) {
      const stableIdentity = stableCandidateIdentity(candidate);
      const roomAlias = candidate.roomId ? `room:${candidate.roomId}` : null;
      let index = stableIdentity ? indexByIdentity.get(stableIdentity) : undefined;
      if (index === undefined && roomAlias) index = indexByRoom.get(roomAlias);
      if (index === undefined) {
        // The database requires a stable creator identity. A bare room id is
        // useful only as an alias for an already identified creator.
        if (!stableIdentity) continue;
        index = merged.length;
        merged.push({
          ...candidate,
          rankingObservations: [rankingObservation(candidate)]
        });
      } else {
        const existing = merged[index];
        existing.rankingObservations.push(rankingObservation(candidate));
        if (!existing.userId && candidate.userId) existing.userId = candidate.userId;
        if (!existing.secUid && candidate.secUid) existing.secUid = candidate.secUid;
        if (!existing.handle && candidate.handle) existing.handle = candidate.handle;
        if (!existing.roomId && candidate.roomId) existing.roomId = candidate.roomId;
        if (existing.seller === null && candidate.seller !== null) existing.seller = candidate.seller;
      }
      const mergedCandidate = merged[index];
      const mergedIdentity = stableCandidateIdentity(mergedCandidate);
      if (mergedIdentity) indexByIdentity.set(mergedIdentity, index);
      if (stableIdentity) indexByIdentity.set(stableIdentity, index);
      if (roomAlias) indexByRoom.set(roomAlias, index);
    }
  }

  const candidates = merged.slice(0, boundedLimit);
  return redactTikTokRankingValue({
    ...current,
    gapInterval: 0,
    gapIntervals: [0, -1],
    totalRanks: current.totalRanks + previous.totalRanks,
    totalRanksByGap: { "0": current.totalRanks, "-1": previous.totalRanks },
    excludedByGeography: current.excludedByGeography + previous.excludedByGeography,
    candidates,
    unionCandidates: merged.length,
    rankingPairComplete: true
  });
}

/**
 * Provider contract:
 *
 *   await provider.fetchRankSnapshot({
 *     marketRegion, countryCode, period, subtab, rankingViewKind, limit
 *   }) -> { sourceUrl, payload, sourceEvidence? }
 *
 * The request intentionally contains no browser state, credentials, cookies,
 * tokens, or callback URL. The returned sourceUrl is validation-only and is
 * never included in the normalized result.
 */
export async function collectTikTokLiveRanking(options = {}) {
  const fetchSnapshot = providerFunction(options.provider ?? options.rankSnapshotProvider);
  if (!fetchSnapshot) return capabilityNotReady("rank_snapshot_provider_missing");

  const limit = normalizeLimit(options.limit);
  const request = Object.freeze({
    marketRegion: normalizedCode(options.marketRegion),
    countryCode: normalizedCode(options.countryCode ?? options.collectionCountry),
    period: safeLabel(options.period),
    subtab: safeLabel(options.subtab),
    rankingViewKind: safeLabel(options.rankingViewKind),
    limit
  });

  let snapshot;
  try {
    snapshot = await fetchSnapshot(request);
  } catch (error) {
    throw new TikTokLiveRankingError(
      `TikTok 排名快照提供器失败：${error?.message ?? error}`,
      "TIKTOK_RANKING_PROVIDER_ERROR",
      { providerCode: error?.code ?? null, providerDetails: error?.details ?? null }
    );
  }

  if (snapshot?.status === "capability_not_ready") {
    return capabilityNotReady(safeLabel(snapshot.reason) ?? "rank_snapshot_not_observed");
  }

  if (Array.isArray(snapshot?.snapshots)) {
    if (snapshot.snapshots.length !== 2) return capabilityNotReady("ranking_pair_incomplete");
    const normalized = snapshot.snapshots.map((item) => normalizeTikTokRankingSnapshot(item, {
      marketRegion: request.marketRegion,
      countryCode: request.countryCode,
      rankingViewKind: request.rankingViewKind,
      limit: 1_000,
      observedAt: options.observedAt
    }));
    const failed = normalized.find((item) => item.status !== "ready");
    if (failed) return capabilityNotReady(safeLabel(failed.reason) ?? "rank_snapshot_not_observed");
    return mergeTikTokRankingPair(normalized, { limit });
  }

  return normalizeTikTokRankingSnapshot(snapshot, {
    marketRegion: request.marketRegion,
    countryCode: request.countryCode,
    period: request.period,
    subtab: request.subtab,
    rankingViewKind: request.rankingViewKind,
    limit,
    observedAt: options.observedAt
  });
}

export const TIKTOK_RANKING_CAPABILITY = Object.freeze({
  name: "regional_gift_ranking",
  source: RANKING_SOURCE,
  implementationStatus: "original_seeded_direct_request",
  productionReady: false,
  defaultRankingViewKind: "top",
  supportedListViewKinds: Object.freeze(["top"]),
  evidenceVersion: RANKING_EVIDENCE_VERSION,
  scoreTypeDefault: "unknown",
  providerRequired: true,
  activeDirectRequest: true,
  passiveCaptureOnly: false,
  originalRequestSemantics: Object.freeze({
    rankTypeCode: ORIGINAL_RANK_TYPE,
    regionTypeCode: ORIGINAL_REGION_TYPE,
    gapIntervals: ORIGINAL_RANK_GAPS
  })
});
