"""Persist TKDesk handoffs, global creator claims and outreach sequences."""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0027_creator_outreach"
down_revision: str | Sequence[str] | None = "0026_social_runtime"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if not inspector.has_table("creator_handoff_batch"):
        op.create_table(
            "creator_handoff_batch",
            sa.Column("owner_user_id", sa.String(128), nullable=False),
            sa.Column("batch_id", sa.String(128), nullable=False),
            sa.Column("dataset_hash", sa.String(64), nullable=False),
            sa.Column("provenance_json", sa.JSON(), nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.PrimaryKeyConstraint("owner_user_id", "batch_id"),
        )
    if not inspector.has_table("creator_handoff_candidate"):
        op.create_table(
            "creator_handoff_candidate",
            sa.Column("owner_user_id", sa.String(128), nullable=False),
            sa.Column("batch_id", sa.String(128), nullable=False),
            sa.Column("creator_uid", sa.String(128), nullable=False),
            sa.Column("payload_json", sa.JSON(), nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.PrimaryKeyConstraint("owner_user_id", "batch_id", "creator_uid"),
        )
        op.create_index("ix_creator_handoff_candidate_creator", "creator_handoff_candidate", ["owner_user_id", "creator_uid"])
    if not inspector.has_table("creator_claim"):
        op.create_table(
            "creator_claim",
            sa.Column("owner_user_id", sa.String(128), nullable=False),
            sa.Column("creator_uid", sa.String(128), nullable=False),
            sa.Column("batch_id", sa.String(128), nullable=True),
            sa.Column("dataset_hash", sa.String(64), nullable=True),
            sa.Column("candidate_payload_json", sa.JSON(), nullable=False),
            sa.Column("status", sa.String(32), nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
            sa.PrimaryKeyConstraint("owner_user_id", "creator_uid"),
            sa.CheckConstraint("status IN ('gray','public_touched','contacted','replied','closed')", name="ck_creator_claim_status"),
        )
    if not inspector.has_table("creator_outreach_sequence"):
        op.create_table(
            "creator_outreach_sequence",
            sa.Column("owner_user_id", sa.String(128), nullable=False),
            sa.Column("creator_uid", sa.String(128), nullable=False),
            sa.Column("sequence_no", sa.Integer(), nullable=False),
            sa.Column("sender_account_id", sa.String(128), nullable=False),
            sa.Column("status", sa.String(32), nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
            sa.PrimaryKeyConstraint("owner_user_id", "creator_uid", "sequence_no"),
            sa.CheckConstraint("status IN ('pending','public_touched','contacted','replied','closed')", name="ck_creator_sequence_status"),
        )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if inspector.has_table("creator_outreach_sequence"):
        op.drop_table("creator_outreach_sequence")
    if inspector.has_table("creator_claim"):
        op.drop_table("creator_claim")
    if inspector.has_table("creator_handoff_candidate"):
        op.drop_index("ix_creator_handoff_candidate_creator", table_name="creator_handoff_candidate")
        op.drop_table("creator_handoff_candidate")
    if inspector.has_table("creator_handoff_batch"):
        op.drop_table("creator_handoff_batch")
