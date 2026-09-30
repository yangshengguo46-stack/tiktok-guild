# Creator Intelligence Conversation Design

**Date:** 2026-10-01
**Status:** Approved for implementation by the project owner
**Related audit:** `docs/audits/2026-09-30-business-completion-audit.md`
**Product boundary:** DeerFlow native Lead remains the only business control plane. TKDesk and Guild Operator remain owners of their source facts.

## Goal

Given a creator's authorized public profile, works, live/content signals, and verified conversation history, produce an evidence-backed conversation plan that helps the agent open naturally, progress toward a transparent guild invitation, estimate the likely number of turns to a formal application or signing, and improve from confirmed outcomes without silently rewriting facts or learning manipulative behavior.

The business success target is a verified funnel ending in an explicit creator consent event and a formal application/signing receipt. A model prediction, a positive reply, a draft invitation, an MCP connection, or a UI click is not a signing.

## Non-goals and hard boundaries

- Do not guarantee conversion or claim a creator will sign within a fixed number of turns.
- Do not use sensitive or inferred attributes such as appearance, gender, income, vulnerability, or presumed dependency to persuade.
- Do not fabricate familiarity with a creator or claim that a message was sent, read, accepted, or signed without provider read-back.
- Do not add a second business ledger, worker, agent, or provider write path. Reuse native social persistence, ChannelManager, scheduler, and provider gates.
- Do not train model weights from live conversations in this phase. “Gets smarter” means source-aware memory, better strategy selection, and outcome calibration.
- No external platform write is enabled by this feature. TikTok provider identity, authorization, deduplication, and receipt evidence remain mandatory gates.

## Architecture

The feature has five native layers:

1. **Evidence ingestion.** TikHub, crawler, homepage, and TKDesk imports implement a common read-only adapter contract. Each observation is normalized into a bounded `CreatorEvidence` record with source reference, capture time, freshness, provenance, and confidence. Raw payloads stay outside model context and Git.
2. **Creator intelligence snapshot.** A scoped, versioned snapshot groups creator identity, content themes, recurring formats, explicit goals, public interaction signals, and open questions. Facts are separated from hypotheses and strategy suggestions. Conflicts remain visible instead of being silently merged.
3. **Conversation planner.** The planner turns the snapshot plus current relationship state into a `ConversationPlan`: opening candidates, forbidden assumptions, stage sequence, per-turn objective, evidence to verify, consent checkpoint, stop/hand-off conditions, and a conversion estimate interval. Plans are advisory data passed into the native social runtime; they cannot authorize tools or bypass contact boundaries.
4. **Learning loop.** After each turn, the runtime stores only bounded memory candidates with evidence IDs. Host validation promotes candidates to durable relationship/self memory only when source and scope checks pass. Explicit creator corrections retract or supersede prior memories. Outcomes update a calibration record; they do not update model weights.
5. **Outcome and scheduling.** A formal invitation, application, or signing becomes a typed event only after a provider or human operator produces an auditable receipt. Followups reuse the native scheduler and are cancelled by new creator input, do-not-contact, human takeover, or provider uncertainty.

## Canonical data contracts

### CreatorEvidence

```json
{
  "evidence_id": "tikhub:creator:123:video:456",
  "scope": {"owner_user_id": "guild-owner", "account_id": "tiktok-account", "person_ref": "creator-123"},
  "source_kind": "tikhub|crawler|homepage|tkdesk|creator_message|operator_note",
  "source_ref": "provider-specific-id",
  "captured_at": "2026-10-01T00:00:00Z",
  "expires_at": "2026-10-15T00:00:00Z",
  "confidence": 0.0,
  "kind": "identity|content|audience|goal|interaction|constraint",
  "text": "bounded source summary",
  "facts": [{"key": "content_theme", "value": "..."}],
  "raw_ref": "git-ignored artifact reference"
}
```

The adapter must reject missing scope, source reference, capture time, or confidence outside `[0,1]`. The planner can consume only evidence that is current for the requested scope and has a non-empty source reference.

### CreatorIntelligenceSnapshot

The snapshot is immutable by revision and contains:

- `identity`: provider identity and display metadata, never inferred demographics;
- `content_map`: bounded themes, formats, representative works, and recurring language;
- `creator_goals`: only explicit or source-labeled goals;
- `relationship_signals`: response history, consent state, objections, and verified commitments;
- `open_questions`: facts the agent must ask rather than assume;
- `evidence_refs`: every material item maps to one or more current evidence IDs;
- `revision`, `captured_at`, and `freshness_state`.

### ConversationPlan

```json
{
  "plan_id": "plan-...",
  "snapshot_revision": 7,
  "stage": "first_contact|qualification|value_fit|invitation|application|signed|paused|human_takeover",
  "opening_candidates": [{"text": "...", "evidence_ids": ["..."]}],
  "avoid": ["unsupported assumption"],
  "turns": [{
    "objective": "verify whether the creator wants help with ...",
    "allowed_evidence_ids": ["..."],
    "success_signal": "creator explicitly confirms ...",
    "next_if_yes": "value_fit",
    "next_if_no": "paused"
  }],
  "consent_checkpoint": "before_formal_invitation",
  "stop_conditions": ["creator says stop", "identity uncertain", "provider result unknown"],
  "estimate": {"p50_turns": 4, "p80_turns": 8, "confidence": 0.42, "basis": ["..."], "calibrated_at": "..."}
}
```

The plan must be regenerated when the evidence revision, relationship revision, consent state, or provider receipt state changes. A stale plan cannot send or schedule an outbound action.

### MemoryCandidate

A model may propose at most 16 candidates per turn. Each candidate has `op`, `memory_id`, `category`, `text` for assertions, and one or more current evidence IDs. Categories are `self_statement`, `self_viewpoint`, `commitment`, and `relationship`. The host rejects unsupported evidence, cross-scope references, duplicate IDs, overlong text, or attempts to mutate identity/boundaries.

## Conversation behavior

The first contact must use one or more specific, source-backed observations and leave room for the creator to correct the interpretation. The planner should prefer a single clear question over a list of claims. The agent moves through small consent-bearing stages:

1. establish relevance from a work or explicit public signal;
2. verify the creator's current interest or goal;
3. explain a guild benefit only when relevant to that goal;
4. answer questions and surface terms transparently;
5. ask permission to send the formal invitation;
6. create an application/signing event only after explicit acceptance and verifiable receipt.

The agent must stop or hand off on rejection, uncertainty, do-not-contact, human takeover, stale evidence, or unknown provider outcome. “Taking control of the conversation” means maintaining an explicit stage and next question, not pressuring the creator or hiding the commercial purpose.

### Broker playbook

The plan must be usable like a mature broker's private deal sheet. It records the current hypothesis about the creator's motivation, the evidence supporting that hypothesis, the next commitment to seek, and the condition that would invalidate it. A plan may choose among these tactics when the evidence supports them:

- **specific opening:** reference one work, format, or stated goal rather than generic praise;
- **calibrated curiosity:** ask one question that lets the creator correct or deepen the picture;
- **controlled disclosure:** reveal only the relevant guild information after the creator signals the matching need;
- **commitment ladder:** move from a small reply, to permission to explain, to permission to send formal terms, to an application;
- **objection loop:** acknowledge the stated concern, clarify the real constraint, answer with verifiable terms, then ask whether the constraint is resolved;
- **pace and space:** use a followup or wait state when immediate pressure would reduce trust;
- **distance and re-entry:** pause or change the angle when the creator's response shows low interest, while retaining the explicit stop boundary.

The planner must never use a hidden pretext, false scarcity, fabricated social proof, emotional dependency, impersonation, or deliberate confusion. “拉扯” is represented as pacing and option management, not withholding material terms or overriding a no. Every planned turn has one primary objective and one observable exit signal; a turn that tries to close without the required permission checkpoint is invalid.

### Sales-stage state machine

The funnel is explicit and reversible:

`first_contact → rapport → discovery → value_fit → objection_handling → permission_to_invite → formal_invite → application → signed`

Any stage may transition to `paused` or `human_takeover`. `signed` requires a verified receipt. `formal_invite` requires the creator's permission to receive terms. `application` requires an explicit application action. A negative or ambiguous response never advances the stage by model confidence alone.

## Learning and calibration

The learning loop has three separately auditable outputs:

- **Memory promotion:** source-backed candidate → accepted/retracted durable memory.
- **Strategy feedback:** plan stage → observed response signal and outcome; no raw model self-approval.
- **Estimate calibration:** predicted turn band compared with actual verified stage transition; aggregate by evidence quality and channel, with minimum sample counts before a strategy is changed.

No single success or failure rewrites the strategy catalog. A later correction always wins over an earlier unsupported hypothesis at the same scope. A strategy with repeated negative consent signals is disabled for that scope and surfaced to an operator.

## Acceptance criteria

- A synthetic creator fixture containing profile metadata, three works, one explicit goal, and one constraint produces a versioned snapshot with source references and no inferred demographics.
- The planner produces an opening, stage sequence, stop conditions, and a P50/P80 estimate; removing or expiring a source removes it from the plan.
- A social turn can commit an accepted relationship memory candidate atomically with the reply/outbox state; replay is idempotent and cross-scope evidence is rejected.
- An explicit creator correction retracts the old memory and appears in the next context; an unverified model assertion does not.
- A followup creates a native scheduled occurrence with a creator-input cancellation condition and is not sent when contact is blocked or receipt state is unknown.
- A verified formal-invitation/application receipt advances the funnel stage; a draft, click, or MCP catalog does not.
- All tests remain offline by default. Live TikTok/TikHub calls require explicit provider configuration and never run in unit or static acceptance suites.
