from __future__ import annotations

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from deerflow.persistence.base import Base
from deerflow.persistence.creator_agent_relationship import CreatorOutreachRepository


@pytest_asyncio.fixture
async def repo(tmp_path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'outreach.db'}")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield CreatorOutreachRepository(async_sessionmaker(engine, expire_on_commit=False))
    await engine.dispose()


@pytest.mark.asyncio
async def test_handoff_import_is_idempotent_and_preserves_provenance(repo):
    payload = [{"creator_uid": "c-1", "payload": {"handle": "alpha"}}, {"creator_uid": "c-1", "payload": {"handle": "ignored"}}]
    first = await repo.import_handoff(owner_user_id="guild", batch_id="b-1", dataset_hash="a" * 64, provenance={"source": "tkdesk", "run": "r1"}, candidates=payload)
    second = await repo.import_handoff(owner_user_id="guild", batch_id="b-1", dataset_hash="a" * 64, provenance={"source": "tkdesk", "run": "r1"}, candidates=payload)
    assert first["inserted"] == 1
    assert second["inserted"] == 0
    claim = await repo.claim_creator(owner_user_id="guild", creator_uid="c-1", batch_id="b-1")
    assert claim["claim"]["status"] == "gray"
    assert claim["handoff"][0]["payload"] == {"handle": "alpha"}


@pytest.mark.asyncio
async def test_claim_is_global_across_sender_accounts_and_other_creators_are_allowed(repo):
    await repo.import_handoff(owner_user_id="guild", batch_id="b", dataset_hash="b" * 64, provenance={"source": "tkdesk"}, candidates=[{"creator_uid": "c-1"}, {"creator_uid": "c-2"}])
    first = await repo.claim_creator(owner_user_id="guild", creator_uid="c-1", batch_id="b")
    second = await repo.claim_creator(owner_user_id="guild", creator_uid="c-1", batch_id="b")
    other = await repo.claim_creator(owner_user_id="guild", creator_uid="c-2", batch_id="b")
    assert first["claim"]["creator_uid"] == second["claim"]["creator_uid"] == "c-1"
    assert other["claim"]["creator_uid"] == "c-2"
    assert await repo.bind_sequence(owner_user_id="guild", creator_uid="c-1", sender_account_id="sender-a")
    assert await repo.bind_sequence(owner_user_id="guild", creator_uid="c-1", sender_account_id="sender-b")
    read = await repo.read_model(owner_user_id="guild", creator_uid="c-1")
    assert [item["sender_account_id"] for item in read["sequences"]] == ["sender-a", "sender-b"]


@pytest.mark.asyncio
async def test_chat_bubble_cannot_advance_and_verified_facts_are_required(repo):
    await repo.claim_creator(owner_user_id="guild", creator_uid="c-1")
    with pytest.raises(ValueError):
        await repo.advance_state(owner_user_id="guild", creator_uid="c-1", next_status="contacted", evidence_kind="chat_bubble")
    with pytest.raises(ValueError):
        await repo.advance_state(owner_user_id="guild", creator_uid="c-1", next_status="contacted", evidence_kind="dm_receipt")
    await repo.advance_state(owner_user_id="guild", creator_uid="c-1", next_status="public_touched", evidence_kind="public_action_receipt")
    await repo.advance_state(owner_user_id="guild", creator_uid="c-1", next_status="contacted", evidence_kind="dm_receipt")
    with pytest.raises(ValueError):
        await repo.advance_state(owner_user_id="guild", creator_uid="c-1", next_status="replied", evidence_kind="dm_receipt")
    read = await repo.read_model(owner_user_id="guild", creator_uid="c-1")
    assert read["claim"]["status"] == "contacted"
