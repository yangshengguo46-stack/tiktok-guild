export const CANDIDATE_BUSINESS_POLICY = Object.freeze({
  diamondsPerUsd: 100,
  diamondEstimateBasis: "user_policy_100_diamonds_per_usd",
  followerInvitationBoundary: 1_000_000,
  originalHighQualityScoreThreshold: 10,
  originalHighQualityScoreFields: Object.freeze([
    "currentScore",
    "historyRankScore",
    "hotListScore",
    "rankRecordScore",
    "rankingScore"
  ])
});

const ORIGINAL_SCORE_INPUTS = Object.freeze({
  currentScore: Object.freeze(["currentScore", "CurrentScore"]),
  topScore: Object.freeze(["topScore", "TopScore"]),
  historyRankScore: Object.freeze(["historyRankScore", "HistoryRankScore"]),
  hotListScore: Object.freeze(["hotListScore", "HotListScore"]),
  rankRecordScore: Object.freeze(["rankRecordScore", "RankRecordScore"]),
  rankingScore: Object.freeze(["rankingScore", "RankingScore"])
});

function normalizedIntegerScore(value) {
  if (typeof value === "bigint") {
    if (value < 0n) return null;
    return { raw: value.toString(), comparable: value };
  }
  if (typeof value === "number") {
    // Unsafe JSON numbers have already lost integer precision; require callers
    // to preserve large scores as decimal strings (or bigint) instead.
    if (!Number.isSafeInteger(value) || value < 0) return null;
    return { raw: value, comparable: BigInt(value) };
  }
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw) return null;
  const unsigned = raw.startsWith("+") ? raw.slice(1) : raw;
  if (!/^\d+$/.test(unsigned) && !/^\d{1,3}(?:,\d{3})+$/.test(unsigned)) return null;
  const comparableText = unsigned.replaceAll(",", "");
  try {
    const comparable = BigInt(comparableText);
    return { raw: comparable.toString(), comparable };
  } catch {
    return null;
  }
}

function firstOriginalScore(input, field) {
  for (const key of ORIGINAL_SCORE_INPUTS[field]) {
    const normalized = normalizeOriginalScoreRaw(input?.[key]);
    if (normalized !== null) return normalized;
  }
  return null;
}

/**
 * Preserve a raw integer leaderboard score while making bigint values JSON-safe.
 * Invalid or missing evidence stays null; numeric strings are not rounded through
 * JavaScript Number, so values beyond Number.MAX_SAFE_INTEGER remain exact.
 */
export function normalizeOriginalScoreRaw(value) {
  return normalizedIntegerScore(value)?.raw ?? null;
}

/**
 * Return the exact raw maximum only when every supplied score is known. This is
 * used for the legacy historical-max compatibility alias and never fills gaps.
 */
export function deriveOriginalScoreMaximum(values = []) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const normalized = values.map(normalizedIntegerScore);
  if (normalized.some((value) => value === null)) return null;
  let maximum = normalized[0];
  for (const value of normalized.slice(1)) {
    if (value.comparable > maximum.comparable) maximum = value;
  }
  return maximum.raw;
}

/**
 * Reproduce TKsoft's fixed high-quality predicate as a three-state decision.
 * TopScore is deliberately excluded. One observed score >= 10 proves true;
 * false requires all five participating fields to be known and below 10.
 */
export function deriveOriginalHighQuality(scores = {}) {
  const threshold = BigInt(CANDIDATE_BUSINESS_POLICY.originalHighQualityScoreThreshold);
  const comparisons = CANDIDATE_BUSINESS_POLICY.originalHighQualityScoreFields.map((field) => {
    const raw = firstOriginalScore(scores, field);
    const normalized = normalizedIntegerScore(raw);
    return normalized === null ? null : normalized.comparable >= threshold;
  });
  if (comparisons.includes(true)) return true;
  if (comparisons.every((value) => value === false)) return false;
  return null;
}

function finiteNumericRaw(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const normalized = value.trim().replaceAll(",", "");
  if (!/^-?(?:\d+(?:\.\d+)?|\.\d+)$/.test(normalized)) return null;
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

function followerCount(value) {
  const number = finiteNumericRaw(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function immutableClone(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(immutableClone));
  if (!value || typeof value !== "object") return value;
  return Object.freeze(Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [key, immutableClone(nested)])
  ));
}

function qualificationSnapshot(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? immutableClone(value)
    : null;
}

/**
 * Convert one raw diamond/rank-score value into an optional business estimate.
 * Negative numeric sentinels remain visible as raw evidence but are not money.
 */
export function deriveDiamondUsdEstimate(value) {
  const rawDiamonds = finiteNumericRaw(value);
  return Object.freeze({
    rawDiamonds,
    estimatedUsd: rawDiamonds !== null && rawDiamonds >= 0
      ? rawDiamonds / CANDIDATE_BUSINESS_POLICY.diamondsPerUsd
      : null,
    currency: "USD",
    approximate: true,
    basis: CANDIDATE_BUSINESS_POLICY.diamondEstimateBasis,
    diamondsPerUsd: CANDIDATE_BUSINESS_POLICY.diamondsPerUsd
  });
}

/**
 * Apply the deployment estimate only when the source explicitly identifies
 * the field as diamonds. Legacy leaderboard scores use an unknown unit and
 * therefore return null here even when they are numeric.
 */
export function deriveDiamondUsdEstimateForEvidence(value, unit) {
  return unit === "diamonds" ? deriveDiamondUsdEstimate(value) : null;
}

/**
 * Return advisory routing metadata only. This never decides eligibility.
 */
export function deriveExpectedInvitationLane(value) {
  const normalizedFollowers = followerCount(value);
  let expectedInvitationLane = null;
  if (normalizedFollowers !== null) {
    if (normalizedFollowers < CANDIDATE_BUSINESS_POLICY.followerInvitationBoundary) {
      expectedInvitationLane = "regular";
    } else if (normalizedFollowers > CANDIDATE_BUSINESS_POLICY.followerInvitationBoundary) {
      expectedInvitationLane = "advanced";
    } else {
      expectedInvitationLane = "backend_required";
    }
  }
  return Object.freeze({
    followerCount: normalizedFollowers,
    expectedInvitationLane,
    advisory: true
  });
}

/**
 * Build the deployment-specific candidate policy projection. Legacy vendor
 * evidence and current collection-sub-backend evidence deliberately remain
 * separate, even when their labels or decisions conflict.
 */
export function normalizeCandidatePolicy({
  diamondValue = null,
  diamondUnit = null,
  followerCount: rawFollowerCount = null,
  legacyQualification = null,
  backstageQualification = null
} = {}) {
  return Object.freeze({
    diamondEstimate: deriveDiamondUsdEstimateForEvidence(diamondValue, diamondUnit),
    invitationExpectation: deriveExpectedInvitationLane(rawFollowerCount),
    legacyQualification: qualificationSnapshot(legacyQualification),
    backstageQualification: qualificationSnapshot(backstageQualification)
  });
}
