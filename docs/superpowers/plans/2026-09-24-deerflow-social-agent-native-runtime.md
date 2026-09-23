# DeerFlow Social Agent Native Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn this repository into the maintained DeerFlow fork and implement the approved CreatorAgent FINAL / PERSONA-REV1 social-agent runtime in the native Lead, ThreadState, persistence, memory, and channel loop.

**Architecture:** The repository root becomes a real fork whose history descends from DeerFlow `769589e8daee14c2587a634b6b43bd96471a41a1`; the current patch overlay is used only to create the first fork commit and is then retired. A native `deerflow.social` domain package owns typed identity, self, relationship, persona, turn-context, memory, and action contracts, while the existing Lead, ThreadState, persistence engine, and ChannelManager call those contracts directly. There is one Lead and one database; Guild Operator and TKDesk remain external business tools.

**Tech Stack:** Python 3.12, LangGraph/LangChain agent middleware, Pydantic/dataclasses, SQLAlchemy/Alembic, FastAPI Gateway channels, pytest/pytest-asyncio, Node.js doctor/bootstrap tests, Next.js workbench.

**Spec:** `/Users/yangyucheng/Downloads/CreatorAgent_FINAL_PERSONA_REV1_20260924.zip`, `/Users/yangyucheng/.codex/attachments/647efbc4-3a38-431a-a1f6-0ca6c019154d/已粘贴的文本.txt`, `docs/superpowers/specs/2026-09-24-deerflow-auto-persona-design.md`, and `.agents/ledger/2026-09-24-deerflow-social-runtime.md`.

## Global Constraints

- The current repository root becomes the DeerFlow fork and unique source of product code. Do not keep `.runtime/deer-flow` or a cumulative patch as the maintained implementation.
- Preserve only the prior `/workspace/guild` route, navigation, translations, tests, and honest unavailable state from older product work. Do not reintroduce `deerflow.recruitment`, `guild_creator_context`, method cards, an old Worker, a Rust bridge, or an independent business ledger.
- Preserve Phase 0 behavior: six exact `1.0.1` persona assets, one active persona per model request, effective fingerprint equality, relation-scope isolation, evidence/persona double CAS, idempotency, winner reload, no-contact precedence, and selector fail-closed behavior.
- PERSONA-REV1 remains authoritative, with these later user corrections: routine persona selection is automatic from sourced communication evidence; operator binding/rollback is an administrative override, not a required per-conversation action; Agent/subagent override is nullable; no persona-specific subagents are created.
- A concrete social self is assembled from trusted Identity, persistent Self Memory, Role, Relationship, EffectivePersona, and TurnContext. Persona changes do not rewrite identity, history, viewpoints, commitments, permissions, or prior messages.
- The first native loop is `external event -> restore social context -> Lead/tool loop -> TurnResult -> atomic commit -> reply or wait`. `TurnResult.reply = null` with a follow-up is `wait`; `reply = null` without a follow-up is `no_reply`.
- Social mode must buffer model output until validation and commit. It must not leak partial streaming text or replace intentional silence with `(No response from agent)`.
- Real TikTok inbound identity, outbound send, invitation, and delivery receipts remain unverified. No test, fixture, MCP connection, or generic channel publish may be described as a successful TikTok action.
- World/profile knowledge-library depth, automatic creator-homepage analysis, proactive scheduling, candidate comparison, Jev advisory, and optional subagent context propagation are outside this main-body plan. Keep compatible seams but do not delay the vertical loop for them.
- All production changes follow RED/GREEN TDD. Read every applicable `AGENTS.md` before editing its subtree.
- Preserve the current SQLite database and custom `SOUL.md`. Before checkout migration, create recoverable backups and verify Alembic revision, table set, row counts, and representative CreatorAgent reads before and after cutover.

## Work Graph

```text
Task 1 fork migration
  -> Task 2 approved assets/contracts
      -> Task 3 native social state/context
      -> Task 4 persona profiles/automatic resolution
      -> Task 5 social persistence/memory
          -> Task 6 Lead TurnResult loop
          -> Task 7 authenticated channel gate/outbox
      -> Task 8 management Chat/profile generation
  -> Task 9 ops/workbench/evaluation
  -> Task 10 cutover and whole-product verification
```

Tasks 3, 4, and 5 have disjoint production file ownership after Task 2 and may run in parallel. Tasks 6, 7, and 8 start only after their declared inputs are committed.

---

### Task 1: Convert the repository into the real DeerFlow fork

**Files:**
- Preserve in fork: `.agents/coordination.md`
- Preserve in fork: `.agents/ledger/2026-09-24-deerflow-social-runtime.md`
- Preserve in fork: `docs/superpowers/specs/2026-09-24-deerflow-auto-persona-design.md`
- Preserve in fork: `docs/superpowers/plans/2026-09-24-deerflow-social-agent-native-runtime.md`
- Create in fork: `ops/guild-runtime/`
- Retire after verification: `patches/0001-feat-add-guild-workbench.patch`
- Retire after verification: `src/product-patches.mjs`

**Interfaces:**
- Consumes: outer repository `master`, the local DeerFlow object store at `.runtime/deer-flow.previous-20260924`, fixed upstream commit `769589e8daee14c2587a634b6b43bd96471a41a1`, and the exact cumulative patch SHA-256 `ff7af8107fec76ac18979c625acd230fe38043d4c4288f09f5261e6d52d77e32`.
- Produces: branch `codex/deerflow-social-runtime` rooted in upstream DeerFlow, with the current workbench and CreatorAgent Phase 0 committed as ordinary source plus the previous project history retained as a merge parent.

- [ ] **Step 1: Record a non-destructive migration snapshot**

Run:

```bash
git status --short --branch
git rev-parse HEAD
shasum -a 256 patches/0001-feat-add-guild-workbench.patch
git -C .runtime/deer-flow rev-parse HEAD
git -C .runtime/deer-flow diff --binary HEAD | cmp - patches/0001-feat-add-guild-workbench.patch
git -C .runtime/deer-flow rev-parse --git-common-dir
sqlite3 .runtime/deer-flow/backend/.deer-flow/data/deerflow.db 'PRAGMA user_version; SELECT version_num FROM alembic_version; SELECT count(*) FROM creator_agent_relationship;'
```

Expected: outer HEAD is the latest ledger commit; patch hash is the approved hash; the diff comparison exits `0`; DeerFlow HEAD is the fixed upstream SHA; the SQLite query succeeds or reports that the relationship table is absent without mutating the file.

- [ ] **Step 2: Create recoverable data and custom-SOUL backups**

Run:

```bash
migration_backup=$(mktemp -d /tmp/deerflow-social-migration.XXXXXX)
cp -p .runtime/deer-flow/backend/.deer-flow/data/deerflow.db "$migration_backup/deerflow.db"
cp -p .runtime/deerflow-home/SOUL.md "$migration_backup/SOUL.md"
shasum -a 256 "$migration_backup/deerflow.db" "$migration_backup/SOUL.md"
```

Expected: two explicit backup paths and hashes are recorded in the task report. Do not remove either existing runtime directory.

- [ ] **Step 3: Import the upstream commit into the current Git object database and create an isolated worktree**

Run:

```bash
git fetch .runtime/deer-flow.previous-20260924 769589e8daee14c2587a634b6b43bd96471a41a1
git worktree add /tmp/deerflow-social-runtime -b codex/deerflow-social-runtime FETCH_HEAD
git -C /tmp/deerflow-social-runtime rev-parse HEAD
```

Expected: the new worktree HEAD equals `769589e8daee14c2587a634b6b43bd96471a41a1`; the current checkout remains on `master`.

- [ ] **Step 4: Apply Phase 0 as ordinary fork source and prove tree equality**

Run:

```bash
git -C /tmp/deerflow-social-runtime apply --check "$PWD/patches/0001-feat-add-guild-workbench.patch"
git -C /tmp/deerflow-social-runtime apply "$PWD/patches/0001-feat-add-guild-workbench.patch"
git -C /tmp/deerflow-social-runtime diff --binary HEAD | cmp - "$PWD/patches/0001-feat-add-guild-workbench.patch"
git -C /tmp/deerflow-social-runtime diff --check
```

Expected: every command exits `0`; scans for `deerflow.recruitment`, `guild_creator_context`, and `0025_guild_creator_context` return no active source hit.

- [ ] **Step 5: Commit the fork baseline and retain the outer history as a parent without importing its root tree**

Run:

```bash
git -C /tmp/deerflow-social-runtime add backend frontend
git -C /tmp/deerflow-social-runtime commit -m "feat: establish guild DeerFlow fork baseline"
git -C /tmp/deerflow-social-runtime merge --allow-unrelated-histories -s ours master -m "chore: preserve pre-fork project history"
```

Expected: `git merge-base --is-ancestor 769589e8daee14c2587a634b6b43bd96471a41a1 codex/deerflow-social-runtime` and `git merge-base --is-ancestor master codex/deerflow-social-runtime` both exit `0`.

- [ ] **Step 6: Import the wrapper as inactive `ops/guild-runtime` material and copy the active coordination/spec files to the fork root**

Run from the original project root:

```bash
outer_snapshot=$(mktemp -d /tmp/guild-outer-snapshot.XXXXXX)
git archive master config fixtures scripts src test package.json package-lock.json README.md | tar -x -C "$outer_snapshot"
mkdir -p /tmp/deerflow-social-runtime/ops/guild-runtime
rsync -a "$outer_snapshot/" /tmp/deerflow-social-runtime/ops/guild-runtime/
git archive master .agents docs/superpowers | tar -x -C /tmp/deerflow-social-runtime
```

Do not copy `.runtime`, `node_modules`, the cumulative patch, or older obsolete backend sources.

Expected tree:

```text
/tmp/deerflow-social-runtime/
  backend/
  frontend/
  ops/guild-runtime/{config,fixtures,scripts,src,test,package.json,package-lock.json,README.md}
  .agents/
  docs/superpowers/
```

- [ ] **Step 7: Commit and verify the topology**

Run:

```bash
git -C /tmp/deerflow-social-runtime add .agents docs/superpowers ops/guild-runtime
git -C /tmp/deerflow-social-runtime commit -m "chore: move guild runtime operations into DeerFlow fork"
git -C /tmp/deerflow-social-runtime status --short
```

Expected: clean fork worktree; the current master checkout and its runtime remain untouched.

---

### Task 2: Import the approved FINAL / PERSONA-REV1 assets and native contracts

**Files:**
- Create: `docs/product/creator-agent-final-persona-rev1/`
- Create: `backend/packages/harness/deerflow/social/__init__.py`
- Create: `backend/packages/harness/deerflow/social/contracts.py`
- Create: `backend/packages/harness/deerflow/social/assets.py`
- Create: `backend/packages/harness/deerflow/social/persona/models.py`
- Create: `backend/packages/harness/deerflow/social/persona/__init__.py`
- Create: `backend/tests/test_social_assets.py`
- Create: `backend/tests/test_social_contracts.py`

**Interfaces:**
- Consumes: the exact archive and its `MANIFEST.json` hashes.
- Produces: `SocialScope`, `ProfileScope`, `IdentityProfile`, `RoleProfile`, `ClaimPatch`, `FollowUp`, `TurnResult`, `SocialAction`, `PersonaProfile`, `PersonaBindings`, `EffectivePersona`, and `load_social_assets()`.

- [ ] **Step 1: Copy the complete approved package into the fork docs and verify every manifest hash**

Extract the archive into `docs/product/creator-agent-final-persona-rev1/` with the top archive directory stripped. Add `scripts/verify_creator_agent_assets.py` that reads `MANIFEST.json`, rejects missing/extra declared files, and checks every SHA-256 before runtime assets are packaged.

- [ ] **Step 2: Write failing contract tests**

```python
def test_turn_result_distinguishes_reply_wait_and_no_reply():
    assert TurnResult(reply="hello").action is SocialAction.REPLY
    assert TurnResult(reply=None, followup=FollowUp(check="recheck", cancel_when="creator replies")).action is SocialAction.WAIT
    assert TurnResult(reply=None).action is SocialAction.NO_REPLY


def test_scope_requires_authenticated_owner_and_stable_relation():
    with pytest.raises(ValueError):
        SocialScope(owner_user_id="", account_id="guild", person_ref="creator", channel_thread_ref="dm")
```

- [ ] **Step 3: Run the tests and confirm RED**

Run: `cd backend && uv run pytest tests/test_social_assets.py tests/test_social_contracts.py -q`

Expected: collection fails because `deerflow.social` contracts do not exist.

- [ ] **Step 4: Implement strict bounded contracts**

```python
class SocialAction(StrEnum):
    REPLY = "reply"
    WAIT = "wait"
    NO_REPLY = "no_reply"


@dataclass(frozen=True)
class SocialScope:
    owner_user_id: str
    account_id: str
    person_ref: str
    channel_thread_ref: str
    agent_instance_id: str = "lead_agent"


@dataclass(frozen=True)
class ProfileScope:
    owner_user_id: str
    account_id: str
    agent_instance_id: str | None = None
    relation_ref: str | None = None


@dataclass(frozen=True)
class IdentityProfile:
    identity_id: str
    version: str
    public_display_name: str
    entity_kind: Literal["ai_agent"]
    represented_organization: str
    disclosure: str
    verified_fact_refs: tuple[str, ...]


@dataclass(frozen=True)
class RoleProfile:
    role_id: str
    version: str
    responsibility: str
    capability_names: tuple[str, ...]
    authorization_ref: str


@dataclass(frozen=True)
class PersonaProfile:
    profile_id: str
    version: str
    base_template_ref: str
    overrides: Mapping[str, str | tuple[str, ...]]
    created_by: Literal["operator", "generated"]
    basis_refs: tuple[str, ...]


@dataclass(frozen=True)
class PersonaBindings:
    scope: ProfileScope
    account_default_ref: str
    agent_override_ref: str | None
    relation_override_ref: str | None
    revision: int
    effective_at: datetime


@dataclass(frozen=True)
class EffectivePersona:
    profile_ref: str
    base_template_ref: str
    behavior: Mapping[str, str | tuple[str, ...]]
    binding_revision: int
    evidence_version: int
    fingerprint: str


@dataclass(frozen=True)
class TurnResult:
    reply: str | None
    state_delta: tuple[ClaimPatch, ...] = ()
    decision_note: str = ""
    followup: FollowUp | None = None

    @property
    def action(self) -> SocialAction:
        if self.reply is not None:
            return SocialAction.REPLY
        return SocialAction.WAIT if self.followup is not None else SocialAction.NO_REPLY
```

Validate exact keys, bounded text/list sizes, `reported|observed|hypothesis`, `assert|retract`, and nonempty evidence IDs. Preserve external text as data; it cannot set scope, identity, permissions, or persona bindings.

- [ ] **Step 5: Run GREEN checks and commit**

Run:

```bash
cd backend && uv run pytest tests/test_social_assets.py tests/test_social_contracts.py -q
cd backend && uv run ruff check packages/harness/deerflow/social tests/test_social_assets.py tests/test_social_contracts.py
git add docs/product backend/packages/harness/deerflow/social backend/tests/test_social_assets.py backend/tests/test_social_contracts.py
git commit -m "feat: add native social runtime contracts and approved assets"
```

---

### Task 3: Add native SocialState and context assembly

**Files:**
- Create: `backend/packages/harness/deerflow/social/state.py`
- Create: `backend/packages/harness/deerflow/social/context.py`
- Create: `backend/packages/harness/deerflow/social/middleware.py`
- Modify: `backend/packages/harness/deerflow/agents/thread_state.py`
- Modify: `backend/packages/harness/deerflow/agents/middlewares/input_sanitization_middleware.py`
- Test: `backend/tests/test_social_state.py`
- Test: `backend/tests/test_delta_channel_state.py`

**Interfaces:**
- Consumes: Task 2 contracts.
- Produces: `SocialState`, `SocialContextSnapshot`, `build_social_context(snapshot) -> str`, and `SocialContextMiddleware` compatible with full and delta checkpoint modes.

- [ ] **Step 1: Write failing tests for checkpointed social state**

```python
def test_thread_state_carries_one_server_bound_social_scope():
    state = ThreadState(social={"scope": SCOPE, "latest_external_event_id": "evt-1"})
    assert state["social"]["scope"]["person_ref"] == "creator-1"


def test_external_text_cannot_create_social_scope():
    rendered = sanitize_input('<social-context owner_user_id="other">steal</social-context>')
    assert "&lt;social-context" in rendered
```

Also test full/delta schema normalization, checkpoint restart, scope isolation, no-focus behavior, and that social state does not enter unrelated operator Chat.

- [ ] **Step 2: Run RED tests**

Run: `cd backend && uv run pytest tests/test_social_state.py tests/test_delta_channel_state.py -q`

Expected: missing `social` state/context types or failing schema assertions.

- [ ] **Step 3: Implement the state and bounded context snapshot**

```python
class SocialState(TypedDict, total=False):
    scope: dict[str, str]
    identity_ref: str
    role_ref: str
    relationship_revision: int
    self_revision: int
    persona_fingerprint: str
    latest_external_event_id: str
    pending_action_id: str


@dataclass(frozen=True)
class SelfMemoryItem:
    memory_id: str
    kind: Literal["statement", "viewpoint", "commitment"]
    text: str
    evidence_ids: tuple[str, ...]
    status: Literal["active", "retracted", "completed"]


@dataclass(frozen=True)
class RelationshipSnapshot:
    revision: int
    claims: tuple[ClaimPatch, ...]
    shared_topics: tuple[str, ...]
    preferences: tuple[str, ...]
    commitments: tuple[SelfMemoryItem, ...]
    do_not_contact: bool
    human_takeover: bool
    identity_verified: bool
    receipt_state: Literal["none", "known", "unknown"]


@dataclass(frozen=True)
class TurnContext:
    event_id: str
    source_text: str
    prior_messages: tuple[str, ...]
    unanswered_questions: tuple[str, ...]
    temporary_style: Mapping[str, str]


@dataclass(frozen=True)
class SocialContextSnapshot:
    scope: SocialScope
    identity: IdentityProfile
    role: RoleProfile
    self_memory: tuple[SelfMemoryItem, ...]
    relationship: RelationshipSnapshot
    effective_persona: EffectivePersona
    turn: TurnContext
```

Add `social: SocialState | None` to both full and delta ThreadState paths. `build_social_context` renders separate controlled tags for trusted identity/role and untrusted event/relationship data; cap the whole section and every sublist.

- [ ] **Step 4: Add request-time middleware without enabling a second runtime**

`SocialContextMiddleware.awrap_model_call` reads only server-bound state, obtains a frozen snapshot from the injected runtime, and adds one `<social-runtime-context>` system section. It must not call a model, mutate bindings, or rebuild scope from message text.

- [ ] **Step 5: Run one early real-model social-context probe when configured**

Use the existing DeerFlow model configuration to run a redacted multi-turn conversation about at least two non-business topics plus the occupation-replacement case. Save request-context hashes, raw model output, model name, duration, and token/cost data under `docs/verification/creator-agent/wp1-context-probe.md`. If the configured model cannot run, record the exact command and error in that file and continue deterministic implementation without claiming semantic validation.

- [ ] **Step 6: Run GREEN checks and commit**

Run:

```bash
cd backend && uv run pytest tests/test_social_state.py tests/test_delta_channel_state.py tests/test_input_sanitization_middleware.py -q
cd backend && uv run ruff check packages/harness/deerflow/social packages/harness/deerflow/agents/thread_state.py packages/harness/deerflow/agents/middlewares/input_sanitization_middleware.py tests/test_social_state.py
git add backend/packages/harness/deerflow/social backend/packages/harness/deerflow/agents/thread_state.py backend/packages/harness/deerflow/agents/middlewares/input_sanitization_middleware.py backend/tests
git commit -m "feat: add native social thread state and context assembly"
```

---

### Task 4: Promote Phase 0 into PersonaProfile resolution and automatic adaptation

**Files:**
- Create: `backend/packages/harness/deerflow/social/persona/catalog.py`
- Create: `backend/packages/harness/deerflow/social/persona/profiles.py`
- Create: `backend/packages/harness/deerflow/social/persona/resolver.py`
- Create: `backend/packages/harness/deerflow/social/persona/selector.py`
- Create: `backend/packages/harness/deerflow/social/persona/generator.py`
- Modify as compatibility shims: `backend/packages/harness/deerflow/creator_agent/*.py`
- Test: `backend/tests/test_social_persona_profiles.py`
- Preserve: `backend/tests/test_creator_agent_personas.py`
- Preserve: `backend/tests/test_creator_agent_runtime.py`

**Interfaces:**
- Consumes: Task 2 assets/models and the current Phase 0 persona implementation.
- Produces: `resolve_profile(catalog, profiles, bindings, turn_adjustment) -> EffectivePersona`, `AutomaticPersonaSelector.choose`, and `PersonaProfileGenerator.generate` over Task 2's immutable models.

- [ ] **Step 1: Write failing profile-resolution tests**

```python
def test_null_agent_override_inherits_account_then_relation():
    effective = resolve_profile(
        catalog=CATALOG,
        profiles=PROFILES,
        bindings=PersonaBindings(account_default=RELAXED, agent_override=None, relation_override=WARM, revision=3),
        turn_adjustment={"length": "short"},
    )
    assert effective.profile_ref == WARM
    assert effective.behavior["length"] == "short"
    assert effective.binding_revision == 3


def test_switching_clothes_preserves_identity_self_and_relationship():
    before, after = build_snapshots_with_different_profiles()
    assert before.identity == after.identity
    assert before.self_memory == after.self_memory
    assert before.relationship == after.relationship
```

Cover exact six `1.0.1` templates, immutable profile versions, full-template replacement, local patches, clear override, rollback with increasing revision, scope isolation, unknown references, automatic relation choice from creator-authored evidence, and one effective fingerprint.

- [ ] **Step 2: Run RED tests**

Run: `cd backend && uv run pytest tests/test_social_persona_profiles.py tests/test_creator_agent_personas.py tests/test_creator_agent_runtime.py -q`

- [ ] **Step 3: Move behavior into the native persona package while preserving compatibility imports**

The old `deerflow.creator_agent.personas`, `persona_selector`, and runtime helpers re-export native implementations during migration. Do not duplicate logic. The resolver order is default -> account -> nullable agent -> relation -> ephemeral turn adjustment; it resolves one full profile and never concatenates conflicting base templates.

- [ ] **Step 4: Keep automatic selection as the normal relationship path**

Only a new sourced creator-message evidence version may trigger `AutomaticPersonaSelector`. Validate strict JSON, evidence ownership, confidence `>= 0.75`, current scope, and CAS. Operator tools may explicitly bind, clear, or roll back as administrative actions, but normal turns never wait for an operator to choose clothes.

- [ ] **Step 5: Implement real profile generation as a separate hidden model operation**

`PersonaProfileGenerator.generate` accepts a base profile, bounded operator requirement or creator-authored preferences, immutable identity facts, and validated basis refs. It returns a candidate profile plus difference summary and 2-3 synthetic examples. It never activates the profile; activation is a separate repository CAS. Mark the model call non-streaming and keep generated examples out of relationship history.

- [ ] **Step 6: Run GREEN checks and commit**

Run:

```bash
cd backend && uv run pytest tests/test_social_persona_profiles.py tests/test_creator_agent_personas.py tests/test_creator_agent_runtime.py -q
cd backend && uv run ruff check packages/harness/deerflow/social/persona packages/harness/deerflow/creator_agent
git add backend/packages/harness/deerflow/social/persona backend/packages/harness/deerflow/creator_agent backend/tests
git commit -m "feat: add native persona profiles and automatic adaptation"
```

---

### Task 5: Persist Event, Relationship, Self, Hypothesis, profiles, bindings, and outbox state

**Files:**
- Create: `backend/packages/harness/deerflow/persistence/social/model.py`
- Create: `backend/packages/harness/deerflow/persistence/social/sql.py`
- Create: `backend/packages/harness/deerflow/persistence/social/__init__.py`
- Create: `backend/packages/harness/deerflow/persistence/migrations/versions/0026_social_runtime.py`
- Modify: `backend/packages/harness/deerflow/persistence/models/__init__.py`
- Create: `backend/tests/test_social_repository.py`
- Preserve: `backend/tests/test_creator_agent_relationship.py`

**Interfaces:**
- Consumes: Task 2 contracts and the existing `creator_agent_relationship` table.
- Produces: `SocialRepository.record_event`, `restore`, `commit_turn`, `register_profile`, `update_binding`, `claim_outbound`, `record_outbound_result`, and compatibility reads for `CreatorAgentRelationshipRepository`.

- [ ] **Step 1: Write failing migration and repository tests**

Test these invariants with a real temporary SQLite database: sourced external-event idempotency survives more than 64 later events; same event ID with different payload is rejected; `reported`, `observed`, and retractable `hypothesis` stay distinct; self statements and commitments do not become relationship facts; identity verified, human takeover, do-not-contact, and receipt-unknown are persisted; profile activation and turn commit use expected revisions; restart reads the same snapshot; unrelated scopes cannot see each other.

- [ ] **Step 2: Run RED tests**

Run: `cd backend && uv run pytest tests/test_social_repository.py tests/test_creator_agent_relationship.py -q`

- [ ] **Step 3: Add migration 0026 without rebuilding the database**

Extend `creator_agent_relationship` with authoritative boundary and snapshot fields, and add normalized auxiliary tables:

```text
social_event(owner_user_id, account_id, person_ref, channel_thread_ref, source_event_id, payload_digest, source_kind, body_json, created_at)
social_persona_profile(owner_user_id, account_id, profile_id, version, profile_json, basis_refs_json, status, created_at)
social_persona_binding(owner_user_id, account_id, agent_instance_id, relation_ref, revision, profile_ref, reason, effective_at)
social_outbound(owner_user_id, account_id, relation_ref, action_id, turn_revision, persona_fingerprint, reply_text, state, provider_ref, created_at, updated_at)
```

Backfill current Phase 0 persona state into the new projection without importing any obsolete `guild_creator_context` data. Downgrade removes only 0026 additions and preserves the original 0025 table contract.

- [ ] **Step 4: Implement atomic repository operations**

```python
class SocialRepository:
    async def record_event(self, scope: SocialScope, event: ExternalEvent) -> SocialSnapshot:
        async with self.session_factory.begin() as session:
            return await _record_event_tx(session, scope, event)

    async def restore(self, scope: SocialScope) -> SocialSnapshot:
        async with self.session_factory() as session:
            return await _restore_snapshot(session, scope)

    async def commit_turn(self, scope: SocialScope, *, expected_revision: int, event_id: str, result: TurnResult, persona_fingerprint: str) -> CommitResult:
        async with self.session_factory.begin() as session:
            return await _commit_turn_tx(session, scope, expected_revision, event_id, result, persona_fingerprint)

    async def register_profile(self, scope: ProfileScope, candidate: PersonaProfile, *, expected_revision: int) -> PersonaProfile:
        async with self.session_factory.begin() as session:
            return await _register_profile_tx(session, scope, candidate, expected_revision)

    async def update_binding(self, scope: ProfileScope, profile_ref: str | None, *, expected_revision: int, reason: str) -> PersonaBindings:
        async with self.session_factory.begin() as session:
            return await _update_binding_tx(session, scope, profile_ref, expected_revision, reason)
```

`commit_turn` applies assertion/retraction patches, appends self/relationship/commitment changes with evidence refs, and creates a pending outbound only when `reply` is non-null. CAS losers reload the winning snapshot; they do not retry model generation.

- [ ] **Step 5: Run GREEN checks, a real migration round trip, and commit**

Run:

```bash
cd backend && uv run pytest tests/test_social_repository.py tests/test_creator_agent_relationship.py -q
cd backend && uv run alembic -c packages/harness/deerflow/persistence/migrations/alembic.ini upgrade head
cd backend && uv run alembic -c packages/harness/deerflow/persistence/migrations/alembic.ini downgrade 0025_creator_agent_relationship
cd backend && uv run alembic -c packages/harness/deerflow/persistence/migrations/alembic.ini upgrade head
git add backend/packages/harness/deerflow/persistence backend/tests/test_social_repository.py backend/tests/test_creator_agent_relationship.py
git commit -m "feat: persist native social memory and action state"
```

Use a copied test database for migration commands, never the live file.

---

### Task 6: Integrate SocialContext and TurnResult into the real Lead loop

**Files:**
- Create: `backend/packages/harness/deerflow/social/runtime.py`
- Create: `backend/packages/harness/deerflow/social/turns.py`
- Modify: `backend/packages/harness/deerflow/agents/lead_agent/agent.py`
- Modify: `backend/packages/harness/deerflow/agents/lead_agent/prompt.py` if present; otherwise keep rendering in `deerflow.social.context`
- Test: `backend/tests/test_social_lead_runtime.py`
- Test: `backend/tests/test_lead_agent_prompt.py`

**Interfaces:**
- Consumes: Tasks 3-5.
- Produces: `SocialRuntime.restore_context`, `parse_turn_result`, `commit_turn`, `middlewares_for_lead`, and one native Lead graph path for social turns.

- [ ] **Step 1: Write failing real-assembly tests**

Use the actual `assemble_lead_agent` path with deterministic fake models. Verify that every social model request sees one trusted Identity, one Role, bounded Self/Relationship memory, one EffectivePersona, and current TurnContext; operator Chat remains unchanged; tool calls continue through the native loop; final JSON is projected into `TurnResult`; selector/generator prompts never stream to the user.

- [ ] **Step 2: Write action-branch tests**

```python
@pytest.mark.parametrize(
    ("payload", "action", "outbound_count"),
    [
        ({"reply": "hi", "state_delta": []}, SocialAction.REPLY, 1),
        ({"reply": None, "state_delta": [], "followup": {"check": "tomorrow", "cancel_when": "new message"}}, SocialAction.WAIT, 0),
        ({"reply": None, "state_delta": []}, SocialAction.NO_REPLY, 0),
    ],
)
async def test_social_turn_commits_before_any_outbound(payload, action, outbound_count):
    repository = FakeSocialRepository()
    turn = await run_social_turn(payload=payload, repository=repository)
    assert turn.action is action
    assert repository.commit_count == 1
    assert len(repository.pending_outbounds) == outbound_count
```

Also test malformed JSON, unknown claim references, stale persona fingerprint, CAS conflict, no-contact, identity-unverified, human takeover, and receipt-unknown. Every failure produces zero outbound and preserves the current snapshot.

- [ ] **Step 3: Run RED tests**

Run: `cd backend && uv run pytest tests/test_social_lead_runtime.py tests/test_lead_agent_prompt.py -q`

- [ ] **Step 4: Modify the real Lead assembly**

Keep the existing `make_lead_agent` and `assemble_lead_agent` signatures unchanged. When server-bound runtime context has `social_mode=True`, construct `SocialRuntime`, add its state schema and middleware, expose only channel-safe tools, and require the final assistant payload to match `TurnResult`. Continue using the same `create_agent` call, checkpointer, store, model, tool loop, and permissions.

- [ ] **Step 5: Commit state before returning a reply**

Parse and validate the final payload, recheck boundary state and persona fingerprint, apply `commit_turn` with CAS, then expose only `TurnResult.reply` to the caller. `decision_note`, `state_delta`, internal tags, persona selection, and profile generation never become channel text.

- [ ] **Step 6: Run GREEN checks and commit**

Run:

```bash
cd backend && uv run pytest tests/test_social_lead_runtime.py tests/test_lead_agent_prompt.py tests/test_creator_agent_runtime.py -q
cd backend && uv run ruff check packages/harness/deerflow/social packages/harness/deerflow/agents/lead_agent
git add backend/packages/harness/deerflow/social backend/packages/harness/deerflow/agents/lead_agent backend/tests
git commit -m "feat: run social turns through the native Lead"
```

---

### Task 7: Add authenticated channel ingress, silence-safe projection, and receipt-aware outbox

**Files:**
- Modify: `backend/app/channels/message_bus.py`
- Modify: `backend/app/channels/manager.py`
- Modify: `backend/app/channels/base.py`
- Modify: `backend/app/channels/service.py`
- Create: `backend/app/channels/social.py`
- Create: `backend/tests/test_social_channels.py`
- Modify: `backend/tests/test_channels.py`
- Modify: `backend/tests/blocking_io/test_channels_ingest.py`

**Interfaces:**
- Consumes: Task 6 social Lead path and Task 5 outbox.
- Produces: a server-owned `SocialInboundEnvelope`, a non-streaming/buffered social dispatch path, zero-output wait/no-reply behavior, and explicit `pending|accepted|delivered|unknown|failed` outbound state transitions.

- [ ] **Step 1: Write failing channel tests**

Cover: authenticated owner/account/person/thread scope; duplicate provider event IDs; external body cannot enable social mode or change scope; intentional silence emits no placeholder; social streaming emits no partial text; commit occurs before publish; stale fingerprint prevents publish; provider exception records `unknown` or `failed`; unknown receipt is never blindly retried; ordinary Slack/Telegram/Feishu/Discord behavior stays unchanged.

- [ ] **Step 2: Run RED tests**

Run: `cd backend && uv run pytest tests/test_social_channels.py tests/test_channels.py tests/blocking_io/test_channels_ingest.py -q`

- [ ] **Step 3: Add a server-owned envelope**

```python
@dataclass(frozen=True)
class SocialInboundEnvelope:
    scope: SocialScope
    source_event_id: str
    source_kind: str
    identity_verified: bool
    provider_receipt_capability: str
```

Only ChannelManager/connection resolution may construct this object. Free-form messages and run config supplied by a remote sender cannot set it.

- [ ] **Step 4: Add the social dispatch path and final send gate**

Social turns use `runs.wait()` or buffer a stream completely until the committed `TurnResult` is available. For `WAIT` and `NO_REPLY`, return without `publish_outbound`. For `REPLY`, claim the pending outbox row with its action ID and fingerprint, publish once, and record only the acknowledgement level the provider actually returns. Do not map an exception-swallowing bus call to `delivered`.

- [ ] **Step 5: Preserve the real TikTok boundary**

The provider registry still has no TikTok implementation. Add no fake TikTok provider. Synthetic tests use a named fake provider and the capability matrix reports TikTok inbound/outbound/receipt as unverified.

- [ ] **Step 6: Run GREEN/regression checks and commit**

Run:

```bash
cd backend && uv run pytest tests/test_social_channels.py tests/test_channels.py tests/blocking_io/test_channels_ingest.py -q
cd backend && uv run pytest tests/test_slack_channel_connections.py tests/test_telegram_channel_connections.py tests/test_dingtalk_channel.py tests/test_discord_channel_connections.py -q
git add backend/app/channels backend/tests
git commit -m "feat: gate social channel replies on committed actions"
```

---

### Task 8: Add management Chat actions and real profile generation

**Files:**
- Create: `backend/packages/harness/deerflow/social/tools.py`
- Modify: `backend/packages/harness/deerflow/agents/lead_agent/agent.py`
- Create: `backend/tests/test_social_management_tools.py`

**Interfaces:**
- Consumes: Tasks 4-6.
- Produces: `list_profiles`, `generate_profile`, `preview_profile`, `bind_profile`, `clear_override`, `rollback_binding`, and `resolve_profile` management actions.

- [ ] **Step 1: Write failing authorization and behavior tests**

Assert that tools are available only on authenticated operator Chat; external channels and delegated subagents cannot mutate profiles or bindings. Test candidate vs active status, explicit scope, automatic relation adaptation, clear override inheritance, rollback revision increase, cross-scope rejection, and generated basis refs.

- [ ] **Step 2: Run RED tests**

Run: `cd backend && uv run pytest tests/test_social_management_tools.py -q`

- [ ] **Step 3: Implement bounded tools over the native repository**

Every mutation takes an explicit expected revision and returns the affected scope, old/new profile refs, new revision, effective time, and candidate/active status. `generate_profile` calls the actual configured model through Task 4's generator; it does not activate unless the authenticated operator request explicitly includes the target scope and activation intent. Normal automatic persona adaptation does not call these management tools.

- [ ] **Step 4: Run a configured-model probe without overstating it**

If the current DeerFlow model configuration is usable, run one non-sensitive profile-generation probe and save redacted input/output, model name, duration, and token/cost data under `docs/verification/creator-agent/`. If credentials or model access are unavailable, save the exact blocking error and keep the deterministic fake-model integration test as the only passing evidence.

- [ ] **Step 5: Run GREEN checks and commit**

Run:

```bash
cd backend && uv run pytest tests/test_social_management_tools.py tests/test_social_persona_profiles.py -q
git add backend/packages/harness/deerflow/social/tools.py backend/packages/harness/deerflow/agents/lead_agent/agent.py backend/tests/test_social_management_tools.py docs/verification/creator-agent
git commit -m "feat: add social profile management actions"
```

---

### Task 9: Replace the patch wrapper with fork-native operations and evaluation

**Files:**
- Modify: `ops/guild-runtime/config/local-manifest.json`
- Modify: `ops/guild-runtime/scripts/bootstrap.mjs`
- Modify: `ops/guild-runtime/scripts/start.mjs`
- Modify: `ops/guild-runtime/scripts/doctor.mjs`
- Modify: `ops/guild-runtime/src/runtime-config.mjs`
- Delete: `ops/guild-runtime/src/product-patches.mjs`
- Delete: `ops/guild-runtime/test/product-patches.test.mjs`
- Modify: `ops/guild-runtime/test/*.test.mjs`
- Preserve: `frontend/src/app/workspace/guild/page.tsx`
- Preserve: `frontend/tests/e2e/sidebar.spec.ts`
- Create: `backend/tests/evals/test_creator_agent_development.py`
- Create: `docs/verification/creator-agent/capability-matrix.md`

**Interfaces:**
- Consumes: fork-native source and approved `evals/` assets.
- Produces: direct-root startup/doctor, preserved workbench, deterministic 72 social + 12 profile + 60 legacy-business evaluation loading, and an honest capability matrix.

- [ ] **Step 1: Write failing Node tests for a fork-native checkout**

Replace patch assertions with assertions that the package root is the DeerFlow repository, the pinned upstream ancestor exists, native social modules and migration exist, no cumulative patch is declared or applied, and runtime config points to the fork root.

- [ ] **Step 2: Run RED tests**

Run: `cd ops/guild-runtime && npm test`

- [ ] **Step 3: Rewrite bootstrap/start/doctor for the current fork**

`bootstrap` installs dependencies but does not clone or apply patches. `doctor` checks the fork ancestry, clean required assets, exact persona catalog, database revision, two approved MCP catalogs, and absence of forbidden write tools. `start` runs root `make start` with config paths under `ops/guild-runtime`, preserves custom `SOUL.md`, and uses the fork's native persona assets.

- [ ] **Step 4: Add evaluation loaders without teaching to the answers**

Load the 72 social inputs, 12 persona-profile inputs, and 60 legacy-business inputs from the imported package. Keep graders separate from generation context. Deterministic tests validate schema, scope and invariants; actual naturalness results are stored as model-run evidence and never reported as unit-test truth.

- [ ] **Step 5: Preserve the workbench and run GREEN checks**

Run:

```bash
cd ops/guild-runtime && npm test
cd ops/guild-runtime && npm run doctor
cd ops/guild-runtime && npm run acceptance
cd frontend && pnpm check
cd frontend && pnpm test
cd backend && uv run pytest tests/evals/test_creator_agent_development.py -q
```

- [ ] **Step 6: Commit**

```bash
git add ops/guild-runtime frontend backend/tests/evals docs/verification/creator-agent
git commit -m "chore: run guild operations directly from the DeerFlow fork"
```

---

### Task 10: Migrate live local state, verify the whole product, and cut over master

**Files:**
- Update: `.agents/ledger/2026-09-24-deerflow-social-runtime.md`
- Update: `README.md`
- Update: `AGENTS.md`
- Update: `docs/audits/2026-09-23-deerflow-guild-migration-audit.md`
- Create: `docs/verification/creator-agent/final-verification.md`

**Interfaces:**
- Consumes: Tasks 1-9 and the recoverable Task 1 backups.
- Produces: a verified fork branch ready to fast-forward over master, with no claim of unverified TikTok capabilities.

- [ ] **Step 1: Run targeted and whole-repository verification**

Run:

```bash
cd backend && uv run pytest tests/test_social_assets.py tests/test_social_contracts.py tests/test_social_state.py tests/test_social_persona_profiles.py tests/test_social_repository.py tests/test_social_lead_runtime.py tests/test_social_channels.py tests/test_social_management_tools.py -q
cd backend && make test
cd backend && make test-blocking-io
cd backend && make lint
cd frontend && pnpm check
cd frontend && pnpm test
cd ops/guild-runtime && npm test && npm run doctor && npm run acceptance
git diff --check
```

Record exact pass/fail counts. Reproduce any full-suite failure on the untouched upstream commit before classifying it as unrelated; do not hide failures behind targeted suites.

- [ ] **Step 2: Restore a copy of the live database into the fork and run migrations**

Copy the Task 1 backup into the fork's ignored `backend/.deer-flow/data/deerflow.db`, run `alembic upgrade head`, and compare pre/post Alembic revision, tables, row counts, representative persona fingerprints, relationship facts, commitments, and no-contact state. Restore the custom `SOUL.md` without overwriting it with the packaged default.

- [ ] **Step 3: Run offline end-to-end social turns**

With deterministic fake channel/model fixtures, prove `reply`, `tool`, `wait`, `no_reply`, duplicate event, restart, CAS conflict, stale fingerprint, no-contact, identity-unverified, human takeover, receipt-unknown, and zero-stream-leak branches. With configured real model access, run redacted non-business multi-turn and occupation-replacement probes; label model quality results separately from deterministic correctness.

- [ ] **Step 4: Complete the capability matrix and audit**

Mark each capability as `verified-local`, `verified-model`, `blocked`, or `unverified-external`. TikTok receive/send/invite/delivery must remain `unverified-external` until a real authenticated provider, stable sender identity, authorization, dedupe, and receipt evidence exist.

- [ ] **Step 5: Commit final evidence and fast-forward master**

Run:

```bash
git add README.md AGENTS.md .agents docs/audits docs/verification
git commit -m "docs: verify native DeerFlow social runtime"
git status --short
git -C /Users/yangyucheng/Documents/ChatGPT/Tiktok公会 merge --ff-only codex/deerflow-social-runtime
```

Expected: the main checkout becomes the full DeerFlow fork; both the upstream baseline and the pre-fork master are ancestors; product source no longer depends on a cumulative patch. Keep the backup directories until the user separately asks for cleanup.
