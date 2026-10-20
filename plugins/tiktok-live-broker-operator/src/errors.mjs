const RECOVERY = Object.freeze({
  duplicate_write: "Inspect get_operation_status or reconcile_message. Never resend or clear this reserved key.",
  idempotency_conflict: "Inspect the original bound operation. Do not reuse its key for different content or recipients.",
  write_receipt_unknown: "Inspect get_operation_status or reconcile_message without sending again. The reserved key cannot be cleared or retried.",
  provider_write_failed: "Inspect the recorded provider rejection. The operation key remains reserved.",
  profile_busy: "Wait for the existing owner to close; do not start another context or remove profile locks.",
  session_transition_timeout: "Wait for the pending transition to settle. A new context is forbidden while it remains in flight.",
  operation_not_found: "Inspect the operation key in the correct owned profile.",
  workflow_capacity: "Complete an existing workflow or wait for its bounded expiry before preparing another.",
  login_required: "Complete login in the visible TikTok LIVE Backstage window, then retry discovery.",
  runtime_restart_required: "Start a fresh Codex task so the current plugin runtime is loaded.",
  guild_binding_not_found: "Open the Backstage overview for an accessible guild, then retry discovery.",
  session_owner_unverified: "Close unrecognized Backstage automation sessions, then retry with this plugin.",
  capability_unavailable: "Use another available domain or retry after this live capability is restored.",
  adapter_mismatch: "Retry after the live adapter is reviewed."
});

export function recoveryFor(code) {
  return RECOVERY[code] ?? "Retry this domain after its live source is available.";
}

export class GuildError extends Error {
  constructor(code, message, recovery = recoveryFor(code), details = null) {
    super(message);
    this.name = "GuildError";
    this.code = code;
    this.recovery = recovery;
    this.details = details;
  }
}

export function normalizeGuildError(error) {
  if (error instanceof GuildError) {
    return Object.freeze({
      code: error.code,
      message: error.message,
      recovery: error.recovery,
      ...(error.details === null ? {} : { details: error.details })
    });
  }
  return Object.freeze({
    code: "capability_unavailable",
    message: "The requested live source is unavailable.",
    recovery: recoveryFor("capability_unavailable")
  });
}
