# Creator Intelligence Conversation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an evidence-backed creator intelligence and broker playbook layer, wire durable memory candidates into native social turns, and connect consented followups to the native scheduler without creating a second business ledger.

**Architecture:** Read-only provider adapters normalize TikHub, crawler, homepage, TKDesk, and creator-message observations into scoped `CreatorEvidence`. A deterministic host planner creates a versioned `CreatorIntelligenceSnapshot` and staged `ConversationPlan` inside the existing `deerflow.social` package; this is not a second agent or ledger. The native social runtime injects the plan beside the resolved persona, so the plan determines grounded content and sales stage while the persona determines expression. Model output may propose bounded memory candidates, but host validation and the existing CAS transaction decide what is persisted. A host-owned followup callback creates a native scheduled occurrence and is cancelled by creator input or contact safety state.

**Tech Stack:** Python 3.11+, dataclasses, SQLAlchemy async persistence, LangChain middleware, pytest, existing scheduled-task repository/service, no new runtime dependency.

**Spec:** `docs/superpowers/specs/2026-10-01-creator-intelligence-conversation-design.md`

## Global Constraints

- DeerFlow native Lead, Gateway, ChannelManager, checkpoint, SocialRepository, and scheduler remain the only business control plane.
- Creator intelligence is a Social Runtime sub-layer and must never become a second Agent, CRM, worker, MCP, or business ledger.
- TikHub/crawler/homepage data is read-only until a provider supplies a scoped, authorized, source-backed record; no raw provider payload enters model context.
- Every material creator fact and strategy claim carries a source reference and freshness/confidence metadata.
- No sensitive demographic or vulnerability inference, hidden pretext, fabricated scarcity, impersonation, or coercive continuation after refusal.
- A positive reply, draft, click, MCP catalog, or model confidence is not a sent message, invitation, application, or signing; only verified provider/human receipt advances those stages.
- Live provider calls remain opt-in; all plan and memory tests use offline fixtures.
- New production behavior follows TDD: each task writes a failing test, observes the failure, implements the smallest change, and runs its focused plus regression tests.

### Task 1: Evidence contracts and deterministic broker planner

**Files:**
- Create: `backend/packages/harness/deerflow/social/intelligence/__init__.py`
- Create: `backend/packages/harness/deerflow/social/intelligence/evidence.py`
- Create: `backend/packages/harness/deerflow/social/intelligence/planner.py`
- Test: `backend/tests/test_social_intelligence.py`
- Modify: `backend/packages/harness/deerflow/social/__init__.py`

**Interfaces:**
- `CreatorEvidence(scope: SocialScope, evidence_id: str, source_kind: str, source_ref: str, captured_at: datetime, expires_at: datetime | None, confidence: float, kind: str, text: str, facts: tuple[tuple[str, str], ...] = ())` validates bounded scope, non-empty source, UTC timestamps, confidence `[0, 1]`, and allowed kinds.
- `CreatorIntelligenceSnapshot(scope: SocialScope, revision: int, identity: tuple[CreatorEvidence, ...], works: tuple[CreatorEvidence, ...], signals: tuple[CreatorEvidence, ...], open_questions: tuple[str, ...], evidence_refs: tuple[str, ...], freshness: str)` is immutable and rejects cross-scope or expired evidence.
- `ConversationStage` contains `first_contact`, `rapport`, `discovery`, `value_fit`, `objection_handling`, `permission_to_invite`, `formal_invite`, `application`, `signed`, `paused`, and `human_takeover`.
- `ConversationPlan(plan_id: str, snapshot_revision: int, stage: ConversationStage, opening_candidates: tuple[dict, ...], avoid: tuple[str, ...], turns: tuple[dict, ...], consent_checkpoint: str, stop_conditions: tuple[str, ...], estimate: dict)` is immutable and bounded.
- `build_snapshot(scope, evidence, revision)` returns a snapshot after dropping expired observations and rejecting duplicate IDs or cross-scope evidence.
- `plan_conversation(snapshot, *, stage, relationship_signals=(), goal=None)` returns a deterministic plan that cites only snapshot evidence, provides one objective per turn, and returns `p50_turns`, `p80_turns`, `confidence`, and `basis`.
- `CreatorEvidenceProvider` is a `Protocol` with `async collect(scope, *, creator_ref: str) -> tuple[CreatorEvidence, ...]`; adapters are not implemented against live credentials in this task.
- The package is imported by `deerflow.social.runtime`; its output is injected beside `EffectivePersona`, never exposed as a separate agent/tool surface.

- [ ] **Step 1: Write failing contract tests**

Add tests for valid TikHub/work/page records, expired evidence exclusion, cross-scope rejection, evidence reference coverage, stage transitions, explicit consent checkpoints, stop conditions, and a plan whose opening candidates cite real works.

```python
def test_plan_uses_current_work_and_stops_before_invite_without_consent():
    snapshot = build_snapshot(SCOPE, (WORK, PROFILE), revision=3)
    plan = plan_conversation(snapshot, stage=ConversationStage.discovery, goal="了解是否愿意听公会方案")
    assert plan.opening_candidates[0]["evidence_ids"] == (WORK.evidence_id,)
    assert plan.consent_checkpoint == "before_formal_invitation"
    assert "creator says stop" in plan.stop_conditions
    assert plan.estimate["p50_turns"] >= 1
```

Run: `backend/.venv/bin/pytest -q tests/test_social_intelligence.py`
Expected: FAIL because the package and contracts do not exist.

- [ ] **Step 2: Implement the bounded evidence and planner contracts**

Create the dataclasses, protocol, stage enum, snapshot normalizer, and planner. The deterministic planner should select up to three newest non-expired work/profile evidence records, generate one opening per selected work, use `open_questions` for missing creator goals, and set `p50_turns=4`, `p80_turns=8` with confidence `0.35` when no verified response history exists. It must set stage-specific objectives and never produce an invitation objective before `permission_to_invite`.

- [ ] **Step 3: Run focused and style checks**

Run: `backend/.venv/bin/pytest -q tests/test_social_intelligence.py` and `backend/.venv/bin/ruff check packages/harness/deerflow/social/intelligence packages/harness/deerflow/social/__init__.py tests/test_social_intelligence.py`.
Expected: all tests pass and ruff reports no violations.

- [ ] **Step 4: Commit**

```bash
git add backend/packages/harness/deerflow/social/intelligence backend/packages/harness/deerflow/social/__init__.py backend/tests/test_social_intelligence.py
git commit -m "feat: add evidence-backed creator conversation planner"
```

### Task 2: Wire durable memory candidates into native social turns

**Files:**
- Modify: `backend/packages/harness/deerflow/social/contracts.py`
- Modify: `backend/packages/harness/deerflow/social/turns.py`
- Modify: `backend/packages/harness/deerflow/social/runtime.py`
- Modify: `backend/packages/harness/deerflow/persistence/social/model.py`
- Modify: `backend/packages/harness/deerflow/persistence/social/sql.py`
- Test: `backend/tests/test_social_contracts.py`
- Test: `backend/tests/test_social_repository.py`
- Test: `backend/tests/test_social_lead_runtime.py`

**Interfaces:**
- `MemoryCandidate(op, memory_id, category, evidence_ids, text=None)` lives in `social.contracts`; it validates the same four categories and bounds as `SelfMemoryChange` without importing persistence.
- `TurnResult` gains `memory_delta: tuple[MemoryCandidate, ...] = ()` after `followup`; existing positional calls remain valid.
- `parse_turn_result` accepts only the additional top-level field `memory_delta`, parses at most 16 candidates, and rejects unknown fields, empty evidence, or duplicate IDs.
- `commit_turn(repository, snapshot, *, event_id, result)` converts `result.memory_delta` to host-owned `SelfMemoryChange` and passes it to the existing atomic `SocialRepository.commit_turn` call.
- `TURN_OUTPUT_PROMPT` documents `memory_delta` as optional, evidence-backed, and never authoritative for identity, boundaries, or platform receipts.

- [ ] **Step 1: Write failing parser and commit tests**

Add one parser test for an asserted relationship candidate, one rejection test for missing evidence, one repository test proving the candidate is committed atomically with the outbound, one replay test proving no duplicate mutation, and one cross-scope evidence test proving the transaction fails closed.

```python
def test_turn_result_parses_evidence_backed_memory_delta():
    result = parse_turn_result('{"reply":"收到","state_delta":[],"memory_delta":[{"op":"assert","memory_id":"pref:short","category":"relationship","evidence_ids":["creator:1"],"text":"对方偏好简短回复"}]}')
    assert result.memory_delta[0].category == "relationship"
```

Run: `backend/.venv/bin/pytest -q tests/test_social_contracts.py tests/test_social_repository.py::test_memory_delta_is_atomic`
Expected: FAIL because `memory_delta` is not accepted.

- [ ] **Step 2: Implement the contract and host conversion**

Add `MemoryCandidate`, extend `TurnResult`, update the parser, and convert candidates only inside `turns.commit_turn`. Preserve the existing repository validation so evidence must already belong to the scoped event/boundary history. Do not let model output call `set_boundaries` or mutate identity.

- [ ] **Step 3: Add Lead prompt and middleware wiring**

Update `TURN_OUTPUT_PROMPT`, the real Lead runtime tests, and the social middleware commit path. Add a regression proving a memory candidate appears in the next restored `SocialContextSnapshot` and that malformed model output produces no outbound or memory write.

- [ ] **Step 4: Run focused regression checks**

Run: `backend/.venv/bin/pytest -q tests/test_social_contracts.py tests/test_social_repository.py tests/test_social_lead_runtime.py` and `backend/.venv/bin/ruff check packages/harness/deerflow/social backend/packages/harness/deerflow/persistence/social tests/test_social_contracts.py tests/test_social_repository.py tests/test_social_lead_runtime.py`.
Expected: all selected tests pass.

- [ ] **Step 5: Commit**

```bash
git add backend/packages/harness/deerflow/social backend/packages/harness/deerflow/persistence/social backend/tests/test_social_contracts.py backend/tests/test_social_repository.py backend/tests/test_social_lead_runtime.py
git commit -m "feat: persist evidence-backed social memory candidates"
```

### Task 3: Inject creator intelligence and persist the sales stage

**Files:**
- Modify: `backend/packages/harness/deerflow/social/context.py`
- Modify: `backend/packages/harness/deerflow/social/runtime.py`
- Modify: `backend/packages/harness/deerflow/social/persistence/model.py` if a separate module is needed; otherwise use the existing JSON projection in `backend/packages/harness/deerflow/persistence/social/model.py`
- Modify: `backend/app/channels/social.py`
- Modify: `backend/app/channels/manager.py`
- Test: `backend/tests/test_social_lead_runtime.py`
- Test: `backend/tests/test_social_channels.py`

**Interfaces:**
- `SocialRuntimeBinding` gains optional host-owned `creator_evidence: tuple[CreatorEvidence, ...] = ()` and `conversation_goal: str | None = None`; client context cannot construct or override these values.
- `SocialContextSnapshot` gains optional `conversation_plan: ConversationPlan | None = None` after existing fields, preserving existing positional constructors.
- `build_social_context_data` serializes a bounded `conversation_plan` block with stage, opening candidates, current objective, evidence IDs, stop conditions, and estimate; it must not include raw provider payloads.
- `SocialRepository` projection stores `conversation_stage` and `conversation_plan` as JSON in the existing snapshot column; restore returns them and `commit_turn` preserves them.
- `advance_conversation_stage(scope, *, expected_revision, target_stage, evidence_ids, reason)` is host-only, validates monotonic/allowed transitions, and refuses `formal_invite`, `application`, or `signed` unless the required consent/receipt evidence is present.

- [ ] **Step 1: Write failing context and stage tests**

Add tests proving a binding with three works injects a plan with work evidence, stale evidence is omitted, the plan is bounded in context, a stage transition requires evidence, and a draft or model confidence cannot produce `signed`.

- [ ] **Step 2: Implement binding/context integration**

Build the planner from host-owned evidence during `SocialRuntime.restore_context`, add the plan to the immutable snapshot and bounded data payload, and preserve it through CAS commits. Keep all raw TikHub/crawler payloads outside the model context.

- [ ] **Step 3: Implement stage transitions**

Add the host repository transition method and use it only from authenticated provider/management call sites. Update the social connection value and ChannelManager construction so an optional evidence resolver can provide already-normalized records; absence of a resolver keeps the current safe behavior with no plan.

- [ ] **Step 4: Run focused tests**

Run: `backend/.venv/bin/pytest -q tests/test_social_lead_runtime.py tests/test_social_channels.py tests/test_social_intelligence.py` and the corresponding ruff checks.
Expected: all selected tests pass.

- [ ] **Step 5: Commit**

```bash
git add backend/packages/harness/deerflow/social backend/packages/harness/deerflow/persistence/social backend/app/channels/social.py backend/app/channels/manager.py backend/tests/test_social_lead_runtime.py backend/tests/test_social_channels.py
git commit -m "feat: inject creator intelligence and sales stages"
```

### Task 4: Connect consented followups to the native scheduler

**Files:**
- Create: `backend/app/scheduler/social_followups.py`
- Modify: `backend/packages/harness/deerflow/social/runtime.py`
- Modify: `backend/app/channels/social.py`
- Modify: `backend/app/channels/service.py`
- Modify: `backend/app/channels/manager.py`
- Modify: `backend/app/gateway/app.py`
- Test: `backend/tests/test_social_scheduler.py`
- Test: `backend/tests/test_social_channels.py`

**Interfaces:**
- `SocialFollowupScheduler.schedule(scope, *, thread_id, followup, expected_revision, cancel_event_id) -> str` creates a native one-time scheduled task with owner, thread, prompt, and `scheduled_task_id` metadata; duplicate `(scope, expected_revision)` requests return the existing task ID.
- `SocialFollowupScheduler.cancel_for_creator_event(scope, event_id)` cancels queued/launching occurrences through `ScheduledTaskRepository`, never cancels a running run, and records a host-owned cancellation reason.
- `SocialRuntimeBinding` gains optional `schedule_followup` callback, supplied only by Gateway/ChannelManager host wiring. Tests may omit it; in that case the followup remains durable but is not dispatched.
- `SocialTurnMiddleware` invokes the callback only after the social commit succeeds, and only when the snapshot is not blocked and the followup has a valid future `not_before` or an explicit scheduler default.

- [ ] **Step 1: Write failing scheduler tests**

Add tests for one-time task creation, idempotent replay, cancellation on a new creator event, no scheduling while `do_not_contact`/human takeover/unknown receipt is active, and no cancellation of a running scheduled occurrence.

```python
async def test_followup_replay_returns_same_native_task_id():
    first = await scheduler.schedule(SCOPE, thread_id="thread-1", followup=FOLLOWUP, expected_revision=4, cancel_event_id="event-4")
    second = await scheduler.schedule(SCOPE, thread_id="thread-1", followup=FOLLOWUP, expected_revision=4, cancel_event_id="event-4")
    assert second == first
```

Run: `backend/.venv/bin/pytest -q tests/test_social_scheduler.py`
Expected: FAIL because the adapter does not exist.

- [ ] **Step 2: Implement the scheduler adapter**

Use the existing `ScheduledTaskRepository` and status vocabulary. Store a prompt containing only bounded scope references and the followup check; never include raw provider content or credentials. Use native queue cancellation for queued occurrences and return `running` when cancellation would race an active run.

- [ ] **Step 3: Wire host callback**

Thread the scheduler callback from `app.py` through `start_channel_service`, `ChannelService`, `ChannelManager`, `SocialConnection`, and `SocialRuntimeBinding`. Keep direct test construction safe by defaulting to `None`. On a new creator event, cancel the previous followup before launching a new social turn.

- [ ] **Step 4: Run scheduler and regression tests**

Run: `backend/.venv/bin/pytest -q tests/test_social_scheduler.py tests/test_social_channels.py tests/test_social_lead_runtime.py tests/test_scheduled_task_postgres.py` with the normal SQLite suite and the opt-in PostgreSQL URI. Expected: all selected tests pass; no external provider is contacted.

- [ ] **Step 5: Commit**

```bash
git add backend/app/scheduler/social_followups.py backend/packages/harness/deerflow/social/runtime.py backend/app/channels/social.py backend/app/channels/service.py backend/app/channels/manager.py backend/app/gateway/app.py backend/tests/test_social_scheduler.py backend/tests/test_social_channels.py
git commit -m "feat: schedule consented social followups natively"
```

### Task 5: Evaluation fixtures, docs, and ledger reconciliation

**Files:**
- Create: `backend/tests/fixtures/social_intelligence/creator_001.json`
- Create: `backend/tests/fixtures/social_intelligence/creator_002.json`
- Create: `backend/scripts/benchmark/social_preflight/intelligence_cases.py`
- Modify: `backend/scripts/benchmark/social_preflight/runner.py`
- Modify: `docs/verification/creator-agent/2026-09-30-model-preflight.md`
- Modify: `.agents/ledger/2026-09-24-deerflow-social-runtime.md`
- Modify: `README.md`
- Test: `backend/tests/test_social_preflight.py`

**Interfaces:**
- Fixtures contain only synthetic/public-like text and explicit source IDs; they never contain credentials or real creator identifiers.
- The preflight report adds `intelligence_snapshot_revision`, `plan_stage`, `estimate`, `memory_promotions`, and `verified_funnel_stage` without claiming live conversion.

- [ ] **Step 1: Write failing benchmark assertions**

Add an offline preflight case proving the same synthetic creator's second turn loads the first accepted memory, changes the plan stage, and refuses formal invitation before consent.

- [ ] **Step 2: Extend the offline benchmark**

Run both fixtures through planner, social runtime, memory commit, stage transition, and followup cancellation. Keep `--live` opt-in and preserve the existing no-retry/max-call boundary.

- [ ] **Step 3: Update user-facing docs and ledger**

Document the new creator intelligence flow, the evidence/consent boundary, the meaning of P50/P80 turn estimates, and the remaining phone/provider/customer-install gaps. Record any implementation ruling in `.agents/coordination.md` and update the single ledger; do not create a second task ledger.

- [ ] **Step 4: Run final verification**

Run focused social tests, blocking-I/O tests, ops tests, ruff checks, and the existing non-live backend suite. Report full-suite environment/upstream failures separately from this feature.

- [ ] **Step 5: Commit**

```bash
git add backend/tests/fixtures/social_intelligence backend/scripts/benchmark/social_preflight docs/verification/creator-agent/2026-09-30-model-preflight.md .agents/ledger/2026-09-24-deerflow-social-runtime.md .agents/coordination.md README.md backend/tests/test_social_preflight.py
git commit -m "docs: record creator intelligence evaluation boundary"
```
