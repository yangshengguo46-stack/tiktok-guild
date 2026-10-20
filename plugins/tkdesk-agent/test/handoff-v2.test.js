import assert from "node:assert/strict";
import test from "node:test";
import { anonymizeCandidate, buildHandoff, summarizeCandidates } from "../mcp/core/handoff.js";

test("handoff hash is stable regardless of candidate input order", () => {
  const first = { candidateId: "b", handle: "bob", source: "svip_legacy" };
  const second = { candidateId: "a", handle: "alice", source: "tiktok_live" };
  const left = buildHandoff({ candidates: [first, second], destination: "digital-employee", purpose: "test" });
  const right = buildHandoff({ candidates: [second, first], destination: "digital-employee", purpose: "test" });
  assert.equal(left.datasetHash, right.datasetHash);
  assert.equal(left.status, "pending_review");
  assert.equal(left.sendAuthorized, false);
});

test("handoff rows keep the untouched marker and a direct creator profile URL", () => {
  const handoff = buildHandoff({
    candidates: [{
      candidateId: "creator-1",
      handle: "alice.creator",
      profileUrl: "[REDACTED_URL]",
      source: "tiktok_live",
      qualificationStatus: "available",
      qualificationSource: "collection_backstage"
    }],
    destination: "broker",
    purpose: "review invitable creators"
  });

  assert.equal(handoff.candidates[0].outreachStatus, "not_contacted");
  assert.equal(handoff.candidates[0].profileUrl, "https://www.tiktok.com/@alice.creator");
});

test("candidate summary keeps unknown distinct from zero", () => {
  const summary = summarizeCandidates([
    { candidateId: "a", followerCount: 0, source: "test", countryCode: null },
    { candidateId: "b", followerCount: null, source: "test", countryCode: "US" }
  ]);
  assert.equal(summary.total, 2);
  assert.equal(summary.fieldCoverage.followerCount, 1);
  assert.deepEqual(summary.countries, [{ label: "US", count: 1 }, { label: "未知", count: 1 }]);
});

test("handoff v4 preserves route, raw score, advisory lane, and separate qualification evidence", () => {
  const handoff = buildHandoff({
    destination: "digital-employee",
    purpose: "policy evidence",
    candidates: [{
      candidateId: "creator-1",
      handle: "alice",
      marketRegion: "MENA",
      routeCountry: "AE",
      rankingScopeMarketRegion: "MENA",
      rankingScopeCountryCode: "AE",
      rankingScopeCountryEvidence: "verified_proxy_exit",
      routeProfileId: "route-ae",
      proxyExitCountry: "AE",
      routeFingerprint: "route-fingerprint",
      routeConfigurationFingerprint: "configuration-fingerprint",
      routeVerifiedAt: "2026-08-23T03:00:00.000Z",
      backstageCountry: "AE",
      backstageCountryEvidence: "user_confirmed_configuration",
      creatorCountryCode: "AE",
      diamondRankingRecord: 12_300,
      diamondFieldUnits: { rankingRecord: "diamonds" },
      diamondUsdEstimates: {
        rankingRecord: {
          rawDiamonds: 12_300,
          estimatedUsd: 123,
          approximate: true,
          basis: "user_policy_100_diamonds_per_usd"
        }
      },
      expectedInvitationLane: "regular",
      legacyQualification: { status: "not_queried" },
      backstageQualification: { status: "available" }
    }]
  });
  assert.equal(handoff.schemaVersion, "tkdesk.candidate-handoff.v4");
  assert.equal(handoff.candidates[0].routeCountry, "AE");
  assert.deepEqual({
    rankingScopeMarketRegion: handoff.candidates[0].rankingScopeMarketRegion,
    rankingScopeCountryCode: handoff.candidates[0].rankingScopeCountryCode,
    rankingScopeCountryEvidence: handoff.candidates[0].rankingScopeCountryEvidence,
    routeProfileId: handoff.candidates[0].routeProfileId,
    proxyExitCountry: handoff.candidates[0].proxyExitCountry,
    routeFingerprint: handoff.candidates[0].routeFingerprint,
    routeConfigurationFingerprint: handoff.candidates[0].routeConfigurationFingerprint,
    routeVerifiedAt: handoff.candidates[0].routeVerifiedAt,
    backstageCountry: handoff.candidates[0].backstageCountry,
    backstageCountryEvidence: handoff.candidates[0].backstageCountryEvidence
  }, {
    rankingScopeMarketRegion: "MENA",
    rankingScopeCountryCode: "AE",
    rankingScopeCountryEvidence: "verified_proxy_exit",
    routeProfileId: "route-ae",
    proxyExitCountry: "AE",
    routeFingerprint: "route-fingerprint",
    routeConfigurationFingerprint: "configuration-fingerprint",
    routeVerifiedAt: "2026-08-23T03:00:00.000Z",
    backstageCountry: "AE",
    backstageCountryEvidence: "user_confirmed_configuration"
  });
  assert.equal(handoff.candidates[0].diamondRankingRecord, 12_300);
  assert.equal(handoff.candidates[0].diamondFieldUnits.rankingRecord, "diamonds");
  assert.equal(handoff.candidates[0].diamondUsdEstimates.rankingRecord.estimatedUsd, 123);
  assert.equal(handoff.candidates[0].expectedInvitationLane, "regular");
  assert.equal(handoff.candidates[0].legacyQualification.status, "not_queried");
  assert.equal(handoff.candidates[0].backstageQualification.status, "available");
});

test("handoff keeps each creator's discovery method and sanitized evidence URL", () => {
  const handoff = buildHandoff({
    destination: "digital-employee",
    purpose: "source provenance",
    candidates: [{
      candidateId: "creator-public-card",
      handle: "mira.creator",
      source: "tiktok_live",
      discoveryMethod: "public_live_cards",
      sourceUrl: "https://www.tiktok.com/@mira.creator/live?token=must-not-leak"
    }]
  });
  assert.equal(handoff.candidates[0].source, "tiktok_live");
  assert.equal(handoff.candidates[0].discoveryMethod, "public_live_cards");
  assert.equal(handoff.candidates[0].sourceUrl, "https://www.tiktok.com/@mira.creator/live");
  assert.equal(JSON.stringify(handoff).includes("must-not-leak"), false);
});

test("handoff route evidence keeps unknown null and excludes route secrets", () => {
  const candidate = {
    candidateId: "creator-route-unknown",
    rankingScopeMarketRegion: "unknown",
    rankingScopeCountryCode: "未知",
    rankingScopeCountryEvidence: "",
    routeProfileId: null,
    proxyExitCountry: "unknown",
    routeFingerprint: "未知",
    routeConfigurationFingerprint: "",
    routeVerifiedAt: null,
    backstageCountry: "unknown",
    backstageCountryEvidence: "未知",
    proxyUrl: "socks5://user:super-secret@127.0.0.1:1080",
    proxyServer: "http://127.0.0.1:8080",
    cookie: "session-cookie-secret",
    token: "access-token-secret",
    credentials: { username: "user", password: "super-secret" }
  };
  const handoff = buildHandoff({
    candidates: [candidate],
    destination: "digital-employee",
    purpose: "route evidence redaction"
  });
  const preview = anonymizeCandidate(candidate);
  const routeFields = [
    "rankingScopeMarketRegion",
    "rankingScopeCountryCode",
    "rankingScopeCountryEvidence",
    "routeProfileId",
    "proxyExitCountry",
    "routeFingerprint",
    "routeConfigurationFingerprint",
    "routeVerifiedAt",
    "backstageCountry",
    "backstageCountryEvidence"
  ];

  for (const field of routeFields) {
    assert.equal(handoff.candidates[0][field], null, field);
    assert.equal(preview[field], null, `preview.${field}`);
    assert.equal(summarizeCandidates([candidate]).fieldCoverage[field], 0, `coverage.${field}`);
  }

  const serialized = JSON.stringify(handoff);
  for (const secret of ["socks5://", "127.0.0.1", "super-secret", "session-cookie-secret", "access-token-secret"]) {
    assert.doesNotMatch(serialized, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("handoff preserves normalized leaderboard evidence and reports its coverage", () => {
  const candidate = {
    candidateId: "creator-ranked",
    handle: "alice",
    source: "tiktok_live_regional_gift_ranking",
    observedAt: "2026-08-23T03:04:05.000Z",
    rank: 7,
    rankScoreRaw: "00042",
    period: "daily",
    subtab: "gift",
    rankEvidence: {
      scoreType: "leaderboard_score",
      scoreUnit: "points",
      rankTypeCode: 8,
      regionTypeCode: 1,
      gapInterval: 0,
      rankingViewKind: "top",
      adapterEvidenceVersion: "regional-ranking-request-semantics-v1",
      source: "tiktok_rank_view",
      observedAt: "2026-08-23T03:04:04.000Z"
    }
  };
  const handoff = buildHandoff({
    candidates: [candidate],
    destination: "digital-employee",
    purpose: "leaderboard evidence"
  });

  assert.deepEqual({
    rank: handoff.candidates[0].rank,
    rankScoreRaw: handoff.candidates[0].rankScoreRaw,
    rankScoreType: handoff.candidates[0].rankScoreType,
    rankScoreUnit: handoff.candidates[0].rankScoreUnit,
    rankingPeriod: handoff.candidates[0].rankingPeriod,
    rankingSubtab: handoff.candidates[0].rankingSubtab,
    rankTypeCode: handoff.candidates[0].rankTypeCode,
    regionTypeCode: handoff.candidates[0].regionTypeCode,
    gapInterval: handoff.candidates[0].gapInterval,
    rankingViewKind: handoff.candidates[0].rankingViewKind,
    adapterEvidenceVersion: handoff.candidates[0].adapterEvidenceVersion,
    rankingSource: handoff.candidates[0].rankingSource,
    rankingObservedAt: handoff.candidates[0].rankingObservedAt
  }, {
    rank: 7,
    rankScoreRaw: "00042",
    rankScoreType: "leaderboard_score",
    rankScoreUnit: "points",
    rankingPeriod: "daily",
    rankingSubtab: "gift",
    rankTypeCode: 8,
    regionTypeCode: 1,
    gapInterval: 0,
    rankingViewKind: "top",
    adapterEvidenceVersion: "regional-ranking-request-semantics-v1",
    rankingSource: "tiktok_rank_view",
    rankingObservedAt: "2026-08-23T03:04:04.000Z"
  });

  const summary = summarizeCandidates([candidate]);
  for (const field of [
    "rank",
    "rankScoreRaw",
    "rankScoreType",
    "rankScoreUnit",
    "rankingPeriod",
    "rankingSubtab",
    "rankTypeCode",
    "regionTypeCode",
    "gapInterval",
    "rankingViewKind",
    "adapterEvidenceVersion",
    "rankingSource",
    "rankingObservedAt"
  ]) {
    assert.equal(summary.fieldCoverage[field], 1, field);
  }

  const preview = anonymizeCandidate(candidate);
  assert.equal(preview.rankScoreRaw, "00042");
  assert.equal(preview.rankingSource, "tiktok_rank_view");
  assert.equal(preview.rankingViewKind, "top");
});

test("unknown leaderboard metadata remains null instead of being inferred", () => {
  const candidate = {
    candidateId: "creator-unranked",
    source: "tiktok_live",
    observedAt: "2026-08-23T03:04:05.000Z",
    rankScoreType: "unknown",
    rankScoreUnit: "未知"
  };
  const handoff = buildHandoff({
    candidates: [candidate],
    destination: "digital-employee",
    purpose: "unknown evidence"
  });
  const value = handoff.candidates[0];

  for (const field of [
    "rank",
    "rankScoreRaw",
    "rankScoreType",
    "rankScoreUnit",
    "rankingPeriod",
    "rankingSubtab",
    "rankingCountdownSeconds",
    "rankTypeCode",
    "regionTypeCode",
    "gapInterval",
    "rankingViewKind",
    "adapterEvidenceVersion",
    "rankingSource",
    "rankingObservedAt"
  ]) {
    assert.equal(value[field], null, field);
  }
  assert.equal(summarizeCandidates([candidate]).fieldCoverage.rankingSource, 0);
});

test("same-source same-period leaderboard rows sort by numeric rank then candidate id", () => {
  const candidates = [
    { candidateId: "creator-z", source: "rank-view", period: "daily", rank: 2 },
    { candidateId: "creator-ten", source: "rank-view", period: "daily", rank: 10 },
    { candidateId: "creator-a", source: "rank-view", period: "daily", rank: "2" }
  ];
  const left = buildHandoff({
    candidates,
    destination: "digital-employee",
    purpose: "rank order"
  });
  const right = buildHandoff({
    candidates: [...candidates].reverse(),
    destination: "digital-employee",
    purpose: "rank order"
  });

  assert.deepEqual(left.candidates.map((candidate) => candidate.candidateId), [
    "creator-a",
    "creator-z",
    "creator-ten"
  ]);
  assert.equal(left.datasetHash, right.datasetHash);
});

test("preview and handoff expose six original scores with unit-safe diamond aliases", () => {
  const candidate = {
    candidateId: "creator-score-evidence",
    currentScore: 11,
    topScore: 12,
    historyRankScore: 13,
    hotListScore: "90071992547409931234567890",
    rankRecordScore: "90071992547409931234567892",
    rankingScore: "90071992547409931234567891"
  };
  const handoff = buildHandoff({
    candidates: [candidate],
    destination: "digital-employee",
    purpose: "raw rank-score evidence"
  });
  const preview = anonymizeCandidate(candidate);
  const summary = summarizeCandidates([candidate]);
  const expectedScores = {
    currentScore: 11,
    topScore: 12,
    historyRankScore: 13,
    hotListScore: "90071992547409931234567890",
    rankRecordScore: "90071992547409931234567892",
    rankingScore: "90071992547409931234567891",
    diamondCurrent: 11,
    diamondPeriod: 12,
    diamondRankingRecord: 13,
    diamondHistoricalMax: "90071992547409931234567892"
  };

  for (const [field, value] of Object.entries(expectedScores)) {
    assert.equal(handoff.candidates[0][field], value, `handoff.${field}`);
    assert.equal(preview[field], value, `preview.${field}`);
    assert.equal(summary.fieldCoverage[field], 1, `coverage.${field}`);
  }
  for (const field of [
    "currentScore",
    "topScore",
    "historyRankScore",
    "hotListScore",
    "rankRecordScore",
    "rankingScore"
  ]) {
    assert.equal(handoff.candidates[0].scoreFieldUnits[field], "unknown_rank_score", field);
    assert.equal(preview.scoreFieldUnits[field], "unknown_rank_score", `preview.${field}`);
  }
  assert.deepEqual(handoff.candidates[0].diamondFieldUnits, {
    current: "unknown_rank_score",
    period: "unknown_rank_score",
    rankingRecord: "unknown_rank_score",
    historicalMax: "unknown_rank_score"
  });
  assert.deepEqual(handoff.candidates[0].diamondUsdEstimates, {
    current: null,
    period: null,
    rankingRecord: null,
    historicalMax: null
  });
});

test("historical diamond alias is not derived from incomplete original score evidence", () => {
  const incomplete = anonymizeCandidate({
    candidateId: "creator-incomplete-history",
    hotListScore: 20,
    rankRecordScore: 30,
    rankingScore: null
  });
  assert.equal(incomplete.diamondHistoricalMax, null);

  const preserved = anonymizeCandidate({
    candidateId: "creator-legacy-history",
    diamondHistoricalMax: 44,
    diamondFieldUnits: { historicalMax: "unknown_rank_score" }
  });
  assert.equal(preserved.diamondHistoricalMax, 44);
  assert.equal(preserved.diamondFieldUnits.historicalMax, "unknown_rank_score");
  assert.equal(preserved.hotListScore, null);
  assert.equal(preserved.rankRecordScore, null);
  assert.equal(preserved.rankingScore, null);
});

test("unknown-rank direct diamond aliases backfill only their exact original fields", () => {
  const preview = anonymizeCandidate({
    candidateId: "creator-old-aliases",
    diamondCurrent: 21,
    diamondPeriod: 22,
    diamondRankingRecord: 23,
    diamondFieldUnits: {
      current: "unknown_rank_score",
      period: "unknown_rank_score",
      rankingRecord: "unknown_rank_score"
    }
  });
  assert.equal(preview.currentScore, 21);
  assert.equal(preview.topScore, 22);
  assert.equal(preview.historyRankScore, 23);
  assert.equal(preview.hotListScore, null);
  assert.equal(preview.rankRecordScore, null);
  assert.equal(preview.rankingScore, null);
});
