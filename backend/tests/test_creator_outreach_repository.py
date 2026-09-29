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
    assert claim["handoff"][0]["dataset_hash"] == "a" * 64
    assert claim["handoff"][0]["provenance"] == {"source": "tkdesk", "run": "r1"}


@pytest.mark.asyncio
async def test_claim_is_global_across_sender_accounts_and_other_creators_are_allowed(repo):
    await repo.import_handoff(owner_user_id="guild", batch_id="b", dataset_hash="b" * 64, provenance={"source": "tkdesk"}, candidates=[{"creator_uid": "c-1"}, {"creator_uid": "c-2"}])
    first = await repo.claim_creator(owner_user_id="guild", creator_uid="c-1", batch_id="b")
    second = await repo.claim_creator(owner_user_id="guild", creator_uid="c-1", batch_id="b")
    other = await repo.claim_creator(owner_user_id="guild", creator_uid="c-2", batch_id="b")
    assert first["claim"]["creator_uid"] == second["claim"]["creator_uid"] == "c-1"
    assert other["claim"]["creator_uid"] == "c-2"
    assert await repo.bind_sequence(owner_user_id="guild", creator_uid="c-1", sender_account_id="sender-a")
    with pytest.raises(ValueError):
        await repo.bind_sequence(owner_user_id="guild", creator_uid="c-1", sender_account_id="sender-b")
    read = await repo.read_model(owner_user_id="guild", creator_uid="c-1")
    assert [item["sender_account_id"] for item in read["sequences"]] == ["sender-a"]


@pytest.mark.asyncio
async def test_chat_bubble_cannot_advance_and_verified_facts_are_required(repo):
    await repo.claim_creator(owner_user_id="guild", creator_uid="c-1")
    with pytest.raises(ValueError):
        await repo.advance_state(owner_user_id="guild", creator_uid="c-1", sequence_no=1, receipt_id="fake", next_status="public_touched")
    with pytest.raises(ValueError):
        await repo.advance_state(owner_user_id="guild", creator_uid="c-1", sequence_no=1, receipt_id="fake", next_status="contacted")
    await repo.bind_sequence(owner_user_id="guild", creator_uid="c-1", sender_account_id="sender")
    await repo.record_receipt(owner_user_id="guild", creator_uid="c-1", sequence_no=1, receipt_id="r1", kind="public_action_receipt", provider_ref="p1", payload={"action": "like"}, verified=True)
    await repo.advance_state(owner_user_id="guild", creator_uid="c-1", sequence_no=1, receipt_id="r1", next_status="public_touched")
    await repo.record_receipt(owner_user_id="guild", creator_uid="c-1", sequence_no=1, receipt_id="r2", kind="dm_receipt", provider_ref="p2", payload={"action": "message"}, verified=True)
    await repo.advance_state(owner_user_id="guild", creator_uid="c-1", sequence_no=1, receipt_id="r2", next_status="contacted")
    with pytest.raises(ValueError):
        await repo.advance_state(owner_user_id="guild", creator_uid="c-1", sequence_no=1, receipt_id="r2", next_status="replied")
    read = await repo.read_model(owner_user_id="guild", creator_uid="c-1")
    assert read["claim"]["status"] == "contacted"


@pytest.mark.asyncio
async def test_receipt_idempotency_and_replay_conflict(repo):
    await repo.claim_creator(owner_user_id="guild", creator_uid="c-1")
    await repo.bind_sequence(owner_user_id="guild", creator_uid="c-1", sender_account_id="sender")
    first = await repo.record_receipt(owner_user_id="guild", creator_uid="c-1", sequence_no=1, receipt_id="r", kind="public_action_receipt", provider_ref="p", payload={"x": 1}, verified=True)
    duplicate = await repo.record_receipt(owner_user_id="guild", creator_uid="c-1", sequence_no=1, receipt_id="r", kind="public_action_receipt", provider_ref="p", payload={"x": 1}, verified=True)
    assert {key: duplicate[key] for key in ("receipt_id", "kind", "provider_ref", "payload_json", "verified")} == {key: first[key] for key in ("receipt_id", "kind", "provider_ref", "payload_json", "verified")}
    with pytest.raises(ValueError):
        await repo.record_receipt(owner_user_id="guild", creator_uid="c-1", sequence_no=1, receipt_id="r", kind="public_action_receipt", provider_ref="p", payload={"x": 2}, verified=True)


@pytest.mark.asyncio
async def test_closed_claim_cannot_rebind_sender(repo):
    await repo.claim_creator(owner_user_id="guild", creator_uid="c-1")
    await repo.bind_sequence(owner_user_id="guild", creator_uid="c-1", sender_account_id="sender-a")
    for receipt_id, kind, next_status in (
        ("like", "public_action_receipt", "public_touched"),
        ("dm", "dm_receipt", "contacted"),
        ("inbound", "verified_inbound", "replied"),
    ):
        await repo.record_receipt(owner_user_id="guild", creator_uid="c-1", sequence_no=1, receipt_id=receipt_id, kind=kind, provider_ref=f"p-{receipt_id}", payload={"receipt": receipt_id}, verified=True)
        await repo.advance_state(owner_user_id="guild", creator_uid="c-1", sequence_no=1, receipt_id=receipt_id, next_status=next_status)
    await repo.record_receipt(owner_user_id="guild", creator_uid="c-1", sequence_no=1, receipt_id="close", kind="closure_receipt", provider_ref="p", payload={"reason": "operator"}, verified=True)
    await repo.advance_state(owner_user_id="guild", creator_uid="c-1", sequence_no=1, receipt_id="close", next_status="closed")
    with pytest.raises(ValueError, match="closed"):
        await repo.bind_sequence(owner_user_id="guild", creator_uid="c-1", sender_account_id="sender-b")
