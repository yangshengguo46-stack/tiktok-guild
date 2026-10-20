function qualificationRuntimeError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function clockMilliseconds(clock) {
  const value = clock();
  const milliseconds = value instanceof Date ? value.getTime() : Number(value);
  if (!Number.isFinite(milliseconds)) {
    throw new TypeError("qualification clock must return a finite timestamp");
  }
  return milliseconds;
}

/**
 * Select only candidates that have never entered a qualification request for
 * this run. Ambiguous or failed attempts remain attempts and are deliberately
 * excluded after pause/restart; their explicit-recheck IDs are also excluded.
 */
export function listOriginalAutoQualificationProspects({
  database,
  runId,
  limit = 30
} = {}) {
  if (!database
    || typeof database.getRun !== "function"
    || typeof database.listUnattemptedRunProspects !== "function") {
    throw new TypeError("a durable qualification database is required");
  }
  const run = database.getRun(runId);
  if (!run) throw new Error(`collection run not found: ${runId ?? "(empty)"}`);
  const unresolved = new Set(run.result?.qualification?.unresolvedCandidateIds ?? []);
  return database.listUnattemptedRunProspects({ runId, limit: 2_000, offset: 0 })
    .filter((prospect) => !unresolved.has(prospect.candidateId))
    .slice(0, Math.min(30, Math.max(1, Number(limit ?? 30))));
}

/**
 * Durable qualification-spacing wait shared by daemon execution and injected
 * restart tests. The checkpoint contains only timing/state metadata. It never
 * turns an attempted request back into an automatic retry.
 */
export async function waitForOriginalQualificationWindow({
  database,
  runId,
  nextEligibleAt,
  shouldStop = () => false,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  clock = () => Date.now(),
  maxSleepMs = 30_000
} = {}) {
  if (!database
    || typeof database.updateRun !== "function"
    || typeof database.saveCheckpoint !== "function") {
    throw new TypeError("a durable qualification database is required");
  }
  if (typeof shouldStop !== "function" || typeof sleep !== "function") {
    throw new TypeError("qualification wait controls must be functions");
  }
  const deadline = Date.parse(nextEligibleAt ?? "");
  if (!Number.isFinite(deadline)) {
    throw qualificationRuntimeError(
      "资格查询预算已用尽，但没有可用的恢复时间",
      "qualification_budget_unavailable"
    );
  }
  const boundedMaxSleepMs = Math.min(30_000, Math.max(25, Number(maxSleepMs) || 30_000));
  const persist = (state, nowMs, lastStoppedReason = null) => {
    const value = {
      stage: "qualification",
      state,
      nextEligibleAt: new Date(deadline).toISOString(),
      automaticRetry: false,
      ...(lastStoppedReason ? { lastStoppedReason } : {}),
      updatedAt: new Date(nowMs).toISOString()
    };
    database.saveCheckpoint(runId, "qualification_wait", value, {
      adapter: "collection_backstage"
    });
    return value;
  };

  while (clockMilliseconds(clock) < deadline) {
    const nowMs = clockMilliseconds(clock);
    if (shouldStop()) {
      persist("stopped", nowMs, "paused_or_cancelled");
      return false;
    }
    const progress = persist("waiting", nowMs);
    database.updateRun(runId, {
      status: "waiting_quota",
      progress: {
        stage: progress.stage,
        nextEligibleAt: progress.nextEligibleAt,
        automaticRetry: false,
        note: "等待的是下一批新请求；失败批次不会重放"
      }
    });
    await sleep(Math.min(boundedMaxSleepMs, Math.max(25, deadline - nowMs)));
  }

  const nowMs = clockMilliseconds(clock);
  if (shouldStop()) {
    persist("stopped", nowMs, "paused_or_cancelled");
    return false;
  }
  persist("eligible", nowMs);
  return true;
}
