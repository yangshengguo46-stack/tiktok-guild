from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from deerflow.persistence.base import Base
from deerflow.persistence.creator_agent_relationship import CreatorOutreachRepository


@pytest_asyncio.fixture
async def repo(tmp_path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'outreach-channels.db'}")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield CreatorOutreachRepository(async_sessionmaker(engine, expire_on_commit=False))
    await engine.dispose()


async def _bound_sequence(repo, *, sender_account_id: str = "web-001") -> None:
    await repo.claim_creator(owner_user_id="guild", creator_uid="creator-1")
    await repo.bind_sequence(owner_user_id="guild", creator_uid="creator-1", sender_account_id=sender_account_id)


@pytest.mark.asyncio
async def test_sender_registration_is_idempotent_and_rejects_channel_conflicts(repo):
    first = await repo.register_sender_account(
        "guild",
        "web-001",
        "web",
        external_ref="ordinary-account",
        profile_ref="profile-001",
        capabilities={"like": True, "comment": True},
    )
    duplicate = await repo.register_sender_account(
        "guild",
        "web-001",
        "web",
        external_ref="ordinary-account",
        profile_ref="profile-001",
        capabilities={"like": True, "comment": True},
    )
    assert duplicate["sender_account_id"] == first["sender_account_id"]
    assert duplicate["channel"] == first["channel"] == "web"
    assert duplicate["capabilities_json"] == first["capabilities_json"] == {"like": True, "comment": True}
    with pytest.raises(ValueError, match="replay conflict"):
        await repo.register_sender_account("guild", "web-001", "ios", external_ref="ordinary-account")
    with pytest.raises(ValueError, match="web or ios"):
        await repo.register_sender_account("guild", "bad", "android")


@pytest.mark.asyncio
async def test_sender_pool_allows_fifty_profiles_and_limits_active_batch_to_ten(repo):
    for number in range(50):
        await repo.register_sender_account("guild", f"web-{number:03d}", "web", profile_ref=f"profile-{number:03d}")
    accounts = await repo.list_sender_accounts("guild", channel="web")
    active_batch = await repo.list_sender_accounts("guild", channel="web", active_only=True)
    assert len(accounts) == 50
    assert len(active_batch) == 10
    with pytest.raises(ValueError, match="maximum of 50"):
        await repo.register_sender_account("guild", "web-050", "web", profile_ref="profile-050")


@pytest.mark.asyncio
async def test_action_idempotency_and_sender_continuity(repo):
    await repo.register_sender_account("guild", "web-001", "web", profile_ref="profile-001")
    await _bound_sequence(repo)
    first = await repo.enqueue_action(
        "guild",
        "creator-1",
        1,
        "web-001",
        "like",
        "outreach:guild:creator-1:1:like",
        payload={"target": "video-1"},
    )
    duplicate = await repo.enqueue_action(
        "guild",
        "creator-1",
        1,
        "web-001",
        "like",
        "outreach:guild:creator-1:1:like",
        payload={"target": "video-1"},
    )
    assert duplicate["task_id"] == first["task_id"]
    with pytest.raises(ValueError, match="replay conflict"):
        await repo.enqueue_action(
            "guild",
            "creator-1",
            1,
            "web-001",
            "like",
            "outreach:guild:creator-1:1:like",
            payload={"target": "different-video"},
        )
    with pytest.raises(ValueError, match="differs from"):
        await repo.enqueue_action(
            "guild",
            "creator-1",
            1,
            "ios-001",
            "comment",
            "outreach:guild:creator-1:1:comment",
            payload={"text": "hello"},
        )


@pytest.mark.asyncio
async def test_action_claim_lease_expiry_and_completion_identity(repo):
    await _bound_sequence(repo)
    created_at = datetime(2026, 9, 29, 12, 0, tzinfo=UTC)
    task = await repo.enqueue_action("guild", "creator-1", 1, "web-001", "message", "message-1")
    first_claim = await repo.claim_action(task["task_id"], now=created_at, lease_seconds=1)
    assert first_claim is not None
    assert first_claim["state"] == "leased"
    assert first_claim["attempt_count"] == 1
    assert await repo.claim_action(task["task_id"], now=created_at + timedelta(milliseconds=500), lease_seconds=1) is None
    released = await repo.release_expired_action_leases(now=created_at + timedelta(seconds=2))
    assert released == 1
    second_claim = await repo.claim_action(task["task_id"], now=created_at + timedelta(seconds=2), lease_seconds=10)
    assert second_claim is not None
    assert second_claim["attempt_count"] == 2
    with pytest.raises(ValueError, match="identity"):
        await repo.complete_action(
            task["task_id"],
            sender_account_id="ios-001",
            idempotency_key="message-1",
            receipt_id="receipt-1",
        )
    completed = await repo.complete_action(
        task["task_id"],
        sender_account_id="web-001",
        idempotency_key="message-1",
        receipt_id="receipt-1",
    )
    assert completed["state"] == "completed"
    assert completed["lease_until"] is None
    assert (await repo.read_action_task(task["task_id"]))["receipt_id"] == "receipt-1"
