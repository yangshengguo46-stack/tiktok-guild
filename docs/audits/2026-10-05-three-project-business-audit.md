# Three-Project Business Audit

Date: 2026-10-05 (UTC)
Scope: read-only audit of the three project trees and the nested DeerFlow runtime, followed by bounded local verification. No external accounts, credentials, content publishing, or TikTok writes were used.

## Project inventory

| Project | Path | Git state | Actual role |
|---|---|---|---|
| Marketing Agent | `/Users/yangyucheng/Documents/ChatGPT/营销agent` | `codex/marketing-agent@19cd6824`; existing uncommitted marketing changes preserved | DeerFlow-based native marketing department: business/audience grounding, signal review, content opportunity, content lineage, feedback |
| TikTok Guild | `/Users/yangyucheng/Documents/ChatGPT/Tiktok公会` | `codex/pre-device-audit@12919183f`; clean at audit time | Product/runtime envelope and guild business context: TKDesk/Guild Operator facts, social Lead, Android outreach operator, operational runbooks |
| DeerFlow runtime | `/Users/yangyucheng/Documents/ChatGPT/Tiktok公会/.runtime/deer-flow` | detached `HEAD@769589e8`; existing CreatorAgent/relationship/workbench edits preserved | Actual DeerFlow code used by the guild product; currently dirty and not a safe place for broad changes |
| Native Agent Organization | `/Users/yangyucheng/Documents/ChatGPT/原生agent组织` | `master@3f2e636`; only pre-existing untracked `.superpowers/` | Proposed RoleOS/CEO–Marketing–Sales control-plane design; no runnable implementation exists |

## Documents and code reconciled

### Marketing

Reviewed root/backend/frontend `AGENTS.md`, `docs/marketing-agent/README.md`, `VERIFICATION.md`, `MARKETING_POSITION_AGENT.md`, `PROJECT_MAP.md`, `docs/content-intelligence-v6/LEDGER.md` and `ARCHITECTURE.md`, marketing loop/position/opportunity/tool modules, and the focused marketing tests.

The code really does provide a native marketing path. `MarketingLoop` accepts business and audience adapters, optional offer/situation context, trend signals, a deterministic opportunity ranking, authored draft/evaluation boundaries, content lineage sealing, and a private `sales_handoff` projection. Production tools enforce server-owned position/account/frame lineage; the test-only generator is explicitly not a production model. The existing dirty diff contains that narrow business slice and is retained as user work.

### TikTok Guild and DeerFlow

Reviewed `AGENTS.md`, `.agents/coordination.md`, `.agents/ledger/2026-09-24-deerflow-social-runtime.md`, `docs/audits/2026-09-30-business-completion-audit.md`, CreatorAgent specs/runbooks, Android outreach runbook, current ops runtime code/tests, and nested DeerFlow CreatorAgent code/tests.

The top-level guild project has a clear ledger and honest business boundaries. The nested runtime contains the actual CreatorAgent/persona/relationship code and substantial pre-existing uncommitted work. The ledger correctly distinguishes local software evidence from unverified TikTok inbound/outbound, provider receipts, real-device operation, customer installation, and live conversion.

A concrete runtime gap is reproducible: nested DeerFlow's CreatorAgent default catalog resolves to `/Users/yangyucheng/Documents/ChatGPT/Tiktok公会/config/personas.json`, but the shipped catalog is at `/Users/yangyucheng/Documents/ChatGPT/Tiktok公会/ops/guild-runtime/config/personas.json`. The nested runtime has no `config/personas.json`. Setting `DEER_FLOW_GUILD_PERSONAS_PATH` to the shipped ops catalog makes the relationship/runtime/input-sanitization tests pass; without it, the default persona tests fail before business behavior is exercised.

### Native Agent Organization

Reviewed the Proposed architecture spec and implementation plan. The repository has no `src/`, `tests/`, `pyproject.toml`, or executable RoleOS code. The plan defines typed envelopes, a ledger, CEO coordination, active work, runtime adapters, and a vertical slice, but none is implemented. Per the current user priority, this remains an architecture/reference project; orchestration should not be introduced into the business projects during this pass.

## Business scorecard

| Project | Usable today | Blocks real work | Safe next sequence |
|---|---|---|---|
| Marketing Agent | Native marketing position/bootstrap; scoped signal review; content opportunity and lineage contracts; authored content tool; feedback receipt; deterministic business-grounded `MarketingLoop` with private sales handoff | No live external signal/provider guarantee; no true sales conversation/qualification runtime; model/content quality and conversion are not proven by offline tests | (1) fix/lock business input contract, (2) add deterministic qualification/continuation state around the handoff, (3) wire a manual CLI/API smoke path, (4) only then connect a real sales owner |
| TikTok Guild/DeerFlow | Native Lead/social runtime; scoped relationship state; persona selection contracts; guild/TKDesk/Guild Operator read boundaries; Android operator shell and extensive offline gates | Persona catalog path is not self-contained; nested runtime is detached/dirty; real TikTok identity/inbound/outbound/receipt, device, customer install, Postgres/live deployment remain unverified | (1) repair asset path and test from a clean runtime, (2) run local social/ops smoke, (3) verify one explicitly authorized device/provider pilot, (4) only then enable business writes |
| Native Agent Organization | Clear proposed business/control-plane model and a detailed implementation plan | No executable code, no tests, no runtime, and orchestration is explicitly out of scope for this pass | Keep as design backlog; do not build a second control plane until Marketing/Sales/Guild business contracts are proven |

## Marketing -> Sales -> TikTok Guild

1. Marketing reads the business promise/offer, audience need/situation, and current signal evidence.
2. Marketing ranks an opportunity and creates an authored draft/plan plus a private `sales_handoff` containing audience, need, offer, trigger, follow-up, and qualification questions.
3. Sales must qualify the concrete need, timing, fit, and permission before any commercial or creator-facing action. The handoff is context, not a lead creation or send authorization.
4. TikTok Guild remains the execution/data authority for creator identity, relationship facts, invitations, device/provider actions, and receipts. Marketing/Sales must consume those facts through existing scoped interfaces rather than copying a second ledger.
5. External writes stay disabled until identity, authorization, deduplication, and provider read-back are verified.

## Verification evidence

- Marketing focused regression: `uv run` was blocked by the host uv cache lock, so the repository's existing `.venv` was used. Command:
  `backend/.venv/bin/python -m pytest -q tests/test_marketing_loop.py tests/test_marketing_position_cases.py tests/test_marketing_proactive.py tests/test_marketing_creative_work.py tests/test_marketing_position_bootstrap.py`
  Result: **101 passed** (pytest cache warning only).
- Guild ops runtime: `ops/guild-runtime npm test` produced **116 passed, 5 failed**. The failures are host/environment boundaries: sandbox `listen EPERM` for tests that start local servers, and nginx cannot open the host log path. Static/runtime contracts, Android operator tests, deployment contracts, asset checks, and most doctor/acceptance tests passed.
- Nested DeerFlow CreatorAgent/runtime/input-sanitization focused run with the shipped catalog injected:
  `DEER_FLOW_GUILD_PERSONAS_PATH=/Users/yangyucheng/Documents/ChatGPT/Tiktok公会/ops/guild-runtime/config/personas.json .venv/bin/python -m pytest -q tests/test_creator_agent_relationship.py tests/test_creator_agent_runtime.py tests/test_input_sanitization_middleware.py`
  Result: **238 passed** (pytest cache warning only).
- The same nested tests without the environment override failed **30 tests** because the default catalog path is missing. This is the first concrete business/runtime gap.

## Proposed first practical slice

After the audit record is accepted, make the smallest safe fix in the nested DeerFlow runtime: resolve the default CreatorAgent catalog to the shipped `ops/guild-runtime/config/personas.json` asset (while retaining the environment override), update the test path to the shipped asset, and add a deterministic smoke test that constructs the default runtime without an environment override. Run the focused runtime tests and `git diff --check`. Do not touch the pre-existing Creator/relationship/workbench edits, external providers, or the marketing repository's dirty files.

The next marketing/sales slice should then add qualification/continuation as a pure local business contract around the existing read-only `sales_handoff`, with a failing test first; it must not create an orchestration layer or external lead/send action.

## Phase 3 progress (2026-10-05)

The first practical slices are now implemented and verified.

### Marketing -> Sales continuation

Added `backend/packages/harness/deerflow/marketing/sales.py` and exported it from the
marketing package. `SalesQualificationInput` accepts only explicit facts for need,
permission, fit, timing, and an explicit stop signal. `qualify_sales_handoff` returns
one of `qualified`, `needs_context`, `not_a_fit`, or `paused`, with a bounded next
step and at most one next question. It is pure and read-only: no send, publish, lead,
conversion, or orchestration side effect.

TDD evidence: `backend/tests/test_marketing_sales.py` first failed with the missing
module, then passed after implementation. The complete focused marketing regression
now reports **104 passed**; Ruff check/format and `git diff --check` pass. A manual
Python smoke call also returns the qualified continuation for the existing breakfast
coffee handoff.

### DeerFlow default persona asset

In the already-dirty nested runtime branch `codex/2026-10-05-business-audit`, the
default catalog in
`backend/packages/harness/deerflow/creator_agent/personas.py` now resolves to the
shipped `ops/guild-runtime/config/personas.json`. The environment override remains
available for packaged deployments. `backend/tests/test_creator_agent_personas.py`
contains the no-environment regression.

With `DEER_FLOW_GUILD_PERSONAS_PATH` removed, the focused CreatorAgent/persona,
relationship, runtime, and input-sanitization run reports **247 passed**. The fix is
uncommitted because the worktree already contained user changes; all of those changes
remain intact.

### Remaining blockers

The top-level guild ops suite remains **116 passed, 5 failed** under this host because
four tests cannot bind local `127.0.0.1` listeners (`listen EPERM`) and one nginx
assertion cannot open `/usr/local/var/log/nginx/error.log`. Real Android/TikTok
identity, inbound/outbound messaging, provider read-back, customer installation,
Postgres deployment, and live conversion are still unverified. The native-agent
organization remains design-only as requested; no collaboration/orchestration layer
was added.
