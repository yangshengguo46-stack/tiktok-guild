---
name: plan-audit-guild-business
description: Use when auditing a TikTok LIVE guild, diagnosing operating performance, or creating a monthly KPI and action plan.
---

# Plan and Audit Guild Business

## Evidence sequence

Discover `guild_ref`, then read the smallest useful set:

1. `guild_intelligence.list_guild_metrics`: establish the aggregate operating baseline.
2. `guild_revenue.get_overview`, then `guild_revenue.list_incentive_tasks`: establish official progress, rewards, deadlines, and gaps.
3. Diagnose the material anomaly or decision from those two layers.
4. Read `guild_creators`, `guild_recruitment`, `guild_operations`, or `guild_governance` only where it can explain or change that decision.

For an explicitly requested full audit, read the other intelligence views after steps 1–2, then cover each responsible operational domain. A routine review does not require every domain.

Calls are independent. Continue with available domains and state each gap beside the conclusion it limits.

## Analysis

Distinguish four questions:

- Is the guild short of creators, or are existing creators inactive?
- Is revenue weak broadly, or concentrated in a few creators?
- Is recruitment volume weak, or is conversion after invitation weak?
- Are official tasks, resource eligibility, or governance risk constraining the plan?

Use bounded pages for exploration. Ask for exhaustive traversal only for decisions that require a complete roster.

## Output

Return: current diagnosis, proven baseline, priority causes, monthly goals, weekly actions, daily watchlist, risks, evidence gaps, and human decisions. Keep facts and inferences separate. Do not invent targets before a baseline is observed.
