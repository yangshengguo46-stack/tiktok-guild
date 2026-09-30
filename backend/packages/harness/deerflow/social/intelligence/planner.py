"""Deterministic conversation planning over a creator intelligence snapshot."""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from enum import StrEnum
from typing import Any

from deerflow.social.contracts import bounded_refs, bounded_text

from .evidence import CreatorIntelligenceSnapshot


class ConversationStage(StrEnum):
    first_contact = "first_contact"
    rapport = "rapport"
    discovery = "discovery"
    value_fit = "value_fit"
    objection_handling = "objection_handling"
    permission_to_invite = "permission_to_invite"
    formal_invite = "formal_invite"
    application = "application"
    signed = "signed"
    paused = "paused"
    human_takeover = "human_takeover"


_NEXT = {
    ConversationStage.first_contact: "rapport",
    ConversationStage.rapport: "discovery",
    ConversationStage.discovery: "value_fit",
    ConversationStage.value_fit: "objection_handling",
    ConversationStage.objection_handling: "permission_to_invite",
    ConversationStage.permission_to_invite: "formal_invite",
    ConversationStage.formal_invite: "application",
    ConversationStage.application: "signed",
    ConversationStage.signed: "signed",
    ConversationStage.paused: "paused",
    ConversationStage.human_takeover: "human_takeover",
}
_OBJECTIVES = {
    ConversationStage.first_contact: "establish relevance from one current work",
    ConversationStage.rapport: "invite the creator to correct or deepen the observation",
    ConversationStage.discovery: "verify the creator's current goal",
    ConversationStage.value_fit: "explain only the benefit relevant to the creator's stated goal",
    ConversationStage.objection_handling: "clarify and answer the creator's stated concern",
    ConversationStage.permission_to_invite: "ask permission to send the formal invitation",
    ConversationStage.formal_invite: "send transparent formal terms after permission",
    ConversationStage.application: "support an explicit application action",
    ConversationStage.signed: "confirm the verified signing receipt",
    ConversationStage.paused: "leave space and wait for a safe re-entry signal",
    ConversationStage.human_takeover: "prepare a concise handoff for a human operator",
}


@dataclass(frozen=True)
class ConversationPlan:
    plan_id: str
    snapshot_revision: int
    stage: ConversationStage
    opening_candidates: tuple[dict[str, Any], ...]
    avoid: tuple[str, ...]
    turns: tuple[dict[str, Any], ...]
    consent_checkpoint: str
    stop_conditions: tuple[str, ...]
    estimate: dict[str, Any]

    def __post_init__(self) -> None:
        bounded_text(self.plan_id, "plan_id", 128)
        if not isinstance(self.stage, ConversationStage) or not isinstance(self.snapshot_revision, int) or self.snapshot_revision < 0:
            raise ValueError("invalid plan stage or revision")
        if not isinstance(self.opening_candidates, tuple) or len(self.opening_candidates) > 3:
            raise ValueError("opening_candidates must contain at most three entries")
        if not isinstance(self.turns, tuple) or not self.turns:
            raise ValueError("turns must contain at least one objective")
        for turn in self.turns:
            if not isinstance(turn, dict) or set(("objective", "allowed_evidence_ids", "success_signal", "next_if_yes", "next_if_no")) - turn.keys():
                raise ValueError("each turn must contain one bounded objective and exit signal")
            bounded_text(turn["objective"], "objective", 512)
            bounded_refs(tuple(turn["allowed_evidence_ids"]), "allowed_evidence_ids", maximum=64)
        bounded_text(self.consent_checkpoint, "consent_checkpoint", 128)
        bounded_refs(self.stop_conditions, "stop_conditions", maximum=16, minimum=1)
        if not isinstance(self.estimate, dict) or self.estimate.get("p50_turns", 0) < 1 or self.estimate.get("p80_turns", 0) < self.estimate.get("p50_turns", 0):
            raise ValueError("estimate must contain ordered turn bounds")


def plan_conversation(snapshot: CreatorIntelligenceSnapshot, *, stage: ConversationStage, relationship_signals=(), goal: str | None = None) -> ConversationPlan:
    if not isinstance(snapshot, CreatorIntelligenceSnapshot) or not isinstance(stage, ConversationStage):
        raise ValueError("snapshot and stage are required")
    works = sorted(snapshot.works, key=lambda item: (item.captured_at, item.evidence_id), reverse=True)[:3]
    openings = tuple({"text": f"I noticed {work.text}. What is your current experience with that format?", "evidence_ids": (work.evidence_id,)} for work in works)
    objective = _OBJECTIVES[stage]
    if stage == ConversationStage.discovery and goal:
        objective = f"verify whether the creator wants help with {goal}"
    allowed = tuple(snapshot.evidence_refs)
    next_stage = _NEXT[stage]
    turns = ({"objective": objective, "allowed_evidence_ids": allowed, "success_signal": "creator responds or corrects the picture", "next_if_yes": next_stage, "next_if_no": "paused"},)
    basis = ["current scoped evidence", f"stage:{stage.value}"]
    if not relationship_signals:
        confidence = 0.35
        basis.append("no verified response history")
    else:
        confidence = 0.5
        basis.append("verified response history")
    raw_id = f"{snapshot.revision}:{stage.value}:{','.join(snapshot.evidence_refs)}"
    plan_id = "plan-" + hashlib.sha256(raw_id.encode()).hexdigest()[:16]
    return ConversationPlan(
        plan_id,
        snapshot.revision,
        stage,
        openings,
        ("unsupported assumption", "pressure after a no"),
        turns,
        "before_formal_invitation",
        ("creator says stop", "identity uncertain", "provider result unknown"),
        {"p50_turns": 4, "p80_turns": 8, "confidence": confidence, "basis": tuple(basis)},
    )
