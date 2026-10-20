---
name: tiktok-live-guild-operator
description: Use when operating, auditing, recruiting, messaging, or analyzing an authenticated TikTok LIVE guild through LIVE Backstage.
---

# TikTok LIVE Guild Operator

## Operating contract

Use `guild_workspace {}` once to obtain `guild_ref`. If it returns `login_required`, ask the user to complete login in the one visible Backstage window, then retry the same call.

For a broad daily review or operating-plan request, use this default evidence order:

1. Read `guild_intelligence.list_guild_metrics` for the aggregate operating baseline.
2. Read `guild_revenue.get_overview`, then `guild_revenue.list_incentive_tasks`, for official progress and gaps.
3. Identify the material anomaly or decision, then read only its responsible creator, recruitment, operations, governance, or messaging domain.

Do not open every domain by default. For an explicitly requested full audit, read the remaining intelligence views after the baseline and task reads, then add the operational domains needed to explain them. For a narrow question, call its responsible domain directly.

Call only the domains needed for the question:

| Need | MCP domain |
|---|---|
| Creator roster, activity, follow-up, creator violations | `guild_creators` |
| Prospects, recommendations, invitations, quota | `guild_recruitment` |
| Conversations or requested message history | `guild_messaging` |
| Activities, Flare Card, Promote | `guild_operations` |
| Revenue, tasks, contributions, evaluation | `guild_revenue` |
| Guild violations, health, appeals, organization | `guild_governance` |
| Recruitment, creator, team, guild, report analytics | `guild_intelligence` |

For a listed broker who needs messaging access, use `guild_onboarding.grant_messaging_permission` with the exact AgentID and email; it submits once and reads the authorized row back. When the broker profile is already authenticated, set `TIKTOK_GUILD_BROKER_PROFILE_DIR`, `TIKTOK_GUILD_BROKER_ACCOUNT_REF`, and `TIKTOK_GUILD_BROKER_IDENTITY_TEXT` before starting the MCP. Then pass the TKDesk `userId` as `creator_id` to `guild_messaging.prepare_message`; `guild_messaging.send_message` selects the broker profile only after the visible identity marker matches.

For organization-account registration or assigning backstage access to staff, hand off to the packaged `operate-guild-onboarding` skill. It composes the existing Outlook Email connector with `guild_onboarding.prepare_access_workflow`, lets the agent execute ordinary backstage mutations after exact identity and target binding, and requires provider receipt read-back before reporting completion. Creator removal remains the explicit approval boundary.

Keep every successful result even when another domain fails. Label the unavailable domain and limit only conclusions that depend on it. Missing or partial data is unknown, never zero.

For large guilds, start with aggregates or one bounded page. Request more pages only when the decision requires exhaustive coverage. Preserve authorized creator IDs, numeric values, units, periods, pagination, and source time in the active task.

The plugin supports both reads and operations. A normal mutating child must have an exact target and identity, a live provider receipt, and read-back evidence before it is reported as applied. The messaging write path uses `guild_messaging.prepare_message` followed by `guild_messaging.send_message`; if the current Backstage identity cannot send, preserve the authorization error and do not retry. Creator removal requires an explicit step-specific approval. Unsupported or unverified live contracts remain unavailable rather than being simulated.

## Output

Lead with the decision or finding. Then separate proven facts, inferences, missing evidence, and any human decision still required.
