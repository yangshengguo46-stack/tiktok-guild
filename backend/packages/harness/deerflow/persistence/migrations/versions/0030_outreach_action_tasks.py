"""Persist idempotent outreach action tasks and execution leases.

Revision ID: 0030_outreach_action_tasks
Revises: 0029_outreach_sender_accounts
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0030_outreach_action_tasks"
down_revision: str | Sequence[str] | None = "0029_outreach_sender_accounts"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _index_names(bind) -> set[str]:
    return {item["name"] for item in sa.inspect(bind).get_indexes("creator_outreach_action_task")}


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if not inspector.has_table("creator_outreach_action_task"):
        op.create_table(
            "creator_outreach_action_task",
            sa.Column("task_id", sa.String(length=128), nullable=False),
            sa.Column("owner_user_id", sa.String(length=128), nullable=False),
            sa.Column("creator_uid", sa.String(length=128), nullable=False),
            sa.Column("sequence_no", sa.Integer(), nullable=False),
            sa.Column("sender_account_id", sa.String(length=128), nullable=False),
            sa.Column("action", sa.String(length=16), nullable=False),
            sa.Column("idempotency_key", sa.String(length=255), nullable=False),
            sa.Column("state", sa.String(length=16), nullable=False, server_default="pending"),
            sa.Column("payload_json", sa.JSON(), nullable=False),
            sa.Column("attempt_count", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("lease_until", sa.DateTime(timezone=True), nullable=True),
            sa.Column("receipt_id", sa.String(length=128), nullable=True),
            sa.Column("error_code", sa.String(length=128), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
            sa.PrimaryKeyConstraint("task_id"),
            sa.UniqueConstraint("owner_user_id", "idempotency_key", name="uq_creator_outreach_action_idempotency"),
            sa.CheckConstraint("action IN ('like','comment','follow','message')", name="ck_creator_outreach_action"),
            sa.CheckConstraint("state IN ('pending','leased','completed','failed')", name="ck_creator_outreach_action_state"),
        )
        inspector = sa.inspect(bind)
    if "uq_creator_outreach_active_action" not in _index_names(bind):
        op.create_index(
            "uq_creator_outreach_active_action",
            "creator_outreach_action_task",
            ["owner_user_id", "creator_uid", "sequence_no", "action"],
            unique=True,
            sqlite_where=sa.text("state IN ('pending','leased')"),
            postgresql_where=sa.text("state IN ('pending','leased')"),
        )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if inspector.has_table("creator_outreach_action_task"):
        if "uq_creator_outreach_active_action" in _index_names(bind):
            op.drop_index("uq_creator_outreach_active_action", table_name="creator_outreach_action_task")
        op.drop_table("creator_outreach_action_task")
