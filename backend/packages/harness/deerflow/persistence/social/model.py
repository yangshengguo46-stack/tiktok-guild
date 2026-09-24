"""Persistence DTOs and tables; these are host inputs, never model output fields."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime
from typing import Literal

import sqlalchemy as sa

from deerflow.persistence.base import Base
from deerflow.social.contracts import SocialScope, bounded_refs, bounded_text
from deerflow.social.persona.models import EffectivePersona, PersonaBindings, ProfileScope, _expression


@dataclass(frozen=True)
class SocialConnectionGuard:
    """Host-resolved connection identity revalidated at send authorization."""

    connection_id: str
    owner_user_id: str
    provider: str
    external_account_id: str
    workspace_id: str

    def __post_init__(self):
        for name, limit in (("connection_id", 64), ("owner_user_id", 64), ("provider", 32), ("external_account_id", 128), ("workspace_id", 128)):
            bounded_text(getattr(self, name), name, limit, allow_empty=name == "workspace_id")


@dataclass(frozen=True)
class ExternalEvent:
    source_event_id: str
    source_ref: str
    source_kind: Literal["creator_message", "operator_note", "platform_observation"]
    text: str

    def __post_init__(self):
        bounded_text(self.source_event_id, "source_event_id", 128)
        bounded_text(self.source_ref, "source_ref", 128)
        bounded_text(self.text, "text", 16384)
        if self.source_kind not in {"creator_message", "operator_note", "platform_observation"}:
            raise ValueError("invalid source_kind")


@dataclass(frozen=True)
class SelfMemoryChange:
    op: Literal["assert", "retract"]
    memory_id: str
    category: Literal["self_statement", "self_viewpoint", "commitment", "relationship"]
    evidence_ids: tuple[str, ...]
    text: str | None = None

    def __post_init__(self):
        bounded_text(self.memory_id, "memory_id", 128)
        bounded_refs(self.evidence_ids, "evidence_ids", minimum=1)
        if self.category not in {"self_statement", "self_viewpoint", "commitment", "relationship"}:
            raise ValueError("invalid memory category")
        if self.op == "assert":
            bounded_text(self.text, "text", 2048)
        elif self.op != "retract" or self.text is not None:
            raise ValueError("invalid memory operation")


@dataclass(frozen=True)
class BoundaryUpdate:
    identity_verified: bool
    human_takeover: bool
    do_not_contact: bool
    evidence_ids: tuple[str, ...]

    def __post_init__(self):
        if any(type(value) is not bool for value in (self.identity_verified, self.human_takeover, self.do_not_contact)):
            raise ValueError("boundaries must be authoritative booleans")
        bounded_refs(self.evidence_ids, "evidence_ids", minimum=1)


@dataclass(frozen=True)
class TurnAdjustment:
    """Server-owned ephemeral expression input, never a TurnResult field."""

    values: Mapping[str, str | tuple[str, ...]]
    source_ref: str
    evidence_ids: tuple[str, ...] = ()

    def __post_init__(self):
        bounded_text(self.source_ref, "source_ref", 128)
        bounded_refs(self.evidence_ids, "evidence_ids")
        if not isinstance(self.values, Mapping) or "core" in self.values:
            raise ValueError("turn adjustment must contain only ephemeral expression fields")
        object.__setattr__(self, "values", _expression(self.values))

    def to_payload(self):
        return {"values": {key: list(value) if isinstance(value, tuple) else value for key, value in self.values.items()}, "source_ref": self.source_ref, "evidence_ids": list(self.evidence_ids)}


@dataclass(frozen=True)
class Outbound:
    action_id: str
    turn_revision: int
    persona_fingerprint: str
    reply_text: str
    state: str
    provider_ref: str | None
    revision: int
    evidence_ids: tuple[str, ...]
    turn_context: dict


@dataclass(frozen=True)
class SocialSnapshot:
    scope: SocialScope
    revision: int = 0
    claims: tuple[dict, ...] = ()
    self_state: tuple[dict, ...] = ()
    commitments: tuple[dict, ...] = ()
    relationship: tuple[dict, ...] = ()
    events: tuple[dict, ...] = ()
    outbound: tuple[Outbound, ...] = ()
    identity_verified: bool = False
    human_takeover: bool = False
    do_not_contact: bool = False
    receipt_state: str = "unknown"
    boundary_history: tuple[dict, ...] = ()
    followup: dict | None = None
    effective_persona: EffectivePersona | None = None
    evaluated_persona_evidence_version: int = 0
    persona_evaluation: dict | None = None


@dataclass(frozen=True)
class PersonaEvaluationClaim:
    """Host-only, durable at-most-once selector capability; never model input."""

    scope: SocialScope
    event_id: str
    evidence_version: int
    binding_generation: int
    token: str


@dataclass(frozen=True)
class CommitResult:
    snapshot: SocialSnapshot
    outbound: Outbound | None


@dataclass(frozen=True)
class OutboundClaim:
    outbound: Outbound
    claimed: bool


@dataclass(frozen=True)
class BindingState:
    """write_revision is the CAS token; bindings.revision is the resolved view."""

    write_revision: int
    bindings: PersonaBindings
    source_scope: ProfileScope | None
    source_revision: int
    source_effective_at: datetime | None


class SocialConflictError(RuntimeError):
    """CAS loser; snapshot is the winning social/profile/binding value."""

    def __init__(self, snapshot):
        super().__init__("social revision conflict")
        self.snapshot = snapshot


def _scope_columns():
    return [sa.Column("owner_user_id", sa.String(128), primary_key=True), sa.Column("account_id", sa.String(128), primary_key=True)]


social_event = sa.Table(
    "social_event",
    Base.metadata,
    *_scope_columns(),
    sa.Column("person_ref", sa.String(128), primary_key=True),
    sa.Column("channel_thread_ref", sa.String(128), primary_key=True),
    sa.Column("agent_instance_id", sa.String(128), primary_key=True),
    sa.Column("source_event_id", sa.String(128), primary_key=True),
    sa.Column("payload_digest", sa.String(64), nullable=False),
    sa.Column("source_kind", sa.String(32), nullable=False),
    sa.Column("body_json", sa.JSON, nullable=False),
    sa.Column("turn_digest", sa.String(64)),
    sa.Column("turn_context_json", sa.JSON),
    sa.Column("action_id", sa.String(64)),
    sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
)
social_persona_profile = sa.Table(
    "social_persona_profile",
    Base.metadata,
    *_scope_columns(),
    sa.Column("profile_id", sa.String(128), primary_key=True),
    sa.Column("version", sa.String(128), primary_key=True),
    sa.Column("revision", sa.Integer, nullable=False),
    sa.Column("profile_json", sa.JSON, nullable=False),
    sa.Column("basis_refs_json", sa.JSON, nullable=False),
    sa.Column("status", sa.String(32), nullable=False),
    sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    sa.UniqueConstraint("owner_user_id", "account_id", "revision", name="uq_social_profile_revision"),
)
social_persona_binding = sa.Table(
    "social_persona_binding",
    Base.metadata,
    *_scope_columns(),
    sa.Column("scope_key", sa.String(64), primary_key=True),
    sa.Column("agent_instance_id", sa.String(128)),
    sa.Column("relation_ref", sa.String(128)),
    sa.Column("revision", sa.Integer, primary_key=True),
    sa.Column("generation", sa.Integer, nullable=False),
    sa.Column("profile_ref", sa.String(257)),
    sa.Column("reason", sa.String(512), nullable=False),
    sa.Column("evidence_refs_json", sa.JSON, nullable=False),
    sa.Column("status", sa.String(16), nullable=False),
    sa.Column("effective_at", sa.DateTime(timezone=True), nullable=False),
    sa.UniqueConstraint("owner_user_id", "account_id", "generation", name="uq_social_binding_generation"),
)
# NULLs compare unequal in a regular SQLite unique index. Canonical non-null
# scope_key fences writes, while this index also protects direct SQL consumers.
sa.Index(
    "uq_social_binding_nullable_scope",
    social_persona_binding.c.owner_user_id,
    social_persona_binding.c.account_id,
    sa.func.coalesce(social_persona_binding.c.agent_instance_id, ""),
    sa.func.coalesce(social_persona_binding.c.relation_ref, ""),
    social_persona_binding.c.revision,
    unique=True,
)
social_outbound = sa.Table(
    "social_outbound",
    Base.metadata,
    *_scope_columns(),
    sa.Column("relation_ref", sa.String(128), nullable=False),
    sa.Column("channel_thread_ref", sa.String(128), nullable=False),
    sa.Column("agent_instance_id", sa.String(128), nullable=False),
    sa.Column("action_id", sa.String(64), primary_key=True),
    sa.Column("turn_revision", sa.Integer, nullable=False),
    sa.Column("persona_fingerprint", sa.String(64), nullable=False),
    sa.Column("reply_text", sa.Text, nullable=False),
    sa.Column("state", sa.String(16), nullable=False),
    sa.Column("provider_ref", sa.String(128)),
    sa.Column("revision", sa.Integer, nullable=False),
    sa.Column("evidence_ids_json", sa.JSON, nullable=False),
    sa.Column("history_json", sa.JSON, nullable=False),
    sa.Column("turn_context_json", sa.JSON, nullable=False),
    sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    sa.CheckConstraint("state IN ('pending','accepted','delivered','unknown','failed')", name="ck_social_outbound_state"),
    sa.UniqueConstraint("owner_user_id", "account_id", "relation_ref", "channel_thread_ref", "agent_instance_id", "turn_revision", name="uq_social_outbound_turn"),
)
