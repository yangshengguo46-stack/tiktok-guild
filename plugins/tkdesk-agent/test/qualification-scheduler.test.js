import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_QUALIFICATION_POLICY,
  chooseQualificationTargets,
  inspectQualificationQuota,
  nextQualificationDelayMs,
  planQualificationBatch
} from "../mcp/core/qualification-scheduler.js";

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;
const NOW = Date.parse("2026-08-23T12:00:00.000Z");

test("samples bounded working targets and a 60-80 second batch interval", () => {
  assert.deepEqual(chooseQualificationTargets({ random: () => 0 }), { hourly: 50, daily: 145 });
  assert.deepEqual(chooseQualificationTargets({ random: () => 0.999999 }), { hourly: 55, daily: 150 });
  assert.equal(nextQualificationDelayMs({ random: () => 0 }), 60_000);
  assert.equal(nextQualificationDelayMs({ random: () => 0.999999 }), 80_000);
});

test("allows the 55th hourly attempt and blocks the 56th reservation", () => {
  const attemptsBeforeFiftyFifth = Array.from({ length: 54 }, (_, index) => NOW - 30_000 - index);
  const before = inspectQualificationQuota(attemptsBeforeFiftyFifth, {
    now: NOW,
    targets: { hourly: 55, daily: 150 }
  });
  assert.equal(before.allowed, true);
  assert.equal(before.hourlyRemaining, 1);

  const afterFiftyFifth = inspectQualificationQuota([...attemptsBeforeFiftyFifth, NOW], {
    now: NOW,
    targets: { hourly: 55, daily: 150 }
  });
  assert.equal(afterFiftyFifth.allowed, false);
  assert.equal(afterFiftyFifth.hourlyUsed, 55);
  assert.equal(afterFiftyFifth.hourlyRemaining, 0);
  assert.deepEqual(afterFiftyFifth.blockedBy, ["hourly_target"]);
});

test("allows the 150th rolling-day attempt and blocks the 151st reservation", () => {
  // Spread attempts across the day so the hourly target is not the blocker.
  const attemptsBeforeOneHundredFiftieth = Array.from(
    { length: 149 },
    (_, index) => NOW - 2 * HOUR_MS - index * 60_000
  );
  const before = inspectQualificationQuota(attemptsBeforeOneHundredFiftieth, {
    now: NOW,
    targets: { hourly: 55, daily: 150 }
  });
  assert.equal(before.allowed, true);
  assert.equal(before.dailyRemaining, 1);

  const afterOneHundredFiftieth = inspectQualificationQuota(
    [...attemptsBeforeOneHundredFiftieth, NOW - 2 * HOUR_MS - 149 * 60_000],
    { now: NOW, targets: { hourly: 55, daily: 150 } }
  );
  assert.equal(afterOneHundredFiftieth.allowed, false);
  assert.equal(afterOneHundredFiftieth.dailyUsed, 150);
  assert.equal(afterOneHundredFiftieth.dailyRemaining, 0);
  assert.deepEqual(afterOneHundredFiftieth.blockedBy, ["daily_target"]);
});

test("rolling hourly allowance recovers exactly when the oldest attempt expires", () => {
  const attempts = Array.from({ length: 55 }, (_, index) => NOW - HOUR_MS + 1_000 + index);
  const blocked = inspectQualificationQuota(attempts, {
    now: NOW,
    targets: { hourly: 55, daily: 150 }
  });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.nextEligibleAtMs, attempts[0] + HOUR_MS);

  const recovered = inspectQualificationQuota(attempts, {
    now: attempts[0] + HOUR_MS,
    targets: { hourly: 55, daily: 150 }
  });
  assert.equal(recovered.allowed, true);
  assert.equal(recovered.hourlyUsed, 54);
});

test("rolling 24-hour allowance recovers exactly when the oldest attempt expires", () => {
  const attempts = Array.from({ length: 150 }, (_, index) => NOW - DAY_MS + 1_000 + index);
  const blocked = inspectQualificationQuota(attempts, {
    now: NOW,
    targets: { hourly: 55, daily: 150 }
  });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.nextEligibleAtMs, attempts[0] + DAY_MS);

  const recovered = inspectQualificationQuota(attempts, {
    now: attempts[0] + DAY_MS,
    targets: { hourly: 55, daily: 150 }
  });
  assert.equal(recovered.allowed, true);
  assert.equal(recovered.dailyUsed, 149);
});

test("all supplied request attempts count regardless of outcome metadata", () => {
  const attempts = Array.from({ length: 50 }, (_, index) => ({
    attemptedAt: new Date(NOW - index * 1_000).toISOString(),
    outcome: index % 3 === 0 ? "captcha" : index % 3 === 1 ? "timeout" : "failed"
  }));
  const state = inspectQualificationQuota(attempts, {
    now: NOW,
    targets: { hourly: 50, daily: 145 }
  });
  assert.equal(state.hourlyUsed, 50);
  assert.equal(state.allowed, false);
});

test("waits for a full batch and flushes only the terminal remainder", () => {
  const candidates = Array.from({ length: 29 }, (_, index) => ({ candidateId: `candidate-${index}` }));
  const waiting = planQualificationBatch(candidates);
  assert.equal(waiting.ready, false);
  assert.equal(waiting.waitingFor, 1);
  assert.equal(waiting.consumesAllowances, 0);

  const terminal = planQualificationBatch(candidates, { sourceComplete: true });
  assert.equal(terminal.ready, true);
  assert.equal(terminal.batchSize, 29);
  assert.equal(terminal.consumesAllowances, 1);

  const oversized = planQualificationBatch([...candidates, { candidateId: "candidate-29" }, { candidateId: "candidate-30" }]);
  assert.equal(oversized.batchSize, DEFAULT_QUALIFICATION_POLICY.maxBatchSize);
  assert.equal(oversized.consumesAllowances, 1);
});
