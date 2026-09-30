"""Synthetic creator-intelligence evaluation cases; no provider access."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path

from app.scheduler.social_followups import SocialFollowupScheduler
from deerflow.persistence.social import BoundaryUpdate, ExternalEvent, SelfMemoryChange, SocialRepository
from deerflow.social.contracts import IdentityProfile, MemoryCandidate, RoleProfile, SocialScope, TurnResult
from deerflow.social.intelligence import ConversationStage, CreatorEvidence, build_snapshot, plan_conversation
from deerflow.social.runtime import SocialRuntime, SocialRuntimeBinding


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
    evidence = tuple(CreatorEvidence(scope, item["id"], "operator_note", item["source_id"], datetime.now(UTC), None, item["confidence"], item["kind"], item["text"]) for item in raw["evidence"])
    _intelligence = build_snapshot(scope, evidence, revision=1)
    first = await repository.record_event(scope, ExternalEvent("turn-1", f"fixture:{raw['creator_ref']}:turn:1", "operator_note", "Synthetic first turn"))
    first = await repository.set_boundaries(scope, expected_revision=first.revision, update=BoundaryUpdate(True, False, False, (f"fixture:{raw['creator_ref']}:turn:1",)))
    identity = IdentityProfile("fixture-ai", "1", "Synthetic AI", "ai_agent", "Synthetic Guild", "Synthetic only", ())
    role = RoleProfile("fixture-role", "1", "Synthetic evaluation", ("conversation",), "fixture")
    first_runtime = SocialRuntime(SocialRuntimeBinding(repository, scope, identity, role, "turn-1", creator_evidence=evidence))
    await first_runtime.restore_context()
    assert first_runtime.context.conversation_plan.snapshot_revision == first.revision
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
    staged = await repository.advance_conversation_stage(scope, expected_revision=restored.revision, target_stage="rapport", evidence_ids=(f"fixture:{raw['creator_ref']}:turn:1",), reason="synthetic response")
    second = await repository.record_event(scope, ExternalEvent("turn-2", f"fixture:{raw['creator_ref']}:turn:2", "operator_note", "Synthetic second turn"), expected_revision=staged.revision)
    second_runtime = SocialRuntime(SocialRuntimeBinding(repository, scope, identity, role, "turn-2", creator_evidence=evidence))
    second_context = await second_runtime.restore_context()
    try:
        await repository.advance_conversation_stage(scope, expected_revision=second.revision, target_stage="formal_invite", evidence_ids=(f"fixture:{raw['creator_ref']}:turn:2",), reason="synthetic pre-consent attempt")
        formal_allowed = True
    except ValueError:
        formal_allowed = False

    class FollowupRepo:
        def __init__(self):
            self.tasks = []

        async def list_by_user(self, user_id):
            return self.tasks

        async def create(self, **kwargs):
            self.tasks.append({"id": kwargs["task_id"], "user_id": kwargs["user_id"], "schedule_spec": kwargs["schedule_spec"]})

        async def get_internal(self, task_id):
            return next((item for item in self.tasks if item["id"] == task_id), None)

        async def get_active_run_status(self, task_id):
            return None

        async def pause_with_queue_cancellation(self, task_id, **kwargs):
            return "paused"

    followup_repo = FollowupRepo()
    followup_scheduler = SocialFollowupScheduler(followup_repo)
    from deerflow.social.contracts import FollowUp

    followup_id = await followup_scheduler.schedule(scope, thread_id=scope.channel_thread_ref, followup=FollowUp("synthetic check", "new event"), expected_revision=second.revision, cancel_event_id="turn-2")
    cancelled = await followup_scheduler.cancel_for_creator_event(scope, "turn-3")
    return {
        "creator_ref": raw["creator_ref"],
        "intelligence_snapshot_revision": committed.snapshot.revision,
        "plan_stage": second_context.conversation_plan.stage.value,
        "estimate": dict(second_context.conversation_plan.estimate),
        "memory_promotions": [item["memory_id"] for item in restored.relationship if item["status"] == "active"],
        "verified_funnel_stage": "discovery" if not formal_allowed else "formal_invite",
        "formal_invite_allowed": formal_allowed,
        "second_turn_loaded_memory": any(item.memory_id == "memory-1" for item in second_context.relationship.notes),
        "followup_task_id": followup_id,
        "followup_cancelled": followup_id in cancelled,
    }
