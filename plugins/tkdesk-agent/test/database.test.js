import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDatabase } from "../mcp/core/database.js";

async function withDatabase(testContext, callback) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tkdesk-database-"));
  const databasePath = path.join(directory, "state", "tkdesk.sqlite3");
  let sequence = 0;
  const options = {
    clock: () => new Date("2026-08-22T03:00:00.000Z"),
    idFactory: () => `generated-${++sequence}`
  };
  const store = createDatabase(databasePath, options);
  testContext.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  await callback({ store, databasePath, options });
}

async function withMutableDatabase(testContext, callback) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tkdesk-database-"));
  const databasePath = path.join(directory, "state", "tkdesk.sqlite3");
  let sequence = 0;
  let currentTime = new Date("2026-08-22T03:00:00.000Z");
  const options = {
    clock: () => currentTime,
    idFactory: () => `generated-${++sequence}`
  };
  const store = createDatabase(databasePath, options);
  testContext.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  await callback({
    store,
    databasePath,
    options,
    setTime(value) { currentTime = new Date(value); }
  });
}

function downgradeCollectionRoutesToV3(store) {
  store.database.exec(`
    ALTER TABLE collection_routes RENAME TO collection_routes_v4;
    DROP INDEX idx_collection_routes_single_active;
    DROP INDEX idx_collection_routes_discovery_country;
    CREATE TABLE collection_routes (
      route_profile_id TEXT PRIMARY KEY,
      market_region TEXT NOT NULL,
      route_country TEXT NOT NULL,
      backstage_country TEXT NOT NULL,
      market_countries_json TEXT NOT NULL,
      proxy_server TEXT NOT NULL,
      proxy_fingerprint TEXT NOT NULL,
      proxy_exit_country TEXT,
      verification_status TEXT NOT NULL DEFAULT 'unverified',
      verification_json TEXT,
      verified_at TEXT,
      active INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (active IN (0, 1))
    ) STRICT;
    INSERT INTO collection_routes(
      route_profile_id, market_region, route_country, backstage_country,
      market_countries_json, proxy_server, proxy_fingerprint,
      proxy_exit_country, verification_status, verification_json,
      verified_at, active, created_at, updated_at
    )
    SELECT
      route_profile_id, market_region, route_country, backstage_country,
      market_countries_json, collection_proxy_server, proxy_fingerprint,
      proxy_exit_country, verification_status, verification_json,
      verified_at, active, created_at, updated_at
    FROM collection_routes_v4;
    DROP TABLE collection_routes_v4;
    CREATE UNIQUE INDEX idx_collection_routes_single_active
      ON collection_routes(active) WHERE active = 1;
  `);
}

test("initializes WAL schema and persists sessions, runs, checkpoints, and audit events", async (t) => {
  await withDatabase(t, async ({ store, databasePath, options }) => {
    const journalMode = store.database.prepare("PRAGMA journal_mode").get().journal_mode;
    assert.equal(journalMode, "wal");
    assert.equal(store.database.prepare("PRAGMA user_version").get().user_version, 8);
    const tables = store.database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name);
    for (const table of [
      "sessions", "collection_runs", "checkpoints", "prospects", "prospect_observations",
      "handoff_batches", "outbox", "audit_events", "collection_routes",
      "qualification_batches", "qualification_batch_items", "qualification_policy_state",
      "discovery_seed_queue"
    ]) assert.ok(tables.includes(table), `missing table ${table}`);
    const routeColumns = new Set(
      store.database.prepare("PRAGMA table_info(collection_routes)").all().map((row) => row.name)
    );
    for (const column of [
      "discovery_country", "discovery_proxy_server", "collection_proxy_server",
      "collection_country_codes_json", "collection_proxy_servers_json",
      "collection_proxy_lane_mode",
      "proxy_server", "discovery_proxy_exit_country",
      "collection_proxy_exit_countries_json", "proxy_exit_country"
    ]) assert.ok(routeColumns.has(column), `missing collection_routes column ${column}`);

    store.upsertSession({
      sessionKey: "tiktok-discovery",
      kind: "tiktok",
      profilePath: "/isolated/tiktok",
      status: "awaiting_login",
      metadata: { browser: "chromium" }
    });
    const session = store.setSessionStatus("tiktok-discovery", "authenticated", {
      currentUrl: "https://www.tiktok.com/",
      authenticatedAt: "2026-08-22T03:00:00.000Z"
    });
    assert.equal(session.status, "authenticated");
    assert.deepEqual(session.metadata, { browser: "chromium" });

    store.createRun({
      runId: "run-1",
      mode: "full_auto",
      source: "tiktok_live",
      filters: { region: "US" },
      config: { pageBudget: 8 }
    });
    const run = store.updateRun("run-1", {
      status: "extracting",
      progress: { page: 3 },
      expected: 100,
      received: 42,
      new: 38,
      duplicate: 4,
      error: { retryable: false },
      result: { coverage: 0.42 }
    });
    assert.deepEqual(run.progress, { page: 3 });
    assert.equal(run.expected, 100);
    assert.equal(run.received, 42);
    assert.equal(run.new, 38);
    assert.equal(run.duplicate, 4);
    assert.deepEqual(run.error, { retryable: false });
    assert.deepEqual(run.result, { coverage: 0.42 });
    assert.equal(run.startedAt, "2026-08-22T03:00:00.000Z");

    const checkpoint = store.saveCheckpoint("run-1", "cursor", { page: 3, token: "opaque" }, { adapter: "ranking" });
    assert.deepEqual(checkpoint.value, { page: 3, token: "opaque" });
    assert.equal(store.listCheckpoints("run-1").length, 1);

    const audit = store.appendAudit({
      actor: "codex",
      action: "collection.started",
      targetType: "collection_run",
      targetId: "run-1",
      runId: "run-1",
      details: { mode: "full_auto" }
    });
    assert.equal(audit.action, "collection.started");
    assert.equal(store.listAuditEvents({ runId: "run-1" }).length, 1);

    store.close();
    const reopened = createDatabase(databasePath, options);
    assert.equal(reopened.getSession("tiktok-discovery").status, "authenticated");
    assert.equal(reopened.getRun("run-1").received, 42);
    assert.deepEqual(reopened.getCheckpoint("run-1", "cursor", { adapter: "ranking" }).value, { page: 3, token: "opaque" });
    assert.equal(reopened.listAuditEvents({ runId: "run-1" })[0].action, "collection.started");
    reopened.close();
  });
});

test("durable original seed queue enforces exact feed and ranking timing across claims", async (t) => {
  await withMutableDatabase(t, async ({ store, setTime }) => {
    store.createRun({ runId: "run-seed-timing", source: "tiktok_live", mode: "full_auto" });

    const firstFeed = store.enqueueOriginalDiscoverySeed({
      runId: "run-seed-timing",
      seedKind: "feed",
      identityKey: "SA:user:1001",
      payload: { candidateId: "creator-1001" }
    });
    assert.equal(firstFeed.accepted, true);
    assert.equal(firstFeed.seed.dueAt, "2026-08-22T03:00:00.000Z");
    assert.equal(firstFeed.seed.dedupeUntil, "2026-08-22T03:05:00.000Z");

    setTime("2026-08-22T03:04:59.000Z");
    const duplicateFeed = store.enqueueOriginalDiscoverySeed({
      runId: "run-seed-timing",
      seedKind: "feed",
      identityKey: "SA:user:1001",
      payload: { candidateId: "changed-but-suppressed" }
    });
    assert.equal(duplicateFeed.accepted, false);
    assert.equal(duplicateFeed.duplicate, true);
    assert.deepEqual(duplicateFeed.seed.payload, { candidateId: "creator-1001" });

    const feedClaims = store.claimDueOriginalDiscoverySeeds({
      runId: "run-seed-timing",
      seedKind: "feed"
    });
    assert.equal(feedClaims.length, 1);
    assert.equal(feedClaims[0].attemptCount, 1);
    store.completeOriginalDiscoverySeed(feedClaims[0].queueId, {
      claimToken: feedClaims[0].claimToken,
      result: { outcome: "enriched" }
    });

    setTime("2026-08-22T03:05:00.000Z");
    const refreshedFeed = store.enqueueOriginalDiscoverySeed({
      runId: "run-seed-timing",
      seedKind: "feed",
      identityKey: "SA:user:1001",
      payload: { candidateId: "creator-1001-second-window" }
    });
    assert.equal(refreshedFeed.accepted, true);
    assert.equal(refreshedFeed.refreshed, true);
    assert.equal(refreshedFeed.seed.status, "pending");
    assert.equal(refreshedFeed.seed.attemptCount, 0);
    assert.equal(refreshedFeed.seed.dedupeUntil, "2026-08-22T03:10:00.000Z");

    const defaultRanking = store.enqueueOriginalDiscoverySeed({
      runId: "run-seed-timing",
      seedKind: "ranking",
      identityKey: "SA:user:2001",
      payload: { candidateId: "creator-2001" },
      countdownSeconds: 0
    });
    assert.equal(defaultRanking.seed.dueAt, "2026-08-22T03:08:00.000Z");
    assert.equal(defaultRanking.seed.dedupeUntil, "2026-08-22T03:15:00.000Z");
    assert.deepEqual(store.claimDueOriginalDiscoverySeeds({
      runId: "run-seed-timing",
      seedKind: "ranking"
    }), []);

    const positiveRanking = store.enqueueOriginalDiscoverySeed({
      runId: "run-seed-timing",
      seedKind: "ranking",
      identityKey: "SA:user:2002",
      payload: { candidateId: "creator-2002" },
      countdownSeconds: 45
    });
    assert.equal(positiveRanking.seed.dueAt, "2026-08-22T03:05:45.000Z");
    setTime("2026-08-22T03:05:45.000Z");
    const rankingClaims = store.claimDueOriginalDiscoverySeeds({
      runId: "run-seed-timing",
      seedKind: "ranking"
    });
    assert.equal(rankingClaims.length, 1);
    assert.equal(rankingClaims[0].identityKey, "SA:user:2002");
    const queueStatus = store.originalDiscoveryQueueStatus("run-seed-timing", {
      seedKind: "ranking"
    });
    assert.equal(queueStatus.counts.processing, 1);
    assert.equal(queueStatus.counts.pending, 1);
    assert.equal(queueStatus.nextDueAt, "2026-08-22T03:08:00.000Z");

    setTime("2026-08-22T03:14:59.000Z");
    const duplicateRanking = store.enqueueOriginalDiscoverySeed({
      runId: "run-seed-timing",
      seedKind: "ranking",
      identityKey: "SA:user:2001",
      payload: { candidateId: "changed-but-suppressed" },
      countdownSeconds: 1
    });
    assert.equal(duplicateRanking.accepted, false);
    assert.equal(duplicateRanking.duplicate, true);
    assert.deepEqual(duplicateRanking.seed.payload, { candidateId: "creator-2001" });

    setTime("2026-08-22T03:15:00.000Z");
    const refreshedRanking = store.enqueueOriginalDiscoverySeed({
      runId: "run-seed-timing",
      seedKind: "ranking",
      identityKey: "SA:user:2001",
      payload: { candidateId: "creator-2001-second-window" },
      countdownSeconds: 0
    });
    assert.equal(refreshedRanking.accepted, true);
    assert.equal(refreshedRanking.refreshed, true);
    assert.equal(refreshedRanking.seed.dueAt, "2026-08-22T03:18:00.000Z");
    assert.equal(refreshedRanking.seed.dedupeUntil, "2026-08-22T03:25:00.000Z");
  });
});

test("durable original seed claims recover after a daemon restart without losing payload", async (t) => {
  await withMutableDatabase(t, async ({ store, databasePath, options }) => {
    store.createRun({ runId: "run-seed-recovery", source: "tiktok_live", mode: "full_auto" });
    store.enqueueOriginalDiscoverySeed({
      runId: "run-seed-recovery",
      seedKind: "feed",
      identityKey: "QA:user:3001",
      payload: { candidateId: "creator-3001", workId: 2 }
    });
    const [claimed] = store.claimDueOriginalDiscoverySeeds({
      runId: "run-seed-recovery",
      seedKind: "feed"
    });
    assert.equal(claimed.status, "processing");
    store.close();

    const reopened = createDatabase(databasePath, options);
    assert.equal(reopened.getDiscoverySeed(claimed.queueId).status, "processing");
    assert.equal(reopened.releaseRunDiscoverySeedLeases("run-seed-recovery"), 1);
    const [recovered] = reopened.claimDueOriginalDiscoverySeeds({
      runId: "run-seed-recovery",
      seedKind: "feed"
    });
    assert.deepEqual(recovered.payload, { candidateId: "creator-3001", workId: 2 });
    assert.equal(recovered.attemptCount, 2);
    reopened.completeOriginalDiscoverySeed(recovered.queueId, {
      claimToken: recovered.claimToken,
      status: "skipped",
      result: { reason: "filtered" }
    });
    assert.equal(reopened.getDiscoverySeed(recovered.queueId).status, "skipped");
    reopened.close();
  });
});

test("due-run scan selects only resumable partial runs and never paused or terminal runs", async (t) => {
  await withMutableDatabase(t, async ({ store, setTime }) => {
    for (const [runId, status] of [
      ["run-due-partial", "partial"],
      ["run-due-paused", "paused"],
      ["run-due-cancelled", "cancelled"]
    ]) {
      store.createRun({ runId, source: "tiktok_live", mode: "full_auto", status });
      store.enqueueOriginalDiscoverySeed({
        runId,
        seedKind: "ranking",
        identityKey: `SA:user:${runId}`,
        payload: { candidateId: `candidate-${runId}` },
        countdownSeconds: 1
      });
    }
    setTime("2026-08-22T03:00:01.000Z");
    assert.deepEqual(
      store.listRunsWithDueOriginalDiscoverySeeds().map((run) => run.runId),
      ["run-due-partial"]
    );
    store.updateRun("run-due-partial", { status: "paused" });
    assert.deepEqual(store.listRunsWithDueOriginalDiscoverySeeds(), []);
  });
});

test("deduplicates prospects across reruns using userId, secUid, then normalized handle", async (t) => {
  await withDatabase(t, async ({ store, databasePath, options }) => {
    store.createRun({ runId: "run-a", source: "ranking" });
    store.createRun({ runId: "run-b", source: "ranking" });

    const first = store.upsertProspect({
      runId: "run-a",
      source: "ranking",
      handle: "@Alice.Live",
      displayName: "Alice",
      region: "US",
      followers: 12_345,
      live: true,
      seller: null,
      highQuality: null,
      data: { rank: "A3" },
      evidence: [{ field: "followers", selector: "visible-cell" }]
    });
    assert.equal(first.created, true);
    assert.equal(first.prospect.seller, null);
    assert.equal(first.prospect.highQuality, null);

    const sameHandle = store.upsertProspect({
      runId: "run-a",
      source: "ranking",
      handle: "alice.live",
      region: "US",
      followers: 12_345,
      live: true,
      data: { rank: "A3" },
      evidence: [{ field: "followers", selector: "visible-cell" }]
    });
    assert.equal(sameHandle.created, false);
    assert.equal(sameHandle.prospect.candidateId, first.prospect.candidateId);
    assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM prospect_observations WHERE run_id = 'run-a'").get().count, 1);

    const upgradedIdentity = store.upsertProspect({
      runId: "run-b",
      source: "profile",
      userId: "701234567890",
      secUid: "MS4wLjABAAAA-test",
      handle: "@ALICE.LIVE",
      region: "US",
      followers: 12_999,
      highQuality: true,
      observation: { sourceUrl: "https://www.tiktok.com/@alice.live", confidence: 0.98 }
    });
    assert.equal(upgradedIdentity.created, false);
    assert.equal(upgradedIdentity.prospect.candidateId, first.prospect.candidateId);
    assert.equal(upgradedIdentity.prospect.identityKey, "user_id:701234567890");

    const sameUserOnThirdPass = store.upsertProspect({
      runId: "run-b",
      source: "profile",
      userId: "701234567890",
      handle: "renamed.alice",
      followers: 13_001
    });
    assert.equal(sameUserOnThirdPass.created, false);
    assert.equal(sameUserOnThirdPass.prospect.candidateId, first.prospect.candidateId);

    assert.equal(store.queryProspects().length, 1);
    const runA = store.queryProspects({ runId: "run-a", source: "ranking", region: "US", minFollowers: 10_000, maxFollowers: 20_000 });
    assert.equal(runA.length, 1);
    assert.equal(runA[0].candidateId, first.prospect.candidateId);
    assert.equal(runA[0].latestObservation.runId, "run-a");
    assert.equal(store.queryProspects({ region: "GB" }).length, 0);

    store.close();
    const reopened = createDatabase(databasePath, options);
    const afterRestart = reopened.upsertProspect({
      runId: "run-b",
      source: "profile",
      secUid: "MS4wLjABAAAA-test",
      handle: "renamed.again",
      followers: 13_500
    });
    assert.equal(afterRestart.created, false);
    assert.equal(afterRestart.prospect.candidateId, first.prospect.candidateId);
    assert.equal(reopened.queryProspects().length, 1);
    reopened.close();
  });
});

test("prospect merges preserve every qualification batch item across candidate ID conflicts", async (t) => {
  await withDatabase(t, async ({ store }) => {
    store.createRun({ runId: "run-merge-history", source: "ranking" });
    const handleCandidate = store.upsertProspect({
      candidateId: "candidate-by-handle",
      runId: "run-merge-history",
      source: "ranking",
      handle: "eventual.match"
    }).prospect;
    const userCandidate = store.upsertProspect({
      candidateId: "candidate-by-user",
      runId: "run-merge-history",
      source: "ranking",
      userId: "701234567890",
      handle: "old.handle"
    }).prospect;

    store.reserveQualificationBatch({
      batchId: "batch-with-conflict",
      runId: "run-merge-history",
      candidateIds: [handleCandidate.candidateId, userCandidate.candidateId]
    });
    store.finishQualificationBatch("batch-with-conflict", {
      status: "completed",
      results: [
        { candidateId: handleCandidate.candidateId, resultStatus: "regular_invitation" },
        { candidateId: userCandidate.candidateId, resultStatus: "advanced_invitation" }
      ]
    });

    store.reserveQualificationBatch({
      batchId: "batch-without-conflict",
      runId: "run-merge-history",
      candidateIds: [handleCandidate.candidateId],
      allowPreviouslyAttempted: true
    });
    store.finishQualificationBatch("batch-without-conflict", {
      status: "completed",
      results: [{ candidateId: handleCandidate.candidateId, resultStatus: "available" }]
    });

    const merged = store.upsertProspect({
      runId: "run-merge-history",
      source: "profile",
      userId: "701234567890",
      handle: "eventual.match"
    });
    assert.equal(merged.prospect.candidateId, userCandidate.candidateId);
    assert.equal(store.getProspect(handleCandidate.candidateId), null);

    const conflictBatch = store.getQualificationBatch("batch-with-conflict");
    assert.equal(conflictBatch.candidateCount, 2);
    assert.deepEqual(conflictBatch.items, [
      {
        candidateId: userCandidate.candidateId,
        requestedCandidateId: handleCandidate.candidateId,
        ordinal: 0,
        resultStatus: "regular_invitation"
      },
      {
        candidateId: userCandidate.candidateId,
        requestedCandidateId: userCandidate.candidateId,
        ordinal: 1,
        resultStatus: "advanced_invitation"
      }
    ]);
    assert.deepEqual(conflictBatch.candidateIds, [
      userCandidate.candidateId,
      userCandidate.candidateId
    ]);
    assert.deepEqual(conflictBatch.requestedCandidateIds, [
      handleCandidate.candidateId,
      userCandidate.candidateId
    ]);

    const nonConflictBatch = store.getQualificationBatch("batch-without-conflict");
    assert.deepEqual(nonConflictBatch.items, [{
      candidateId: userCandidate.candidateId,
      requestedCandidateId: handleCandidate.candidateId,
      ordinal: 0,
      resultStatus: "available"
    }]);

    assert.equal(
      store.database.prepare(`
        SELECT COUNT(*) AS count FROM qualification_batch_items
        WHERE candidate_id = ?
      `).get(userCandidate.candidateId).count,
      3
    );
  });
});

test("migrates v2 qualification items with their requested candidate identity intact", async (t) => {
  await withDatabase(t, async ({ store, databasePath, options }) => {
    store.createRun({ runId: "run-v2-migration", source: "ranking" });
    store.upsertProspect({
      candidateId: "candidate-v2",
      runId: "run-v2-migration",
      source: "ranking",
      handle: "legacy.candidate"
    });
    store.reserveQualificationBatch({
      batchId: "batch-v2",
      runId: "run-v2-migration",
      candidateIds: ["candidate-v2"]
    });
    store.finishQualificationBatch("batch-v2", {
      status: "completed",
      results: [{ candidateId: "candidate-v2", resultStatus: "available" }]
    });

    // Recreate the exact v2 item shape so reopening exercises migration 3
    // against durable data instead of only testing a fresh empty database.
    store.transaction(() => {
      store.database.exec(`
        DROP INDEX idx_qualification_items_candidate;
        DROP INDEX idx_qualification_items_requested_candidate;
        ALTER TABLE qualification_batch_items RENAME TO qualification_batch_items_v3;
        CREATE TABLE qualification_batch_items (
          batch_id TEXT NOT NULL REFERENCES qualification_batches(batch_id) ON DELETE CASCADE,
          candidate_id TEXT NOT NULL REFERENCES prospects(candidate_id) ON DELETE CASCADE,
          ordinal INTEGER NOT NULL,
          result_status TEXT,
          PRIMARY KEY (batch_id, candidate_id),
          UNIQUE (batch_id, ordinal),
          CHECK (ordinal >= 0)
        ) STRICT;
        INSERT INTO qualification_batch_items(batch_id, candidate_id, ordinal, result_status)
        SELECT batch_id, candidate_id, ordinal, result_status
        FROM qualification_batch_items_v3;
        DROP TABLE qualification_batch_items_v3;
        CREATE INDEX idx_qualification_items_candidate
          ON qualification_batch_items(candidate_id, batch_id);
      `);
      downgradeCollectionRoutesToV3(store);
      store.database.exec(`
        DELETE FROM schema_migrations WHERE version >= 3;
        PRAGMA user_version = 2;
      `);
    });
    store.close();

    const reopened = createDatabase(databasePath, options);
    assert.equal(reopened.database.prepare("PRAGMA user_version").get().user_version, 8);
    assert.deepEqual(reopened.getQualificationBatch("batch-v2").items, [{
      candidateId: "candidate-v2",
      requestedCandidateId: "candidate-v2",
      ordinal: 0,
      resultStatus: "available"
    }]);
    reopened.close();
  });
});

test("migrates legacy single-proxy routes into one explicit country lane", async (t) => {
  await withDatabase(t, async ({ store, databasePath, options }) => {
    store.upsertCollectionRoute({
      routeProfileId: "legacy-route-sa",
      marketRegion: "MENA",
      marketCountryCodes: ["SA", "AE"],
      discoveryCountry: "SA",
      discoveryProxyServer: "http://127.0.0.1:17780",
      routeCountry: "SA",
      backstageCountry: "SA",
      collectionProxyServer: "http://127.0.0.1:17780",
      routeFingerprint: "sha256:legacy-sa"
    });
    store.recordCollectionRouteVerification("legacy-route-sa", {
      status: "verified",
      routeFingerprint: "sha256:legacy-sa",
      discoveryProxyExitCountry: "SA",
      proxyExitCountry: "SA",
      verification: { source: "legacy-probe" }
    });
    store.setActiveCollectionRoute("legacy-route-sa");

    // Recreate the exact v3 single-proxy table, then reopen so migration 4
    // must preserve the row while expanding it into both target routes.
    store.transaction(() => {
      downgradeCollectionRoutesToV3(store);
      store.database.exec(`
        DELETE FROM schema_migrations WHERE version >= 4;
        PRAGMA user_version = 3;
      `);
    });
    store.close();

    const reopened = createDatabase(databasePath, options);
    assert.equal(reopened.database.prepare("PRAGMA user_version").get().user_version, 8);
    const migrated = reopened.getCollectionRoute("legacy-route-sa");
    assert.equal(migrated.discoveryCountry, "SA");
    assert.equal(migrated.discoveryProxyServer, "http://127.0.0.1:17780");
    assert.equal(migrated.routeCountry, "SA");
    assert.equal(migrated.collectionProxyServer, "http://127.0.0.1:17780");
    assert.deepEqual(migrated.collectionProxyServers, ["http://127.0.0.1:17780"]);
    assert.deepEqual(migrated.collectionCountryCodes, ["SA"]);
    assert.deepEqual(migrated.collectionLanes, [{
      workId: 1,
      countryCode: "SA",
      proxyServer: "http://127.0.0.1:17780"
    }]);
    assert.equal(migrated.collectionProxyLaneMode, "country_lanes");
    assert.equal(migrated.collectionProxyLaneCount, 1);
    assert.equal(migrated.proxyServer, migrated.collectionProxyServer);
    assert.equal(migrated.discoveryProxyExitCountry, null);
    assert.deepEqual(migrated.collectionProxyExitCountries, []);
    assert.equal(migrated.proxyExitCountry, null);
    assert.equal(migrated.verificationStatus, "unverified");
    assert.deepEqual(migrated.verification, { source: "legacy-probe" });
    assert.equal(migrated.verifiedAt, null);
    assert.equal(migrated.active, false);
    assert.equal(migrated.migrationRequired, false);
    assert.equal(
      reopened.database.prepare("SELECT name FROM schema_migrations WHERE version = 4").get().name,
      "split_discovery_and_collection_routes"
    );
    assert.equal(
      reopened.database.prepare("SELECT name FROM schema_migrations WHERE version = 5").get().name,
      "add_exact_three_collection_proxy_lanes"
    );
    assert.equal(
      reopened.database.prepare("SELECT name FROM schema_migrations WHERE version = 6").get().name,
      "invalidate_degraded_single_lane_verification"
    );
    assert.equal(
      reopened.database.prepare("SELECT name FROM schema_migrations WHERE version = 7").get().name,
      "map_one_proxy_to_each_collection_country"
    );
    reopened.close();
  });
});

test("migration invalidates legacy ambiguous three-slot routes without deleting endpoints", async (t) => {
  await withDatabase(t, async ({ store, databasePath, options }) => {
    store.upsertCollectionRoute({
      routeProfileId: "legacy-v6-three-slot",
      marketRegion: "MENA",
      marketCountryCodes: ["SA", "QA", "EG"],
      discoveryCountry: "US",
      discoveryProxyServer: "http://127.0.0.1:18100",
      collectionLanes: [
        { countryCode: "SA", proxyServer: "http://127.0.0.1:18101" },
        { countryCode: "QA", proxyServer: "http://127.0.0.1:18102" },
        { countryCode: "EG", proxyServer: "http://127.0.0.1:18103" }
      ],
      routeFingerprint: "sha256:legacy-v6-three-slot"
    });
    store.recordCollectionRouteVerification("legacy-v6-three-slot", {
      status: "verified",
      routeFingerprint: "sha256:legacy-v6-three-slot",
      discoveryProxyExitCountry: "US",
      collectionProxyExitCountries: ["SA", "QA", "EG"]
    });
    store.setActiveCollectionRoute("legacy-v6-three-slot");

    // Recreate the v6 table and deliberately erase the per-slot countries.
    // This is the old model: three distinct endpoints all asserted to be SA.
    store.transaction(() => {
      store.database.exec(`
        ALTER TABLE collection_routes RENAME TO collection_routes_v7;
        DROP INDEX idx_collection_routes_single_active;
        DROP INDEX idx_collection_routes_discovery_country;
        CREATE TABLE collection_routes (
          route_profile_id TEXT PRIMARY KEY,
          market_region TEXT NOT NULL,
          discovery_country TEXT NOT NULL,
          discovery_proxy_server TEXT NOT NULL,
          route_country TEXT NOT NULL,
          backstage_country TEXT NOT NULL,
          market_countries_json TEXT NOT NULL,
          collection_proxy_server TEXT NOT NULL,
          collection_proxy_servers_json TEXT NOT NULL,
          collection_proxy_lane_mode TEXT NOT NULL,
          proxy_server TEXT NOT NULL,
          proxy_fingerprint TEXT NOT NULL,
          discovery_proxy_exit_country TEXT,
          collection_proxy_exit_countries_json TEXT NOT NULL,
          proxy_exit_country TEXT,
          verification_status TEXT NOT NULL DEFAULT 'unverified',
          verification_json TEXT,
          verified_at TEXT,
          active INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          CHECK (active IN (0, 1)),
          CHECK (proxy_server = collection_proxy_server),
          CHECK (json_valid(collection_proxy_servers_json)),
          CHECK (json_type(collection_proxy_servers_json) = 'array'),
          CHECK (json_array_length(collection_proxy_servers_json) IN (1, 3)),
          CHECK (json_valid(collection_proxy_exit_countries_json)),
          CHECK (json_type(collection_proxy_exit_countries_json) = 'array'),
          CHECK (json_array_length(collection_proxy_exit_countries_json) IN (0, 1, 3)),
          CHECK (collection_proxy_lane_mode IN ('exact_three_lane', 'degraded_single_lane'))
        ) STRICT;
        INSERT INTO collection_routes(
          route_profile_id, market_region, discovery_country, discovery_proxy_server,
          route_country, backstage_country, market_countries_json,
          collection_proxy_server, collection_proxy_servers_json,
          collection_proxy_lane_mode, proxy_server, proxy_fingerprint,
          discovery_proxy_exit_country, collection_proxy_exit_countries_json,
          proxy_exit_country, verification_status, verification_json, verified_at,
          active, created_at, updated_at
        )
        SELECT
          route_profile_id, market_region, discovery_country, discovery_proxy_server,
          route_country, backstage_country, market_countries_json,
          collection_proxy_server, collection_proxy_servers_json,
          'exact_three_lane', proxy_server, proxy_fingerprint,
          discovery_proxy_exit_country, json_array(route_country, route_country, route_country),
          route_country, 'verified', verification_json, verified_at,
          1, created_at, updated_at
        FROM collection_routes_v7;
        DROP TABLE collection_routes_v7;
        CREATE UNIQUE INDEX idx_collection_routes_single_active
          ON collection_routes(active) WHERE active = 1;
        CREATE INDEX idx_collection_routes_discovery_country
          ON collection_routes(discovery_country, updated_at DESC);
        DELETE FROM schema_migrations WHERE version >= 7;
        PRAGMA user_version = 6;
      `);
    });
    store.close();

    const reopened = createDatabase(databasePath, options);
    const route = reopened.getCollectionRoute("legacy-v6-three-slot");
    assert.equal(reopened.database.prepare("PRAGMA user_version").get().user_version, 8);
    assert.equal(route.collectionProxyLaneMode, "legacy_ambiguous_v5");
    assert.deepEqual(route.collectionProxyServers, [
      "http://127.0.0.1:18101",
      "http://127.0.0.1:18102",
      "http://127.0.0.1:18103"
    ]);
    assert.deepEqual(route.collectionCountryCodes, []);
    assert.deepEqual(route.collectionLanes, []);
    assert.equal(route.migrationRequired, true);
    assert.equal(route.verificationStatus, "unverified");
    assert.equal(route.verifiedAt, null);
    assert.equal(route.active, false);
    assert.throws(
      () => reopened.setActiveCollectionRoute("legacy-v6-three-slot"),
      (error) => error.code === "COLLECTION_LANE_MIGRATION_REQUIRED"
    );
    assert.throws(
      () => reopened.recordCollectionRouteVerification("legacy-v6-three-slot", {
        status: "verified",
        routeFingerprint: "sha256:legacy-v6-three-slot",
        discoveryProxyExitCountry: "US",
        collectionProxyExitCountries: ["SA", "QA", "EG"]
      }),
      (error) => error.code === "COLLECTION_LANE_MIGRATION_REQUIRED"
    );

    const repaired = reopened.upsertCollectionRoute({
      routeProfileId: "legacy-v6-three-slot",
      collectionCountryCodes: ["SA", "QA", "EG"],
      routeFingerprint: "sha256:repaired-country-lanes"
    });
    assert.equal(repaired.migrationRequired, false);
    assert.deepEqual(repaired.collectionProxyServers, route.collectionProxyServers);
    assert.deepEqual(repaired.collectionCountryCodes, ["SA", "QA", "EG"]);
    assert.deepEqual(repaired.collectionProxyExitCountries, []);
    assert.equal(repaired.verificationStatus, "unverified");
    reopened.close();
  });
});

test("qualification batches append independent evidence without overwriting discovery data", async (t) => {
  await withDatabase(t, async ({ store }) => {
    store.createRun({ runId: "run-qualification", source: "tiktok_live" });
    const created = store.upsertProspect({
      runId: "run-qualification",
      source: "tiktok_live",
      handle: "alice.live",
      displayName: "Alice",
      followers: 12_345,
      live: true,
      observedAt: "2026-08-22T01:00:00.000Z",
      data: { discoveryMarker: "must-survive" }
    });
    const candidateId = created.prospect.candidateId;

    store.recordQualificationBatch({
      batchId: "qualification-batch-1",
      runId: "run-qualification",
      records: [{
        candidateId,
        qualificationStatus: "region_mismatch",
        observedAt: "2026-08-22T02:00:00.000Z",
        sourceUrl: "https://live-backstage.tiktok.com/portal/anchor/relation",
        confidence: 1,
        data: { qualificationReason: { anchorStatusCode: 2 } }
      }]
    });
    store.recordQualificationBatch({
      batchId: "qualification-batch-2",
      runId: "run-qualification",
      records: [{
        candidateId,
        qualificationStatus: "available",
        observedAt: "2026-08-22T03:00:00.000Z",
        sourceUrl: "https://live-backstage.tiktok.com/portal/anchor/relation",
        confidence: 1,
        data: { qualificationReason: { anchorStatusCode: 0 } }
      }]
    });

    const raw = store.database.prepare("SELECT * FROM prospects WHERE candidate_id = ?").get(candidateId);
    assert.equal(raw.latest_source, "tiktok_live");
    assert.equal(raw.last_seen_at, "2026-08-22T01:00:00.000Z");
    assert.equal(JSON.parse(raw.data_json).discoveryMarker, "must-survive");
    assert.equal(raw.invitation_eligibility, "available");

    const readBack = store.queryProspects({ runId: "run-qualification", source: "tiktok_live" })[0];
    assert.equal(readBack.latestDiscoveryObservation.source, "tiktok_live");
    assert.equal(readBack.latestDiscoveryObservation.observedAt, "2026-08-22T01:00:00.000Z");
    assert.equal(readBack.latestQualificationObservation.source, "collection_backstage");
    assert.equal(readBack.latestQualificationObservation.invitationEligibility, "available");
    assert.deepEqual(readBack.latestQualificationObservation.data, { qualificationReason: { anchorStatusCode: 0 } });
    assert.equal(
      store.database.prepare("SELECT COUNT(*) AS count FROM prospect_observations WHERE source = 'collection_backstage'").get().count,
      2
    );
  });
});

test("handoff and outbox writes are idempotent and expose pending work", async (t) => {
  await withDatabase(t, async ({ store }) => {
    store.createRun({ runId: "run-handoff" });
    const firstBatch = store.createHandoffBatch({
      runId: "run-handoff",
      idempotencyKey: "handoff:run-handoff:v1",
      purpose: "creator-recruitment",
      candidateCount: 2,
      payload: { candidateIds: ["candidate-a", "candidate-b"] }
    });
    const repeatedBatch = store.createHandoffBatch({
      runId: "run-handoff",
      idempotencyKey: "handoff:run-handoff:v1",
      candidateCount: 999
    });
    assert.equal(repeatedBatch.batchId, firstBatch.batchId);
    assert.equal(repeatedBatch.candidateCount, 2);
    assert.equal(store.listPendingHandoffs().length, 1);

    store.updateHandoffBatch(firstBatch.batchId, {
      status: "approved",
      approvedBy: "user",
      approvedAt: "2026-08-22T03:00:00.000Z"
    });
    const outbox = store.createOutboxEvent({
      idempotencyKey: `handoff:${firstBatch.batchId}:dispatch`,
      aggregateType: "handoff_batch",
      aggregateId: firstBatch.batchId,
      eventType: "handoff.dispatch_requested",
      payload: { destination: "digital-employee" }
    });
    const repeatedOutbox = store.createOutboxEvent({
      idempotencyKey: `handoff:${firstBatch.batchId}:dispatch`,
      aggregateType: "handoff_batch",
      aggregateId: firstBatch.batchId,
      eventType: "handoff.dispatch_requested",
      payload: { destination: "must-not-overwrite" }
    });
    assert.equal(repeatedOutbox.outboxId, outbox.outboxId);
    assert.deepEqual(repeatedOutbox.payload, { destination: "digital-employee" });
    assert.equal(store.listPendingOutbox().length, 1);

    store.updateOutboxEvent(outbox.outboxId, {
      status: "delivered",
      attempts: 1,
      deliveredAt: "2026-08-22T03:00:00.000Z"
    });
    assert.equal(store.listPendingOutbox().length, 0);
  });
});

test("persists market region and creator country on prospects and observations", async (t) => {
  await withDatabase(t, async ({ store }) => {
    store.createRun({ runId: "run-market-country", source: "ranking" });
    const created = store.upsertProspect({
      runId: "run-market-country",
      source: "ranking",
      handle: "mena.creator",
      marketRegion: "MENA",
      creatorCountryCode: "SA",
      observation: {
        sourceUrl: "https://www.tiktok.com/@mena.creator",
        marketRegion: "MENA",
        creatorCountryCode: "SA"
      }
    });

    assert.equal(created.prospect.marketRegion, "MENA");
    assert.equal(created.prospect.creatorCountryCode, "SA");
    assert.equal(created.observation.marketRegion, "MENA");
    assert.equal(created.observation.creatorCountryCode, "SA");
    assert.equal(store.queryProspects({ marketRegion: "MENA", creatorCountryCode: "SA" }).length, 1);
    assert.equal(store.queryProspects({ creatorCountryCode: "AE" }).length, 0);

    store.recordQualificationBatch({
      batchId: "market-country-check",
      runId: "run-market-country",
      records: [{
        candidateId: created.prospect.candidateId,
        qualificationStatus: "available",
        marketRegion: "MENA",
        creatorCountryCode: "SA"
      }]
    });
    const readBack = store.getProspect(created.prospect.candidateId);
    assert.equal(readBack.latestQualificationObservation.marketRegion, "MENA");
    assert.equal(readBack.latestQualificationObservation.creatorCountryCode, "SA");

    const raw = store.database.prepare(`
      SELECT market_region, creator_country_code FROM prospect_observations
      WHERE prospect_id = ? ORDER BY created_at, observation_id
    `).all(created.prospect.candidateId);
    assert.deepEqual(raw.map((row) => [row.market_region, row.creator_country_code]), [
      ["MENA", "SA"],
      ["MENA", "SA"]
    ]);
  });
});

test("collection routes require verified matching countries before activation", async (t) => {
  await withDatabase(t, async ({ store }) => {
    const first = store.upsertCollectionRoute({
      routeProfileId: "route-sa",
      marketRegion: "MENA",
      marketCountryCodes: ["AE", "SA"],
      discoveryCountry: "US",
      discoveryProxyServer: "http://127.0.0.1:18200",
      routeCountry: "SA",
      backstageCountry: "SA",
      collectionProxyServer: "http://127.0.0.1:18201",
      routeFingerprint: "sha256:dual-sa"
    });
    assert.deepEqual(first.marketCountryCodes, ["AE", "SA"]);
    assert.equal(first.discoveryCountry, "US");
    assert.equal(first.discoveryProxyServer, "http://127.0.0.1:18200");
    assert.equal(first.collectionProxyServer, "http://127.0.0.1:18201");
    assert.deepEqual(first.collectionCountryCodes, ["SA"]);
    assert.deepEqual(first.collectionLanes, [{
      workId: 1,
      countryCode: "SA",
      proxyServer: "http://127.0.0.1:18201"
    }]);
    assert.equal(first.proxyServer, first.collectionProxyServer);
    assert.equal(first.routeFingerprint, "sha256:dual-sa");
    assert.equal(first.proxyFingerprint, first.routeFingerprint);
    assert.equal(first.verificationStatus, "unverified");
    assert.throws(
      () => store.setActiveCollectionRoute("route-sa"),
      (error) => error.code === "ROUTE_NOT_VERIFIED"
    );
    assert.throws(
      () => store.recordCollectionRouteVerification("route-sa", {
        status: "verified",
        routeFingerprint: "sha256:dual-sa",
        discoveryProxyExitCountry: "US",
        proxyExitCountry: "AE"
      }),
      (error) => error.code === "ROUTE_VERIFICATION_COUNTRY_MISMATCH"
    );
    assert.throws(
      () => store.recordCollectionRouteVerification("route-sa", {
        status: "verified",
        routeFingerprint: "sha256:dual-sa",
        discoveryProxyExitCountry: "CA",
        proxyExitCountry: "SA"
      }),
      (error) => error.code === "ROUTE_VERIFICATION_COUNTRY_MISMATCH"
    );

    const verified = store.recordCollectionRouteVerification("route-sa", {
      status: "verified",
      routeFingerprint: "sha256:dual-sa",
      discoveryProxyExitCountry: "US",
      proxyExitCountry: "SA",
      verification: { provider: "ip-check", ip: "203.0.113.10" }
    });
    assert.equal(verified.verificationStatus, "verified");
    assert.equal(verified.discoveryProxyExitCountry, "US");
    assert.equal(verified.proxyExitCountry, "SA");
    assert.deepEqual(verified.verification, { provider: "ip-check", ip: "203.0.113.10" });
    assert.equal(store.setActiveCollectionRoute("route-sa").active, true);

    store.upsertCollectionRoute({
      routeProfileId: "route-ae",
      marketRegion: "MENA",
      marketCountryCodes: ["SA", "AE"],
      discoveryCountry: "US",
      discoveryProxyServer: "http://127.0.0.1:18200",
      routeCountry: "AE",
      backstageCountry: "AE",
      collectionProxyServer: "http://127.0.0.1:18202",
      proxyFingerprint: "sha256:ae"
    });
    store.recordCollectionRouteVerification("route-ae", {
      status: "verified",
      proxyFingerprint: "sha256:ae",
      discoveryProxyExitCountry: "US",
      proxyExitCountry: "AE"
    });
    store.setActiveCollectionRoute("route-ae");
    assert.equal(store.getActiveCollectionRoute().routeProfileId, "route-ae");
    assert.equal(store.getCollectionRoute("route-sa").active, false);
    assert.equal(store.listCollectionRoutes({ marketRegion: "MENA", verificationStatus: "verified" }).length, 2);
    assert.equal(store.listCollectionRoutes({ discoveryCountry: "US" }).length, 2);

    const changed = store.upsertCollectionRoute({
      routeProfileId: "route-ae",
      collectionProxyServer: "http://127.0.0.1:18212",
      proxyFingerprint: "sha256:replacement",
      active: false
    });
    assert.equal(changed.verificationStatus, "unverified");
    assert.equal(changed.discoveryProxyExitCountry, null);
    assert.equal(changed.proxyExitCountry, null);
    assert.equal(changed.verifiedAt, null);
    assert.equal(changed.active, false);
    assert.equal(store.getActiveCollectionRoute(), null);
    assert.throws(
      () => store.recordCollectionRouteVerification("route-ae", {
        status: "verified",
        proxyFingerprint: "sha256:ae",
        discoveryProxyExitCountry: "US",
        proxyExitCountry: "AE"
      }),
      (error) => error.code === "ROUTE_FINGERPRINT_MISMATCH"
    );
    assert.equal(store.getCollectionRoute("route-ae").verificationStatus, "unverified");
    assert.throws(
      () => store.recordCollectionRouteVerification("route-ae", {
        status: "verified",
        discoveryProxyExitCountry: "US",
        proxyExitCountry: "AE"
      }),
      (error) => error.code === "ROUTE_FINGERPRINT_REQUIRED"
    );
    assert.throws(
      () => store.upsertCollectionRoute({
        routeProfileId: "route-ae",
        collectionProxyServer: "http://127.0.0.1:18213",
        proxyServer: "http://127.0.0.1:18214",
        active: false
      }),
      (error) => error.code === "COLLECTION_PROXY_ALIAS_MISMATCH"
    );
  });
});

test("collection routes persist one proxy per country and verify every lane by index", async (t) => {
  await withDatabase(t, async ({ store }) => {
    const route = store.upsertCollectionRoute({
      routeProfileId: "route-sa-three-lane",
      marketRegion: "MENA",
      marketCountryCodes: ["SA", "QA", "AE", "EG"],
      discoveryCountry: "US",
      discoveryProxyServer: "socks5://127.0.0.1:18000",
      collectionLanes: [
        { countryCode: "SA", proxyServer: "socks5://127.0.0.1:18001" },
        { countryCode: "QA", proxyServer: "socks5://127.0.0.1:18002" },
        { countryCode: "EG", proxyServer: "socks5://127.0.0.1:18003" }
      ],
      routeFingerprint: "sha256:three-lane-sa"
    });
    assert.equal(route.collectionProxyLaneMode, "country_lanes");
    assert.equal(route.collectionProxyLaneCount, 3);
    assert.equal(route.collectionProxyServer, "socks5://127.0.0.1:18001");
    assert.deepEqual(route.collectionCountryCodes, ["SA", "QA", "EG"]);
    assert.deepEqual(route.collectionLanes, [
      { workId: 1, countryCode: "SA", proxyServer: "socks5://127.0.0.1:18001" },
      { workId: 2, countryCode: "QA", proxyServer: "socks5://127.0.0.1:18002" },
      { workId: 3, countryCode: "EG", proxyServer: "socks5://127.0.0.1:18003" }
    ]);
    assert.deepEqual(route.collectionProxyServers, [
      "socks5://127.0.0.1:18001",
      "socks5://127.0.0.1:18002",
      "socks5://127.0.0.1:18003"
    ]);
    assert.deepEqual(route.collectionProxyExitCountries, []);

    assert.throws(
      () => store.recordCollectionRouteVerification("route-sa-three-lane", {
        status: "verified",
        routeFingerprint: "sha256:three-lane-sa",
        discoveryProxyExitCountry: "US",
        proxyExitCountry: "SA"
      }),
      (error) => error.code === "ROUTE_VERIFICATION_COUNTRY_MISMATCH"
    );
    assert.throws(
      () => store.recordCollectionRouteVerification("route-sa-three-lane", {
        status: "verified",
        routeFingerprint: "sha256:three-lane-sa",
        discoveryProxyExitCountry: "US",
        collectionProxyExitCountries: ["SA", "EG", "EG"]
      }),
      (error) => error.code === "ROUTE_VERIFICATION_COUNTRY_MISMATCH"
    );

    const verified = store.recordCollectionRouteVerification("route-sa-three-lane", {
      status: "verified",
      routeFingerprint: "sha256:three-lane-sa",
      discoveryProxyExitCountry: "US",
      collectionProxyExitCountries: ["SA", "QA", "EG"]
    });
    assert.equal(verified.proxyExitCountry, "SA");
    assert.deepEqual(verified.collectionProxyExitCountries, ["SA", "QA", "EG"]);
    assert.equal(store.setActiveCollectionRoute("route-sa-three-lane").active, true);

    const changed = store.upsertCollectionRoute({
      routeProfileId: "route-sa-three-lane",
      collectionProxyServers: [
        "socks5://127.0.0.1:18001",
        "socks5://127.0.0.1:18002",
        "socks5://127.0.0.1:18013"
      ],
      routeFingerprint: "sha256:three-lane-sa-v2",
      active: false
    });
    assert.equal(changed.verificationStatus, "unverified");
    assert.deepEqual(changed.collectionProxyExitCountries, []);
    assert.equal(changed.proxyExitCountry, null);

    const twoLane = store.upsertCollectionRoute({
      routeProfileId: "route-two-lanes",
      marketRegion: "MENA",
      marketCountryCodes: ["SA", "QA", "EG"],
      discoveryCountry: "US",
      discoveryProxyServer: "socks5://127.0.0.1:19000",
      collectionLanes: [
        { countryCode: "SA", proxyServer: "socks5://127.0.0.1:19001" },
        { countryCode: "QA", proxyServer: "socks5://127.0.0.1:19002" }
      ],
      routeFingerprint: "sha256:two-lanes"
    });
    assert.equal(twoLane.collectionProxyLaneCount, 2);
    assert.deepEqual(twoLane.collectionCountryCodes, ["SA", "QA"]);

    assert.throws(
      () => store.upsertCollectionRoute({
        routeProfileId: "route-ambiguous-old-arrays",
        marketRegion: "MENA",
        marketCountryCodes: ["SA", "QA"],
        discoveryCountry: "US",
        discoveryProxyServer: "socks5://127.0.0.1:19100",
        routeCountry: "SA",
        collectionProxyServers: [
          "socks5://127.0.0.1:19101",
          "socks5://127.0.0.1:19102"
        ],
        routeFingerprint: "sha256:ambiguous"
      }),
      (error) => error.code === "COLLECTION_LANE_COUNTRIES_REQUIRED"
    );
  });
});

test("qualification reservations persist policy targets and enforce rolling budgets", async (t) => {
  await withMutableDatabase(t, async ({ store, databasePath, options, setTime }) => {
    store.createRun({ runId: "run-budget", source: "ranking" });
    const candidates = ["candidate-b", "candidate-a", "candidate-c"].map((candidateId) => (
      store.upsertProspect({
        candidateId,
        runId: "run-budget",
        source: "ranking",
        handle: candidateId
      }).prospect.candidateId
    ));
    const policy = store.upsertQualificationPolicyState({
      hourlyTarget: 2,
      dailyTarget: 3,
      epochStartedAt: "2026-08-22T00:00:00.000Z",
      epochEndsAt: "2026-08-23T00:00:00.000Z"
    });
    assert.equal(policy.hourlyTarget, 2);
    assert.equal(policy.dailyTarget, 3);
    assert.equal(store.getQualificationPolicyState({ at: "2026-08-22T03:00:00.000Z" }).active, true);
    assert.equal(store.getQualificationPolicyState({ at: "2026-08-23T00:00:00.000Z", activeOnly: true }), null);

    const first = store.reserveQualificationBatch({
      batchId: "batch-first",
      runId: "run-budget",
      candidateIds: [candidates[0], candidates[1]],
      attemptedAt: "2026-08-22T03:00:00.000Z",
      minimumSpacingSeconds: 60
    });
    assert.equal(first.alreadyReserved, false);
    assert.deepEqual(first.candidateIds, ["candidate-b", "candidate-a"]);
    assert.deepEqual(first.items.map((item) => item.ordinal), [0, 1]);
    assert.equal(first.usageBefore.hourlyUsed, 0);
    assert.equal(first.hourlyLimit, 2);
    assert.equal(first.dailyLimit, 3);

    const repeatedReservation = store.reserveQualificationBatch({
      batchId: "batch-first",
      runId: "run-budget",
      candidateIds: [candidates[1], candidates[0]],
      attemptedAt: "2026-08-22T03:00:30.000Z"
    });
    assert.equal(repeatedReservation.alreadyReserved, true);
    assert.equal(store.getQualificationUsage({ at: "2026-08-22T03:00:30.000Z" }).hourlyUsed, 1);

    setTime("2026-08-22T03:00:10.000Z");
    const failed = store.finishQualificationBatch("batch-first", {
      status: "failed",
      errorCode: "BACKSTAGE_TIMEOUT",
      results: [{ candidateId: "candidate-a", resultStatus: "transport_error" }]
    });
    assert.equal(failed.status, "failed");
    assert.equal(failed.errorCode, "BACKSTAGE_TIMEOUT");
    assert.equal(failed.items.find((item) => item.candidateId === "candidate-a").resultStatus, "transport_error");
    const spacingUsage = store.getQualificationUsage({
      at: "2026-08-22T03:00:30.000Z",
      minimumSpacingSeconds: 10
    });
    assert.equal(spacingUsage.hourlyUsed, 1);
    assert.deepEqual(spacingUsage.blockedBy, ["minimum_spacing"]);
    assert.equal(spacingUsage.nextEligibleAt, "2026-08-22T03:01:00.000Z");

    assert.throws(
      () => store.reserveQualificationBatch({
        batchId: "batch-default-repeat",
        runId: "run-budget",
        candidateIds: ["candidate-a"],
        attemptedAt: "2026-08-22T03:01:00.000Z"
      }),
      (error) => error.code === "QUALIFICATION_CANDIDATE_ALREADY_ATTEMPTED"
    );
    setTime("2026-08-22T03:01:00.000Z");
    const manualRecheck = store.reserveQualificationBatch({
      batchId: "batch-manual-repeat",
      runId: "run-budget",
      candidateIds: ["candidate-a"],
      attemptedAt: "2026-08-22T03:01:00.000Z",
      allowPreviouslyAttempted: true,
      details: { reason: "explicit user recheck" }
    });
    assert.equal(manualRecheck.alreadyReserved, false);
    assert.equal(manualRecheck.usageBefore.hourlyUsed, 1);

    assert.throws(
      () => store.reserveQualificationBatch({
        batchId: "batch-hourly-blocked",
        runId: "run-budget",
        candidateIds: ["candidate-c"],
        attemptedAt: "2026-08-22T03:02:00.000Z"
      }),
      (error) => error.code === "QUALIFICATION_BUDGET_EXHAUSTED"
        && error.details.blockedBy.includes("hourly_limit")
    );

    setTime("2026-08-22T04:00:00.000Z");
    const boundaryUsage = store.getQualificationUsage();
    assert.equal(boundaryUsage.hourlyUsed, 1);
    assert.equal(boundaryUsage.dailyUsed, 2);
    const third = store.reserveQualificationBatch({
      batchId: "batch-third",
      runId: "run-budget",
      candidateIds: ["candidate-c"],
      attemptedAt: "2026-08-22T04:00:00.000Z"
    });
    assert.equal(third.usageBefore.hourlyUsed, 1);
    assert.throws(
      () => store.getQualificationUsage({ hourlyLimit: 56 }),
      (error) => error.code === "QUALIFICATION_LIMIT_EXCEEDS_HARD_CAP"
    );
    assert.throws(
      () => store.reserveQualificationBatch({
        batchId: "batch-daily-blocked",
        runId: "run-budget",
        candidateIds: ["candidate-c"],
        attemptedAt: "2026-08-22T04:01:00.000Z",
        allowPreviouslyAttempted: true
      }),
      (error) => error.code === "QUALIFICATION_BUDGET_EXHAUSTED"
        && error.details.blockedBy.includes("daily_limit")
    );

    store.close();
    const reopened = createDatabase(databasePath, options);
    assert.equal(reopened.getQualificationPolicyState().hourlyTarget, 2);
    assert.equal(reopened.getQualificationBatch("batch-first").status, "failed");
    assert.equal(reopened.getQualificationUsage({ at: "2026-08-22T04:00:00.000Z" }).dailyUsed, 3);
    reopened.close();
  });
});

test("recovers reserved qualification batches as terminal ambiguous attempts", async (t) => {
  await withDatabase(t, async ({ store, databasePath, options }) => {
    store.createRun({ runId: "run-recovery", source: "ranking" });
    for (const candidateId of ["candidate-reserved", "candidate-completed"]) {
      store.upsertProspect({
        candidateId,
        runId: "run-recovery",
        source: "ranking",
        handle: candidateId
      });
    }
    store.reserveQualificationBatch({
      batchId: "batch-reserved",
      runId: "run-recovery",
      candidateIds: ["candidate-reserved"],
      attemptedAt: "2026-08-22T02:58:00.000Z",
      details: { automatic: true, reason: "full-auto qualification" }
    });
    store.reserveQualificationBatch({
      batchId: "batch-completed",
      runId: "run-recovery",
      candidateIds: ["candidate-completed"],
      attemptedAt: "2026-08-22T02:59:00.000Z"
    });
    store.finishQualificationBatch("batch-completed", {
      status: "completed",
      results: [{ candidateId: "candidate-completed", resultStatus: "available" }]
    });

    assert.deepEqual(
      store.listReservedQualificationBatches({ runId: "run-recovery" }).map((batch) => batch.batchId),
      ["batch-reserved"]
    );
    store.close();

    const reopened = createDatabase(databasePath, options);
    const recovery = reopened.recoverReservedQualificationBatches({
      recoveredAt: "2026-08-22T03:05:00.000Z",
      details: { reason: "daemon_restarted" }
    });
    assert.equal(recovery.count, 1);
    assert.deepEqual(recovery.candidateIds, ["candidate-reserved"]);
    assert.equal(recovery.batches[0].batchId, "batch-reserved");
    assert.equal(recovery.batches[0].status, "ambiguous");
    assert.equal(recovery.batches[0].finishedAt, "2026-08-22T03:05:00.000Z");
    assert.equal(recovery.batches[0].errorCode, "QUALIFICATION_OUTCOME_AMBIGUOUS");
    assert.equal(recovery.batches[0].items[0].resultStatus, "ambiguous");
    assert.deepEqual(recovery.batches[0].details, {
      automatic: true,
      reason: "daemon_restarted",
      recovery: {
        outcome: "ambiguous",
        qualificationComplete: false,
        automaticRetry: false,
        recoveredAt: "2026-08-22T03:05:00.000Z"
      }
    });
    assert.equal(reopened.getQualificationBatch("batch-completed").status, "completed");
    assert.equal(reopened.listReservedQualificationBatches().length, 0);
    assert.equal(reopened.recoverReservedQualificationBatches().count, 0);
    assert.equal(reopened.getQualificationUsage({ at: "2026-08-22T03:05:00.000Z" }).dailyUsed, 2);
    assert.equal(reopened.listUnattemptedRunProspects({ runId: "run-recovery" }).length, 0);
    reopened.close();
  });
});

test("counts future-dated qualification attempts conservatively after clock rollback", async (t) => {
  await withMutableDatabase(t, async ({ store, setTime }) => {
    store.createRun({ runId: "run-clock-rollback", source: "ranking" });
    for (const candidateId of ["candidate-before-rollback", "candidate-after-rollback"]) {
      store.upsertProspect({
        candidateId,
        runId: "run-clock-rollback",
        source: "ranking",
        handle: candidateId
      });
    }
    store.upsertQualificationPolicyState({
      hourlyTarget: 1,
      dailyTarget: 2,
      epochStartedAt: "2026-08-22T00:00:00.000Z",
      epochEndsAt: "2026-08-23T00:00:00.000Z"
    });
    setTime("2026-08-22T03:10:00.000Z");
    store.reserveQualificationBatch({
      batchId: "batch-before-rollback",
      runId: "run-clock-rollback",
      candidateIds: ["candidate-before-rollback"],
      minimumSpacingSeconds: 60
    });

    setTime("2026-08-22T03:00:00.000Z");
    const usage = store.getQualificationUsage();
    assert.equal(usage.hourlyUsed, 1);
    assert.equal(usage.dailyUsed, 1);
    assert.deepEqual(usage.blockedBy, ["hourly_limit", "minimum_spacing"]);
    assert.equal(usage.hourlyReleaseAt, "2026-08-22T04:10:00.000Z");
    assert.equal(usage.spacingReleaseAt, "2026-08-22T03:11:00.000Z");
    assert.equal(usage.nextEligibleAt, "2026-08-22T04:10:00.000Z");
    assert.throws(
      () => store.reserveQualificationBatch({
        batchId: "batch-after-rollback",
        runId: "run-clock-rollback",
        candidateIds: ["candidate-after-rollback"]
      }),
      (error) => error.code === "QUALIFICATION_BUDGET_EXHAUSTED"
    );
  });
});

test("lists unattempted run prospects with offsets beyond two thousand", async (t) => {
  await withDatabase(t, async ({ store }) => {
    const runId = "run-large";
    const timestamp = "2026-08-22T03:00:00.000Z";
    store.createRun({ runId, source: "ranking" });
    store.transaction(() => {
      const insertProspect = store.database.prepare(`
        INSERT INTO prospects(
          candidate_id, identity_key, handle, handle_normalized, latest_source,
          first_seen_at, last_seen_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'ranking', ?, ?, ?, ?)
      `);
      const insertObservation = store.database.prepare(`
        INSERT INTO prospect_observations(
          observation_id, observation_key, prospect_id, run_id, source, observed_at, created_at
        ) VALUES (?, ?, ?, ?, 'ranking', ?, ?)
      `);
      for (let index = 0; index < 2_005; index += 1) {
        const suffix = String(index).padStart(4, "0");
        const candidateId = `candidate-${suffix}`;
        const handle = `creator-${suffix}`;
        insertProspect.run(
          candidateId, `handle:${handle}`, handle, handle,
          timestamp, timestamp, timestamp, timestamp
        );
        insertObservation.run(
          `observation-${suffix}`, `observation-key-${suffix}`,
          candidateId, runId, timestamp, timestamp
        );
      }
    });

    const tail = store.listUnattemptedRunProspects({ runId, limit: 10, offset: 2_000 });
    assert.deepEqual(tail.map((prospect) => prospect.candidateId), [
      "candidate-2000", "candidate-2001", "candidate-2002", "candidate-2003", "candidate-2004"
    ]);
    assert.equal(tail[0].latestDiscoveryObservation.runId, runId);

    store.reserveQualificationBatch({
      batchId: "batch-tail",
      runId,
      candidateIds: ["candidate-2002"]
    });
    const unattemptedTail = store.listUnattemptedRunProspects(runId, { limit: 10, offset: 2_000 });
    assert.deepEqual(unattemptedTail.map((prospect) => prospect.candidateId), [
      "candidate-2000", "candidate-2001", "candidate-2003", "candidate-2004"
    ]);
  });
});

test("collection cleanup previews an exact snapshot and transactionally preserves protected state", async (t) => {
  await withMutableDatabase(t, async ({ store, setTime }) => {
    const oldAt = "2026-08-18T00:00:00.000Z";
    const cutoff = "2026-08-22T02:30:00.000Z";
    const now = "2026-08-22T03:00:00.000Z";
    setTime(oldAt);

    store.upsertSession({
      sessionKey: "collection_backstage",
      kind: "collection_backstage",
      profilePath: "/isolated/collection-backstage",
      status: "authenticated",
      authenticatedAt: oldAt
    });
    store.upsertCollectionRoute({
      routeProfileId: "route-cleanup-protected",
      marketRegion: "MENA",
      marketCountryCodes: ["SA"],
      discoveryCountry: "US",
      discoveryProxyServer: "http://127.0.0.1:19200",
      routeCountry: "SA",
      backstageCountry: "SA",
      collectionProxyServer: "http://127.0.0.1:19201",
      routeFingerprint: "sha256:cleanup-protected"
    });
    store.upsertQualificationPolicyState({
      hourlyTarget: 55,
      dailyTarget: 150,
      epochStartedAt: "2026-08-01T00:00:00.000Z",
      epochEndsAt: "2026-09-01T00:00:00.000Z"
    });
    store.createRun({
      runId: "run-cleanup-terminal",
      source: "tiktok_live",
      status: "completed",
      createdAt: oldAt
    });
    store.createRun({
      runId: "run-cleanup-paused",
      source: "tiktok_live",
      status: "paused",
      createdAt: oldAt
    });
    store.saveCheckpoint("run-cleanup-terminal", "page", { page: 4 });
    const queued = store.enqueueOriginalDiscoverySeed({
      runId: "run-cleanup-terminal",
      seedKind: "feed",
      identityKey: "SA:cleanup-seed",
      payload: { internalPayloadSentinel: "MUST_NOT_BE_RETURNED_BY_PREVIEW" },
      at: oldAt
    });

    const addCandidate = (candidateId, runId = "run-cleanup-terminal") => {
      store.upsertProspect({
        candidateId,
        runId,
        source: "tiktok_live",
        handle: candidateId,
        observedAt: oldAt,
        observationKey: `observation:${candidateId}`
      });
    };
    for (const candidateId of [
      "candidate-cleanup-delete",
      "candidate-cleanup-committed",
      "candidate-cleanup-pending",
      "candidate-cleanup-recent-qualification"
    ]) addCandidate(candidateId);
    addCandidate("candidate-cleanup-paused", "run-cleanup-paused");

    store.reserveQualificationBatch({
      batchId: "qualification-cleanup-old",
      runId: "run-cleanup-terminal",
      candidateIds: ["candidate-cleanup-delete"],
      attemptedAt: oldAt
    });
    store.finishQualificationBatch("qualification-cleanup-old", {
      status: "completed",
      finishedAt: oldAt,
      results: [{ candidateId: "candidate-cleanup-delete", resultStatus: "eligible" }]
    });

    const approvedHandoff = store.createHandoffBatch({
      batchId: "handoff-cleanup-approved",
      runId: "run-cleanup-terminal",
      status: "approved",
      approvedBy: "user",
      approvedAt: oldAt,
      candidateCount: 1,
      payload: {
        datasetHash: "approved-dataset",
        candidates: [{ candidateId: "candidate-cleanup-committed", handle: "protected" }]
      }
    });
    store.createOutboxEvent({
      outboxId: "outbox-cleanup-approved",
      idempotencyKey: "cleanup-approved-outbox",
      aggregateType: "handoff_batch",
      aggregateId: approvedHandoff.batchId,
      eventType: "candidate_batch.ready",
      payload: { immutablePayloadSentinel: "PRESERVE_APPROVED_HANDOFF" }
    });
    store.createHandoffBatch({
      batchId: "handoff-cleanup-pending",
      runId: "run-cleanup-terminal",
      status: "pending_review",
      candidateCount: 1,
      payload: { candidates: [{ candidateId: "candidate-cleanup-pending" }] }
    });
    store.appendAudit({
      auditId: "audit-cleanup-protected",
      action: "cleanup_test_source_audit",
      runId: "run-cleanup-terminal",
      details: { immutableAuditSentinel: "PRESERVE_AUDIT" },
      occurredAt: oldAt
    });

    setTime("2026-08-22T02:00:00.000Z");
    store.reserveQualificationBatch({
      batchId: "qualification-cleanup-recent",
      runId: "run-cleanup-terminal",
      candidateIds: ["candidate-cleanup-recent-qualification"],
      attemptedAt: "2026-08-22T02:00:00.000Z"
    });
    store.finishQualificationBatch("qualification-cleanup-recent", {
      status: "completed",
      finishedAt: "2026-08-22T02:01:00.000Z",
      results: [{
        candidateId: "candidate-cleanup-recent-qualification",
        resultStatus: "eligible"
      }]
    });
    setTime("2026-08-22T02:45:00.000Z");
    store.createRun({
      runId: "run-cleanup-recently-finished",
      source: "tiktok_live",
      status: "completed",
      createdAt: oldAt,
      finishedAt: "2026-08-22T02:45:00.000Z"
    });
    setTime(now);

    const preview = store.previewCollectionCleanup({ cutoff });
    assert.deepEqual(preview.deleteCounts, {
      sessions: 0,
      collectionRuns: 1,
      checkpoints: 1,
      prospects: 2,
      prospectObservations: 4,
      handoffBatches: 1,
      outbox: 0,
      auditEvents: 0,
      collectionRoutes: 0,
      qualificationBatches: 1,
      qualificationBatchItems: 1,
      qualificationPolicyState: 0,
      discoverySeedQueue: 1
    });
    assert.equal(preview.cutoff, cutoff);
    assert.match(preview.previewHash, /^[a-f0-9]{64}$/);
    assert.equal(preview.protectedCounts.auditEvents, 1);
    assert.equal(preview.protectedCounts.committedHandoffs, 1);
    assert.equal(preview.protectedCounts.outbox, 1);
    assert.equal(preview.protectedCounts.sessions, 1);
    assert.equal(preview.protectedCounts.collectionRoutes, 1);
    assert.equal(preview.protectedCounts.qualificationPolicyState, 1);
    assert.equal(preview.protectedCounts.nonterminalOrRecentlyFinishedRuns, 2);
    assert.equal(preview.protectedCounts.qualificationBatchesInRollingWindowOrReserved, 1);
    assert.equal(preview.recoverability.recoverable, false);
    assert.equal(preview.recoverability.backupCreated, false);
    assert.equal(JSON.stringify(preview).includes("MUST_NOT_BE_RETURNED_BY_PREVIEW"), false);

    store.saveCheckpoint("run-cleanup-terminal", "late-change", { page: 5 });
    assert.throws(
      () => store.commitCollectionCleanup({
        cutoff,
        expectedPreviewHash: preview.previewHash,
        actor: "user"
      }),
      (error) => error.code === "COLLECTION_CLEANUP_PREVIEW_STALE"
    );
    assert.notEqual(store.getRun("run-cleanup-terminal"), null);
    assert.notEqual(store.getDiscoverySeed(queued.seed.queueId), null);

    const freshPreview = store.previewCollectionCleanup({ cutoff });
    assert.equal(freshPreview.deleteCounts.checkpoints, 2);
    assert.notEqual(freshPreview.previewHash, preview.previewHash);
    const committed = store.commitCollectionCleanup({
      cutoff,
      expectedPreviewHash: freshPreview.previewHash,
      actor: "user"
    });
    assert.equal(committed.committed, true);
    assert.equal(committed.cutoff, cutoff);
    assert.deepEqual(committed.deleteCounts, freshPreview.deleteCounts);
    assert.equal(committed.recoverability.recoverable, false);
    assert.equal(committed.recoverability.backupCreated, false);

    assert.equal(store.getRun("run-cleanup-terminal"), null);
    assert.notEqual(store.getRun("run-cleanup-paused"), null);
    assert.notEqual(store.getRun("run-cleanup-recently-finished"), null);
    assert.equal(store.getDiscoverySeed(queued.seed.queueId), null);
    assert.equal(store.getProspect("candidate-cleanup-delete"), null);
    assert.equal(store.getProspect("candidate-cleanup-pending"), null);
    assert.notEqual(store.getProspect("candidate-cleanup-committed"), null);
    assert.notEqual(store.getProspect("candidate-cleanup-paused"), null);
    assert.notEqual(store.getProspect("candidate-cleanup-recent-qualification"), null);
    assert.equal(store.getQualificationBatch("qualification-cleanup-old"), null);
    assert.notEqual(store.getQualificationBatch("qualification-cleanup-recent"), null);
    assert.equal(store.getHandoffBatch("handoff-cleanup-pending"), null);
    assert.equal(
      store.getHandoffBatch("handoff-cleanup-approved").payload.datasetHash,
      "approved-dataset"
    );
    assert.equal(
      store.getOutboxEvent("outbox-cleanup-approved").payload.immutablePayloadSentinel,
      "PRESERVE_APPROVED_HANDOFF"
    );
    assert.equal(store.getSession("collection_backstage").status, "authenticated");
    assert.notEqual(store.getCollectionRoute("route-cleanup-protected"), null);
    assert.notEqual(store.getQualificationPolicyState(), null);
    assert.equal(
      store.listAuditEvents({ action: "cleanup_test_source_audit" })[0].details.immutableAuditSentinel,
      "PRESERVE_AUDIT"
    );
    assert.equal(store.listAuditEvents({ action: "collection_cleanup_committed" }).length, 1);
    assert.equal(committed.protectedCounts.auditEvents, 2);
  });
});

test("late source merge reopens a terminal queue item without stale completion evidence", async t => {
  await withDatabase(t, async ({ store }) => {
    store.createRun({ runId: "late-source-run", source: "tiktok_live" });
    const original = store.enqueueOriginalDiscoverySeed({ runId: "late-source-run", seedKind: "feed", identityKey: "SA:late", payload: { handle: "late", topScore: null } });
    const [claim] = store.claimDueOriginalDiscoverySeeds({ runId: "late-source-run", seedKind: "feed" });
    store.completeOriginalDiscoverySeed(claim.queueId, { claimToken: claim.claimToken, status: "failed", result: { stage: "old" }, error: { code: "old_failure" } });
    const result = store.enqueueOriginalDiscoverySeed({ runId: "late-source-run", seedKind: "feed", identityKey: "SA:late", payload: { topScore: "99" }, mergePayload: (existing, incoming) => ({ ...existing, ...incoming }) });
    assert.equal(result.accepted, true);
    assert.equal(result.seed.queueId, original.seed.queueId);
    assert.equal(result.seed.status, "pending");
    assert.equal(result.seed.completedAt, null);
    assert.equal(result.seed.result, null);
    assert.equal(result.seed.lastError, null);
  });
});
