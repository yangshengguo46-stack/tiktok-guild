# Task 2 report: evidence-backed social memory candidates

## Status

Implemented and verified. Commit: pending.

## TDD evidence

- Added parser acceptance and missing-evidence rejection tests before production changes.
- Added atomic commit, replay idempotency, and cross-scope evidence fail-closed tests before production changes.
- Initial focused run failed during collection because `MemoryCandidate` was not yet defined.
- After implementation, all five focused tests passed.

## Implementation

- Added immutable, bounded `MemoryCandidate` to the native social contract with the four host memory categories, assert/retract shape checks, bounded text, non-empty unique evidence, and duplicate-per-turn ID rejection.
- Added `memory_delta` after `followup` on `TurnResult`, preserving existing positional callers.
- Extended strict JSON parsing to accept only the bounded `memory_delta` field and reject malformed candidates, empty evidence, unknown fields, and duplicate IDs.
- Converted model candidates to host-owned `SelfMemoryChange` values only in `social.turns.commit_turn`; the existing repository transaction performs scope evidence validation, CAS, outbox write, and replay handling atomically.
- Updated the Lead output prompt to describe optional evidence-backed memory candidates and state that they cannot authorize identity, boundaries, or platform receipts.

## Verification

- `backend/.venv/bin/pytest -q backend/tests/test_social_contracts.py backend/tests/test_social_repository.py backend/tests/test_social_lead_runtime.py`
  - 198 passed in 47.62s
- `backend/.venv/bin/ruff check packages/harness/deerflow/social packages/harness/deerflow/persistence/social tests/test_social_contracts.py tests/test_social_repository.py tests/test_social_lead_runtime.py`
  - All checks passed

## Concerns

- No known concerns. Existing repository evidence and atomicity paths are reused; no separate memory ledger or agent was introduced.
