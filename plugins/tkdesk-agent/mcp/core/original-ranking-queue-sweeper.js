function safeReason(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return (normalized || "not_ready").slice(0, 80);
}

function errorCode(error, fallback = "queue_sweep_failed") {
  return safeReason(error?.code ?? fallback);
}

/**
 * Durable automatic runner for original ranking seeds.
 *
 * The database scan and automatic startup/timer trigger live in this shared
 * seam. Callers may inject only the high-level readiness and run-resume
 * boundaries; they cannot replace queue discovery with a hand-written claim.
 */
export function createOriginalRankingQueueSweeper({
  database,
  intervalMs,
  statuses = ["partial"],
  clock = () => new Date(),
  preflightRun,
  resumeRun,
  shuttingDown = () => false,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval
} = {}) {
  if (!database || typeof database.listRunsWithDueOriginalDiscoverySeeds !== "function") {
    throw new TypeError("a durable discovery database is required");
  }
  if (!Number.isFinite(intervalMs) || intervalMs < 1) {
    throw new TypeError("intervalMs must be a positive finite number");
  }
  if (typeof preflightRun !== "function") throw new TypeError("preflightRun is required");
  if (typeof resumeRun !== "function") throw new TypeError("resumeRun is required");

  const state = {
    intervalMs,
    running: false,
    scanCount: 0,
    overlapSkipCount: 0,
    lastStartedAt: null,
    lastFinishedAt: null,
    lastScan: null,
    lastErrorCode: null
  };
  let timer = null;
  let operation = null;

  const publicState = () => ({
    ...state,
    lastScan: state.lastScan ? structuredClone(state.lastScan) : null,
    payloadExposed: false
  });

  const scan = async (trigger = "timer") => {
    if (operation) {
      state.overlapSkipCount += 1;
      return operation;
    }
    const task = (async () => {
      const startedAt = clock().toISOString();
      state.running = true;
      state.scanCount += 1;
      state.lastStartedAt = startedAt;
      state.lastErrorCode = null;
      const report = {
        trigger,
        dueRunCount: 0,
        resumedRunCount: 0,
        skippedCounts: {},
        startedAt,
        finishedAt: null
      };
      const skipped = (reason) => {
        const key = safeReason(reason);
        report.skippedCounts[key] = (report.skippedCounts[key] ?? 0) + 1;
      };
      try {
        if (shuttingDown()) {
          skipped("daemon_shutting_down");
          return report;
        }
        const dueRuns = database.listRunsWithDueOriginalDiscoverySeeds({
          seedKind: "ranking",
          statuses,
          at: clock().toISOString(),
          limit: 100
        });
        report.dueRunCount = dueRuns.length;
        for (const dueRun of dueRuns) {
          if (shuttingDown()) {
            skipped("daemon_shutting_down");
            break;
          }
          let readiness;
          try {
            readiness = await preflightRun(dueRun);
          } catch (error) {
            skipped(errorCode(error, "resume_preflight_failed"));
            continue;
          }
          if (readiness?.ready !== true) {
            skipped(readiness?.reason ?? "resume_precondition_changed");
            continue;
          }
          // Preflight may await browser/authorization reads. A user can pause
          // the run or its bounded execution can finish while those reads are
          // pending, so recheck durable admission before acquiring the daemon
          // collector lease. Never turn an explicit pause into an auto resume.
          const admission = database.originalCollectionAutomaticResumeReadiness?.(dueRun.runId);
          if (admission?.ready === false) {
            skipped(admission.reason);
            continue;
          }
          try {
            const resumed = await resumeRun(dueRun);
            if (resumed?.queuedInDaemon === true
              || resumed?.alreadyRunning === true
              || resumed?.completed === true) {
              report.resumedRunCount += 1;
              // The daemon owns one shared collector lease. A scan therefore
              // starts at most one run even when the injected test runtime
              // completes synchronously.
              break;
            }
            skipped("resume_precondition_changed");
          } catch (error) {
            skipped(errorCode(error, "resume_failed"));
          }
        }
        return report;
      } catch (error) {
        state.lastErrorCode = errorCode(error);
        skipped(state.lastErrorCode);
        return report;
      } finally {
        const finishedAt = clock().toISOString();
        report.finishedAt = finishedAt;
        state.running = false;
        state.lastFinishedAt = finishedAt;
        state.lastScan = structuredClone(report);
      }
    })();
    operation = task;
    try {
      return await task;
    } finally {
      if (operation === task) operation = null;
    }
  };

  const start = () => {
    if (timer || shuttingDown()) return operation;
    timer = setIntervalFn(() => {
      void scan("timer");
    }, intervalMs);
    timer?.unref?.();
    void scan("startup");
    return operation;
  };

  const stop = () => {
    if (!timer) return;
    clearIntervalFn(timer);
    timer = null;
  };

  return {
    scan,
    start,
    stop,
    publicState,
    waitForIdle: async () => operation ? operation : state.lastScan
  };
}
