---
name: model-guild-task-economics
description: Use when evaluating TikTok LIVE guild incentive tasks, progress gaps, qualification, reward economics, or deadline feasibility.
---

# Model Guild Task Economics

## Read live task facts

Use `guild_revenue.list_incentive_tasks` for current task progress and `guild_revenue.list_contributions` for attributable supply. Add creator activity, recruitment, or governance evidence only when the task depends on those inputs.

For every task retain its identifier or label, measurement period, unit, current progress, target, deadline, eligibility state, and visible reward. Unknown eligibility is not ineligibility; an absent reward is not zero reward.

## Calculate the frontier

For each tier, derive:

- remaining quantity and remaining time
- required daily and weekly pace
- observed recent pace when comparable periods exist
- named creator or team contribution already proven
- resource and compliance constraints
- confidence and missing evidence

Separate official task values from local forecasts. Do not assume a percentage target represents the same unit as revenue.

## Recommend

Classify tiers as achievable, stretch, or currently unproven. Prefer the highest tier whose incremental reward justifies the incremental operating cost and risk. State which human budget or workload limit could change the choice.

## Output

Return the recommended tier, task table, gap math, contribution evidence, daily pace, assumptions, risks, and the next evidence read needed.
