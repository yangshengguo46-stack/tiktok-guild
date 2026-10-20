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
  const database = new DatabaseStore(path.join(directory, "test.sqlite"), overrides.databaseClock ? { clock: overrides.databaseClock } : {}).init();
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


test("review bounded tail arriving during full qualification is not stranded", async t => {
  const qualified = gate();
  const finishData = gate();
  let stop = false;
  let queries = 0;
  const state = await setup(t, {
    shouldStop: () => stop,
    fetchFeedOnce: async () => feed(lanes[0], Array.from({length:31}, (_,i) => seed(lanes[0],i))),
    enrichOnce: async ({seed: row}) => {
      if (row.handle.endsWith(".30")) await qualified.promise;
      return enriched(row);
    },
    onProgress: async p => { if (p.found === 31) finishData.resolve(); },
    qualifyReady: async ({sourceComplete}) => {
      queries++;
      if (queries === 1) {
        assert.equal(sourceComplete, false);
        const prospects = state.database.listUnattemptedRunProspects({runId:state.runId});
        // Match the qualifier's durable exclusion of the initial attempted batch.
        state.database.updateRun(state.runId, {result:{qualification:{unresolvedCandidateIds:prospects.map(p=>p.candidateId)}}});
        qualified.resolve();
        await finishData.promise;
        return {complete:false, stoppedReason:"waiting_full_batch"};
      }
      assert.equal(sourceComplete, true);
      return {complete:true};
    }
  });
  await runOriginalCollector(state.options);
  assert.equal(queries,2, "bounded final unattempted tail requires a second sourceComplete qualification call");
});

test("review independent source stable identity conflict remains observable", async t => {
  const first=seed(lanes[0],1);
  const second={...first, handle:"different.handle"};
  const state=await setup(t, {
    fetchFeedOnce:async()=>feed(lanes[0],[first]),
    fetchCountryTemplatesOnce:async()=>({...feed(lanes[0],[second]), countryCode:"SA"})
  });
  const result=await runOriginalCollector(state.options);
  assert.equal(state.saved.length,1);
  assert.equal(state.database.listUnattemptedRunProspects({runId:state.runId}).length,1);
  assert.equal(result.partialCounts.discovery_identity_conflict,1);
  assert.equal(result.found,1);
});


test("stable identity conflict is fenced after asynchronous source completion and collector restart", async t => {
  const pc = seed(lanes[0], 1);
  const mobile = { ...pc, handle: "renamed.creator", mobileTemplateEvidence: { templateLabel: "top" } };
  const dataEntered = gate();
  const state = await setup(t, {
    fetchFeedOnce: async () => feed(lanes[0], [pc]),
    fetchCountryTemplatesOnce: async () => {
      await dataEntered.promise;
      return { ...feed(lanes[0], [mobile]), countryCode: "SA" };
    },
    enrichOnce: async ({ seed: row }) => { dataEntered.resolve(); return enriched(row); }
  });
  const first = await runOriginalCollector(state.options);
  assert.equal(first.found, 1);
  assert.equal(first.partialCounts.discovery_identity_conflict, 1);
  assert.equal(state.saved.length, 1);
  state.database.close();
  state.database.init();
  const restarted = await runOriginalCollector({ ...state.options,
    fetchFeedOnce: async () => feed(lanes[0]),
    fetchCountryTemplatesOnce: async () => ({ ...feed(lanes[0], [mobile]), countryCode: "SA" })
  });
  assert.equal(restarted.found, 0);
  assert.equal(restarted.partialCounts.discovery_identity_conflict, 1);
  const evidence = state.database.getCheckpoint(state.runId, "original_discovery_identity_conflicts", { adapter: "tiktok_original_cascade" }).value;
  assert.equal(evidence.totalCount, 2);
  assert.equal(evidence.observations.length, 2);
  assert.equal(evidence.observations[0].incoming.handle, mobile.handle);
  assert.deepEqual(evidence.observations[0].incoming.discoverySourceKinds, ["original_mobile_processor_fixed_country_lists"]);
  assert.equal(evidence.observations[0].existing[0].handle, pc.handle);
  assert.equal(state.database.listDiscoverySeeds({ runId: state.runId, seedKind: "feed" }).length, 1);
});

test("stable aliases stay isolated by country and an expired Feed TTL permits a legitimate rename", async t => {
  let now = new Date("2026-09-26T00:00:00Z");
  const first = seed(lanes[0], 1);
  const otherCountry = { ...seed(lanes[1], 1), handle: "qa.creator", userId: first.userId, roomId: first.roomId };
  const state = await setup(t, { databaseClock: () => now,
    selectedLanes: lanes.slice(0, 2),
    fetchFeedOnce: async ({ workId }) => feed(lanes[workId - 1], [workId === 1 ? first : otherCountry])
  });
  const initial = await runOriginalCollector(state.options);
  assert.equal(initial.found, 2);
  assert.equal(initial.partialCounts.discovery_identity_conflict, undefined);
  now = new Date("2026-09-26T00:05:01Z");
  const renamed = { ...first, handle: "legitimate.rename" };
  const resumed = await runOriginalCollector({ ...state.options, selectedLanes: [lanes[0]],
    fetchFeedOnce: async () => feed(lanes[0], [renamed]) });
  assert.equal(resumed.found, 1);
  assert.equal(resumed.partialCounts.discovery_identity_conflict, undefined);
  assert.equal(state.saved.at(-1).handle, renamed.handle);
});

test("Mobile uses evidenced three-second backpressure wait with an explicit local source threshold policy", async t => {
  let stop = false;
  let totalWait = 0;
  let afterBackpressure = false;
  const state = await setup(t, {
    shouldStop: () => stop,
    fetchCountryTemplatesOnce: async () => { stop = true; afterBackpressure = true; return { ...feed(lanes[0]), countryCode: "SA" }; },
    fetchFeedOnce: async () => { throw new Error("PC must wait for its own queue admission"); },
    enrichOnce: async () => { await immediate(); return { status: "capability_not_ready", reason: "test_pending" }; },
    sleep: async (ms, owner) => {
      if (owner.processor === "mobile") totalWait += ms;
      await immediate();
    }
  });
  // Keep Data from draining the queue; source admission sees a durable backlog.
  state.database.claimDueOriginalDiscoverySeeds = () => [];
  state.database.originalDiscoveryQueueStatus = (_runId, { sourceKind }) => {
    if (sourceKind !== null) assert.ok(["original_pc_web_feed", "original_mobile_processor_fixed_country_lists"].includes(sourceKind));
    return { counts: { pending: totalWait < 1500 ? 35 : 0 } };
  };
  for (let index = 0; index < 35; index++) {
    state.database.enqueueOriginalDiscoverySeed({ runId: state.runId, seedKind: "feed", identityKey: `SA:queued.${index}`, payload: seed(lanes[0], index) });
  }
  const result = await runOriginalCollector(state.options);
  assert.equal(afterBackpressure, true);
  assert.equal(totalWait, 3000);
  assert.equal(result.processors.mobile[0].nextDelayMs, 3000);
  assert.equal(result.processors.mobile[0].backpressurePolicy, "local_source_queue");
  assert.equal(result.processors.mobile[0].backpressureThreshold, 35);
  assert.equal(result.originalDiscoveryParityComplete, false);
});
