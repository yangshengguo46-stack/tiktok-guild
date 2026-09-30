"""Add Android senders and retire Web/iOS senders without erasing history.

Revision ID: 0032_android_outreach_sender
Revises: 0031_outreach_action_leases
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0032_android_outreach_sender"
down_revision: str | Sequence[str] | None = "0031_outreach_action_leases"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    if not sa.inspect(op.get_bind()).has_table("sender_account"):
        return
    with op.batch_alter_table("sender_account") as batch:
        batch.drop_constraint("ck_sender_account_channel", type_="check")
        batch.create_check_constraint("ck_sender_account_channel", "channel IN ('web','ios','android')")
    op.execute(sa.text("UPDATE sender_account SET status='retired' WHERE channel IN ('web','ios') AND status <> 'retired'"))


def downgrade() -> None:
    # Existing Android rows must be removed by an operator before downgrade.
    if not sa.inspect(op.get_bind()).has_table("sender_account"):
        return
    with op.batch_alter_table("sender_account") as batch:
        batch.drop_constraint("ck_sender_account_channel", type_="check")
        batch.create_check_constraint("ck_sender_account_channel", "channel IN ('web','ios')")
