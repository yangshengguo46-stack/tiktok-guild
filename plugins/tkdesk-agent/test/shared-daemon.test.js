import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DaemonClient } from "../mcp/core/daemon-client.js";
import { DatabaseStore } from "../mcp/core/database.js";
import {
  fingerprintRoutePolicy
} from "../mcp/core/route-policy.js";
import { runtimePaths } from "../mcp/core/runtime-paths.js";
import { originalCountryCatalog } from "../mcp/core/original-country-config.js";
import { TIKTOK_RANKING_TRANSPORT_PROFILE } from "../mcp/core/tiktok-ranking-transport.js";

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

function proxyDerivedFingerprintPaths(value, path = "$", found = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => proxyDerivedFingerprintPaths(item, `${path}[${index}]`, found));
    return found;
  }
  if (!value || typeof value !== "object") return found;
  for (const [key, nested] of Object.entries(value)) {
    if (isProxyDerivedFingerprintKey(key)) found.push(`${path}.${key}`);
    proxyDerivedFingerprintPaths(nested, `${path}.${key}`, found);
  }
  return found;
}

function assertNoProxyDerivedFingerprints(value) {
  assert.deepEqual(proxyDerivedFingerprintPaths(value), []);
}

test("reopen_login rejects missing confirmation or verified route before touching Chrome", async (t) => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "tkdesk-reopen-login-"));
  const client = new DaemonClient({ pluginRoot: process.cwd(), dataDirectory });
  t.after(async () => {
    await client.call("shutdown", {}).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 150));
    await rm(dataDirectory, { recursive: true, force: true });
  });

  await assert.rejects(
    client.call("reopen_login", { target: "collection_backstage" }),
    (error) => error.code === "confirmation_required"
  );
  await assert.rejects(
    client.call("reopen_login", { target: "collection_backstage", userConfirmed: true }),
    (error) => error.code === "collection_route_required"
  );
  const session = await client.call("session_status", { target: "collection_backstage" });
  assert.equal(session.browser.running, false);
});

test("missing mobile access and confirmed clear expose metadata only", async (t) => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "tkdesk-mobile-access-status-"));
  const pluginRoot = process.cwd();
  const paths = runtimePaths(dataDirectory);
  const client = new DaemonClient({ pluginRoot, dataDirectory });
  t.after(async () => {
    await client.call("shutdown", {}).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 150));
    await rm(dataDirectory, { recursive: true, force: true });
  });

  const coreStatus = await client.call("core_configuration_status");
  const mobileStatus = await client.call("mobile_authorization_status", {
    marketRegion: "MENA",
    countryCode: "SA"
  });
  assert.equal(coreStatus.state, "uninitialized");
  assert.equal(coreStatus.mobileAccess.state, "missing");
  assert.equal(mobileStatus.state, "missing");
  assert.equal(mobileStatus.usable, false);
  const defaultStatus = await client.call("mobile_authorization_status");
  for (const projection of [coreStatus.mobileAccess, mobileStatus, defaultStatus]) {
    assert.equal(projection.configurationState, "missing");
    assert.equal(projection.onlineAuthorization.state, "unknown");
    assert.equal(projection.onlineAuthorization.persistsAcrossRestart, false);
    assert.equal(projection.onlineVerified, false);
  }
  const runtime = await client.call("status");
  assert.equal(runtime.capabilities.discovery.regionalGiftRanking.authorizationOnlineReady, false);
  assert.equal(runtime.capabilities.discovery.regionalGiftRanking.productionReady, false);

  const cleared = await client.call("clear_mobile_authorization", { userConfirmed: true });
  assert.equal(cleared.cleared, true);
  assert.equal(cleared.state, "missing");
  const audit = await client.call("audit_events", { limit: 100 });
  const sentinel = "SYNTHETIC_MOBILE_SECRET_MUST_NOT_APPEAR";
  const serializedPublicValues = JSON.stringify({ coreStatus, mobileStatus, cleared, audit });
  assert.equal(serializedPublicValues.includes(sentinel), false);
  const databaseBytes = await readFile(paths.databasePath);
  assert.equal(databaseBytes.includes(Buffer.from(sentinel)), false);
  const daemonLog = await readFile(paths.logPath, "utf8").catch(() => "");
  assert.equal(daemonLog.includes(sentinel), false);
});

test("restart status exposes persisted candidates before fresh collection", async (t) => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "tkdesk-startup-inventory-"));
  const pluginRoot = process.cwd();
  const paths = runtimePaths(dataDirectory);
  const store = new DatabaseStore(paths.databasePath).init();
  const run = store.createRun({
    runId: "startup-existing-run",
    source: "tiktok_live",
    mode: "semi_auto",
    status: "partial",
    filters: { marketRegion: "MENA", discoveryMethod: "public_live_cards" }
  });
  const candidate = store.upsertProspect({
    runId: run.runId,
    source: "tiktok_live",
    userId: "7411111111111111111",
    handle: "startup.existing",
    observedAt: "2026-09-28T00:00:00.000Z"
  });
  store.recordQualificationBatch({
    batchId: "startup-existing-qualification",
    runId: run.runId,
    records: [{
      candidateId: candidate.prospect.candidateId,
      qualificationStatus: "available",
      observedAt: "2026-09-28T00:01:00.000Z"
    }]
  });
  store.close();

  const client = new DaemonClient({ pluginRoot, dataDirectory });
  t.after(async () => {
    await client.call("shutdown", {}).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 150));
    await rm(dataDirectory, { recursive: true, force: true });
  });

  const status = await client.call("status");
  assert.equal(status.startupInventory.decision, "use_existing_candidates");
  assert.equal(status.startupInventory.persistedCandidates.total, 1);
  assert.equal(status.startupInventory.persistedCandidates.available, 1);
  assert.deepEqual(status.startupInventory.candidateQuery, {
    source: "tiktok_live",
    qualificationStatus: "available",
    limit: 100,
    offset: 0
  });
  assert.equal(status.startupInventory.requiresFreshCollection, false);

  const candidates = await client.call("query_candidates", {
    source: "tiktok_live",
    qualificationStatus: "available",
    limit: 10,
    offset: 0,
    reason: "load persisted backstage-qualified candidates for broker handoff"
  });
  assert.equal(candidates.returned, 1);
  assert.equal(candidates.candidates[0].userId, "7411111111111111111");
  assert.equal(candidates.candidates[0].qualificationSource, "collection_backstage");
  assert.equal(candidates.candidates[0].profileUrl, "https://www.tiktok.com/@startup.existing");

  const handoff = await client.call("prepare_handoff", {
    source: "tiktok_live",
    qualificationStatus: "available",
    limit: 10,
    offset: 0,
    destination: "broker",
    purpose: "freeze the persisted invitable batch for review"
  });
  const verifier = new DatabaseStore(paths.databasePath).init();
  const storedHandoff = verifier.getHandoffBatch(handoff.batchId);
  verifier.close();
  assert.equal(storedHandoff.payload.schemaVersion, "tkdesk.candidate-handoff.v4");
  assert.equal(storedHandoff.payload.candidates[0].outreachStatus, "not_contacted");
  assert.equal(storedHandoff.payload.candidates[0].profileUrl, "https://www.tiktok.com/@startup.existing");

  const readHandoff = await client.call("get_handoff", {
    batchId: handoff.batchId,
    reason: "read the persisted handoff rows for broker review"
  });
  assert.equal(readHandoff.batchId, handoff.batchId);
  assert.equal(readHandoff.status, "pending_review");
  assert.equal(readHandoff.candidates[0].outreachStatus, "not_contacted");
  assert.equal(readHandoff.candidates[0].profileUrl, "https://www.tiktok.com/@startup.existing");
});

test("two agent clients converge on one daemon and one SQLite store", async (t) => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "tkdesk-shared-daemon-"));
  const pluginRoot = process.cwd();
  const first = new DaemonClient({ pluginRoot, dataDirectory });
  const second = new DaemonClient({ pluginRoot, dataDirectory });
  t.after(async () => {
    await first.call("shutdown", {}).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 150));
    await rm(dataDirectory, { recursive: true, force: true });
  });

  const [left, right] = await Promise.all([first.call("ping"), second.call("ping")]);
  assert.equal(left.pid, right.pid);

  const created = await first.call("create_discovery_run", {
    source: "tiktok_live",
    mode: "semi_auto",
    filters: { discoveryMethod: "public_live_cards", maxCandidates: 10 }
  });
  const readBack = await second.call("get_run", { runId: created.runId });
  assertNoProxyDerivedFingerprints(readBack);
  assert.equal(readBack.runId, created.runId);
  assert.equal(readBack.status, "queued");
  assert.equal(readBack.filters.discoveryMethod, "public_live_cards");

  await assert.rejects(
    first.call("create_discovery_run", {
      source: "tiktok_live",
      mode: "full_auto",
      filters: {
        discoveryMethod: "public_live_cards",
        marketRegion: "MENA",
        countryCodes: ["SA"],
        maxCandidates: 10
      }
    }),
    (error) => error.code === "collection_route_required"
  );

  for (const forbiddenRegionalFilter of [
    { liveTag: "LIVE" },
    { qualificationStatuses: ["available"] }
  ]) {
    await assert.rejects(
      first.call("create_discovery_run", {
        source: "tiktok_live",
        mode: "semi_auto",
        filters: {
          discoveryMethod: "regional_gift_ranking",
          marketRegion: "MENA",
          countryCodes: ["SA"],
          maxCandidates: 5,
          ...forbiddenRegionalFilter
        }
      }),
      (error) => error.code === "unsupported_regional_filter"
    );
  }
  await assert.rejects(
    first.call("create_discovery_run", {
      source: "tiktok_live",
      mode: "semi_auto",
      filters: {
        discoveryMethod: "regional_gift_ranking",
        marketRegion: "MENA",
        countryCodes: ["SA"],
        maxCandidates: 5,
        maxPages: 20,
        maxScrolls: 20
      }
    }),
    (error) => error.code === "collection_route_required"
  );
  const genericFiltersRemainAccepted = await first.call("create_discovery_run", {
    source: "svip_legacy",
    mode: "semi_auto",
    filters: {
      liveTag: "LIVE",
      qualificationStatuses: ["available"],
      maxCandidates: 5
    }
  });
  assert.equal(genericFiltersRemainAccepted.filters.liveTag, "LIVE");
  assert.deepEqual(genericFiltersRemainAccepted.filters.qualificationStatuses, ["available"]);

  await assert.rejects(
    first.call("create_discovery_run", {
      source: "tiktok_live",
      mode: "semi_auto",
      filters: {
        marketRegion: "MENA",
        countryCodes: ["SA"],
        maxCandidates: 10
      }
    }),
    (error) => error.code === "collection_route_required"
  );

  await assert.rejects(
    first.call("create_discovery_run", {
      source: "tiktok_live",
      mode: "full_auto",
      filters: { discoveryMethod: "regional_gift_ranking", maxCandidates: 10 }
    }),
    (error) => error.code === "collection_route_required"
  );

  await assert.rejects(
    first.call("create_discovery_run", {
      source: "tiktok_live",
      mode: "full_auto",
      filters: {
        discoveryMethod: "regional_gift_ranking",
        calibrationProbe: true,
        maxCandidates: 31
      }
    }),
    (error) => error.code === "calibration_probe_limit"
  );

  for (const [field, value] of Object.entries({
    startUrl: "https://www.tiktok.com/live",
    rankingViewKind: "top",
    topUrl: "https://example.com/webcast/ranklist/list/v2/",
    proxyServer: "http://127.0.0.1:17891",
    headers: { "sdk-version": "2" },
    rankTypeCode: 16,
    regionTypeCode: 1,
    gapInterval: 0
  })) {
    await assert.rejects(
      first.call("create_discovery_run", {
        source: "tiktok_live",
        mode: "full_auto",
        filters: {
          discoveryMethod: "regional_gift_ranking",
          calibrationProbe: true,
          maxCandidates: 30,
          [field]: value
        }
      }),
      (error) => {
        assert.equal(error.code, "unsupported_regional_filter");
        assert.deepEqual(error.details?.fields, [field]);
        return true;
      },
      `${field} must be rejected before collection-route validation`
    );
  }

  await assert.rejects(
    first.call("create_discovery_run", {
      source: "tiktok_live",
      mode: "full_auto",
      filters: {
        discoveryMethod: "regional_gift_ranking",
        calibrationProbe: true,
        maxCandidates: 30
      }
    }),
    (error) => error.code === "collection_route_required"
  );
});

test("collection backstage preflight derives MENA from the verified route and consumes zero qualification usage", async (t) => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "tkdesk-backstage-preflight-"));
  const pluginRoot = process.cwd();
  const paths = runtimePaths(dataDirectory);
  const routeProfileId = "95d6bd86-16c4-4bc3-a679-669746f80cd8";
  const store = new DatabaseStore(paths.databasePath).init();
  const route = store.upsertCollectionRoute({
    routeProfileId,
    marketRegion: "MENA",
    marketCountryCodes: ["SA"],
    discoveryCountry: "US",
    discoveryProxyServer: "http://127.0.0.1:19680",
    collectionLanes: [
      { countryCode: "SA", proxyServer: "http://127.0.0.1:19681" }
    ],
    proxyFingerprint: "sha256:preflight-route"
  });
  store.recordCollectionRouteVerification(route.routeProfileId, {
    status: "verified",
    proxyFingerprint: "sha256:preflight-route",
    discoveryProxyExitCountry: "US",
    proxyExitCountry: "SA",
    collectionProxyExitCountries: ["SA"]
  });
  store.setActiveCollectionRoute(route.routeProfileId);
  assert.equal(
    store.database.prepare("SELECT COUNT(*) AS count FROM qualification_batches").get().count,
    0
  );
  assert.equal(
    store.database.prepare("SELECT COUNT(*) AS count FROM qualification_policy_state").get().count,
    0
  );
  store.close();

  const client = new DaemonClient({ pluginRoot, dataDirectory });
  t.after(async () => {
    await client.call("shutdown", {}).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 150));
    await rm(dataDirectory, { recursive: true, force: true });
  });

  await assert.rejects(
    client.call("collection_backstage_preflight", {
      routeProfileId,
      expectedMarketRegion: "CCA",
      email: "PRECHECK_INPUT_EMAIL_SECRET@example.com",
      raw: "PRECHECK_INPUT_RAW_SECRET"
    }),
    (error) => {
      assert.equal(error.code, "authentication_required");
      assert.equal(error.details?.target, "collection_backstage");
      return true;
    }
  );

  const verifier = new DatabaseStore(paths.databasePath).init();
  assert.equal(
    verifier.database.prepare("SELECT COUNT(*) AS count FROM qualification_batches").get().count,
    0
  );
  assert.equal(
    verifier.database.prepare("SELECT COUNT(*) AS count FROM qualification_policy_state").get().count,
    1
  );
  const usage = verifier.getQualificationUsage();
  assert.equal(usage.hourlyUsed, 0);
  assert.equal(usage.dailyUsed, 0);
  const audits = verifier.listAuditEvents({
    action: "collection_backstage_preflight_checked",
    targetId: routeProfileId,
    limit: 10
  });
  assert.equal(audits.length, 1);
  assert.equal(audits[0].outcome, "failed");
  assert.equal(audits[0].details.expectedMarketRegion, "MENA");
  assert.equal(audits[0].details.observedMarketRegion, null);
  assert.equal(audits[0].details.qualificationRequestConsumed, false);
  assert.match(audits[0].details.routeFingerprint, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(
    JSON.stringify(audits[0]),
    /"CCA"|PRECHECK_INPUT_EMAIL_SECRET|PRECHECK_INPUT_RAW_SECRET|"(?:email|appId|unionId|raw)"\s*:/i
  );
  verifier.close();
});

test("semi-auto defaults to the verified regional route without requiring mobile authorization", async (t) => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "tkdesk-semi-auto-route-"));
  const pluginRoot = process.cwd();
  const paths = runtimePaths(dataDirectory);
  const routeProfileId = "2a84a5b4-4789-4ed1-8f2e-7eb665bd0cc2";
  const store = new DatabaseStore(paths.databasePath).init();
  const route = store.upsertCollectionRoute({
    routeProfileId,
    marketRegion: "MENA",
    marketCountryCodes: ["SA"],
    discoveryCountry: "US",
    discoveryProxyServer: "http://127.0.0.1:18980",
    collectionLanes: [
      { countryCode: "SA", proxyServer: "http://127.0.0.1:18981" }
    ],
    proxyFingerprint: "sha256:semi-auto-route"
  });
  store.recordCollectionRouteVerification(route.routeProfileId, {
    status: "verified",
    proxyFingerprint: "sha256:semi-auto-route",
    discoveryProxyExitCountry: "US",
    proxyExitCountry: "SA",
    collectionProxyExitCountries: ["SA"]
  });
  store.setActiveCollectionRoute(route.routeProfileId);
  store.close();

  const client = new DaemonClient({ pluginRoot, dataDirectory });
  t.after(async () => {
    await client.call("shutdown", {}).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 150));
    await rm(dataDirectory, { recursive: true, force: true });
  });

  const before = await client.call("status");
  const created = await client.call("create_discovery_run", {
    source: "tiktok_live",
    mode: "semi_auto",
    routeProfileId,
    filters: {
      marketRegion: "MENA",
      countryCodes: ["SA"],
      maxCandidates: 10
    }
  });
  const publicCardsAuto = await client.call("create_discovery_run", {
    source: "tiktok_live",
    mode: "full_auto",
    routeProfileId,
    filters: {
      discoveryMethod: "public_live_cards",
      marketRegion: "MENA",
      countryCodes: ["SA"],
      maxCandidates: 10
    }
  });
  const after = await client.call("status");

  assert.equal(created.filters.discoveryMethod, "regional_gift_ranking");
  assert.equal(created.config.routeProfileId, routeProfileId);
  assert.equal(created.status, "queued");
  const continuous = await client.call("create_discovery_run", {
    source: "tiktok_live", mode: "full_auto", routeProfileId,
    filters: { marketRegion: "MENA", countryCodes: ["SA"], countryDisplayNames: [{ countryCode: "SA", displayName: "MENA(中东)" }] }
  });
  assert.equal(continuous.status, "queued");
  assert.equal(continuous.filters.maxCandidates, undefined);
  assert.equal(continuous.filters.maxFeedRounds, undefined);
  assert.equal(continuous.filters.countryDisplayNames[0].displayName, "MENA(中东)");
  assert.equal(publicCardsAuto.status, "queued");
  assert.equal(publicCardsAuto.filters.discoveryMethod, "public_live_cards");
  assert.equal(publicCardsAuto.config.routeProfileId, routeProfileId);
  assert.equal(after.qualificationUsage.hourlyUsed, before.qualificationUsage.hourlyUsed);
  assert.equal(after.qualificationUsage.dailyUsed, before.qualificationUsage.dailyUsed);
  assert.equal(after.qualificationUsage.hourlyLimit, before.qualificationUsage.hourlyLimit);
  assert.equal(after.qualificationUsage.dailyLimit, before.qualificationUsage.dailyLimit);
  assert.equal(after.activeQualificationBatchId, null);
  assertNoProxyDerivedFingerprints(created);
});

test("full-auto TikTok handoff rejects a mixed set containing a region mismatch", async (t) => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "tkdesk-invitable-handoff-"));
  const pluginRoot = process.cwd();
  const paths = runtimePaths(dataDirectory);
  const store = new DatabaseStore(paths.databasePath).init();
  const run = store.createRun({
    source: "tiktok_live",
    mode: "full_auto",
    filters: { discoveryMethod: "public_live_cards", marketRegion: "MENA", countryCodes: ["SA"] }
  });
  const candidate = store.upsertProspect({
    runId: run.runId,
    source: "tiktok_live",
    handle: "outside.market",
    observedAt: "2026-09-26T00:00:00.000Z"
  });
  store.recordQualificationBatch({
    batchId: "outside-market-batch",
    runId: run.runId,
    records: [{
      candidateId: candidate.prospect.candidateId,
      qualificationStatus: "region_mismatch",
      observedAt: "2026-09-26T00:01:00.000Z"
    }]
  });
  store.close();
  const client = new DaemonClient({ pluginRoot, dataDirectory });
  t.after(async () => {
    await client.call("shutdown", {}).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 150));
    await rm(dataDirectory, { recursive: true, force: true });
  });
  const queried = await client.call("query_candidates", {
    runId: run.runId,
    limit: 10,
    reason: "verify per-candidate public LIVE-card provenance"
  });
  assert.equal(queried.candidates[0].discoveryMethod, "public_live_cards");
  await assert.rejects(
    client.call("prepare_handoff", {
      runId: run.runId,
      destination: "digital-employee",
      purpose: "only officially invitable creators",
      limit: 10
    }),
    (error) => error.code === "unqualified_candidate_set"
  );
});

test("restarted daemon discovers an expired recursive ranking seed without manual resume", async (t) => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "tkdesk-seed-queue-daemon-"));
  const pluginRoot = process.cwd();
  const paths = runtimePaths(dataDirectory);
  const client = new DaemonClient({ pluginRoot, dataDirectory });
  t.after(async () => {
    await client.call("shutdown", {}).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 150));
    await rm(dataDirectory, { recursive: true, force: true });
  });

  const created = await client.call("create_discovery_run", {
    source: "tiktok_live",
    mode: "semi_auto",
    filters: { discoveryMethod: "public_live_cards", maxCandidates: 10 }
  });
  const store = new DatabaseStore(paths.databasePath).init();
  store.enqueueOriginalDiscoverySeed({
    runId: created.runId,
    seedKind: "feed",
    identityKey: "SA:user:durable-feed",
    payload: { candidateId: "candidate-feed" }
  });
  store.enqueueOriginalDiscoverySeed({
    runId: created.runId,
    seedKind: "ranking",
    identityKey: "SA:user:durable-ranking",
    payload: { candidateId: "candidate-ranking" },
    countdownSeconds: 1
  });
  store.updateRun(created.runId, { status: "partial" });
  store.close();

  const beforeRestart = await client.call("get_run", { runId: created.runId });
  assert.equal(beforeRestart.seedQueue.feed.counts.pending, 1);
  assert.equal(beforeRestart.seedQueue.feed.dueCount, 1);
  assert.equal(beforeRestart.seedQueue.ranking.counts.pending, 1);
  assert.equal(beforeRestart.seedQueue.ranking.dueCount, 0);
  assert.equal(JSON.stringify(beforeRestart).includes("candidate-ranking"), false);

  await client.call("shutdown", {});
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  const afterRestart = await client.call("get_run", { runId: created.runId });
  assert.equal(afterRestart.seedQueue.feed.counts.pending, 1);
  assert.equal(afterRestart.seedQueue.ranking.counts.pending, 1);
  assert.equal(afterRestart.seedQueue.ranking.dueCount, 1);
  assert.equal(afterRestart.seedQueue.ranking.nextDueAt, beforeRestart.seedQueue.ranking.nextDueAt);

  const deadline = Date.now() + 2_000;
  let daemonStatus = null;
  while (Date.now() < deadline) {
    daemonStatus = await client.call("status");
    if (daemonStatus.durableQueueSweep?.lastScan?.trigger === "startup"
      && daemonStatus.durableQueueSweep.lastScan.dueRunCount === 1) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(daemonStatus.durableQueueSweep.lastScan.trigger, "startup");
  assert.equal(daemonStatus.durableQueueSweep.lastScan.dueRunCount, 1);
  assert.equal(
    daemonStatus.durableQueueSweep.lastScan.skippedCounts.collection_route_required,
    1,
    "the restarted daemon must pick up the due seed and fail closed only at the missing route preflight"
  );
});

test("five-minute durable queue sweeper scans due ranking work without manual resume", async (t) => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "tkdesk-auto-seed-sweep-"));
  const pluginRoot = process.cwd();
  const paths = runtimePaths(dataDirectory);
  const client = new DaemonClient({ pluginRoot, dataDirectory });
  const previousTestMode = process.env.TKDESK_AGENT_TEST_QUEUE_SWEEP;
  const previousInterval = process.env.TKDESK_AGENT_TEST_QUEUE_SWEEP_INTERVAL_MS;
  const restoreEnvironment = () => {
    if (previousTestMode === undefined) delete process.env.TKDESK_AGENT_TEST_QUEUE_SWEEP;
    else process.env.TKDESK_AGENT_TEST_QUEUE_SWEEP = previousTestMode;
    if (previousInterval === undefined) delete process.env.TKDESK_AGENT_TEST_QUEUE_SWEEP_INTERVAL_MS;
    else process.env.TKDESK_AGENT_TEST_QUEUE_SWEEP_INTERVAL_MS = previousInterval;
  };
  t.after(async () => {
    restoreEnvironment();
    await client.call("shutdown", {}).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 150));
    await rm(dataDirectory, { recursive: true, force: true });
  });

  process.env.TKDESK_AGENT_TEST_QUEUE_SWEEP = "1";
  process.env.TKDESK_AGENT_TEST_QUEUE_SWEEP_INTERVAL_MS = "40";
  try {
    await client.call("ping");
  } finally {
    restoreEnvironment();
  }

  const store = new DatabaseStore(paths.databasePath).init();
  store.createRun({
    runId: "run-auto-sweep-missing-route",
    source: "tiktok_live",
    mode: "full_auto",
    status: "partial",
    filters: {
      discoveryMethod: "regional_gift_ranking",
      marketRegion: "MENA",
      countryCodes: ["SA"],
      maxCandidates: 30
    },
    config: { routeProfileId: "missing-route" }
  });
  store.enqueueOriginalDiscoverySeed({
    runId: "run-auto-sweep-missing-route",
    seedKind: "ranking",
    identityKey: "SA:user:auto-sweep",
    payload: { candidateId: "AUTO_SWEEP_PAYLOAD_MUST_STAY_PRIVATE" },
    countdownSeconds: 1,
    at: "2020-01-01T00:00:00.000Z"
  });
  store.close();

  const deadline = Date.now() + 3_000;
  let status = null;
  while (Date.now() < deadline) {
    status = await client.call("status");
    if (status.durableQueueSweep?.lastScan?.dueRunCount === 1
      && status.durableQueueSweep.lastScan.skippedCounts?.collection_route_required >= 1) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  assert.equal(status.durableQueueSweep.intervalMs, 40);
  assert.ok(status.durableQueueSweep.scanCount >= 2);
  assert.equal(status.durableQueueSweep.lastScan.dueRunCount, 1);
  assert.equal(
    status.durableQueueSweep.lastScan.skippedCounts.collection_route_required,
    1
  );
  assert.equal(status.durableQueueSweep.payloadExposed, false);
  assert.equal(JSON.stringify(status).includes("AUTO_SWEEP_PAYLOAD_MUST_STAY_PRIVATE"), false);

  const run = await client.call("get_run", { runId: "run-auto-sweep-missing-route" });
  assert.equal(run.status, "partial");
  assert.equal(run.seedQueue.ranking.counts.pending, 1);
  assert.equal(JSON.stringify(run).includes("AUTO_SWEEP_PAYLOAD_MUST_STAY_PRIVATE"), false);
});

test("legacy ranking scores stay unit-unknown and never gain USD estimates through query or handoff", async (t) => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "tkdesk-legacy-score-unit-"));
  const pluginRoot = process.cwd();
  const paths = runtimePaths(dataDirectory);
  const store = new DatabaseStore(paths.databasePath).init();
  const run = store.createRun({ source: "svip_legacy", mode: "semi_auto" });
  store.upsertProspect({
    userId: "legacy-score-user",
    handle: "legacy-score",
    source: "svip_legacy",
    runId: run.runId,
    observedAt: "2026-08-23T00:00:00.000Z",
    data: {
      diamondCurrent: 50_000,
      diamondFieldUnits: {
        current: "unknown_rank_score",
        period: "unknown_rank_score",
        rankingRecord: "unknown_rank_score",
        historicalMax: "unknown_rank_score"
      }
    }
  });
  store.close();

  const client = new DaemonClient({ pluginRoot, dataDirectory });
  t.after(async () => {
    await client.call("shutdown", {}).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 150));
    await rm(dataDirectory, { recursive: true, force: true });
  });

  const queried = await client.call("query_candidates", {
    runId: run.runId,
    limit: 10,
    reason: "verify legacy score unit gate"
  });
  assert.equal(queried.candidates[0].diamondCurrent, 50_000);
  assert.equal(queried.candidates[0].diamondFieldUnits.current, "unknown_rank_score");
  assert.equal(queried.candidates[0].diamondUsdEstimates.current, null);

  await assert.rejects(
    client.call("prepare_handoff", {
      runId: run.runId,
      destination: "digital-employee",
      purpose: "verify strict direct RPC boundary",
      limit: 10,
      offset: 0,
      token: "HANDOFF_FILTER_SECRET"
    }),
    (error) => error.code === "unsupported_candidate_filter"
  );

  const handoff = await client.call("prepare_handoff", {
    runId: run.runId,
    destination: "digital-employee",
    purpose: "verify legacy score unit gate",
    limit: 10,
    offset: 0
  });
  const verifier = new DatabaseStore(paths.databasePath).init();
  const storedHandoff = verifier.getHandoffBatch(handoff.batchId);
  verifier.close();
  assert.equal(storedHandoff.payload.candidates[0].diamondCurrent, 50_000);
  assert.equal(storedHandoff.payload.candidates[0].diamondFieldUnits.current, "unknown_rank_score");
  assert.equal(storedHandoff.payload.candidates[0].diamondUsdEstimates.current, null);
});

test("semi-auto not-queried evidence does not overwrite an existing backstage qualification", async (t) => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "tkdesk-semi-auto-qualification-"));
  const pluginRoot = process.cwd();
  const paths = runtimePaths(dataDirectory);
  const store = new DatabaseStore(paths.databasePath).init();
  const qualifiedRun = store.createRun({ source: "tiktok_live", mode: "full_auto" });
  const original = store.upsertProspect({
    runId: qualifiedRun.runId,
    source: "tiktok_live",
    userId: "7411111111111111111",
    handle: "semi.preserved",
    observedAt: "2026-08-22T00:00:00.000Z"
  });
  store.recordQualificationBatch({
    batchId: "semi-preserved-qualification",
    runId: qualifiedRun.runId,
    records: [{
      candidateId: original.prospect.candidateId,
      qualificationStatus: "available",
      observedAt: "2026-08-22T00:01:00.000Z"
    }]
  });
  const semiRun = store.createRun({
    source: "tiktok_live",
    mode: "semi_auto",
    filters: { discoveryMethod: "regional_gift_ranking" }
  });
  store.upsertProspect({
    runId: semiRun.runId,
    source: "tiktok_live",
    userId: "7411111111111111111",
    handle: "semi.preserved",
    invitationEligibility: null,
    observedAt: "2026-08-23T00:00:00.000Z",
    data: {
      workflowMode: "semi_auto",
      qualificationQueryState: "not_queried",
      automaticQualificationPerformed: false
    },
    observation: {
      runId: semiRun.runId,
      source: "tiktok_live",
      observedAt: "2026-08-23T00:00:00.000Z",
      data: {
        workflowMode: "semi_auto",
        qualificationQueryState: "not_queried",
        automaticQualificationPerformed: false
      },
      evidence: {
        workflow: {
          schemaVersion: "tkdesk.semi-auto-workflow.v1",
          workflowMode: "semi_auto",
          qualificationQueryState: "not_queried",
          automaticQualificationPerformed: false,
          recursiveRankingExpansionPerformed: false
        }
      }
    }
  });
  store.close();

  const client = new DaemonClient({ pluginRoot, dataDirectory });
  t.after(async () => {
    await client.call("shutdown", {}).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 150));
    await rm(dataDirectory, { recursive: true, force: true });
  });

  const queried = await client.call("query_candidates", {
    runId: semiRun.runId,
    limit: 10,
    reason: "verify semi-auto qualification preservation"
  });
  assert.equal(queried.total, 1);
  assert.equal(queried.candidates[0].workflowMode, "semi_auto");
  assert.equal(queried.candidates[0].qualificationQueryState, "not_queried");
  assert.equal(queried.candidates[0].automaticQualificationPerformed, false);
  assert.equal(queried.candidates[0].qualificationStatus, null);
  assert.equal(queried.candidates[0].qualificationSource, null);

  const verifier = new DatabaseStore(paths.databasePath).init();
  const preserved = verifier.getProspect(original.prospect.candidateId);
  verifier.close();
  assert.equal(preserved.latestQualificationObservation.invitationEligibility, "available");
  assert.equal(preserved.latestQualificationObservation.source, "collection_backstage");
});

test("failed ranking cascade and legacy v1 enrichment evidence never unlock full auto", async (t) => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "tkdesk-ranking-failed-cascade-"));
  const pluginRoot = process.cwd();
  const paths = runtimePaths(dataDirectory);
  const store = new DatabaseStore(paths.databasePath).init();
  const route = store.upsertCollectionRoute({
    routeProfileId: "route-sa-failed-cascade",
    marketRegion: "MENA",
    marketCountryCodes: ["AE", "SA"],
    discoveryCountry: "US",
    discoveryProxyServer: "http://127.0.0.1:18180",
    collectionLanes: [
      { countryCode: "SA", proxyServer: "http://127.0.0.1:18181" }
    ],
    proxyFingerprint: "sha256:sa-failed-cascade"
  });
  store.recordCollectionRouteVerification(route.routeProfileId, {
    status: "verified",
    proxyFingerprint: "sha256:sa-failed-cascade",
    discoveryProxyExitCountry: "US",
    proxyExitCountry: "SA",
    collectionProxyExitCountries: ["SA"]
  });
  store.setActiveCollectionRoute(route.routeProfileId);
  const routeFingerprint = fingerprintRoutePolicy({
    marketRegion: "MENA",
    marketCountryCodes: ["AE", "SA"],
    discoveryCountry: "US",
    discoveryProxyServer: "http://127.0.0.1:18180",
    discoveryProxyExitCountry: "US",
    collectionLanes: [
      { countryCode: "SA", proxyServer: "http://127.0.0.1:18181" }
    ],
    collectionProxyExitCountries: ["SA"]
  });
  const run = store.createRun({
    source: "tiktok_live",
    mode: "full_auto",
    filters: {
      discoveryMethod: "regional_gift_ranking",
      marketRegion: "MENA",
      countryCode: "SA"
    },
    config: {
      routeProfileId: route.routeProfileId,
      routeFingerprint,
      routeConfigurationFingerprint: "sha256:sa-failed-cascade"
    }
  });
  store.updateRun(run.runId, {
    status: "completed",
    result: {
      discovery: {
        found: 1,
        sourceType: "tiktok_webcast_feed_room_projection",
        triggerKind: "original_pc_web_feed",
        listProducing: true,
        pcWebWorkers: 1,
        dataProcessorWorkers: 4,
        workIdAffinity: "feed_1_3_rank_descendants_4",
        dataProcessorEvidenceVersion: "original-data-processor-enrichment-v1",
        adapterEvidenceVersion: "original-pc-web-feed-v1"
      },
      fullAuto: {
        cascade: {
          implementation: "original_pcweb_live_ranking_loop",
          rounds: [{
            found: 0,
            stoppedReason: "ranking_mobile_authorization_required",
            triggerKind: "original_room_seed_direct_request",
            endpointFingerprint: TIKTOK_RANKING_TRANSPORT_PROFILE.endpointFingerprint,
            rankTypeCode: 16,
            regionTypeCode: 1,
            gapIntervals: [0, -1],
            rankingPairComplete: false,
            sourceType: "tiktok_rank_view",
            adapterEvidenceVersion: "regional-ranking-request-semantics-v2",
            listProducing: true,
            rankingViewKind: "top",
            complete: false
          }]
        }
      }
    }
  });
  const legacyEvidenceRun = store.createRun({
    source: "tiktok_live",
    mode: "full_auto",
    filters: {
      discoveryMethod: "regional_gift_ranking",
      marketRegion: "MENA",
      countryCode: "SA"
    },
    config: {
      routeProfileId: route.routeProfileId,
      routeFingerprint,
      routeConfigurationFingerprint: "sha256:sa-failed-cascade"
    }
  });
  store.updateRun(legacyEvidenceRun.runId, {
    status: "completed",
    result: {
      discovery: {
        found: 1,
        sourceType: "tiktok_webcast_feed_room_projection",
        triggerKind: "original_pc_web_feed",
        listProducing: true,
        pcWebWorkers: 1,
        dataProcessorWorkers: 4,
        workIdAffinity: "feed_1_3_rank_descendants_4",
        dataProcessorEvidenceVersion: "original-data-processor-enrichment-v1",
        adapterEvidenceVersion: "original-pc-web-feed-v1"
      },
      fullAuto: {
        cascade: {
          implementation: "original_pcweb_live_ranking_loop",
          rounds: [{
            found: 1,
            triggerKind: "original_room_seed_direct_request",
            endpointFingerprint: TIKTOK_RANKING_TRANSPORT_PROFILE.endpointFingerprint,
            rankTypeCode: 16,
            regionTypeCode: 1,
            gapIntervals: [0, -1],
            rankingPairComplete: true,
            sourceType: "tiktok_rank_view",
            adapterEvidenceVersion: "regional-ranking-request-semantics-v2",
            listProducing: true,
            rankingViewKind: "top",
            complete: true
          }]
        }
      }
    }
  });
  store.close();

  const client = new DaemonClient({ pluginRoot, dataDirectory });
  t.after(async () => {
    await client.call("shutdown", {}).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 150));
    await rm(dataDirectory, { recursive: true, force: true });
  });

  const status = await client.call("status");
  assert.equal(status.capabilities.modes.full_auto, false);
  assert.equal(status.capabilities.modes.default, "calibration_required");
  assert.equal(status.capabilities.discovery.regionalGiftRanking.operationalReady, false);
  assert.equal(status.capabilities.discovery.regionalGiftRanking.lastValidatedRunId, null);
});

test("regional ranking validation is bound to the active country-lane map and evidence version", async (t) => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "tkdesk-ranking-validation-route-"));
  const pluginRoot = process.cwd();
  const paths = runtimePaths(dataDirectory);
  const store = new DatabaseStore(paths.databasePath).init();
  const menaRoute = store.upsertCollectionRoute({
    routeProfileId: "route-mena",
    marketRegion: "MENA",
    marketCountryCodes: ["SA", "QA", "EG"],
    discoveryCountry: "US",
    discoveryProxyServer: "http://127.0.0.1:18080",
    collectionLanes: [
      { countryCode: "SA", proxyServer: "http://127.0.0.1:18081" },
      { countryCode: "QA", proxyServer: "http://127.0.0.1:18082" },
      { countryCode: "EG", proxyServer: "http://127.0.0.1:18083" }
    ],
    proxyFingerprint: "sha256:mena"
  });
  store.recordCollectionRouteVerification(menaRoute.routeProfileId, {
    status: "verified",
    proxyFingerprint: "sha256:mena",
    discoveryProxyExitCountry: "US",
    proxyExitCountry: "SA",
    collectionProxyExitCountries: ["SA", "QA", "EG"]
  });
  store.setActiveCollectionRoute(menaRoute.routeProfileId);
  const routeFingerprint = fingerprintRoutePolicy({
    marketRegion: "MENA",
    marketCountryCodes: ["SA", "QA", "EG"],
    discoveryCountry: "US",
    discoveryProxyServer: "http://127.0.0.1:18080",
    discoveryProxyExitCountry: "US",
    collectionLanes: [
      { countryCode: "SA", proxyServer: "http://127.0.0.1:18081" },
      { countryCode: "QA", proxyServer: "http://127.0.0.1:18082" },
      { countryCode: "EG", proxyServer: "http://127.0.0.1:18083" }
    ],
    collectionProxyExitCountries: ["SA", "QA", "EG"]
  });
  const run = store.createRun({
    source: "tiktok_live",
    mode: "full_auto",
    filters: {
      discoveryMethod: "regional_gift_ranking",
      marketRegion: "MENA",
      countryCodes: ["SA", "QA", "EG"]
    },
    config: {
      routeProfileId: menaRoute.routeProfileId,
      routeFingerprint,
      routeConfigurationFingerprint: "sha256:mena"
    }
  });
  store.updateRun(run.runId, {
    status: "completed",
    result: {
      discovery: {
        found: 1,
        sourceType: "tiktok_original_country_discovery_union",
        triggerKind: "original_pc_web_feed_and_mobile_processor_fixed_country_lists",
        listProducing: true,
        selectionComplete: true,
        mobileTemplateAttempted: true,
        mobileTemplateComplete: true,
        mobileTemplateEvidenceVersion: TIKTOK_RANKING_TRANSPORT_PROFILE.originalTemplateBundleEvidenceVersion,
        pcWebWorkers: 3,
        dataProcessorWorkers: 4,
        workIdAffinity: "feed_1_3_rank_descendants_4",
        dataProcessorEvidenceVersion: "original-data-processor-enrichment-v3",
        adapterEvidenceVersion: "original-country-discovery-union-v1"
      },
      fullAuto: {
        complete: true,
        cascade: {
          implementation: "original_pcweb_live_ranking_loop",
          complete: true,
          rounds: [{
            found: 1,
            triggerKind: "original_room_seed_direct_request",
            endpointFingerprint: TIKTOK_RANKING_TRANSPORT_PROFILE.endpointFingerprint,
            rankTypeCode: 16,
            regionTypeCode: 1,
            gapIntervals: [0, -1],
            rankingPairComplete: true,
            sourceType: "tiktok_rank_view",
            adapterEvidenceVersion: "regional-ranking-request-semantics-v2",
            listProducing: true,
            rankingViewKind: "top",
            complete: true
          }]
        }
      }
    }
  });
  const derived = store.upsertProspect({
    runId: run.runId,
    source: "tiktok_live",
    userId: "7412345678901234567",
    secUid: "MS4wLjABAAAA_validated_derived",
    handle: "validated.derived",
    roomId: "7498765432109876543",
    marketRegion: "MENA",
    creatorCountryCode: "SA",
    data: {
      workId: 4,
      dataProcessorStatus: "ready",
      dataProcessorComplete: true,
      dataProcessorEvidenceVersion: "original-data-processor-enrichment-v3",
      dataProcessorStages: [
        "basic", "country", "ranking", "top_score", "anchor_level"
      ],
      topCode: 1,
      originalScoreEvidence: {
        state: "ready",
        evidenceVersion: "tkdesk.original-anchor-scores.v4"
      }
    }
  });
  store.recordQualificationBatch({
    batchId: "validated-derived-qualification",
    runId: run.runId,
    records: [{
      candidateId: derived.prospect.candidateId,
      qualificationStatus: "available",
      marketRegion: "MENA",
      creatorCountryCode: "SA"
    }]
  });
  const resumableRun = store.createRun({
    source: "tiktok_live",
    mode: "full_auto",
    filters: {
      discoveryMethod: "regional_gift_ranking",
      marketRegion: "MENA",
      countryCodes: ["SA"]
    },
    config: {
      routeProfileId: menaRoute.routeProfileId,
      routeFingerprint,
      routeConfigurationFingerprint: "sha256:mena"
    }
  });
  store.updateRun(resumableRun.runId, { status: "paused" });
  store.close();

  const client = new DaemonClient({ pluginRoot, dataDirectory });
  t.after(async () => {
    await client.call("shutdown", {}).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 150));
    await rm(dataDirectory, { recursive: true, force: true });
  });

  const accessBlocked = await client.call("status");
  assert.equal(accessBlocked.capabilities.discovery.regionalGiftRanking.liveSampleValidated, true);
  assert.equal(accessBlocked.capabilities.discovery.regionalGiftRanking.codePresent, true);
  assert.equal(accessBlocked.capabilities.discovery.regionalGiftRanking.liveValidated, true);
  assert.deepEqual(
    accessBlocked.capabilities.discovery.regionalGiftRanking.liveValidatedCountries,
    ["SA", "QA", "EG"]
  );
  assert.deepEqual(
    accessBlocked.capabilities.discovery.regionalGiftRanking.operationalCountries,
    []
  );
  assert.equal(
    accessBlocked.capabilities.discovery.regionalGiftRanking.implementationStatus,
    "live_validated_authorization_required"
  );
  assert.equal(
    accessBlocked.capabilities.discovery.regionalGiftRanking.countryFeedOperational,
    true
  );
  assert.equal(accessBlocked.capabilities.discovery.regionalGiftRanking.authorizationReady, false);
  assert.equal(accessBlocked.capabilities.discovery.regionalGiftRanking.operationalReady, false);
  assert.equal(accessBlocked.capabilities.modes.full_auto, false);
  assert.equal(accessBlocked.capabilities.modes.default, "authorization_required");
  const normal = await client.call("create_discovery_run", {
    source: "tiktok_live", mode: "full_auto",
    filters: { discoveryMethod: "regional_gift_ranking", marketRegion: "MENA", countryCodes: ["SA"], maxCandidates: 10 },
    routeProfileId: menaRoute.routeProfileId
  });
  assert.equal(normal.status, "queued");
  await assert.rejects(client.call("resume_run", { runId: resumableRun.runId }), error => {
    assert.notEqual(error.code, "ranking_mobile_authorization_required");
    return /proxy|route/i.test(error.code);
  });
  const stillPaused = await client.call("get_run", { runId: resumableRun.runId });
  assert.notEqual(stillPaused.error?.code, "ranking_mobile_authorization_required");

  const evidenceStore = new DatabaseStore(paths.databasePath).init();
  evidenceStore.database.prepare(`
    UPDATE prospect_observations SET data_json = '{}'
    WHERE run_id = ? AND source <> 'collection_backstage'
  `).run(run.runId);
  evidenceStore.close();
  const summaryOnly = await client.call("status");
  assert.equal(summaryOnly.capabilities.discovery.regionalGiftRanking.liveSampleValidated, false);
  assert.equal(summaryOnly.capabilities.discovery.regionalGiftRanking.lastValidatedRunId, null);

  const routeStore = new DatabaseStore(paths.databasePath).init();
  const changedRoute = routeStore.upsertCollectionRoute({
    routeProfileId: "route-mena-changed",
    marketRegion: "MENA",
    marketCountryCodes: ["SA", "QA", "EG"],
    discoveryCountry: "US",
    discoveryProxyServer: "http://127.0.0.1:18080",
    collectionLanes: [
      { countryCode: "SA", proxyServer: "http://127.0.0.1:18181" },
      { countryCode: "QA", proxyServer: "http://127.0.0.1:18182" },
      { countryCode: "EG", proxyServer: "http://127.0.0.1:18183" }
    ],
    proxyFingerprint: "sha256:mena-changed"
  });
  routeStore.recordCollectionRouteVerification(changedRoute.routeProfileId, {
    status: "verified",
    proxyFingerprint: "sha256:mena-changed",
    discoveryProxyExitCountry: "US",
    proxyExitCountry: "SA",
    collectionProxyExitCountries: ["SA", "QA", "EG"]
  });
  routeStore.setActiveCollectionRoute(changedRoute.routeProfileId);
  routeStore.close();

  const invalidated = await client.call("status");
  assert.equal(invalidated.capabilities.modes.full_auto, false);
  assert.equal(invalidated.capabilities.modes.default, "calibration_required");
  assert.equal(invalidated.capabilities.discovery.regionalGiftRanking.operationalReady, false);
  assert.equal(invalidated.capabilities.discovery.regionalGiftRanking.lastValidatedRunId, null);
});

test("handoff freezes exactly the requested preview range", async (t) => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "tkdesk-handoff-range-"));
  const pluginRoot = process.cwd();
  const paths = runtimePaths(dataDirectory);
  const store = new DatabaseStore(paths.databasePath).init();
  const run = store.createRun({ source: "svip_legacy", mode: "semi_auto" });
  for (let index = 0; index < 60; index += 1) {
    store.upsertProspect({
      userId: `user-${index}`,
      handle: `creator-${index}`,
      displayName: `Creator ${index}`,
      source: "svip_legacy",
      runId: run.runId,
      observedAt: `2026-08-22 10:${String(index).padStart(2, "0")}:00`
    });
  }
  store.close();

  const client = new DaemonClient({ pluginRoot, dataDirectory });
  t.after(async () => {
    await client.call("shutdown", {}).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 150));
    await rm(dataDirectory, { recursive: true, force: true });
  });

  const preview = await client.call("preview_candidates", { runId: run.runId, limit: 50, offset: 0 });
  const handoff = await client.call("prepare_handoff", {
    runId: run.runId,
    limit: 50,
    offset: 0,
    destination: "digital-employee",
    purpose: "QA exact preview range"
  });
  assert.equal(preview.summary.total, 50);
  assert.equal(handoff.count, 50);
  assert.equal(handoff.sendAuthorized, false);
});

test("daemon rejects undeclared filters and sanitizes allowlisted filters before persistence", async (t) => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "tkdesk-filter-at-rest-"));
  const pluginRoot = process.cwd();
  const paths = runtimePaths(dataDirectory);
  const client = new DaemonClient({ pluginRoot, dataDirectory });
  let stopped = false;
  t.after(async () => {
    if (!stopped) {
      await client.call("shutdown", {}).catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    await rm(dataDirectory, { recursive: true, force: true });
  });

  await assert.rejects(
    client.call("create_discovery_run", {
      source: "tiktok_live",
      mode: "semi_auto",
      filters: {
        discoveryMethod: "public_live_cards",
        startUrl: "https://www.tiktok.com/live?access_token=FILTER_URL_SECRET#cookie=FILTER_HASH_SECRET",
        search: "FILTER_SEARCH_SECRET",
        email: "filter-owner@example.com",
        token: "FILTER_TOKEN_SECRET"
      }
    }),
    (error) => error.code === "unsupported_filter"
  );

  const created = await client.call("create_discovery_run", {
    source: "svip_legacy",
    mode: "semi_auto",
    filters: {
      query: "@alice token=FILTER_TOKEN_SECRET",
      maxCandidates: 50,
      maxScrolls: 7,
      region: "US",
      highQualityMode: true
    }
  });
  assert.equal(created.filters.startUrl, undefined);
  assert.equal(created.filters.query, "[REDACTED]");
  assert.equal(created.filters.maxCandidates, 50);
  assert.equal(created.filters.maxScrolls, 7);
  assert.equal(created.filters.region, "US");
  assert.equal(created.filters.highQualityMode, true);

  await client.call("shutdown", {});
  stopped = true;
  await new Promise((resolve) => setTimeout(resolve, 250));
  const store = new DatabaseStore(paths.databasePath).init();
  const persisted = store.getRun(created.runId);
  store.close();

  assert.equal(persisted.filters.startUrl, undefined);
  assert.equal(persisted.filters.query, "@alice [REDACTED]");
  assert.equal(persisted.filters.search, undefined);
  assert.equal(persisted.filters.email, undefined);
  assert.equal(persisted.filters.token, undefined);
  assert.equal(persisted.filters.maxCandidates, 50);
  assert.equal(persisted.filters.maxScrolls, 7);
  assert.equal(persisted.filters.region, "US");
  assert.equal(persisted.filters.highQualityMode, true);
  assert.doesNotMatch(
    JSON.stringify(persisted),
    /FILTER_URL_SECRET|FILTER_HASH_SECRET|FILTER_SEARCH_SECRET|FILTER_TOKEN_SECRET|filter-owner@example\.com/
  );
});

test("daemon cleanup requires a live preview proof and preserves login, audit, and committed handoff state", async (t) => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "tkdesk-cleanup-rpc-"));
  const pluginRoot = process.cwd();
  const paths = runtimePaths(dataDirectory);
  const oldAt = "2026-01-01T00:00:00.000Z";
  const cutoff = "2026-08-01T00:00:00.000Z";
  const store = new DatabaseStore(paths.databasePath, {
    clock: () => new Date(oldAt)
  }).init();
  store.upsertSession({
    sessionKey: "protected-login-material",
    kind: "browser_profile",
    profilePath: "/isolated/protected-profile",
    status: "authenticated",
    authenticatedAt: oldAt
  });
  store.createRun({
    runId: "run-cleanup-rpc",
    source: "tiktok_live",
    status: "completed",
    createdAt: oldAt
  });
  store.saveCheckpoint("run-cleanup-rpc", "old-page", { page: 9 });
  store.enqueueOriginalDiscoverySeed({
    runId: "run-cleanup-rpc",
    seedKind: "feed",
    identityKey: "SA:cleanup-rpc",
    payload: { payloadSentinel: "CLEANUP_QUEUE_PAYLOAD_MUST_NOT_LEAK" },
    at: oldAt
  });
  store.upsertProspect({
    candidateId: "candidate-cleanup-rpc",
    runId: "run-cleanup-rpc",
    source: "tiktok_live",
    handle: "candidate-cleanup-rpc",
    observedAt: oldAt,
    observationKey: "observation:cleanup-rpc"
  });
  store.createHandoffBatch({
    batchId: "handoff-cleanup-rpc-approved",
    runId: "run-cleanup-rpc",
    status: "approved",
    approvedBy: "user",
    approvedAt: oldAt,
    candidateCount: 1,
    payload: {
      datasetHash: "cleanup-rpc-approved",
      candidates: [{ candidateId: "candidate-cleanup-rpc", handle: "protected-handle" }]
    }
  });
  store.createOutboxEvent({
    outboxId: "outbox-cleanup-rpc-approved",
    idempotencyKey: "cleanup-rpc-approved",
    aggregateType: "handoff_batch",
    aggregateId: "handoff-cleanup-rpc-approved",
    eventType: "candidate_batch.ready",
    payload: { payloadSentinel: "COMMITTED_HANDOFF_PAYLOAD_MUST_SURVIVE" }
  });
  store.appendAudit({
    auditId: "audit-cleanup-rpc-protected",
    action: "cleanup_rpc_source",
    runId: "run-cleanup-rpc",
    details: { auditSentinel: "AUDIT_MUST_SURVIVE" },
    occurredAt: oldAt
  });
  store.close();

  const client = new DaemonClient({ pluginRoot, dataDirectory });
  t.after(async () => {
    await client.call("shutdown", {}).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 150));
    await rm(dataDirectory, { recursive: true, force: true });
  });

  for (let attempt = 0; attempt < 30; attempt += 1) {
    const status = await client.call("status");
    if (status.durableQueueSweep.running !== true) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  const preview = await client.call("preview_collection_cleanup", { cutoff });
  assert.equal(preview.commitRequired, true);
  assert.equal(preview.irreversible, true);
  assert.equal(preview.cutoff, cutoff);
  assert.match(preview.previewHash, /^[a-f0-9]{64}$/);
  assert.match(preview.confirmationProof, /^[a-f0-9]{64}$/);
  assert.equal(preview.deleteCounts.collectionRuns, 1);
  assert.equal(preview.deleteCounts.prospects, 0);
  assert.equal(preview.deleteCounts.auditEvents, 0);
  assert.equal(preview.deleteCounts.handoffBatches, 0);
  assert.equal(preview.protectedCounts.committedHandoffs, 1);
  assert.equal(preview.recoverability.recoverable, false);
  assert.doesNotMatch(JSON.stringify(preview), /CLEANUP_QUEUE_PAYLOAD_MUST_NOT_LEAK/);

  await assert.rejects(
    client.call("commit_collection_cleanup", {
      cutoff,
      previewHash: preview.previewHash,
      confirmationProof: preview.confirmationProof,
      userConfirmed: false
    }),
    (error) => error.code === "confirmation_required"
  );

  await assert.rejects(
    client.call("commit_collection_cleanup", {
      cutoff,
      previewHash: preview.previewHash,
      confirmationProof: "0".repeat(64),
      userConfirmed: true
    }),
    (error) => error.code === "collection_cleanup_confirmation_expired"
  );

  const committed = await client.call("commit_collection_cleanup", {
    cutoff,
    previewHash: preview.previewHash,
    confirmationProof: preview.confirmationProof,
    userConfirmed: true
  });
  assert.equal(committed.committed, true);
  assert.equal(committed.cutoff, cutoff);
  assert.equal(committed.deleteCounts.collectionRuns, 1);
  assert.equal(committed.deleteCounts.checkpoints, 1);
  assert.equal(committed.deleteCounts.discoverySeedQueue, 1);
  assert.equal(committed.recoverability.recoverable, false);
  assert.equal(committed.recoverability.backupCreated, false);

  await assert.rejects(
    client.call("commit_collection_cleanup", {
      cutoff,
      previewHash: preview.previewHash,
      confirmationProof: preview.confirmationProof,
      userConfirmed: true
    }),
    (error) => error.code === "collection_cleanup_confirmation_expired"
  );

  const verifier = new DatabaseStore(paths.databasePath).init();
  assert.equal(verifier.getRun("run-cleanup-rpc"), null);
  assert.equal(verifier.getSession("protected-login-material").profilePath, "/isolated/protected-profile");
  assert.equal(
    verifier.getHandoffBatch("handoff-cleanup-rpc-approved").payload.datasetHash,
    "cleanup-rpc-approved"
  );
  assert.equal(
    verifier.getOutboxEvent("outbox-cleanup-rpc-approved").payload.payloadSentinel,
    "COMMITTED_HANDOFF_PAYLOAD_MUST_SURVIVE"
  );
  assert.equal(
    verifier.listAuditEvents({ action: "cleanup_rpc_source" })[0].details.auditSentinel,
    "AUDIT_MUST_SURVIVE"
  );
  assert.equal(verifier.listAuditEvents({ action: "collection_cleanup_committed" }).length, 1);
  verifier.close();

  const audit = await client.call("audit_events", { limit: 100 });
  assert.equal(JSON.stringify(audit).includes(preview.confirmationProof), false);
  assert.doesNotMatch(JSON.stringify({ preview, committed }), /CLEANUP_QUEUE_PAYLOAD_MUST_NOT_LEAK/);
});

test("daemon strips URL and credential secrets from state, RPC, audit, and logs", async (t) => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "tkdesk-daemon-redaction-"));
  const pluginRoot = process.cwd();
  const paths = runtimePaths(dataDirectory);
  const store = new DatabaseStore(paths.databasePath).init();
  const run = store.createRun({
    source: "tiktok_live",
    mode: "semi_auto",
    filters: {
      startUrl: "https://www.tiktok.com/live?access_token=STATE_TOKEN_SECRET&email=state@example.com#hash=STATE_HASH_SECRET",
      query: "STATE_QUERY_SECRET"
    },
    progress: {
      url: "https://www.tiktok.com/live?token=PROGRESS_TOKEN_SECRET#cookie=PROGRESS_COOKIE_SECRET",
      email: "progress@example.com",
      query: "PROGRESS_QUERY_SECRET",
      hash: "PROGRESS_HASH_SECRET"
    }
  });
  store.saveCheckpoint(run.runId, "position", {
    url: "https://www.tiktok.com/live?token=CHECKPOINT_TOKEN_SECRET#hash=CHECKPOINT_HASH_SECRET",
    cookie: "CHECKPOINT_COOKIE_SECRET"
  }, { adapter: "tiktok_live" });
  store.upsertProspect({
    userId: "user-redaction",
    handle: "alice",
    profileUrl: "https://www.tiktok.com/@alice",
    source: "tiktok_live",
    runId: run.runId,
    data: {
      sourceUrl: "https://www.tiktok.com/@alice/live?token=DATA_TOKEN_SECRET#hash=DATA_HASH_SECRET"
    },
    observation: {
      runId: run.runId,
      source: "tiktok_live",
      sourceUrl: "https://www.tiktok.com/@alice/live?token=SOURCE_TOKEN_SECRET#cookie=SOURCE_COOKIE_SECRET",
      evidence: {
        href: "https://www.tiktok.com/@alice/live?access_token=EVIDENCE_TOKEN_SECRET#hash=EVIDENCE_HASH_SECRET",
        text: "contact=creator@example.com password=EVIDENCE_PASSWORD_SECRET",
        cookie: "EVIDENCE_COOKIE_SECRET"
      }
    }
  });
  store.appendAudit({
    action: "unsafe_fixture",
    runId: run.runId,
    details: {
      message: "failed at https://www.tiktok.com/live?token=AUDIT_TOKEN_SECRET#hash=AUDIT_HASH_SECRET for audit@example.com",
      password: "AUDIT_PASSWORD_SECRET"
    }
  });
  store.close();

  const client = new DaemonClient({ pluginRoot, dataDirectory });
  let stopped = false;
  t.after(async () => {
    if (!stopped) {
      await client.call("shutdown", {}).catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    await rm(dataDirectory, { recursive: true, force: true });
  });

  const [status, readBack, candidates, audits] = await Promise.all([
    client.call("status"),
    client.call("get_run", { runId: run.runId }),
    client.call("query_candidates", { runId: run.runId, limit: 10, reason: "redaction regression" }),
    client.call("audit_events", { runId: run.runId, limit: 20 })
  ]);
  assert.equal(readBack.progress.url, "https://www.tiktok.com/live");
  assert.equal(readBack.progress.email, "[REDACTED]");
  assert.equal(readBack.progress.query, "[REDACTED]");
  assert.equal(readBack.progress.hash, "[REDACTED]");
  assert.equal(readBack.checkpoints[0].value.url, "https://www.tiktok.com/live");
  assert.equal(candidates.candidates[0].profileUrl, "https://www.tiktok.com/@alice");
  assert.equal(candidates.candidates[0].sourceUrl, "https://www.tiktok.com/@alice/live");
  assert.equal(candidates.candidates[0].evidence.href, "https://www.tiktok.com/@alice/live");
  assert.equal(candidates.candidates[0].evidence.cookie, "[REDACTED]");

  const rpcExposed = JSON.stringify({ status, readBack, candidates, audits });
  assert.doesNotMatch(
    rpcExposed,
    /STATE_TOKEN_SECRET|STATE_HASH_SECRET|STATE_QUERY_SECRET|state@example\.com|PROGRESS_TOKEN_SECRET|PROGRESS_COOKIE_SECRET|PROGRESS_QUERY_SECRET|PROGRESS_HASH_SECRET|progress@example\.com|CHECKPOINT_TOKEN_SECRET|CHECKPOINT_HASH_SECRET|CHECKPOINT_COOKIE_SECRET|DATA_TOKEN_SECRET|DATA_HASH_SECRET|SOURCE_TOKEN_SECRET|SOURCE_COOKIE_SECRET|EVIDENCE_TOKEN_SECRET|EVIDENCE_HASH_SECRET|EVIDENCE_PASSWORD_SECRET|EVIDENCE_COOKIE_SECRET|creator@example\.com|AUDIT_TOKEN_SECRET|AUDIT_HASH_SECRET|AUDIT_PASSWORD_SECRET|audit@example\.com|[?#]/i
  );

  const rpcSecret = "RPC_TOKEN_SECRET";
  await assert.rejects(
    client.call("create_discovery_run", {
      source: `https://evil.example/source?access_token=${rpcSecret}#email=rpc@example.com`,
      mode: "semi_auto"
    }),
    (error) => {
      const exposed = JSON.stringify({ message: error.message, details: error.details, stack: error.stack });
      assert.doesNotMatch(exposed, /RPC_TOKEN_SECRET|rpc@example\.com|access_token|[?#]/i);
      assert.match(error.message, /https:\/\/evil\.example\/source/);
      return true;
    }
  );

  await client.call("shutdown", {});
  stopped = true;
  await new Promise((resolve) => setTimeout(resolve, 200));
  const log = await readFile(paths.logPath, "utf8");
  assert.doesNotMatch(log, /RPC_TOKEN_SECRET|rpc@example\.com|access_token|[?#]/i);
  assert.match(log, /https:\/\/evil\.example\/source/);
});


test("normal daemon creation accepts all 36 original display configurations without Mobile or calibration gates", async t => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "tkdesk-all-original-regions-"));
  const store = new DatabaseStore(runtimePaths(dataDirectory).databasePath).init();
  const cases = [];
  for (const group of originalCountryCatalog().configurations) {
    for (const variant of group.displayVariants) {
      const countryCode = variant.selectionCountryCodes[0];
      const route = store.upsertCollectionRoute({ marketRegion: group.routeCode, marketCountryCodes: group.memberCountryCodes,
        discoveryCountry: "US", discoveryProxyServer: "http://127.0.0.1:18980",
        collectionLanes: [{ countryCode, proxyServer: "http://127.0.0.1:18981" }], proxyFingerprint: "sha256:test-all-catalog" });
      store.recordCollectionRouteVerification(route.routeProfileId, { status: "verified", proxyFingerprint: "sha256:test-all-catalog",
        discoveryProxyExitCountry: "US", proxyExitCountry: countryCode, collectionProxyExitCountries: [countryCode] });
      cases.push({ routeProfileId: route.routeProfileId, marketRegion: group.routeCode, countryCode, displayName: variant.displayName });
    }
  }
  store.close();
  const client = new DaemonClient({ pluginRoot: process.cwd(), dataDirectory });
  t.after(async () => { await client.call("shutdown", {}).catch(() => {}); await new Promise(resolve => setTimeout(resolve, 150)); await rm(dataDirectory, { recursive: true, force: true }); });
  for (const entry of cases) {
    const run = await client.call("create_discovery_run", { source: "tiktok_live", mode: "full_auto", routeProfileId: entry.routeProfileId,
      filters: { marketRegion: entry.marketRegion, countryCodes: [entry.countryCode], countryDisplayNames: [{ countryCode: entry.countryCode, displayName: entry.displayName }] } });
    assert.equal(run.status, "queued");
    assert.equal(run.filters.maxCandidates, undefined);
    assert.equal(run.filters.countryDisplayNames[0].displayName, entry.displayName);
  }
  assert.equal(cases.length, 36);
  const status = await client.call("status");
  assert.equal(status.qualificationUsage.hourlyUsed, 0);
  assert.equal(status.activeQualificationBatchId, null);
  assert.deepEqual(status.capabilities.discovery.regionalGiftRanking.originalCatalog, { displayConfigurations: 36, routeGroups: 27, memberCountryCodes: 146 });
});
