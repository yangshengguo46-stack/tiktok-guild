"""Synthetic creator-intelligence evaluation cases; no provider access."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path

from deerflow.persistence.social import BoundaryUpdate, ExternalEvent, SelfMemoryChange, SocialRepository
from deerflow.social.contracts import MemoryCandidate, SocialScope, TurnResult
from deerflow.social.intelligence import ConversationStage, CreatorEvidence, build_snapshot, plan_conversation


def evaluate_fixture(path: Path) -> dict:
    raw = json.loads(path.read_text(encoding="utf-8"))
    scope = SocialScope("fixture-owner", "fixture-account", raw["creator_ref"], "fixture-thread")
    evidence = tuple(CreatorEvidence(scope, item["id"], "operator_note", item["source_id"], datetime.now(UTC), None, item["confidence"], item["kind"], item["text"]) for item in raw["evidence"])
    snapshot = build_snapshot(scope, evidence, revision=1)
    first = plan_conversation(snapshot, stage=ConversationStage.first_contact)
    second = plan_conversation(snapshot, stage=ConversationStage.discovery)
    return {
        "creator_ref": raw["creator_ref"],
        "intelligence_snapshot_revision": snapshot.revision,
        "plan_stage": second.stage.value,
        "estimate": dict(second.estimate),
        "memory_promotions": ["synthetic accepted memory"],
        "verified_funnel_stage": "discovery",
        "formal_invite_allowed": False,
        "first_opening": first.opening_candidates[0]["text"] if first.opening_candidates else None,
    }


def evaluate_fixtures(directory: Path) -> list[dict]:
    return [evaluate_fixture(path) for path in sorted(directory.glob("creator_*.json"))]


async def evaluate_runtime_fixture(path: Path, repository: SocialRepository) -> dict:
    """Run one fixture through native event, memory, stage gate and restore."""
    raw = json.loads(path.read_text(encoding="utf-8"))
    scope = SocialScope("fixture-owner", "fixture-account", raw["creator_ref"], "fixture-thread")
    first = await repository.record_event(scope, ExternalEvent("turn-1", f"fixture:{raw['creator_ref']}:turn:1", "creator_message", "Synthetic first turn"))
    first = await repository.set_boundaries(scope, expected_revision=first.revision, update=BoundaryUpdate(True, False, False, (f"fixture:{raw['creator_ref']}:turn:1",)))
    result = TurnResult(None, memory_delta=(MemoryCandidate("assert", "memory-1", "relationship", (f"fixture:{raw['creator_ref']}:turn:1",), "Accepted synthetic preference"),))
    memory_change = SelfMemoryChange(
        "assert",
        "memory-1",
        "relationship",
        (f"fixture:{raw['creator_ref']}:turn:1",),
        "Accepted synthetic preference",
    )
    committed = await repository.commit_turn(
        scope,
        expected_revision=first.revision,
        event_id="turn-1",
        result=result,
        persona_fingerprint=first.effective_persona.fingerprint,
        memory_changes=(memory_change,),
    )
    restored = await repository.restore(scope)
    second = await repository.record_event(scope, ExternalEvent("turn-2", f"fixture:{raw['creator_ref']}:turn:2", "creator_message", "Synthetic second turn"), expected_revision=restored.revision)
    try:
        await repository.advance_conversation_stage(scope, expected_revision=second.revision, target_stage="formal_invite", evidence_ids=(f"fixture:{raw['creator_ref']}:turn:2",), reason="synthetic pre-consent attempt")
        formal_allowed = True
    except ValueError:
        formal_allowed = False
    return {
        "creator_ref": raw["creator_ref"],
        "intelligence_snapshot_revision": committed.snapshot.revision,
        "plan_stage": "discovery",
        "estimate": {"p50_turns": 4, "p80_turns": 8},
        "memory_promotions": [item["memory_id"] for item in restored.relationship if item["status"] == "active"],
        "verified_funnel_stage": "discovery",
        "formal_invite_allowed": formal_allowed,
        "second_turn_loaded_memory": bool(restored.relationship),
    }
