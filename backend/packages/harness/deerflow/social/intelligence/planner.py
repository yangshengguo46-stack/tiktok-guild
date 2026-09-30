"""Deterministic conversation planning over a creator intelligence snapshot."""

from __future__ import annotations

import hashlib
from collections.abc import Mapping
from dataclasses import dataclass
from enum import StrEnum
from types import MappingProxyType
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
_REQUIRED_TURN_KEYS = {"objective", "allowed_evidence_ids", "success_signal", "next_if_yes", "next_if_no"}


def _freeze(value: Mapping[str, Any]) -> MappingProxyType:
    return MappingProxyType(dict(value))


@dataclass(frozen=True)
class ConversationPlan:
    plan_id: str
    snapshot_revision: int
    stage: ConversationStage
    opening_candidates: tuple[Mapping[str, Any], ...]
    avoid: tuple[str, ...]
    turns: tuple[Mapping[str, Any], ...]
    consent_checkpoint: str
    stop_conditions: tuple[str, ...]
    estimate: Mapping[str, Any]
    consent_evidence_ids: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        bounded_text(self.plan_id, "plan_id", 128)
        if not isinstance(self.stage, ConversationStage) or not isinstance(self.snapshot_revision, int) or isinstance(self.snapshot_revision, bool) or self.snapshot_revision < 0:
            raise ValueError("invalid plan stage or revision")
        if not isinstance(self.opening_candidates, tuple) or len(self.opening_candidates) > 3:
            raise ValueError("opening_candidates must contain at most three entries")
        frozen_openings = []
        for candidate in self.opening_candidates:
            if not isinstance(candidate, Mapping) or set(candidate) != {"text", "evidence_ids"}:
                raise ValueError("each opening candidate must contain text and evidence_ids")
            bounded_text(candidate["text"], "opening text", 512)
            ids = candidate["evidence_ids"]
            bounded_refs(ids, "opening evidence_ids", maximum=64, minimum=1)
            frozen_openings.append(_freeze({"text": candidate["text"], "evidence_ids": ids}))
        object.__setattr__(self, "opening_candidates", tuple(frozen_openings))
        bounded_refs(self.avoid, "avoid", maximum=16)
        if not isinstance(self.turns, tuple) or not self.turns:
            raise ValueError("turns must contain at least one objective")
        frozen_turns = []
        for turn in self.turns:
            if not isinstance(turn, Mapping) or set(turn) != _REQUIRED_TURN_KEYS:
                raise ValueError("each turn must contain one bounded objective and exit signal")
            bounded_text(turn["objective"], "objective", 512)
            bounded_text(turn["success_signal"], "success_signal", 512)
            bounded_text(turn["next_if_yes"], "next_if_yes", 64)
            bounded_text(turn["next_if_no"], "next_if_no", 64)
            ids = turn["allowed_evidence_ids"]
            bounded_refs(ids, "allowed_evidence_ids", maximum=64)
            frozen_turns.append(_freeze({**turn, "allowed_evidence_ids": ids}))
        object.__setattr__(self, "turns", tuple(frozen_turns))
        bounded_text(self.consent_checkpoint, "consent_checkpoint", 128)
        bounded_refs(self.stop_conditions, "stop_conditions", maximum=16, minimum=1)
        bounded_refs(self.consent_evidence_ids, "consent_evidence_ids", maximum=16)
        if self.stage == ConversationStage.formal_invite and not self.consent_evidence_ids:
            raise ValueError("formal_invite plan requires consent evidence")
        if not isinstance(self.estimate, Mapping):
            raise ValueError("estimate must be a mapping")
        if set(self.estimate) != {"p50_turns", "p80_turns", "confidence", "basis"}:
            raise ValueError("estimate has invalid fields")
        p50, p80, confidence, basis = (self.estimate[k] for k in ("p50_turns", "p80_turns", "confidence", "basis"))
        if not isinstance(p50, int) or isinstance(p50, bool) or p50 < 1 or not isinstance(p80, int) or isinstance(p80, bool) or p80 < p50:
            raise ValueError("estimate must contain ordered integer turn bounds")
        if not isinstance(confidence, (int, float)) or isinstance(confidence, bool) or not 0 <= confidence <= 1:
            raise ValueError("estimate confidence must be between 0 and 1")
        bounded_refs(basis, "estimate basis", maximum=16, minimum=1)
        object.__setattr__(self, "estimate", _freeze(dict(self.estimate)))

    def to_payload(self) -> dict:
        """Bounded JSON projection safe for the social snapshot."""
        return {
            "plan_id": self.plan_id,
            "snapshot_revision": self.snapshot_revision,
            "stage": self.stage.value,
            "opening_candidates": [{"text": item["text"], "evidence_ids": list(item["evidence_ids"])} for item in self.opening_candidates],
            "avoid": list(self.avoid),
            "turns": [{**turn, "allowed_evidence_ids": list(turn["allowed_evidence_ids"])} for turn in self.turns],
            "consent_checkpoint": self.consent_checkpoint,
            "stop_conditions": list(self.stop_conditions),
            "estimate": dict(self.estimate),
            "consent_evidence_ids": list(self.consent_evidence_ids),
        }

    @classmethod
    def from_payload(cls, payload: Mapping[str, Any]) -> ConversationPlan:
        """Validate and rehydrate a host-persisted plan projection.

        Persisted plans are data, not authority.  Rehydration deliberately
        accepts only the exact bounded JSON shape emitted by ``to_payload``;
        malformed or extended projections fail closed at the runtime boundary.
        """
        required_fields = {
            "plan_id",
            "snapshot_revision",
            "stage",
            "opening_candidates",
            "avoid",
            "turns",
            "consent_checkpoint",
            "stop_conditions",
            "estimate",
        }
        payload_fields = set(payload) if isinstance(payload, Mapping) else None
        if payload_fields not in (required_fields, required_fields | {"consent_evidence_ids"}):
            raise ValueError("persisted conversation_plan has invalid fields")
        try:
            stage = ConversationStage(payload["stage"])
        except (TypeError, ValueError) as exc:
            raise ValueError("persisted conversation_plan has invalid stage") from exc
        openings = payload["opening_candidates"]
        turns = payload["turns"]
        estimate = payload["estimate"]
        avoid = payload["avoid"]
        stop_conditions = payload["stop_conditions"]
        consent_evidence_ids = payload.get("consent_evidence_ids", ())
        if (
            not isinstance(openings, (list, tuple))
            or not isinstance(turns, (list, tuple))
            or not isinstance(estimate, Mapping)
            or not isinstance(avoid, (list, tuple))
            or not isinstance(stop_conditions, (list, tuple))
            or not isinstance(consent_evidence_ids, (list, tuple))
        ):
            raise ValueError("persisted conversation_plan has invalid nested values")
        normalized_openings = tuple(
            {"text": item["text"], "evidence_ids": tuple(item["evidence_ids"])} if isinstance(item, Mapping) and set(item) == {"text", "evidence_ids"} and isinstance(item["evidence_ids"], (list, tuple)) else item for item in openings
        )
        normalized_turns = tuple(
            {**item, "allowed_evidence_ids": tuple(item["allowed_evidence_ids"])} if isinstance(item, Mapping) and set(item) == _REQUIRED_TURN_KEYS and isinstance(item["allowed_evidence_ids"], (list, tuple)) else item for item in turns
        )
        normalized_estimate = dict(estimate)
        raw_basis = normalized_estimate.get("basis")
        if not isinstance(raw_basis, (list, tuple)):
            raise ValueError("persisted conversation_plan has invalid estimate basis")
        normalized_estimate["basis"] = tuple(raw_basis)
        return cls(
            payload["plan_id"],
            payload["snapshot_revision"],
            stage,
            normalized_openings,
            tuple(avoid),
            normalized_turns,
            payload["consent_checkpoint"],
            tuple(stop_conditions),
            normalized_estimate,
            tuple(consent_evidence_ids),
        )


def plan_conversation(
    snapshot: CreatorIntelligenceSnapshot,
    *,
    stage: ConversationStage,
    relationship_signals=(),
    goal: str | None = None,
    consent_evidence_ids: tuple[str, ...] = (),
) -> ConversationPlan:
    if not isinstance(snapshot, CreatorIntelligenceSnapshot) or not isinstance(stage, ConversationStage):
        raise ValueError("snapshot and stage are required")
    if goal is not None:
        bounded_text(goal, "goal", 512)
    bounded_refs(consent_evidence_ids, "consent_evidence_ids", maximum=16)
    if stage == ConversationStage.formal_invite and not consent_evidence_ids:
        raise ValueError("formal_invite planning requires typed creator consent evidence")
    records = [(item, 0) for item in snapshot.works] + [(item, 1) for item in snapshot.identity]
    records.sort(key=lambda pair: (pair[0].captured_at, -pair[1], pair[0].evidence_id), reverse=True)
    selected = records[:3]
    openings = tuple(
        {
            "text": (f"I noticed {item.text}. What is your current experience with that format?" if item.kind == "content" else f"I read your profile note: {item.text}. Is that still a useful way to understand your work?"),
            "evidence_ids": (item.evidence_id,),
        }
        for item, _ in selected
    )
    objective = _OBJECTIVES[stage]
    if stage == ConversationStage.discovery and goal is not None:
        objective = f"verify whether the creator wants help with {goal}"
    source_refs = tuple(item.source_ref for group in (snapshot.identity, snapshot.works, snapshot.signals) for item in group)
    allowed = tuple(dict.fromkeys((*snapshot.evidence_refs, *source_refs, *consent_evidence_ids)))
    turns = ({"objective": objective, "allowed_evidence_ids": allowed, "success_signal": "creator responds or corrects the picture", "next_if_yes": _NEXT[stage], "next_if_no": "paused"},)
    basis = ["current scoped evidence", f"stage:{stage.value}"]
    confidence = 0.35 if not relationship_signals else 0.5
    basis.append("no verified response history" if not relationship_signals else "verified response history")
    raw_id = f"{snapshot.revision}:{stage.value}:{','.join(allowed)}"
    return ConversationPlan(
        "plan-" + hashlib.sha256(raw_id.encode()).hexdigest()[:16],
        snapshot.revision,
        stage,
        openings,
        ("unsupported assumption", "pressure after a no"),
        turns,
        "before_formal_invitation",
        ("creator says stop", "identity uncertain", "provider result unknown"),
        {"p50_turns": 4, "p80_turns": 8, "confidence": confidence, "basis": tuple(basis)},
        tuple(consent_evidence_ids),
    )
