// Configuration admission and recent upstream authorization are separate facts.
// This projection reads only the provider's safe in-memory observations.
export function projectMobileAuthorizationRuntime(configuration = {}, observations = []) {
  const rejected = observations.find(item => item?.state === "rejected");
  const verified = observations.length > 0 && observations.every(item => item?.state === "verified");
  const state = rejected ? "rejected" : verified ? "verified" : "unknown";
  const oldest = verified ? observations.reduce((previous, item) =>
    item.observedAt < previous.observedAt ? item : previous) : null;
  return {
    configurationState: configuration.state ?? "invalid",
    state: rejected ? "upstream_rejected" : configuration.state ?? "invalid",
    usable: configuration.state === "ready" && configuration.usable === true && !rejected,
    reason: rejected ? "upstream_rejected" : configuration.reason ?? null,
    onlineVerified: configuration.state === "ready" && configuration.usable === true && verified,
    onlineAuthorization: {
      state,
      reason: rejected?.reason ?? null,
      observedAt: rejected?.observedAt ?? oldest?.observedAt ?? null,
      verificationScope: "fixed_endpoint_authorization",
      persistsAcrossRestart: false
    }
  };
}
