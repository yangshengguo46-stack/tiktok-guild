---
name: operate-guild-creators
description: Use when inspecting TikTok LIVE creator performance, activity, relationships, follow-up needs, or creator-level risk.
---

# Operate Guild Creators

## Select the read

Use `guild_creators` for current roster and operational state. Use `guild_intelligence.list_creator_metrics` when the question needs period metrics. Use creator-violation data only for risk conclusions.

Start with the requested creator ID or one bounded roster page. Do not scan every creator merely to answer a single-creator question. For a guild-wide count or ranking, prefer an aggregate; traverse pages only when completeness is required and report the cursor state.

## Diagnose

Keep these dimensions separate:

- relationship and membership state
- valid LIVE days and duration
- revenue and contribution for the stated period
- recent trend versus comparable period
- follow-up reason and assigned owner, when visible
- creator-specific violations or restrictions

Group creators as core output, stable, activatable, coaching-needed, and risk/unknown only when observed fields support the classification. A partial page cannot prove guild-wide concentration or inactivity rates.

## Output

Return creator ID, observed values with units and periods, evidence time, interpretation, next action, owner, and next review date. Preserve numeric precision. Separate platform facts from coaching recommendations.
