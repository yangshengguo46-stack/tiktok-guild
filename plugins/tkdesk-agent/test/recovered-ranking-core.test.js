import assert from "node:assert/strict";
import test from "node:test";
import {
  RECOVERED_RANKING_CORE_VERSION,
  buildRecoveredOnlineAudienceUrl,
  mergeRecoveredMobileRankingStages,
  projectRecoveredMobileResponse,
  projectRecoveredOnlineAudience
} from "../mcp/core/recovered-ranking-core.js";

function mobileResponse(rows) {
  return { data: { rank_view: { ranks: rows } } };
}

function rankRow({ displayId, userId, roomId, score }) {
  return {
    score,
    room_id_str: roomId,
    rank_user: { display_id: displayId, id_str: userId }
  };
}

test("recovered MobileResponse parser preserves exact fields and int64 score precision", () => {
  const rows = projectRecoveredMobileResponse(mobileResponse([
    rankRow({
      displayId: "Creator.One",
      userId: "7412345678901234001",
      roomId: "7498765432109876001",
      score: "9007199254740993123"
    })
  ]));
  assert.deepEqual(rows, [{
    sourceIndex: 0,
    displayId: "Creator.One",
    userId: "7412345678901234001",
    roomId: "7498765432109876001",
    score: "9007199254740993123"
  }]);
});

test("recovered four-list merge keys on DisplayID and retains every source score", () => {
  const base = {
    displayId: "Creator.One",
    userId: "7412345678901234001",
    roomId: "7498765432109876001",
    secUid: "MS4wLjABAAAA_creator_one",
    nickname: null,
    followerCount: null,
    seller: null
  };
  const result = mergeRecoveredMobileRankingStages([
    { stage: "mobile_top_list", rows: [{ ...base, score: "100" }] },
    { stage: "mobile_history_list", rows: [{ ...base, displayId: "creator.one", score: "90" }] },
    { stage: "mobile_hot_list", rows: [{ ...base, score: "80" }] },
    { stage: "mobile_rank_record", rows: [{ ...base, score: "70" }] }
  ], {
    marketRegion: "MENA",
    countryCode: "SA",
    displayName: "MENA(中东)",
    topCode: 1,
    workId: 1
  });
  assert.equal(result.identityConflicts, 0);
  assert.equal(result.scoreConflicts, 0);
  assert.equal(result.candidates.length, 1);
  assert.deepEqual({
    topScore: result.candidates[0].topScore,
    historyRankScore: result.candidates[0].historyRankScore,
    hotListScore: result.candidates[0].hotListScore,
    rankRecordScore: result.candidates[0].rankRecordScore,
    evidence: result.candidates[0].recoveredRankingCoreVersion
  }, {
    topScore: "100",
    historyRankScore: "90",
    hotListScore: "80",
    rankRecordScore: "70",
    evidence: RECOVERED_RANKING_CORE_VERSION
  });
});

test("recovered merge rejects stable-ID cross-links between distinct DisplayIDs", () => {
  const sharedUserId = "7412345678901234001";
  const result = mergeRecoveredMobileRankingStages([
    {
      stage: "mobile_top_list",
      rows: [{ displayId: "creator.one", userId: sharedUserId, roomId: null, secUid: null, score: 10 }]
    },
    {
      stage: "mobile_hot_list",
      rows: [{ displayId: "creator.two", userId: sharedUserId, roomId: null, secUid: null, score: 20 }]
    }
  ]);
  assert.equal(result.identityConflicts, 1);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].handle, "creator.one");
});

test("recovered online-audience core fixes URL and sums scores without JS precision loss", () => {
  const url = new URL(buildRecoveredOnlineAudienceUrl(
    "7412345678901234001",
    "7498765432109876001"
  ));
  assert.equal(url.origin, "https://webcast.us.tiktok.com");
  assert.equal(url.pathname, "/webcast/ranklist/online_audience/");
  assert.deepEqual([...url.searchParams.entries()], [
    ["aid", "1988"],
    ["anchor_id", "7412345678901234001"],
    ["room_id", "7498765432109876001"]
  ]);

  assert.deepEqual(projectRecoveredOnlineAudience({
    data: {
      ranks: [{ score: "9007199254740993" }, { score: "7" }],
      total: 321
    }
  }), {
    currentScore: "9007199254741000",
    userCount: 321
  });
});
