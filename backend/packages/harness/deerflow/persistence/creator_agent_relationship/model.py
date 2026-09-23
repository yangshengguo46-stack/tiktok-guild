"""One bounded relationship snapshot per operator, account, and creator UID."""

from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import JSON, Boolean, DateTime, Integer, String
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
