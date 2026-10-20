// Pure ranking core recovered from TK主播助手9.9's Go type/function metadata.
//
// The exact recoverable contracts are:
// - play.MobileResponse: data.rank_view.ranks[].score/room_id_str/rank_user
// - play.UserData's six score fields and DisplayID-first merge identity
// - RankingProcessor.processRankingDataWithGap's WorkID4 downstream role
// - online_audience aid/anchor_id/room_id request and score summation
//
// Compiled Go cannot yield the author's original statement-by-statement source,
// so this module is the plugin-native implementation of those recovered
// contracts. It deliberately contains no HTTP, credentials, routing, or retry
// policy; the existing TKDesk transports remain responsible for those layers.

export const RECOVERED_RANKING_CORE_VERSION = "tksoft-9.9-ranking-core-v1";

export const RECOVERED_USER_DATA_FIELDS = Object.freeze([
  "displayId",
  "roomId",
  "userId",
  "secUid",
  "region",
  "host",
  "topCode",
  "tag",
  "currentScore",
  "topScore",
  "historyRankScore",
  "hotListScore",
  "rankRecordScore",
  "rankingScore",
  "ranking",
  "followerCount",
  "userCount",
  "liveTime",
  "anchorLevel",
  "workId",
  "countdown"
]);

export const RECOVERED_MOBILE_STAGE_SCORE_FIELD = Object.freeze({
  mobile_top_list: "topScore",
  mobile_history_list: "historyRankScore",
  mobile_hot_list: "hotListScore",
  mobile_rank_record: "rankRecordScore"
});

const ONLINE_AUDIENCE_ENDPOINT = Object.freeze({
  origin: "https://webcast.us.tiktok.com",
  path: "/webcast/ranklist/online_audience/"
});
const DECIMAL_ID = /^\d{5,32}$/;
const SIGNED_INTEGER = /^[+-]?\d+$/;
const SIGNED_INT64_MIN = -(1n << 63n);
const SIGNED_INT64_MAX = (1n << 63n) - 1n;
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE_BIGINT = BigInt(Number.MIN_SAFE_INTEGER);

function scalar(value, limit = 256) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).trim();
  return text ? text.slice(0, limit) : null;
}

function numericIdentifier(value) {
  const text = scalar(value, 32);
  return text && DECIMAL_ID.test(text) ? text : null;
}

function recoveredIntegerBigInt(value) {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) ? BigInt(value) : null;
  }
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!SIGNED_INTEGER.test(text)) return null;
  try {
    const parsed = BigInt(text);
    return parsed >= SIGNED_INT64_MIN && parsed <= SIGNED_INT64_MAX ? parsed : null;
  } catch {
    return null;
  }
}

function recoveredIntegerValue(value) {
  if (value >= MIN_SAFE_BIGINT && value <= MAX_SAFE_BIGINT) return Number(value);
  return value.toString();
}

function nullableNonNegativeInteger(value) {
  const parsed = recoveredIntegerBigInt(value);
  if (parsed === null || parsed < 0n || parsed > MAX_SAFE_BIGINT) return null;
  return Number(parsed);
}

export function normalizeRecoveredDisplayId(value) {
  const text = scalar(value, 64)?.replace(/^@/, "") ?? null;
  return text ? text.toLocaleLowerCase("en-US") : null;
}

export function normalizeRecoveredRankScore(value) {
  const parsed = recoveredIntegerBigInt(value);
  if (parsed === null || parsed < 0n) return null;
  // Preserve the transport's representation contract: a JSON string remains
  // a canonical decimal string even when it would fit safely in Number.
  return typeof value === "string" ? parsed.toString() : recoveredIntegerValue(parsed);
}

/** Parse only the exact play.MobileResponse shape recovered from the binary. */
export function projectRecoveredMobileResponse(payload, { limit = 5_000 } = {}) {
  const ranks = payload?.data?.rank_view?.ranks;
  if (!Array.isArray(ranks)) return null;
  const boundedLimit = Number.isSafeInteger(limit) && limit >= 1
    ? Math.min(limit, 5_000)
    : 5_000;
  return Object.freeze(ranks.slice(0, boundedLimit).map((row, sourceIndex) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) return null;
    const user = row.rank_user;
    if (!user || typeof user !== "object" || Array.isArray(user)) return null;
    const displayId = scalar(user.display_id, 64);
    if (!normalizeRecoveredDisplayId(displayId)) return null;
    return Object.freeze({
      sourceIndex,
      displayId,
      userId: numericIdentifier(user.id_str),
      roomId: numericIdentifier(row.room_id_str),
      score: normalizeRecoveredRankScore(row.score)
    });
  }).filter(Boolean));
}

/** Reproduce MobileProcessor's DisplayID-keyed four-list merge. */
export function mergeRecoveredMobileRankingStages(stageRows, {
  marketRegion = null,
  countryCode = null,
  displayName = null,
  topCode = null,
  workId = null,
  collectionLaneEvidence = null
} = {}) {
  const candidates = [];
  const displayIndex = new Map();
  const userIndex = new Map();
  const roomIndex = new Map();
  const secIndex = new Map();
  let identityConflicts = 0;
  let scoreConflicts = 0;

  for (const { stage, rows } of stageRows ?? []) {
    const scoreField = RECOVERED_MOBILE_STAGE_SCORE_FIELD[stage];
    if (!scoreField || !Array.isArray(rows)) continue;
    for (const row of rows) {
      const displayKey = normalizeRecoveredDisplayId(row?.displayId);
      if (!displayKey) continue;
      const matched = new Set();
      if (displayIndex.has(displayKey)) matched.add(displayIndex.get(displayKey));
      if (row.userId && userIndex.has(row.userId)) matched.add(userIndex.get(row.userId));
      if (row.roomId && roomIndex.has(row.roomId)) matched.add(roomIndex.get(row.roomId));
      if (row.secUid && secIndex.has(row.secUid)) matched.add(secIndex.get(row.secUid));
      if (matched.size > 1) {
        identityConflicts += 1;
        continue;
      }

      let index = matched.size === 1 ? [...matched][0] : null;
      if (index === null) {
        index = candidates.length;
        candidates.push({
          handle: row.displayId,
          userId: row.userId ?? null,
          roomId: row.roomId ?? null,
          secUid: row.secUid ?? null,
          displayId: row.displayId,
          nickname: row.nickname ?? null,
          followerCount: row.followerCount ?? null,
          seller: row.seller ?? null,
          workId,
          rankingScopeMarketRegion: marketRegion,
          rankingScopeCountryCode: countryCode,
          rankingDisplayName: displayName,
          collectionLaneEvidence,
          templateMergeKeyKind: "normalized_display_id",
          recoveredRankingCoreVersion: RECOVERED_RANKING_CORE_VERSION,
          topCode,
          topScore: null,
          historyRankScore: null,
          hotListScore: null,
          rankRecordScore: null
        });
      } else {
        const current = candidates[index];
        const identityConflict = normalizeRecoveredDisplayId(current.displayId) !== displayKey
          || (current.userId !== null && row.userId !== null && current.userId !== row.userId)
          || (current.roomId !== null && row.roomId !== null && current.roomId !== row.roomId)
          || (current.secUid !== null && row.secUid !== null && current.secUid !== row.secUid);
        if (identityConflict) {
          identityConflicts += 1;
          continue;
        }
        for (const key of [
          "userId",
          "roomId",
          "secUid",
          "displayId",
          "nickname",
          "followerCount",
          "seller"
        ]) {
          if (current[key] === null && row[key] !== null && row[key] !== undefined) {
            current[key] = row[key];
          }
        }
      }

      const current = candidates[index];
      if (current[scoreField] === null) current[scoreField] = row.score ?? null;
      else if (row.score !== null
        && row.score !== undefined
        && String(current[scoreField]) !== String(row.score)) {
        current[scoreField] = null;
        scoreConflicts += 1;
      }
      displayIndex.set(displayKey, index);
      if (row.userId) userIndex.set(row.userId, index);
      if (row.roomId) roomIndex.set(row.roomId, index);
      if (row.secUid) secIndex.set(row.secUid, index);
    }
  }

  return Object.freeze({
    candidates: Object.freeze(candidates.map((candidate) => Object.freeze(candidate))),
    identityConflicts,
    scoreConflicts,
    evidenceVersion: RECOVERED_RANKING_CORE_VERSION
  });
}

export function buildRecoveredOnlineAudienceUrl(anchorId, roomId) {
  const url = new URL(ONLINE_AUDIENCE_ENDPOINT.path, ONLINE_AUDIENCE_ENDPOINT.origin);
  url.searchParams.set("aid", "1988");
  url.searchParams.set("anchor_id", String(anchorId));
  url.searchParams.set("room_id", String(roomId));
  return url.href;
}

/** Sum data.ranks[*].score without losing signed-int64 precision. */
export function projectRecoveredOnlineAudience(payload, { entryUserCount = null } = {}) {
  const data = payload?.data;
  if (!data || typeof data !== "object" || !Array.isArray(data.ranks)) return null;
  let total = 0n;
  for (const row of data.ranks) {
    const score = recoveredIntegerBigInt(row?.score);
    if (score === null) return null;
    total += score;
    if (total < SIGNED_INT64_MIN || total > SIGNED_INT64_MAX) return null;
  }
  const originalUserCount = nullableNonNegativeInteger(entryUserCount);
  const fallbackTotal = nullableNonNegativeInteger(data.total);
  return Object.freeze({
    currentScore: recoveredIntegerValue(total),
    userCount: originalUserCount !== null && originalUserCount > 0
      ? originalUserCount
      : fallbackTotal
  });
}
