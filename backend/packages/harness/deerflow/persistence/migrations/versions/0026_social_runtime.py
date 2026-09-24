"""Durable social events, channel snapshots, persona history and outbox.

Revision ID: 0026_social_runtime
Revises: 0025_creator_agent_relationship
"""

from __future__ import annotations

import hashlib
import json

import sqlalchemy as sa
from alembic import op

from deerflow.persistence.migrations._helpers import safe_add_column, safe_drop_column

revision = "0026_social_runtime"
down_revision = "0025_creator_agent_relationship"
branch_labels = None
depends_on = None


def _scope_columns():
    return [sa.Column("owner_user_id", sa.String(128), primary_key=True), sa.Column("account_id", sa.String(128), primary_key=True)]


def _tables():
    # Frozen migration schema, independent of future ORM revisions.
    metadata = sa.MetaData()
    sa.Table(
        "social_event",
        metadata,
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
    sa.Table(
        "social_persona_profile",
        metadata,
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
    bindings = sa.Table(
        "social_persona_binding",
        metadata,
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
    sa.Index("uq_social_binding_nullable_scope", bindings.c.owner_user_id, bindings.c.account_id, sa.func.coalesce(bindings.c.agent_instance_id, ""), sa.func.coalesce(bindings.c.relation_ref, ""), bindings.c.revision, unique=True)
    sa.Table(
        "social_outbound",
        metadata,
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
    return metadata


def upgrade():
    bind = op.get_bind()
    if not sa.inspect(bind).has_table("creator_agent_relationship"):
        raise RuntimeError("0026 requires the 0025 relationship table")
    safe_add_column("creator_agent_relationship", sa.Column("social_snapshots_json", sa.JSON, nullable=True))
    safe_add_column("creator_agent_relationship", sa.Column("identity_verified", sa.Boolean, nullable=False, server_default="0"))
    safe_add_column("creator_agent_relationship", sa.Column("human_takeover", sa.Boolean, nullable=False, server_default="0"))
    safe_add_column("creator_agent_relationship", sa.Column("receipt_state", sa.String(16), nullable=False, server_default="unknown"))
    tables = _tables()
    tables.create_all(bind, checkfirst=True)
    relationship = sa.Table("creator_agent_relationship", sa.MetaData(), autoload_with=bind)
    bindings = tables.tables["social_persona_binding"]
    for row in bind.execute(sa.select(relationship).order_by(relationship.c.owner_user_id, relationship.c.account_id, relationship.c.creator_uid)).mappings():
        state = row["persona_state_json"]
        # No creator context import or untyped legacy fact promotion. There is
        # no verified channel identity in Phase 0, so no channel is fabricated.
        if not isinstance(state, dict) or not isinstance(state.get("persona_ref"), str):
            continue
        scope_key = hashlib.sha256(json.dumps(["lead_agent", row["creator_uid"]], ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
        where = (bindings.c.owner_user_id == row["owner_user_id"], bindings.c.account_id == row["account_id"], bindings.c.scope_key == scope_key)
        if bind.execute(sa.select(bindings.c.revision).where(*where).limit(1)).first() is not None:
            continue
        generation = (bind.execute(sa.select(sa.func.max(bindings.c.generation)).where(bindings.c.owner_user_id == row["owner_user_id"], bindings.c.account_id == row["account_id"])).scalar() or 1) + 1
        refs = state.get("evidence_refs", [])
        if not isinstance(refs, list) or any(not isinstance(ref, str) for ref in refs):
            refs = []
        bind.execute(
            bindings.insert().values(
                owner_user_id=row["owner_user_id"],
                account_id=row["account_id"],
                scope_key=scope_key,
                agent_instance_id="lead_agent",
                relation_ref=row["creator_uid"],
                revision=max(row["persona_revision"], 1),
                generation=generation,
                profile_ref=state["persona_ref"],
                reason="phase0_persona_backfill",
                evidence_refs_json=refs,
                status="applied",
                effective_at=row["updated_at"],
            )
        )


def downgrade():
    bind = op.get_bind()
    for name in ("social_outbound", "social_persona_binding", "social_persona_profile", "social_event"):
        if sa.inspect(bind).has_table(name):
            op.drop_table(name)
    for name in ("receipt_state", "human_takeover", "identity_verified", "social_snapshots_json"):
        safe_drop_column("creator_agent_relationship", name)
