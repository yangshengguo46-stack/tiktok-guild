const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;

export const DEFAULT_QUALIFICATION_POLICY = Object.freeze({
  maxBatchSize: 30,
  hourlyWindowMs: HOUR_MS,
  hourlyTargetMin: 50,
  hourlyTargetMax: 55,
  hourlyHardLimit: 55,
  dailyWindowMs: DAY_MS,
  dailyTargetMin: 145,
  dailyTargetMax: 150,
  dailyHardLimit: 150,
  intervalMinMs: 60_000,
  intervalMaxMs: 80_000
});

function finiteInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : fallback;
}

function boundedInteger(value, minimum, maximum, fallback = maximum) {
  return Math.min(maximum, Math.max(minimum, finiteInteger(value, fallback)));
}

function randomUnit(random) {
  const value = Number(typeof random === "function" ? random() : Math.random());
  if (!Number.isFinite(value)) return 0;
  return Math.min(1 - Number.EPSILON, Math.max(0, value));
}

function randomIntegerInclusive(minimum, maximum, random) {
  return minimum + Math.floor(randomUnit(random) * (maximum - minimum + 1));
}

function timestampOf(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return Number.isFinite(value) ? Math.trunc(value) : null;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (value && typeof value === "object") {
    return timestampOf(value.attemptedAt ?? value.attempted_at ?? value.timestamp);
  }
  return null;
}

function normalizedPolicy(input = DEFAULT_QUALIFICATION_POLICY) {
  const policy = { ...DEFAULT_QUALIFICATION_POLICY, ...(input ?? {}) };
  const hourlyHardLimit = Math.max(1, finiteInteger(policy.hourlyHardLimit, 55));
  const dailyHardLimit = Math.max(1, finiteInteger(policy.dailyHardLimit, 150));
  const hourlyTargetMin = boundedInteger(policy.hourlyTargetMin, 1, hourlyHardLimit, 50);
  const hourlyTargetMax = boundedInteger(
    policy.hourlyTargetMax,
    hourlyTargetMin,
    hourlyHardLimit,
    hourlyHardLimit
  );
  const dailyTargetMin = boundedInteger(policy.dailyTargetMin, 1, dailyHardLimit, 145);
  const dailyTargetMax = boundedInteger(
    policy.dailyTargetMax,
    dailyTargetMin,
    dailyHardLimit,
    dailyHardLimit
  );
  const intervalMinMs = Math.max(0, finiteInteger(policy.intervalMinMs, 60_000));
  const intervalMaxMs = Math.max(
    intervalMinMs,
    finiteInteger(policy.intervalMaxMs, 80_000)
  );
  return {
    maxBatchSize: Math.max(1, finiteInteger(policy.maxBatchSize, 30)),
    hourlyWindowMs: Math.max(1, finiteInteger(policy.hourlyWindowMs, HOUR_MS)),
    hourlyTargetMin,
    hourlyTargetMax,
    hourlyHardLimit,
    dailyWindowMs: Math.max(1, finiteInteger(policy.dailyWindowMs, DAY_MS)),
    dailyTargetMin,
    dailyTargetMax,
    dailyHardLimit,
    intervalMinMs,
    intervalMaxMs
  };
}

/**
 * Choose working targets once for a durable scheduling epoch and persist them.
 * Do not resample on every quota inspection, because doing so would move the
 * effective limit while a run is in progress.
 */
export function chooseQualificationTargets({
  random = Math.random,
  policy: policyInput = DEFAULT_QUALIFICATION_POLICY
} = {}) {
  const policy = normalizedPolicy(policyInput);
  return Object.freeze({
    hourly: randomIntegerInclusive(policy.hourlyTargetMin, policy.hourlyTargetMax, random),
    daily: randomIntegerInclusive(policy.dailyTargetMin, policy.dailyTargetMax, random)
  });
}

/** Return a jittered delay for the next distinct batch. */
export function nextQualificationDelayMs({
  random = Math.random,
  policy: policyInput = DEFAULT_QUALIFICATION_POLICY
} = {}) {
  const policy = normalizedPolicy(policyInput);
  return randomIntegerInclusive(policy.intervalMinMs, policy.intervalMaxMs, random);
}

function releaseTimeForWindow(attempts, limit, windowMs) {
  if (attempts.length < limit) return null;
  // If more than `limit` records are supplied (for example after importing an
  // older ledger), enough oldest records must expire to make the count < limit.
  return attempts[attempts.length - limit] + windowMs;
}

/**
 * Inspect rolling quota state without mutating the attempt ledger.
 *
 * Every supplied timestamp represents an attempted backend request regardless
 * of its eventual outcome. The caller must atomically persist an attempt before
 * dispatch and must not remove it after a failure, timeout, or CAPTCHA.
 */
export function inspectQualificationQuota(attempts = [], {
  now = Date.now(),
  targets = null,
  policy: policyInput = DEFAULT_QUALIFICATION_POLICY
} = {}) {
  const policy = normalizedPolicy(policyInput);
  const nowMs = timestampOf(now);
  if (nowMs === null) throw new TypeError("now must be a valid timestamp");

  const hourlyTarget = boundedInteger(
    targets?.hourly,
    policy.hourlyTargetMin,
    policy.hourlyTargetMax,
    policy.hourlyTargetMax
  );
  const dailyTarget = boundedInteger(
    targets?.daily,
    policy.dailyTargetMin,
    policy.dailyTargetMax,
    policy.dailyTargetMax
  );
  const effectiveHourlyLimit = Math.min(hourlyTarget, policy.hourlyHardLimit);
  const effectiveDailyLimit = Math.min(dailyTarget, policy.dailyHardLimit);

  const normalizedAttempts = (Array.isArray(attempts) ? attempts : [])
    .map(timestampOf)
    .filter((value) => value !== null)
    .sort((left, right) => left - right);
  const hourlyCutoff = nowMs - policy.hourlyWindowMs;
  const dailyCutoff = nowMs - policy.dailyWindowMs;
  // The rolling interval is (now - window, now]. A record exactly on the old
  // boundary has expired. Future-dated records remain counted conservatively
  // so a clock rollback cannot accidentally create extra allowance.
  const hourlyAttempts = normalizedAttempts.filter((value) => value > hourlyCutoff);
  const dailyAttempts = normalizedAttempts.filter((value) => value > dailyCutoff);

  const blockedBy = [];
  if (hourlyAttempts.length >= effectiveHourlyLimit) blockedBy.push("hourly_target");
  if (hourlyAttempts.length >= policy.hourlyHardLimit
    && effectiveHourlyLimit !== policy.hourlyHardLimit) blockedBy.push("hourly_hard_limit");
  if (dailyAttempts.length >= effectiveDailyLimit) blockedBy.push("daily_target");
  if (dailyAttempts.length >= policy.dailyHardLimit
    && effectiveDailyLimit !== policy.dailyHardLimit) blockedBy.push("daily_hard_limit");

  const hourlyReleaseAt = releaseTimeForWindow(
    hourlyAttempts,
    effectiveHourlyLimit,
    policy.hourlyWindowMs
  );
  const dailyReleaseAt = releaseTimeForWindow(
    dailyAttempts,
    effectiveDailyLimit,
    policy.dailyWindowMs
  );
  const releaseTimes = [hourlyReleaseAt, dailyReleaseAt]
    .filter((value) => value !== null && value > nowMs);
  const nextEligibleAtMs = blockedBy.length && releaseTimes.length
    ? Math.max(...releaseTimes)
    : (blockedBy.length ? nowMs : null);

  return Object.freeze({
    allowed: blockedBy.length === 0,
    blockedBy: Object.freeze(blockedBy),
    hourlyUsed: hourlyAttempts.length,
    hourlyTarget,
    hourlyHardLimit: policy.hourlyHardLimit,
    hourlyRemaining: Math.max(0, effectiveHourlyLimit - hourlyAttempts.length),
    dailyUsed: dailyAttempts.length,
    dailyTarget,
    dailyHardLimit: policy.dailyHardLimit,
    dailyRemaining: Math.max(0, effectiveDailyLimit - dailyAttempts.length),
    nextEligibleAtMs,
    nextEligibleAt: nextEligibleAtMs === null ? null : new Date(nextEligibleAtMs).toISOString()
  });
}

/**
 * Select one efficient qualification batch. Partial batches wait until the
 * discovery source is complete so one allowance is not wasted prematurely.
 */
export function planQualificationBatch(candidates = [], {
  sourceComplete = false,
  policy: policyInput = DEFAULT_QUALIFICATION_POLICY
} = {}) {
  const policy = normalizedPolicy(policyInput);
  const queue = Array.isArray(candidates) ? candidates : [];
  const ready = queue.length >= policy.maxBatchSize || (sourceComplete && queue.length > 0);
  const batch = ready ? queue.slice(0, policy.maxBatchSize) : [];
  return Object.freeze({
    ready,
    batch: Object.freeze(batch),
    batchSize: batch.length,
    consumesAllowances: ready ? 1 : 0,
    waitingFor: ready ? 0 : Math.max(0, policy.maxBatchSize - queue.length)
  });
}
