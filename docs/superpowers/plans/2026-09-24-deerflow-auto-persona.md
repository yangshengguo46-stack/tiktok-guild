# DeerFlow Auto Persona Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve the existing guild workbench while the default DeerFlow Lead automatically resolves one evidence-based persona for the focused creator without routine operator switching.

**Architecture:** Start from the pinned upstream DeerFlow checkout with only the existing guild workbench UI restored. Register the six immutable PERSONA-REV1 assets, create a fresh `deerflow.creator_agent` runtime and same-database relationship store, and refresh one relation-scoped AI persona decision only when sourced evidence changes. The host validates model JSON and applies a compare-and-swap transaction before injecting one resolved persona plus its fingerprint into the real model request.

**Tech Stack:** Node.js package/bootstrap tests, Python 3.12, LangChain middleware, SQLAlchemy/Alembic, pytest, DeerFlow cumulative Git patch.

**Spec:** `docs/superpowers/specs/2026-09-24-deerflow-auto-persona-design.md`

## Global Constraints

- One DeerFlow runtime and the same default Lead; do not add a second service, Worker, Rust bridge, independent ledger, CRM, or six permanent persona agents.
- All prior backend recruitment, relationship-summary, method-card, channel-provenance, and conversation-plan implementations are obsolete; preserve only `/workspace/guild`, its navigation order, translations, and honest unavailable state.
- Do not import or extend obsolete `deerflow.recruitment` or `guild_creator_context` code; the active implementation lives under `deerflow.creator_agent` and a fresh migration.
- TKDesk owns candidate facts and Guild Operator owns guild backend facts; relationship notes and persona decisions are not platform truth.
- Real TikTok receive, send, invitation, and receipt capabilities remain unverified and must not be claimed or invoked.
- Automatic decisions write only the current `(operator, stable guild id, TikTok creator uid)` relation scope; identity, history, commitments, permissions, and no-contact state never change with persona.
- New relationships default to `relaxed_wit@1.0.1`; a switch requires a valid current-scope creator source reference and `confidence >= 0.75`.
- Selection failures and CAS conflicts keep the current/default persona and do not block ordinary Lead execution.
- Production changes follow test-first RED/GREEN cycles and end in one reproducible cumulative patch against DeerFlow commit `769589e8daee14c2587a634b6b43bd96471a41a1`.

---

### Task 1: Versioned persona catalog and deterministic resolver

**Files:**
- Create: `config/personas.json`
- Create: `.runtime/deer-flow/backend/packages/harness/deerflow/creator_agent/personas.py`
- Create: `.runtime/deer-flow/backend/tests/test_creator_agent_personas.py`

**Interfaces:**
- Consumes: `DEER_FLOW_GUILD_PERSONAS_PATH` containing six version `1.0.1` persona objects.
- Produces: `load_personas(path: str | None) -> dict[str, PersonaAsset]`, `resolve_persona(catalog, stored_state, *, scope, context_version) -> dict`, and `effective_persona_fingerprint(snapshot: dict) -> str`.

- [x] **Step 1: Write failing tests for exact six-asset loading, unknown IDs, default resolution, one-persona rendering, immutable input, and scope/revision-sensitive fingerprints.**
- [x] **Step 2: Run `cd .runtime/deer-flow/backend && uv run pytest tests/test_creator_agent_personas.py -q` and confirm failures name missing persona interfaces.**
- [x] **Step 3: Implement strict bounded catalog validation and pure resolution/fingerprint functions; persona content stays separate from identity and permission data.**
- [x] **Step 4: Re-run the focused pytest and confirm the new resolver cases pass.**

### Task 2: Relation-scoped persona CAS persistence

**Files:**
- Create: `.runtime/deer-flow/backend/packages/harness/deerflow/persistence/creator_agent_relationship/__init__.py`
- Create: `.runtime/deer-flow/backend/packages/harness/deerflow/persistence/creator_agent_relationship/model.py`
- Create: `.runtime/deer-flow/backend/packages/harness/deerflow/persistence/creator_agent_relationship/sql.py`
- Create: `.runtime/deer-flow/backend/packages/harness/deerflow/persistence/migrations/versions/0025_creator_agent_relationship.py`
- Modify: `.runtime/deer-flow/backend/packages/harness/deerflow/persistence/models/__init__.py`
- Create: `.runtime/deer-flow/backend/tests/test_creator_agent_relationship.py`

**Interfaces:**
- Consumes: sourced relationship events and a validated decision with `persona_ref`, `evaluated_evidence_version`, `policy_version`, evidence refs, reason, confidence, and fingerprint inputs.
- Produces: `CreatorAgentRelationshipRepository.record_evidence(...)`, `apply_persona_decision(..., expected_evidence_version: int, expected_persona_revision: int, decision: dict) -> dict`, and `get()` snapshots containing bounded relationship data, `persona_revision`, and `persona_state`.

- [x] **Step 1: Write failing repository tests for default null state, successful CAS, duplicate idempotency, stale context rejection, stale persona revision rejection, scope isolation, persistence after restart, and relationship facts remaining unchanged.**
- [x] **Step 2: Run the focused pytest and confirm the failures come from missing columns/methods.**
- [x] **Step 3: Add the 0025 migration, mapped fields, bounded semantic validation, and a single conditional SQL update that checks both context and persona revisions.**
- [x] **Step 4: Re-run repository tests and confirm all cases pass.**

### Task 3: Fresh CreatorAgent runtime, AI selector, and model-request integration

**Files:**
- Create: `.runtime/deer-flow/backend/packages/harness/deerflow/creator_agent/__init__.py`
- Create: `.runtime/deer-flow/backend/packages/harness/deerflow/creator_agent/state.py`
- Create: `.runtime/deer-flow/backend/packages/harness/deerflow/creator_agent/tools.py`
- Create: `.runtime/deer-flow/backend/packages/harness/deerflow/creator_agent/persona_selector.py`
- Create: `.runtime/deer-flow/backend/packages/harness/deerflow/creator_agent/middleware.py`
- Create: `.runtime/deer-flow/backend/packages/harness/deerflow/creator_agent/runtime.py`
- Modify: `.runtime/deer-flow/backend/packages/harness/deerflow/agents/lead_agent/agent.py`
- Create: `.runtime/deer-flow/backend/tests/test_creator_agent_runtime.py`

**Interfaces:**
- Consumes: Task 1 catalog/resolver and Task 2 repository CAS; `middlewares_for_lead(app_config, model_name)` receives the actual Lead model configuration.
- Produces: `creator_agent_focus`, `creator_agent_brief`, and `creator_agent_record` tools; one bounded no-stream selector call for each unseen evidence version; validated `stay|switch` decisions; and a single `<creator-agent-persona>` system section containing the active asset, revision, source, and fingerprint.

- [x] **Step 1: Write failing tests with a deterministic fake chat model for valid switch, low-confidence stay, missing/cross-scope evidence rejection, malformed JSON fail-closed, no repeated selector call at the same context version, CAS conflict reload, no-focus default behavior, and no-contact precedence.**
- [x] **Step 2: Run the focused pytest and confirm expected behavioral failures.**
- [x] **Step 3: Implement the strict JSON decision parser, allowed evidence extraction, sensitive/occupational anti-targeting instruction, lazy no-stream selector model, and repository refresh.**
- [x] **Step 4: Inject only the resolved active persona and current relationship data into `ModelRequest`; include its fingerprint in the brief without exposing operator-scoped tools to unverified external channels.**
- [x] **Step 5: Run the focused pytest, then the related provenance/agent assembly tests.**

### Task 4: Package, document, and verify the cumulative product

**Files:**
- Modify: `config/guild-soul.md`
- Modify: `scripts/start.mjs`
- Modify: `scripts/doctor.mjs`
- Modify: `src/guild-soul.mjs`
- Modify: `test/doctor.test.mjs`
- Modify: `test/guild-soul.test.mjs`
- Modify: `test/acceptance.test.mjs`
- Modify: `test/product-patches.test.mjs`
- Modify: `README.md`
- Modify: `docs/audits/2026-09-23-deerflow-guild-migration-audit.md`
- Modify: `patches/0001-feat-add-guild-workbench.patch`

**Interfaces:**
- Consumes: the tested runtime diff from Tasks 1–3.
- Produces: `DEER_FLOW_GUILD_PERSONAS_PATH`, doctor catalog validation, one cumulative patch that applies to the fixed DeerFlow commit, and an honest current capability statement.

- [x] **Step 1: Add failing Node tests that require the persona catalog environment and the new runtime/migration/test surfaces in the cumulative patch while retaining workbench assertions.**
- [x] **Step 2: Run `npm test` and confirm those tests fail before package wiring.**
- [x] **Step 3: Wire the catalog path, doctor validation, one-time migration from the exact old managed business-first SOUL to the constant social kernel (without overwriting user-custom SOUL content), README/audit status, and regenerate the single cumulative patch from the pinned runtime checkout while retaining only the prior workbench UI plus the new CreatorAgent implementation; obsolete provenance, context, and recruitment backends must not reappear.**
- [x] **Step 4: Rebuild a clean pinned checkout or use forward/reverse apply checks to prove the cumulative patch is reproducible.**
- [x] **Step 5: Run focused backend pytest, `npm test`, `npm run doctor`, and `npm run acceptance`; record exact pass/fail evidence and keep real TikTok receive/send marked unverified.**

## Deferred roadmap — do not block the current main build

The user wants a later communication-intelligence layer that goes beyond selecting one of six personas:

- a versioned persona/communication knowledge library containing reusable conversation instincts, topic transitions, pacing patterns, boundary handling, and examples;
- pre-contact interpretation of an authenticated creator profile and its sourced public material, producing hypotheses about useful topics and a tentative conversation rhythm before the first message;
- continued adaptation from the creator's actual replies so the initial profile-based hypothesis can be corrected rather than hardened into a label;
- retrieval into the current Lead as bounded, sourced guidance rather than a second runtime, permanent persona agents, fixed scripts, or an automatic-send pipeline.

This is explicitly deferred until the current CreatorAgent main body and its real channel provenance are complete. Profile signals remain low-trust hypotheses: they must not infer personality from occupation, gender, income, audience size, response speed, or vulnerability, and they must not authorize contact or sending.
