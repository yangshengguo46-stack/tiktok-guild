const STARTUP_QUERY_LIMIT = 100;
export const DEFAULT_REPLENISH_THRESHOLD = 20;
const CANDIDATE_HANDOFF_SCHEMA_VERSION = "tkdesk.candidate-handoff.v4";

function nonNegativeCount(value) {
  const count = Number(value);
  return Number.isFinite(count) && count >= 0 ? Math.floor(count) : 0;
}

function summarizeHandoff(batch = {}) {
  return {
    batchId: batch.batchId ?? null,
    runId: batch.runId ?? null,
    status: batch.status ?? null,
    candidateCount: nonNegativeCount(batch.candidateCount),
    purpose: batch.purpose ?? null,
    destination: batch.criteria?.destination ?? batch.payload?.destination ?? null,
    datasetHash: batch.payload?.datasetHash ?? null,
    createdAt: batch.createdAt ?? null,
    updatedAt: batch.updatedAt ?? null
  };
}

function summarizeRun(run = {}) {
  return {
    runId: run.runId ?? null,
    status: run.status ?? null,
    source: run.source ?? null,
    mode: run.mode ?? null,
    createdAt: run.createdAt ?? null,
    updatedAt: run.updatedAt ?? null
  };
}

function queryForExistingCandidates(availableCount) {
  const query = {
    source: "tiktok_live",
    limit: STARTUP_QUERY_LIMIT,
    offset: 0
  };
  if (availableCount > 0) query.qualificationStatus = "available";
  return query;
}

/**
 * Decide what the Lead should do after a process or conversation restart.
 * This function only consumes persisted summaries; it never starts collection.
 */
export function buildStartupInventory({
  candidates = {},
  availableCandidates = {},
  pendingHandoffs = [],
  resumableRuns = [],
  replenishThreshold = DEFAULT_REPLENISH_THRESHOLD,
  observedAt = new Date().toISOString()
} = {}) {
  const candidateCount = nonNegativeCount(candidates.total);
  const availableCount = nonNegativeCount(availableCandidates.total);
  const normalizedReplenishThreshold = nonNegativeCount(replenishThreshold);
  const needsReplenishment = availableCount <= normalizedReplenishThreshold;
  const handoffs = pendingHandoffs
    .filter((batch) => nonNegativeCount(batch?.candidateCount) > 0)
    .map(summarizeHandoff);
  const runs = resumableRuns.map(summarizeRun);
  const candidateQuery = candidateCount > 0
    ? queryForExistingCandidates(availableCount)
    : null;

  let decision;
  let reason;
  let recommendedAction;
  if (handoffs.length > 0) {
    decision = "use_existing_handoff";
    reason = "pending_handoff_exists";
    recommendedAction = "处理已有交接批次；不要重新采集名单";
  } else if (availableCount > 0) {
    decision = "use_existing_candidates";
    reason = "qualified_candidates_exist";
    recommendedAction = needsReplenishment
      ? "先按 candidateQuery 读取现有可用名单；当前批次收尾后补采，不要立刻新建第二个任务"
      : "先按 candidateQuery 读取现有可用名单；不要新建采集任务";
  } else if (candidateCount > 0) {
    decision = "review_existing_candidates";
    reason = "persisted_candidates_exist_without_available_qualification";
    recommendedAction = "先读取现有名单并补充资格核验；不要直接新建采集任务";
  } else if (runs.length > 0) {
    decision = "resume_run";
    reason = "resumable_run_exists";
    recommendedAction = "恢复已有任务；不要新建同类任务";
  } else {
    decision = "collect_fresh";
    reason = "no_persisted_work_found";
    recommendedAction = "确认采集条件后才允许新建采集任务";
  }

  return {
    schemaVersion: "tkdesk.startup-inventory.v1",
    observedAt,
    decision,
    reason,
    recommendedAction,
    requiresFreshCollection: decision === "collect_fresh",
    persistedCandidates: {
      total: candidateCount,
      truncatedByStoreLimit: candidates.truncatedByStoreLimit === true,
      available: availableCount,
      availableTruncatedByStoreLimit: availableCandidates.truncatedByStoreLimit === true,
      replenishThreshold: normalizedReplenishThreshold,
      needsReplenishment
    },
    replenishment: {
      needed: needsReplenishment,
      shouldStartAfterCurrentBatch: availableCount > 0 && needsReplenishment,
      phase: availableCount > 0 ? "after_current_batch" : "before_next_batch"
    },
    candidateHandoff: {
      nextStep: decision === "use_existing_handoff"
        ? "process_existing_handoff"
        : decision === "use_existing_candidates"
          ? "query_candidates_then_prepare_handoff"
          : null,
      schemaVersion: CANDIDATE_HANDOFF_SCHEMA_VERSION,
      markerField: "outreachStatus",
      initialMarker: "not_contacted",
      profileField: "profileUrl"
    },
    candidateQuery,
    pendingHandoffs: handoffs,
    resumableRuns: runs
  };
}
