---
name: operate-guild-recruitment-messaging
description: Use when inspecting TikTok LIVE recruitment funnels, invitation capacity, prospects, conversations, onboarding, or drafting creator outreach.
---

# Operate Guild Recruitment and Messaging

## Read the funnel

Use `guild_recruitment` for prospects, recommendations, invitations, and quota. Use `guild_messaging.list_conversations` only when conversation state matters; use `get_messages` only for the explicitly requested conversation.

Measure the funnel as separate stages: discovered, contacted, replied, invited, joined, first LIVE, and stable active. Do not use invitation count as proof of joined or active creators. Keep quota tiers separate when the platform presents separate capacities.

## Prioritize

Rank prospects by observed fit, recent activity, funnel stage, blocking reason, and next action. For large prospect sets, work from a bounded page and state whether the list is partial.

When drafting outreach, distinguish verified guild facts from proposed language. Adapt the message to the creator's visible context without inventing guarantees, earnings, platform affiliation, or urgency.

## Safety

This release reads data and can execute a message through `guild_messaging.prepare_message` and `guild_messaging.send_message` when the authenticated Backstage identity is authorized. Ordinary backstage writes follow the agent operation policy. Require an exact recipient, exact sender identity, provider receipt, and outgoing read-back. If any of those are missing, keep the result as a draft or authorization error and never state that a message was sent.

## Output

Return funnel diagnosis, priority creator IDs, stage, owner, next action and date, quota facts, a draft when requested, and missing evidence.
