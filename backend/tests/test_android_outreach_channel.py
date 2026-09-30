from __future__ import annotations

import pytest
import pytest_asyncio
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.gateway.public_outreach_service import PublicOutreachService
from deerflow.persistence.base import Base
from deerflow.persistence.creator_agent_relationship import CreatorOutreachRepository


@pytest_asyncio.fixture
async def repo(tmp_path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'android-outreach.db'}")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    yield CreatorOutreachRepository(async_sessionmaker(engine, expire_on_commit=False))
    await engine.dispose()


@pytest.mark.asyncio
async def test_android_sender_requires_a_device_and_legacy_channels_cannot_be_registered(repo):
    with pytest.raises(ValueError, match="device_ref"):
        await repo.register_sender_account("owner", "android:one", "android", external_ref="@one")

    sender = await repo.register_sender_account("owner", "android:one", "android", external_ref="@one", device_ref="host-a:serial-1")
    assert sender["channel"] == "android"
    assert sender["device_ref"] == "host-a:serial-1"

    for old_channel in ("web", "ios"):
        with pytest.raises(ValueError, match="android"):
            await repo.register_sender_account("owner", f"old:{old_channel}", old_channel, external_ref="@old", device_ref="host-a:old")

    assert [row["sender_account_id"] for row in await repo.list_sender_accounts("owner")] == ["android:one"]


@pytest.mark.asyncio
async def test_historical_sender_is_read_only(repo):
    async with repo.session_factory() as session:
        await session.execute(text("INSERT INTO sender_account (owner_user_id,sender_account_id,channel,status,capabilities_json,created_at,updated_at) VALUES ('owner','old-web','web','retired','{}',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)"))
        await session.commit()
    with pytest.raises(ValueError, match="read only"):
        await repo.set_sender_account_status("owner", "old-web", status="paused", reason="operator_pause")


@pytest.mark.asyncio
@pytest.mark.parametrize("inherit_owner", [False, True])
async def test_device_commands_are_owner_bound_and_takeover_pauses_sender(repo, inherit_owner):
    await repo.register_sender_account("owner", "android:one", "android", external_ref="@one", device_ref="host-a:serial-1")

    class Transport:
        def __init__(self):
            self.calls = []

        async def execute(self, **request):
            self.calls.append(request)
            return {"ok": True, "device_ref": request["device_ref"]}

    transport = Transport()
    deployment = {"devices": [{"device_ref": "host-a:serial-1", "owner_user_id": "owner"}]}
    if inherit_owner:
        deployment = {"devices": [{"device_ref": "host-a:serial-1"}], "sender": {"owner_user_id": "owner", "device_ref": "host-a:serial-1"}}
    service = PublicOutreachService(repo, transport, config=deployment)
    with pytest.raises(ValueError, match="registered"):
        await service.device_operation("other", "host-a:serial-1", "doctor")
    result = await service.device_operation("owner", "host-a:serial-1", "control", commands=[{"type": "observe"}])
    assert result["ok"] is True
    assert transport.calls[-1]["commands"] == [{"type": "observe"}]
    assert transport.calls[-1]["owner_user_id"] == "owner"
    await service.device_operation("owner", "host-a:serial-1", "takeover")
    assert (await repo.read_sender_account("owner", "android:one"))["status"] == "paused"
    with pytest.raises(ValueError, match="paused"):
        await service.device_operation("owner", "host-a:serial-1", "control", commands=[{"type": "tap"}])


@pytest.mark.asyncio
@pytest.mark.parametrize("inherit_owner", [False, True])
async def test_self_registered_device_reference_does_not_grant_deployment_ownership(repo, inherit_owner):
    await repo.register_sender_account("other", "android:other", "android", external_ref="@other", device_ref="host-a:serial-1")

    class Transport:
        async def execute(self, **request):
            pytest.fail("An unrelated owner must never reach the device executor")

    deployment = {"devices": [{"device_ref": "host-a:serial-1", "owner_user_id": "owner"}]}
    if inherit_owner:
        deployment = {"devices": [{"device_ref": "host-a:serial-1"}], "sender": {"owner_user_id": "owner", "device_ref": "host-a:serial-1"}}
    service = PublicOutreachService(repo, Transport(), config=deployment)
    for operation in ("doctor", "control", "takeover", "resume"):
        with pytest.raises(ValueError, match="deployment owner"):
            await service.device_operation("other", "host-a:serial-1", operation, commands=[{"type": "observe"}])


@pytest.mark.asyncio
@pytest.mark.parametrize("error_code", ["write_unknown", "cleanup_unknown", "manual_takeover"])
async def test_uncertain_device_control_pauses_the_native_sender(repo, error_code):
    await repo.register_sender_account("owner", "android:one", "android", external_ref="@one", device_ref="phone")

    class Transport:
        async def execute(self, **request):
            return {"ok": False, "device_ref": "phone", "error_code": error_code}

    service = PublicOutreachService(repo, Transport(), config={"devices": [{"device_ref": "phone", "owner_user_id": "owner"}]})
    result = await service.device_operation("owner", "phone", "control", commands=[{"type": "tap", "locator": {"accessibility_id": "send"}}])
    assert result["error_code"] == error_code
    assert (await repo.read_sender_account("owner", "android:one"))["status"] == "paused"
