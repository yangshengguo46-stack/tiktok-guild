import { GuildError } from "./errors.mjs";

const CREATOR_REMOVAL_CHILDREN = new Set(["remove_creator"]);

export function operationPolicy({ domain, child } = {}) {
  const requires = domain === "guild_creators" && CREATOR_REMOVAL_CHILDREN.has(child);
  return Object.freeze({
    mode: requires ? "explicit_approval" : "agent_auto",
    requires_explicit_approval: requires
  });
}

export function authorizeOperation({ domain, child, approval, now = new Date().toISOString() } = {}) {
  const policy = operationPolicy({ domain, child });
  if (!policy.requires_explicit_approval) return policy;
  if (!approval || approval.approved !== true
    || approval.workflow_id === undefined
    || approval.step !== child
    || approval.idempotency_key === undefined) {
    throw new GuildError("authorization_required", `Explicit approval for ${domain}.${child} is required.`);
  }
  const expiresAt = Date.parse(approval.expires_at ?? "");
  const currentTime = Date.parse(now);
  if (Number.isNaN(expiresAt) || Number.isNaN(currentTime) || expiresAt <= currentTime) {
    throw new GuildError("authorization_expired", `Approval for ${domain}.${child} has expired.`);
  }
  return policy;
}

export { CREATOR_REMOVAL_CHILDREN };
