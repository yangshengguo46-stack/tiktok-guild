---
name: govern-guild-backstage
description: Use when inspecting TikTok LIVE guild violations, health score, reports, appeals, organization, permissions, or compliance risk.
---

# Govern Guild Backstage

## Read the relevant risk surface

Use `guild_governance` for guild violations, health events, reports, appeals, organization, and permissions. Use `guild_creators.list_creator_violations` for creator-level history. Do not broaden a creator question into a full organization review without need.

For each event retain its visible identifier, status, severity, consequence, occurrence or effective time, appeal deadline, account or creator scope, and source time. Unknown coverage means unverified, not safe.

## Assess

Separate current restrictions, historical events, open appeals, approaching deadlines, and permission gaps. Rank urgency by irreversible deadline, operational impact, and confidence. Do not infer guilt, contract meaning, or platform policy beyond the live evidence.

## Human control

Risk and enforcement decisions remain separate from ordinary backstage operations. Use verified write paths with an exact target, provider receipt, and read-back. Creator removals remain explicitly approval-gated; ordinary permission changes can run under the agent operation policy. Appeals, contract actions, and enforcement decisions are not inferred from a read and must not be claimed as executed without provider evidence.

## Output

Lead with urgent items. Then show affected IDs, event facts, deadlines, operational impact, recommended owner and action, evidence gaps, and which conclusions remain available if another business domain failed.
