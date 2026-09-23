"""Create bounded creator-agent relationship snapshots.

Revision ID: 0025_creator_agent_relationship
Revises: 0024_project_documents
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0025_creator_agent_relationship"
down_revision: str | Sequence[str] | None = "0024_project_documents"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    if sa.inspect(op.get_bind()).has_table("creator_agent_relationship"):
        return
    op.create_table(
        "creator_agent_relationship",
        sa.Column("owner_user_id", sa.String(length=64), nullable=False),
        sa.Column("account_id", sa.String(length=128), nullable=False),
        sa.Column("creator_uid", sa.String(length=128), nullable=False),
        sa.Column("evidence_version", sa.Integer(), nullable=False),
        sa.Column("persona_revision", sa.Integer(), nullable=False),
        sa.Column("evidence_json", sa.JSON(), nullable=False),
        sa.Column("evidence_ids_json", sa.JSON(), nullable=False),
        sa.Column("facts_json", sa.JSON(), nullable=False),
        sa.Column("commitments_json", sa.JSON(), nullable=False),
        sa.Column("do_not_contact", sa.Boolean(), nullable=False),
        sa.Column("persona_state_json", sa.JSON(), nullable=True),
        sa.Column("decision_ids_json", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("owner_user_id", "account_id", "creator_uid"),
    )


def downgrade() -> None:
    if sa.inspect(op.get_bind()).has_table("creator_agent_relationship"):
        op.drop_table("creator_agent_relationship")
