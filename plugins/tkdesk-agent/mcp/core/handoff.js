import crypto from "node:crypto";
import {
  deriveOriginalScoreMaximum,
  normalizeOriginalScoreRaw
} from "./candidate-policy.js";
import { sanitizeTikTokUrl } from "../adapters/tiktok-live.js";

const UNKNOWN_RANK_SCORE_UNIT = "unknown_rank_score";

const ORIGINAL_SCORE_FIELDS = Object.freeze([
  "currentScore",
  "topScore",
  "historyRankScore",
  "hotListScore",
  "rankRecordScore",
  "rankingScore"
]);

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function firstEvidenceValue(...values) {
  for (const value of values) {
    if (value !== null && value !== undefined && value !== "") return value;
  }
  return null;
}

function evidenceLabel(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue;
    if (typeof value !== "string") return value;
    const normalized = value.trim();
    if (!normalized || normalized.toLowerCase() === "unknown" || normalized === "未知") continue;
    return normalized;
  }
  return null;
}

function firstScoreValue(...values) {
  for (const value of values) {
    const normalized = normalizeOriginalScoreRaw(value);
    if (normalized !== null) return normalized;
  }
  return null;
}

function directProfileUrl(candidate = {}) {
  const rawUrl = candidate.profileUrl;
  if (typeof rawUrl === "string" && rawUrl !== "[REDACTED_URL]") {
    const safeUrl = sanitizeTikTokUrl(rawUrl);
    if (safeUrl && safeUrl !== "[REDACTED_URL]") return safeUrl;
  }
  const handle = String(candidate.handle ?? "").trim().replace(/^@+/, "");
  return /^[a-z\d._]{1,64}$/i.test(handle)
    ? `https://www.tiktok.com/@${encodeURIComponent(handle)}`
    : null;
}

function originalScoreEvidence(candidate = {}) {
  const candidateUnits = candidate.diamondFieldUnits
    && typeof candidate.diamondFieldUnits === "object"
    && !Array.isArray(candidate.diamondFieldUnits)
    ? candidate.diamondFieldUnits
    : {};
  const candidateEstimates = candidate.diamondUsdEstimates
    && typeof candidate.diamondUsdEstimates === "object"
    && !Array.isArray(candidate.diamondUsdEstimates)
    ? candidate.diamondUsdEstimates
    : {};

  const explicit = {
    currentScore: firstScoreValue(candidate.currentScore, candidate.CurrentScore),
    topScore: firstScoreValue(candidate.topScore, candidate.TopScore),
    historyRankScore: firstScoreValue(candidate.historyRankScore, candidate.HistoryRankScore),
    hotListScore: firstScoreValue(candidate.hotListScore, candidate.HotListScore),
    rankRecordScore: firstScoreValue(candidate.rankRecordScore, candidate.RankRecordScore),
    rankingScore: firstScoreValue(candidate.rankingScore, candidate.RankingScore)
  };
  const existingAliases = {
    diamondCurrent: firstScoreValue(candidate.diamondCurrent),
    diamondPeriod: firstScoreValue(candidate.diamondPeriod),
    diamondRankingRecord: firstScoreValue(candidate.diamondRankingRecord),
    diamondHistoricalMax: firstScoreValue(candidate.diamondHistoricalMax)
  };

  // Old TKDesk rows may only have the direct compatibility aliases. Backfill
  // an original field only when its stored unit proves it was a raw rank score.
  const scores = {
    ...explicit,
    currentScore: explicit.currentScore
      ?? (candidateUnits.current === UNKNOWN_RANK_SCORE_UNIT ? existingAliases.diamondCurrent : null),
    topScore: explicit.topScore
      ?? (candidateUnits.period === UNKNOWN_RANK_SCORE_UNIT ? existingAliases.diamondPeriod : null),
    historyRankScore: explicit.historyRankScore
      ?? (candidateUnits.rankingRecord === UNKNOWN_RANK_SCORE_UNIT
        ? existingAliases.diamondRankingRecord
        : null)
  };
  const derivedHistoricalMax = deriveOriginalScoreMaximum([
    scores.hotListScore,
    scores.rankRecordScore,
    scores.rankingScore
  ]);
  const aliases = {
    diamondCurrent: existingAliases.diamondCurrent ?? scores.currentScore,
    diamondPeriod: existingAliases.diamondPeriod ?? scores.topScore,
    diamondRankingRecord: existingAliases.diamondRankingRecord ?? scores.historyRankScore,
    // A pre-existing legacy value is direct evidence. Otherwise the compressed
    // alias is safe only when all three contributing fields are present.
    diamondHistoricalMax: existingAliases.diamondHistoricalMax ?? derivedHistoricalMax
  };
  const aliasWasDerived = {
    current: existingAliases.diamondCurrent === null && aliases.diamondCurrent !== null,
    period: existingAliases.diamondPeriod === null && aliases.diamondPeriod !== null,
    rankingRecord: existingAliases.diamondRankingRecord === null && aliases.diamondRankingRecord !== null,
    historicalMax: existingAliases.diamondHistoricalMax === null && aliases.diamondHistoricalMax !== null
  };
  const diamondFieldUnits = {
    current: aliasWasDerived.current ? UNKNOWN_RANK_SCORE_UNIT : (candidateUnits.current ?? null),
    period: aliasWasDerived.period ? UNKNOWN_RANK_SCORE_UNIT : (candidateUnits.period ?? null),
    rankingRecord: aliasWasDerived.rankingRecord
      ? UNKNOWN_RANK_SCORE_UNIT
      : (candidateUnits.rankingRecord ?? null),
    historicalMax: aliasWasDerived.historicalMax
      ? UNKNOWN_RANK_SCORE_UNIT
      : (candidateUnits.historicalMax ?? null)
  };
  const diamondUsdEstimates = Object.fromEntries(
    Object.keys(diamondFieldUnits).map((key) => [
      key,
      diamondFieldUnits[key] === "diamonds" ? (candidateEstimates[key] ?? null) : null
    ])
  );
  const scoreFieldUnits = Object.fromEntries(ORIGINAL_SCORE_FIELDS.map((field) => [
    field,
    scores[field] === null ? null : UNKNOWN_RANK_SCORE_UNIT
  ]));
  const hasOriginalScoreEvidence = Object.values(scores).some((value) => value !== null);
  const hasDiamondAliasEvidence = Object.values(aliases).some((value) => value !== null);
  const hasDiamondUnitEvidence = Object.values(candidateUnits)
    .some((value) => value !== null && value !== undefined);

  return {
    ...scores,
    scoreFieldUnits: hasOriginalScoreEvidence ? scoreFieldUnits : null,
    ...aliases,
    diamondFieldUnits: hasDiamondAliasEvidence || hasDiamondUnitEvidence ? diamondFieldUnits : null,
    diamondUsdEstimates: hasDiamondAliasEvidence || hasDiamondUnitEvidence ? diamondUsdEstimates : null
  };
}

function leaderboardEvidence(candidate = {}) {
  const rankEvidence = candidate.rankEvidence
    && typeof candidate.rankEvidence === "object"
    && !Array.isArray(candidate.rankEvidence)
    ? candidate.rankEvidence
    : {};
  const rank = firstEvidenceValue(candidate.rank, rankEvidence.rank);
  const rankScoreRaw = firstEvidenceValue(
    candidate.rankScoreRaw,
    rankEvidence.scoreRaw,
    rankEvidence.rankScoreRaw
  );
  const rankScoreType = evidenceLabel(
    candidate.rankScoreType,
    rankEvidence.scoreType,
    rankEvidence.rankScoreType
  );
  const rankScoreUnit = evidenceLabel(
    candidate.rankScoreUnit,
    rankEvidence.scoreUnit,
    rankEvidence.rankScoreUnit,
    rankEvidence.unit
  );
  const rankingPeriod = evidenceLabel(
    candidate.rankingPeriod,
    candidate.period,
    rankEvidence.period,
    rankEvidence.rankingPeriod
  );
  const rankingSubtab = evidenceLabel(
    candidate.rankingSubtab,
    candidate.subtab,
    rankEvidence.subtab,
    rankEvidence.rankingSubtab
  );
  const rankingCountdownSeconds = firstEvidenceValue(
    candidate.rankingCountdownSeconds,
    candidate.countdown,
    rankEvidence.countdown,
    rankEvidence.countdownSeconds
  );
  const rankTypeCode = firstEvidenceValue(candidate.rankTypeCode, rankEvidence.rankTypeCode);
  const regionTypeCode = firstEvidenceValue(candidate.regionTypeCode, rankEvidence.regionTypeCode);
  const gapInterval = firstEvidenceValue(candidate.gapInterval, rankEvidence.gapInterval);
  const rankingViewKind = evidenceLabel(
    candidate.rankingViewKind,
    rankEvidence.rankingViewKind
  );
  const adapterEvidenceVersion = evidenceLabel(
    candidate.adapterEvidenceVersion,
    rankEvidence.adapterEvidenceVersion
  );
  const hasEvidence = [
    rank,
    rankScoreRaw,
    rankScoreType,
    rankScoreUnit,
    rankingPeriod,
    rankingSubtab,
    rankingCountdownSeconds,
    rankTypeCode,
    regionTypeCode,
    gapInterval,
    rankingViewKind,
    adapterEvidenceVersion
  ].some((value) => value !== null);

  return {
    rank,
    rankScoreRaw,
    rankScoreType,
    rankScoreUnit,
    rankingPeriod,
    rankingSubtab,
    rankingCountdownSeconds,
    rankTypeCode,
    regionTypeCode,
    gapInterval,
    rankingViewKind,
    adapterEvidenceVersion,
    rankingSource: hasEvidence
      ? evidenceLabel(candidate.rankingSource, rankEvidence.source, candidate.source)
      : null,
    rankingObservedAt: hasEvidence
      ? evidenceLabel(candidate.rankingObservedAt, rankEvidence.observedAt, candidate.observedAt)
      : null
  };
}

function collectionRouteEvidence(candidate = {}) {
  return {
    rankingScopeMarketRegion: evidenceLabel(candidate.rankingScopeMarketRegion),
    rankingScopeCountryCode: evidenceLabel(candidate.rankingScopeCountryCode),
    rankingScopeCountryEvidence: evidenceLabel(candidate.rankingScopeCountryEvidence),
    routeProfileId: evidenceLabel(candidate.routeProfileId),
    proxyExitCountry: evidenceLabel(candidate.proxyExitCountry),
    routeFingerprint: evidenceLabel(candidate.routeFingerprint),
    routeConfigurationFingerprint: evidenceLabel(candidate.routeConfigurationFingerprint),
    routeVerifiedAt: evidenceLabel(candidate.routeVerifiedAt),
    backstageCountry: evidenceLabel(candidate.backstageCountry),
    backstageCountryEvidence: evidenceLabel(candidate.backstageCountryEvidence)
  };
}

function numericLeaderboardRank(value) {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value !== "string" || !/^\d+$/.test(value.trim())) return null;
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function compareStableText(left, right) {
  const leftText = String(left ?? "");
  const rightText = String(right ?? "");
  return leftText < rightText ? -1 : leftText > rightText ? 1 : 0;
}

function compareHandoffCandidates(left, right) {
  const leftRank = numericLeaderboardRank(left.rank);
  const rightRank = numericLeaderboardRank(right.rank);
  const leftGroup = leftRank !== null && left.rankingSource
    ? canonicalJson([left.rankingSource, left.rankingPeriod])
    : null;
  const rightGroup = rightRank !== null && right.rankingSource
    ? canonicalJson([right.rankingSource, right.rankingPeriod])
    : null;

  if (leftGroup !== null || rightGroup !== null) {
    if (leftGroup === null) return 1;
    if (rightGroup === null) return -1;
    const groupOrder = compareStableText(leftGroup, rightGroup);
    if (groupOrder) return groupOrder;
    if (leftRank !== rightRank) return leftRank - rightRank;
  }

  const candidateOrder = compareStableText(left.candidateId, right.candidateId);
  if (candidateOrder) return candidateOrder;
  return compareStableText(canonicalJson(left), canonicalJson(right));
}

export function summarizeCandidates(candidates = []) {
  const known = (field) => candidates.filter((candidate) => candidate[field] !== null && candidate[field] !== undefined && candidate[field] !== "").length;
  const bucket = (field) => {
    const counts = new Map();
    for (const candidate of candidates) {
      const label = String(candidate[field] ?? "未知");
      counts.set(label, (counts.get(label) || 0) + 1);
    }
    return [...counts.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, 12)
      .map(([label, count]) => ({ label, count }));
  };
  const freshness = candidates.map((candidate) => candidate.observedAt).filter(Boolean).sort();
  const leaderboard = candidates.map(leaderboardEvidence);
  const leaderboardKnown = (field) => leaderboard.filter((evidence) => evidence[field] !== null).length;
  const routeEvidence = candidates.map(collectionRouteEvidence);
  const routeEvidenceKnown = (field) => routeEvidence.filter((evidence) => evidence[field] !== null).length;
  const scores = candidates.map(originalScoreEvidence);
  const scoreKnown = (field) => scores.filter((evidence) => evidence[field] !== null).length;
  return {
    total: candidates.length,
    fieldCoverage: {
      stablePlatformId: candidates.filter((candidate) => candidate.userId || candidate.secUid).length,
      handle: known("handle"),
      marketRegion: known("marketRegion"),
      routeCountry: known("routeCountry"),
      countryCode: known("countryCode"),
      followerCount: known("followerCount"),
      highQuality: known("highQuality"),
      qualificationStatus: known("qualificationStatus"),
      topCode: known("topCode"),
      rankingLabel: known("rankingLabel"),
      originalRankingCountdownSeconds: known("originalRankingCountdownSeconds"),
      originalScoreEvidence: known("originalScoreEvidence"),
      currentScore: scoreKnown("currentScore"),
      topScore: scoreKnown("topScore"),
      historyRankScore: scoreKnown("historyRankScore"),
      hotListScore: scoreKnown("hotListScore"),
      rankRecordScore: scoreKnown("rankRecordScore"),
      rankingScore: scoreKnown("rankingScore"),
      diamondCurrent: scoreKnown("diamondCurrent"),
      diamondPeriod: scoreKnown("diamondPeriod"),
      diamondRankingRecord: scoreKnown("diamondRankingRecord"),
      diamondHistoricalMax: scoreKnown("diamondHistoricalMax"),
      rank: leaderboardKnown("rank"),
      rankScoreRaw: leaderboardKnown("rankScoreRaw"),
      rankScoreType: leaderboardKnown("rankScoreType"),
      rankScoreUnit: leaderboardKnown("rankScoreUnit"),
      rankingPeriod: leaderboardKnown("rankingPeriod"),
      rankingSubtab: leaderboardKnown("rankingSubtab"),
      rankingSource: leaderboardKnown("rankingSource"),
      rankingObservedAt: leaderboardKnown("rankingObservedAt"),
      rankTypeCode: leaderboardKnown("rankTypeCode"),
      regionTypeCode: leaderboardKnown("regionTypeCode"),
      gapInterval: leaderboardKnown("gapInterval"),
      rankingViewKind: leaderboardKnown("rankingViewKind"),
      adapterEvidenceVersion: leaderboardKnown("adapterEvidenceVersion"),
      rankingScopeMarketRegion: routeEvidenceKnown("rankingScopeMarketRegion"),
      rankingScopeCountryCode: routeEvidenceKnown("rankingScopeCountryCode"),
      rankingScopeCountryEvidence: routeEvidenceKnown("rankingScopeCountryEvidence"),
      routeProfileId: routeEvidenceKnown("routeProfileId"),
      proxyExitCountry: routeEvidenceKnown("proxyExitCountry"),
      routeFingerprint: routeEvidenceKnown("routeFingerprint"),
      routeConfigurationFingerprint: routeEvidenceKnown("routeConfigurationFingerprint"),
      routeVerifiedAt: routeEvidenceKnown("routeVerifiedAt"),
      backstageCountry: routeEvidenceKnown("backstageCountry"),
      backstageCountryEvidence: routeEvidenceKnown("backstageCountryEvidence")
    },
    sources: bucket("source"),
    countries: bucket("countryCode"),
    qualificationStatuses: bucket("qualificationStatus"),
    oldestObservationAt: freshness[0] ?? null,
    newestObservationAt: freshness.at(-1) ?? null
  };
}

export function anonymizeCandidate(candidate, index = 0) {
  const ranking = leaderboardEvidence(candidate);
  const routeEvidence = collectionRouteEvidence(candidate);
  const scores = originalScoreEvidence(candidate);
  return {
    candidateRef: candidate.candidateId || `candidate-${String(index + 1).padStart(4, "0")}`,
    source: candidate.source ?? null,
    discoveryMethod: candidate.discoveryMethod ?? null,
    marketRegion: candidate.marketRegion ?? null,
    routeCountry: candidate.routeCountry ?? null,
    countryCode: candidate.countryCode ?? null,
    followerCount: candidate.followerCount ?? null,
    viewerCount: candidate.viewerCount ?? null,
    live: candidate.live ?? null,
    seller: candidate.seller ?? null,
    highQuality: candidate.highQuality ?? null,
    liveTag: candidate.liveTag ?? null,
    topCode: candidate.topCode ?? null,
    rankingLabel: candidate.rankingLabel ?? null,
    originalRankingCountdownSeconds: candidate.originalRankingCountdownSeconds ?? null,
    originalScoreEvidence: candidate.originalScoreEvidence ?? null,
    ...scores,
    ...ranking,
    ...routeEvidence,
    qualificationStatus: candidate.qualificationStatus ?? null,
    expectedInvitationLane: candidate.expectedInvitationLane ?? null,
    qualificationObservedAt: candidate.qualificationObservedAt ?? null,
    observedAt: candidate.observedAt ?? null,
    confidence: candidate.confidence ?? null
  };
}

export function buildHandoff({ candidates, runId = null, destination, purpose, filters = {} }) {
  const generatedAt = new Date().toISOString();
  const dataset = (candidates ?? []).map((candidate) => {
    const ranking = leaderboardEvidence(candidate);
    const routeEvidence = collectionRouteEvidence(candidate);
    const scores = originalScoreEvidence(candidate);
    return {
      candidateId: candidate.candidateId ?? null,
      userId: candidate.userId ?? null,
      secUid: candidate.secUid ?? null,
      handle: candidate.handle ?? null,
      displayName: candidate.displayName ?? null,
      profileUrl: directProfileUrl(candidate),
      roomId: candidate.roomId ?? null,
      region: candidate.region ?? null,
      marketRegion: candidate.marketRegion ?? null,
      routeCountry: candidate.routeCountry ?? null,
      creatorCountryCode: candidate.creatorCountryCode ?? candidate.countryCode ?? null,
      countryCode: candidate.countryCode ?? null,
      followerCount: candidate.followerCount ?? null,
      viewerCount: candidate.viewerCount ?? null,
      live: candidate.live ?? null,
      seller: candidate.seller ?? null,
      highQuality: candidate.highQuality ?? null,
      liveTag: candidate.liveTag ?? null,
      liveDurationMinutes: candidate.liveDurationMinutes ?? null,
      creatorLevel: candidate.creatorLevel ?? null,
      topCode: candidate.topCode ?? null,
      rankingLabel: candidate.rankingLabel ?? null,
      originalRankingCountdownSeconds: candidate.originalRankingCountdownSeconds ?? null,
      originalScoreEvidence: candidate.originalScoreEvidence ?? null,
      ...scores,
      ...ranking,
      ...routeEvidence,
      expectedInvitationLane: candidate.expectedInvitationLane ?? null,
      source: candidate.source ?? null,
      discoveryMethod: candidate.discoveryMethod ?? null,
      sourceUrl: candidate.sourceUrl ? sanitizeTikTokUrl(candidate.sourceUrl) : null,
      qualificationStatus: candidate.qualificationStatus ?? null,
      qualificationReason: candidate.qualificationReason ?? null,
      qualificationObservedAt: candidate.qualificationObservedAt ?? null,
      qualificationSource: candidate.qualificationSource ?? null,
      legacyQualification: candidate.legacyQualification ?? null,
      backstageQualification: candidate.backstageQualification ?? null,
      observedAt: candidate.observedAt ?? null,
      confidence: candidate.confidence ?? null,
      outreachStatus: "not_contacted"
    };
  }).sort(compareHandoffCandidates);
  const datasetHash = crypto.createHash("sha256").update(canonicalJson(dataset)).digest("hex");
  return {
    schemaVersion: "tkdesk.candidate-handoff.v4",
    batchId: crypto.randomUUID(),
    runId,
    datasetHash,
    generatedAt,
    destination,
    purpose,
    filters,
    status: "pending_review",
    sendAuthorized: false,
    count: dataset.length,
    candidates: dataset
  };
}
