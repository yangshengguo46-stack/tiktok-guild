import { projectMobileAuthorizationRuntime } from "../mcp/core/mobile-authorization-status.js";
import crypto from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, request as playwrightRequest } from "playwright";
import {
  batchCheckCollectionBackstage,
  inspectCollectionBackstageCompatibility,
  inspectCollectionBackstageStartup,
  normalizeCollectionHandle,
  normalizeManualCollectionBackstageResults
} from "../mcp/adapters/collection-backstage.js";
import { collectSvipLegacy } from "../mcp/adapters/svip-legacy.js";
import { inspectStartupInitialization, initializeCollectionBackstage, pauseDiscoveryPlayback, prepareDiscoveryLive } from "../mcp/adapters/startup-initialization.js";
import {
  TIKTOK_RANKING_CAPABILITY
} from "../mcp/adapters/tiktok-live-ranking.js";
import {
  collectTikTokLive,
  sanitizeTikTokText,
  sanitizeTikTokUrl,
  sanitizeTikTokValue
} from "../mcp/adapters/tiktok-live.js";
import { CoreConfigStore } from "../mcp/core/core-config-store.js";
import { TIKHUB_RANKING_PROFILE, createTikHubRankingTransport, selectTikHubRankingSeeds, collectTikHubRankingSnapshots } from '../mcp/core/tikhub-ranking.js';
import { createTikHubEnrichment } from '../mcp/core/tikhub-enrichment.js';
import {
  COLLECTION_CLEANUP_SCOPE_VERSION,
  DatabaseStore
} from "../mcp/core/database.js";
import { createOriginalCoreConfigStore } from "../mcp/core/original-core-config-store.js";
import { createMobileRankingAuthorizationProvider } from "../mcp/core/mobile-ranking-authorization-provider.js";
import {
  RECOVERED_DOWNLOAD_CORE_DLL_PROFILE
} from "../mcp/core/recovered-download-core-dll.js";
import {
  ORIGINAL_COUNTRY_CATALOG_PROFILE,
  originalCountryCatalog,
  originalExecutableProfileForCountry
} from "../mcp/core/original-country-config.js";
import {
  TIKTOK_DATA_ENRICHMENT_PROFILE,
  createTikTokDataEnrichmentTransport
} from "../mcp/core/tiktok-data-enrichment-transport.js";
import {
  attachDiscoveryWorkflowEvidence,
  discoveryWorkflowPolicy
} from "../mcp/core/discovery-workflow-policy.js";
import {
  TIKTOK_LIVE_FEED_PROFILE,
  createTikTokLiveFeedTransport
} from "../mcp/core/tiktok-live-feed-transport.js";
import {
  TIKTOK_RANKING_TRANSPORT_PROFILE,
  createTikTokRankingTransport
} from "../mcp/core/tiktok-ranking-transport.js";
import {
  resumeOriginalDueRankingSeeds
} from "../mcp/core/original-cascade-runtime.js";
import { selectedOriginalCountryLanes, runOriginalCollectorWithSessions, originalCollectorFailureState } from "../mcp/core/original-collector-settings.js";
import { createOriginalRankingQueueSweeper } from "../mcp/core/original-ranking-queue-sweeper.js";
import { inspectCollectionReadiness } from "../mcp/core/collection-readiness.js";
import {
  listOriginalAutoQualificationProspects,
  waitForOriginalQualificationWindow
} from "../mcp/core/original-qualification-runtime.js";
import {
  deriveDiamondUsdEstimateForEvidence,
  deriveExpectedInvitationLane
} from "../mcp/core/candidate-policy.js";
import { anonymizeCandidate, buildHandoff, summarizeCandidates } from "../mcp/core/handoff.js";
import { buildStartupInventory } from "../mcp/core/startup-inventory.js";
import {
  DEFAULT_QUALIFICATION_POLICY,
  chooseQualificationTargets,
  nextQualificationDelayMs,
  planQualificationBatch
} from "../mcp/core/qualification-scheduler.js";
import {
  fingerprintCollectionSessionRoute,
  fingerprintDiscoverySessionRoute,
  fingerprintRouteIntent,
  fingerprintRoutePolicy,
  normalizeCountryCode,
  normalizeRouteIntent,
  normalizeRoutePolicy
} from "../mcp/core/route-policy.js";
import { DAEMON_VERSION, PROTOCOL_VERSION, defaultDataDirectory, runtimePaths } from "../mcp/core/runtime-paths.js";
import {
  SESSION_TARGET_NAMES,
  SessionManager,
  probeProxyExitCountry
} from "../mcp/core/session-manager.js";

const dataDirectory = defaultDataDirectory();
const paths = runtimePaths(dataDirectory);
const coreConfigStore = new CoreConfigStore({ dataDirectory });
const originalCoreConfigStore = await createOriginalCoreConfigStore({ dataDirectory });
const rankingCoreConfigStore = originalCoreConfigStore ?? coreConfigStore;
const tikHubRankingTransport = createTikHubRankingTransport({ dataDirectory });
const database = new DatabaseStore(paths.databasePath).init();
const tikHubResearch = createTikHubEnrichment({ store: database, dataDirectory });
const sessions = new SessionManager({ dataDirectory, log: (message) => console.error(`[session] ${sanitizeTikTokText(message)}`) });
const liveFeedTransport = createTikTokLiveFeedTransport({
  requestExecutor: (request, { verifiedRoute }) => sessions.executeCountryFeedRequest(request, verifiedRoute)
});
const mobileRankingAuthorizationProvider = createMobileRankingAuthorizationProvider({
  coreConfigStore: rankingCoreConfigStore,
  profileResolver: originalCoreConfigStore ? scope => originalCoreConfigStore.profileFor(scope) : null,
  requestContextFactory: playwrightRequest
});
const rankingTransport = createTikTokRankingTransport({
  authorizationProvider: mobileRankingAuthorizationProvider,
  profileResolver: originalCoreConfigStore
    ? (countryCode, marketRegion, displayName) => originalCoreConfigStore.profileFor({ countryCode, marketRegion, displayName })
    : null
});
const dataEnrichmentTransport = createTikTokDataEnrichmentTransport({
  requestExecutor: (request, { verifiedRoute }) => sessions.executeCountryDataRequest(request, verifiedRoute),
  rankingTransport
});
const activeRuns = new Map();
// Read-only readiness uses observations from this process and this exact page;
// historical preflight audits never certify a newly started browser.
const collectionAdapterObservations = new Map();
const COLLECTION_READINESS_EVIDENCE_TTL_MS = 300_000;
let activeQualification = null;
let shutdownRequested = false;
const ORIGINAL_QUEUE_SWEEP_INTERVAL_MS = 5 * 60 * 1_000;
const queueSweepTestInterval = process.env.TKDESK_AGENT_TEST_QUEUE_SWEEP === "1"
  ? Number(process.env.TKDESK_AGENT_TEST_QUEUE_SWEEP_INTERVAL_MS)
  : null;
const queueSweepIntervalMs = Number.isFinite(queueSweepTestInterval)
  ? Math.min(10_000, Math.max(25, Math.trunc(queueSweepTestInterval)))
  : ORIGINAL_QUEUE_SWEEP_INTERVAL_MS;
const COUNTRY_LANE_ROUTE_SCHEMA_VERSION = "tkdesk.country-lane-route.v1";
const COLLECTION_BACKSTAGE_PREFLIGHT_CHECKPOINT_KEY = "startup_preflight";
const COLLECTION_BACKSTAGE_PREFLIGHT_CHECKPOINT_ADAPTER = "collection_backstage_startup";
const DISCOVERY_COUNTRY = "US";
const REGIONAL_DISCOVERY_FILTERS = new Set([
  "region",
  "marketRegion",
  "countryCode",
  "countryCodes",
  "countryDisplayNames",
  "minFollowers",
  "maxFollowers",
  "excludeSellers",
  "highQualityMode",
  "discoveryMethod",
  "calibrationProbe",
  "maxFeedRounds",
  "maxCandidates"
]);
const DISCOVERY_FILTERS = new Set([
  "region",
  "marketRegion",
  "countryCode",
  "countryCodes",
  "countryDisplayNames",
  "query",
  "minFollowers",
  "maxFollowers",
  "excludeSellers",
  "highQualityMode",
  "liveTag",
  "qualificationStatuses",
  "discoveryMethod",
  "tikHubRankingKind",
  "tikHubRankingPeriod",
  "calibrationProbe",
  "maxFeedRounds",
  "recordedAfter",
  "recordedBefore",
  "maxCandidates",
  "maxPages",
  "maxScrolls"
]);
const secret = crypto.randomBytes(32).toString("hex");
const COLLECTION_CLEANUP_CONFIRMATION_TTL_MS = 10 * 60 * 1_000;
const collectionCleanupConfirmations = new Map();
const pluginRoot = process.env.TKDESK_AGENT_PLUGIN_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginVersion = await readFile(path.join(pluginRoot, ".codex-plugin", "plugin.json"), "utf8")
  .then((text) => String(JSON.parse(text).version || DAEMON_VERSION))
  .catch(() => DAEMON_VERSION);

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

await Promise.all([
  mkdir(paths.runtimeDirectory, { recursive: true, mode: 0o700 }),
  mkdir(paths.exportsDirectory, { recursive: true, mode: 0o700 }),
  mkdir(paths.handoffsDirectory, { recursive: true, mode: 0o700 })
]);

for (const target of SESSION_TARGET_NAMES) {
  database.upsertSession({
    sessionKey: target,
    kind: target,
    profilePath: sessions.profileDirectory(target),
    status: "stopped"
  });
}

for (const run of database.listRuns({ limit: 2_000 })) {
  if (["starting", "navigating", "discovering", "enriching", "qualifying", "waiting_quota", "deduplicating", "scoring", "pausing"].includes(run.status)) {
    database.releaseRunDiscoverySeedLeases(run.runId);
    database.updateRun(run.runId, {
      status: "paused",
      error: { code: "daemon_restarted", message: "守护进程重启，任务已安全暂停，可从 checkpoint 继续" }
    });
  }
}

function rpcError(message, code = "tkdesk_error", details = null) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function normalizeCollectionCleanupCutoff(value) {
  const milliseconds = Date.parse(String(value ?? ""));
  if (!Number.isFinite(milliseconds)) {
    throw rpcError("清理截止时间必须是有效的 ISO 时间", "collection_cleanup_cutoff_invalid");
  }
  if (milliseconds > Date.now()) {
    throw rpcError("清理截止时间不能晚于当前时间", "collection_cleanup_cutoff_in_future");
  }
  return new Date(milliseconds).toISOString();
}

function collectionCleanupConfirmationMaterial({ cutoff, previewHash, nonce, expiresAt }) {
  return JSON.stringify({
    scopeVersion: COLLECTION_CLEANUP_SCOPE_VERSION,
    cutoff,
    previewHash,
    nonce,
    expiresAt
  });
}

function issueCollectionCleanupConfirmation(cutoff, previewHash) {
  const now = Date.now();
  for (const [proof, challenge] of collectionCleanupConfirmations) {
    if (Date.parse(challenge.expiresAt) <= now) collectionCleanupConfirmations.delete(proof);
  }
  const challenge = {
    cutoff,
    previewHash,
    nonce: crypto.randomBytes(16).toString("hex"),
    expiresAt: new Date(now + COLLECTION_CLEANUP_CONFIRMATION_TTL_MS).toISOString()
  };
  const confirmationProof = crypto.createHmac("sha256", secret)
    .update(collectionCleanupConfirmationMaterial(challenge))
    .digest("hex");
  collectionCleanupConfirmations.set(confirmationProof, challenge);
  return { confirmationProof, confirmationExpiresAt: challenge.expiresAt };
}

function consumeCollectionCleanupConfirmation({ cutoff, previewHash, confirmationProof }) {
  const normalizedProof = String(confirmationProof ?? "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalizedProof)) {
    throw rpcError("清理确认凭据无效，请重新预览", "collection_cleanup_confirmation_invalid");
  }
  const challenge = collectionCleanupConfirmations.get(normalizedProof);
  if (!challenge || Date.parse(challenge.expiresAt) <= Date.now()) {
    collectionCleanupConfirmations.delete(normalizedProof);
    throw rpcError("清理确认凭据不存在或已过期，请重新预览", "collection_cleanup_confirmation_expired");
  }
  const expected = crypto.createHmac("sha256", secret)
    .update(collectionCleanupConfirmationMaterial(challenge))
    .digest("hex");
  const providedBytes = Buffer.from(normalizedProof, "hex");
  const expectedBytes = Buffer.from(expected, "hex");
  const matches = providedBytes.length === expectedBytes.length
    && crypto.timingSafeEqual(providedBytes, expectedBytes)
    && challenge.cutoff === cutoff
    && challenge.previewHash === previewHash;
  if (!matches) {
    throw rpcError("清理确认凭据与预览不匹配，请重新预览", "collection_cleanup_confirmation_mismatch");
  }
  collectionCleanupConfirmations.delete(normalizedProof);
  return challenge;
}

function sanitizeErrorDetails(value) {
  return sanitizeTikTokValue(value);
}

function isProxyDerivedFingerprintKey(key) {
  const normalized = String(key ?? "")
    .replace(/([a-z\d])([A-Z])/g, "$1_$2")
    .replace(/[-\s]+/g, "_")
    .toLowerCase();
  return normalized.endsWith("route_fingerprint")
    || normalized.endsWith("route_fingerprints")
    || normalized.endsWith("proxy_fingerprint")
    || normalized.endsWith("configuration_fingerprint");
}

function stripPublicProxyDerivedFingerprints(value) {
  if (Array.isArray(value)) return value.map(stripPublicProxyDerivedFingerprints);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !isProxyDerivedFingerprintKey(key))
    .map(([key, nested]) => [key, stripPublicProxyDerivedFingerprints(nested)]));
}

function publicRpcValue(value) {
  const publicValue = stripPublicProxyDerivedFingerprints(sanitizeTikTokValue(value));
  const restoreFalseSecurityAssertions = (source, target, depth = 0) => {
    if (depth > 12 || !source || !target || typeof source !== "object" || typeof target !== "object") return;
    for (const [key, nested] of Object.entries(source)) {
      if (key === "onlineAuthorization" && nested && ["unknown", "verified", "rejected"].includes(nested.state)) {
        const reason = ["http_401", "http_403", "business_20003", "transport_authorization_required"].includes(nested.reason) ? nested.reason : null;
        const observedAt = typeof nested.observedAt === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(nested.observedAt) ? nested.observedAt : null;
        target[key] = { state: nested.state, reason, observedAt,
          verificationScope: "fixed_endpoint_authorization", persistsAcrossRestart: false };
      } else if (key === "authorizationFailure" && nested && ["http_401", "http_403", "business_20003"].includes(nested.reason)) {
        target[key] = { reason: nested.reason, observedAt: /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(nested.observedAt) ? nested.observedAt : null };
      } else if (key === "authorizationOnlineReady" && typeof nested === "boolean") {
        target[key] = nested;
      } else if ((key === "secretValuesExposed" && nested === false)
        || (["supplierCredentialsCopied", "copiesSupplierCredentials"].includes(key) && typeof nested === "boolean")) {
        // These exact booleans describe provenance; actual credential material
        // remains covered by the redactor.
        target[key] = nested;
      } else if (nested && typeof nested === "object") {
        restoreFalseSecurityAssertions(nested, target[key], depth + 1);
      }
    }
  };
  restoreFalseSecurityAssertions(value, publicValue);
  const authorizationReady = value?.capabilities?.discovery?.regionalGiftRanking?.authorizationReady;
  if (typeof authorizationReady === "boolean"
    && publicValue?.capabilities?.discovery?.regionalGiftRanking) {
    // This exact boolean is capability metadata, not authorization material.
    // The generic TikTok redactor intentionally treats every other
    // authorization-shaped key as sensitive.
    publicValue.capabilities.discovery.regionalGiftRanking.authorizationReady = authorizationReady;
  }
  return publicValue;
}

function safeErrorCode(error, fallback = "tkdesk_error") {
  return sanitizeTikTokText(error?.code || fallback);
}

function safeErrorMessage(error) {
  return sanitizeTikTokText(error?.message ?? error);
}

function safeErrorStack(error) {
  return sanitizeTikTokText(error?.stack ?? error?.message ?? error);
}

function appendAudit(event) {
  return database.appendAudit(sanitizeTikTokValue(event));
}

function requiredRun(runId) {
  const run = database.getRun(runId);
  if (!run) throw rpcError(`找不到采集任务：${runId}`, "run_not_found");
  return run;
}

function sourceTarget(source) {
  if (source === "tiktok_live") return "tiktok_discovery";
  if (source === "svip_legacy") return "svip_legacy";
  throw rpcError(`不支持的采集源：${source}`, "unsupported_source");
}

function awaitingStatus(target, loginState) {
  if (loginState === "manual_verification") return "awaiting_manual_verification";
  if (target === "tiktok_discovery") return "awaiting_tiktok_login";
  if (target === "collection_backstage") return "awaiting_collection_backstage_login";
  return "awaiting_svip_login";
}

function isRoutedTarget(target) {
  return target === "tiktok_discovery" || target === "collection_backstage";
}

function requestedCountryCodes(filters = {}, field = "countryCodes") {
  const hasCountryCodes = filters.countryCodes !== undefined && filters.countryCodes !== null;
  const hasCountryCode = filters.countryCode !== undefined
    && filters.countryCode !== null
    && filters.countryCode !== "";
  if (hasCountryCodes && !Array.isArray(filters.countryCodes)) {
    throw rpcError("countryCodes 必须是国家代码数组", "collection_countries_invalid");
  }
  const raw = hasCountryCodes
    ? filters.countryCodes
    : hasCountryCode ? [filters.countryCode] : [];
  const normalized = raw.map((value, index) => normalizeCountryCode(value, `${field}[${index}]`));
  if (normalized.length < 1 || normalized.length > 3) {
    throw rpcError("一次采集必须选择 1 到 3 个国家", "collection_country_count_invalid", {
      minimum: 1,
      maximum: 3,
      received: normalized.length
    });
  }
  if (new Set(normalized).size !== normalized.length) {
    throw rpcError("同一个国家不能重复占用采集槽", "collection_country_duplicate");
  }
  if (hasCountryCodes && hasCountryCode) {
    const compatibilityCountry = normalizeCountryCode(filters.countryCode, "countryCode");
    if (normalized.length !== 1 || normalized[0] !== compatibilityCountry) {
      throw rpcError(
        "countryCode 仅是单国家兼容字段，不能与多国家 countryCodes 冲突",
        "collection_country_alias_mismatch",
        { countryCodes: normalized, countryCode: compatibilityCountry }
      );
    }
  }
  return normalized;
}

function runCountryCodesOrEmpty(filters = {}) {
  try {
    return requestedCountryCodes(filters);
  } catch {
    return [];
  }
}

function countryLaneForWorkId(route, workId) {
  const details = dualRouteDetails(route);
  if (!details || !Number.isInteger(workId) || workId < 1 || workId > details.collectionLanes.length) {
    return null;
  }
  return details.collectionLanes[workId - 1] ?? null;
}

function countryLaneForCandidate(route, candidate = {}, explicitCountryCode = null) {
  const details = dualRouteDetails(route);
  if (!details) return null;
  const rawScopeCountries = [
    explicitCountryCode,
    candidate.rankingScopeCountryCode,
    candidate.rankingScope?.countryCode,
    candidate.collectionLaneEvidence?.countryCode
  ].filter((value) => value !== undefined && value !== null && value !== "");
  const normalizedScopeCountries = [];
  for (const value of rawScopeCountries) {
    try {
      normalizedScopeCountries.push(normalizeCountryCode(value, "candidateRankingScopeCountryCode"));
    } catch {
      return null;
    }
  }
  if (new Set(normalizedScopeCountries).size > 1) return null;
  const scopedCountry = normalizedScopeCountries[0] ?? null;
  const workId = Number(candidate.workId);
  if (Number.isInteger(workId) && workId >= 1 && workId <= 3) {
    const indexed = details.collectionLanes[workId - 1] ?? null;
    if (!indexed || (scopedCountry && scopedCountry !== indexed.countryCode)) return null;
    return indexed;
  }
  // Original WorkID4 falls back to MobileSettings[0]. Our multi-country
  // compatibility binding must therefore carry an explicit ranking scope;
  // routeCountry is only a lane-1 compatibility alias and is unsafe here.
  if (workId === 4 && !scopedCountry) return null;
  const compatibilityCountry = scopedCountry ?? candidate.routeCountry ?? null;
  if (!compatibilityCountry) return null;
  let normalizedCompatibilityCountry;
  try {
    normalizedCompatibilityCountry = normalizeCountryCode(
      compatibilityCountry,
      "candidateCountryCode"
    );
  } catch {
    return null;
  }
  return details.collectionLanes.find(
    (lane) => lane.countryCode === normalizedCompatibilityCountry
  ) ?? null;
}

function normalizeDualRouteIntent({
  marketRegion,
  marketCountryCodes,
  collectionLanes,
  routeCountry,
  backstageCountry,
  discoveryCountry,
  discoveryProxyServer,
  collectionProxyServer,
  collectionProxyServers
}) {
  const normalizedDiscoveryCountry = normalizeCountryCode(discoveryCountry, "discoveryCountry");
  if (normalizedDiscoveryCountry !== DISCOVERY_COUNTRY) {
    throw rpcError(
      `TikTok 主播发现线路必须使用 ${DISCOVERY_COUNTRY} 出口`,
      "discovery_country_must_be_us",
      { expectedCountry: DISCOVERY_COUNTRY, discoveryCountry: normalizedDiscoveryCountry }
    );
  }
  return normalizeRouteIntent({
    marketRegion,
    marketCountryCodes,
    discoveryCountry: normalizedDiscoveryCountry,
    discoveryProxyServer,
    ...(collectionLanes === undefined ? {} : { collectionLanes }),
    ...(routeCountry === undefined ? {} : { routeCountry }),
    ...(backstageCountry === undefined ? {} : { backstageCountry }),
    ...(collectionLanes !== undefined
      ? {}
      : collectionProxyServers === undefined
        ? { collectionProxyServer }
        : { collectionProxyServers })
  });
}

function dualRouteConfigurationFingerprint(route) {
  return fingerprintRouteIntent(route);
}

function dualRouteDetails(route) {
  try {
    const normalized = normalizeRouteIntent(route);
    if (normalized.discoveryCountry !== DISCOVERY_COUNTRY) return null;
    const normalizedLanes = Array.isArray(normalized.collectionLanes)
      ? normalized.collectionLanes
      : (normalized.collectionProxyServers ?? []).map((proxyServer, index) => ({
          countryCode: normalized.collectionCountryCodes?.[index]
            ?? (index === 0 ? normalized.routeCountry : null),
          proxyServer
        }));
    if (normalizedLanes.length < 1 || normalizedLanes.length > 3) return null;
    const rawExitCountries = Array.isArray(route.collectionProxyExitCountries)
      ? route.collectionProxyExitCountries
      : [];
    const collectionLanes = normalizedLanes.map((lane, index) => {
      const value = rawExitCountries[index]
        ?? (index === 0 ? (route.proxyExitCountry ?? route.collectionProxyExitCountry) : null);
      let proxyExitCountry = null;
      if (value !== null && value !== undefined && value !== "") {
        try {
          proxyExitCountry = normalizeCountryCode(value, `collectionProxyExitCountries[${index}]`);
        } catch {
          proxyExitCountry = null;
        }
      }
      return {
        workId: index + 1,
        countryCode: normalizeCountryCode(lane.countryCode, `collectionLanes[${index}].countryCode`),
        proxyServer: lane.proxyServer,
        proxyExitCountry
      };
    });
    const collectionProxyServers = collectionLanes.map((lane) => lane.proxyServer);
    const collectionCountryCodes = collectionLanes.map((lane) => lane.countryCode);
    const collectionProxyExitCountries = collectionLanes.map((lane) => lane.proxyExitCountry);
    return {
      discoveryCountry: normalized.discoveryCountry,
      discoveryProxyServer: normalized.discoveryProxyServer,
      discoveryProxyExitCountry: route.discoveryProxyExitCountry ?? null,
      collectionLanes,
      collectionCountryCodes,
      collectionProxyServer: normalized.collectionProxyServer,
      collectionProxyServers,
      collectionProxyLaneMode: normalized.collectionProxyLaneMode ?? "country_per_lane",
      collectionProxyLaneCount: collectionProxyServers.length,
      collectionProxyExitCountry: collectionProxyExitCountries[0] ?? null,
      collectionProxyExitCountries
    };
  } catch {
    return null;
  }
}

function dualRouteVerification(route, patch = {}) {
  const details = dualRouteDetails(route);
  if (!details) {
    throw rpcError(
      "该线路不是国家与节点一一对应的配置；请重新配置美国 TikTok 发现节点和 1 到 3 条国家采集线路",
      "country_lane_route_configuration_required",
      { routeProfileId: route?.routeProfileId ?? null }
    );
  }
  return {
    ...(route.verification ?? {}),
    countryLaneRouteSchemaVersion: COUNTRY_LANE_ROUTE_SCHEMA_VERSION,
    discoveryCountry: details.discoveryCountry,
    collectionCountryCodes: details.collectionCountryCodes,
    ...patch
  };
}

function targetRouteCountry(route, target) {
  const details = dualRouteDetails(route);
  if (target === "tiktok_discovery") return details?.discoveryCountry ?? null;
  // The collection sub-backend shares WorkID1's country-matched node. WorkID2
  // and WorkID3 remain independent lanes and do not alter this login profile.
  if (target === "collection_backstage") return details?.collectionCountryCodes?.[0] ?? null;
  return null;
}

function routeLaunchInput(route, target) {
  const details = dualRouteDetails(route);
  if (!details) {
    throw rpcError(
      "该线路缺少美国 TikTok 发现节点或国家采集节点；请重新配置后再打开登录窗口",
      "country_lane_route_configuration_required",
      { routeProfileId: route?.routeProfileId ?? null }
    );
  }
  if (!isRoutedTarget(target)) throw rpcError(`不支持的线路会话：${target}`, "unsupported_route_target");
  return normalizeRoutePolicy({
    marketRegion: route.marketRegion,
    marketCountryCodes: route.marketCountryCodes,
    discoveryCountry: details.discoveryCountry,
    discoveryProxyServer: details.discoveryProxyServer,
    discoveryProxyExitCountry: details.discoveryProxyExitCountry,
    collectionLanes: details.collectionLanes.map(({ countryCode, proxyServer }) => ({ countryCode, proxyServer })),
    collectionCountryCodes: details.collectionCountryCodes,
    routeCountry: details.collectionCountryCodes[0],
    backstageCountry: details.collectionCountryCodes[0],
    collectionProxyServer: details.collectionProxyServer,
    collectionProxyServers: details.collectionProxyServers,
    proxyExitCountry: details.collectionProxyExitCountry,
    collectionProxyExitCountries: details.collectionProxyExitCountries
  });
}

function targetSessionRouteFingerprint(route, target) {
  try {
    const details = dualRouteDetails(route);
    if (!details) return null;
    if (target === "tiktok_discovery") {
      return fingerprintDiscoverySessionRoute({
        discoveryCountry: details.discoveryCountry,
        discoveryProxyServer: details.discoveryProxyServer
      });
    }
    if (target === "collection_backstage") {
      const firstLane = details.collectionLanes[0];
      return fingerprintCollectionSessionRoute({
        collectionLanes: [{
          countryCode: firstLane.countryCode,
          proxyServer: firstLane.proxyServer
        }]
      });
    }
    return null;
  } catch {
    return null;
  }
}

function runtimeRouteFingerprint(route) {
  try {
    return fingerprintRoutePolicy(routeLaunchInput(route, "tiktok_discovery"));
  } catch {
    return null;
  }
}

function isDualRouteVerified(route) {
  const details = dualRouteDetails(route);
  return Boolean(details
    && route.verificationStatus === "verified"
    && details.collectionProxyLaneCount >= 1
    && details.collectionProxyLaneCount <= 3
    && details.collectionProxyExitCountries.length === details.collectionProxyLaneCount
    && details.collectionLanes.every((lane) => lane.proxyExitCountry === lane.countryCode)
    && route.discoveryProxyExitCountry === details.discoveryCountry
    && details.discoveryCountry === DISCOVERY_COUNTRY
    && targetSessionRouteFingerprint(route, "tiktok_discovery")
    && targetSessionRouteFingerprint(route, "collection_backstage"));
}

function publicRoute(route) {
  if (!route) return null;
  const dual = dualRouteDetails(route);
  const collectionLanes = dual?.collectionLanes?.map((lane) => ({
    workId: lane.workId,
    countryCode: lane.countryCode,
    observedExitCountry: lane.proxyExitCountry,
    verified: lane.proxyExitCountry === lane.countryCode
  })) ?? [];
  return {
    routeProfileId: route.routeProfileId,
    marketRegion: route.marketRegion,
    marketCountryCodes: route.marketCountryCodes,
    // Compatibility aliases point to lane 1 only. Multi-country consumers
    // must use collectionCountryCodes/collectionLanes.
    routeCountry: dual?.collectionCountryCodes?.[0] ?? route.routeCountry ?? null,
    backstageCountry: dual?.collectionCountryCodes?.[0] ?? route.backstageCountry ?? null,
    collectionCountryCodes: dual?.collectionCountryCodes ?? [],
    discoveryCountry: dual?.discoveryCountry ?? null,
    discoveryProxyExitCountry: dual?.discoveryProxyExitCountry ?? null,
    collectionProxyExitCountry: dual?.collectionProxyExitCountry ?? null,
    collectionProxyExitCountries: dual?.collectionProxyExitCountries ?? [],
    collectionProxyLaneMode: dual?.collectionProxyLaneMode ?? null,
    collectionProxyLaneCount: dual?.collectionProxyLaneCount ?? 0,
    collectionLanes,
    // Backward-compatible alias: proxyExitCountry describes collection lane 1
    // only; the remaining lanes may intentionally be different countries.
    proxyExitCountry: dual?.collectionProxyExitCountry ?? route.proxyExitCountry ?? null,
    verificationStatus: route.verificationStatus,
    verifiedAt: route.verifiedAt,
    countryLaneRouteSchemaVersion: route.verification?.countryLaneRouteSchemaVersion
      ?? COUNTRY_LANE_ROUTE_SCHEMA_VERSION,
    active: route.active
  };
}

async function probeAndRecordDualRoute(route, reason) {
  const details = dualRouteDetails(route);
  if (!details) {
    throw rpcError(
      "该线路缺少美国 TikTok 发现节点或国家采集线路；请重新配置",
      "country_lane_route_configuration_required",
      { routeProfileId: route.routeProfileId }
    );
  }
  if (details.collectionLanes.length < 1 || details.collectionLanes.length > 3) {
    throw rpcError(
      "全自动采集必须配置 1 到 3 条国家采集线路，每个国家一条",
      "collection_lane_count_invalid",
      { routeProfileId: route.routeProfileId, configuredLaneCount: details.collectionProxyServers.length }
    );
  }
  const [discoveryProbe, ...collectionProbes] = await Promise.allSettled([
    probeProxyExitCountry(details.discoveryProxyServer),
    ...details.collectionProxyServers.map((proxyServer) => probeProxyExitCountry(proxyServer))
  ]);
  const discoveryObservedCountry = discoveryProbe.status === "fulfilled"
    ? discoveryProbe.value
    : null;
  const collectionObservedCountries = collectionProbes.map((probe) => (
    probe.status === "fulfilled" ? probe.value : null
  ));
  const collectionObservedCountry = collectionObservedCountries[0] ?? null;
  const probeFailed = discoveryProbe.status === "rejected"
    || !discoveryObservedCountry
    || collectionProbes.some((probe) => probe.status === "rejected")
    || collectionObservedCountries.some((country) => !country);
  const discoveryMismatch = discoveryObservedCountry !== null
    && discoveryObservedCountry !== details.discoveryCountry;
  const collectionMismatch = collectionObservedCountries.some((country, index) => (
    country !== null && country !== details.collectionLanes[index].countryCode
  ));
  const verification = dualRouteVerification(route, {
    provider: "cloudflare_trace",
    reason,
    outcome: probeFailed
      ? "probe_failed"
      : discoveryMismatch || collectionMismatch
        ? "country_mismatch"
        : "matched",
    discoveryProxyExitCountry: discoveryObservedCountry,
    collectionProxyExitCountry: collectionObservedCountry,
    collectionProxyExitCountries: collectionObservedCountries,
    discoveryProbeCode: discoveryProbe.status === "rejected"
      ? safeErrorCode(discoveryProbe.reason)
      : null,
    collectionProbeCodes: collectionProbes.map((probe) => (
      probe.status === "rejected" ? safeErrorCode(probe.reason) : null
    )),
    discoveryVerifiedAt: !probeFailed && !discoveryMismatch ? new Date().toISOString() : null,
    collectionVerifiedAt: !probeFailed && !collectionMismatch ? new Date().toISOString() : null
  });

  if (probeFailed || discoveryMismatch || collectionMismatch) {
    // A failed probe can leave null holes. The structured exit columns accept
    // either a complete per-lane vector or the empty unverified sentinel; raw
    // partial observations remain available only in verification JSON.
    const completeCollectionObservedCountries = collectionObservedCountries.every(Boolean)
      ? collectionObservedCountries
      : [];
    const completeCollectionObservedCountry = completeCollectionObservedCountries[0] ?? null;
    database.recordCollectionRouteVerification(route.routeProfileId, {
      proxyFingerprint: route.proxyFingerprint,
      discoveryProxyExitCountry: discoveryObservedCountry,
      proxyExitCountry: completeCollectionObservedCountry,
      collectionProxyExitCountries: completeCollectionObservedCountries,
      verificationStatus: probeFailed ? "verification_failed" : "country_mismatch",
      verification
    });
    if (probeFailed) {
      throw rpcError(
        "无法同时确认美国 TikTok 发现节点和全部国家采集线路；线路已暂停",
        "country_lane_route_reverification_required",
        {
          routeProfileId: route.routeProfileId,
          discoveryProbeCode: verification.discoveryProbeCode,
          collectionProbeCodes: verification.collectionProbeCodes
        }
      );
    }
    if (discoveryMismatch) {
      throw rpcError(
        `主播发现代理出口 ${discoveryObservedCountry} 不是 ${DISCOVERY_COUNTRY}`,
        "discovery_proxy_exit_country_mismatch",
        { expectedCountry: DISCOVERY_COUNTRY, observedCountry: discoveryObservedCountry }
      );
    }
    const mismatchLane = collectionObservedCountries.findIndex((country, index) => (
      country !== details.collectionLanes[index].countryCode
    ));
    const expectedCountry = details.collectionLanes[mismatchLane].countryCode;
    throw rpcError(
      `采集线路 WorkID ${mismatchLane + 1} 的出口 ${collectionObservedCountries[mismatchLane]} 与该槽国家 ${expectedCountry} 不一致`,
      "collection_proxy_exit_country_mismatch",
      {
        expectedCountry,
        workId: mismatchLane + 1,
        observedCountry: collectionObservedCountries[mismatchLane]
      }
    );
  }

  // Validate both target-specific session policies before recording success.
  normalizeRoutePolicy({
    marketRegion: route.marketRegion,
    marketCountryCodes: route.marketCountryCodes,
    discoveryCountry: details.discoveryCountry,
    discoveryProxyServer: details.discoveryProxyServer,
    discoveryProxyExitCountry: discoveryObservedCountry,
    collectionLanes: details.collectionLanes.map(({ countryCode, proxyServer }) => ({ countryCode, proxyServer })),
    collectionCountryCodes: details.collectionCountryCodes,
    routeCountry: details.collectionCountryCodes[0],
    backstageCountry: details.collectionCountryCodes[0],
    collectionProxyServer: details.collectionProxyServer,
    collectionProxyServers: details.collectionProxyServers,
    proxyExitCountry: collectionObservedCountry,
    collectionProxyExitCountries: collectionObservedCountries
  });
  return database.recordCollectionRouteVerification(route.routeProfileId, {
    proxyFingerprint: route.proxyFingerprint,
    discoveryProxyExitCountry: discoveryObservedCountry,
    proxyExitCountry: collectionObservedCountry,
    collectionProxyExitCountries: collectionObservedCountries,
    verificationStatus: "verified",
    verification,
    verifiedAt: new Date().toISOString()
  });
}

async function revalidateDualRouteEgress(route, reason = "run_start_reprobe") {
  const refreshed = await probeAndRecordDualRoute(route, reason);
  return refreshed.active ? refreshed : database.setActiveCollectionRoute(refreshed.routeProfileId);
}

function requiredCollectionRoute(routeProfileId = null, { verified = true } = {}) {
  const route = routeProfileId
    ? database.getCollectionRoute(routeProfileId)
    : (verified
      ? database.getActiveCollectionRoute()
      : (database.listCollectionRoutes({ active: false, limit: 1 })[0]
        ?? database.getActiveCollectionRoute()));
  if (!route) {
    throw rpcError(
      "尚未配置采集国家和对应代理；请先配置并验证采集线路",
      "collection_route_required"
    );
  }
  if (verified && !isDualRouteVerified(route)) {
    throw rpcError(
      "美国 TikTok 发现节点或所选国家采集线路尚未全部验证，已拒绝启动任务",
      "collection_route_unverified",
      publicRoute(route)
    );
  }
  return route;
}

function assertRunRoute(run, route) {
  const marketRegion = String(run.filters?.marketRegion ?? run.filters?.region ?? "").trim().toUpperCase();
  const countryCodes = requestedCountryCodes(run.filters ?? {});
  if (!marketRegion) {
    throw rpcError(
      "地区采集任务必须明确选择 marketRegion 大区和 1 到 3 个国家",
      "collection_route_filters_required"
    );
  }
  const details = dualRouteDetails(route);
  const configuredCountries = details?.collectionCountryCodes ?? [];
  if (marketRegion !== route.marketRegion
    || countryCodes.some((countryCode) => !configuredCountries.includes(countryCode))) {
    throw rpcError(
      "任务选择的大区/国家没有对应的已验证一国一节点线路",
      "collection_route_mismatch",
      { task: { marketRegion, countryCodes }, route: publicRoute(route) }
    );
  }
  if (countryCodes.some((countryCode) => !route.marketCountryCodes.includes(countryCode))) {
    throw rpcError("任务国家不在该大区显式国家列表中", "collection_country_not_in_market");
  }
  const expectedConfigurationFingerprint = run.config?.routeConfigurationFingerprint ?? null;
  if (expectedConfigurationFingerprint && expectedConfigurationFingerprint !== route.proxyFingerprint) {
    throw rpcError(
      "任务创建后采集线路配置已发生变化；必须重新验证线路并新建任务",
      "collection_route_changed",
      {
        routeProfileId: route.routeProfileId,
        expectedConfigurationFingerprint,
        actualConfigurationFingerprint: route.proxyFingerprint
      }
    );
  }
  const expectedRouteFingerprint = run.config?.routeFingerprint ?? null;
  const actualRouteFingerprint = runtimeRouteFingerprint(route);
  if (expectedRouteFingerprint && expectedRouteFingerprint !== actualRouteFingerprint) {
    throw rpcError(
      "任务创建后采集线路配置已发生变化；必须重新验证线路并新建任务",
      "collection_route_changed",
      {
        routeProfileId: route.routeProfileId,
        expectedRouteFingerprint,
        actualRouteFingerprint
      }
    );
  }
  return { marketRegion, countryCodes };
}

async function routedSessionState(target, route) {
  const status = await sessions.status(target);
  const expectedRouteFingerprint = targetSessionRouteFingerprint(route, target);
  const expectedRouteCountry = targetRouteCountry(route, target);
  if (!status.running) {
    return { status, expectedRouteFingerprint, expectedRouteCountry, restartRequired: false };
  }
  const restartRequired = !expectedRouteFingerprint
    || status.routeFingerprint !== expectedRouteFingerprint
    || status.routeCountry !== expectedRouteCountry;
  return { status, expectedRouteFingerprint, expectedRouteCountry, restartRequired };
}

function ensureQualificationPolicyState(at = new Date()) {
  const atIso = at instanceof Date ? at.toISOString() : new Date(at).toISOString();
  const active = database.getQualificationPolicyState({ at: atIso, activeOnly: true });
  if (active) return active;
  const targets = chooseQualificationTargets();
  const epochStartedAt = atIso;
  const epochEndsAt = new Date(Date.parse(atIso) + 24 * 60 * 60 * 1_000).toISOString();
  return database.upsertQualificationPolicyState({
    hourlyTarget: targets.hourly,
    dailyTarget: targets.daily,
    epochStartedAt,
    epochEndsAt
  });
}

ensureQualificationPolicyState();

function hasValidatedOriginalDerivedCandidate(runId) {
  const requiredStages = [
    "basic",
    "country",
    "ranking",
    "top_score",
    "anchor_level"
  ];
  return database.queryProspects({ runId, limit: 2_000, offset: 0 }).some((prospect) => {
    const discovery = prospect.latestDiscoveryObservation ?? {};
    const qualification = prospect.latestQualificationObservation ?? {};
    // Runtime validation must be tied to this run's immutable observation
    // evidence. The aggregate prospect row can outlive a run (or be updated by
    // another run), so accepting it here would let a compact run summary or a
    // stale aggregate falsely certify a live sample.
    const data = discovery.data ?? {};
    const stages = new Set(Array.isArray(data.dataProcessorStages) ? data.dataProcessorStages : []);
    const topCode = Number(data.topCode);
    return data.workId === 4
      && data.dataProcessorStatus === "ready"
      && data.dataProcessorComplete === true
      && data.dataProcessorEvidenceVersion === TIKTOK_DATA_ENRICHMENT_PROFILE.adapterEvidenceVersion
      && requiredStages.every((stage) => stages.has(stage))
      && (topCode === 1 || stages.has("history_rank"))
      && data.originalScoreEvidence?.state === "ready"
      && data.originalScoreEvidence?.evidenceVersion
        === TIKTOK_RANKING_TRANSPORT_PROFILE.originalScoreEvidenceVersion
      && qualification.source === "collection_backstage"
      && qualification.invitationEligibility === "available";
  });
}

function regionalRankingRuntimeValidation() {
  const activeRoute = database.getActiveCollectionRoute();
  const activeRouteFingerprint = activeRoute ? runtimeRouteFingerprint(activeRoute) : null;
  const activeCountries = dualRouteDetails(activeRoute)?.collectionCountryCodes ?? [];
  const validatedRun = database.listRuns({ limit: 2_000 }).find((run) => {
    const method = run.filters?.discoveryMethod
      ?? (run.source === "tiktok_live" && run.mode === "full_auto"
        ? "regional_gift_ranking"
        : null);
    const discovery = run.result?.discovery ?? {};
    const cascade = run.result?.fullAuto?.cascade ?? {};
    const expansion = Array.isArray(cascade.rounds)
      ? cascade.rounds.find((round) => (
          Number(round?.found ?? 0) > 0
          && round?.triggerKind === "original_room_seed_direct_request"
          && round?.endpointFingerprint === TIKTOK_RANKING_TRANSPORT_PROFILE.endpointFingerprint
          && round?.rankTypeCode === 16
          && round?.regionTypeCode === 1
          && Array.isArray(round?.gapIntervals)
          && round.gapIntervals.length === 2
          && round.gapIntervals[0] === 0
          && round.gapIntervals[1] === -1
          && round?.rankingPairComplete === true
          && round?.sourceType === "tiktok_rank_view"
          && round?.adapterEvidenceVersion === TIKTOK_RANKING_CAPABILITY.evidenceVersion
          && round?.listProducing === true
          && round?.rankingViewKind === "top"
        ))
      : null;
    const runCountries = runCountryCodesOrEmpty(run.filters ?? {});
    return run.source === "tiktok_live"
      && run.status === "completed"
      && method === "regional_gift_ranking"
      && activeRoute !== null
      && isDualRouteVerified(activeRoute)
      && activeRouteFingerprint !== null
      && run.config?.routeProfileId === activeRoute.routeProfileId
      && run.config?.routeFingerprint === activeRouteFingerprint
      && run.config?.routeConfigurationFingerprint === activeRoute.proxyFingerprint
      && String(run.filters?.marketRegion ?? run.filters?.region ?? "").toUpperCase() === activeRoute.marketRegion
      && runCountries.length > 0
      && runCountries.every((countryCode) => activeCountries.includes(countryCode))
      && Number(discovery.found ?? 0) > 0
      && discovery.sourceType === "tiktok_original_country_discovery_union"
      && discovery.triggerKind === "original_pc_web_feed_and_mobile_processor_fixed_country_lists"
      && discovery.listProducing === true
      && discovery.selectionComplete === true
      && discovery.mobileTemplateAttempted === true
      && discovery.mobileTemplateComplete === true
      && discovery.mobileTemplateEvidenceVersion
        === TIKTOK_RANKING_TRANSPORT_PROFILE.originalTemplateBundleEvidenceVersion
      && discovery.pcWebWorkers === runCountries.length
      && discovery.dataProcessorWorkers === 4
      && discovery.workIdAffinity === "feed_1_3_rank_descendants_4"
      && discovery.adapterEvidenceVersion === "original-country-discovery-union-v1"
      && discovery.dataProcessorEvidenceVersion === TIKTOK_DATA_ENRICHMENT_PROFILE.adapterEvidenceVersion
      && cascade.implementation === "original_pcweb_live_ranking_loop"
      && run.result?.fullAuto?.complete === true
      && cascade.complete === true
      && hasValidatedOriginalDerivedCandidate(run.runId)
      && Boolean(expansion);
  });
  return {
    liveSampleValidated: Boolean(validatedRun),
    lastValidatedRunId: validatedRun?.runId ?? null,
    validatedMarketRegion: validatedRun ? activeRoute.marketRegion : null,
    validatedCountryCodes: validatedRun ? runCountryCodesOrEmpty(validatedRun.filters ?? {}) : [],
    // Backward-compatible alias for single-country consumers.
    validatedCountryCode: validatedRun && runCountryCodesOrEmpty(validatedRun.filters ?? {}).length === 1
      ? runCountryCodesOrEmpty(validatedRun.filters ?? {})[0]
      : null,
    validatedRouteProfileId: validatedRun ? activeRoute.routeProfileId : null,
    adapterEvidenceVersion: TIKTOK_RANKING_CAPABILITY.evidenceVersion
  };
}

const PUBLIC_MOBILE_ACCESS_STATES = new Set([
  "upstream_rejected",
  "ready",
  "missing",
  "expired",
  "unsupported_country",
  "market_mismatch",
  "invalid"
]);

function publicMobileAccessState(value, requested = {}) {
  const providerReasonState = value?.state === "authorization_required"
    && PUBLIC_MOBILE_ACCESS_STATES.has(value?.reason)
    ? value.reason
    : null;
  const state = PUBLIC_MOBILE_ACCESS_STATES.has(value?.state)
    ? value.state
    : (providerReasonState ?? "invalid");
  const reason = typeof value?.reason === "string"
    ? sanitizeTikTokText(value.reason).slice(0, 160)
    : null;
  return {
    state,
    usable: state === "ready" && value?.usable !== false,
    reason,
    configurationState: value?.configurationState ?? state,
    onlineVerified: value?.onlineVerified === true,
    onlineAuthorization: value?.onlineAuthorization ?? projectMobileAuthorizationRuntime().onlineAuthorization,
    marketRegion: requested.marketRegion ?? null,
    countryCode: requested.countryCode ?? null,
    secretValuesExposed: false,
    supplierCredentialsCopied: value?.source === "user_authorized_original_bundle",
    ...(value?.source === "user_authorized_original_bundle" ? { provenance: value.source } : {})
  };
}

function configuredMobileRuntime(status = {}) {
  const observations = (status.countryCodes ?? []).map(countryCode => {
    const profile = originalExecutableProfileForCountry({ marketRegion: status.marketRegion, countryCode });
    return mobileRankingAuthorizationProvider.onlineStatus({ marketRegion: status.marketRegion, countryCode,
      endpointProfileId: profile?.id });
  });
  return projectMobileAuthorizationRuntime(status, observations);
}

function publicCoreConfigurationStatus(value) {
  const countries = value?.countries ?? {};
  const mobileAccess = value?.mobileAuthorization ?? {};
  const state = value?.state === "ready"
    ? "ready"
    : value?.state === "uninitialized" ? "uninitialized" : "invalid";
  return {
    state,
    schemaVersion: typeof value?.schemaVersion === "string" ? value.schemaVersion : null,
    coreVersion: Number.isSafeInteger(value?.coreVersion) ? value.coreVersion : null,
    encryption: typeof value?.encryption === "string" ? value.encryption : null,
    errorCode: state === "invalid" && typeof value?.errorCode === "string"
      ? sanitizeTikTokText(value.errorCode)
      : null,
    countries: {
      count: Number.isSafeInteger(countries.count) ? countries.count : 0,
      countryCodes: Array.isArray(countries.countryCodes)
        ? countries.countryCodes.filter((countryCode) => /^[A-Z]{2}$/.test(countryCode))
        : [],
      marketRegions: Array.isArray(countries.marketRegions)
        ? countries.marketRegions.filter((region) => /^[A-Z0-9_-]{2,32}$/.test(region))
        : []
    },
    mobileAccess: {
      ...configuredMobileRuntime(mobileAccess),
      configured: mobileAccess.configured === true,
      marketRegion: typeof mobileAccess.marketRegion === "string" ? mobileAccess.marketRegion : null,
      countryCodes: Array.isArray(mobileAccess.countryCodes)
        ? mobileAccess.countryCodes.filter((countryCode) => /^[A-Z]{2}$/.test(countryCode))
        : [],
      installedAt: typeof mobileAccess.installedAt === "string" ? mobileAccess.installedAt : null,
      expiresAt: typeof mobileAccess.expiresAt === "string" ? mobileAccess.expiresAt : null,
      provenance: ["user_owned_local_secure_terminal", "user_authorized_original_bundle"].includes(mobileAccess.provenance)
        ? mobileAccess.provenance
        : null
    },
    secretValuesExposed: false,
    supplierCredentialsCopied: value?.supplierCredentialsCopied === true
  };
}

async function mobileAccessStatus({ marketRegion = null, countryCode = null } = {}) {
  if (!marketRegion && !countryCode) {
    const core = await rankingCoreConfigStore.status();
    const status = core?.mobileAuthorization ?? {};
    return publicMobileAccessState({
      ...configuredMobileRuntime(status),
      source: status.provenance
    }, {
      marketRegion: status.marketRegion ?? null,
      countryCode: null
    });
  }
  if (!marketRegion || !countryCode) {
    return publicMobileAccessState({ state: "invalid", usable: false, reason: "scope_incomplete" }, {
      marketRegion,
      countryCode
    });
  }
  const executableProfile = originalExecutableProfileForCountry({ marketRegion, countryCode });
  if (!executableProfile) {
    return publicMobileAccessState({
      state: "unsupported_country",
      usable: false,
      reason: "country_profile_not_configured"
    }, { marketRegion, countryCode });
  }
  const raw = await mobileRankingAuthorizationProvider.status({
    marketRegion,
    countryCode,
    endpointProfileId: executableProfile.id
  });
  return publicMobileAccessState(raw, { marketRegion, countryCode });
}

async function mobileAccessReadinessForRoute(route, countryCodes = null) {
  const details = dualRouteDetails(route);
  const marketRegion = typeof route?.marketRegion === "string"
    ? route.marketRegion.trim().toUpperCase()
    : "";
  const selected = Array.isArray(countryCodes) && countryCodes.length
    ? countryCodes
    : details?.collectionCountryCodes ?? [];
  if (!details || !marketRegion || !selected.length) {
    const current = await mobileAccessStatus();
    return { ready: false, onlineReady: false, state: current.state, marketRegion: null, countryCodes: [], coverage: [] };
  }
  const coverage = [];
  for (const countryCode of selected) {
    coverage.push(await mobileAccessStatus({ marketRegion, countryCode }));
  }
  const ready = coverage.length > 0 && coverage.every((item) => item.state === "ready" && item.usable === true);
  return {
    ready,
    onlineReady: ready && coverage.every(item => item.onlineVerified === true),
    state: ready ? "ready" : (coverage.find((item) => item.state !== "ready")?.state ?? "invalid"),
    marketRegion,
    countryCodes: [...selected],
    coverage
  };
}

// A request may have reached TikTok even if the daemon exited before its
// response was persisted. Such batches are deliberately never replayed. Mark
// every stranded reservation as ambiguous and surface its creators as an
// explicit-recheck set before any run can resume.
const recoveredQualificationBatches = database.recoverReservedQualificationBatches({
  details: { reason: "daemon_startup_reconciliation" }
});
if (recoveredQualificationBatches.count > 0) {
  const byRun = new Map();
  for (const batch of recoveredQualificationBatches.batches) {
    if (!batch.runId) continue;
    const ids = byRun.get(batch.runId) ?? new Set();
    for (const candidateId of batch.candidateIds ?? []) ids.add(candidateId);
    byRun.set(batch.runId, ids);
  }
  for (const [runId, recoveredIds] of byRun) {
    const run = database.getRun(runId);
    if (!run) continue;
    const previousQualification = run.result?.qualification ?? {};
    const unresolvedCandidateIds = new Set(previousQualification.unresolvedCandidateIds ?? []);
    for (const candidateId of recoveredIds) unresolvedCandidateIds.add(candidateId);
    database.updateRun(runId, {
      status: "paused",
      result: {
        ...(run.result ?? {}),
        qualification: {
          ...previousQualification,
          qualificationComplete: false,
          unresolvedCandidateIds: [...unresolvedCandidateIds].sort(),
          unresolvedCount: unresolvedCandidateIds.size,
          ambiguousBatchRecoveryCount:
            Number(previousQualification.ambiguousBatchRecoveryCount ?? 0) + 1,
          stoppedReason: "explicit_recheck_required",
          automaticRetry: false
        }
      },
      error: {
        code: "QUALIFICATION_OUTCOME_AMBIGUOUS",
        message: "上次退出时有资格请求结果未能确认；这些主播不会自动重查，需显式复核"
      }
    });
  }
}

function sessionRecord(target, state, browserStatus) {
  const page = browserStatus?.pages?.find((item) => item.active) ?? browserStatus?.pages?.at(-1);
  return database.upsertSession({
    sessionKey: target,
    kind: target,
    profilePath: sessions.profileDirectory(target),
    status: state.state,
    currentUrl: sanitizeTikTokUrl(state.url ?? page?.url ?? null),
    authenticatedAt: state.authenticated ? new Date().toISOString() : undefined,
    lastCheckedAt: new Date().toISOString(),
    error: state.state === "blocked_navigation" ? { message: sanitizeTikTokText(state.message) } : null,
    metadata: {
      running: browserStatus?.running ?? false,
      engine: browserStatus?.engine ?? null,
      routeFingerprint: browserStatus?.routeFingerprint ?? null,
      routeCountry: browserStatus?.routeCountry ?? null
    }
  });
}

async function inspectSession(target) {
  const before = await sessions.status(target);
  const login = before.running
    ? await sessions.checkLogin(target)
    : {
        target,
        state: "stopped",
        authenticated: null,
        requiresUserAction: true,
        message: "登录浏览器尚未启动"
      };
  // checkLogin may attach to a running ordinary Chrome. Always refresh so the
  // response cannot mix a pre-check manual state with a post-check connection.
  const browser = await sessions.status(target);
  sessionRecord(target, login, browser);
  return { ...login, browser };
}

function safePreflightMarketRegion(value) {
  if (typeof value !== "string") return null;
  const firstSegment = value.trim().split("+", 1)[0].trim();
  const normalized = firstSegment === "中国台湾" ? "TW" : firstSegment.toUpperCase();
  return /^[A-Z][A-Z0-9_-]{1,31}$/.test(normalized) ? normalized : null;
}

function safePreflightBoolean(value) {
  return typeof value === "boolean" ? value : null;
}

function currentCollectionBackstagePage() {
  try { return sessions.page("collection_backstage"); } catch { return null; }
}

async function collectionReadiness(route = database.getActiveCollectionRoute(), runtimeSessions = null) {
  const browsers = runtimeSessions ?? await sessions.status();
  const sessionStates = Object.fromEntries(["tiktok_discovery", "collection_backstage"].map(target => {
    const browser = browsers[target];
    const expected = route ? targetSessionRouteFingerprint(route, target) : null;
    return [target, {
      running: browser?.running === true,
      authenticatedRequestReady: browser?.authenticatedRequestReady === true,
      restartRequired: Boolean(browser?.running && route && (!expected
        || browser.routeFingerprint !== expected || browser.routeCountry !== targetRouteCountry(route, target)))
    }];
  }));
  const observation = route ? collectionAdapterObservations.get(route.routeProfileId) : null;
  const page = currentCollectionBackstagePage();
  const age = Date.now() - Date.parse(observation?.evidence?.observedAt ?? "");
  const current = page && observation?.page === page
    && observation.evidence.routeFingerprint === runtimeRouteFingerprint(route)
    && age >= 0 && age <= COLLECTION_READINESS_EVIDENCE_TTL_MS;
  return inspectCollectionReadiness({
    routeConfigured: Boolean(route), routeVerified: Boolean(route && isDualRouteVerified(route)),
    sessions: sessionStates, adapterEvidence: current ? observation.evidence : null,
    qualificationBudgetAllowed: database.getQualificationUsage().allowed === true,
    collectorBusy: activeRuns.size > 0 || Boolean(activeQualification), shuttingDown: shutdownRequested
  });
}

function persistCollectionBackstagePreflight({ evidence, outcome, runId = null }) {
  const safeEvidence = sanitizeTikTokValue(evidence);
  collectionAdapterObservations.set(safeEvidence.routeProfileId, { evidence: safeEvidence, page: currentCollectionBackstagePage() });
  if (runId) {
    database.saveCheckpoint(
      runId,
      COLLECTION_BACKSTAGE_PREFLIGHT_CHECKPOINT_KEY,
      safeEvidence,
      { adapter: COLLECTION_BACKSTAGE_PREFLIGHT_CHECKPOINT_ADAPTER }
    );
  }
  appendAudit({
    action: "collection_backstage_preflight_checked",
    actor: "agent",
    targetType: runId ? "run" : "collection_route",
    targetId: runId ?? safeEvidence.routeProfileId,
    runId,
    outcome,
    details: safeEvidence
  });
  return safeEvidence;
}

async function requireCollectionBackstagePreflight({
  route,
  runId = null,
  sessionAuthenticated = false
}) {
  const expectedMarketRegion = safePreflightMarketRegion(route?.marketRegion);
  const routeFingerprint = runtimeRouteFingerprint(route);
  if (!expectedMarketRegion || !routeFingerprint) {
    throw rpcError(
      "已验证采集线路缺少可用于子后台预检的大区或线路指纹",
      "COLLECTION_ADAPTER_MISMATCH"
    );
  }
  const observedAt = new Date().toISOString();
  const baseEvidence = {
    schemaVersion: "tkdesk.collection-backstage-preflight-checkpoint.v2",
    adapterVersion: "collection-backstage-startup.v4",
    expectedMarketRegion,
    observedMarketRegion: null,
    regionMatched: false,
    accountAvailable: null,
    accountIdentityPresent: null,
    unionIdentityPresent: null,
    appIdentityPresent: null,
    qualificationAdapterReady: null,
    verificationPresentationReady: null,
    failureStage: null,
    verificationExportShape: null,
    qualificationRequestConsumed: false,
    routeProfileId: route.routeProfileId,
    routeFingerprint,
    observedAt
  };
  try {
    const routeState = await routedSessionState("collection_backstage", route);
    if (!routeState.status.running) {
      throw rpcError(
        "采集子后台登录窗口尚未启动",
        "authentication_required",
        { target: "collection_backstage" }
      );
    }
    if (routeState.restartRequired) {
      throw rpcError(
        "采集子后台窗口未绑定 WorkID 1 的已验证国家线路；请关闭该窗口后重新打开",
        "collection_route_restart_required",
        { target: "collection_backstage" }
      );
    }
    if (!sessionAuthenticated) {
      const login = await inspectSession("collection_backstage");
      if (login.state !== "authenticated") {
        throw rpcError(login.message, login.state, { target: "collection_backstage" });
      }
    }

    const inspected = await inspectCollectionBackstageStartup({
      page: sessions.page("collection_backstage"),
      expectedMarketRegion
    });
    if (inspected.regionMatched !== true
      || inspected.accountAvailable !== true
      || inspected.accountIdentityPresent !== true
      || inspected.qualificationRequestConsumed !== false) {
      throw rpcError(
        "采集子后台启动预检没有返回可用账号与匹配大区",
        "COLLECTION_BACKSTAGE_PREFLIGHT_UNAVAILABLE"
      );
    }
    const compatibility = await inspectCollectionBackstageCompatibility({
      page: sessions.page("collection_backstage")
    });
    if (compatibility.ready !== true) {
      throw rpcError(
        "采集子后台资格适配器与当前页面不兼容；本次未提交主播查询",
        "COLLECTION_ADAPTER_MISMATCH",
        {
          failureStage: compatibility.failureStage,
          verificationExportShape: compatibility.verificationExportShape ?? null,
          qualificationAdapterReady: false,
          qualificationRequestConsumed: false
        }
      );
    }
    return persistCollectionBackstagePreflight({
      runId,
      outcome: "matched",
      evidence: {
        ...baseEvidence,
        adapterVersion: inspected.adapterVersion,
        expectedMarketRegion: inspected.expectedMarketRegion,
        observedMarketRegion: inspected.observedMarketRegion,
        regionMatched: true,
        accountAvailable: true,
        accountIdentityPresent: true,
        unionIdentityPresent: safePreflightBoolean(inspected.unionIdentityPresent),
        appIdentityPresent: safePreflightBoolean(inspected.appIdentityPresent),
        qualificationAdapterReady: true,
        verificationPresentationReady: safePreflightBoolean(compatibility.verificationPresentationReady),
        failureStage: null,
        verificationExportShape: compatibility.verificationExportShape ?? null,
        observedAt: inspected.observedAt
      }
    });
  } catch (error) {
    const details = error?.details && typeof error.details === "object" ? error.details : {};
    persistCollectionBackstagePreflight({
      runId,
      outcome: "failed",
      evidence: {
        ...baseEvidence,
        observedMarketRegion: safePreflightMarketRegion(details.observedMarketRegion),
        regionMatched: false,
        accountAvailable: safePreflightBoolean(details.accountAvailable),
        accountIdentityPresent: safePreflightBoolean(details.accountIdentityPresent),
        unionIdentityPresent: safePreflightBoolean(details.unionIdentityPresent),
        appIdentityPresent: safePreflightBoolean(details.appIdentityPresent),
        qualificationAdapterReady: safePreflightBoolean(details.qualificationAdapterReady),
        verificationPresentationReady: safePreflightBoolean(details.verificationPresentationReady),
        failureStage: typeof details.failureStage === "string" ? details.failureStage : null,
        verificationExportShape: Array.isArray(details.verificationExportShape)
          ? details.verificationExportShape : null,
        errorCode: safeErrorCode(error, "COLLECTION_BACKSTAGE_PREFLIGHT_UNAVAILABLE")
      }
    });
    throw error;
  }
}

async function readSession(target) {
  const browser = await sessions.status(target);
  const readiness = isRoutedTarget(target) ? { collectionReadiness: await collectionReadiness() } : {};
  if (browser.mode === "manual_login") {
    return {
      target,
      ...readiness,
      state: "manual_login_in_progress",
      authenticated: null,
      requiresUserAction: true,
      message: "请在普通 Chrome 中完成登录并保持窗口打开，然后显式执行 check_login",
      browser
    };
  }
  if (browser.mode === "manual_login_owner_unverified") {
    return {
      target,
      ...readiness,
      state: "manual_login_owner_unverified",
      authenticated: null,
      requiresUserAction: true,
      message: "专用 Chrome 的进程身份无法安全核验；状态查询不会强行连接",
      browser
    };
  }
  if (browser.mode === "agent_attached" || browser.mode === "agent_controlled") {
    return {
      target,
      ...readiness,
      state: "running_unchecked",
      authenticated: null,
      requiresUserAction: false,
      message: "浏览器会话正在运行；状态查询不会导航或推进登录流程",
      browser
    };
  }
  return {
    target,
    ...readiness,
    state: "stopped",
    authenticated: null,
    requiresUserAction: true,
    message: browser.reopenRequired ? "普通 Chrome 已关闭，可重新执行 start_login 且不会删除登录资料" : "登录浏览器尚未启动",
    browser
  };
}

function normalizeCandidate(prospect) {
  const observation = prospect.latestDiscoveryObservation ?? prospect.latestObservation ?? {};
  const qualificationObservation = prospect.latestQualificationObservation ?? {};
  const data = { ...(prospect.data ?? {}), ...(observation.data ?? {}) };
  const observedRun = observation.runId && observation.source === "tiktok_live"
    ? database.getRun(observation.runId)
    : null;
  const qualificationData = qualificationObservation.data ?? {};
  const manualQualificationImported = qualificationData.qualificationReason?.importMode === "manual_import";
  const backstageQualification = qualificationObservation.invitationEligibility
    ? {
        status: qualificationObservation.invitationEligibility,
        reason: qualificationData.qualificationReason ?? null,
        observedAt: qualificationObservation.observedAt ?? null,
        source: qualificationObservation.source ?? null
      }
    : null;
  const followerCount = observation.followers ?? prospect.followers ?? null;
  const diamondValues = {
    current: data.diamondCurrent ?? null,
    period: data.diamondPeriod ?? null,
    rankingRecord: data.diamondRankingRecord ?? null,
    historicalMax: data.diamondHistoricalMax ?? null
  };
  const diamondFieldUnits = data.diamondFieldUnits
    && typeof data.diamondFieldUnits === "object"
    && !Array.isArray(data.diamondFieldUnits)
    ? data.diamondFieldUnits
    : {};
  const scoreFieldUnits = data.scoreFieldUnits
    && typeof data.scoreFieldUnits === "object"
    && !Array.isArray(data.scoreFieldUnits)
    ? data.scoreFieldUnits
    : {};
  const rawHandle = String(prospect.handle ?? "").trim().replace(/^@+/, "");
  const rawProfileUrl = prospect.profileUrl ?? data.profileUrl;
  const safeProfileUrl = typeof rawProfileUrl === "string"
    && rawProfileUrl !== "[REDACTED_URL]"
    ? sanitizeTikTokUrl(rawProfileUrl)
    : null;
  const profileUrl = safeProfileUrl && safeProfileUrl !== "[REDACTED_URL]"
    ? safeProfileUrl
    : (/^[a-z\d._]{1,64}$/i.test(rawHandle)
      ? `https://www.tiktok.com/@${encodeURIComponent(rawHandle)}`
      : null);
  return {
    candidateId: prospect.candidateId,
    userId: prospect.userId ?? null,
    secUid: prospect.secUid ?? null,
    handle: prospect.handle ?? null,
    displayName: prospect.displayName ?? data.displayName ?? null,
    profileUrl,
    roomId: observation.roomId ?? prospect.roomId ?? null,
    region: observation.region ?? prospect.region ?? data.region ?? null,
    marketRegion: observation.marketRegion ?? prospect.marketRegion ?? data.marketRegion ?? null,
    routeCountry: data.routeCountry ?? null,
    routeProfileId: data.routeProfileId ?? null,
    proxyExitCountry: data.proxyExitCountry ?? null,
    routeFingerprint: data.routeFingerprint ?? null,
    routeConfigurationFingerprint: data.routeConfigurationFingerprint ?? null,
    routeVerifiedAt: data.routeVerifiedAt ?? null,
    backstageCountry: data.backstageCountry ?? null,
    backstageCountryEvidence: data.backstageCountryEvidence ?? null,
    workId: Number.isInteger(data.workId) ? data.workId : null,
    collectionLaneEvidence: data.collectionLaneEvidence ?? null,
    creatorCountryCode: observation.creatorCountryCode
      ?? prospect.creatorCountryCode
      ?? data.creatorCountryCode
      ?? data.countryCode
      ?? data.regionCode
      ?? null,
    // Backward-compatible alias. This is creator evidence, never the proxy country.
    countryCode: observation.creatorCountryCode
      ?? prospect.creatorCountryCode
      ?? data.creatorCountryCode
      ?? data.countryCode
      ?? data.regionCode
      ?? null,
    followerCount,
    viewerCount: data.viewerCount ?? data.liveViewerCount ?? null,
    live: observation.live ?? prospect.live ?? null,
    seller: observation.seller ?? prospect.seller ?? null,
    highQuality: observation.highQuality ?? prospect.highQuality ?? null,
    liveTag: data.liveTag ?? null,
    rank: observation.rank ?? prospect.rank ?? data.ranking ?? null,
    rankScoreRaw: data.rankScoreRaw ?? null,
    rankScoreType: data.rankScoreType ?? null,
    rankScoreUnit: data.rankScoreUnit ?? null,
    rankingPeriod: data.rankingPeriod ?? null,
    rankingSubtab: data.rankingSubtab ?? null,
    rankingCountdownSeconds: data.rankingCountdownSeconds ?? null,
    rankingSource: data.rankingSource ?? null,
    rankingProvider: data.rankingProvider ?? null,
    rankingRequestId: data.rankingRequestId ?? null,
    rankingContextCountryCode: data.rankingContextCountryCode ?? null,
    rankingClassType: data.rankingClassType ?? null,
    rankingObservedAt: data.rankingObservedAt ?? null,
    rankingScopeMarketRegion: data.rankingScopeMarketRegion ?? null,
    rankingScopeCountryCode: data.rankingScopeCountryCode ?? null,
    rankingScopeCountryEvidence: data.rankingScopeCountryEvidence ?? null,
    rankTypeCode: data.rankTypeCode ?? null,
    regionTypeCode: data.regionTypeCode ?? null,
    gapInterval: data.gapInterval ?? null,
    rankingViewKind: data.rankingViewKind ?? null,
    adapterEvidenceVersion: data.adapterEvidenceVersion ?? null,
    rankingObservations: Array.isArray(data.rankingObservations) ? data.rankingObservations : [],
    currentScore: data.currentScore ?? data.diamondCurrent ?? null,
    topScore: data.topScore ?? null,
    historyRankScore: data.historyRankScore ?? null,
    hotListScore: data.hotListScore ?? null,
    rankRecordScore: data.rankRecordScore ?? null,
    rankingScore: data.rankingScore ?? null,
    scoreFieldUnits: {
      currentScore: scoreFieldUnits.currentScore ?? null,
      topScore: scoreFieldUnits.topScore ?? null,
      historyRankScore: scoreFieldUnits.historyRankScore ?? null,
      hotListScore: scoreFieldUnits.hotListScore ?? null,
      rankRecordScore: scoreFieldUnits.rankRecordScore ?? null,
      rankingScore: scoreFieldUnits.rankingScore ?? null
    },
    topCode: data.topCode ?? null,
    rankingLabel: data.rankingLabel ?? null,
    originalRankingCountdownSeconds: data.originalRankingCountdownSeconds ?? null,
    originalScoreEvidence: data.originalScoreEvidence ?? null,
    diamondCurrent: data.diamondCurrent ?? null,
    diamondPeriod: data.diamondPeriod ?? null,
    diamondRankingRecord: data.diamondRankingRecord ?? null,
    diamondHistoricalMax: data.diamondHistoricalMax ?? null,
    diamondFieldUnits: {
      current: diamondFieldUnits.current ?? null,
      period: diamondFieldUnits.period ?? null,
      rankingRecord: diamondFieldUnits.rankingRecord ?? null,
      historicalMax: diamondFieldUnits.historicalMax ?? null
    },
    diamondUsdEstimates: Object.fromEntries(
      Object.entries(diamondValues).map(([key, value]) => [
        key,
        deriveDiamondUsdEstimateForEvidence(value, diamondFieldUnits[key])
      ])
    ),
    expectedInvitationLane: deriveExpectedInvitationLane(followerCount).expectedInvitationLane,
    liveDurationMinutes: data.liveDurationMinutes ?? null,
    liveTime: data.liveTime ?? null,
    creatorLevel: data.creatorLevel ?? null,
    dataProcessorStatus: data.dataProcessorStatus ?? null,
    dataProcessorComplete: data.dataProcessorComplete ?? null,
    dataProcessorReason: data.dataProcessorReason ?? null,
    dataProcessorStages: Array.isArray(data.dataProcessorStages) ? data.dataProcessorStages : [],
    dataProcessorEvidenceVersion: data.dataProcessorEvidenceVersion ?? null,
    workflowMode: data.workflowMode ?? null,
    qualificationQueryState: manualQualificationImported
      ? "manual_imported"
      : data.qualificationQueryState ?? null,
    automaticQualificationPerformed: typeof data.automaticQualificationPerformed === "boolean"
      ? data.automaticQualificationPerformed
      : null,
    source: observation.source ?? prospect.latestSource ?? null,
    discoveryMethod: data.discoveryMethod
      ?? (observedRun?.source === "tiktok_live"
        ? observedRun.filters?.discoveryMethod ?? "regional_gift_ranking"
        : null),
    sourceUrl: observation.sourceUrl ?? data.sourceUrl ?? null,
    // Only the dedicated collection sub-backend may authoritatively classify
    // invitation eligibility. Discovery/legacy hints remain separate below.
    qualificationStatus: qualificationObservation.invitationEligibility ?? null,
    qualificationReason: qualificationData.qualificationReason ?? null,
    legacyQualification: data.legacyQualification ?? null,
    backstageQualification,
    qualificationObservedAt: qualificationObservation.observedAt ?? null,
    qualificationSource: qualificationObservation.source ?? null,
    qualificationProvenance: qualificationData.qualificationReason?.provenance ?? null,
    qualificationRunId: qualificationObservation.runId ?? null,
    qualificationConfidence: qualificationObservation.confidence ?? null,
    observedAt: observation.observedAt ?? prospect.lastSeenAt ?? null,
    confidence: observation.confidence ?? data.confidence ?? null,
    evidence: observation.evidence ?? null,
    firstSeenAt: prospect.firstSeenAt,
    lastSeenAt: prospect.lastSeenAt
  };
}

function queryCandidateSet(filters = {}) {
  const requestedLimit = Math.min(2_000, Math.max(1, Number(filters.limit ?? 100)));
  const requestedOffset = Math.max(0, Number(filters.offset ?? 0));
  let candidates = database.queryProspects({
    runId: filters.runId,
    candidateIds: filters.candidateIds,
    source: filters.source,
    region: filters.region,
    minFollowers: filters.minFollowers,
    maxFollowers: filters.maxFollowers,
    limit: 2_000,
    offset: 0
  }).map(normalizeCandidate);
  if (filters.marketRegion) candidates = candidates.filter((item) => item.marketRegion === String(filters.marketRegion).toUpperCase());
  if (filters.routeCountry) candidates = candidates.filter((item) => item.routeCountry === String(filters.routeCountry).toUpperCase());
  const creatorCountryCode = filters.creatorCountryCode ?? filters.countryCode;
  if (creatorCountryCode) candidates = candidates.filter((item) => item.creatorCountryCode === String(creatorCountryCode).toUpperCase());
  if (filters.qualificationStatus) candidates = candidates.filter((item) => item.qualificationStatus === filters.qualificationStatus);
  // An invitable TikTok row is valid only when the dedicated collection
  // backstage authored the latest qualification observation. This protects
  // restart initialization and exact queries from legacy or synthetic
  // `available` flags that have no official provenance.
  if (filters.qualificationStatus === "available") {
    candidates = candidates.filter((item) => item.qualificationSource === "collection_backstage");
  }
  const total = candidates.length;
  return {
    total,
    truncatedByStoreLimit: total === 2_000,
    candidates: candidates.slice(requestedOffset, requestedOffset + requestedLimit)
  };
}

function startupInventoryStatus() {
  const candidates = queryCandidateSet({ limit: 2_000, offset: 0 });
  const availableCandidates = queryCandidateSet({
    source: "tiktok_live",
    qualificationStatus: "available",
    limit: 2_000,
    offset: 0
  });
  const pendingHandoffs = database.listPendingHandoffs({ limit: 50, offset: 0 });
  const resumableRuns = database.listRuns({ limit: 100, offset: 0 }).filter((run) => (
    ["paused", "partial"].includes(run.status) && !activeRuns.has(run.runId)
  ));
  return buildStartupInventory({
    candidates,
    availableCandidates,
    pendingHandoffs,
    resumableRuns
  });
}

const CANDIDATE_QUERY_FILTERS = new Set([
  "runId",
  "source",
  "region",
  "marketRegion",
  "routeCountry",
  "creatorCountryCode",
  "countryCode",
  "minFollowers",
  "maxFollowers",
  "qualificationStatus",
  "limit",
  "offset"
]);

function candidateQueryFilters(params = {}) {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw rpcError("候选筛选条件必须是对象", "invalid_candidate_filters");
  }
  const unsupported = Object.keys(params).filter((key) => !CANDIDATE_QUERY_FILTERS.has(key)).sort();
  if (unsupported.length) {
    throw rpcError(
      "候选查询只接受版本化筛选字段",
      "unsupported_candidate_filter",
      { fields: unsupported.map((value) => sanitizeTikTokText(value)) }
    );
  }
  return Object.fromEntries(Object.entries(params).map(([key, value]) => [
    key,
    typeof value === "string" ? sanitizeTikTokText(value).slice(0, 300) : value
  ]));
}

function databaseProspectInput(candidate, runId, source, {
  runFilters = {},
  verifiedRoute = null,
  runConfig = {}
} = {}) {
  const legacyLive = candidate.live && typeof candidate.live === "object" ? candidate.live : null;
  const diamonds = candidate.diamonds && typeof candidate.diamonds === "object" ? candidate.diamonds : null;
  const qualification = candidate.qualification && typeof candidate.qualification === "object" ? candidate.qualification : null;
  const routeDetails = verifiedRoute ? dualRouteDetails(verifiedRoute) : null;
  const candidateLane = verifiedRoute ? countryLaneForCandidate(verifiedRoute, candidate) : null;
  const routeEvidence = verifiedRoute
    ? {
        routeProfileId: verifiedRoute.routeProfileId,
        routeCountry: candidateLane?.countryCode ?? null,
        backstageCountry: candidateLane?.countryCode ?? null,
        proxyExitCountry: candidateLane?.proxyExitCountry ?? null,
        collectionCountryCodes: routeDetails?.collectionCountryCodes ?? [],
        collectionProxyExitCountries: routeDetails?.collectionProxyExitCountries ?? null,
        routeFingerprint: runConfig.routeFingerprint ?? runtimeRouteFingerprint(verifiedRoute),
        routeConfigurationFingerprint: runConfig.routeConfigurationFingerprint ?? verifiedRoute.proxyFingerprint,
        routeVerifiedAt: verifiedRoute.verifiedAt,
        backstageCountryEvidence: candidateLane ? "candidate_work_id_country_lane" : null
      }
    : null;
  const data = {
    discoveryMethod: source === "tiktok_live" ? runFilters.discoveryMethod ?? "regional_gift_ranking" : null,
    workflowMode: candidate.workflowMode ?? null,
    qualificationQueryState: candidate.qualificationQueryState ?? null,
    automaticQualificationPerformed: typeof candidate.automaticQualificationPerformed === "boolean"
      ? candidate.automaticQualificationPerformed
      : null,
    marketRegion: verifiedRoute?.marketRegion ?? runFilters.marketRegion ?? runFilters.region ?? null,
    routeCountry: routeEvidence?.routeCountry ?? null,
    routeProfileId: routeEvidence?.routeProfileId ?? null,
    proxyExitCountry: routeEvidence?.proxyExitCountry ?? null,
    routeFingerprint: routeEvidence?.routeFingerprint ?? null,
    routeConfigurationFingerprint: routeEvidence?.routeConfigurationFingerprint ?? null,
    routeVerifiedAt: routeEvidence?.routeVerifiedAt ?? null,
    backstageCountry: routeEvidence?.backstageCountry ?? null,
    backstageCountryEvidence: routeEvidence?.backstageCountryEvidence ?? null,
    workId: Number.isInteger(candidate.workId) ? candidate.workId : null,
    collectionLaneEvidence: candidate.collectionLaneEvidence ?? null,
    collectionCountryCodes: routeEvidence?.collectionCountryCodes ?? null,
    collectionProxyExitCountries: routeEvidence?.collectionProxyExitCountries ?? null,
    creatorCountryCode: candidate.creatorCountryCode ?? candidate.countryCode ?? null,
    countryCode: candidate.creatorCountryCode ?? candidate.countryCode ?? null,
    viewerCount: candidate.viewerCount ?? null,
    liveTag: candidate.liveTag ?? legacyLive?.tagId ?? null,
    liveDurationMinutes: candidate.liveDurationMinutes ?? legacyLive?.durationMinutes ?? null,
    creatorLevel: candidate.creatorLevel ?? legacyLive?.level ?? null,
    liveTime: candidate.liveTime ?? null,
    currentScore: candidate.currentScore ?? candidate.diamondCurrent ?? null,
    topScore: candidate.topScore ?? null,
    historyRankScore: candidate.historyRankScore ?? null,
    hotListScore: candidate.hotListScore ?? null,
    rankRecordScore: candidate.rankRecordScore ?? null,
    rankingScore: candidate.rankingScore ?? null,
    scoreFieldUnits: candidate.scoreFieldUnits ?? null,
    topCode: candidate.topCode ?? null,
    rankingLabel: candidate.rankingLabel ?? null,
    originalRankingCountdownSeconds: candidate.originalRankingCountdownSeconds ?? null,
    originalScoreEvidence: candidate.originalScoreEvidence ?? null,
    discoverySourceKinds: Array.isArray(candidate.discoverySourceKinds)
      ? candidate.discoverySourceKinds
      : [],
    mobileTemplateEvidence: candidate.mobileTemplateEvidence ?? null,
    dataProcessorStatus: candidate.dataProcessorStatus ?? null,
    dataProcessorComplete: candidate.dataProcessorComplete ?? null,
    dataProcessorReason: candidate.dataProcessorReason ?? null,
    dataProcessorStages: candidate.dataProcessorStages ?? [],
    dataProcessorEvidenceVersion: candidate.dataProcessorEvidenceVersion ?? null,
    diamondCurrent: candidate.diamondCurrent ?? diamonds?.current ?? null,
    diamondPeriod: candidate.diamondPeriod ?? diamonds?.ranking ?? null,
    diamondRankingRecord: candidate.diamondRankingRecord ?? diamonds?.rankingRecord ?? null,
    diamondHistoricalMax: candidate.diamondHistoricalMax ?? diamonds?.historicalHighest ?? null,
    diamondFieldUnits: candidate.diamondFieldUnits ?? (source === "svip_legacy"
      ? {
          current: "unknown_rank_score",
          period: "unknown_rank_score",
          rankingRecord: "unknown_rank_score",
          historicalMax: "unknown_rank_score"
        }
      : null),
    legacyQualification: source === "svip_legacy" ? qualification : null,
    qualificationStatus: candidate.qualificationStatus ?? qualification?.status ?? null,
    qualificationReason: candidate.qualificationReason ?? (qualification ? { code: qualification.code, eligible: qualification.eligible } : null),
    discovery: candidate.discovery ?? null,
    sourceUrl: candidate.sourceUrl ?? null,
    legacyRecord: candidate.legacy ?? null,
    raw: candidate.raw ?? null,
    rankScoreRaw: candidate.rankScoreRaw ?? candidate.rankEvidence?.scoreRaw ?? null,
    rankScoreType: candidate.rankScoreType ?? candidate.rankEvidence?.scoreType ?? null,
    rankScoreUnit: candidate.rankScoreUnit ?? null,
    rankingPeriod: candidate.rankingPeriod ?? candidate.period ?? candidate.rankEvidence?.period ?? null,
    rankingSubtab: candidate.rankingSubtab ?? candidate.subtab ?? candidate.rankEvidence?.subtab ?? null,
    rankingCountdownSeconds: candidate.rankingCountdownSeconds ?? candidate.countdown ?? candidate.rankEvidence?.countdown ?? null,
    rankingSource: candidate.rankEvidence?.source ?? candidate.source ?? null,
    rankingProvider: candidate.rankingProvider ?? null,
    rankingRequestId: candidate.rankingRequestId ?? null,
    rankingContextCountryCode: candidate.rankingContextCountryCode ?? null,
    rankingClassType: candidate.rankingClassType ?? null,
    rankingObservedAt: candidate.rankEvidence?.observedAt ?? candidate.observedAt ?? null,
    rankingScopeMarketRegion: candidate.rankingScopeMarketRegion ?? null,
    rankingScopeCountryCode: candidate.rankingScopeCountryCode ?? null,
    rankingScopeCountryEvidence: candidate.rankingScopeCountryEvidence ?? null,
    rankTypeCode: candidate.rankTypeCode ?? candidate.rankEvidence?.rankTypeCode ?? null,
    regionTypeCode: candidate.regionTypeCode ?? candidate.rankEvidence?.regionTypeCode ?? null,
    gapInterval: candidate.gapInterval ?? candidate.rankEvidence?.gapInterval ?? null,
    rankingViewKind: candidate.rankingViewKind ?? candidate.rankEvidence?.rankingViewKind ?? null,
    adapterEvidenceVersion: candidate.adapterEvidenceVersion
      ?? candidate.rankEvidence?.adapterEvidenceVersion
      ?? null,
    rankingObservations: Array.isArray(candidate.rankingObservations)
      ? candidate.rankingObservations
      : []
  };
  return {
    candidateId: candidate.candidateId ?? undefined,
    userId: candidate.userId ?? candidate.tiktokUserId ?? null,
    secUid: candidate.secUid ?? null,
    handle: candidate.handle,
    displayName: candidate.displayName ?? candidate.name ?? null,
    profileUrl: candidate.profileUrl ?? null,
    roomId: candidate.roomId ?? null,
    region: candidate.region ?? candidate.country ?? null,
    marketRegion: verifiedRoute?.marketRegion ?? runFilters.marketRegion ?? runFilters.region ?? null,
    creatorCountryCode: candidate.creatorCountryCode ?? candidate.countryCode ?? null,
    followers: candidate.followerCount ?? candidate.followers ?? null,
    live: typeof candidate.live === "boolean" ? candidate.live : null,
    seller: candidate.seller ?? null,
    highQuality: candidate.highQuality ?? null,
    rank: candidate.rank ?? null,
    invitationEligibility: candidate.qualificationStatus ?? candidate.invitationEligibility ?? qualification?.status ?? null,
    observedAt: candidate.observedAt ?? new Date().toISOString(),
    source,
    runId,
    data,
    observation: {
      runId,
      source,
      sourceUrl: candidate.sourceUrl ?? null,
      observedAt: candidate.observedAt ?? new Date().toISOString(),
      region: candidate.region ?? candidate.country ?? null,
      marketRegion: verifiedRoute?.marketRegion ?? runFilters.marketRegion ?? runFilters.region ?? null,
      creatorCountryCode: candidate.creatorCountryCode ?? candidate.countryCode ?? null,
      followerCount: candidate.followerCount ?? candidate.followers ?? null,
      live: typeof candidate.live === "boolean" ? candidate.live : null,
      seller: candidate.seller ?? null,
      highQuality: candidate.highQuality ?? null,
      invitationEligibility: candidate.qualificationStatus ?? candidate.invitationEligibility ?? qualification?.status ?? null,
      rank: candidate.rank ?? null,
      roomId: candidate.roomId ?? null,
      confidence: candidate.confidence ?? candidate.evidence?.confidence ?? null,
      data,
      evidence: candidate.rawEvidence ?? candidate.rankEvidence ?? candidate.evidence ?? null
    }
  };
}

function compactAdapterResult(result) {
  if (!result || typeof result !== "object") return result;
  const { items: _items, candidates: _candidates, ...summary } = result;
  return summary;
}

function adapterFilters(source, filters = {}) {
  if (source !== "svip_legacy") return filters;
  const qualificationCodes = {
    regular_invitation: "3",
    advanced_invitation: "4",
    associated_account: "5",
    insufficient_duration: "6",
    not_queried: "10"
  };
  const output = {
    region: filters.region ?? "",
    regioncode: filters.countryCode || undefined,
    zb_name: filters.query || undefined,
    zb_liveTag: filters.liveTag === undefined ? [] : [filters.liveTag],
    zb_yqType: (filters.qualificationStatuses ?? []).map((value) => qualificationCodes[value] ?? String(value))
  };
  if (filters.minFollowers !== undefined || filters.maxFollowers !== undefined) {
    output.zb_fan = [{ min: filters.minFollowers ?? "", max: filters.maxFollowers ?? "" }];
  }
  if (filters.recordedAfter !== undefined || filters.recordedBefore !== undefined) {
    output.zb_date = [{ min: filters.recordedAfter ?? "", max: filters.recordedBefore ?? "" }];
  }
  return output;
}

async function collectTikTokRegionalGiftRanking({
  runId, filters = {}, verifiedRoute, maxCandidates = null,
  onBatch, onProgress, shouldStop, control, receivedCount, workflowPolicy
}) {
  const marketRegion = String(filters.marketRegion ?? filters.region ?? "").trim().toUpperCase();
  const selectedLanes = selectedOriginalCountryLanes({ route: dualRouteDetails(verifiedRoute), filters });
  const laneForCandidate = (route, candidate, country) => {
    const lane = countryLaneForCandidate(route, candidate, country);
    return lane ? { ...lane, displayName: selectedLanes.find(item => item.countryCode === lane.countryCode)?.displayName } : null;
  };
  return runOriginalCollectorWithSessions({
    sessions, database, runId, selectedLanes, verifiedRoute, marketRegion, filters,
    maxCandidates: Number.isFinite(maxCandidates) ? maxCandidates : null,
    maxFeedRounds: filters.maxFeedRounds ?? (filters.calibrationProbe === true ? 10 : null),
    receivedCount, shouldStop, onBatch, onProgress,
    fetchFeedOnce: request => liveFeedTransport.fetchOnce(request),
    fetchCountryTemplatesOnce: request => rankingTransport.fetchOriginalCountryTemplateBundle(request),
    laneForCandidate,
    enrichOnce: request => dataEnrichmentTransport.enrichOnce(request),
    qualifyReady: workflowPolicy.automaticQualification
      ? ({ sourceComplete }) => autoQualifyRun(runId, control, { sourceComplete }) : null,
    expandReady: workflowPolicy.recursiveRankingExpansion
      ? () => expandQualifiedRankingSeeds({ runId, control, verifiedRoute, filters, maxCandidates: Number.isFinite(maxCandidates) ? maxCandidates : Infinity, receivedCount, onBatch, onProgress }) : null
  });
}

async function collectTikHubRankings({ runId, filters, maxCandidates, onBatch, onProgress, shouldStop }) {
  const run = requiredRun(runId);
  return collectTikHubRankingSnapshots({
    transport: tikHubRankingTransport, seeds: run.config?.tikhubRankingSeeds,
    rankingKind: filters.tikHubRankingKind, rankingPeriod: filters.tikHubRankingPeriod,
    // This is the total durable run cap; committed checkpoints already count.
    maxCandidates: run.filters.maxCandidates, filters,
    checkpoint: database.getCheckpoint(runId, 'tikhub_snapshots', { adapter: 'tikhub_rankings' })?.value ?? {},
    saveCheckpoint: value => database.saveCheckpoint(runId, 'tikhub_snapshots', value, { adapter: 'tikhub_rankings' }),
    onBatch, onProgress, shouldStop
  });
}

async function expandQualifiedRankingSeeds({
  runId,
  control,
  verifiedRoute,
  filters = {},
  maxCandidates,
  receivedCount,
  onBatch,
  onProgress
}) {
  const marketRegion = String(verifiedRoute?.marketRegion ?? "").trim().toUpperCase();
  const selectedCountryCodes = requestedCountryCodes(filters);
  const dualRoute = dualRouteDetails(verifiedRoute);
  if (!dualRoute
    || selectedCountryCodes.some((countryCode) => !dualRoute.collectionCountryCodes.includes(countryCode))
    || dualRoute.collectionLanes.some((lane) => lane.proxyExitCountry !== lane.countryCode)) {
    return { complete: false, found: 0, stoppedReason: "collection_route_mismatch" };
  }
  const qualifiedCandidates = queryCandidateSet({
    runId,
    qualificationStatus: "available",
    limit: 2_000,
    offset: 0
  }).candidates;
  return resumeOriginalDueRankingSeeds({
    database,
    runId,
    qualifiedCandidates,
    verifiedRoute,
    marketRegion,
    selectedCountryCodes,
    filters,
    maxCandidates,
    receivedCount,
    laneForCandidate: (route, candidate, country) => {
      const lane = countryLaneForCandidate(route, candidate, country);
      const selected = selectedOriginalCountryLanes({ route: dualRouteDetails(route), filters });
      return lane ? { ...lane, displayName: selected.find(item => item.countryCode === lane.countryCode)?.displayName } : null;
    },
    rankingTransport,
    enrichOnce: (request) => dataEnrichmentTransport.enrichOnce(request),
    onBatch,
    onProgress,
    shouldStop: () => Boolean(control.requested)
  });
}

async function executeRun(runId, control) {
  let run = requiredRun(runId);
  const target = sourceTarget(run.source);
  const workflowPolicy = discoveryWorkflowPolicy(run);
  let verifiedRunRoute = null;
  let received = run.received ?? 0;
  let created = run.new ?? 0;
  let duplicate = run.duplicate ?? 0;
  try {
    // A run is single-owner inside this daemon. Any processing lease left by a
    // previous process belongs to an interrupted attempt and is safe to make
    // pending before checkpoint resume.
    database.releaseRunDiscoverySeedLeases(runId);
    database.updateRun(runId, { status: "starting", error: null });
    if (workflowPolicy.requiresVerifiedRoute) {
      const route = requiredCollectionRoute(run.config?.routeProfileId, { verified: true });
      assertRunRoute(run, route);
      verifiedRunRoute = route;
      for (const routedTarget of workflowPolicy.requiredRouteSessionTargets) {
        const state = await routedSessionState(routedTarget, route);
        if (!state.status.running) {
          throw rpcError(
            `${SESSION_TARGET_NAMES.includes(routedTarget) ? routedTarget : "采集"} 登录窗口尚未启动`,
            "authentication_required",
            { target: routedTarget }
          );
        }
        if (state.restartRequired) {
          throw rpcError(
            "现有 TikTok 窗口未绑定其对应的已验证线路；请关闭对应窗口后重新打开",
            "collection_route_restart_required",
            { target: routedTarget, route: publicRoute(route) }
          );
        }
      }
    }
    const login = await inspectSession(target);
    if (login.state !== "authenticated") {
      database.updateRun(runId, {
        status: awaitingStatus(target, login.state),
        error: { code: sanitizeTikTokText(login.state), message: sanitizeTikTokText(login.message) }
      });
      return;
    }
    if (workflowPolicy.automaticQualification) {
      const backstageLogin = await inspectSession("collection_backstage");
      if (backstageLogin.state !== "authenticated") {
        throw rpcError(
          backstageLogin.message,
          backstageLogin.state,
          { target: "collection_backstage" }
        );
      }
    }
    database.updateRun(runId, { status: "navigating" });
    const checkpoint = database.getCheckpoint(runId, "position", { adapter: run.source })?.value ?? {};
    const seenInRun = new Set();
    for (let offset = 0; ; offset += 2_000) {
      const page = database.queryProspects({ runId, limit: 2_000, offset });
      page.forEach(prospect => seenInRun.add(prospect.candidateId));
      if (page.length < 2_000) break;
    }
    const configuredCandidateLimit = run.filters?.maxCandidates === undefined && workflowPolicy.regional
      ? Infinity : Math.max(1, Number(run.filters?.maxCandidates ?? 100));
    const onBatch = (batch) => {
      const items = Array.isArray(batch) ? batch : (batch?.items ?? []);
      for (const rawCandidate of items) {
        if (received >= configuredCandidateLimit) break;
        const candidate = sanitizeTikTokValue(attachDiscoveryWorkflowEvidence(
          rawCandidate,
          workflowPolicy
        ));
        const saved = database.upsertProspect(databaseProspectInput(candidate, runId, run.source, {
          runFilters: run.filters ?? {},
          verifiedRoute: verifiedRunRoute,
          runConfig: run.config ?? {}
        }));
        if (!seenInRun.has(saved.prospect.candidateId)) {
          seenInRun.add(saved.prospect.candidateId);
          received += 1;
          if (saved.created) created += 1;
          else duplicate += 1;
        }
      }
      if (!Array.isArray(batch) && batch?.checkpoint) {
        database.saveCheckpoint(runId, "position", sanitizeTikTokValue(batch.checkpoint), { adapter: run.source });
      }
      database.updateRun(runId, { received, new: created, duplicate });
    };
    const onProgress = async (progress) => {
      const safeProgress = sanitizeTikTokValue(progress);
      if (safeProgress.checkpoint || run.source !== "svip_legacy") {
        database.saveCheckpoint(runId, "position", safeProgress.checkpoint ?? safeProgress, { adapter: run.source });
      }
      database.updateRun(runId, {
        status: "discovering",
        progress: safeProgress,
        expected: safeProgress.expected ?? safeProgress.reportedTotal ?? undefined,
        received,
        new: created,
        duplicate
      });
    };
    const shouldStop = () => Boolean(control.requested);
    if (workflowPolicy.requiresVerifiedRoute && isRoutedTarget(target)) {
      const currentRoute = requiredCollectionRoute(run.config?.routeProfileId, { verified: true });
      assertRunRoute(run, currentRoute);
      const routeState = await routedSessionState(target, currentRoute);
      if (routeState.restartRequired) {
        throw rpcError(
          "发现会话的代理线路已变化，已在读取页面前停止任务",
          "collection_route_restart_required",
          { target, route: publicRoute(currentRoute) }
        );
      }
    }
    const page = sessions.page(target);
    const remainingCandidateLimit = Math.max(0, configuredCandidateLimit - received);
    if (remainingCandidateLimit === 0) {
      const result = sanitizeTikTokValue({
        complete: false,
        selectionComplete: true,
        reason: "configured_candidate_limit_reached",
        completionScope: "configured_candidate_limit",
        configuredCandidateLimit,
        ...(workflowPolicy.workflowEvidence
          ? {
              workflow: workflowPolicy.workflowEvidence,
              rankingExpansionPending: false
            }
          : {})
      });
      if (workflowPolicy.automaticQualification) {
        database.updateRun(runId, {
          status: "qualifying",
          received,
          new: created,
          duplicate,
          result: { ...(run.result ?? {}), ...result, discovery: result },
          error: null
        });
        const qualification = await autoQualifyRun(runId, control);
        const refreshed = requiredRun(runId);
        const status = control.requested === "cancel"
          ? "cancelled"
          : control.requested === "pause"
            ? "paused"
            : qualification.complete ? "completed" : "partial";
        database.updateRun(runId, {
          status,
          result: {
            ...(refreshed.result ?? {}),
            fullAuto: qualification,
            ...(control.requested === "cancel"
              ? { cancellationReason: sanitizeTikTokText(control.reason) }
              : {})
          },
          error: null
        });
      } else {
        database.updateRun(runId, {
          status: "completed",
          received,
          new: created,
          duplicate,
          result,
          error: null
        });
      }
      appendAudit({ action: "discovery_run_finished", targetType: "run", targetId: runId, runId, details: { result, received, created, duplicate } });
      return;
    }
    const options = {
      runId,
      page,
      filters: adapterFilters(run.source, run.filters ?? {}),
      verifiedRoute: verifiedRunRoute,
      maxPages: run.filters?.maxPages ?? 20,
      maxCandidates: workflowPolicy.regional ? configuredCandidateLimit : remainingCandidateLimit,
      control, receivedCount: () => received, workflowPolicy,
      maxScrolls: run.filters?.maxScrolls ?? 20,
      startUrl: run.filters?.startUrl,
      pageSize: checkpoint?.pageSize ?? Math.min(1_000, configuredCandidateLimit),
      checkpoint,
      onBatch,
      onProgress,
      shouldStop
    };
    const discoveryMethod = workflowPolicy.discoveryMethod;
    const result = run.source === "svip_legacy"
      ? await collectSvipLegacy(options)
      : discoveryMethod === "public_live_cards"
        ? await collectTikTokLive(options)
        : discoveryMethod === 'tikhub_rankings'
          ? await collectTikHubRankings(options)
        : await collectTikTokRegionalGiftRanking(options);
    if (workflowPolicy.regional) {
      const current = requiredRun(runId);
      const resultSummary = sanitizeTikTokValue({
        ...compactAdapterResult(result),
        found: received,
        configuredCandidateLimit: Number.isFinite(configuredCandidateLimit) ? configuredCandidateLimit : null,
        selectedCountryCodes: requestedCountryCodes(run.filters),
        selectedDisplayNames: selectedOriginalCountryLanes({ route: dualRouteDetails(verifiedRunRoute), filters: run.filters }).map(lane => ({ countryCode: lane.countryCode, displayName: lane.displayName })),
        dataProcessorEvidenceVersion: TIKTOK_DATA_ENRICHMENT_PROFILE.adapterEvidenceVersion,
        adapterEvidenceVersion: "tksoft-v10-continuous-processors-v1",
        ...(workflowPolicy.workflowEvidence ? { workflow: workflowPolicy.workflowEvidence } : {})
      });
      database.updateRun(runId, {
        status: control.requested === "cancel" ? "cancelled" : control.requested === "pause" ? "paused" : "partial",
        received, new: created, duplicate,
        result: { ...(current.result ?? {}), ...resultSummary, qualification: current.result?.qualification ?? resultSummary.qualification, discovery: resultSummary,
          ...(control.requested === "cancel" ? { cancellationReason: sanitizeTikTokText(control.reason) } : {}) },
        error: null
      });
      appendAudit({ action: "discovery_run_finished", targetType: "run", targetId: runId, runId, details: { result: resultSummary, received, created, duplicate } });
      return;
    }
    if (result?.checkpoint) database.saveCheckpoint(runId, "position", sanitizeTikTokValue(result.checkpoint), { adapter: run.source });
    const configuredLimitReached = received >= configuredCandidateLimit || result?.selectionComplete === true;
    const sourceReconciled = result?.complete === true;
    const resultSummary = sanitizeTikTokValue({
      ...compactAdapterResult(result),
      configuredCandidateLimit,
      sourceReconciled,
      selectionComplete: configuredLimitReached || sourceReconciled,
      ...(workflowPolicy.workflowEvidence
        ? {
            workflow: workflowPolicy.workflowEvidence,
            rankingExpansionPending: false
          }
        : {}),
      completionScope: sourceReconciled
        ? workflowPolicy.tikHubRankings ? 'tikhub_snapshot_plan' : "source_reconciled"
        : configuredLimitReached
          ? "configured_candidate_limit"
          : run.source === "tiktok_live"
            ? discoveryMethod === "regional_gift_ranking"
              ? workflowPolicy.semiAutoRegional
                ? "bounded_semi_auto_data_processor"
                : "bounded_regional_gift_ranking"
              : "bounded_live_discovery"
            : "partial_source"
    });

    if (control.requested === "cancel") {
      database.updateRun(runId, {
        status: "cancelled",
        received,
        new: created,
        duplicate,
        result: { ...resultSummary, cancellationReason: sanitizeTikTokText(control.reason) }
      });
    } else if (control.requested === "pause") {
      database.updateRun(runId, { status: "paused", received, new: created, duplicate, result: resultSummary });
    } else if (workflowPolicy.automaticQualification) {
      database.updateRun(runId, {
        status: "qualifying",
        received,
        new: created,
        duplicate,
        result: { ...(requiredRun(runId).result ?? {}), ...resultSummary, discovery: resultSummary },
        error: null
      });
      let qualification = await autoQualifyRun(runId, control);
      const cascadeRounds = [];
      if (workflowPolicy.recursiveRankingExpansion) {
        while (!control.requested && qualification.complete && received < configuredCandidateLimit) {
          const expansion = await expandQualifiedRankingSeeds({
            runId,
            control,
            verifiedRoute: verifiedRunRoute,
            filters: run.filters ?? {},
            maxCandidates: configuredCandidateLimit,
            receivedCount: () => received,
            onBatch,
            onProgress
          });
          cascadeRounds.push(expansion);
          if (!expansion.complete || expansion.found === 0 || received >= configuredCandidateLimit) break;
          qualification = await autoQualifyRun(runId, control);
        }
      }
      const refreshed = requiredRun(runId);
      const selectionComplete = resultSummary.selectionComplete === true;
      const lastExpansion = cascadeRounds.at(-1) ?? null;
      const cascadeComplete = !workflowPolicy.recursiveRankingExpansion
        || (qualification.complete && (lastExpansion === null || lastExpansion.complete));
      const status = control.requested === "cancel"
        ? "cancelled"
        : control.requested === "pause"
          ? "paused"
          : qualification.complete && cascadeComplete && selectionComplete ? "completed" : "partial";
      database.updateRun(runId, {
        status,
        received,
        new: created,
        duplicate,
        result: {
          ...(refreshed.result ?? {}),
          fullAuto: {
            ...qualification,
            cascade: workflowPolicy.recursiveRankingExpansion
              ? {
                  implementation: "original_pcweb_live_ranking_loop",
                  complete: cascadeComplete,
                  rounds: cascadeRounds,
                  mobileSessionRequired: cascadeRounds.some(
                    (round) => round.mobileSessionRequired === true
                  )
                }
              : null
          },
          ...(control.requested === "cancel"
            ? { cancellationReason: sanitizeTikTokText(control.reason) }
            : {})
        },
        error: null
      });
    } else if (run.source === "svip_legacy" && !sourceReconciled && !configuredLimitReached) {
      database.updateRun(runId, { status: "partial", received, new: created, duplicate, result: resultSummary, error: null });
    } else if (workflowPolicy.semiAutoRegional
      && (Number(resultSummary.enrichmentUnresolved ?? 0) > 0
        || resultSummary.mobileTemplateComplete !== true)) {
      database.updateRun(runId, { status: "partial", received, new: created, duplicate, result: resultSummary, error: null });
    } else {
      database.updateRun(runId, { status: "completed", received, new: created, duplicate, result: resultSummary, error: null });
    }
    appendAudit({ action: "discovery_run_finished", targetType: "run", targetId: runId, runId, details: { result: resultSummary, received, created, duplicate } });
  } catch (error) {
    // A failed queue transaction also rolls back its run counters. Do not
    // publish the in-memory provisional counts after that rollback.
    const committed = requiredRun(runId);
    received = committed.received ?? received;
    created = committed.new ?? created;
    duplicate = committed.duplicate ?? duplicate;
    const errorCode = safeErrorCode(error, "run_failed");
    const errorMessage = safeErrorMessage(error);
    const errorDetails = sanitizeErrorDetails(error?.details ?? null);
    const waitingCodes = new Set([
      "authentication_required",
      "manual_verification",
      "stopped",
      "SVIP_AUTH_REQUIRED",
      "SVIP_LOGIN_EXPIRED"
    ]);
    const errorTarget = SESSION_TARGET_NAMES.includes(error?.details?.target)
      ? error.details.target
      : target;
    const collectorState = workflowPolicy.regional ? originalCollectorFailureState(errorCode) : null;
    const status = waitingCodes.has(errorCode) || collectorState === "authentication_required"
      ? awaitingStatus(errorTarget, errorCode === "manual_verification" ? errorCode : "authentication_required")
      : errorCode === "collection_route_restart_required" || collectorState === "paused"
        ? "paused"
      : errorCode === "capability_not_ready"
        ? "partial"
        : "failed";
    database.updateRun(runId, {
      status,
      received,
      new: created,
      duplicate,
      error: { code: errorCode, message: errorMessage, details: errorDetails }
    });
    appendAudit({ action: "discovery_run_error", targetType: "run", targetId: runId, runId, outcome: status, details: { code: errorCode, message: errorMessage } });
    console.error(`[run ${runId}] ${safeErrorStack(error)}`);
  } finally {
    activeRuns.delete(runId);
  }
}

async function startRun(runId) {
  if (shutdownRequested) {
    throw rpcError("守护进程正在安全关闭，请稍后重试", "daemon_shutting_down");
  }
  if (activeQualification?.phase === "startup_initialization") throw rpcError("启动初始化尚未完成", "startup_initialization_busy");
  const run = requiredRun(runId);
  const workflowPolicy = discoveryWorkflowPolicy(run);
  if (activeRuns.has(runId)) return { ...run, alreadyRunning: true };
  if (run.status === "completed" || run.status === "cancelled") {
    throw rpcError(`任务状态为 ${run.status}，不能再次启动`, "invalid_run_state");
  }
  const conflicting = [...activeRuns.entries()].find(([otherRunId]) => sourceTarget(requiredRun(otherRunId).source) === sourceTarget(run.source));
  if (conflicting) throw rpcError(`同一浏览器会话正在执行任务 ${conflicting[0]}`, "session_busy");
  if (workflowPolicy.automaticQualification) {
    const activeFullAuto = [...activeRuns.keys()].find(
      (activeRunId) => requiredRun(activeRunId).mode === "full_auto"
    );
    if (activeFullAuto) {
      throw rpcError(`已有全自动任务 ${activeFullAuto} 正在占用采集子后台`, "collection_backstage_busy");
    }
  }
  const target = sourceTarget(run.source);
  let route = null;
  if (workflowPolicy.requiresVerifiedRoute) {
    if (workflowPolicy.automaticQualification && activeQualification) {
      throw rpcError(
        `采集子后台正在执行批次 ${activeQualification.batchId}`,
        "collection_backstage_busy"
      );
    }
    route = requiredCollectionRoute(run.config?.routeProfileId, { verified: true });
    assertRunRoute(run, route);
  }

  // Acquire the run lease before the first await. This closes the start/resume
  // race for the same run, the same discovery session, and the shared
  // collection-backstage qualifier.
  const control = { requested: null, reason: null, phase: "starting", promise: null };
  activeRuns.set(runId, control);
  database.updateRun(runId, { status: "starting", error: null, finishedAt: null });
  try {
    if (workflowPolicy.requiresVerifiedRoute) {
      route = await revalidateDualRouteEgress(route);
      assertRunRoute(run, route);
      for (const routedTarget of workflowPolicy.requiredRouteSessionTargets) {
        const bound = await sessions.bindExistingRoute(routedTarget, { route: routeLaunchInput(route, routedTarget) });
        if (bound.restartRequired) {
          throw rpcError(
            "现有 TikTok 窗口未绑定其对应的已验证线路；关闭对应窗口后重新打开即可保留登录资料",
            "collection_route_restart_required",
            { target: routedTarget, route: publicRoute(route), session: bound }
          );
        }
      }
    }

    const login = await inspectSession(target);
    if (login.state !== "authenticated") {
      activeRuns.delete(runId);
      return database.updateRun(runId, {
        status: awaitingStatus(target, login.state),
        error: { code: sanitizeTikTokText(login.state), message: sanitizeTikTokText(login.message) }
      });
    }
    if (workflowPolicy.automaticQualification) {
      const backstageLogin = await inspectSession("collection_backstage");
      if (backstageLogin.state !== "authenticated") {
        activeRuns.delete(runId);
        return database.updateRun(runId, {
          status: awaitingStatus("collection_backstage", backstageLogin.state),
          error: { code: sanitizeTikTokText(backstageLogin.state), message: sanitizeTikTokText(backstageLogin.message) }
        });
      }
      await requireCollectionBackstagePreflight({
        route,
        runId,
        sessionAuthenticated: true
      });
    }

    if (control.requested) {
      activeRuns.delete(runId);
      const current = requiredRun(runId);
      return database.updateRun(runId, {
        status: control.requested === "cancel" ? "cancelled" : "paused",
        result: {
          ...(current.result ?? {}),
          ...(control.requested === "cancel"
            ? { cancellationReason: sanitizeTikTokText(control.reason) }
            : {})
        }
      });
    }

    control.phase = "running";
    control.promise = executeRun(runId, control);
    void control.promise;
    return { ...database.updateRun(runId, { status: "starting", error: null, finishedAt: null }), queuedInDaemon: true };
  } catch (error) {
    activeRuns.delete(runId);
    const code = safeErrorCode(error);
    const preflightPausedCodes = new Set([
      "COLLECTION_BACKSTAGE_MARKET_MISMATCH",
      "COLLECTION_BACKSTAGE_PREFLIGHT_UNAVAILABLE",
      "COLLECTION_BACKSTAGE_REQUEST_FAILED",
      "COLLECTION_BACKSTAGE_REQUEST_TIMEOUT"
    ]);
    const preflightPartialCodes = new Set([
      "COLLECTION_ADAPTER_MISMATCH",
      "COLLECTION_FRONTEND_RUNTIME_MISSING"
    ]);
    if (code === "manual_verification") {
      database.updateRun(runId, {
        status: "awaiting_manual_verification",
        error: {
          code,
          message: safeErrorMessage(error),
          details: sanitizeErrorDetails(error?.details ?? null)
        }
      });
    } else if (["authentication_required", "stopped"].includes(code)) {
      database.updateRun(runId, {
        status: "awaiting_collection_backstage_login",
        error: {
          code,
          message: safeErrorMessage(error),
          details: sanitizeErrorDetails(error?.details ?? null)
        }
      });
    } else if (["collection_route_restart_required", "ranking_mobile_authorization_required"].includes(code)
      || preflightPausedCodes.has(code)) {
      database.updateRun(runId, {
        status: "paused",
        error: {
          code,
          message: safeErrorMessage(error),
          details: sanitizeErrorDetails(error?.details ?? null)
        }
      });
    } else if (preflightPartialCodes.has(code)) {
      database.updateRun(runId, {
        status: "partial",
        error: {
          code,
          message: safeErrorMessage(error),
          details: sanitizeErrorDetails(error?.details ?? null)
        }
      });
    }
    throw error;
  }
}

function publicQueueSweepState() {
  return {
    enabled: true,
    ...originalRankingQueueSweeper.publicState()
  };
}

async function persistedAuthenticatedSessionReady(target) {
  const persisted = database.getSession(target);
  if (persisted?.status !== "authenticated") return false;
  const runtime = await sessions.status(target);
  return runtime?.running === true;
}

async function preflightDueOriginalRankingRun(dueRun) {
  const admission = database.originalCollectionAutomaticResumeReadiness(dueRun.runId);
  if (!admission.ready) return admission;
  const current = database.getRun(dueRun.runId);
  if (activeRuns.has(current.runId)) return { ready: false, reason: "run_already_active" };
  if (activeRuns.size > 0 || activeQualification) return { ready: false, reason: "collector_busy" };
  const usage = database.getQualificationUsage();
  if (usage.allowed !== true) return { ready: false, reason: "qualification_budget_blocked" };
  let route;
  try {
    route = requiredCollectionRoute(current.config?.routeProfileId, { verified: true });
    assertRunRoute(current, route);
  } catch (error) {
    return { ready: false, reason: safeErrorCode(error, "collection_route_not_ready") };
  }
  const countries = requestedCountryCodes(current.filters ?? {});
  const access = await mobileAccessReadinessForRoute(route, countries);
  if (access.ready !== true) {
    return { ready: false, reason: "ranking_mobile_authorization_required" };
  }
  const discoveryTarget = sourceTarget(current.source);
  if (!await persistedAuthenticatedSessionReady(discoveryTarget)
    || !await persistedAuthenticatedSessionReady("collection_backstage")) {
    return { ready: false, reason: "authenticated_sessions_not_running" };
  }
  if (shutdownRequested || activeRuns.size > 0 || activeQualification) {
    return { ready: false, reason: "collector_busy" };
  }
  return { ready: true };
}

async function resumeDueOriginalRankingRun(dueRun) {
  try {
    return await startRun(dueRun.runId);
  } catch (error) {
    const errorCode = safeErrorCode(error, "resume_failed");
    const afterFailure = database.getRun(dueRun.runId);
    if (afterFailure?.status === "starting" && !activeRuns.has(dueRun.runId)) {
      database.updateRun(dueRun.runId, {
        status: "partial",
        error: {
          code: "queue_sweep_resume_deferred",
          message: "持久榜单队列自动恢复条件暂时不可用，已保留到期任务等待下次扫描",
          details: { reason: errorCode }
        }
      });
    }
    throw error;
  }
}

const originalRankingQueueSweeper = createOriginalRankingQueueSweeper({
  database,
  intervalMs: queueSweepIntervalMs,
  preflightRun: preflightDueOriginalRankingRun,
  resumeRun: resumeDueOriginalRankingRun,
  shuttingDown: () => shutdownRequested
});

const sweepDueOriginalRankingQueues = (trigger = "timer") => (
  originalRankingQueueSweeper.scan(trigger)
);

const startOriginalQueueSweeper = () => originalRankingQueueSweeper.start();
const stopOriginalQueueSweeper = () => originalRankingQueueSweeper.stop();

async function performQualificationBatch({
  runId,
  candidates,
  reason,
  automatic = false,
  allowPreviouslyAttempted = false,
  offset = 0
}) {
  const qualificationRun = requiredRun(runId);
  if (activeQualification) {
    throw rpcError(
      `采集子后台正在执行批次 ${activeQualification.batchId}`,
      "collection_backstage_busy"
    );
  }

  const boundedOffset = Math.max(0, Number(offset ?? 0));
  const selectedCandidates = Array.isArray(candidates) ? candidates.slice(0, 30) : [];
  if (!selectedCandidates.length) {
    throw rpcError("所选采集任务没有可核验的候选主播", "empty_candidate_set");
  }
  const candidateByHandle = new Map();
  for (const candidate of selectedCandidates) {
    const handle = normalizeCollectionHandle(candidate.handle);
    if (!handle) {
      throw rpcError("候选名单中存在缺少有效 TikTok 用户名的记录，本批次没有提交", "candidate_handle_missing");
    }
    candidateByHandle.set(handle.toLowerCase(), candidate);
  }

  const batchId = crypto.randomUUID();
  let route = requiredCollectionRoute(qualificationRun.config?.routeProfileId, { verified: true });
  assertRunRoute(qualificationRun, route);
  // Acquire the single-flight lease before the first await. JavaScript runs
  // this section atomically, so two concurrent RPCs cannot both pass the
  // session inspection and spend two child-backend batch allowances.
  activeQualification = {
    batchId,
    runId,
    routeProfileId: route.routeProfileId,
    phase: "checking_session"
  };
  let requestAttempted = false;
  let reservation = null;
  try {
    route = await revalidateDualRouteEgress(route, "qualification_batch_reprobe");
    assertRunRoute(requiredRun(runId), route);
    const routeState = await routedSessionState("collection_backstage", route);
    if (routeState.restartRequired) {
      throw rpcError(
        "采集子后台窗口未绑定 WorkID 1 的已验证国家线路；请关闭该窗口后重新打开",
        "collection_route_restart_required",
        { route: publicRoute(route) }
      );
    }
    const login = await inspectSession("collection_backstage");
    if (login.state !== "authenticated") {
      throw rpcError(login.message, login.state, { target: "collection_backstage" });
    }

    await requireCollectionBackstagePreflight({
      route,
      runId,
      sessionAuthenticated: true
    });

    ensureQualificationPolicyState();
    const minimumSpacingSeconds = Math.ceil(nextQualificationDelayMs() / 1_000);
    reservation = database.reserveQualificationBatch({
      batchId,
      runId,
      candidateIds: [...candidateByHandle.values()].map((candidate) => candidate.candidateId),
      minimumSpacingSeconds,
      allowPreviouslyAttempted,
      details: {
        automatic,
        automaticRetry: false,
        reason: sanitizeTikTokText(reason),
        routeProfileId: route.routeProfileId,
        routeCountries: dualRouteDetails(route)?.collectionCountryCodes ?? []
      }
    });

    appendAudit({
      action: "qualification_request_attempted",
      actor: "agent",
      targetType: "qualification_batch",
      targetId: batchId,
      runId,
      details: {
        reason: sanitizeTikTokText(reason),
        requested: candidateByHandle.size,
        offset: boundedOffset,
        maximumPerRequest: 30,
        automatic,
        automaticRetry: false
      }
    });
    requestAttempted = true;
    activeQualification.phase = "request_in_flight";
    const checked = await batchCheckCollectionBackstage({
      page: sessions.page("collection_backstage"),
      handles: [...candidateByHandle.values()].map((candidate) => candidate.handle)
    });
    const records = checked.results.map((item) => {
      const candidate = candidateByHandle.get(item.handle.toLowerCase());
      if (!candidate) {
        throw rpcError("资格结果无法与本地候选名单对齐", "qualification_identity_mismatch");
      }
      const qualificationReason = {
        source: "collection_backstage",
        eligible: item.eligible,
        anchorStatusCode: item.anchorStatusCode,
        displayReasonCode: item.displayReasonCode,
        displayReason: item.displayReason,
        canUseInvitationTypeCodes: item.canUseInvitationTypeCodes,
        canUseInvitationTypes: item.canUseInvitationTypes,
        popupInvitationTypeCodes: item.popupInvitationTypeCodes,
        popupInvitationTypes: item.popupInvitationTypes,
        trialLiveEndAt: item.trialLiveEndAt,
        flags: item.flags,
        adapterVersion: checked.adapterVersion
      };
      return {
        candidateId: candidate.candidateId,
        qualificationStatus: item.qualificationStatus,
        observedAt: item.observedAt,
        sourceUrl: item.sourceUrl,
        confidence: item.confidence,
        data: { qualificationReason },
        evidence: {
          endpoint: checked.endpoint,
          adapterVersion: checked.adapterVersion,
          requestCount: 1,
          accountState: checked.accountState
        }
      };
    });
    database.recordQualificationBatch({ batchId, runId, records });
    const statusCounts = new Map();
    for (const item of checked.results) {
      statusCounts.set(item.qualificationStatus, (statusCounts.get(item.qualificationStatus) ?? 0) + 1);
    }
    const quotaLimited = (statusCounts.get("quota_limit") ?? 0) > 0;
    database.finishQualificationBatch(batchId, {
      status: quotaLimited ? "quota_limited" : "completed",
      results: records.map((record) => ({
        candidateId: record.candidateId,
        resultStatus: record.qualificationStatus
      })),
      details: {
        ...(reservation?.details ?? {}),
        adapterVersion: checked.adapterVersion,
        accountState: checked.accountState
      }
    });

    const refreshedRun = requiredRun(runId);
    const previousQualification = refreshedRun.result?.qualification ?? {};
    const cumulativeStatusCounts = { ...(previousQualification.statusCounts ?? {}) };
    const unresolvedCandidateIds = new Set(previousQualification.unresolvedCandidateIds ?? []);
    for (const record of records) {
      if (record.qualificationStatus === "quota_limit") unresolvedCandidateIds.add(record.candidateId);
      else unresolvedCandidateIds.delete(record.candidateId);
    }
    for (const [status, count] of statusCounts) {
      cumulativeStatusCounts[status] = (cumulativeStatusCounts[status] ?? 0) + count;
    }
    const pendingCandidates = database.listUnattemptedRunProspects({ runId, limit: 1, offset: 0 }).length;
    const qualificationSummary = {
      lastBatchId: batchId,
      checkedAt: checked.results[0]?.observedAt ?? new Date().toISOString(),
      batchRequestsUsed: (previousQualification.batchRequestsUsed ?? 0) + 1,
      creatorsChecked: (previousQualification.creatorsChecked ?? 0) + checked.results.length,
      offset: boundedOffset,
      statusCounts: Object.fromEntries(Object.entries(cumulativeStatusCounts).sort()),
      quotaLimitedCount: (previousQualification.quotaLimitedCount ?? 0) + (statusCounts.get("quota_limit") ?? 0),
      unresolvedCandidateIds: [...unresolvedCandidateIds].sort(),
      unresolvedCount: unresolvedCandidateIds.size,
      pendingCandidates,
      qualificationComplete: unresolvedCandidateIds.size === 0 && pendingCandidates === 0,
      automatic,
      automaticRetry: false,
      usageAfter: database.getQualificationUsage()
    };
    database.updateRun(runId, {
      result: { ...(refreshedRun.result ?? {}), qualification: qualificationSummary }
    });
    appendAudit({
      action: "qualification_batch_checked",
      actor: "agent",
      targetType: "qualification_batch",
      targetId: batchId,
      runId,
      details: qualificationSummary
    });
    return sanitizeTikTokValue({
      schemaVersion: "tkdesk.qualification-batch.v2",
      batchId,
      runId,
      batchRequestsUsed: 1,
      creatorsChecked: checked.results.length,
      maximumCreatorsPerRequest: 30,
      automaticRetry: false,
      automatic,
      usageBefore: reservation?.usageBefore ?? null,
      usageAfter: qualificationSummary.usageAfter,
      accountState: checked.accountState,
      statusCounts: qualificationSummary.statusCounts,
      quotaLimitedCount: qualificationSummary.quotaLimitedCount,
      qualificationComplete: qualificationSummary.qualificationComplete,
      candidates: checked.results.map((item) => {
        const candidate = candidateByHandle.get(item.handle.toLowerCase());
        return {
          candidateId: candidate.candidateId,
          handle: candidate.handle,
          qualificationStatus: item.qualificationStatus,
          eligible: item.eligible,
          qualificationReason: {
            anchorStatusCode: item.anchorStatusCode,
            displayReasonCode: item.displayReasonCode,
            displayReason: item.displayReason,
            canUseInvitationTypes: item.canUseInvitationTypes,
            trialLiveEndAt: item.trialLiveEndAt,
            flags: item.flags
          },
          qualificationObservedAt: item.observedAt
        };
      })
    });
  } catch (error) {
    if (safeErrorCode(error) === "manual_verification") {
      // The versioned adapter may present TikTok's own verification widget in
      // the Agent-owned tab. Bring only that tab forward so the user can solve
      // it manually; never click, solve, or replay the qualification request.
      const verificationPage = sessions.page("collection_backstage");
      if (typeof verificationPage.bringToFront === "function") {
        await verificationPage.bringToFront().catch(() => {});
      }
    }
    if (reservation) {
      database.finishQualificationBatch(batchId, {
        status: "failed",
        errorCode: safeErrorCode(error),
        details: {
          ...(reservation.details ?? {}),
          automatic,
          automaticRetry: false,
          errorCode: safeErrorCode(error)
        }
      });
      const run = requiredRun(runId);
      const previousQualification = run.result?.qualification ?? {};
      const unresolvedCandidateIds = new Set(previousQualification.unresolvedCandidateIds ?? []);
      for (const candidateId of reservation.candidateIds ?? []) unresolvedCandidateIds.add(candidateId);
      database.updateRun(runId, {
        result: {
          ...(run.result ?? {}),
          qualification: {
            ...previousQualification,
            qualificationComplete: false,
            unresolvedCandidateIds: [...unresolvedCandidateIds].sort(),
            unresolvedCount: unresolvedCandidateIds.size,
            lastFailedBatchId: batchId,
            lastFailureCode: safeErrorCode(error),
            batchRequestsUsed: Number(previousQualification.batchRequestsUsed ?? 0) + 1,
            usageAfter: database.getQualificationUsage(),
            automaticRetry: false
          }
        }
      });
    }
    if (requestAttempted) {
      appendAudit({
        action: "qualification_batch_checked",
        actor: "agent",
        targetType: "qualification_batch",
        targetId: batchId,
        runId,
        outcome: "failed",
        details: { code: safeErrorCode(error), automaticRetry: false }
      });
    }
    throw error;
  } finally {
    if (activeQualification?.batchId === batchId) activeQualification = null;
  }
}

function runProspectsForManualQualificationImport(runId) {
  const prospects = [];
  for (let offset = 0; ; offset += 2_000) {
    const page = database.queryProspects({ runId, limit: 2_000, offset });
    prospects.push(...page.filter((prospect) => prospect.latestDiscoveryObservation?.runId === runId));
    if (page.length < 2_000) break;
  }
  return prospects;
}

function importManualQualificationResults({ runId, results, observedAt = null, reason }) {
  const run = requiredRun(runId);
  const workflow = discoveryWorkflowPolicy(run);
  if (run.source !== "tiktok_live" || run.mode !== "semi_auto" || !workflow.semiAutoRegional) {
    throw rpcError(
      "人工资格结果只允许关联原版地区榜半自动任务",
      "manual_qualification_import_mode_mismatch"
    );
  }
  if (activeRuns.has(runId)) {
    throw rpcError(
      "半自动发现任务仍在运行；请等候选名单安全落库后再导入人工结果",
      "run_busy"
    );
  }
  if (!["completed", "partial", "paused"].includes(run.status)) {
    throw rpcError(
      "半自动任务尚未形成可关联的候选名单",
      "manual_qualification_import_run_not_ready",
      { runStatus: sanitizeTikTokText(run.status) }
    );
  }
  const safeReason = sanitizeTikTokText(reason).slice(0, 300);
  if (safeReason.length < 5) {
    throw rpcError("人工资格结果导入需要可审计的原因", "manual_qualification_import_reason_required");
  }
  const normalizedResults = normalizeManualCollectionBackstageResults(results, {
    observedAt: observedAt ?? new Date().toISOString()
  });
  const runProspects = runProspectsForManualQualificationImport(runId);
  const candidatesByHandle = new Map();
  for (const prospect of runProspects) {
    const handle = normalizeCollectionHandle(prospect.handle);
    if (!handle) continue;
    const handleKey = handle.toLocaleLowerCase("en-US");
    const matches = candidatesByHandle.get(handleKey) ?? [];
    matches.push(prospect);
    candidatesByHandle.set(handleKey, matches);
  }

  const unknownHandles = [];
  const ambiguousHandles = [];
  const alreadyImportedHandles = [];
  const matched = [];
  for (const item of normalizedResults) {
    const candidates = candidatesByHandle.get(item.handleKey) ?? [];
    if (candidates.length === 0) {
      unknownHandles.push(item.handle);
      continue;
    }
    if (candidates.length !== 1) {
      ambiguousHandles.push(item.handle);
      continue;
    }
    const candidate = candidates[0];
    if (candidate.latestQualificationObservation) {
      alreadyImportedHandles.push(item.handle);
      continue;
    }
    matched.push({ item, candidate });
  }
  if (unknownHandles.length || ambiguousHandles.length || alreadyImportedHandles.length) {
    throw rpcError(
      "人工资格结果无法与该半自动任务的未分类候选逐一对应；本批次没有写入",
      "manual_qualification_identity_mismatch",
      {
        unknownHandles: unknownHandles.map((value) => sanitizeTikTokText(value)),
        ambiguousHandles: ambiguousHandles.map((value) => sanitizeTikTokText(value)),
        alreadyImportedHandles: alreadyImportedHandles.map((value) => sanitizeTikTokText(value))
      }
    );
  }

  const importId = `manual-import:${crypto.randomUUID()}`;
  const usageBefore = database.getQualificationUsage();
  const records = matched.map(({ item, candidate }) => ({
    candidateId: candidate.candidateId,
    qualificationStatus: item.qualificationStatus,
    observedAt: item.observedAt,
    confidence: 1,
    data: {
      qualificationReason: {
        source: "collection_backstage_manual_import",
        importMode: item.importMode,
        provenance: item.provenance,
        eligible: item.eligible,
        anchorStatusCode: item.anchorStatusCode,
        displayReasonCode: item.displayReasonCode,
        displayReason: item.displayReason,
        canUseInvitationTypeCodes: item.canUseInvitationTypeCodes,
        canUseInvitationTypes: item.canUseInvitationTypes,
        popupInvitationTypeCodes: item.popupInvitationTypeCodes,
        popupInvitationTypes: item.popupInvitationTypes
      }
    },
    evidence: {
      adapterVersion: "collection-backstage-manual-import.v1",
      provenance: item.provenance,
      importMode: "manual_import",
      officialManualQuery: true,
      automaticBackstageRequest: false,
      qualificationRequestConsumed: false,
      automaticRetry: false,
      recursiveRankingExpansionTriggered: false
    }
  }));
  const committedImport = database.commitManualQualificationImport({
    importId,
    runId,
    records,
    reason: safeReason
  });
  const usageAfter = database.getQualificationUsage();
  const {
    statusCounts,
    pendingCandidates,
    qualificationComplete
  } = committedImport;
  return sanitizeTikTokValue({
    schemaVersion: "tkdesk.manual-qualification-import.v1",
    operation: "manual_import",
    importId,
    runId,
    imported: records.length,
    maximumCreatorsPerImport: 30,
    statusCounts,
    pendingCandidates,
    qualificationComplete,
    batchRequestsUsed: 0,
    qualificationBudgetRequestsConsumed: 0,
    usageBefore,
    usageAfter,
    automaticBackstageRequest: false,
    automaticRetry: false,
    recursiveRankingExpansionTriggered: false,
    candidates: matched.map(({ item, candidate }) => ({
      candidateId: candidate.candidateId,
      handle: candidate.handle,
      qualificationStatus: item.qualificationStatus,
      eligible: item.eligible,
      qualificationReason: {
        anchorStatusCode: item.anchorStatusCode,
        displayReasonCode: item.displayReasonCode,
        displayReason: item.displayReason,
        canUseInvitationTypes: item.canUseInvitationTypes,
        popupInvitationTypes: item.popupInvitationTypes
      },
      qualificationObservedAt: item.observedAt,
      provenance: item.provenance
    }))
  });
}

async function checkCandidateQualifications(params = {}) {
  const {
    operation = "automatic_query",
    runId,
    candidateIds = null,
    limit = 30,
    offset = 0,
    results = null,
    observedAt = null,
    reason
  } = params;
  const run = requiredRun(runId);
  if (operation === "manual_import") {
    const conflictingFields = ["candidateIds", "limit", "offset"]
      .filter((field) => Object.hasOwn(params, field));
    if (conflictingFields.length) {
      throw rpcError(
        "manual_import 不能同时选择自动查询候选范围",
        "manual_qualification_operation_conflict",
        { fields: conflictingFields }
      );
    }
    return importManualQualificationResults({ runId, results, observedAt, reason });
  }
  if (operation !== "automatic_query") {
    throw rpcError("不支持的资格操作模式", "unsupported_qualification_operation");
  }
  const conflictingFields = ["results", "observedAt"]
    .filter((field) => Object.hasOwn(params, field));
  if (conflictingFields.length) {
    throw rpcError(
      "automatic_query 不能携带人工导入结果",
      "manual_qualification_operation_conflict",
      { fields: conflictingFields }
    );
  }
  if (run.mode === "semi_auto" && discoveryWorkflowPolicy(run).semiAutoRegional) {
    throw rpcError(
      "原版半自动任务不调用采集子后台；请在官方子后台手动查询后使用 manual_import",
      "semi_auto_automatic_qualification_forbidden"
    );
  }
  const activeFullAuto = [...activeRuns.keys()].find(
    (activeRunId) => requiredRun(activeRunId).mode === "full_auto"
  );
  if (activeRuns.has(runId) || activeFullAuto) {
    throw rpcError("全自动采集任务仍在运行；请等其安全停点后再手动复核", "run_busy");
  }
  const boundedLimit = Math.min(30, Math.max(1, Number(limit ?? 30)));
  const boundedOffset = Math.max(0, Number(offset ?? 0));
  const requestedCandidateIds = Array.isArray(candidateIds)
    ? [...new Set(candidateIds.map((value) => String(value || "").trim()).filter(Boolean))].slice(0, 30)
    : [];
  const selected = queryCandidateSet({
    runId,
    candidateIds: requestedCandidateIds.length ? requestedCandidateIds : undefined,
    limit: requestedCandidateIds.length || boundedLimit,
    offset: requestedCandidateIds.length ? 0 : boundedOffset
  });
  if (requestedCandidateIds.length) {
    const selectedById = new Map(selected.candidates.map((candidate) => [candidate.candidateId, candidate]));
    const missingCandidateIds = requestedCandidateIds.filter((candidateId) => !selectedById.has(candidateId));
    if (missingCandidateIds.length) {
      throw rpcError(
        "显式复核名单中有主播不属于该采集任务",
        "qualification_candidate_not_in_run",
        { missingCandidateIds }
      );
    }
    selected.candidates = requestedCandidateIds.map((candidateId) => selectedById.get(candidateId));
  }
  return performQualificationBatch({
    runId,
    candidates: selected.candidates,
    reason,
    automatic: false,
    allowPreviouslyAttempted: true,
    offset: requestedCandidateIds.length ? 0 : boundedOffset
  });
}

async function waitForQualificationWindow(runId, control, nextEligibleAt) {
  return waitForOriginalQualificationWindow({
    database,
    runId,
    nextEligibleAt,
    maxSleepMs: 250,
    shouldStop: () => Boolean(control.requested)
  });
}

function listAutoQualificationProspects(runId, limit = 30) {
  requiredRun(runId);
  return listOriginalAutoQualificationProspects({ database, runId, limit });
}

async function autoQualifyRun(runId, control, { sourceComplete = true } = {}) {
  let batchesThisExecution = 0;
  let creatorsThisExecution = 0;
  database.updateRun(runId, {
    status: "qualifying",
    progress: { stage: "qualification", automatic: true, automaticRetry: false }
  });

  while (!control.requested) {
    ensureQualificationPolicyState();
    const prospects = listAutoQualificationProspects(runId, 30);
    const planned = planQualificationBatch(prospects, { sourceComplete });
    if (!planned.ready) {
      const run = requiredRun(runId);
      const unresolvedCount = Number(run.result?.qualification?.unresolvedCount ?? 0);
      const qualification = {
        ...(run.result?.qualification ?? {}),
        qualificationComplete: sourceComplete && unresolvedCount === 0,
        pendingCandidates: prospects.length,
        automatic: true,
        automaticRetry: false,
        usageAfter: database.getQualificationUsage()
      };
      database.updateRun(runId, { result: { ...(run.result ?? {}), qualification } });
      return {
        complete: sourceComplete && unresolvedCount === 0,
        stoppedReason: !sourceComplete ? "waiting_full_batch" : unresolvedCount === 0 ? null : "explicit_recheck_required",
        unresolvedCount,
        batchesThisExecution,
        creatorsThisExecution
      };
    }

    const candidates = planned.batch.map(normalizeCandidate);
    const invalidCandidates = candidates.filter((candidate) => !normalizeCollectionHandle(candidate.handle));
    if (invalidCandidates.length) {
      const run = requiredRun(runId);
      const previousQualification = run.result?.qualification ?? {};
      const unresolvedCandidateIds = new Set(previousQualification.unresolvedCandidateIds ?? []);
      const invalidHandleCandidateIds = new Set(previousQualification.invalidHandleCandidateIds ?? []);
      for (const candidate of invalidCandidates) {
        unresolvedCandidateIds.add(candidate.candidateId);
        invalidHandleCandidateIds.add(candidate.candidateId);
      }
      database.updateRun(runId, {
        result: {
          ...(run.result ?? {}),
          qualification: {
            ...previousQualification,
            qualificationComplete: false,
            unresolvedCandidateIds: [...unresolvedCandidateIds].sort(),
            unresolvedCount: unresolvedCandidateIds.size,
            invalidHandleCandidateIds: [...invalidHandleCandidateIds].sort(),
            automaticRetry: false
          }
        }
      });
    }
    const validCandidates = candidates.filter((candidate) => normalizeCollectionHandle(candidate.handle));
    if (!validCandidates.length) continue;
    let checked;
    try {
      checked = await performQualificationBatch({
        runId,
        candidates: validCandidates,
        reason: "全自动名单资格分类",
        automatic: true,
        allowPreviouslyAttempted: false
      });
    } catch (error) {
      if (safeErrorCode(error) !== "QUALIFICATION_BUDGET_EXHAUSTED") throw error;
      const shouldContinue = await waitForQualificationWindow(
        runId,
        control,
        error?.details?.nextEligibleAt
      );
      if (!shouldContinue) break;
      continue;
    }

    batchesThisExecution += 1;
    creatorsThisExecution += checked.creatorsChecked;
    database.saveCheckpoint(runId, "qualification", {
      lastBatchId: checked.batchId,
      batchesThisExecution,
      creatorsThisExecution,
      usageAfter: checked.usageAfter
    }, { adapter: "collection_backstage" });

    if (checked.candidates.some((candidate) => candidate.qualificationStatus === "quota_limit")) {
      const run = requiredRun(runId);
      const qualification = {
        ...(run.result?.qualification ?? {}),
        qualificationComplete: false,
        stoppedReason: "backend_quota_limit",
        automaticRetry: false
      };
      database.updateRun(runId, { result: { ...(run.result ?? {}), qualification } });
      return {
        complete: false,
        stoppedReason: "backend_quota_limit",
        batchesThisExecution,
        creatorsThisExecution
      };
    }

    if (!listAutoQualificationProspects(runId, 1).length) {
      continue;
    }
    const nextEligibleAt = checked.usageAfter?.nextEligibleAt
      ?? checked.usageAfter?.spacingReleaseAt;
    if (nextEligibleAt) {
      const shouldContinue = await waitForQualificationWindow(runId, control, nextEligibleAt);
      if (!shouldContinue) break;
    }
    database.updateRun(runId, {
      status: "qualifying",
      progress: {
        stage: "qualification",
        batchesThisExecution,
        creatorsThisExecution,
        automatic: true,
        automaticRetry: false
      }
    });
  }
  return {
    complete: false,
    stoppedReason: control.requested ?? "stopped",
    batchesThisExecution,
    creatorsThisExecution
  };
}

async function writeHandoffFile(batch) {
  const outputPath = path.join(paths.handoffsDirectory, `${batch.batchId}.json`);
  const temporaryPath = `${outputPath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(batch, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, outputPath);
  return outputPath;
}

const methods = {
  ping: async () => ({ protocolVersion: PROTOCOL_VERSION, daemonVersion: DAEMON_VERSION, pluginVersion, pid: process.pid }),

  status: async () => {
    const rankingValidation = regionalRankingRuntimeValidation();
    const activeCollectionRoute = database.getActiveCollectionRoute();
    const startupInventory = startupInventoryStatus();
    const mobileAccess = await mobileAccessReadinessForRoute(activeCollectionRoute);
    const authorizationReady = mobileAccess.ready === true;
    const runtimeSessions = await sessions.status();
    const collectionReady = await collectionReadiness(activeCollectionRoute, runtimeSessions);
    const operationalReady = rankingValidation.liveSampleValidated && authorizationReady && mobileAccess.onlineReady === true && collectionReady.ready;
    const codePresentCountries = [...TIKTOK_RANKING_TRANSPORT_PROFILE.supportedCountries];
    const liveValidatedCountries = rankingValidation.liveSampleValidated
      ? [...rankingValidation.validatedCountryCodes]
      : [];
    const authorizedCountries = new Set((mobileAccess.coverage ?? [])
      .filter((item) => item?.state === "ready" && item?.usable === true && item?.onlineVerified === true)
      .map((item) => item.countryCode));
    const operationalCountries = liveValidatedCountries.filter(
      (countryCode) => authorizedCountries.has(countryCode)
    );
    const implementationStatus = operationalReady
      ? "operational"
      : rankingValidation.liveSampleValidated
        ? "live_validated_authorization_required"
        : "code_present_live_validation_required";
    return {
      protocolVersion: PROTOCOL_VERSION,
      daemonVersion: DAEMON_VERSION,
      pluginVersion,
      pid: process.pid,
      dataDirectory,
      databasePath: paths.databasePath,
      sessions: runtimeSessions,
      collectionReadiness: collectionReady,
      activeRunIds: [...activeRuns.keys()],
      activeQualificationBatchId: activeQualification?.batchId ?? null,
      durableQueueSweep: publicQueueSweepState(),
      activeCollectionRoute: publicRoute(activeCollectionRoute),
      qualificationPolicyState: database.getQualificationPolicyState({
        at: new Date().toISOString(),
        activeOnly: true
      }),
      qualificationUsage: database.getQualificationUsage(),
      startupInventory,
      recentRuns: database.listRuns({ limit: 10 }),
      capabilities: {
        sources: ["tiktok_live", "svip_legacy"],
        modes: {
          semi_auto: true,
          full_auto: operationalReady,
          full_autoCalibration: true,
          pcAutomationAvailable: isDualRouteVerified(activeCollectionRoute),
          continuousRegionalDefault: true,
          desiredDefault: "full_auto",
          default: !rankingValidation.liveSampleValidated
            ? "calibration_required"
            : authorizationReady ? "full_auto" : "authorization_required"
        },
        discovery: {
          default: "regional_gift_ranking",
          regionalGiftRanking: {
            codePresent: true,
            continuousCore: "tksoft-v10-continuous-processors-v1",
            pcAutomationAvailable: isDualRouteVerified(activeCollectionRoute),
            originalCatalog: { displayConfigurations: 36, routeGroups: 27, memberCountryCodes: 146 },
            codePresentCountries,
            implementationStatus,
            productionReady: operationalReady,
            operationalReady,
            ...rankingValidation,
            liveValidated: rankingValidation.liveSampleValidated,
            liveValidatedCountries,
            operationalCountries,
            authorizationReady,
            authorizationOnlineReady: mobileAccess.onlineReady === true,
            mobileAccess,
            runtimeValidationRequiredPerEnvironment: true,
            runtimeSource: "fixed_pc_feed_mobileprocessor_country_lists_and_seeded_direct_rank_requests",
            requiresOfficialUiTriggeredResponse: false,
            passiveCaptureOnly: false,
            countryFeedCodePresent: true,
            countryFeedOperational: rankingValidation.liveSampleValidated,
            rankingTransportCodePresent: true,
            mobileSessionBoundary: originalCoreConfigStore
              ? "user_authorized_original_published_configuration"
              : mobileAccess.onlineReady === true ? "validated_user_authorized_runtime"
                : authorizationReady ? "user_owned_mobile_configuration_online_unknown" : "user_owned_mobile_authorization_required",
            copiesSupplierCredentials: Boolean(originalCoreConfigStore),
            defaultRankingViewKind: "top",
            supportedListViewKinds: ["top"],
            originalRequestSemantics: {
              rankTypeCode: TIKTOK_RANKING_TRANSPORT_PROFILE.rankTypeCode,
              regionTypeCode: TIKTOK_RANKING_TRANSPORT_PROFILE.regionTypeCode,
              gapIntervals: [...TIKTOK_RANKING_TRANSPORT_PROFILE.gapIntervals]
            },
            scoreUnitDefault: "unknown_rank_score",
            originalAnchorScoreEvidenceVersion: TIKTOK_RANKING_TRANSPORT_PROFILE.originalScoreEvidenceVersion,
            originalTopCode: TIKTOK_RANKING_TRANSPORT_PROFILE.originalScoreTopCode,
            ordinaryLiveCardsUsedAsFallback: false
          },
          recoveredDownloadCoreDLL: RECOVERED_DOWNLOAD_CORE_DLL_PROFILE,
          publicLiveCards: {
            diagnosticOnly: false,
            allowedInFullAuto: true,
            automaticQualification: true,
            rankingExpansion: false
          },
          tikhubRankings: await tikHubRankingTransport.status()
        },
        routePolicy: {
          explicitMarketCountries: true,
          originalCountryCatalog: {
            schemaVersion: ORIGINAL_COUNTRY_CATALOG_PROFILE.schemaVersion,
            sourceRecordCount: ORIGINAL_COUNTRY_CATALOG_PROFILE.sourceRecordCount,
            routeCodeCount: ORIGINAL_COUNTRY_CATALOG_PROFILE.routeCodeCount,
            displayVariantCount: ORIGINAL_COUNTRY_CATALOG_PROFILE.displayVariantCount,
            sourceDefinedMembershipPreserved: true
          },
          countryPerLaneTopology: true,
          discoveryBrowserProfile: "tiktok_discovery",
          discoveryBrowserCountry: DISCOVERY_COUNTRY,
          discoveryProxyExitCountryRequired: DISCOVERY_COUNTRY,
          collectionBackstageProfile: "collection_backstage",
          collectionBackstageUsesFirstCountryLane: true,
          minimumCollectionCountries: 1,
          maxCollectionCountries: 3,
          oneProxyPerCountry: true,
          collectionLanesMustBeDistinct: true,
          workIdLaneAffinity: true,
          allConfiguredExitsReprobedBeforeRunAndBatch: true,
          qualificationUsesFirstCountryLane: true,
          countryMatchedProxyRequired: true,
          verifiedExitCountryRequired: true,
          exitCountryReprobeBeforeRunAndBatch: true,
          backstageMarketRegionExplicitlyConfigured: true,
          proxyCredentialsAccepted: false
        },
        qualification: {
          collectionBackstage: true,
          readOnly: true,
          maximumCreatorsPerRequest: 30,
          oneHourWindowType: "rolling_60m",
          hourlyTargetRange: [50, 55],
          hourlyHardLimit: 55,
          dailyWindowType: "rolling_24h",
          dailyTargetRange: [145, 150],
          dailyHardLimit: 150,
          intervalSecondsRange: [60, 80],
          automaticRetry: false,
          sendsInvitations: false
        },
        businessPolicy: {
          authority: "user_confirmed_local_policy",
          followerInvitationBoundary: 1_000_000,
          followerLaneExpectation: {
            belowBoundary: "regular",
            exactlyBoundary: "backend_required",
            aboveBoundary: "advanced"
          },
          diamondsPerUsdEstimate: 100,
          diamondEstimateApproximate: true,
          explicitDiamondUnitRequired: true,
          platformCreatorDiamondCapBackendAuthoritative: true,
          insufficientDurationBackendAuthoritative: true,
          originalHighQualityMode: {
            threshold: 10,
            participatingScoreFields: [
              "currentScore",
              "historyRankScore",
              "hotListScore",
              "rankRecordScore",
              "rankingScore"
            ],
            topScoreExcluded: true,
            incompleteEvidence: "unresolved"
          }
        },
        scope: {
          creatorListDiscoveryOnly: true,
          operatesCollectionBackstage: true,
          operatesGuildBackend: false,
          sendsInvitations: false,
          sendsMessages: false,
          operatesOfficialAccountMarketing: false
        },
        pagination: {
          svip_legacy: true,
          tiktok_live: false
        },
        checkpointResume: true,
        sharedDaemon: true,
        customDesktopUi: false,
        sendsMessages: false
      }
    };
  },

  core_configuration_status: async () => publicCoreConfigurationStatus(await rankingCoreConfigStore.status()),

  original_country_catalog: async ({ routeCode = null, countryCode = null } = {}) => {
    const catalog = originalCountryCatalog({ routeCode, countryCode });
    if (!catalog) throw rpcError("原版国家配置筛选条件无效", "original_country_catalog_filter_invalid");
    return {
      ...catalog,
      compiledMobileProfileCountries: [
        ...TIKTOK_RANKING_TRANSPORT_PROFILE.supportedCountries
      ],
      liveValidatedMobileProfileCountries: [],
      catalogMembershipImpliesOperationalReadiness: false
    };
  },

  mobile_authorization_status: async ({ marketRegion = null, countryCode = null } = {}) => {
    const hasMarket = marketRegion !== null && marketRegion !== undefined && marketRegion !== "";
    const hasCountry = countryCode !== null && countryCode !== undefined && countryCode !== "";
    if (hasMarket !== hasCountry) {
      throw rpcError(
        "检查指定范围时必须同时提供 marketRegion 和 countryCode",
        "mobile_authorization_scope_incomplete"
      );
    }
    if (!hasMarket) return mobileAccessStatus();
    const normalizedMarket = String(marketRegion).trim().toUpperCase();
    if (!/^[A-Z0-9_-]{2,32}$/.test(normalizedMarket)) {
      throw rpcError("移动授权大区格式无效", "mobile_authorization_scope_invalid");
    }
    const normalizedCountry = normalizeCountryCode(countryCode, "countryCode");
    return mobileAccessStatus({ marketRegion: normalizedMarket, countryCode: normalizedCountry });
  },

  clear_mobile_authorization: async ({ userConfirmed } = {}) => {
    if (userConfirmed !== true) {
      throw rpcError("清除移动授权需要用户明确确认", "confirmation_required");
    }
    if (activeRuns.size > 0 || activeQualification) {
      throw rpcError(
        "采集任务或资格核验正在运行，不能清除移动授权",
        "mobile_authorization_in_use"
      );
    }
    const before = await mobileAccessStatus();
    await rankingCoreConfigStore.clearMobileAuthorization();
    const after = await mobileAccessStatus();
    appendAudit({
      action: "mobile_authorization_cleared",
      actor: "user",
      targetType: "mobile_access",
      targetId: "regional_gift_ranking",
      details: { previousState: before.state, currentState: after.state }
    });
    return { ...after, cleared: true };
  },

  session_status: async ({ target } = {}) => {
    if (target) return readSession(target);
    return Object.fromEntries(await Promise.all(SESSION_TARGET_NAMES.map(async (name) => [name, await readSession(name)])));
  },

  start_login: async ({ target, routeProfileId = null }) => {
    const route = isRoutedTarget(target) ? requiredCollectionRoute(routeProfileId, { verified: true }) : null;
    const started = await sessions.start(target, route ? { route: routeLaunchInput(route, target) } : undefined);
    if (started?.restartRequired) {
      throw rpcError(
        "当前专用窗口未绑定其对应的已验证线路；请只关闭该窗口后重新执行 start_login，登录资料会保留",
        "collection_route_restart_required",
        { target, route: publicRoute(route), session: started }
      );
    }
    const result = await readSession(target);
    appendAudit({
      action: "login_window_opened",
      targetType: "session",
      targetId: target,
      details: { state: result.state, route: route ? publicRoute(route) : null }
    });
    return result;
  },

  reopen_login: async ({ target, routeProfileId = null, userConfirmed }) => {
    if (userConfirmed !== true) throw rpcError("安全重开需要用户明确确认", "confirmation_required");
    if (target !== "collection_backstage") throw rpcError("只能安全重开采集子后台", "invalid_session_target");
    const route = requiredCollectionRoute(routeProfileId, { verified: true });
    await sessions.reopen(target, { route: routeLaunchInput(route, target) });
    const result = await readSession(target);
    appendAudit({
      action: "login_official_page_reopened",
      actor: "user",
      targetType: "session",
      targetId: target,
      details: { state: result.state, route: publicRoute(route), profilePreserved: true, processPreserved: true }
    });
    return result;
  },

  inspect_startup_initialization: async ({ target, routeProfileId = null }) => {
    if(!["collection_backstage","tiktok_discovery"].includes(target))throw rpcError("初始化会话不支持", "startup_target_invalid");
    if(activeRuns.size||activeQualification)throw rpcError("初始化需要采集与查询处于空闲", "run_busy");
    requiredCollectionRoute(routeProfileId,{verified:true});
    const session=await sessions.status(target);
    if(!session.authenticatedRequestReady)throw rpcError("初始化需要已认证的专用窗口", "authentication_required");
    return inspectStartupInitialization(sessions.page(target),target);
  },

  initialize_collection_backstage: async ({ routeProfileId = null, inspectOnly = false, userConfirmedVerification = false }) => {
    if(activeRuns.size||activeQualification)throw rpcError("初始化需要采集与查询处于空闲", "run_busy");
    const route=requiredCollectionRoute(routeProfileId,{verified:true});
    const batchId=crypto.randomUUID();
    activeQualification={batchId,runId:null,routeProfileId:route.routeProfileId,phase:'startup_initialization'};
    try{
      const bound=await routedSessionState('collection_backstage',route);
      if(bound.restartRequired)throw rpcError('后台窗口线路不匹配','collection_route_restart_required');
      await requireCollectionBackstagePreflight({route});
      const page=sessions.page('collection_backstage');
      if(inspectOnly)return inspectStartupInitialization(page,'collection_backstage');
      const result=await initializeCollectionBackstage(page,{userConfirmedVerification,reserveAttempt:({requestId})=>{
        ensureQualificationPolicyState();
        return database.reserveStartupQualificationAttempt({requestId,routeProfileId:route.routeProfileId,minimumSpacingSeconds:nextQualificationDelayMs()/1000});
      }});
      appendAudit({action:'collection_startup_initialized',targetType:'collection_route',targetId:route.routeProfileId,outcome:result.state,details:result});
      return {...result,qualificationUsage:database.getQualificationUsage()};
    }finally{if(activeQualification?.batchId===batchId)activeQualification=null;}
  },

  prepare_discovery_live: async ({ routeProfileId = null }) => {
    if(activeRuns.size||activeQualification)throw rpcError("初始化需要采集与查询处于空闲", "run_busy");
    const batchId=crypto.randomUUID();
    const route=requiredCollectionRoute(routeProfileId,{verified:true});
    activeQualification={batchId,runId:null,routeProfileId:route.routeProfileId,phase:'startup_initialization'};
    try{
    const session=await sessions.status('tiktok_discovery');
    if(!session.authenticatedRequestReady)throw rpcError("初始化需要已认证的专用窗口", "authentication_required");
    const bound=await routedSessionState('tiktok_discovery',route);
    if(bound.restartRequired)throw rpcError('发现窗口线路不匹配','collection_route_restart_required');
    const pages=sessions.startupPages('tiktok_discovery');
    if(!pages.length)throw rpcError('没有已认证的推荐或直播页面','startup_page_unavailable');
    const results=[];
    // Pause every approved page before any navigation can fail.
    const paused = await Promise.allSettled(pages.map(page => pauseDiscoveryPlayback(page)));
    for (let index=0;index<pages.length;index++) {
      try {
        if(paused[index].status==='rejected')throw paused[index].reason;
        results.push(await prepareDiscoveryLive(pages[index]));
      } catch(error) {
        results.push({state:'playback_pause_failed',ready:false,paused:false,errorCode:error.code??'startup_playback_unavailable'});
      }
    }
    const result={state:results.every(r=>r.ready)?'ready':'playback_pause_failed',ready:results.every(r=>r.ready),paused:results.every(r=>r.paused),pageCount:results.length,pages:results,profilePreserved:true};
    appendAudit({action:'discovery_startup_paused',targetType:'session',targetId:'tiktok_discovery',outcome:result.state,details:result});
    return result;
    }finally{if(activeQualification?.batchId===batchId)activeQualification=null;}
  },

  check_login: async ({ target, routeProfileId = null }) => {
    if (isRoutedTarget(target)) {
      const route = requiredCollectionRoute(routeProfileId, { verified: true });
      const bound = await sessions.bindExistingRoute(target, { route: routeLaunchInput(route, target) });
      if (bound.restartRequired) {
        throw rpcError(
          "当前登录窗口不是通过其对应的已验证线路启动；请关闭窗口后重新打开（登录资料会保留）",
          "collection_route_restart_required",
          { route: publicRoute(route), session: bound }
        );
      }
    }
    const result = await inspectSession(target);
    appendAudit({ action: "login_status_checked", targetType: "session", targetId: target, details: { state: result.state } });
    return result;
  },

  reset_session: async ({ target, userConfirmed }) => {
    if (userConfirmed !== true) throw rpcError("重置会话需要用户明确确认", "confirmation_required");
    const result = await sessions.reset(target);
    database.setSessionStatus(target, "reset", { currentUrl: null, authenticatedAt: null });
    appendAudit({ action: "session_reset", actor: "user", targetType: "session", targetId: target });
    return result;
  },

  configure_collection_route: async ({
    routeProfileId = crypto.randomUUID(),
    marketRegion,
    marketCountryCodes,
    collectionLanes,
    routeCountry,
    backstageCountry,
    discoveryCountry,
    discoveryProxyServer,
    collectionProxyServers,
    activate = true,
    userConfirmed
  }) => {
    if (userConfirmed !== true) throw rpcError("保存采集线路需要用户明确确认", "confirmation_required");
    if (routeProfileId && [...activeRuns.keys()].some(
      (runId) => requiredRun(runId).config?.routeProfileId === routeProfileId
    )) {
      throw rpcError("该采集线路正被运行中的任务使用，不能原地修改", "collection_route_in_use");
    }
    if (activeQualification?.routeProfileId === routeProfileId) {
      throw rpcError("该采集线路正被资格核验批次使用，不能原地修改", "collection_route_in_use");
    }
    const normalized = normalizeDualRouteIntent({
      marketRegion,
      marketCountryCodes,
      collectionLanes,
      discoveryCountry,
      discoveryProxyServer,
      routeCountry,
      backstageCountry,
      collectionProxyServers
    });
    const proxyFingerprint = dualRouteConfigurationFingerprint(normalized);
    const stored = database.upsertCollectionRoute({
      routeProfileId,
      ...normalized,
      proxyFingerprint,
      discoveryProxyExitCountry: null,
      proxyExitCountry: null,
      collectionProxyExitCountries: [],
      verificationStatus: "unverified",
      verification: {
        countryLaneRouteSchemaVersion: COUNTRY_LANE_ROUTE_SCHEMA_VERSION,
        reason: "configuration_changed",
        activateOnVerify: activate
      },
      verifiedAt: null,
      active: false
    });
    appendAudit({
      action: "collection_route_configured",
      actor: "user",
      targetType: "collection_route",
      targetId: stored.routeProfileId,
      details: publicRoute(database.getCollectionRoute(stored.routeProfileId))
    });
    return {
      route: publicRoute(database.getCollectionRoute(stored.routeProfileId)),
      verificationRequired: true,
      activationPending: activate,
      message: "一国一节点线路已保存；美国主出口和每条所选国家出口全部验证通过后才能启动任务"
    };
  },

  verify_collection_route: async ({ routeProfileId, userConfirmed }) => {
    if (userConfirmed !== true) throw rpcError("验证代理出口需要用户明确确认", "confirmation_required");
    if (!routeProfileId) throw rpcError("必须明确指定刚配置返回的 routeProfileId", "route_profile_id_required");
    if ([...activeRuns.keys()].some(
      (runId) => requiredRun(runId).config?.routeProfileId === routeProfileId
    )) {
      throw rpcError("该采集线路正被运行中的任务使用，不能重新验证", "collection_route_in_use");
    }
    if (activeQualification?.routeProfileId === routeProfileId) {
      throw rpcError("该采集线路正被资格核验批次使用，不能重新验证", "collection_route_in_use");
    }
    const route = requiredCollectionRoute(routeProfileId, { verified: false });
    try {
      const stored = await probeAndRecordDualRoute(route, "explicit_verification");
      const active = route.verification?.activateOnVerify === false
        ? stored
        : database.setActiveCollectionRoute(stored.routeProfileId);
      appendAudit({
        action: "collection_route_verified",
        actor: "user",
        targetType: "collection_route",
        targetId: route.routeProfileId,
        details: publicRoute(active)
      });
      return { route: publicRoute(active), verified: true, active: active.active };
    } catch (error) {
      if (["ROUTE_FINGERPRINT_MISMATCH", "ROUTE_FINGERPRINT_REQUIRED"].includes(safeErrorCode(error))) {
        appendAudit({
          action: "collection_route_verification_stale",
          actor: "user",
          targetType: "collection_route",
          targetId: route.routeProfileId,
          outcome: "rejected",
          details: { code: safeErrorCode(error) }
        });
        throw rpcError(
          "代理验证期间线路配置已变化，旧探测结果已丢弃；请对当前配置重新验证",
          "collection_route_changed",
          { routeProfileId: route.routeProfileId }
        );
      }
      appendAudit({
        action: "collection_route_verification_failed",
        actor: "user",
        targetType: "collection_route",
        targetId: route.routeProfileId,
        outcome: "failed",
        details: { code: safeErrorCode(error) }
      });
      throw error;
    }
  },

  collection_route_status: async ({ routeProfileId = null } = {}) => {
    const route = routeProfileId
      ? database.getCollectionRoute(routeProfileId)
      : (database.getActiveCollectionRoute() ?? database.listCollectionRoutes({ limit: 1 })[0]);
    if (!route) return { configured: false, route: null, sessions: {}, readiness: await collectionReadiness(null) };
    const states = Object.fromEntries(await Promise.all(
      ["tiktok_discovery", "collection_backstage"].map(async (target) => {
        const value = await routedSessionState(target, route);
        return [target, {
          running: value.status.running,
          authenticatedRequestReady: value.status.authenticatedRequestReady === true,
          routeCountry: value.status.routeCountry ?? null,
          expectedRouteCountry: value.expectedRouteCountry,
          restartRequired: value.restartRequired
        }];
      })
    ));
    return {
      configured: true,
      verified: isDualRouteVerified(route),
      route: publicRoute(route),
      sessions: states,
      readiness: await collectionReadiness(route)
    };
  },

  collection_backstage_preflight: async ({ routeProfileId = null } = {}) => {
    const route = requiredCollectionRoute(routeProfileId, { verified: true });
    return requireCollectionBackstagePreflight({ route });
  },

  create_discovery_run: async ({ source, mode = "full_auto", filters = {}, label = null, routeProfileId = null }) => {
    sourceTarget(source);
    if (!["semi_auto", "full_auto"].includes(mode)) throw rpcError(`不支持的模式：${mode}`, "unsupported_mode");
    if (!filters || typeof filters !== "object" || Array.isArray(filters)) {
      throw rpcError("采集筛选条件必须是对象", "invalid_filters");
    }
    const discoveryMethod = source === "tiktok_live"
      ? (filters.discoveryMethod ?? "regional_gift_ranking")
      : null;
    if (source === "tiktok_live"
      && !["regional_gift_ranking", "public_live_cards", 'tikhub_rankings'].includes(discoveryMethod)) {
      throw rpcError(`不支持的 TikTok 发现方式：${discoveryMethod}`, "unsupported_discovery_method");
    }
    if (source === "tiktok_live" && discoveryMethod === "regional_gift_ranking") {
      // Older MCP clients injected these two fixed defaults even when the
      // caller omitted them. Accept only the exact internal defaults and drop
      // them before validation/storage; any real page-control override still
      // fails closed.
      filters = { ...filters };
      for (const field of ["maxPages", "maxScrolls"]) {
        if (filters[field] === 20) delete filters[field];
      }
      const unsupportedFields = Object.keys(filters)
        .filter((key) => !REGIONAL_DISCOVERY_FILTERS.has(key))
        .sort();
      if (unsupportedFields.length) {
        throw rpcError(
          "原版地区采集链路的请求地址、代理、请求头、榜单参数和页面控制均由插件固定，不能由任务覆盖",
          "unsupported_regional_filter",
          { fields: unsupportedFields.map((value) => sanitizeTikTokText(value)) }
        );
      }
    }
    const unsupportedFields = Object.keys(filters)
      .filter((key) => !DISCOVERY_FILTERS.has(key))
      .sort();
    if (unsupportedFields.length) {
      throw rpcError(
        "采集任务只接受版本化筛选字段；页面地址、请求参数和认证材料不能由调用方提供",
        "unsupported_filter",
        { fields: unsupportedFields.map((value) => sanitizeTikTokText(value)) }
      );
    }
    if (discoveryMethod === 'tikhub_rankings') {
      const allowed = new Set(['discoveryMethod','marketRegion','countryCode','countryCodes','tikHubRankingKind','tikHubRankingPeriod','minFollowers','maxFollowers','maxCandidates']);
      const invalid = Object.keys(filters).filter(key => !allowed.has(key));
      if (invalid.length) throw rpcError('TikHub 榜单只接受固定榜单、时间和粉丝筛选，不能套用原版质量或卖家规则', 'unsupported_tikhub_filter', {fields:invalid});
      filters = { ...filters, tikHubRankingKind: filters.tikHubRankingKind ?? 'league', tikHubRankingPeriod: filters.tikHubRankingPeriod ?? 'current', maxCandidates: filters.maxCandidates ?? 100 };
      if (!TIKHUB_RANKING_PROFILE.rankingKinds.includes(filters.tikHubRankingKind)
        || !TIKHUB_RANKING_PROFILE.rankingPeriods.includes(filters.tikHubRankingPeriod)) throw rpcError('TikHub 榜单类型或时间无效', 'tikhub_request_invalid');
      const provider = await tikHubRankingTransport.status();
      if (provider.enabled === false && provider.state === 'disabled') throw rpcError('当前部署已关闭 TikHub 付费榜单，使用原生采集', 'tikhub_ranking_disabled');
      if (!provider.configured) throw rpcError('TikHub 本机配置尚未就绪', `tikhub_configuration_${provider.state === 'missing' ? 'missing' : 'invalid'}`);
    } else if (filters.tikHubRankingKind !== undefined || filters.tikHubRankingPeriod !== undefined) {
      throw rpcError('第三方榜单筛选只适用于 tikhub_rankings', 'unsupported_filter');
    }
    if (source === "tiktok_live" && discoveryMethod === "regional_gift_ranking" && filters.calibrationProbe === true) {
      const probeLimit = Number(filters.maxCandidates ?? 100);
      if (!Number.isSafeInteger(probeLimit) || probeLimit < 1 || probeLimit > 30) {
        throw rpcError("地区礼物榜校准探测的 maxCandidates 必须在 1 到 30 之间", "calibration_probe_limit");
      }
    }
    for (const [key, maximum] of [["maxCandidates", 5_000], ["maxFeedRounds", 1_000]]) {
      if (filters[key] !== undefined && (!Number.isSafeInteger(filters[key]) || filters[key] < 1 || filters[key] > maximum)) {
        throw rpcError(`${key} 必须为 1 到 ${maximum} 的整数`, "invalid_collection_boundary");
      }
    }
    if (source !== "svip_legacy" && (filters.recordedAfter || filters.recordedBefore)) {
      throw rpcError("记录时间筛选只适用于 svip_legacy 来源", "unsupported_filter");
    }
    if (filters.recordedAfter && filters.recordedBefore && filters.recordedAfter > filters.recordedBefore) {
      throw rpcError("recordedAfter 不能晚于 recordedBefore", "invalid_date_range");
    }
    // Persist only allowlisted, recursively sanitized filters. The svip
    // handle query remains usable, but its text is still credential/URL
    // redacted before it can enter SQLite, audit, or daemon state.
    const storedFilters = sanitizeTikTokValue({
      ...filters,
      ...(source === "tiktok_live" ? { discoveryMethod } : {})
    });
    if (source === "svip_legacy" && typeof filters.query === "string") {
      storedFilters.query = sanitizeTikTokText(filters.query).slice(0, 160);
    }
    const workflowPolicy = discoveryWorkflowPolicy({ source, mode, filters: storedFilters });
    let route = null;
    if (workflowPolicy.requiresVerifiedRoute) {
      route = requiredCollectionRoute(routeProfileId, { verified: true });
      assertRunRoute({ filters: storedFilters }, route);
      if (workflowPolicy.regional) selectedOriginalCountryLanes({ route: dualRouteDetails(route), filters: storedFilters });
    }
    const policyState = ensureQualificationPolicyState();
    const tikHubSeeds = workflowPolicy.tikHubRankings
      ? selectTikHubRankingSeeds(database.queryProspects({source:'tiktok_live',limit:2000}).map(normalizeCandidate), requestedCountryCodes(storedFilters))
      : null;
    if (workflowPolicy.tikHubRankings && (!tikHubSeeds?.length || tikHubSeeds.length > 3)) throw rpcError('TikHub 榜单必须选择一到三个现有国家种子', 'tikhub_request_invalid');
    const run = database.createRun({
      source,
      mode,
      filters: storedFilters,
      config: {
        ...(tikHubSeeds ? {tikhubRankingSeeds:tikHubSeeds} : {}),
        label: label === null ? null : sanitizeTikTokText(label),
        routeProfileId: route?.routeProfileId ?? null,
        routeFingerprint: route ? runtimeRouteFingerprint(route) : null,
        routeConfigurationFingerprint: route?.proxyFingerprint ?? null,
        qualificationPolicy: {
          hourlyTarget: policyState.hourlyTarget,
          dailyTarget: policyState.dailyTarget,
          hourlyHardLimit: DEFAULT_QUALIFICATION_POLICY.hourlyHardLimit,
          dailyHardLimit: DEFAULT_QUALIFICATION_POLICY.dailyHardLimit,
          intervalMinMs: DEFAULT_QUALIFICATION_POLICY.intervalMinMs,
          intervalMaxMs: DEFAULT_QUALIFICATION_POLICY.intervalMaxMs
        }
      }
    });
    appendAudit({
      action: "discovery_run_created",
      targetType: "run",
      targetId: run.runId,
      runId: run.runId,
      details: sanitizeTikTokValue({ source, mode, filters: storedFilters })
    });
    return { ...sanitizeTikTokValue(run), route: publicRoute(route) };
  },

  start_run: async ({ runId }) => startRun(runId),
  resume_run: async ({ runId }) => startRun(runId),

  pause_run: async ({ runId }) => {
    const run = requiredRun(runId);
    if (["completed", "cancelled"].includes(run.status)) {
      throw rpcError(`任务状态为 ${run.status}，不能暂停`, "invalid_run_state");
    }
    if (run.status === "paused" && !activeRuns.has(runId)) return run;
    const control = activeRuns.get(runId);
    if (!control) return database.updateRun(runId, { status: "paused" });
    control.requested = "pause";
    return database.updateRun(runId, { status: "pausing" });
  },

  cancel_run: async ({ runId, reason }) => {
    const run = requiredRun(runId);
    if (run.status === "completed") {
      throw rpcError("已完成任务不能改写为取消", "invalid_run_state");
    }
    if (run.status === "cancelled" && !activeRuns.has(runId)) return run;
    const control = activeRuns.get(runId);
    if (!control) {
      return database.updateRun(runId, {
        status: "cancelled",
        result: {
          ...(run.result ?? {}),
          cancellationReason: sanitizeTikTokText(reason)
        }
      });
    }
    control.requested = "cancel";
    control.reason = sanitizeTikTokText(reason);
    return database.updateRun(runId, { status: "pausing", progress: { cancellationRequested: true } });
  },

  get_run: async ({ runId }) => ({
    ...requiredRun(runId),
    checkpoints: database.listCheckpoints(runId),
    seedQueue: {
      feed: database.originalDiscoveryQueueStatus(runId, { seedKind: "feed" }),
      ranking: database.originalDiscoveryQueueStatus(runId, { seedKind: "ranking" })
    },
    active: activeRuns.has(runId)
  }),

  list_runs: async (params = {}) => database.listRuns(params),

  preview_collection_cleanup: async ({ cutoff } = {}) => {
    const normalizedCutoff = normalizeCollectionCleanupCutoff(cutoff);
    const preview = database.previewCollectionCleanup({ cutoff: normalizedCutoff });
    return {
      ...preview,
      ...issueCollectionCleanupConfirmation(normalizedCutoff, preview.previewHash),
      commitRequired: true,
      irreversible: true
    };
  },

  commit_collection_cleanup: async ({
    cutoff,
    previewHash,
    confirmationProof,
    userConfirmed
  } = {}) => {
    if (userConfirmed !== true) {
      throw rpcError("清理采集数据需要用户明确确认", "confirmation_required");
    }
    if (activeRuns.size > 0
      || activeQualification
      || originalRankingQueueSweeper.publicState().running) {
      throw rpcError(
        "采集、资格核验或持久队列扫描正在运行，当前不能清理采集数据",
        "collection_cleanup_busy"
      );
    }
    const normalizedCutoff = normalizeCollectionCleanupCutoff(cutoff);
    const normalizedPreviewHash = String(previewHash ?? "").trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(normalizedPreviewHash)) {
      throw rpcError("预览哈希无效，请重新预览", "collection_cleanup_preview_hash_invalid");
    }
    consumeCollectionCleanupConfirmation({
      cutoff: normalizedCutoff,
      previewHash: normalizedPreviewHash,
      confirmationProof
    });
    return database.commitCollectionCleanup({
      cutoff: normalizedCutoff,
      expectedPreviewHash: normalizedPreviewHash,
      actor: "user"
    });
  },

  preview_candidates: async (params = {}) => {
    const filters = candidateQueryFilters(params);
    const result = queryCandidateSet(filters);
    return {
      total: result.total,
      returnedExamples: Math.min(10, result.candidates.length),
      truncatedByStoreLimit: result.truncatedByStoreLimit,
      summary: summarizeCandidates(result.candidates),
      examples: result.candidates.slice(0, 10).map(anonymizeCandidate)
    };
  },

  query_candidates: async ({ reason, ...params }) => {
    const filters = candidateQueryFilters(params);
    const safeReason = sanitizeTikTokText(reason).slice(0, 300);
    const result = queryCandidateSet(filters);
    appendAudit({ action: "candidate_identities_read", actor: "agent", targetType: "candidate_set", targetId: filters.runId ?? filters.source ?? "all", runId: filters.runId, details: { reason: safeReason, returned: result.candidates.length, filters } });
    return { ...result, returned: result.candidates.length, auditReason: safeReason };
  },

  get_handoff: async ({ batchId, reason } = {}) => {
    const normalizedBatchId = String(batchId ?? "").trim();
    if (!/^[0-9a-f-]{36}$/i.test(normalizedBatchId)) {
      throw rpcError("交接批次 ID 无效", "invalid_handoff_batch_id");
    }
    if (typeof reason !== "string" || reason.trim().length < 5 || reason.length > 300) {
      throw rpcError("读取交接批次需要与用户请求相关的审计原因", "handoff_reason_required");
    }
    const stored = database.getHandoffBatch(normalizedBatchId);
    if (!stored) throw rpcError(`找不到交接批次：${normalizedBatchId}`, "handoff_not_found");
    const payload = stored.payload ?? {};
    const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
    const safeReason = sanitizeTikTokText(reason).slice(0, 300);
    appendAudit({
      action: "handoff_identities_read",
      actor: "agent",
      targetType: "handoff",
      targetId: normalizedBatchId,
      runId: stored.runId,
      details: { reason: safeReason, returned: candidates.length, status: stored.status }
    });
    return {
      batchId: stored.batchId,
      runId: stored.runId,
      status: stored.status,
      schemaVersion: payload.schemaVersion ?? null,
      datasetHash: payload.datasetHash ?? null,
      destination: payload.destination ?? stored.criteria?.destination ?? null,
      purpose: stored.purpose ?? payload.purpose ?? null,
      count: candidates.length,
      sendAuthorized: payload.sendAuthorized === true,
      candidates,
      auditReason: safeReason
    };
  },

  check_candidate_qualifications: async (params) => checkCandidateQualifications(params),

  creator_research_status: async () => tikHubResearch.status(),

  research_candidate: async ({ reason, ...params } = {}) => {
    if (typeof reason !== "string" || reason.trim().length < 5 || reason.length > 300) {
      throw rpcError("公开研究需要与用户请求相关的审计原因", "research_reason_required");
    }
    const result = await tikHubResearch.research(params);
    appendAudit({ action: "candidate_public_research", actor: "agent", targetType: "candidate", targetId: params.candidateId,
      details: { provider: "tikhub", state: result.state, reason: result.reason ?? null,
        allowPaid: params.allowPaid === true, paidRequests: result.paidRequests ?? 0, cacheHit: result.cacheHit === true } });
    return result;
  },

  prepare_handoff: async ({ destination, purpose, ...params }) => {
    const filters = candidateQueryFilters(params);
    const safeDestination = sanitizeTikTokText(destination).slice(0, 120);
    const safePurpose = sanitizeTikTokText(purpose).slice(0, 300);
    const result = queryCandidateSet(filters);
    if (!result.candidates.length) throw rpcError("筛选结果为空，未创建交接批次", "empty_candidate_set");
    if (result.candidates.some((candidate) => candidate.source === "tiktok_live"
      && (candidate.qualificationStatus !== "available"
        || candidate.qualificationSource !== "collection_backstage"
        || (filters.runId && candidate.qualificationRunId !== filters.runId)))) {
      throw rpcError(
        "TikTok 主播交接只能包含本次公会后台已确认可邀约、地区匹配的候选人；请先筛选 available 并核对来源",
        "unqualified_candidate_set"
      );
    }
    const handoff = buildHandoff({ candidates: result.candidates, runId: filters.runId ?? null, destination: safeDestination, purpose: safePurpose, filters });
    const stored = database.createHandoffBatch({
      batchId: handoff.batchId,
      idempotencyKey: `${safeDestination}:${handoff.datasetHash}`,
      runId: handoff.runId,
      status: "pending_review",
      purpose: safePurpose,
      criteria: { ...filters, destination: safeDestination, datasetHash: handoff.datasetHash },
      payload: handoff,
      candidateCount: handoff.count
    });
    appendAudit({ action: "handoff_prepared", targetType: "handoff", targetId: stored.batchId, runId: stored.runId, details: { datasetHash: stored.payload.datasetHash, count: stored.candidateCount, destination: safeDestination } });
    return {
      batchId: stored.batchId,
      runId: stored.runId,
      datasetHash: stored.payload.datasetHash,
      count: stored.candidateCount,
      destination: stored.payload.destination,
      status: stored.status,
      sendAuthorized: false
    };
  },

  commit_handoff: async ({ batchId, datasetHash, userConfirmed }) => {
    if (userConfirmed !== true) throw rpcError("交接需要用户明确确认", "confirmation_required");
    const stored = database.getHandoffBatch(batchId);
    if (!stored) throw rpcError(`找不到交接批次：${batchId}`, "handoff_not_found");
    if (stored.payload?.datasetHash !== datasetHash) throw rpcError("数据集哈希不匹配，拒绝交接可能已变化的名单", "dataset_hash_mismatch");
    const payload = { ...stored.payload, status: "approved_for_handoff", approvedAt: new Date().toISOString(), sendAuthorized: false };
    const filePath = await writeHandoffFile(payload);
    const outbox = database.createOutboxEvent({
      idempotencyKey: `handoff:${batchId}:${datasetHash}`,
      aggregateType: "handoff_batch",
      aggregateId: batchId,
      eventType: "candidate_batch.ready",
      payload: { filePath, batch: payload }
    });
    database.updateHandoffBatch(batchId, { status: "approved", approvedBy: "user", approvedAt: payload.approvedAt, payload });
    appendAudit({ action: "handoff_committed", actor: "user", targetType: "handoff", targetId: batchId, runId: stored.runId, details: { datasetHash, filePath, outboxId: outbox.outboxId } });
    return { batchId, datasetHash, status: "approved", outboxStatus: outbox.status, filePath, sendsMessages: false };
  },

  audit_events: async (params = {}) => database.listAuditEvents(params),

  shutdown: async () => {
    shutdownRequested = true;
    setTimeout(() => void shutdown("rpc"), 50).unref();
    return { shuttingDown: true };
  }
};

function authorized(request) {
  const provided = String(request.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const left = Buffer.from(provided);
  const right = Buffer.from(secret);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function readRequestBody(request, maximumBytes = 1_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > maximumBytes) {
        reject(rpcError("请求体过大", "request_too_large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

const server = http.createServer(async (request, response) => {
  response.setHeader("content-type", "application/json; charset=utf-8");
  if (request.method !== "POST" || request.url !== "/rpc") {
    response.statusCode = 404;
    response.end(JSON.stringify({ error: { code: "not_found", message: "Not found" } }));
    return;
  }
  if (!authorized(request)) {
    response.statusCode = 401;
    response.end(JSON.stringify({ error: { code: "unauthorized", message: "Unauthorized" } }));
    return;
  }
  let call;
  try {
    call = JSON.parse(await readRequestBody(request));
    if (shutdownRequested && call.method !== "shutdown") {
      throw rpcError("守护进程正在安全关闭，请稍后重试", "daemon_shutting_down");
    }
    const handler = methods[call.method];
    if (!handler) throw rpcError(`未知方法：${call.method}`, "method_not_found");
    const result = publicRpcValue(await handler(call.params ?? {}));
    response.statusCode = 200;
    response.end(JSON.stringify({ id: sanitizeTikTokValue(call.id ?? null), result }));
  } catch (error) {
    const errorCode = safeErrorCode(error);
    const errorMessage = safeErrorMessage(error);
    response.statusCode = error.code === "method_not_found" ? 404 : 400;
    response.end(JSON.stringify({
      id: sanitizeTikTokValue(call?.id ?? null),
      error: { code: errorCode, message: errorMessage, details: publicRpcValue(error?.details ?? null) }
    }));
    console.error(safeErrorStack(error));
  }
});

let shuttingDown = false;
async function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  shutdownRequested = true;
  stopOriginalQueueSweeper();
  collectionCleanupConfirmations.clear();
  console.error(`[daemon] shutting down: ${reason}`);
  for (const control of activeRuns.values()) {
    control.requested = "pause";
    control.reason = "daemon_shutdown";
  }
  // Stop accepting new work first and drain any in-flight RPCs. Only then
  // snapshot/close Agent connections so a late request cannot escape stopAll.
  await new Promise((resolve) => server.close(resolve));
  await sessions.stopAll().catch((error) => console.error(safeErrorStack(error)));
  const jobs = [...activeRuns.values()].map((control) => control.promise).filter(Boolean);
  if (jobs.length) {
    // Worker transports have bounded timeouts. Keep SQLite open until every
    // admitted worker has released its durable claim and session scope.
    await Promise.allSettled(jobs);
  }
  database.close();
  const state = await readFile(paths.statePath, "utf8").then(JSON.parse).catch(() => null);
  if (state?.pid === process.pid) await unlink(paths.statePath).catch(() => {});
  process.exit(0);
}

server.listen(0, "127.0.0.1", async () => {
  const address = server.address();
  const state = {
    protocolVersion: PROTOCOL_VERSION,
    daemonVersion: DAEMON_VERSION,
    pluginVersion,
    pid: process.pid,
    port: address.port,
    secret,
    startedAt: new Date().toISOString()
  };
  const temporaryPath = `${paths.statePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, paths.statePath);
  console.error(`[daemon] TKDesk ${DAEMON_VERSION} listening on 127.0.0.1:${address.port}`);
  startOriginalQueueSweeper();
});

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("uncaughtException", (error) => console.error(safeErrorStack(error)));
process.on("unhandledRejection", (error) => console.error(safeErrorStack(error)));
