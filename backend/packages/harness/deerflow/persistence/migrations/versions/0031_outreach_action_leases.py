"""Add worker ownership tokens to outreach action leases.

Revision ID: 0031_outreach_action_leases
Revises: 0030_outreach_action_tasks
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa

revision: str = "0031_outreach_action_leases"
down_revision: str | Sequence[str] | None = "0030_outreach_action_tasks"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    from deerflow.persistence.migrations._helpers import safe_add_column

    safe_add_column("creator_outreach_action_task", sa.Column("lease_owner", sa.String(length=128), nullable=True))
    safe_add_column("creator_outreach_action_task", sa.Column("lease_token", sa.String(length=128), nullable=True))


def downgrade() -> None:
    from deerflow.persistence.migrations._helpers import safe_drop_column

    safe_drop_column("creator_outreach_action_task", "lease_token")
    safe_drop_column("creator_outreach_action_task", "lease_owner")
