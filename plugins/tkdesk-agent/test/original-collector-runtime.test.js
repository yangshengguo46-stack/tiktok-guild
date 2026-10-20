import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setImmediate as immediate } from "node:timers/promises";
import test from "node:test";
import { DatabaseStore } from "../mcp/core/database.js";
import { originalCountryCatalog } from "../mcp/core/original-country-config.js";
import { runOriginalCollector } from "../mcp/core/original-collector-runtime.js";

const lanes = ["SA", "QA", "EG"].map((countryCode, index) => ({
  workId: index + 1, countryCode, proxyServer: `http://127.0.0.1:${18100 + index}`,
  proxyExitCountry: countryCode
}));
const route = {
  verificationStatus: "verified", marketRegion: "MENA", discoveryCountry: "US",
  discoveryProxyExitCountry: "US", collectionLanes: lanes,
  collectionProxyExitCountries: lanes.map(lane => lane.countryCode)
};
const gate = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
function seed(lane, index) {
  return {
    handle: `${lane.countryCode.toLowerCase()}.creator.${index}`,
    userId: `${700000000 + lane.workId * 10000 + index}`, roomId: `${800000000 + index}`,
    workId: lane.workId, rankingScopeCountryCode: lane.countryCode,
    collectionLaneEvidence: { workId: lane.workId, countryCode: lane.countryCode, exitCountry: lane.countryCode }
  };
}
function feed(lane, seeds = []) {
  return {
    status: "ready", workId: lane.workId, rankingScopeCountryCode: lane.countryCode,
    collectionLaneEvidence: { workId: lane.workId, countryCode: lane.countryCode, exitCountry: lane.countryCode },
    channelId: 87, receivedRooms: seeds.length, candidates: seeds
  };
}
function enriched(candidate) {
  return {
    status: "ready", workId: candidate.workId, completedStages: ["basic", "country", "level"],
    enrichment: { userId: candidate.userId, roomId: candidate.roomId, followerCount: 50,
      creatorCountryCode: candidate.rankingScopeCountryCode, creatorLevel: "1" }
  };
}
async function setup(t, overrides = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tkdesk-collector-test-"));
  const database = new DatabaseStore(path.join(directory, "test.sqlite")).init();
  const runId = "collector-run";
  database.createRun({ runId, source: "tiktok_live", mode: "full_auto" });
  t.after(async () => { database.close(); await rm(directory, { recursive: true, force: true }); });
  const saved = [];
  const options = {
    database, runId, selectedLanes: [lanes[0]], verifiedRoute: route, marketRegion: "MENA",
    maxFeedRounds: 1, shouldStop: () => false,
    fetchFeedOnce: async ({ workId }) => feed(lanes[workId - 1]),
    laneForCandidate: (_route, candidate) => lanes.find(lane => lane.countryCode === candidate.rankingScopeCountryCode),
    enrichOnce: async ({ seed: candidate }) => enriched(candidate),
    sleep: async () => immediate(),
    onBatch: candidates => {
      for (const candidate of candidates) {
        saved.push(candidate);
        database.upsertProspect({ runId, source: "tiktok_live", userId: candidate.userId,
          roomId: candidate.roomId, handle: candidate.handle, data: candidate });
      }
    }, ...overrides
  };
  return { options, database, runId, saved };
}

test("long-running Feed diagnostics retain a bounded channel sample without losing attempt counters", async t => {
  const state = await setup(t, { maxFeedRounds: 200 });
  const result = await runOriginalCollector(state.options);
  assert.equal(result.feedAttempts, 200);
  assert.equal(result.feedAttemptsByWorkId[1], 200);
  assert.equal(result.channelIdsByWorkId[1].length, 64);
  assert.equal(result.channelIdSampleLimit, 64);
});

test("a large Mobile backlog does not stop later PC rounds while Data is blocked", async t => {
  const dataRelease = gate(); const entered = gate(); let calls = 0;
  const state = await setup(t, {
    maxFeedRounds: 2,
    fetchFeedOnce: async () => { calls++; return feed(lanes[0], [seed(lanes[0], calls)]); },
    fetchCountryTemplatesOnce: async () => ({
      ...feed(lanes[0], Array.from({ length: 80 }, (_, i) => seed(lanes[0], i + 100))),
      countryCode: "SA"
    }),
    enrichOnce: async ({ seed: row }) => { entered.resolve(); await dataRelease.promise; return enriched(row); }
  });
  const operation = runOriginalCollector(state.options);
  await entered.promise;
  for (let tick = 0; tick < 150 && calls < 2; tick++) await immediate();
  const observedCalls = calls;
  const backlog = state.database.originalDiscoveryQueueStatus(state.runId, { seedKind: "feed" }).counts.pending;
  dataRelease.resolve(); await operation;
  assert.ok(backlog > 35);
  assert.equal(observedCalls, 2, "PC must poll independently of the Mobile queue");
});

test("Feed failures persist a bounded response diagnostic in processor checkpoints", async t => {
  const diagnostics = { httpStatus: 200, contentType: "text/html", bodyBytes: 0, bodyKind: "empty", elapsedMs: 17 };
  const state = await setup(t, {
    fetchFeedOnce: async () => ({ status: "capability_not_ready", reason: "feed_response_not_json", diagnostics })
  });
  const result = await runOriginalCollector(state.options);
  assert.ok(result.processors.pc[0].lastFailure, "processor lost the response diagnostics");
  assert.deepEqual(result.processors.pc[0].lastFailure.diagnostics, diagnostics);
  const checkpoint = state.database.getCheckpoint(state.runId, "original_collectors", { adapter: "tiktok_original_cascade" });
  assert.deepEqual(checkpoint.value.summary.processors.pc[0].lastFailure.diagnostics, diagnostics);
});

test("failed Basic diagnostics survive a durable queue result without storing response text", async t => {
  const diagnostics = { httpStatus: 200, contentType: "text/html", bodyBytes: 0, bodyKind: "empty", elapsedMs: 19 };
  const state = await setup(t, {
    fetchFeedOnce: async () => feed(lanes[0], [seed(lanes[0], 12)]),
    enrichOnce: async () => ({ status: "partial", reason: "basic_response_not_json", completedStages: [], enrichment: {},
      stageEvidence: [{ stage: "basic", state: "failed", reason: "basic_response_not_json", diagnostics, responseText: "COOKIE_TEST_SECRET" }] })
  });
  await runOriginalCollector(state.options);
  const [row] = state.database.listDiscoverySeeds({ runId: state.runId, seedKind: "feed", status: "failed" });
  assert.ok(row.result.failedStages, "failed Basic lost its diagnostic when no candidate was admitted");
  assert.deepEqual(row.result.failedStages[0].diagnostics, diagnostics);
  assert.doesNotMatch(JSON.stringify(row.result), /COOKIE_TEST_SECRET|responseText/);
});

test("Data admits Web rows amid an older Mobile backlog and rotates country lanes", async t => {
  const release = gate(); const firstClaims = [];
  const state = await setup(t, {
    selectedLanes: lanes,
    enrichOnce: async ({ seed: row }) => { firstClaims.push(row); await release.promise; return enriched(row); }
  });
  for (const lane of lanes) for (let i = 0; i < 6; i++) {
    const row = seed(lane, 200 + i);
    state.database.enqueueOriginalDiscoverySeed({ runId: state.runId, seedKind: "feed",
      identityKey: lane.countryCode + ":" + row.handle,
      payload: { ...row, discoverySourceKinds: ["original_mobile_processor_fixed_country_lists"] } });
  }
  const pcRow = seed(lanes[1], 999);
  state.database.enqueueOriginalDiscoverySeed({ runId: state.runId, seedKind: "feed",
    identityKey: "QA:" + pcRow.handle, payload: { ...pcRow, discoverySourceKinds: ["original_pc_web_feed"] } });
  const operation = runOriginalCollector(state.options);
  for (let tick = 0; tick < 100 && firstClaims.length < 4; tick++) await immediate();
  const observed = firstClaims.slice(0, 4);
  release.resolve(); await operation;
  assert.ok(observed.some(row => row.handle === pcRow.handle), "Web cannot sit behind the entire Mobile backlog");
  assert.equal(new Set(observed.map(row => row.rankingScopeCountryCode)).size, 3);
});

async function repeatedCountryEvidence(t, { actualCountry = "AE", resultOverride = null, identityChanges = false, expire = false } = {}) {
  let calls = 0; let now = 0;
  const shared = seed(lanes[0], 500);
  const state = await setup(t, {
    selectedLanes: lanes, clock: () => now,
    fetchFeedOnce: async ({ workId }) => feed(lanes[workId - 1]),
    enrichOnce: async ({ seed: row }) => {
      calls++;
      await immediate();
      const value = enriched(row);
      value.enrichment.creatorCountryCode = actualCountry;
      return resultOverride ?? (actualCountry === row.rankingScopeCountryCode ? value
        : { ...value, status: "filtered", reason: "creator_country_mismatch" });
    },
    onProgress: async progress => { if (expire && progress.filteredCounts.creator_country_mismatch) now = 300_001; }
  });
  for (const lane of lanes) {
    const row = { ...shared, workId: lane.workId, rankingScopeCountryCode: lane.countryCode,
      collectionLaneEvidence: { workId: lane.workId, countryCode: lane.countryCode, exitCountry: lane.countryCode },
      ...(identityChanges ? { userId: String(Number(shared.userId) + lane.workId) } : {}) };
    state.database.enqueueOriginalDiscoverySeed({ runId: state.runId, seedKind: "feed",
      identityKey: lane.countryCode + ":" + row.handle,
      payload: { ...row, discoverySourceKinds: ["original_mobile_processor_fixed_country_lists"] } });
  }
  const result = await runOriginalCollector(state.options);
  return { calls, result, state };
}

test("identical foreign-country seeds reuse fresh verified negative evidence across lanes", async t => {
  const { calls, result, state } = await repeatedCountryEvidence(t);
  assert.equal(calls, 1);
  assert.equal(result.filteredCounts.creator_country_mismatch, 3);
  assert.equal(result.countryEvidenceReuse.skipped, 2);
  assert.equal(state.database.originalDiscoveryQueueStatus(state.runId, { seedKind: "feed" }).counts.skipped, 3);
});

test("the matching country still verifies its own lane before admission", async t => {
  const { calls, result, state } = await repeatedCountryEvidence(t, { actualCountry: "QA" });
  assert.equal(calls, 2);
  assert.equal(result.found, 1);
  assert.equal(state.saved[0].workId, 2);
  assert.equal(state.saved[0].creatorCountryCode, "QA");
});

test("country reuse does not cross identities, failed evidence, or the discovery TTL", async t => {
  const changed = await repeatedCountryEvidence(t, { identityChanges: true });
  assert.equal(changed.calls, 3);
  const failed = await repeatedCountryEvidence(t, { resultOverride: {
    status: "partial", reason: "country_transport_failed", completedStages: ["basic"],
    enrichment: { userId: "1", roomId: "2", creatorCountryCode: null }
  } });
  assert.equal(failed.calls, 3);
  const expired = await repeatedCountryEvidence(t, { expire: true });
  assert.ok(expired.calls >= 2, "expired country evidence must cause a fresh check");
});

test("PC producers continue while four independent Data consumers are blocked", async t => {
  const processing = gate();
  const entered = gate();
  const calls = new Map();
  let active = 0;
  let maximum = 0;
  const state = await setup(t, {
    selectedLanes: lanes, maxFeedRounds: 2,
    fetchFeedOnce: async ({ workId }) => {
      const count = (calls.get(workId) ?? 0) + 1;
      calls.set(workId, count);
      return feed(lanes[workId - 1], [seed(lanes[workId - 1], count)]);
    },
    enrichOnce: async ({ seed: candidate }) => {
      active += 1; maximum = Math.max(maximum, active);
      entered.resolve(); await processing.promise; active -= 1;
      return enriched(candidate);
    }
  });
  const operation = runOriginalCollector(state.options);
  await entered.promise;
  for (let tick = 0; tick < 100 && [...calls.values()].some(value => value < 2); tick++) await immediate();
  for (let tick = 0; tick < 100 && active < 4; tick++) await immediate();
  const observed = [...calls.values()];
  processing.resolve();
  const result = await operation;
  assert.deepEqual(observed, [2, 2, 2]);
  assert.equal(maximum, 4);
  assert.equal(result.found, 6);
  assert.deepEqual(result.processors.pc.map(processor => ({
    success: processor.successfulResponses, nonempty: processor.nonEmptyResponses,
    rooms: processor.receivedRooms, errors: processor.ordinaryErrors
  })), Array.from({ length: 3 }, () => ({ success: 2, nonempty: 2, rooms: 2, errors: 0 })));
  assert.equal(state.saved.length, 6);
  assert.equal(state.database.originalDiscoveryQueueStatus(state.runId, { seedKind: "feed" }).counts.completed, 6);
});

test("Live qualifies thirty persisted people while a later Feed request is still running", async t => {
  const secondFeed = gate();
  const secondEntered = gate();
  const qualified = gate();
  let stop = false;
  let calls = 0;
  let discoveryReturned = false;
  let observedCount = null;
  const state = await setup(t, {
    maxFeedRounds: null, shouldStop: () => stop,
    fetchFeedOnce: async () => {
      calls += 1;
      if (calls === 1) return feed(lanes[0], Array.from({ length: 30 }, (_, index) => seed(lanes[0], index)));
      secondEntered.resolve();
      await secondFeed.promise; discoveryReturned = true; return feed(lanes[0]);
    },
    enrichOnce: async ({ seed: candidate }) => { await secondEntered.promise; return enriched(candidate); },
    qualifyReady: async ({ sourceComplete }) => {
      assert.equal(sourceComplete, false);
      observedCount = state.database.listUnattemptedRunProspects({ runId: state.runId, limit: 100 }).length;
      qualified.resolve(); stop = true; secondFeed.resolve();
      return { complete: true, batchesThisExecution: 1 };
    }
  });
  const operation = runOriginalCollector(state.options);
  await qualified.promise;
  const observedDiscovery = discoveryReturned;
  await operation;
  assert.equal(observedCount, 30);
  assert.equal(observedDiscovery, false);
  assert.ok(calls >= 2);
});

test("upstream errors wait sixty seconds before another request, valid empty lists do not", async t => {
  let count = 0;
  const sleeps = [];
  const state = await setup(t, {
    maxFeedRounds: 3,
    fetchFeedOnce: async () => (++count === 1
      ? { status: "capability_not_ready", reason: "feed_upstream_empty_response", candidates: [] }
      : feed(lanes[0])),
    sleep: async (milliseconds, owner) => { sleeps.push({ milliseconds, owner }); await immediate(); }
  });
  const result = await runOriginalCollector(state.options);
  const pcWait = sleeps.filter(entry => entry.owner?.processor === "pc");
  assert.equal(pcWait.reduce((sum, entry) => sum + entry.milliseconds, 0), 63_000);
  assert.equal(result.feedAttempts, 3);
  assert.equal(result.partialCounts.feed_upstream_empty_response, 1);
  assert.equal(result.processors.pc[0].successfulResponses, 2);
  assert.equal(result.processors.pc[0].nonEmptyResponses, 0);
  assert.equal(result.processors.pc[0].receivedRooms, 0);
  assert.equal(result.processors.pc[0].ordinaryErrors, 1);
});

test("stop interrupts the error wait and preserves an unprocessed durable seed", async t => {
  let stop = false;
  let requests = 0;
  const state = await setup(t, {
    maxFeedRounds: null, shouldStop: () => stop,
    fetchFeedOnce: async () => { requests += 1; return { status: "capability_not_ready", reason: "feed_transport_failed" }; },
    sleep: async (_milliseconds, owner) => { if (owner?.processor === "pc") stop = true; await immediate(); }
  });
  const result = await runOriginalCollector(state.options);
  assert.equal(requests, 1);
  assert.equal(result.status, "stopped");
  assert.equal(state.database.originalDiscoveryQueueStatus(state.runId, { seedKind: "feed" }).counts.processing ?? 0, 0);
});

test("Mobile missing authorization leaves PC production usable and explicitly partial", async t => {
  const state = await setup(t, {
    fetchFeedOnce: async () => feed(lanes[0], [seed(lanes[0], 1)]),
    fetchCountryTemplatesOnce: async () => ({ status: "capability_not_ready", reason: "ranking_mobile_authorization_required" })
  });
  const result = await runOriginalCollector(state.options);
  assert.equal(state.saved.length, 1);
  assert.equal(result.mobileTemplateComplete, false);
  assert.equal(result.partialCounts.ranking_mobile_authorization_required, 1);
  assert.equal(result.processors.mobile[0].state, "dependency_missing");
});

test("an explicit candidate bound is reserved across parallel consumers", async t => {
  const state = await setup(t, {
    maxCandidates: 3,
    fetchFeedOnce: async () => feed(lanes[0], Array.from({ length: 10 }, (_, index) => seed(lanes[0], index))),
    enrichOnce: async ({ seed: candidate }) => { await immediate(); return enriched(candidate); }
  });
  const result = await runOriginalCollector(state.options);
  assert.equal(result.found, 3);
  assert.equal(state.saved.length, 3);
  const queue = state.database.originalDiscoveryQueueStatus(state.runId, { seedKind: "feed" });
  assert.equal(queue.counts.processing ?? 0, 0);
  assert.equal(queue.counts.pending, 7);
});

test("a resumed pending queue is drained even when the next source response fails", async t => {
  const state = await setup(t, {
    fetchFeedOnce: async () => ({ status: "capability_not_ready", reason: "feed_upstream_empty_response" })
  });
  state.database.enqueueOriginalDiscoverySeed({ runId: state.runId, seedKind: "feed",
    identityKey: "SA:pending", payload: seed(lanes[0], 3) });
  const result = await runOriginalCollector(state.options);
  assert.equal(result.found, 1);
  assert.equal(state.saved[0].handle, "sa.creator.3");
});

test("pause never flushes a short qualification tail", async t => {
  let stop = false;
  let queries = 0;
  const state = await setup(t, {
    maxFeedRounds: null, shouldStop: () => stop,
    fetchFeedOnce: async () => feed(lanes[0], [seed(lanes[0], 1)]),
    onProgress: async progress => { if (progress.found === 1) stop = true; },
    qualifyReady: async () => { queries += 1; }
  });
  await runOriginalCollector(state.options);
  assert.equal(queries, 0);
});

test("bounded diagnostic completion can qualify a short tail exactly once", async t => {
  let queries = 0;
  const state = await setup(t, {
    fetchFeedOnce: async () => feed(lanes[0], [seed(lanes[0], 1)]),
    qualifyReady: async ({ sourceComplete }) => {
      queries += 1; assert.equal(sourceComplete, true);
      // A real qualifier records an attempt. This test stops the consumer by
      // its completed batch result rather than fabricating a network receipt.
      return { complete: true, pendingCandidates: 0 };
    }
  });
  const result = await runOriginalCollector(state.options);
  assert.equal(queries, 1);
  assert.equal(result.qualification.complete, true);
});

test("queue transfer rolls back its candidate if completion fails", async t => {
  const state = await setup(t);
  assert.throws(() => state.database.transaction(() => {
    state.database.upsertProspect({ runId: state.runId, source: "tiktok_live", handle: "rollback.person" });
    throw new Error("completion failed");
  }), /completion failed/);
  assert.equal(state.database.listUnattemptedRunProspects({ runId: state.runId }).length, 0);
});

test("a failed nested transaction can roll back independently of its outer transaction", async t => {
  const state = await setup(t);
  state.database.transaction(() => {
    state.database.upsertProspect({ runId: state.runId, source: "tiktok_live", handle: "outer.person" });
    assert.throws(() => state.database.transaction(() => {
      state.database.upsertProspect({ runId: state.runId, source: "tiktok_live", handle: "inner.person" });
      throw new Error("inner failed");
    }), /inner failed/);
  });
  const candidates = state.database.listUnattemptedRunProspects({ runId: state.runId });
  assert.deepEqual(candidates.map(item => item.handle), ["outer.person"]);
});

test("Mobile scores arriving during Data processing join the same durable identity", async t => {
  const dataEntered = gate();
  const mobilePersisted = gate();
  const candidate = seed(lanes[0], 2);
  const state = await setup(t, {
    fetchFeedOnce: async () => feed(lanes[0], [candidate]),
    fetchCountryTemplatesOnce: async () => {
      await dataEntered.promise;
      return { ...feed(lanes[0], [{ ...candidate, topScore: "55", hotListScore: "66" }]),
        countryCode: "SA", templateLabels: ["top", "hot"], templateRowCounts: { top: 1, hot: 1 } };
    },
    enrichOnce: async ({ seed: row }) => { dataEntered.resolve(); await mobilePersisted.promise; return enriched(row); },
    onProgress: async value => { if (value.mobileTemplateAttempts === 1) mobilePersisted.resolve(); }
  });
  await runOriginalCollector(state.options);
  assert.equal(state.saved.length, 1);
  assert.equal(state.saved[0].topScore, "55");
  assert.equal(state.saved[0].hotListScore, "66");
  assert.deepEqual(state.saved[0].discoverySourceKinds.sort(), ["original_mobile_processor_fixed_country_lists", "original_pc_web_feed"]);
});

test("a late Mobile source refreshes a completed row without adding another identity", async t => {
  const persisted = gate();
  const candidate = seed(lanes[0], 8);
  const state = await setup(t, {
    fetchFeedOnce: async () => feed(lanes[0], [candidate]),
    fetchCountryTemplatesOnce: async () => {
      await persisted.promise;
      return { ...feed(lanes[0], [{ ...candidate, hotListScore: "99" }]), countryCode: "SA" };
    },
    onProgress: async value => { if (value.found === 1) persisted.resolve(); }
  });
  const result = await runOriginalCollector(state.options);
  assert.equal(result.found, 1);
  assert.equal(state.saved.at(-1).hotListScore, "99");
  assert.equal(state.database.listUnattemptedRunProspects({ runId: state.runId }).length, 1);
});

test("the collector rejects a configured lane mismatch before any source request", async t => {
  let requests = 0;
  const state = await setup(t, {
    selectedLanes: [{ ...lanes[0], proxyServer: "http://127.0.0.1:19999" }],
    fetchFeedOnce: async () => { requests += 1; return feed(lanes[0]); }
  });
  await assert.rejects(runOriginalCollector(state.options), error => error.code === "collection_route_mismatch");
  assert.equal(requests, 0);
});

test("every original display configuration can pass its selected country through the engine", async t => {
  const catalog = originalCountryCatalog();
  const variants = catalog.configurations.flatMap(group => group.displayVariants.map(variant => ({ group, variant })));
  assert.equal(variants.length, 36);
  const state = await setup(t);
  for (const [index, { group, variant }] of variants.entries()) {
    const countryCode = variant.selectionCountryCodes[0];
    const lane = { ...lanes[0], countryCode, proxyExitCountry: countryCode, displayName: variant.displayName };
    const localRoute = { ...route, marketRegion: group.routeCode, collectionLanes: [lane], collectionProxyExitCountries: [countryCode] };
    const runId = `all-regions-${index}`;
    state.database.createRun({ runId, source: "tiktok_live", mode: "semi_auto" });
    let observed;
    const result = await runOriginalCollector({ ...state.options, runId,
      marketRegion: group.routeCode, selectedLanes: [lane], verifiedRoute: localRoute,
      fetchFeedOnce: async request => { observed = request; return feed(lane); },
      laneForCandidate: () => lane
    });
    assert.equal(result.feedAttempts, 1, variant.displayName);
    assert.equal(observed.countryCode, countryCode, variant.displayName);
    assert.equal(observed.displayName, variant.displayName, variant.displayName);
  }
});

test("bounded runs finish with no qualification prospects and unavailable ranking", async t => {
  let stop = false;
  let scans = 0;
  const state = await setup(t, {
    shouldStop: () => stop,
    fetchFeedOnce: async () => feed(lanes[0], [seed(lanes[0], 4)]),
    onBatch: () => {},
    qualifyReady: async () => { throw new Error("no eligible prospects"); },
    expandReady: async () => { scans += 1; return { mobileSessionRequired: true, found: 0 }; }
  });
  const timer = setTimeout(() => { stop = true; }, 1000);
  const result = await runOriginalCollector(state.options);
  clearTimeout(timer);
  assert.equal(result.status, "partial");
  assert.ok(scans >= 1);
});

test("ranking descendants count toward the shared cap and wake short-tail qualification", async t => {
  let received = 0;
  let queries = 0;
  let expansions = 0;
  let stop = false;
  const state = await setup(t, {
    maxCandidates: 1, receivedCount: () => received,
    shouldStop: () => stop,
    qualifyReady: async ({ sourceComplete }) => { queries += 1; assert.equal(sourceComplete, true); return { complete: true }; },
    expandReady: async () => {
      expansions += 1;
      if (expansions === 1) {
        state.database.upsertProspect({ runId: state.runId, source: "tiktok_live", handle: "ranked.person", userId: "901", data: seed(lanes[0], 90) });
        received += 1;
        return { found: 1 };
      }
      return { found: 0 };
    }
  });
  const timer = setTimeout(() => { stop = true; }, 1000);
  const result = await runOriginalCollector(state.options);
  clearTimeout(timer);
  assert.equal(result.status, "partial");
  assert.equal(result.selectionComplete, true);
  assert.equal(queries, 1);
});

test("duplicate configured WorkIDs are rejected before source HTTP", async t => {
  let requests = 0;
  const state = await setup(t, {
    selectedLanes: [lanes[0], lanes[0]],
    fetchFeedOnce: async () => { requests += 1; return feed(lanes[0]); }
  });
  await assert.rejects(runOriginalCollector(state.options), error => error.code === "collection_route_mismatch");
  assert.equal(requests, 0);
});

test("queue completion failure rolls back nested persistence and releases every claim", async t => {
  const state = await setup(t, { fetchFeedOnce: async () => feed(lanes[0], [seed(lanes[0], 5)]) });
  state.database.completeOriginalDiscoverySeed = () => { throw new Error("queue completion failed"); };
  await assert.rejects(runOriginalCollector(state.options), /queue completion failed/);
  assert.equal(state.database.listUnattemptedRunProspects({ runId: state.runId }).length, 0);
  const queue = state.database.originalDiscoveryQueueStatus(state.runId, { seedKind: "feed" });
  assert.equal(queue.counts.processing ?? 0, 0);
  assert.equal(queue.counts.pending, 1);
});

test("an invalid unselected lane invalidates the whole verified route before HTTP", async t => {
  let requests = 0;
  const state = await setup(t, {
    verifiedRoute: { ...route, collectionLanes: [lanes[0], { ...lanes[1], countryCode: "SA" }, lanes[2]] },
    fetchFeedOnce: async () => { requests += 1; return feed(lanes[0]); }
  });
  await assert.rejects(runOriginalCollector(state.options), error => error.code === "collection_route_mismatch");
  assert.equal(requests, 0);
});

test("Ranking consumes newly qualified results while PC and Data continue", async t => {
  const feedEntered = gate();
  const feedRelease = gate();
  const dataEntered = gate();
  const dataRelease = gate();
  const qualified = gate();
  let stop = false;
  let calls = 0;
  let qualificationCalls = 0;
  let ranked = false;
  const state = await setup(t, {
    maxFeedRounds: null, shouldStop: () => stop,
    fetchFeedOnce: async () => {
      calls += 1;
      if (calls === 1) return feed(lanes[0], Array.from({ length: 31 }, (_, index) => seed(lanes[0], index)));
      feedEntered.resolve(); await feedRelease.promise; return feed(lanes[0]);
    },
    enrichOnce: async ({ seed: candidate }) => {
      await feedEntered.promise;
      if (candidate.handle.endsWith(".30")) { dataEntered.resolve(); await dataRelease.promise; }
      return enriched(candidate);
    },
    qualifyReady: async () => {
      qualificationCalls += 1;
      await dataEntered.promise;
      qualified.resolve();
      return { complete: true };
    },
    expandReady: async () => {
      if (qualificationCalls > 0) {
        ranked = true; stop = true; dataRelease.resolve(); feedRelease.resolve();
      }
      return { found: 0 };
    }
  });
  await runOriginalCollector(state.options);
  assert.equal(ranked, true);
  assert.equal(qualificationCalls, 1);
  assert.equal(state.database.originalDiscoveryQueueStatus(state.runId, { seedKind: "feed" }).counts.processing ?? 0, 0);
});

test("official backend quota stops qualification without replaying a pending batch", async t => {
  let queries = 0;
  const state = await setup(t, {
    fetchFeedOnce: async () => feed(lanes[0], Array.from({ length: 30 }, (_, index) => seed(lanes[0], index))),
    qualifyReady: async () => { queries += 1; return { complete: false, stoppedReason: "backend_quota_limit" }; }
  });
  await assert.rejects(runOriginalCollector(state.options), error => error.code === "backend_quota_limit");
  assert.equal(queries, 1);
  assert.equal(state.database.originalDiscoveryQueueStatus(state.runId, { seedKind: "feed" }).counts.processing ?? 0, 0);
});

test("Data lease invalidation stops every processor and retains the claim", async t => {
  const state = await setup(t, {
    fetchFeedOnce: async () => feed(lanes[0], [seed(lanes[0], 19)]),
    enrichOnce: async () => ({ status: "partial", reason: "enrichment_session_run_closed", enrichment: null, completedStages: [] })
  });
  await assert.rejects(runOriginalCollector(state.options), error => error.code === "enrichment_session_run_closed");
  const queue = state.database.originalDiscoveryQueueStatus(state.runId, { seedKind: "feed" });
  assert.equal(queue.counts.processing ?? 0, 0);
  assert.equal(queue.counts.pending, 1);
});

test("a ranking admission filling the cap preserves an in-flight Data seed for recovery", async t => {
  const dataEntered = gate();
  const dataRelease = gate();
  let received = 0;
  const state = await setup(t, {
    maxCandidates: 1, receivedCount: () => received,
    fetchFeedOnce: async () => feed(lanes[0], [seed(lanes[0], 20)]),
    enrichOnce: async ({ seed: candidate }) => { dataEntered.resolve(); await dataRelease.promise; return enriched(candidate); },
    expandReady: async () => { await dataEntered.promise; received = 1; dataRelease.resolve(); return { found: 1 }; }
  });
  await runOriginalCollector(state.options);
  assert.equal(state.saved.length, 0);
  const queue = state.database.originalDiscoveryQueueStatus(state.runId, { seedKind: "feed" });
  assert.equal(queue.counts.pending, 1);
  assert.equal(queue.counts.processing ?? 0, 0);
});


test("paused bounded runs retain their three total source rounds and do not refetch the completed Mobile sample", async t => {
  let stop = false; let feedCalls = 0; let mobileCalls = 0;
  const state = await setup(t, {
    maxFeedRounds: 3, shouldStop: () => stop,
    fetchFeedOnce: async () => {feedCalls++; return feed(lanes[0]);},
    fetchCountryTemplatesOnce: async () => {mobileCalls++;return {...feed(lanes[0]),countryCode:"SA",marketRegion:"MENA",templateLabels:["TopURL"],templateRowCounts:{TopURL:0}};},
    onProgress: async progress => {if(progress.feedAttempts === 1 && progress.mobileTemplateAttempts === 1) stop = true;}
  });
  const first = await runOriginalCollector(state.options);
  assert.equal(first.feedAttempts,1);assert.equal(first.mobileTemplateAttempts,1);
  stop=false;
  const result = await runOriginalCollector({...state.options,onProgress:async()=>{}});
  assert.equal(feedCalls,3,"three is the total run bound across pause/resume");
  assert.equal(mobileCalls,1,"completed bounded Mobile discovery must not be replayed");
  assert.equal(result.feedAttempts,3);
  assert.equal(result.processors.pc[0].successfulResponses,3);
  assert.equal(result.mobileTemplateComplete,true);
});

test('explicit Feed round bounds finish even when the admitted candidate cap is reached first', async t => {
  const admitted=gate();let calls=0;
  const state=await setup(t,{maxCandidates:1,maxFeedRounds:3,
    fetchFeedOnce:async()=>{calls++;return feed(lanes[0],calls===1?[seed(lanes[0],1)]:[]);},
    onProgress:async p=>{if(p.feedAttempts===1)await admitted.promise;}
  });
  const persist=state.options.onBatch;state.options.onBatch=c=>{persist(c);admitted.resolve();};
  const result=await runOriginalCollector(state.options);
  assert.equal(calls,3);assert.equal(result.feedRounds,3);assert.equal(state.saved.length,1);
});
