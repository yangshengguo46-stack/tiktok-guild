"""Opt-in real PostgreSQL checks; only synthetic data in disposable schemas."""

from __future__ import annotations

import asyncio
import os
import uuid

import pytest
import pytest_asyncio
from sqlalchemy import text

from deerflow.config.database_config import DatabaseConfig
from deerflow.persistence.creator_agent_relationship import CreatorOutreachRepository
from deerflow.persistence.engine import close_engine, get_engine, get_session_factory, init_engine_from_config
from deerflow.persistence.social import ExternalEvent, SocialConflictError, SocialRepository
from deerflow.social.contracts import SocialScope, TurnResult
from deerflow.social.persona.models import ProfileScope

POSTGRES_URL = os.environ.get("TEST_POSTGRES_URI")
pytestmark = pytest.mark.skipif(not POSTGRES_URL, reason="requires TEST_POSTGRES_URI (real PostgreSQL)")


@pytest_asyncio.fixture
async def repositories():
    schema = f"social_audit_{uuid.uuid4().hex}"
    await init_engine_from_config(DatabaseConfig(backend="postgres", postgres_url=POSTGRES_URL, postgres_schema=schema))
    factory = get_session_factory()
    assert factory is not None
    try:
        yield SocialRepository(factory), CreatorOutreachRepository(factory)
    finally:
        engine = get_engine()
        assert engine is not None
        async with engine.begin() as connection:
            await connection.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
        await close_engine()


@pytest.mark.asyncio
async def test_postgres_competing_persona_updates_have_one_cas_winner(repositories):
    social, _ = repositories
    scope = ProfileScope("synthetic-owner", "synthetic-account")
    outcomes = await asyncio.gather(
        social.update_binding(scope, "clear_direct@1.0.1", expected_revision=0, reason="synthetic-a"),
        social.update_binding(scope, "quiet_depth@1.0.1", expected_revision=0, reason="synthetic-b"),
        return_exceptions=True,
    )
    assert sum(isinstance(item, SocialConflictError) for item in outcomes) == 1
    assert sum(isinstance(item, Exception) for item in outcomes) == 1
    state = await social.get_binding_state(scope)
    assert state.write_revision == 1
    assert state.bindings.account_default_ref in {"clear_direct@1.0.1", "quiet_depth@1.0.1"}


@pytest.mark.asyncio
async def test_postgres_replayed_social_turn_has_one_durable_outbox_item(repositories):
    social, _ = repositories
    scope = SocialScope("synthetic-owner", "synthetic-account", "synthetic-person", "synthetic-thread")
    snapshot = await social.record_event(scope, ExternalEvent("event-1", "synthetic:ref-1", "creator_message", "A synthetic greeting."))
    arguments = dict(expected_revision=snapshot.revision, event_id="event-1", result=TurnResult("A synthetic reply."), persona_fingerprint=snapshot.effective_persona.fingerprint)
    outcomes = await asyncio.gather(social.commit_turn(scope, **arguments), social.commit_turn(scope, **arguments))
    assert outcomes[0].outbound.action_id == outcomes[1].outbound.action_id
    # A new repository instance must see the committed event and outbox.
    restored = await SocialRepository(social.session_factory).restore(scope)
    assert len(restored.outbound) == 1
    assert restored.outbound[0].state == "pending"
    assert restored.outbound[0].reply_text == "A synthetic reply."


@pytest.mark.asyncio
async def test_postgres_sender_competition_preserves_one_creator_sequence(repositories):
    _, outreach = repositories
    await outreach.claim_creator(owner_user_id="synthetic-owner", creator_uid="synthetic-creator")
    for sender in ("sender-a", "sender-b"):
        await outreach.register_sender_account("synthetic-owner", sender, "android", device_ref=f"device-{sender}")
    outcomes = await asyncio.gather(
        outreach.bind_sequence(owner_user_id="synthetic-owner", creator_uid="synthetic-creator", sender_account_id="sender-a"),
        outreach.bind_sequence(owner_user_id="synthetic-owner", creator_uid="synthetic-creator", sender_account_id="sender-b"),
        return_exceptions=True,
    )
    assert sum(isinstance(item, ValueError) for item in outcomes) == 1
    assert sum(isinstance(item, Exception) for item in outcomes) == 1
    read = await outreach.read_model(owner_user_id="synthetic-owner", creator_uid="synthetic-creator")
    assert len(read["sequences"]) == 1
    assert read["sequences"][0]["sender_account_id"] in {"sender-a", "sender-b"}
