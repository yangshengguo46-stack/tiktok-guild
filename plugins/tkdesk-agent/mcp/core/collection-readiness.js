const TARGETS = ["tiktok_discovery", "collection_backstage"];

/** Read-only admission snapshot; callers supply only current-process adapter evidence. */
export function inspectCollectionReadiness({
  routeConfigured = false,
  routeVerified = false,
  sessions = {},
  adapterEvidence = null,
  qualificationBudgetAllowed = false,
  collectorBusy = false,
  shuttingDown = false
} = {}) {
  const blockingReasons = [];
  const routeReady = routeConfigured && routeVerified;
  if (!routeConfigured) blockingReasons.push("collection_route_required");
  else if (!routeVerified) blockingReasons.push("collection_route_unverified");
  let sessionsReady = true;
  for (const target of TARGETS) {
    const session = sessions[target];
    if (session?.restartRequired === true) {
      blockingReasons.push(`${target}_route_restart_required`);
      sessionsReady = false;
    } else if (session?.running !== true || session?.authenticatedRequestReady !== true) {
      blockingReasons.push(`${target}_session_not_ready`);
      sessionsReady = false;
    }
  }
  const checked = Boolean(adapterEvidence);
  const adapterReady = checked && adapterEvidence.qualificationAdapterReady === true
    && adapterEvidence.regionMatched === true && adapterEvidence.accountAvailable === true
    && adapterEvidence.qualificationRequestConsumed === false;
  if (!checked) blockingReasons.push("collection_adapter_unchecked");
  else if (!adapterReady) blockingReasons.push("collection_adapter_not_ready");
  if (!qualificationBudgetAllowed) blockingReasons.push("qualification_budget_blocked");
  if (collectorBusy) blockingReasons.push("collector_busy");
  if (shuttingDown) blockingReasons.push("daemon_shutting_down");
  const boolean = value => typeof value === "boolean" ? value : null;
  const observedAt = typeof adapterEvidence?.observedAt === "string"
    && Number.isFinite(Date.parse(adapterEvidence.observedAt)) ? adapterEvidence.observedAt : null;
  const failureStage = typeof adapterEvidence?.failureStage === "string"
    && /^[a-z_]{1,80}$/.test(adapterEvidence.failureStage) ? adapterEvidence.failureStage : null;
  return {
    scope: "original_full_auto",
    ready: blockingReasons.length === 0,
    blockingReasons,
    routeReady,
    sessionsReady,
    adapter: {
      state: !checked ? "unchecked" : adapterReady ? "ready" : "blocked",
      qualificationAdapterReady: boolean(adapterEvidence?.qualificationAdapterReady),
      regionMatched: boolean(adapterEvidence?.regionMatched),
      accountAvailable: boolean(adapterEvidence?.accountAvailable),
      failureStage,
      observedAt,
      evidenceScope: "current_process_page_and_route",
      recheckBeforeExecution: true
    },
    qualificationBudgetAllowed,
    collectorBusy,
    qualificationRequestConsumed: false
  };
}
