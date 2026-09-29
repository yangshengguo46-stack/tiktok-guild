"""Persist verified outreach receipts and enforce one active sender sequence."""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0028_creator_outreach_receipts"
down_revision: str | Sequence[str] | None = "0027_creator_outreach"
branch_labels = None
depends_on = None


def _index_names(bind) -> set[str]:
    return {item["name"] for item in sa.inspect(bind).get_indexes("creator_outreach_sequence")}


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if inspector.has_table("creator_outreach_sequence") and "uq_creator_active_sequence" not in _index_names(bind):
        op.create_index(
            "uq_creator_active_sequence",
            "creator_outreach_sequence",
            ["owner_user_id", "creator_uid"],
            unique=True,
            sqlite_where=sa.text("status IN ('pending','public_touched','contacted','replied')"),
            postgresql_where=sa.text("status IN ('pending','public_touched','contacted','replied')"),
        )
    if not inspector.has_table("creator_outreach_receipt"):
        op.create_table(
            "creator_outreach_receipt",
            sa.Column("owner_user_id", sa.String(128), nullable=False),
            sa.Column("creator_uid", sa.String(128), nullable=False),
            sa.Column("sequence_no", sa.Integer(), nullable=False),
            sa.Column("receipt_id", sa.String(128), nullable=False),
            sa.Column("kind", sa.String(32), nullable=False),
            sa.Column("provider_ref", sa.String(128), nullable=True),
            sa.Column("verification_source", sa.String(64), nullable=False),
            sa.Column("payload_json", sa.JSON(), nullable=False),
            sa.Column("verified", sa.Boolean(), nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.PrimaryKeyConstraint("owner_user_id", "creator_uid", "sequence_no", "receipt_id"),
        )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if inspector.has_table("creator_outreach_receipt"):
        op.drop_table("creator_outreach_receipt")
    if inspector.has_table("creator_outreach_sequence") and "uq_creator_active_sequence" in _index_names(bind):
        op.drop_index("uq_creator_active_sequence", table_name="creator_outreach_sequence")
