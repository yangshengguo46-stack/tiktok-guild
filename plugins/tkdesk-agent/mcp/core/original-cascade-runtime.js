import {
  deriveOriginalHighQuality,
  deriveOriginalScoreMaximum,
  normalizeOriginalScoreRaw
} from "./candidate-policy.js";
import { collectTikTokLiveRanking } from "../adapters/tiktok-live-ranking.js";
import { originalWebLiveProfileForCountry } from "./original-web-live-config.js";
import { sanitizeTikTokText } from "../adapters/tiktok-live.js";

const ORIGINAL_DISCOVERY_UNION_EVIDENCE_VERSION = "original-country-discovery-union-v1";

function normalizedCountry(value) {
  const country = typeof value === "string" ? value.trim().toUpperCase() : "";
  return /^[A-Z]{2}$/.test(country) ? country : null;
}

function laneEvidenceMatches(lane, evidence, expectedWorkId = lane?.workId) {
  if (!evidence || typeof evidence !== "object") return false;
  return Number(evidence.workId) === Number(expectedWorkId)
    && normalizedCountry(evidence.countryCode) === normalizedCountry(lane.countryCode)
    && normalizedCountry(evidence.exitCountry) === normalizedCountry(lane.proxyExitCountry);
}

function feedResultMatchesLane(lane, result) {
  if (Number(result?.workId) !== Number(lane.workId)
    || normalizedCountry(result?.rankingScopeCountryCode) !== normalizedCountry(lane.countryCode)
    || !laneEvidenceMatches(lane, result?.collectionLaneEvidence)) {
    return false;
  }
  return (result.candidates ?? []).every((candidate) => (
    Number(candidate?.workId) === Number(lane.workId)
      && normalizedCountry(candidate?.rankingScopeCountryCode) === normalizedCountry(lane.countryCode)
      && laneEvidenceMatches(lane, candidate?.collectionLaneEvidence)
  ));
}

function templateResultMatchesLane(lane, result) {
  if (Number(result?.workId) !== Number(lane.workId)
    || normalizedCountry(result?.countryCode) !== normalizedCountry(lane.countryCode)
    || !laneEvidenceMatches(lane, result?.collectionLaneEvidence)) {
    return false;
  }
  return (result.candidates ?? []).every((candidate) => (
    Number(candidate?.workId) === Number(lane.workId)
      && normalizedCountry(candidate?.rankingScopeCountryCode) === normalizedCountry(lane.countryCode)
      && laneEvidenceMatches(lane, candidate?.collectionLaneEvidence)
  ));
}

function normalizedHandle(value) {
  const text = typeof value === "string" ? value.trim().replace(/^@/, "") : "";
  return text ? text.toLocaleLowerCase("en-US") : null;
}

function stableIdentityAliases(candidate) {
  return [
    ["user", candidate?.userId ? String(candidate.userId) : null],
    ["sec", candidate?.secUid ? String(candidate.secUid) : null],
    ["room", candidate?.roomId ? String(candidate.roomId) : null]
  ].filter(([, value]) => value);
}

export function mergeOriginalDiscoverySeeds(seedGroups) {
  const merged = [];
  const displayIndex = new Map();
  const stableAliasIndex = new Map();
  let identityConflicts = 0;
  for (const { sourceKind, candidates } of seedGroups) {
    for (const candidate of candidates ?? []) {
      const displayKey = normalizedHandle(candidate?.handle ?? candidate?.displayId);
      if (!displayKey) continue;
      const displayMatch = displayIndex.get(displayKey);
      const aliasMatches = new Set(
        stableIdentityAliases(candidate)
          .map(([kind, value]) => stableAliasIndex.get(`${kind}:${value}`))
          .filter(Number.isInteger)
      );
      // DisplayID is the original primary key. Stable IDs only prove a
      // conflict; they never merge a different handle into an existing row.
      if ((displayMatch === undefined && aliasMatches.size > 0)
        || aliasMatches.size > 1
        || (displayMatch !== undefined
          && [...aliasMatches].some((index) => index !== displayMatch))) {
        identityConflicts += 1;
        continue;
      }
      let index = displayMatch ?? null;
      if (index === null) {
        index = merged.length;
        merged.push({
          ...candidate,
          handle: candidate.handle ?? candidate.displayId ?? null,
          discoverySourceKinds: [sourceKind]
        });
      } else {
        const current = merged[index];
        const conflicts = ["userId", "secUid", "roomId"].some((key) => (
          current[key] !== null && current[key] !== undefined
          && candidate[key] !== null && candidate[key] !== undefined
          && String(current[key]) !== String(candidate[key])
        ));
        if (conflicts) {
          identityConflicts += 1;
          continue;
        }
        for (const key of [
        "handle", "displayId", "userId", "secUid", "roomId", "displayName",
          "nickname", "followerCount", "viewerCount", "seller", "topCode",
          "rankingDisplayName"
        ]) {
          if ((current[key] === null || current[key] === undefined)
            && candidate[key] !== null && candidate[key] !== undefined) {
            current[key] = candidate[key];
          }
        }
        for (const key of ["topScore", "historyRankScore", "hotListScore", "rankRecordScore"]) {
          const incoming = candidate[key] ?? null;
          if (current[key] === null || current[key] === undefined) current[key] = incoming;
          else if (incoming !== null && String(current[key]) !== String(incoming)) current[key] = null;
        }
        if (!current.discoverySourceKinds.includes(sourceKind)) {
          current.discoverySourceKinds.push(sourceKind);
        }
        if (candidate.mobileTemplateEvidence) {
          current.mobileTemplateEvidence = candidate.mobileTemplateEvidence;
        }
      }
      displayIndex.set(displayKey, index);
      for (const [kind, value] of stableIdentityAliases(merged[index])) {
        stableAliasIndex.set(`${kind}:${value}`, index);
      }
    }
  }
  return {
    candidates: merged.map((candidate) => ({
      ...candidate,
      discoverySourceKinds: Object.freeze([...candidate.discoverySourceKinds])
    })),
    identityConflicts
  };
}

/**
 * Start one original PC-Web feed request per selected country at the same
 * Promise boundary. The returned rows retain lane identity and fail closed if
 * a transport response drifts onto another WorkID/country proxy lane.
 */
export async function fetchOriginalCountryFeedLaneRound({
  selectedLanes,
  verifiedRoute,
  marketRegion,
  limit,
  shouldStop = () => false,
  fetchOnce
} = {}) {
  if (!Array.isArray(selectedLanes) || selectedLanes.length < 1 || selectedLanes.length > 3) {
    throw new TypeError("selectedLanes must contain one to three country lanes");
  }
  if (typeof fetchOnce !== "function") throw new TypeError("fetchOnce is required");
  const workIds = new Set();
  const countries = new Set();
  for (const lane of selectedLanes) {
    const workId = Number(lane?.workId);
    const countryCode = normalizedCountry(lane?.countryCode);
    const exitCountry = normalizedCountry(lane?.proxyExitCountry);
    if (!Number.isInteger(workId) || workId < 1 || workId > 3
      || !countryCode || countryCode !== exitCountry
      || workIds.has(workId) || countries.has(countryCode)) {
      throw new TypeError("selectedLanes must be unique, verified WorkID country lanes");
    }
    workIds.add(workId);
    countries.add(countryCode);
  }

  return Promise.all(selectedLanes.map(async (lane) => {
    const result = await fetchOnce({
      verifiedRoute,
      workId: lane.workId,
      marketRegion,
      countryCode: lane.countryCode,
      displayName: lane.displayName ?? null,
      limit,
      shouldStop
    });
    if (result?.status === "ready" && !feedResultMatchesLane(lane, result)) {
      return {
        lane,
        workId: lane.workId,
        result: {
          status: "capability_not_ready",
          capability: "original_country_live_feed",
          reason: "feed_lane_evidence_mismatch",
          candidates: []
        }
      };
    }
    return { lane, workId: lane.workId, result };
  }));
}

/**
 * Start one fixed MobileProcessor country-template bundle per selected lane.
 * The display variant is resolved from the same natural country partition as
 * the PC-Web worker, so callers cannot inject a free-form template selector.
 */
export async function fetchOriginalCountryTemplateLaneRound({
  selectedLanes,
  verifiedRoute,
  marketRegion,
  shouldStop = () => false,
  fetchOnce
} = {}) {
  if (!Array.isArray(selectedLanes) || selectedLanes.length < 1 || selectedLanes.length > 3) {
    throw new TypeError("selectedLanes must contain one to three country lanes");
  }
  if (typeof fetchOnce !== "function") throw new TypeError("fetchOnce is required");
  return Promise.all(selectedLanes.map(async (lane) => {
    const profile = originalWebLiveProfileForCountry({
      marketRegion,
      countryCode: lane.countryCode,
      displayName: lane.displayName ?? null
    });
    if (!profile) {
      return {
        lane,
        workId: lane.workId,
        displayName: null,
        result: {
          status: "capability_not_ready",
          capability: "regional_gift_ranking",
          reason: "ranking_country_template_display_variant_required",
          candidates: []
        }
      };
    }
    const result = await fetchOnce({
      verifiedRoute,
      workId: lane.workId,
      marketRegion,
      countryCode: lane.countryCode,
      displayName: profile.displayName,
      shouldStop
    });
    if (result?.status === "ready" && !templateResultMatchesLane(lane, result)) {
      return {
        lane,
        workId: lane.workId,
        displayName: profile.displayName,
        result: {
          status: "capability_not_ready",
          capability: "regional_gift_ranking",
          reason: "ranking_country_template_lane_evidence_mismatch",
          candidates: []
        }
      };
    }
    return { lane, workId: lane.workId, displayName: profile.displayName, result };
  }));
}

/**
 * Shared DataProcessor worker pool used by both feed seeds (WorkID 1..3) and
 * ranking descendants (WorkID 4). Lane resolution remains an injected daemon
 * policy so WorkID4 must carry an explicit ranking-country affinity.
 */
export async function runOriginalDataProcessorWorkerPool({
  seeds,
  verifiedRoute,
  filters = {},
  shouldStop = () => false,
  laneForCandidate,
  enrichOnce,
  maxWorkers = 4
} = {}) {
  if (!Array.isArray(seeds)) throw new TypeError("seeds must be an array");
  if (typeof laneForCandidate !== "function") throw new TypeError("laneForCandidate is required");
  if (typeof enrichOnce !== "function") throw new TypeError("enrichOnce is required");
  const requestedWorkerCount = Number.isSafeInteger(maxWorkers) ? maxWorkers : 4;
  const workerCount = Math.min(4, Math.max(1, requestedWorkerCount));
  const results = new Array(seeds.length);
  let cursor = 0;
  const worker = async () => {
    while (!shouldStop()) {
      const index = cursor;
      cursor += 1;
      if (index >= seeds.length) return;
      const seed = seeds[index];
      const lane = laneForCandidate(verifiedRoute, seed);
      if (!lane) {
        results[index] = {
          seed,
          targetCountryCode: null,
          result: { status: "partial", reason: "collection_country_lane_missing" }
        };
        continue;
      }
      const result = await enrichOnce({
        seed,
        verifiedRoute,
        countryCode: lane.countryCode,
        minFollowers: filters.minFollowers ?? null,
        maxFollowers: filters.maxFollowers ?? null,
        shouldStop
      });
      results[index] = { seed, targetCountryCode: lane.countryCode, result };
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(workerCount, Math.max(1, seeds.length)) },
    () => worker()
  ));
  return results;
}

/**
 * Project the fixed original DataProcessor result into the durable candidate
 * shape. This is shared by the daemon and the injected integration seam so a
 * test cannot replace the local filtering/classification step with a public
 * LIVE-card row.
 */
export function originalDataProcessorCandidate(seed, result, {
  nowMs = Date.now()
} = {}) {
  const enrichment = result?.enrichment ?? {};
  const liveTime = Number.isSafeInteger(enrichment.liveTime) ? enrichment.liveTime : null;
  const liveDurationMinutes = liveTime !== null
    ? Math.max(0, Math.floor((nowMs / 1_000 - liveTime) / 60))
    : null;
  const scores = {
    currentScore: normalizeOriginalScoreRaw(
      enrichment.currentScore ?? seed.currentScore ?? seed.diamondCurrent
    ),
    topScore: normalizeOriginalScoreRaw(
      enrichment.topScore ?? seed.topScore ?? seed.diamondPeriod
    ),
    historyRankScore: normalizeOriginalScoreRaw(
      enrichment.historyRankScore ?? seed.historyRankScore ?? seed.diamondRankingRecord
    ),
    hotListScore: normalizeOriginalScoreRaw(enrichment.hotListScore ?? seed.hotListScore),
    rankRecordScore: normalizeOriginalScoreRaw(
      enrichment.rankRecordScore ?? seed.rankRecordScore
    ),
    rankingScore: normalizeOriginalScoreRaw(enrichment.rankingScore ?? seed.rankingScore)
  };
  const scoreFieldUnits = Object.fromEntries(Object.entries(scores).map(([field, value]) => [
    field,
    value === null ? null : "unknown_rank_score"
  ]));
  const derivedHistoricalMax = deriveOriginalScoreMaximum([
    scores.hotListScore,
    scores.rankRecordScore,
    scores.rankingScore
  ]);
  const highQuality = deriveOriginalHighQuality(scores);
  return {
    ...seed,
    workId: result?.workId ?? seed.workId ?? null,
    collectionLaneEvidence: result?.collectionLaneEvidence
      ?? seed.collectionLaneEvidence
      ?? null,
    userId: enrichment.userId ?? seed.userId ?? null,
    secUid: enrichment.secUid ?? seed.secUid ?? null,
    roomId: enrichment.roomId ?? seed.roomId ?? null,
    followerCount: enrichment.followerCount ?? seed.followerCount ?? null,
    viewerCount: enrichment.userCount ?? seed.viewerCount ?? null,
    region: enrichment.region ?? seed.region ?? null,
    creatorCountryCode: enrichment.creatorCountryCode ?? seed.creatorCountryCode ?? null,
    countryCode: enrichment.creatorCountryCode ?? seed.countryCode ?? null,
    liveTime,
    liveDurationMinutes,
    creatorLevel: enrichment.creatorLevel ?? seed.creatorLevel ?? null,
    ...scores,
    scoreFieldUnits,
    topCode: enrichment.topCode ?? seed.topCode ?? null,
    rankingLabel: enrichment.ranking ?? seed.rankingLabel ?? null,
    rankingTitleState: enrichment.rankingTitleState ?? seed.rankingTitleState ?? null,
    originalRankingCountdownSeconds: enrichment.countdown
      ?? seed.originalRankingCountdownSeconds
      ?? null,
    originalScoreEvidence: result.originalScoreEvidence ?? null,
    highQuality,
    diamondCurrent: seed.diamondCurrent ?? scores.currentScore,
    diamondPeriod: seed.diamondPeriod ?? scores.topScore,
    diamondRankingRecord: seed.diamondRankingRecord ?? scores.historyRankScore,
    diamondHistoricalMax: seed.diamondHistoricalMax ?? derivedHistoricalMax,
    diamondFieldUnits: {
      ...(seed.diamondFieldUnits ?? {}),
      current: seed.diamondCurrent !== null && seed.diamondCurrent !== undefined
        ? (seed.diamondFieldUnits?.current ?? null)
        : scores.currentScore === null ? null : "unknown_rank_score",
      period: seed.diamondPeriod !== null && seed.diamondPeriod !== undefined
        ? (seed.diamondFieldUnits?.period ?? null)
        : scores.topScore === null ? null : "unknown_rank_score",
      rankingRecord: seed.diamondRankingRecord !== null && seed.diamondRankingRecord !== undefined
        ? (seed.diamondFieldUnits?.rankingRecord ?? null)
        : scores.historyRankScore === null ? null : "unknown_rank_score",
      historicalMax: seed.diamondHistoricalMax !== null && seed.diamondHistoricalMax !== undefined
        ? (seed.diamondFieldUnits?.historicalMax ?? null)
        : derivedHistoricalMax === null ? null : "unknown_rank_score"
    },
    dataProcessorStatus: result.status,
    dataProcessorComplete: result.status === "ready",
    dataProcessorReason: result.reason ?? null,
    dataProcessorStages: result.completedStages ?? [],
    dataProcessorEvidenceVersion: result.adapterEvidenceVersion ?? null,
    rawEvidence: {
      ...(seed.rawEvidence ?? {}),
      dataProcessor: {
        status: result.status,
        reason: result.reason ?? null,
        completedStages: result.completedStages ?? [],
        stageEvidence: result.stageEvidence ?? [],
        adapterEvidenceVersion: result.adapterEvidenceVersion ?? null,
        workId: result?.workId ?? seed.workId ?? null,
        collectionLaneEvidence: result?.collectionLaneEvidence
          ?? seed.collectionLaneEvidence
          ?? null
      }
    }
  };
}

/**
 * Run the production DataProcessor worker pool and its fixed post-enrichment
 * seller/quality classification. Only the single-request transport is
 * injectable; worker affinity and classification remain shared production
 * code.
 */
export async function enrichOriginalDataProcessorSeeds({
  seeds,
  verifiedRoute,
  filters = {},
  shouldStop = () => false,
  laneForCandidate,
  enrichOnce,
  nowMs = Date.now()
} = {}) {
  const results = await runOriginalDataProcessorWorkerPool({
    seeds,
    verifiedRoute,
    filters,
    shouldStop,
    laneForCandidate,
    enrichOnce,
    maxWorkers: 4
  });

  return classifyOriginalDataProcessorResults(results, { filters, nowMs });
}

export function classifyOriginalDataProcessorResults(results, { filters = {}, nowMs = Date.now() } = {}) {

  const accepted = [];
  const filteredCounts = {};
  const partialCounts = {};
  let unresolved = 0;
  for (const entry of results) {
    if (!entry) continue;
    const { seed, targetCountryCode, result } = entry;
    const enrichment = result?.enrichment ?? {};
    const completed = new Set(result?.completedStages ?? []);
    const coreComplete = completed.has("basic")
      && completed.has("country")
      && enrichment.creatorCountryCode === targetCountryCode;
    if (result.status === "filtered") {
      const reason = result.reason ?? "filtered";
      filteredCounts[reason] = (filteredCounts[reason] ?? 0) + 1;
      continue;
    }
    if (result.status === "ready" || (result.status === "partial" && coreComplete)) {
      if (filters.excludeSellers === true && seed.seller === true) {
        filteredCounts.seller_excluded = (filteredCounts.seller_excluded ?? 0) + 1;
        continue;
      }
      const candidate = originalDataProcessorCandidate(seed, result, { nowMs });
      if (filters.highQualityMode === true && candidate.highQuality !== true) {
        if (candidate.highQuality === false) {
          filteredCounts.high_quality_below_threshold = (
            filteredCounts.high_quality_below_threshold ?? 0
          ) + 1;
        } else {
          unresolved += 1;
          partialCounts.high_quality_score_incomplete = (
            partialCounts.high_quality_score_incomplete ?? 0
          ) + 1;
        }
        continue;
      }
      accepted.push(candidate);
      if (result.status === "partial") {
        const reason = result.reason ?? "partial";
        partialCounts[reason] = (partialCounts[reason] ?? 0) + 1;
      }
      continue;
    }
    unresolved += 1;
    const reason = result?.reason ?? "enrichment_unresolved";
    partialCounts[reason] = (partialCounts[reason] ?? 0) + 1;
  }
  return { accepted, filteredCounts, partialCounts, unresolved };
}

function regionalPipelineError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function assertRegionalPipelineRoute({ verifiedRoute, selectedLanes, marketRegion }) {
  const normalizedMarket = typeof marketRegion === "string"
    ? marketRegion.trim().toUpperCase()
    : "";
  if (!verifiedRoute
    || verifiedRoute.verificationStatus !== "verified"
    || verifiedRoute.marketRegion !== normalizedMarket
    || verifiedRoute.discoveryCountry !== "US"
    || verifiedRoute.discoveryProxyExitCountry !== "US") {
    throw regionalPipelineError(
      "regional Feed -> DataProcessor requires a verified US discovery route",
      "collection_route_mismatch"
    );
  }
  if (!Array.isArray(selectedLanes) || selectedLanes.length < 1 || selectedLanes.length > 3) {
    throw regionalPipelineError(
      "regional Feed -> DataProcessor requires one to three verified country lanes",
      "collection_route_mismatch"
    );
  }
  const routeExitCountries = Array.isArray(verifiedRoute.collectionProxyExitCountries)
    ? verifiedRoute.collectionProxyExitCountries
    : [];
  const routeLanes = Array.isArray(verifiedRoute.collectionLanes)
    ? verifiedRoute.collectionLanes
    : [];
  if (routeLanes.length < 1 || routeLanes.length > 3 || routeExitCountries.length !== routeLanes.length) {
    throw regionalPipelineError("verified route requires matching country lanes and exits", "collection_route_mismatch");
  }
  const configuredCountries = new Set();
  for (const [index, lane] of routeLanes.entries()) {
    const country = normalizedCountry(lane?.countryCode);
    if (!country || configuredCountries.has(country)
      || (lane.workId !== undefined && lane.workId !== index + 1)
      || country !== normalizedCountry(routeExitCountries[index])
      || (lane.proxyExitCountry !== undefined && country !== normalizedCountry(lane.proxyExitCountry))
      || typeof lane.proxyServer !== "string" || !lane.proxyServer) {
      throw regionalPipelineError("verified route contains an invalid country lane", "collection_route_mismatch");
    }
    configuredCountries.add(country);
  }
  const workIds = new Set();
  const countries = new Set();
  for (const lane of selectedLanes) {
    const laneIndex = Number(lane?.workId) - 1;
    const configuredLane = routeLanes[laneIndex] ?? null;
    if (!Number.isInteger(laneIndex)
      || laneIndex < 0 || laneIndex > 2
      || !normalizedCountry(lane?.countryCode)
      || workIds.has(laneIndex) || countries.has(normalizedCountry(lane?.countryCode))
      || normalizedCountry(lane?.countryCode) !== normalizedCountry(lane?.proxyExitCountry)
      || normalizedCountry(routeExitCountries[laneIndex]) !== normalizedCountry(lane?.countryCode)
      || normalizedCountry(configuredLane?.countryCode) !== normalizedCountry(lane?.countryCode)
      || configuredLane?.proxyServer !== lane?.proxyServer) {
      throw regionalPipelineError(
        "regional Feed -> DataProcessor country lane does not match its verified exit",
        "collection_route_mismatch"
      );
    }
    workIds.add(laneIndex);
    countries.add(normalizedCountry(lane.countryCode));
  }
}

/**
 * One durable production round of the original PC-Web and MobileProcessor
 * country-list discovery front half:
 *
 * fixed PC Feed + four fixed country lists -> one DisplayID-keyed feed seed
 * queue -> DataProcessor -> persistence callback
 *
 * Qualification and ranking recursion are deliberately outside this seam.
 */
export async function runOriginalRegionalFeedDataProcessorRound({
  database,
  runId,
  selectedLanes,
  verifiedRoute,
  marketRegion,
  filters = {},
  maxCandidates = 100,
  feedLimit = 100,
  shouldStop = () => false,
  fetchFeedOnce,
  fetchCountryTemplatesOnce = null,
  laneForCandidate,
  enrichOnce,
  sanitizeSeed = (candidate) => candidate,
  onBatch = async () => {},
  feedRound = null,
  checkpointAt = () => new Date().toISOString()
} = {}) {
  assertRegionalPipelineRoute({ verifiedRoute, selectedLanes, marketRegion });
  if (!database
    || typeof database.enqueueOriginalDiscoverySeed !== "function"
    || typeof database.claimDueOriginalDiscoverySeeds !== "function"
    || typeof database.completeOriginalDiscoverySeed !== "function"
    || typeof database.releaseOriginalDiscoverySeed !== "function"
    || typeof database.releaseRunDiscoverySeedLeases !== "function"
    || typeof database.originalDiscoveryQueueStatus !== "function"
    || typeof database.saveCheckpoint !== "function") {
    throw new TypeError("a durable discovery database is required");
  }
  if (typeof runId !== "string" || !runId.trim()) throw new TypeError("runId is required");
  if (typeof fetchFeedOnce !== "function") throw new TypeError("fetchFeedOnce is required");
  if (typeof laneForCandidate !== "function") throw new TypeError("laneForCandidate is required");
  if (typeof enrichOnce !== "function") throw new TypeError("enrichOnce is required");
  if (typeof onBatch !== "function") throw new TypeError("onBatch must be a function");
  const candidateLimit = Number.isSafeInteger(maxCandidates) && maxCandidates > 0
    ? maxCandidates
    : 100;
  const boundedFeedLimit = Number.isSafeInteger(feedLimit) && feedLimit > 0
    ? feedLimit
    : Math.min(100, Math.max(30, candidateLimit));
  const emptyByWorkId = Object.fromEntries(selectedLanes.map((lane) => [lane.workId, []]));
  const attemptsByWorkId = Object.fromEntries(selectedLanes.map((lane) => [lane.workId, 0]));
  if (shouldStop()) {
    const feedQueue = database.originalDiscoveryQueueStatus(runId, { seedKind: "feed" });
    database.saveCheckpoint(runId, "original_seed_queue", {
      feed: feedQueue,
      ...(Number.isSafeInteger(feedRound) ? { feedRound } : {}),
      lastStoppedReason: "paused_or_cancelled",
      updatedAt: checkpointAt()
    }, { adapter: "tiktok_original_cascade" });
    return {
      status: "stopped",
      reason: "paused_or_cancelled",
      candidates: [],
      feedAttempts: 0,
      feedAttemptsByWorkId: attemptsByWorkId,
      receivedRooms: 0,
      channelIds: [],
      channelIdsByWorkId: emptyByWorkId,
      filteredCounts: {},
      partialCounts: {},
      unresolved: 0,
      feedQueue
    };
  }

  const shouldFetchCountryTemplates = typeof fetchCountryTemplatesOnce === "function"
    && (!Number.isSafeInteger(feedRound) || feedRound === 1);
  const [laneResults, templateLaneResults] = await Promise.all([
    fetchOriginalCountryFeedLaneRound({
      selectedLanes,
      verifiedRoute,
      marketRegion,
      limit: boundedFeedLimit,
      shouldStop,
      fetchOnce: fetchFeedOnce
    }),
    shouldFetchCountryTemplates
      ? fetchOriginalCountryTemplateLaneRound({
          selectedLanes,
          verifiedRoute,
          marketRegion,
          shouldStop,
          fetchOnce: fetchCountryTemplatesOnce
        })
      : Promise.resolve([])
  ]);
  for (const { lane } of laneResults) attemptsByWorkId[lane.workId] += 1;

  const readyLanes = laneResults.filter(({ result }) => result.status === "ready");
  const readyTemplateLanes = templateLaneResults.filter(({ result }) => result.status === "ready");
  const filteredCounts = {};
  const partialCounts = {};
  const channelIds = [];
  const channelIdsByWorkId = { ...emptyByWorkId };
  const reasons = [];
  const roundSeeds = [];
  const templateSeeds = [];
  const templateAttemptsByWorkId = Object.fromEntries(selectedLanes.map((lane) => [lane.workId, 0]));
  const templateLabelsByWorkId = Object.fromEntries(selectedLanes.map((lane) => [lane.workId, []]));
  const templateRowCountsByWorkId = Object.fromEntries(selectedLanes.map((lane) => [lane.workId, null]));
  let receivedRooms = 0;
  let triggerKind = null;
  let adapterEvidenceVersion = null;
  for (const { lane, workId, result } of laneResults) {
    if (result.status !== "ready") {
      const reason = result.reason ?? "feed_not_ready";
      partialCounts[reason] = (partialCounts[reason] ?? 0) + 1;
      reasons.push({
        workId,
        reason,
        ...(reason === "feed_business_rejected" && Number.isSafeInteger(result.businessStatusCode)
          ? { businessStatusCode: result.businessStatusCode }
          : {}),
        ...(reason === "feed_business_rejected" && typeof result.businessMessage === "string"
          ? { businessMessage: sanitizeTikTokText(result.businessMessage).slice(0, 240) }
          : {})
      });
      continue;
    }
    triggerKind = result.triggerKind;
    adapterEvidenceVersion = result.adapterEvidenceVersion;
    channelIds.push(result.channelId);
    channelIdsByWorkId[workId].push(result.channelId);
    receivedRooms += Number(result.receivedRooms ?? 0);
    for (const candidate of result.candidates ?? []) {
      roundSeeds.push({
        ...candidate,
        workId,
        rankingScopeMarketRegion: candidate.rankingScopeMarketRegion ?? marketRegion,
        rankingScopeCountryCode: candidate.rankingScopeCountryCode ?? lane.countryCode,
        rankingDisplayName: candidate.rankingDisplayName ?? result.sourceDisplayName ?? null,
        rankingScopeCountryEvidence: candidate.rankingScopeCountryEvidence
          ?? "verified_work_id_country_lane",
        collectionLaneEvidence: candidate.collectionLaneEvidence ?? {
          workId,
          countryCode: lane.countryCode,
          exitCountry: lane.proxyExitCountry,
          affinity: "original_proxy_settings_work_id"
        }
      });
    }
  }
  for (const { lane, workId, displayName, result } of templateLaneResults) {
    templateAttemptsByWorkId[workId] += 1;
    if (result.status !== "ready") {
      const reason = result.reason ?? "country_templates_not_ready";
      partialCounts[reason] = (partialCounts[reason] ?? 0) + 1;
      reasons.push({ workId, sourceKind: "mobile_country_templates", reason });
      continue;
    }
    templateLabelsByWorkId[workId] = [...(result.templateLabels ?? [])];
    templateRowCountsByWorkId[workId] = result.templateRowCounts ?? null;
    for (const candidate of result.candidates ?? []) {
      templateSeeds.push({
        ...candidate,
        handle: candidate.handle ?? candidate.displayId ?? null,
        workId,
        rankingScopeMarketRegion: candidate.rankingScopeMarketRegion ?? marketRegion,
        rankingScopeCountryCode: candidate.rankingScopeCountryCode ?? lane.countryCode,
        rankingScopeCountryEvidence: candidate.rankingScopeCountryEvidence
          ?? "verified_work_id_country_lane_and_fixed_mobile_template",
        collectionLaneEvidence: candidate.collectionLaneEvidence ?? {
          workId,
          countryCode: lane.countryCode,
          exitCountry: lane.proxyExitCountry,
          affinity: "original_proxy_settings_work_id"
        },
        mobileTemplateEvidence: {
          evidenceVersion: result.evidenceVersion,
          fixedTemplateFingerprint: result.fixedTemplateFingerprint,
          displayName,
          templateLabels: result.templateLabels,
          templateRowCounts: result.templateRowCounts,
          mergeKeyKind: result.templateMergeKeyKind
        }
      });
    }
  }
  const mergedDiscovery = mergeOriginalDiscoverySeeds([
    { sourceKind: "original_pc_web_feed", candidates: roundSeeds },
    { sourceKind: "original_mobile_processor_fixed_country_lists", candidates: templateSeeds }
  ]);
  roundSeeds.splice(0, roundSeeds.length, ...mergedDiscovery.candidates);
  if (mergedDiscovery.identityConflicts > 0) {
    partialCounts.discovery_identity_conflict = (
      partialCounts.discovery_identity_conflict ?? 0
    ) + mergedDiscovery.identityConflicts;
  }
  const templatesComplete = shouldFetchCountryTemplates
    && readyTemplateLanes.length === selectedLanes.length;
  const originalDiscoveryParityComplete = shouldFetchCountryTemplates
    && templatesComplete
    && readyLanes.length === selectedLanes.length
    && mergedDiscovery.identityConflicts === 0;
  const originalDiscoveryIncompleteReason = mergedDiscovery.identityConflicts > 0
    ? "discovery_identity_conflict"
    : reasons.find((entry) => entry.sourceKind === "mobile_country_templates")?.reason
      ?? reasons[0]?.reason
      ?? "country_discovery_inputs_not_ready";
  const queuedBeforeCurrentRound = database.originalDiscoveryQueueStatus(runId, {
    seedKind: "feed"
  });
  if (!readyLanes.length
    && !readyTemplateLanes.length
    && Number(queuedBeforeCurrentRound.dueCount ?? 0) === 0) {
    return {
      status: "capability_not_ready",
      reason: shouldFetchCountryTemplates
        ? "country_discovery_sources_not_ready"
        : "feed_not_ready",
      reasons,
      candidates: [],
      feedAttempts: laneResults.length,
      feedAttemptsByWorkId: attemptsByWorkId,
      receivedRooms,
      channelIds,
      channelIdsByWorkId,
      filteredCounts,
      partialCounts,
      unresolved: 0,
      triggerKind,
      adapterEvidenceVersion,
      mobileTemplateComplete: false,
      mobileTemplateAttempts: templateLaneResults.length,
      mobileTemplateAttemptsByWorkId: templateAttemptsByWorkId,
      mobileTemplateLabelsByWorkId: templateLabelsByWorkId,
      mobileTemplateRowCountsByWorkId: templateRowCountsByWorkId,
      feedQueue: database.originalDiscoveryQueueStatus(runId, { seedKind: "feed" })
    };
  }

  if (shouldFetchCountryTemplates) {
    triggerKind = "original_pc_web_feed_and_mobile_processor_fixed_country_lists";
    adapterEvidenceVersion = ORIGINAL_DISCOVERY_UNION_EVIDENCE_VERSION;
  }

  if (!roundSeeds.length && Number(queuedBeforeCurrentRound.dueCount ?? 0) === 0) {
    const feedQueue = queuedBeforeCurrentRound;
    database.saveCheckpoint(runId, "original_seed_queue", {
      feed: feedQueue,
      ...(Number.isSafeInteger(feedRound) ? { feedRound } : {}),
      updatedAt: checkpointAt()
    }, { adapter: "tiktok_original_cascade" });
    return {
      status: originalDiscoveryParityComplete || !shouldFetchCountryTemplates ? "ready" : "partial",
      reason: originalDiscoveryParityComplete || !shouldFetchCountryTemplates
        ? null
        : originalDiscoveryIncompleteReason,
      reasons,
      candidates: [],
      feedAttempts: laneResults.length,
      feedAttemptsByWorkId: attemptsByWorkId,
      receivedRooms,
      channelIds,
      channelIdsByWorkId,
      filteredCounts,
      partialCounts,
      unresolved: 0,
      triggerKind,
      adapterEvidenceVersion,
      mobileTemplateComplete: templatesComplete,
      originalDiscoveryParityComplete,
      mobileTemplateAttempts: templateLaneResults.length,
      mobileTemplateAttemptsByWorkId: templateAttemptsByWorkId,
      mobileTemplateLabelsByWorkId: templateLabelsByWorkId,
      mobileTemplateRowCountsByWorkId: templateRowCountsByWorkId,
      discoveryIdentityConflicts: mergedDiscovery.identityConflicts,
      feedQueue
    };
  }

  for (const candidate of roundSeeds) {
    const countryAffinity = candidate.rankingScopeCountryCode
      ?? candidate.collectionLaneEvidence?.countryCode
      ?? `work-${candidate.workId}`;
    const creatorIdentity = candidate.userId
      ? `user:${candidate.userId}`
      : `handle:${candidate.handle}`;
    database.enqueueOriginalDiscoverySeed({
      runId,
      seedKind: "feed",
      identityKey: `${countryAffinity}:${creatorIdentity}`,
      payload: sanitizeSeed(candidate)
    });
  }
  if (shouldStop()) {
    const feedQueue = database.originalDiscoveryQueueStatus(runId, { seedKind: "feed" });
    database.saveCheckpoint(runId, "original_seed_queue", {
      feed: feedQueue,
      ...(Number.isSafeInteger(feedRound) ? { feedRound } : {}),
      lastStoppedReason: "paused_or_cancelled",
      discoveryInputsPersisted: true,
      updatedAt: checkpointAt()
    }, { adapter: "tiktok_original_cascade" });
    return {
      status: "stopped",
      reason: "paused_or_cancelled",
      candidates: [],
      feedAttempts: laneResults.length,
      feedAttemptsByWorkId: attemptsByWorkId,
      receivedRooms,
      channelIds,
      channelIdsByWorkId,
      filteredCounts,
      partialCounts,
      unresolved: 0,
      triggerKind,
      adapterEvidenceVersion,
      mobileTemplateComplete: templatesComplete,
      originalDiscoveryParityComplete,
      mobileTemplateAttempts: templateLaneResults.length,
      mobileTemplateAttemptsByWorkId: templateAttemptsByWorkId,
      mobileTemplateLabelsByWorkId: templateLabelsByWorkId,
      mobileTemplateRowCountsByWorkId: templateRowCountsByWorkId,
      discoveryIdentityConflicts: mergedDiscovery.identityConflicts,
      feedQueue
    };
  }
  const claimedFeedSeeds = database.claimDueOriginalDiscoverySeeds({
    runId,
    seedKind: "feed",
    limit: Math.min(2_000, Math.max(1, candidateLimit))
  });
  let enriched;
  try {
    enriched = await enrichOriginalDataProcessorSeeds({
      seeds: claimedFeedSeeds.map((item) => item.payload),
      verifiedRoute,
      filters,
      shouldStop,
      laneForCandidate,
      enrichOnce
    });
  } catch (error) {
    for (const item of claimedFeedSeeds) {
      database.releaseOriginalDiscoverySeed(item.queueId, {
        claimToken: item.claimToken,
        error: { code: "feed_seed_processing_failed" }
      });
    }
    throw error;
  }
  for (const [reason, count] of Object.entries(enriched.filteredCounts)) {
    filteredCounts[reason] = (filteredCounts[reason] ?? 0) + count;
  }
  for (const [reason, count] of Object.entries(enriched.partialCounts)) {
    partialCounts[reason] = (partialCounts[reason] ?? 0) + count;
  }
  const candidates = enriched.accepted.slice(0, candidateLimit);
  try {
    if (candidates.length) await onBatch(candidates);
    for (const item of claimedFeedSeeds) {
      if (shouldStop()) {
        database.releaseOriginalDiscoverySeed(item.queueId, {
          claimToken: item.claimToken,
          error: { code: "paused_or_cancelled" }
        });
      } else {
        database.completeOriginalDiscoverySeed(item.queueId, {
          claimToken: item.claimToken,
          result: { stage: "original_data_processor" }
        });
      }
    }
  } catch (error) {
    database.releaseRunDiscoverySeedLeases(runId);
    throw error;
  }
  const feedQueue = database.originalDiscoveryQueueStatus(runId, { seedKind: "feed" });
  database.saveCheckpoint(runId, "original_seed_queue", {
    feed: feedQueue,
    ...(Number.isSafeInteger(feedRound) ? { feedRound } : {}),
    updatedAt: checkpointAt()
  }, { adapter: "tiktok_original_cascade" });
  return {
    status: shouldStop()
      ? "stopped"
      : originalDiscoveryParityComplete || !shouldFetchCountryTemplates ? "ready" : "partial",
    reason: shouldStop()
      ? "paused_or_cancelled"
      : originalDiscoveryParityComplete || !shouldFetchCountryTemplates
        ? null
        : originalDiscoveryIncompleteReason,
    candidates,
    feedAttempts: laneResults.length,
    feedAttemptsByWorkId: attemptsByWorkId,
    receivedRooms,
    channelIds,
    channelIdsByWorkId,
    filteredCounts,
    partialCounts,
    unresolved: enriched.unresolved,
    triggerKind,
    adapterEvidenceVersion,
    mobileTemplateComplete: templatesComplete,
    originalDiscoveryParityComplete,
    mobileTemplateAttempts: templateLaneResults.length,
    mobileTemplateAttemptsByWorkId: templateAttemptsByWorkId,
    mobileTemplateLabelsByWorkId: templateLabelsByWorkId,
    mobileTemplateRowCountsByWorkId: templateRowCountsByWorkId,
    discoveryIdentityConflicts: mergedDiscovery.identityConflicts,
    feedQueue
  };
}

/**
 * Execute the pair request for an already qualified creator and bind it to the
 * exact verified country lane. No response may silently switch WorkID or exit
 * country.
 */
export async function fetchOriginalQualifiedRankingPair({
  seed,
  lane,
  verifiedRoute,
  marketRegion,
  rankingTransport,
  shouldStop = () => false
} = {}) {
  if (!seed?.userId || !seed?.roomId || !lane || typeof rankingTransport?.fetchPair !== "function") {
    return {
      status: "capability_not_ready",
      capability: "regional_gift_ranking",
      reason: "ranking_seed_or_lane_invalid",
      candidates: []
    };
  }
  const countryCode = normalizedCountry(lane.countryCode);
  const pair = await rankingTransport.fetchPair({
    seed: {
      anchorId: seed.userId,
      roomId: seed.roomId,
      workId: seed.workId,
      rankingScopeCountryCode: countryCode,
      rankingDisplayName: seed.rankingDisplayName ?? lane.displayName ?? null
    },
    verifiedRoute,
    marketRegion,
    countryCode,
    displayName: lane.displayName ?? seed.rankingDisplayName ?? null,
    shouldStop
  });
  if (pair?.status !== "ready") return pair;
  if (Number(pair.workId) !== Number(seed.workId)
    || !laneEvidenceMatches(lane, pair.collectionLaneEvidence, seed.workId)) {
    return {
      status: "capability_not_ready",
      capability: "regional_gift_ranking",
      reason: "ranking_route_evidence_mismatch",
      candidates: []
    };
  }
  return pair;
}

/**
 * Production high-level transport seam for one qualified recursive ranking
 * seed. It owns the pair normalization, country-evidence gate, WorkID4
 * projection, and DataProcessor country recheck. Tests may inject the bounded
 * ranking/enrichment providers but cannot replace those business stages.
 */
export async function expandOriginalQualifiedRankingSeed({
  seed,
  lane,
  verifiedRoute,
  marketRegion,
  filters = {},
  limit = 30,
  rankingTransport,
  laneForCandidate,
  enrichOnce,
  shouldStop = () => false
} = {}) {
  const countryCode = normalizedCountry(lane?.countryCode);
  const pair = await fetchOriginalQualifiedRankingPair({
    seed,
    lane,
    verifiedRoute,
    marketRegion,
    rankingTransport,
    shouldStop
  });
  if (pair?.status !== "ready") {
    return {
      status: "partial",
      reason: pair?.reason ?? "ranking_pair_not_ready",
      capability: pair?.capability ?? "regional_gift_ranking",
      mobileSessionRequired: pair?.reason === "ranking_mobile_authorization_required",
      candidates: []
    };
  }
  const normalized = await collectTikTokLiveRanking({
    marketRegion,
    countryCode,
    rankingViewKind: "top",
    limit: Math.max(1, Number(limit) || 30),
    provider: async () => pair
  });
  if (normalized.status !== "ready" || normalized.rankingPairComplete !== true) {
    return {
      status: "partial",
      reason: normalized.reason ?? "ranking_pair_incomplete",
      candidates: []
    };
  }
  const allScopeCountries = [
    normalized.rankingScopeCountryCode,
    ...normalized.candidates.map((candidate) => candidate.rankingScopeCountryCode)
  ].map(normalizedCountry);
  if (!countryCode || allScopeCountries.some((value) => value !== countryCode)) {
    return {
      status: "partial",
      reason: "ranking_scope_country_mismatch",
      candidates: []
    };
  }
  const rankingSeeds = buildOriginalWorkId4RankingSeeds({
    candidates: normalized.candidates,
    sourceSeed: seed,
    normalizedRanking: normalized,
    lane,
    marketRegion
  });
  const enriched = await enrichOriginalDataProcessorSeeds({
    seeds: rankingSeeds,
    verifiedRoute,
    filters,
    shouldStop,
    laneForCandidate,
    enrichOnce
  });
  return {
    status: "ready",
    reason: null,
    candidates: enriched.accepted,
    rankingEnrichmentUnresolved: enriched.unresolved,
    rankingEnrichmentFilteredCounts: enriched.filteredCounts,
    rankingEnrichmentPartialCounts: enriched.partialCounts,
    pairMetadata: {
      triggerKind: pair.triggerKind,
      endpointProfileId: pair.endpointProfileId,
      endpointFingerprint: pair.endpointFingerprint,
      rankTypeCode: pair.rankTypeCode,
      regionTypeCode: pair.regionTypeCode,
      gapIntervals: pair.gapIntervals,
      adapterEvidenceVersion: normalized.adapterEvidenceVersion,
      rankingPairComplete: true,
      workId: pair.workId ?? seed.workId,
      sourceType: normalized.sourceType,
      listProducing: normalized.listProducing,
      rankingViewKind: normalized.rankingViewKind
    }
  };
}

/**
 * Reproduce the original WorkID4 descendant shape while preserving the source
 * country's verified lane instead of falling back to an unrelated first lane.
 */
export function buildOriginalWorkId4RankingSeeds({
  candidates,
  sourceSeed,
  normalizedRanking,
  lane,
  marketRegion
} = {}) {
  if (!Array.isArray(candidates) || !lane) return [];
  const countryCode = normalizedCountry(lane.countryCode);
  if (!countryCode || normalizedCountry(lane.proxyExitCountry) !== countryCode) return [];
  return candidates.map((candidate) => ({
    ...candidate,
    workId: 4,
    collectionLaneEvidence: {
      topology: "mobile_settings_country_lane_compatibility",
      workId: 4,
      sourceWorkId: sourceSeed?.workId ?? null,
      laneIndex: Number(lane.workId) - 1,
      countryCode,
      exitCountry: lane.proxyExitCountry,
      affinity: "target_country_fallback",
      originalFallbackSource: "mobile_settings_0"
    },
    creatorCountryCode: null,
    countryCode: null,
    followerCount: candidate.followerCount ?? null,
    live: candidate.roomId ? true : null,
    seller: candidate.seller ?? null,
    highQuality: null,
    rankingScore: normalizeOriginalScoreRaw(candidate.rankingScore ?? candidate.rankScoreRaw),
    rankScoreUnit: "unknown_rank_score",
    rankingScopeMarketRegion: candidate.rankingScopeMarketRegion
      ?? normalizedRanking?.rankingScopeMarketRegion
      ?? marketRegion,
    rankingScopeCountryCode: countryCode,
    rankingScopeCountryEvidence: candidate.rankingScopeCountryEvidence
      ?? normalizedRanking?.rankingScopeCountryEvidence
      ?? "verified_collection_proxy_exit_and_original_top_url",
    adapterEvidenceVersion: normalizedRanking?.adapterEvidenceVersion,
    rankingObservations: candidate.rankingObservations ?? [],
    rawEvidence: candidate.rankEvidence ?? null,
    confidence: 0.95
  }));
}

function candidateQualificationAvailable(candidate) {
  return candidate?.qualificationStatus === "available"
    || candidate?.invitationEligibility === "available"
    || candidate?.latestQualificationObservation?.invitationEligibility === "available";
}

/**
 * Persist the recursive edge from an available backstage qualification to the
 * next ranking request. Queue timing and dedupe remain owned by DatabaseStore.
 */
export function enqueueQualifiedOriginalRankingSeeds({
  database,
  runId,
  candidates,
  at
} = {}) {
  if (!database || typeof database.enqueueOriginalDiscoverySeed !== "function") {
    throw new TypeError("database seed queue is required");
  }
  if (!Array.isArray(candidates)) throw new TypeError("candidates must be an array");
  const candidateById = new Map();
  let accepted = 0;
  let duplicates = 0;
  for (const candidate of candidates) {
    if (!candidateQualificationAvailable(candidate)
      || !candidate?.candidateId || !candidate?.userId || !candidate?.roomId) continue;
    const countryAffinity = normalizedCountry(
      candidate.rankingScopeCountryCode
        ?? candidate.creatorCountryCode
        ?? candidate.routeCountry
    );
    if (!countryAffinity) continue;
    candidateById.set(candidate.candidateId, candidate);
    const queued = database.enqueueOriginalDiscoverySeed({
      runId,
      seedKind: "ranking",
      identityKey: `${countryAffinity}:user:${candidate.userId}`,
      payload: { candidateId: candidate.candidateId },
      rankingTiming: "eligibility_ttl_v1",
      countdownSeconds: candidate.originalRankingCountdownSeconds
        ?? candidate.rankingCountdownSeconds
        ?? null,
      ...(at === undefined ? {} : { at })
    });
    if (queued.accepted) accepted += 1;
    else if (queued.duplicate) duplicates += 1;
  }
  return { candidateById, accepted, duplicates };
}

/**
 * Resume every currently-due recursive ranking seed from SQLite. Queue claim,
 * WorkID4 expansion, country recheck, completion, and checkpoint persistence
 * are one production seam shared by daemon resume and restart integration
 * tests. Provider injection is confined to the bounded ranking/enrichment
 * transports consumed by expandOriginalQualifiedRankingSeed.
 */
export async function resumeOriginalDueRankingSeeds({
  database,
  runId,
  qualifiedCandidates,
  verifiedRoute,
  marketRegion,
  selectedCountryCodes,
  filters = {},
  maxCandidates = 100,
  receivedCount = () => 0,
  laneForCandidate,
  rankingTransport,
  enrichOnce,
  onBatch = async () => {},
  onProgress = async () => {},
  shouldStop = () => false,
  checkpointAt = () => new Date().toISOString()
} = {}) {
  if (!database || typeof database.claimDueOriginalDiscoverySeeds !== "function") {
    throw new TypeError("a durable discovery database is required");
  }
  if (!Array.isArray(qualifiedCandidates)) throw new TypeError("qualifiedCandidates must be an array");
  if (typeof laneForCandidate !== "function") throw new TypeError("laneForCandidate is required");
  if (typeof onBatch !== "function" || typeof onProgress !== "function") {
    throw new TypeError("onBatch and onProgress must be functions");
  }
  const selectedCountries = new Set((selectedCountryCodes ?? []).map(normalizedCountry));
  const { candidateById } = enqueueQualifiedOriginalRankingSeeds({
    database,
    runId,
    candidates: qualifiedCandidates
  });
  const claims = database.claimDueOriginalDiscoverySeeds({
    runId,
    seedKind: "ranking",
    limit: 2_000
  });
  const eligible = [];
  for (const claim of claims) {
    const candidate = candidateById.get(claim.payload?.candidateId);
    if (!candidate) {
      database.completeOriginalDiscoverySeed(claim.queueId, {
        claimToken: claim.claimToken,
        status: "skipped",
        result: { reason: "candidate_no_longer_qualified" }
      });
      continue;
    }
    eligible.push({ ...candidate, queueClaim: claim });
  }
  const initialQueue = database.originalDiscoveryQueueStatus(runId, { seedKind: "ranking" });
  database.saveCheckpoint(runId, "ranking_expansion", {
    queue: initialQueue,
    updatedAt: checkpointAt()
  }, { adapter: "tiktok_original_cascade" });
  if (!eligible.length) {
    const pendingSeeds = Number(initialQueue.counts.pending ?? 0);
    return {
      complete: pendingSeeds === 0,
      found: 0,
      expandedSeeds: 0,
      pendingSeeds,
      nextDueAt: initialQueue.nextDueAt,
      stoppedReason: pendingSeeds > 0 ? "ranking_expansion_not_due" : null
    };
  }

  let found = 0;
  let expandedSeeds = 0;
  let rankingEnrichmentUnresolved = 0;
  const rankingEnrichmentFilteredCounts = {};
  const rankingEnrichmentPartialCounts = {};
  let lastPairMetadata = null;
  let lastExpandedCandidateId = null;
  const releaseClaims = (reason) => {
    // Ranking overlaps Data. Recovery of every run lease belongs only to
    // executeRun startup; this invocation may release only its own tokens.
    database.transaction(() => {
      for (const { queueClaim } of eligible) {
        const current = database.getDiscoverySeed(queueClaim.queueId);
        if (current?.status !== "processing" || current.claimToken !== queueClaim.claimToken) continue;
        database.releaseOriginalDiscoverySeed(queueClaim.queueId, {
          claimToken: queueClaim.claimToken, error: { code: reason }
        });
      }
    });
    const queue = database.originalDiscoveryQueueStatus(runId, { seedKind: "ranking" });
    database.saveCheckpoint(runId, "ranking_expansion", {
      queue,
      lastStoppedReason: reason,
      updatedAt: checkpointAt()
    }, { adapter: "tiktok_original_cascade" });
    return queue;
  };

  try {
    for (const seed of eligible) {
      if (shouldStop() || receivedCount() >= maxCandidates) break;
      if (!seed.userId || !seed.roomId) {
        database.completeOriginalDiscoverySeed(seed.queueClaim.queueId, {
          claimToken: seed.queueClaim.claimToken,
          status: "skipped",
          result: { reason: "ranking_seed_identity_incomplete" }
        });
        continue;
      }
      if (![1, 2, 3, 4].includes(seed.workId)) {
        const queue = releaseClaims("ranking_work_id_missing");
        return {
          complete: false,
          found,
          expandedSeeds,
          pendingSeeds: Number(queue.counts.pending ?? 0),
          nextDueAt: queue.nextDueAt,
          stoppedReason: "ranking_work_id_missing"
        };
      }
      const lane = laneForCandidate(verifiedRoute, seed);
      if (!lane || !selectedCountries.has(normalizedCountry(lane.countryCode))) {
        const queue = releaseClaims("ranking_country_lane_missing");
        return {
          complete: false,
          found,
          expandedSeeds,
          pendingSeeds: Number(queue.counts.pending ?? 0),
          nextDueAt: queue.nextDueAt,
          stoppedReason: "ranking_country_lane_missing"
        };
      }
      const expansion = await expandOriginalQualifiedRankingSeed({
        seed,
        lane,
        verifiedRoute,
        marketRegion,
        filters,
        // The run may be continuous; one ranking normalization is still bounded.
        limit: Math.min(1_000, Math.max(1, maxCandidates - receivedCount())),
        rankingTransport,
        laneForCandidate,
        enrichOnce,
        shouldStop
      });
      if (expansion.status !== "ready") {
        const queue = releaseClaims(expansion.reason);
        const partial = {
          complete: false,
          found,
          expandedSeeds,
          pendingSeeds: Number(queue.counts.pending ?? 0),
          nextDueAt: queue.nextDueAt,
          stoppedReason: expansion.reason,
          capability: expansion.capability ?? "regional_gift_ranking",
          mobileSessionRequired: expansion.mobileSessionRequired === true
        };
        database.saveCheckpoint(runId, "ranking_expansion", {
          queue,
          lastStoppedReason: expansion.reason,
          lastAttemptedCandidateId: seed.candidateId,
          updatedAt: checkpointAt()
        }, { adapter: "tiktok_original_cascade" });
        await onProgress({ phase: "original_ranking_expansion", ...partial });
        return partial;
      }
      for (const [reason, count] of Object.entries(expansion.rankingEnrichmentFilteredCounts)) {
        rankingEnrichmentFilteredCounts[reason] = (rankingEnrichmentFilteredCounts[reason] ?? 0) + count;
      }
      for (const [reason, count] of Object.entries(expansion.rankingEnrichmentPartialCounts)) {
        rankingEnrichmentPartialCounts[reason] = (rankingEnrichmentPartialCounts[reason] ?? 0) + count;
      }
      rankingEnrichmentUnresolved += expansion.rankingEnrichmentUnresolved;
      if (expansion.candidates.length) await onBatch(expansion.candidates);
      found += expansion.candidates.length;
      expandedSeeds += 1;
      lastExpandedCandidateId = seed.candidateId;
      lastPairMetadata = {
        ...expansion.pairMetadata,
        rankingEnrichmentUnresolved,
        rankingEnrichmentFilteredCounts,
        rankingEnrichmentPartialCounts
      };
      database.completeOriginalDiscoverySeed(seed.queueClaim.queueId, {
        claimToken: seed.queueClaim.claimToken,
        result: {
          candidateId: seed.candidateId,
          rankingPairComplete: true,
          producedCandidates: expansion.candidates.length
        }
      });
      const queue = database.originalDiscoveryQueueStatus(runId, { seedKind: "ranking" });
      database.saveCheckpoint(runId, "ranking_expansion", {
        queue,
        lastExpandedCandidateId: seed.candidateId,
        endpointProfileId: expansion.pairMetadata.endpointProfileId,
        endpointFingerprint: expansion.pairMetadata.endpointFingerprint,
        rankTypeCode: expansion.pairMetadata.rankTypeCode,
        regionTypeCode: expansion.pairMetadata.regionTypeCode,
        gapIntervals: expansion.pairMetadata.gapIntervals,
        workId: expansion.pairMetadata.workId,
        rankingEnrichmentUnresolved,
        updatedAt: checkpointAt()
      }, { adapter: "tiktok_original_cascade" });
      await onProgress({
        phase: "original_ranking_expansion",
        found,
        expandedSeeds,
        gapIntervals: expansion.pairMetadata.gapIntervals,
        rankTypeCode: expansion.pairMetadata.rankTypeCode,
        regionTypeCode: expansion.pairMetadata.regionTypeCode,
        workId: expansion.pairMetadata.workId,
        rankingEnrichmentUnresolved,
        rankingPairComplete: true
      });
    }
  } catch (error) {
    releaseClaims(error?.code ?? "ranking_seed_processing_failed");
    throw error;
  }

  const stopped = shouldStop();
  if (stopped || receivedCount() >= maxCandidates) {
    releaseClaims(stopped ? "paused_or_cancelled" : "configured_candidate_limit_reached");
  }
  const finalQueue = database.originalDiscoveryQueueStatus(runId, { seedKind: "ranking" });
  const pendingSeeds = Number(finalQueue.counts.pending ?? 0)
    + Number(finalQueue.counts.processing ?? 0);
  database.saveCheckpoint(runId, "ranking_expansion", {
    queue: finalQueue,
    lastExpandedCandidateId,
    rankingEnrichmentUnresolved,
    ...(stopped ? { lastStoppedReason: "paused_or_cancelled" } : {}),
    updatedAt: checkpointAt()
  }, { adapter: "tiktok_original_cascade" });
  return {
    complete: !stopped && pendingSeeds === 0 && rankingEnrichmentUnresolved === 0,
    found,
    expandedSeeds,
    pendingSeeds,
    nextDueAt: finalQueue.nextDueAt,
    stoppedReason: stopped
      ? "paused_or_cancelled"
      : rankingEnrichmentUnresolved > 0
        ? "ranking_enrichment_partial"
        : pendingSeeds > 0
          ? (finalQueue.dueCount > 0 ? "ranking_expansion_pending" : "ranking_expansion_not_due")
          : null,
    rankingEnrichmentUnresolved,
    rankingEnrichmentFilteredCounts,
    rankingEnrichmentPartialCounts,
    ...lastPairMetadata
  };
}
