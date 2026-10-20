import assert from "node:assert/strict";
import test from "node:test";
import {
  CANDIDATE_BUSINESS_POLICY,
  deriveDiamondUsdEstimate,
  deriveDiamondUsdEstimateForEvidence,
  deriveExpectedInvitationLane,
  deriveOriginalHighQuality,
  deriveOriginalScoreMaximum,
  normalizeCandidatePolicy
} from "../mcp/core/candidate-policy.js";

test("derives an explicitly approximate USD estimate without replacing raw diamonds", () => {
  assert.deepEqual(deriveDiamondUsdEstimate(12_345), {
    rawDiamonds: 12_345,
    estimatedUsd: 123.45,
    currency: "USD",
    approximate: true,
    basis: "user_policy_100_diamonds_per_usd",
    diamondsPerUsd: 100
  });
  assert.deepEqual(deriveDiamondUsdEstimate("10,000"), {
    rawDiamonds: 10_000,
    estimatedUsd: 100,
    currency: "USD",
    approximate: true,
    basis: "user_policy_100_diamonds_per_usd",
    diamondsPerUsd: 100
  });
  assert.equal(CANDIDATE_BUSINESS_POLICY.diamondsPerUsd, 100);
});

test("estimates USD only for source fields explicitly identified as diamonds", () => {
  assert.equal(deriveDiamondUsdEstimateForEvidence(12_345, "unknown_rank_score"), null);
  assert.equal(deriveDiamondUsdEstimateForEvidence(12_345, null), null);
  assert.deepEqual(deriveDiamondUsdEstimateForEvidence(12_345, "diamonds"), {
    rawDiamonds: 12_345,
    estimatedUsd: 123.45,
    currency: "USD",
    approximate: true,
    basis: "user_policy_100_diamonds_per_usd",
    diamondsPerUsd: 100
  });
});

test("preserves unknown and negative sentinel values without inventing USD", () => {
  const unknown = deriveDiamondUsdEstimate("not-a-number");
  assert.equal(unknown.rawDiamonds, null);
  assert.equal(unknown.estimatedUsd, null);
  assert.equal(unknown.approximate, true);

  const sentinel = deriveDiamondUsdEstimate(-3);
  assert.equal(sentinel.rawDiamonds, -3);
  assert.equal(sentinel.estimatedUsd, null);
  assert.equal(sentinel.basis, "user_policy_100_diamonds_per_usd");
});

test("derives only the expected invitation lane around the one-million boundary", () => {
  assert.equal(deriveExpectedInvitationLane(999_999).expectedInvitationLane, "regular");
  assert.equal(deriveExpectedInvitationLane(1_000_000).expectedInvitationLane, "backend_required");
  assert.equal(deriveExpectedInvitationLane(1_000_001).expectedInvitationLane, "advanced");
  assert.equal(deriveExpectedInvitationLane("1,000,001").expectedInvitationLane, "advanced");

  const unknown = deriveExpectedInvitationLane(null);
  assert.equal(unknown.followerCount, null);
  assert.equal(unknown.expectedInvitationLane, null);
  assert.equal(unknown.advisory, true);
  assert.equal(Object.hasOwn(unknown, "eligible"), false);
  assert.equal(Object.hasOwn(unknown, "eligibility"), false);
});

test("keeps legacy and backstage qualification evidence separate and immutable", () => {
  const legacyQualification = {
    schema: "svip_zb_yqType",
    status: "advanced_invitation",
    eligible: true,
    nested: { code: 4 }
  };
  const backstageQualification = {
    schema: "live_backstage_anchor_status",
    status: "ineligible",
    eligible: false,
    nested: { anchorStatusCode: 3 }
  };
  const result = normalizeCandidatePolicy({
    diamondValue: 5_000,
    diamondUnit: "diamonds",
    followerCount: 1_250_000,
    legacyQualification,
    backstageQualification,
    // Deliberately unsupported generic/derived claims must not enter output.
    qualification: { status: "available" },
    platformCreator: true,
    diamondLimitExceeded: true,
    insufficientDuration: true
  });

  assert.deepEqual(result.legacyQualification, legacyQualification);
  assert.deepEqual(result.backstageQualification, backstageQualification);
  assert.notEqual(result.legacyQualification, legacyQualification);
  assert.notEqual(result.backstageQualification, backstageQualification);
  assert.notEqual(result.legacyQualification.nested, legacyQualification.nested);
  assert.notEqual(result.backstageQualification.nested, backstageQualification.nested);
  assert.equal(Object.isFrozen(result.legacyQualification), true);
  assert.equal(Object.isFrozen(result.backstageQualification.nested), true);

  assert.equal(result.invitationExpectation.expectedInvitationLane, "advanced");
  for (const forbidden of [
    "qualification",
    "eligible",
    "eligibility",
    "platformCreator",
    "platform_creator",
    "diamondLimitExceeded",
    "diamondCap",
    "insufficientDuration",
    "liveDurationResult"
  ]) {
    assert.equal(Object.hasOwn(result, forbidden), false, `must not infer ${forbidden}`);
  }
});

test("does not infer platform-creator, diamond-cap, or live-duration outcomes", () => {
  const result = normalizeCandidatePolicy({
    diamondValue: 999_999_999,
    diamondUnit: "diamonds",
    followerCount: 2_000_000
  });
  assert.deepEqual(result.legacyQualification, null);
  assert.deepEqual(result.backstageQualification, null);
  assert.equal(result.invitationExpectation.expectedInvitationLane, "advanced");
  assert.equal(result.diamondEstimate.estimatedUsd, 9_999_999.99);
  assert.equal(Object.hasOwn(result, "platformCreator"), false);
  assert.equal(Object.hasOwn(result, "diamondLimitExceeded"), false);
  assert.equal(Object.hasOwn(result, "insufficientDuration"), false);
});

test("policy projection refuses a numeric legacy score without explicit diamond provenance", () => {
  const result = normalizeCandidatePolicy({ diamondValue: 50_000, followerCount: 10_000 });
  assert.equal(result.diamondEstimate, null);
  assert.equal(result.invitationExpectation.expectedInvitationLane, "regular");
});

test("original high-quality policy uses exactly five score fields and excludes TopScore", () => {
  assert.equal(deriveOriginalHighQuality({
    CurrentScore: 0,
    TopScore: 999_999,
    HistoryRankScore: 1,
    HotListScore: 2,
    RankRecordScore: 3,
    RankingScore: 9
  }), false);
  assert.equal(deriveOriginalHighQuality({
    currentScore: 0,
    historyRankScore: 10,
    hotListScore: null,
    rankRecordScore: null,
    rankingScore: null
  }), true);
});

test("original high-quality policy returns null for unresolved partial evidence", () => {
  assert.equal(deriveOriginalHighQuality({
    currentScore: 0,
    historyRankScore: 9,
    hotListScore: 8,
    rankRecordScore: 7
  }), null);
  assert.equal(deriveOriginalHighQuality({}), null);
  assert.equal(deriveOriginalHighQuality({
    currentScore: 0,
    historyRankScore: 0,
    hotListScore: 0,
    rankRecordScore: 0,
    rankingScore: "not-observed"
  }), null);
});

test("original score comparisons preserve integers beyond Number.MAX_SAFE_INTEGER", () => {
  const huge = "90,071,992,547,409,931,234,567,890";
  assert.equal(deriveOriginalHighQuality({ rankingScore: huge }), true);
  assert.equal(deriveOriginalScoreMaximum([
    "90071992547409931234567890",
    "90071992547409931234567891",
    "90071992547409931234567889"
  ]), "90071992547409931234567891");
  assert.equal(deriveOriginalScoreMaximum([1, null, 3]), null);
  assert.equal(deriveOriginalScoreMaximum([Number.MAX_SAFE_INTEGER + 1, 2, 3]), null);
  assert.equal(deriveOriginalScoreMaximum(["-1", 2, 3]), null);
  assert.equal(deriveOriginalHighQuality({ rankingScore: -10 }), null);
});
