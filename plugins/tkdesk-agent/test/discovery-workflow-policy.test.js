import assert from "node:assert/strict";
import test from "node:test";
import {
  SEMI_AUTO_WORKFLOW_EVIDENCE,
  attachDiscoveryWorkflowEvidence,
  discoveryWorkflowPolicy
} from "../mcp/core/discovery-workflow-policy.js";

test('TikHub snapshots require the routed sessions and official qualification without original ranking recursion', () => {
  const full = discoveryWorkflowPolicy({ source: 'tiktok_live', mode: 'full_auto', filters: { discoveryMethod: 'tikhub_rankings' } });
  const semi = discoveryWorkflowPolicy({ source: 'tiktok_live', mode: 'semi_auto', filters: { discoveryMethod: 'tikhub_rankings' } });
  assert.equal(full.tikHubRankings, true);
  assert.equal(full.regional, false);
  assert.equal(full.automaticQualification, true);
  assert.equal(full.recursiveRankingExpansion, false);
  assert.deepEqual(full.requiredRouteSessionTargets, ['tiktok_discovery', 'collection_backstage']);
  assert.equal(semi.requiresVerifiedRoute, true);
  assert.equal(semi.automaticQualification, false);
  assert.deepEqual(semi.requiredRouteSessionTargets, ['tiktok_discovery']);
});

test("original semi-auto defaults to regional DataProcessor and stops before qualification", () => {
  const policy = discoveryWorkflowPolicy({
    source: "tiktok_live",
    mode: "semi_auto",
    filters: { marketRegion: "MENA", countryCodes: ["SA"] }
  });

  assert.equal(policy.discoveryMethod, "regional_gift_ranking");
  assert.equal(policy.regional, true);
  assert.equal(policy.semiAutoRegional, true);
  assert.equal(policy.requiresVerifiedRoute, true);
  assert.deepEqual(policy.requiredRouteSessionTargets, ["tiktok_discovery"]);
  assert.equal(policy.automaticQualification, false);
  assert.equal(policy.recursiveRankingExpansion, false);
  assert.deepEqual(policy.workflowEvidence, SEMI_AUTO_WORKFLOW_EVIDENCE);

  const candidate = attachDiscoveryWorkflowEvidence({
    handle: "creator.one",
    rawEvidence: { dataProcessor: { status: "ready" } }
  }, policy);
  assert.equal(candidate.workflowMode, "semi_auto");
  assert.equal(candidate.qualificationQueryState, "not_queried");
  assert.equal(candidate.automaticQualificationPerformed, false);
  assert.deepEqual(candidate.rawEvidence.dataProcessor, { status: "ready" });
  assert.deepEqual(candidate.rawEvidence.workflow, SEMI_AUTO_WORKFLOW_EVIDENCE);
  assert.equal(Object.hasOwn(candidate, "qualificationStatus"), false);
});

test("public LIVE cards stay an explicit diagnostic without semi-auto parity evidence", () => {
  const policy = discoveryWorkflowPolicy({
    source: "tiktok_live",
    mode: "semi_auto",
    filters: { discoveryMethod: "public_live_cards" }
  });

  assert.equal(policy.publicDiagnostic, true);
  assert.equal(policy.regional, false);
  assert.equal(policy.requiresVerifiedRoute, false);
  assert.deepEqual(policy.requiredRouteSessionTargets, []);
  assert.equal(policy.workflowEvidence, null);
  const candidate = { handle: "diagnostic.only" };
  assert.equal(attachDiscoveryWorkflowEvidence(candidate, policy), candidate);
});

test("explicit public LIVE full-auto qualifies candidates without mobile ranking expansion", () => {
  const policy = discoveryWorkflowPolicy({
    source: "tiktok_live",
    mode: "full_auto",
    filters: { discoveryMethod: "public_live_cards", marketRegion: "MENA" }
  });

  assert.equal(policy.discoveryMethod, "public_live_cards");
  assert.equal(policy.publicDiagnostic, false);
  assert.equal(policy.requiresVerifiedRoute, true);
  assert.deepEqual(policy.requiredRouteSessionTargets, [
    "tiktok_discovery",
    "collection_backstage"
  ]);
  assert.equal(policy.automaticQualification, true);
  assert.equal(policy.recursiveRankingExpansion, false);
  assert.equal(policy.workflowEvidence, null);
});

test("full auto retains collection-backstage qualification and qualified ranking expansion", () => {
  const tiktok = discoveryWorkflowPolicy({
    source: "tiktok_live",
    mode: "full_auto",
    filters: {}
  });
  assert.deepEqual(tiktok.requiredRouteSessionTargets, [
    "tiktok_discovery",
    "collection_backstage"
  ]);
  assert.equal(tiktok.automaticQualification, true);
  assert.equal(tiktok.recursiveRankingExpansion, true);
  assert.equal(tiktok.workflowEvidence, null);

  const legacy = discoveryWorkflowPolicy({
    source: "svip_legacy",
    mode: "full_auto",
    filters: {}
  });
  assert.deepEqual(legacy.requiredRouteSessionTargets, ["collection_backstage"]);
  assert.equal(legacy.requiresVerifiedRoute, true);
  assert.equal(legacy.automaticQualification, true);
  assert.equal(legacy.recursiveRankingExpansion, false);
});
