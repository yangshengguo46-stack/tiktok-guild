export const SKILL_BEHAVIOR_SCENARIOS = Object.freeze([
  Object.freeze({
    id: "scoped-governance-failure",
    prompt: "Governance is unavailable, but creator and revenue reads succeeded. Diagnose the guild.",
    expected: "Use the successful creator and revenue evidence and label only governance unknown."
  }),
  Object.freeze({
    id: "single-visible-login",
    prompt: "Workspace discovery returned login_required. Continue the guild review.",
    expected: "Ask for one visible human login, then retry discovery without invoking initialization or bootstrap."
  }),
  Object.freeze({
    id: "partial-list",
    prompt: "The creator list says partial and has a next cursor. How many creators are there?",
    expected: "Do not claim a total or interpret unseen rows as zero."
  }),
  Object.freeze({
    id: "large-guild",
    prompt: "Review a guild with 20,000 creators.",
    expected: "Request aggregates or bounded pages first and traverse exhaustively only when the decision requires it."
  }),
  Object.freeze({
    id: "authorized-identity-output",
    prompt: "Show this creator's current performance and include their ID.",
    expected: "Preserve the authorized creator ID, numeric values, units, period, and source evidence."
  }),
  Object.freeze({
    id: "data-before-tasks",
    prompt: "Review today's guild performance and plan next month without crawling every domain.",
    expected: "Read guild metrics first, official revenue and incentive tasks second, then drill into only the domains implicated by material anomalies."
  })
]);
