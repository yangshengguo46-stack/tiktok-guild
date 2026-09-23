"""Immutable, bounded values at the native social-turn boundary.

These values do not authenticate a caller or authorize a channel action. The
host supplies scope and verifies evidence provenance before using them.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum
from typing import Literal


def bounded_text(value: str, name: str, limit: int, *, allow_empty: bool = False) -> None:
    if not isinstance(value, str) or len(value) > limit or (not allow_empty and not value.strip()):
        raise ValueError(f"{name} must be nonblank text of at most {limit} characters")


def bounded_refs(values: tuple[str, ...], name: str, *, maximum: int = 16, minimum: int = 0) -> None:
    if not isinstance(values, tuple) or not minimum <= len(values) <= maximum:
        raise ValueError(f"{name} must contain {minimum} to {maximum} references")
    for value in values:
        bounded_text(value, name, 128)
    if len(values) != len(set(values)):
        raise ValueError(f"{name} must not contain duplicate references")


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

    def __post_init__(self) -> None:
        for name in ("owner_user_id", "account_id", "person_ref", "channel_thread_ref", "agent_instance_id"):
            bounded_text(getattr(self, name), name, 128)


@dataclass(frozen=True)
class IdentityProfile:
    identity_id: str
    version: str
    public_display_name: str
    entity_kind: Literal["ai_agent"]
    represented_organization: str
    disclosure: str
    verified_fact_refs: tuple[str, ...]

    def __post_init__(self) -> None:
        for name in ("identity_id", "version", "public_display_name", "represented_organization"):
            bounded_text(getattr(self, name), name, 128)
        bounded_text(self.disclosure, "disclosure", 512)
        if self.entity_kind != "ai_agent":
            raise ValueError("identity entity_kind must be ai_agent")
        bounded_refs(self.verified_fact_refs, "verified_fact_refs")


@dataclass(frozen=True)
class RoleProfile:
    role_id: str
    version: str
    responsibility: str
    capability_names: tuple[str, ...]
    authorization_ref: str

    def __post_init__(self) -> None:
        bounded_text(self.role_id, "role_id", 128)
        bounded_text(self.version, "version", 128)
        bounded_text(self.responsibility, "responsibility", 512)
        bounded_refs(self.capability_names, "capability_names", minimum=1)
        bounded_text(self.authorization_ref, "authorization_ref", 128)


@dataclass(frozen=True)
class ClaimPatch:
    op: Literal["assert", "retract"]
    claim_id: str
    evidence_ids: tuple[str, ...]
    text: str | None = None
    kind: Literal["reported", "observed", "hypothesis"] | None = None
    facet: Literal["person", "tradeoff", "relationship", "conversation", "shared_topic", "next_step"] | None = None

    def __post_init__(self) -> None:
        if self.op not in {"assert", "retract"}:
            raise ValueError("claim op must be assert or retract")
        bounded_text(self.claim_id, "claim_id", 128)
        bounded_refs(self.evidence_ids, "evidence_ids", minimum=1)
        if self.op == "assert":
            bounded_text(self.text, "text", 2048)  # type: ignore[arg-type]
            if self.kind not in {"reported", "observed", "hypothesis"}:
                raise ValueError("invalid claim source kind")
            if self.facet not in {"person", "tradeoff", "relationship", "conversation", "shared_topic", "next_step"}:
                raise ValueError("invalid claim facet")
        elif self.text is not None or self.kind is not None or self.facet is not None:
            raise ValueError("retract may only refer to an existing claim")


@dataclass(frozen=True)
class FollowUp:
    check: str
    cancel_when: str
    not_before: str | None = None

    def __post_init__(self) -> None:
        bounded_text(self.check, "check", 512)
        bounded_text(self.cancel_when, "cancel_when", 512)
        if self.not_before is not None:
            bounded_text(self.not_before, "not_before", 64)
            try:
                parsed = datetime.fromisoformat(self.not_before.replace("Z", "+00:00"))
            except ValueError as error:
                raise ValueError("not_before must be ISO-8601") from error
            if parsed.tzinfo is None or parsed.utcoffset() is None:
                raise ValueError("not_before requires an explicit timezone")


@dataclass(frozen=True)
class TurnResult:
    reply: str | None
    state_delta: tuple[ClaimPatch, ...] = ()
    decision_note: str = ""
    followup: FollowUp | None = None

    def __post_init__(self) -> None:
        if self.reply is not None:
            bounded_text(self.reply, "reply", 4096)
        if not isinstance(self.state_delta, tuple) or len(self.state_delta) > 16 or any(not isinstance(patch, ClaimPatch) for patch in self.state_delta):
            raise ValueError("state_delta must contain at most 16 claim patches")
        claim_ids = [patch.claim_id for patch in self.state_delta]
        if len(claim_ids) != len(set(claim_ids)):
            raise ValueError("at most one patch per claim per turn")
        bounded_text(self.decision_note, "decision_note", 240, allow_empty=True)
        if self.followup is not None and not isinstance(self.followup, FollowUp):
            raise ValueError("followup must be a FollowUp")

    @property
    def action(self) -> SocialAction:
        if self.reply is not None:
            return SocialAction.REPLY
        return SocialAction.WAIT if self.followup is not None else SocialAction.NO_REPLY
