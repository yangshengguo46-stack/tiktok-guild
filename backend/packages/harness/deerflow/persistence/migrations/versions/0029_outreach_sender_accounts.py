"""Persist native outreach sender accounts.

Revision ID: 0029_outreach_sender_accounts
Revises: 0028_creator_outreach_receipts
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0029_outreach_sender_accounts"
down_revision: str | Sequence[str] | None = "0028_creator_outreach_receipts"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    if sa.inspect(op.get_bind()).has_table("sender_account"):
        return
    op.create_table(
        "sender_account",
        sa.Column("owner_user_id", sa.String(length=128), nullable=False),
        sa.Column("sender_account_id", sa.String(length=128), nullable=False),
        sa.Column("channel", sa.String(length=16), nullable=False),
        sa.Column("external_ref", sa.String(length=255), nullable=True),
        sa.Column("profile_ref", sa.String(length=255), nullable=True),
        sa.Column("device_ref", sa.String(length=255), nullable=True),
        sa.Column("status", sa.String(length=32), nullable=False, server_default="enabled"),
        sa.Column("capabilities_json", sa.JSON(), nullable=False),
        sa.Column("last_health_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("owner_user_id", "sender_account_id"),
        sa.UniqueConstraint("owner_user_id", "sender_account_id", name="uq_sender_account_owner_id"),
        sa.CheckConstraint("channel IN ('web','ios')", name="ck_sender_account_channel"),
    )


def downgrade() -> None:
    if sa.inspect(op.get_bind()).has_table("sender_account"):
        op.drop_table("sender_account")
