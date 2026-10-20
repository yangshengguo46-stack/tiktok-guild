import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseStore } from "../mcp/core/database.js";
import { createOriginalRankingQueueSweeper } from "../mcp/core/original-ranking-queue-sweeper.js";
import { DaemonClient } from "../mcp/core/daemon-client.js";
import { runtimePaths } from "../mcp/core/runtime-paths.js";

async function temporaryStore(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tkdesk-stability-"));
  const database = new DatabaseStore(path.join(directory, "test.sqlite")).init();
  t.after(async () => { database.close(); await rm(directory, { recursive: true, force: true }); });
  return database;
}

function dueSeed(database, runId, patch = {}) {
  database.createRun({ runId, source: "tiktok_live", mode: "full_auto", status: "partial", ...patch });
  return database.enqueueOriginalDiscoverySeed({ runId, seedKind: "ranking", identityKey: `SA:${runId}`,
    payload: { candidateId: "private-candidate" }, at: "2020-01-01T00:00:00.000Z" }).seed;
}

test("finished bounded partial runs retain seeds without automatic startup or timer replay", async t => {
  const database = await temporaryStore(t);
  const terminal = dueSeed(database, "bounded-partial");
  database.saveCheckpoint("bounded-partial", "original_collectors", { executionFinished: true, sourceComplete: true, dataComplete: true },
    { adapter: "tiktok_original_cascade" });
  dueSeed(database, "candidate-cap", { result: { discovery: { selectionComplete: true, completionScope: "configured_candidate_limit" } } });
  dueSeed(database, "paused-history", { status: "paused" });
  dueSeed(database, "completed-history", { status: "completed" });
  dueSeed(database, "pending-partial");
  const resumed = [];
  const sweeper = createOriginalRankingQueueSweeper({ database, intervalMs: 300_000,
    preflightRun: async () => ({ ready: true }), resumeRun: async run => {
      resumed.push(run.runId);
      return { queuedInDaemon: true };
    } });
  await sweeper.scan("startup");
  await sweeper.scan("timer");
  assert.deepEqual(resumed, ["pending-partial", "pending-partial"]);
  assert.equal(database.getDiscoverySeed(terminal.queueId).status, "pending", "terminal seed evidence must stay available for explicit review");
  assert.equal(database.getRun("paused-history").status, "paused");
});

test("a pause arriving during asynchronous sweep preflight prevents automatic resume", async t => {
  const database = await temporaryStore(t);
  dueSeed(database, "pause-during-preflight");
  let resumed = 0;
  const sweeper = createOriginalRankingQueueSweeper({ database, intervalMs: 300_000,
    preflightRun: async run => { database.updateRun(run.runId, { status: "paused" }); return { ready: true }; },
    resumeRun: async () => { resumed += 1; return { queuedInDaemon: true }; } });
  const report = await sweeper.scan("timer");
  assert.equal(resumed, 0);
  assert.equal(report.skippedCounts.run_not_resumable, 1);
  assert.equal(database.getRun("pause-during-preflight").status, "paused");
});

test("daemon status and session state explicitly report missing route and unchecked adapter", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tkdesk-stability-daemon-"));
  const client = new DaemonClient({ pluginRoot: process.cwd(), dataDirectory: directory });
  t.after(async () => { await client.call("shutdown").catch(() => {}); await new Promise(r => setTimeout(r, 150)); await rm(directory, { recursive: true, force: true }); });
  const status = await client.call("status");
  assert.equal(status.collectionReadiness?.ready, false);
  assert.ok(status.collectionReadiness.blockingReasons.includes("collection_route_required"));
  assert.equal(status.collectionReadiness.adapter.state, "unchecked");
  const session = await client.call("session_status", { target: "collection_backstage" });
  assert.equal(session.collectionReadiness?.ready, false);
  assert.equal(session.collectionReadiness.adapter.qualificationAdapterReady, null);
  const route = await client.call("collection_route_status");
  assert.equal(route.readiness?.ready, false);
  assert.ok(route.readiness.blockingReasons.includes("collection_route_required"));
  assert.equal((await client.call("status")).qualificationUsage.dailyUsed, 0);
});

test("unverified configured route blocks readiness without probing network or spending qualification quota", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tkdesk-stability-route-"));
  const paths = runtimePaths(directory);
  const store = new DatabaseStore(paths.databasePath).init();
  store.upsertCollectionRoute({ routeProfileId: "unverified-route", marketRegion: "MENA", marketCountryCodes: ["SA"],
    discoveryCountry: "US", discoveryProxyServer: "http://127.0.0.1:19801",
    collectionLanes: [{ countryCode: "SA", proxyServer: "http://127.0.0.1:19802" }], routeFingerprint: "sha256:unverified-test" });
  store.close();
  const client = new DaemonClient({ pluginRoot: process.cwd(), dataDirectory: directory });
  t.after(async () => { await client.call("shutdown").catch(() => {}); await new Promise(r => setTimeout(r, 150)); await rm(directory, { recursive: true, force: true }); });
  const route = await client.call("collection_route_status", { routeProfileId: "unverified-route" });
  assert.equal(route.readiness?.ready, false);
  assert.ok(route.readiness.blockingReasons.includes("collection_route_unverified"));
  assert.equal(route.readiness.qualificationRequestConsumed, false);
  assert.equal((await client.call("status")).qualificationUsage.dailyUsed, 0);
});

test("stranded qualification reservations stay unknown across daemon restarts and consume only the original allowance", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tkdesk-stability-reserved-"));
  const paths = runtimePaths(directory);
  const store = new DatabaseStore(paths.databasePath).init();
  store.createRun({ runId: "reserved-run", source: "tiktok_live", mode: "full_auto", status: "paused" });
  store.upsertProspect({ candidateId: "reserved-creator", runId: "reserved-run", source: "tiktok_live", handle: "reserved.creator" });
  store.reserveQualificationBatch({ batchId: "reserved-request", runId: "reserved-run", candidateIds: ["reserved-creator"] });
  const pausedSeed = dueSeed(store, "user-paused", { status: "paused", error: { code: "user_paused" } });
  store.close();
  const client = new DaemonClient({ pluginRoot: process.cwd(), dataDirectory: directory });
  t.after(async () => { await client.call("shutdown").catch(() => {}); await new Promise(r => setTimeout(r, 150)); await rm(directory, { recursive: true, force: true }); });
  for (let restart = 0; restart < 2; restart++) {
    const run = await client.call("get_run", { runId: "reserved-run" });
    assert.equal(run.status, "paused");
    assert.equal(run.result.qualification.qualificationComplete, false);
    assert.equal(run.result.qualification.automaticRetry, false);
    assert.equal(run.result.qualification.stoppedReason, "explicit_recheck_required");
    assert.deepEqual(run.result.qualification.unresolvedCandidateIds, ["reserved-creator"]);
    const status = await client.call("status");
    assert.equal(status.qualificationUsage.dailyUsed, 1);
    assert.equal(status.durableQueueSweep.lastScan.resumedRunCount, 0);
    const history = await client.call("get_run", { runId: "user-paused" });
    assert.equal(history.status, "paused");
    assert.equal(history.error.code, "user_paused");
    if (restart === 0) { await client.call("shutdown"); await new Promise(r => setTimeout(r, 150)); }
  }
  const reopened = new DatabaseStore(paths.databasePath).init();
  try {
    assert.equal(reopened.getQualificationBatch("reserved-request").status, "ambiguous");
    assert.equal(reopened.listUnattemptedRunProspects({ runId: "reserved-run" }).length, 0);
    assert.throws(() => reopened.reserveQualificationBatch({ batchId: "new-request", runId: "reserved-run", candidateIds: ["reserved-creator"] }),
      { code: "QUALIFICATION_CANDIDATE_ALREADY_ATTEMPTED" });
    assert.equal(reopened.getQualificationUsage().dailyUsed, 1);
    assert.equal(reopened.getDiscoverySeed(pausedSeed.queueId).status, "pending");
  } finally { reopened.close(); }
});

test("overlapping startup and timer scans share one sweep and seed claims remain token fenced", async t => {
  const database = await temporaryStore(t);
  dueSeed(database, "single-owner");
  let unblock;
  const blocked = new Promise(resolve => { unblock = resolve; });
  let started = 0;
  const sweeper = createOriginalRankingQueueSweeper({ database, intervalMs: 300_000,
    preflightRun: async () => { await blocked; return { ready: true }; },
    resumeRun: async run => {
      started += 1;
      const [claim] = database.claimDueOriginalDiscoverySeeds({ runId: run.runId, seedKind: "ranking", limit: 1 });
      assert.ok(claim);
      assert.equal(database.claimDueOriginalDiscoverySeeds({ runId: run.runId, seedKind: "ranking", limit: 1 }).length, 0);
      assert.throws(() => database.completeOriginalDiscoverySeed(claim.queueId, { claimToken: "wrong-owner" }),
        { code: "DISCOVERY_SEED_CLAIM_STALE" });
      database.completeOriginalDiscoverySeed(claim.queueId, { claimToken: claim.claimToken });
      return { completed: true };
    } });
  const startup = sweeper.scan("startup");
  const timer = sweeper.scan("timer");
  unblock();
  await Promise.all([startup, timer]);
  assert.equal(started, 1);
  assert.equal(sweeper.publicState().overlapSkipCount, 1);
  assert.equal((await sweeper.scan("timer")).dueRunCount, 0);
});
