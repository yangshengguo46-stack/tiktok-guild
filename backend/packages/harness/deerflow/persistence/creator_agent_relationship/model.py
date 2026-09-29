"""One bounded relationship snapshot per operator, account, and creator UID."""

from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import JSON, Boolean, CheckConstraint, DateTime, Index, Integer, String, UniqueConstraint, text
from sqlalchemy.orm import Mapped, mapped_column

from deerflow.persistence.base import Base


def _utc_now() -> datetime:
    return datetime.now(UTC)


class CreatorAgentRelationshipRow(Base):
    __tablename__ = "creator_agent_relationship"

    owner_user_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    account_id: Mapped[str] = mapped_column(String(128), primary_key=True)
    creator_uid: Mapped[str] = mapped_column(String(128), primary_key=True)
    evidence_version: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    persona_revision: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    evidence_json: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    evidence_ids_json: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    facts_json: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    commitments_json: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    do_not_contact: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    persona_state_json: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    decision_ids_json: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=_utc_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=_utc_now)
    # Phase 0 fields above remain intact. New channel snapshots are independent
    # of its bounded evidence window and never reinterpret its untyped facts.
    social_snapshots_json: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    identity_verified: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="0")
    human_takeover: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="0")
    receipt_state: Mapped[str] = mapped_column(String(16), nullable=False, default="unknown", server_default="unknown")


class CreatorHandoffBatchRow(Base):
    __tablename__ = "creator_handoff_batch"

    owner_user_id: Mapped[str] = mapped_column(String(128), primary_key=True)
    batch_id: Mapped[str] = mapped_column(String(128), primary_key=True)
    dataset_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    provenance_json: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=_utc_now)


class CreatorHandoffCandidateRow(Base):
    __tablename__ = "creator_handoff_candidate"

    owner_user_id: Mapped[str] = mapped_column(String(128), primary_key=True)
    batch_id: Mapped[str] = mapped_column(String(128), primary_key=True)
    creator_uid: Mapped[str] = mapped_column(String(128), primary_key=True)
    payload_json: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=_utc_now)


class CreatorClaimRow(Base):
    __tablename__ = "creator_claim"

    owner_user_id: Mapped[str] = mapped_column(String(128), primary_key=True)
    creator_uid: Mapped[str] = mapped_column(String(128), primary_key=True)
    batch_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    dataset_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    candidate_payload_json: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="gray")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=_utc_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=_utc_now)

    __table_args__ = (CheckConstraint("status IN ('gray','public_touched','contacted','replied','closed')", name="ck_creator_claim_status"),)


class SenderAccountRow(Base):
    """A persisted sender identity used by one or more outreach sequences."""

    __tablename__ = "sender_account"

    owner_user_id: Mapped[str] = mapped_column(String(128), primary_key=True)
    sender_account_id: Mapped[str] = mapped_column(String(128), primary_key=True)
    channel: Mapped[str] = mapped_column(String(16), nullable=False)
    external_ref: Mapped[str | None] = mapped_column(String(255), nullable=True)
    profile_ref: Mapped[str | None] = mapped_column(String(255), nullable=True)
    device_ref: Mapped[str | None] = mapped_column(String(255), nullable=True)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="enabled", server_default="enabled")
    capabilities_json: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    last_health_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=_utc_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=_utc_now)

    __table_args__ = (
        UniqueConstraint("owner_user_id", "sender_account_id", name="uq_sender_account_owner_id"),
        CheckConstraint("channel IN ('web','ios')", name="ck_sender_account_channel"),
    )


class CreatorOutreachSequenceRow(Base):
    __tablename__ = "creator_outreach_sequence"

    owner_user_id: Mapped[str] = mapped_column(String(128), primary_key=True)
    creator_uid: Mapped[str] = mapped_column(String(128), primary_key=True)
    sequence_no: Mapped[int] = mapped_column(Integer, primary_key=True)
    sender_account_id: Mapped[str] = mapped_column(String(128), nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="pending")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=_utc_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=_utc_now)

    __table_args__ = (
        Index(
            "uq_creator_active_sequence",
            "owner_user_id",
            "creator_uid",
            unique=True,
            sqlite_where=text("status IN ('pending','public_touched','contacted','replied')"),
            postgresql_where=text("status IN ('pending','public_touched','contacted','replied')"),
        ),
        CheckConstraint("status IN ('pending','public_touched','contacted','replied','closed')", name="ck_creator_sequence_status"),
    )


class CreatorOutreachReceiptRow(Base):
    __tablename__ = "creator_outreach_receipt"

    owner_user_id: Mapped[str] = mapped_column(String(128), primary_key=True)
    creator_uid: Mapped[str] = mapped_column(String(128), primary_key=True)
    sequence_no: Mapped[int] = mapped_column(Integer, primary_key=True)
    receipt_id: Mapped[str] = mapped_column(String(128), primary_key=True)
    kind: Mapped[str] = mapped_column(String(32), nullable=False)
    provider_ref: Mapped[str | None] = mapped_column(String(128), nullable=True)
    verification_source: Mapped[str] = mapped_column(String(64), nullable=False)
    payload_json: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    verified: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=_utc_now)


class CreatorOutreachActionTaskRow(Base):
    """One durable, idempotent action in a creator outreach sequence."""

    __tablename__ = "creator_outreach_action_task"

    task_id: Mapped[str] = mapped_column(String(128), primary_key=True)
    owner_user_id: Mapped[str] = mapped_column(String(128), nullable=False)
    creator_uid: Mapped[str] = mapped_column(String(128), nullable=False)
    sequence_no: Mapped[int] = mapped_column(Integer, nullable=False)
    sender_account_id: Mapped[str] = mapped_column(String(128), nullable=False)
    action: Mapped[str] = mapped_column(String(16), nullable=False)
    idempotency_key: Mapped[str] = mapped_column(String(255), nullable=False)
    state: Mapped[str] = mapped_column(String(16), nullable=False, default="pending", server_default="pending")
    payload_json: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    attempt_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    lease_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    lease_owner: Mapped[str | None] = mapped_column(String(128), nullable=True)
    lease_token: Mapped[str | None] = mapped_column(String(128), nullable=True)
    receipt_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    error_code: Mapped[str | None] = mapped_column(String(128), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=_utc_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=_utc_now)

    __table_args__ = (
        UniqueConstraint("owner_user_id", "idempotency_key", name="uq_creator_outreach_action_idempotency"),
        Index(
            "uq_creator_outreach_active_action",
            "owner_user_id",
            "creator_uid",
            "sequence_no",
            "action",
            unique=True,
            sqlite_where=text("state IN ('pending','leased')"),
            postgresql_where=text("state IN ('pending','leased')"),
        ),
        CheckConstraint("action IN ('like','comment','follow','message')", name="ck_creator_outreach_action"),
        CheckConstraint("state IN ('pending','leased','completed','failed')", name="ck_creator_outreach_action_state"),
    )
