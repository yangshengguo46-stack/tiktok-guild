import assert from "node:assert/strict";
import test from "node:test";
import { buildStartupInventory } from "../mcp/core/startup-inventory.js";

test("startup inventory prefers an existing handoff over collection", () => {
  const state = buildStartupInventory({
    candidates: { total: 12, truncatedByStoreLimit: false },
    availableCandidates: { total: 8, truncatedByStoreLimit: false },
    pendingHandoffs: [{
      batchId: "handoff-1",
      runId: "run-1",
      status: "pending_review",
      candidateCount: 8,
      purpose: "broker outreach",
      criteria: { destination: "broker" },
      payload: { datasetHash: "hash-1", candidates: [{ candidateId: "secret" }] },
      createdAt: "2026-09-29T00:00:00.000Z",
      updatedAt: "2026-09-29T00:00:00.000Z"
    }],
    resumableRuns: [{ runId: "run-2", status: "paused" }]
  });

  assert.equal(state.decision, "use_existing_handoff");
  assert.equal(state.requiresFreshCollection, false);
  assert.equal(state.candidateHandoff.nextStep, "process_existing_handoff");
  assert.deepEqual(state.pendingHandoffs, [{
    batchId: "handoff-1",
    runId: "run-1",
    status: "pending_review",
    candidateCount: 8,
    purpose: "broker outreach",
    destination: "broker",
    datasetHash: "hash-1",
    createdAt: "2026-09-29T00:00:00.000Z",
    updatedAt: "2026-09-29T00:00:00.000Z"
  }]);
  assert.equal(JSON.stringify(state).includes("secret"), false);
});

test("startup inventory chooses persisted available candidates before resumable runs", () => {
  const state = buildStartupInventory({
    candidates: { total: 12, truncatedByStoreLimit: false },
    availableCandidates: { total: 8, truncatedByStoreLimit: false },
    pendingHandoffs: [],
    resumableRuns: [{ runId: "run-2", status: "paused" }]
  });

  assert.equal(state.decision, "use_existing_candidates");
  assert.deepEqual(state.candidateQuery, {
    source: "tiktok_live",
    qualificationStatus: "available",
    limit: 100,
    offset: 0
  });
  assert.deepEqual(state.candidateHandoff, {
    nextStep: "query_candidates_then_prepare_handoff",
    schemaVersion: "tkdesk.candidate-handoff.v4",
    markerField: "outreachStatus",
    initialMarker: "not_contacted",
    profileField: "profileUrl"
  });
  assert.equal(state.requiresFreshCollection, false);
});

test("startup inventory marks a nearly depleted list for replenishment after the current batch", () => {
  const state = buildStartupInventory({
    candidates: { total: 12, truncatedByStoreLimit: false },
    availableCandidates: { total: 3, truncatedByStoreLimit: false },
    pendingHandoffs: [],
    resumableRuns: []
  });

  assert.equal(state.decision, "use_existing_candidates");
  assert.deepEqual(state.replenishment, {
    needed: true,
    shouldStartAfterCurrentBatch: true,
    phase: "after_current_batch"
  });
  assert.match(state.recommendedAction, /收尾后补采/);
});

test("startup inventory keeps an existing unqualified list ahead of fresh collection", () => {
  const state = buildStartupInventory({
    candidates: { total: 12, truncatedByStoreLimit: false },
    availableCandidates: { total: 0, truncatedByStoreLimit: false },
    pendingHandoffs: [],
    resumableRuns: []
  });

  assert.equal(state.decision, "review_existing_candidates");
  assert.deepEqual(state.candidateQuery, {
    source: "tiktok_live",
    limit: 100,
    offset: 0
  });
  assert.equal(state.requiresFreshCollection, false);
});

test("startup inventory permits fresh collection only when no persisted work exists", () => {
  const state = buildStartupInventory({
    candidates: { total: 0, truncatedByStoreLimit: false },
    availableCandidates: { total: 0, truncatedByStoreLimit: false },
    pendingHandoffs: [],
    resumableRuns: [{ runId: "run-2", status: "paused" }]
  });
  assert.equal(state.decision, "resume_run");
  assert.equal(state.requiresFreshCollection, false);

  const fresh = buildStartupInventory({
    candidates: { total: 0, truncatedByStoreLimit: false },
    availableCandidates: { total: 0, truncatedByStoreLimit: false },
    pendingHandoffs: [],
    resumableRuns: []
  });
  assert.equal(fresh.decision, "collect_fresh");
  assert.equal(fresh.requiresFreshCollection, true);
});
