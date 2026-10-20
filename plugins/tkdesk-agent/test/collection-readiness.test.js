import assert from "node:assert/strict";
import test from "node:test";
import { inspectCollectionReadiness } from "../mcp/core/collection-readiness.js";

const available = () => ({
  routeConfigured: true, routeVerified: true,
  sessions: { tiktok_discovery: { running: true, authenticatedRequestReady: true, restartRequired: false },
    collection_backstage: { running: true, authenticatedRequestReady: true, restartRequired: false } },
  adapterEvidence: { qualificationAdapterReady: true, regionMatched: true, accountAvailable: true,
    qualificationRequestConsumed: false, observedAt: "2026-09-28T00:00:00.000Z" },
  qualificationBudgetAllowed: true
});

test("verified route and both browsers still require current qualification adapter evidence", () => {
  const result = inspectCollectionReadiness({ ...available(), adapterEvidence: null });
  assert.equal(result.ready, false);
  assert.equal(result.routeReady, true);
  assert.equal(result.sessionsReady, true);
  assert.equal(result.adapter.state, "unchecked");
  assert.ok(result.blockingReasons.includes("collection_adapter_unchecked"));
});

test("a qualified read-only adapter observation admits only matching authenticated sessions and available budget", () => {
  assert.equal(inspectCollectionReadiness(available()).ready, true);
  for (const target of ["tiktok_discovery", "collection_backstage"]) {
    for (const patch of [{ running: false }, { authenticatedRequestReady: false }, { restartRequired: true }]) {
      const input = available();
      Object.assign(input.sessions[target], patch);
      assert.equal(inspectCollectionReadiness(input).ready, false, `${target}:${Object.keys(patch)[0]}`);
    }
  }
  assert.equal(inspectCollectionReadiness({ ...available(), qualificationBudgetAllowed: false }).ready, false);
  assert.equal(inspectCollectionReadiness({ ...available(), collectorBusy: true }).ready, false);
  assert.equal(inspectCollectionReadiness({ ...available(), shuttingDown: true }).ready, false);
});

test("failed or market-mismatched adapter observations cannot be reported operational", () => {
  for (const field of ["qualificationAdapterReady", "regionMatched", "accountAvailable"]) {
    const input = available(); input.adapterEvidence[field] = false;
    const result = inspectCollectionReadiness(input);
    assert.equal(result.ready, false);
    assert.equal(result.adapter.state, "blocked");
    assert.ok(result.blockingReasons.includes("collection_adapter_not_ready"));
  }
  const input = available();
  input.adapterEvidence.failureStage = "transport_defaults";
  input.adapterEvidence.rawResponse = "MUST_NOT_LEAK";
  input.adapterEvidence.routeFingerprint = "PRIVATE_FINGERPRINT";
  const result = inspectCollectionReadiness(input);
  assert.equal(result.adapter.failureStage, "transport_defaults");
  assert.equal(JSON.stringify(result).includes("MUST_NOT_LEAK"), false);
  assert.equal(JSON.stringify(result).includes("PRIVATE_FINGERPRINT"), false);
});
