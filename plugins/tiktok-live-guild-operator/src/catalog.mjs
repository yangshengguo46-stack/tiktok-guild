export const DOMAIN_CATALOG = Object.freeze([
  Object.freeze({
    name: "guild_workspace",
    title: "Guild workspace",
    description: "Discover the authenticated guild or passively inspect the current live-session state.",
    children: Object.freeze(["get_status"])
  }),
  Object.freeze({
    name: "guild_creators",
    title: "Guild creators",
    description: "Read managed creators, relationships, live activity, follow-up, and creator violations.",
    children: Object.freeze(["list_creators", "list_relationships", "list_live_activity", "list_follow_up", "list_creator_violations"])
  }),
  Object.freeze({
    name: "guild_recruitment",
    title: "Guild recruitment",
    description: "Read prospects, affiliate recruitment accounts, recommendations, invitations, and invitation capacity.",
    children: Object.freeze(["list_prospects", "list_affiliate_accounts", "list_recommendations", "list_invitations", "get_invitation_quota"])
  }),
  Object.freeze({
    name: "guild_messaging",
    title: "Guild messaging",
    description: "Read conversations and send messages through the authenticated Backstage identity under the agent operation policy.",
    children: Object.freeze(["list_conversations", "get_messages", "prepare_message", "send_message", "get_operation_status", "reconcile_message"])
  }),
  Object.freeze({
    name: "guild_operations",
    title: "Guild operations",
    description: "Read activities, Flare Card capacity, and Promote authorization and coupons.",
    children: Object.freeze(["list_activities", "get_flare_card_quota", "list_flare_card_records", "get_promote_authorization", "list_promote_coupons"])
  }),
  Object.freeze({
    name: "guild_revenue",
    title: "Guild revenue",
    description: "Read current revenue overview, incentive tasks, contributions, and business evaluation.",
    children: Object.freeze(["get_overview", "list_incentive_tasks", "list_contributions", "get_business_evaluation"])
  }),
  Object.freeze({
    name: "guild_governance",
    title: "Guild governance",
    description: "Read guild violations, health events, reports, appeals, organization, and permissions.",
    children: Object.freeze(["list_guild_violations", "list_health_events", "list_reports", "list_appeals", "list_organization", "list_permissions"])
  }),
  Object.freeze({
    name: "guild_intelligence",
    title: "Guild intelligence",
    description: "Read live recruitment, creator, team, guild, and weekly-report analytics for agent-side synthesis.",
    children: Object.freeze(["list_recruitment_metrics", "list_creator_metrics", "list_team_metrics", "list_guild_metrics", "list_live_reports"])
  }),
  Object.freeze({
    name: "guild_onboarding",
    title: "Guild onboarding",
    description: "Prepare and execute verified affiliate-account, staff-access, messaging-permission, profile, and invitation-card writes under the agent operation policy.",
    children: Object.freeze(["prepare_access_workflow", "prepare_affiliate_workflow", "prepare_affiliate_assignment", "assign_affiliate_account", "assign_staff", "allocate_invitation_cards", "grant_messaging_permission"])
  })
]);

function businessInputSchema(children) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["guild_ref", "child"],
    properties: {
      guild_ref: { type: "string", minLength: 8, maxLength: 128 },
      child: { type: "string", enum: [...children] },
      params: { type: "object", additionalProperties: true, ...(children.includes("prepare_message") ? { properties: { lookup_handle: { type: "string", minLength: 1, maxLength: 128, description: "Only with creator_id: a sourced TikTok username used for native lookup; returned CreatorUID must match creator_id exactly. Bound to the prepared plan and idempotency key." } } } : {}) }
    }
  };
}

function workspaceInputSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      child: { type: "string", enum: ["get_status"] }
    }
  };
}

export const TOOL_DEFINITIONS = Object.freeze(DOMAIN_CATALOG.map((domain) => Object.freeze({
  name: domain.name,
  title: domain.title,
  description: domain.description,
  inputSchema: domain.name === "guild_workspace"
    ? workspaceInputSchema()
    : businessInputSchema(domain.children)
})));

export const TOOL_NAMES = Object.freeze(TOOL_DEFINITIONS.map(({ name }) => name));
