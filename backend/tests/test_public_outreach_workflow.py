from __future__ import annotations

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from deerflow.creator_agent.public_outreach import PublicOutreachWorkflow
from deerflow.persistence.base import Base
from deerflow.persistence.creator_agent_relationship import CreatorOutreachRepository


@pytest_asyncio.fixture
async def repo(tmp_path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'public-outreach.db'}")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield CreatorOutreachRepository(async_sessionmaker(engine, expire_on_commit=False))
    await engine.dispose()


async def _creator(repo, *, creator_uid: str = "creator-1", sender_account_id: str = "web:account-001"):
    channel = "ios" if sender_account_id.startswith("ios:") else "web"
    await repo.register_sender_account(
        "guild",
        sender_account_id,
        channel,
        profile_ref="profile-001" if channel == "web" else None,
        device_ref="device-001" if channel == "ios" else None,
    )
    await repo.claim_creator(owner_user_id="guild", creator_uid=creator_uid)
    return await repo.bind_sequence(
        owner_user_id="guild",
        creator_uid=creator_uid,
        sender_account_id=sender_account_id,
    )


def _receipt(sender: str, creator: str, action: str, receipt_id: str, *, verified: bool = True):
    return {
        "provider_ref": receipt_id,
        "receipt_payload": {
            "receipt_type": "dm_receipt" if action == "message" else "public_action_receipt",
            "action": action,
            "sender_account_id": sender,
            "creator_uid": creator,
            "evidence": [f"provider-readback:{action}"],
        },
        "verification_source": "provider_readback",
        "verified": verified,
    }


@pytest.mark.asyncio
async def test_web_operator_runs_ordered_public_actions_and_message(repo):
    await _creator(repo)
    calls = []

    async def web_operator(**kwargs):
        calls.append((kwargs["action"], kwargs["account"]["sender_account_id"]))
        return _receipt("web:account-001", "creator-1", kwargs["action"], f"receipt-{kwargs['action']}")

    workflow = PublicOutreachWorkflow(repo, web_operator=web_operator, worker_id="test-web")
    tasks = await workflow.create_public_outreach_tasks(
        "guild",
        "creator-1",
        1,
        "web:account-001",
        ["like", "comment", "follow", "message"],
    )
    for task in tasks:
        result = await workflow.execute_task(
            task["task_id"],
            creator={"creator_uid": "creator-1"},
            payload={"text": "Hello from the creator team."},
        )
        assert result["status"] == "verified"
    assert calls == [
        ("like", "web:account-001"),
        ("comment", "web:account-001"),
        ("follow", "web:account-001"),
        ("message", "web:account-001"),
    ]
    model = await repo.read_model(owner_user_id="guild", creator_uid="creator-1")
    assert model["claim"]["status"] == "contacted"


@pytest.mark.asyncio
async def test_ios_operator_receives_device_and_keeps_sender_identity(repo):
    await _creator(repo, sender_account_id="ios:device-001:account-001")
    calls = []

    async def ios_operator(**kwargs):
        calls.append((kwargs["action"], kwargs["account"]["sender_account_id"], kwargs["device"]["device_ref"]))
        return _receipt(
            "ios:device-001:account-001",
            "creator-1",
            kwargs["action"],
            f"ios-{kwargs['action']}",
        )

    workflow = PublicOutreachWorkflow(repo, ios_operator=ios_operator, worker_id="test-ios")
    tasks = await workflow.create_public_outreach_tasks(
        "guild",
        "creator-1",
        1,
        "ios:device-001:account-001",
        ["like", "comment", "follow"],
    )
    for task in tasks:
        result = await workflow.execute_task(
            task["task_id"],
            creator={"creator_uid": "creator-1"},
            device={"device_ref": "device-001"},
        )
        assert result["status"] == "verified"
    assert calls == [
        ("like", "ios:device-001:account-001", "device-001"),
        ("comment", "ios:device-001:account-001", "device-001"),
        ("follow", "ios:device-001:account-001", "device-001"),
    ]
    model = await repo.read_model(owner_user_id="guild", creator_uid="creator-1")
    assert model["claim"]["status"] == "public_touched"


@pytest.mark.asyncio
async def test_mixed_channel_sender_is_rejected_for_one_sequence(repo):
    await _creator(repo)
    await repo.register_sender_account("guild", "ios:device-001:account-001", "ios", device_ref="device-001")
    workflow = PublicOutreachWorkflow(repo)
    with pytest.raises(ValueError, match="differs from"):
        await workflow.create_public_outreach_tasks(
            "guild",
            "creator-1",
            1,
            "ios:device-001:account-001",
            ["like", "comment", "follow"],
        )


@pytest.mark.asyncio
async def test_partial_public_receipts_stay_actionable_until_verified_set_is_complete(repo):
    await _creator(repo)
    workflow = PublicOutreachWorkflow(repo, worker_id="partial")
    tasks = await workflow.create_public_outreach_tasks(
        "guild",
        "creator-1",
        1,
        "web:account-001",
        ["like", "comment", "follow"],
    )
    by_action = {task["action"]: task for task in tasks}
    for action in ("like", "comment"):
        result = await workflow.record_public_action_result(
            by_action[action]["task_id"],
            _receipt("web:account-001", "creator-1", action, f"partial-{action}"),
        )
        assert result["status"] == "verified"
        assert result["advanced"] is False
    model = await repo.read_model(owner_user_id="guild", creator_uid="creator-1")
    assert model["claim"]["status"] == "gray"
    result = await workflow.record_public_action_result(
        by_action["follow"]["task_id"],
        _receipt("web:account-001", "creator-1", "follow", "partial-follow"),
    )
    assert result["advanced"] is True
    model = await repo.read_model(owner_user_id="guild", creator_uid="creator-1")
    assert model["claim"]["status"] == "public_touched"


@pytest.mark.asyncio
async def test_verified_aggregate_completes_public_set_and_duplicate_delivery_is_idempotent(repo):
    await _creator(repo)
    workflow = PublicOutreachWorkflow(repo, worker_id="aggregate")
    tasks = await workflow.create_public_outreach_tasks(
        "guild",
        "creator-1",
        1,
        "web:account-001",
        ["like", "comment", "follow"],
    )
    aggregate = {
        "provider_ref": "aggregate-1",
        "receipt_payload": {
            "receipt_type": "public_action_receipt",
            "sender_account_id": "web:account-001",
            "creator_uid": "creator-1",
            "actions": [
                {"action": "like", "sender_account_id": "web:account-001", "creator_uid": "creator-1"},
                {"action": "comment", "sender_account_id": "web:account-001", "creator_uid": "creator-1"},
                {"action": "follow", "sender_account_id": "web:account-001", "creator_uid": "creator-1"},
            ],
        },
        "verification_source": ["provider_readback", "provider_readback", "provider_readback"],
        "verified": True,
    }
    first = await workflow.record_public_action_result(tasks[0]["task_id"], aggregate)
    duplicate = await workflow.record_public_action_result(tasks[0]["task_id"], aggregate)
    assert first["advanced"] is True
    assert duplicate["status"] == "verified"
    assert duplicate["receipt"]["receipt_id"] == "aggregate-1"
    assert len(await repo.list_action_tasks("guild", "creator-1", 1)) == 3
    assert all(task["state"] == "completed" for task in await repo.list_action_tasks("guild", "creator-1", 1))


@pytest.mark.asyncio
async def test_bubble_does_not_contact_or_suppress_verified_inbound_reply(repo):
    await _creator(repo)
    workflow = PublicOutreachWorkflow(repo, worker_id="reply")
    tasks = await workflow.create_public_outreach_tasks(
        "guild",
        "creator-1",
        1,
        "web:account-001",
        ["like", "comment", "follow", "message"],
    )
    public_receipt = {
        "provider_ref": "public-aggregate",
        "receipt_payload": {
            "receipt_type": "public_action_receipt",
            "sender_account_id": "web:account-001",
            "creator_uid": "creator-1",
            "actions": [{"action": action} for action in ("like", "comment", "follow")],
        },
        "verification_source": "provider_readback",
        "verified": True,
    }
    await workflow.record_public_action_result(tasks[0]["task_id"], public_receipt)
    bubble = {
        "provider_ref": "bubble-1",
        "receipt_payload": {
            "receipt_type": "chat_bubble",
            "action": "message",
            "sender_account_id": "web:account-001",
            "creator_uid": "creator-1",
            "draft": True,
        },
        "verification_source": "ui_observation",
        "verified": True,
    }
    bubble_result = await workflow.record_message_result(tasks[-1]["task_id"], bubble)
    assert bubble_result["status"] == "unknown"
    assert bubble_result["advanced"] is False
    model = await repo.read_model(owner_user_id="guild", creator_uid="creator-1")
    assert model["claim"]["status"] == "public_touched"

    inbound = {
        "provider_ref": "inbound-1",
        "receipt_payload": {
            "receipt_type": "verified_inbound",
            "sender_account_id": "web:account-001",
            "creator_uid": "creator-1",
            "message_id": "creator-message-1",
        },
        "verification_source": "provider_readback",
        "verified": True,
    }
    reply = await workflow.record_inbound_result(tasks[-1]["task_id"], inbound)
    assert reply["status"] == "verified"
    assert reply["advanced"] is True
    model = await repo.read_model(owner_user_id="guild", creator_uid="creator-1")
    assert model["claim"]["status"] == "replied"


@pytest.mark.asyncio
async def test_message_before_public_is_blocked_and_retries_after_public_completion(repo):
    await _creator(repo)
    workflow = PublicOutreachWorkflow(repo, worker_id="message-order")
    tasks = await workflow.create_public_outreach_tasks(
        "guild",
        "creator-1",
        1,
        "web:account-001",
        ["like", "comment", "follow", "message"],
    )
    by_action = {task["action"]: task for task in tasks}
    message_receipt = _receipt("web:account-001", "creator-1", "message", "message-before-public")

    blocked = await workflow.record_message_result(by_action["message"]["task_id"], message_receipt)
    assert blocked["status"] == "blocked"
    assert blocked["error_code"] == "public_actions_required"
    assert (await repo.read_action_task(by_action["message"]["task_id"]))["state"] == "pending"

    for action in ("like", "comment", "follow"):
        await workflow.record_public_action_result(
            by_action[action]["task_id"],
            _receipt("web:account-001", "creator-1", action, f"public-{action}"),
        )
    contacted = await workflow.record_message_result(by_action["message"]["task_id"], message_receipt)
    assert contacted["status"] == "verified"
    assert contacted["advanced"] is True
    model = await repo.read_model(owner_user_id="guild", creator_uid="creator-1")
    assert model["claim"]["status"] == "contacted"


@pytest.mark.asyncio
async def test_web_and_ios_unknown_operator_results_are_bounded_and_retryable(repo):
    await _creator(repo, creator_uid="web-creator")
    await _creator(repo, creator_uid="ios-creator", sender_account_id="ios:device-001:account-001")

    async def unknown_operator(**_kwargs):
        return {"verified": False, "error_code": "unknown"}

    workflow = PublicOutreachWorkflow(
        repo,
        web_operator=unknown_operator,
        ios_operator=unknown_operator,
        worker_id="unknown-results",
    )
    for creator_uid, sender_account_id in (
        ("web-creator", "web:account-001"),
        ("ios-creator", "ios:device-001:account-001"),
    ):
        tasks = await workflow.create_public_outreach_tasks(
            "guild",
            creator_uid,
            1,
            sender_account_id,
            ["like", "comment", "follow"],
        )
        result = await workflow.execute_task(
            tasks[0]["task_id"],
            creator={"creator_uid": creator_uid},
            device={"device_ref": "device-001"},
        )
        assert result["status"] == "unknown"
        assert result["manual_required"] is True
        assert result["error_code"] == "unknown"
        assert (await repo.read_action_task(tasks[0]["task_id"]))["state"] == "pending"


@pytest.mark.asyncio
async def test_unknown_provider_ref_does_not_block_later_verified_receipt(repo):
    await _creator(repo)

    async def unknown_operator(**_kwargs):
        return {
            "verified": False,
            "error_code": "unknown",
            "provider_ref": "provider-reused-after-unknown",
        }

    workflow = PublicOutreachWorkflow(repo, web_operator=unknown_operator, worker_id="provider-ref")
    tasks = await workflow.create_public_outreach_tasks(
        "guild",
        "creator-1",
        1,
        "web:account-001",
        ["like", "comment", "follow"],
    )
    unknown = await workflow.execute_task(
        tasks[0]["task_id"],
        creator={"creator_uid": "creator-1"},
    )
    assert unknown["status"] == "unknown"
    assert unknown["receipt"]["provider_ref"] is None
    verified = await workflow.record_public_action_result(
        tasks[0]["task_id"],
        _receipt(
            "web:account-001",
            "creator-1",
            "like",
            "provider-reused-after-unknown",
        ),
    )
    assert verified["status"] == "verified"
    assert verified["receipt"]["provider_ref"] == "provider-reused-after-unknown"


@pytest.mark.asyncio
async def test_aggregate_receipt_merges_after_single_action_completion(repo):
    await _creator(repo)
    workflow = PublicOutreachWorkflow(repo, worker_id="aggregate-merge")
    tasks = await workflow.create_public_outreach_tasks(
        "guild",
        "creator-1",
        1,
        "web:account-001",
        ["like", "comment", "follow"],
    )
    single = await workflow.record_public_action_result(
        tasks[0]["task_id"],
        _receipt("web:account-001", "creator-1", "like", "single-like"),
    )
    assert single["status"] == "verified"
    assert (await repo.read_action_task(tasks[0]["task_id"]))["state"] == "completed"
    group = tasks[0]["payload_json"]["action_group"]
    aggregate = {
        "provider_ref": "single-like",
        "receipt_payload": {
            "receipt_type": "public_action_receipt",
            "sender_account_id": "web:account-001",
            "creator_uid": "creator-1",
            "action_group": group,
            "actions": [
                {
                    "action": action,
                    "action_group": group,
                    "sender_account_id": "web:account-001",
                    "creator_uid": "creator-1",
                    "receipt_type": "public_action_receipt",
                    "verified": True,
                }
                for action in ("like", "comment", "follow")
            ],
        },
        "verification_source": "provider_readback",
        "verified": True,
    }
    merged = await workflow.record_public_action_result(tasks[0]["task_id"], aggregate)
    assert merged["status"] == "verified"
    assert merged["advanced"] is True
    assert merged["receipt"]["receipt_id"] == "aggregate:single-like"
    assert {task["action"] for task in merged["completed_tasks"]} == {"like", "comment", "follow"}
    model = await repo.read_model(owner_user_id="guild", creator_uid="creator-1")
    assert model["claim"]["status"] == "public_touched"


@pytest.mark.asyncio
async def test_public_action_rejects_non_public_receipt_type_without_advancing(repo):
    await _creator(repo)
    workflow = PublicOutreachWorkflow(repo, worker_id="receipt-type")
    tasks = await workflow.create_public_outreach_tasks(
        "guild",
        "creator-1",
        1,
        "web:account-001",
        ["like", "comment", "follow"],
    )
    invalid = _receipt("web:account-001", "creator-1", "like", "wrong-kind")
    invalid["receipt_payload"]["receipt_type"] = "dm_receipt"
    result = await workflow.record_public_action_result(tasks[0]["task_id"], invalid)
    assert result["status"] == "unknown"
    assert result["manual_required"] is True
    assert (await repo.read_action_task(tasks[0]["task_id"]))["state"] == "pending"
    model = await repo.read_model(owner_user_id="guild", creator_uid="creator-1")
    assert model["claim"]["status"] == "gray"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("field", "value"),
    (
        ("action_group", "wrong-group"),
        ("sender_account_id", "web:other-account"),
        ("receipt_type", "dm_receipt"),
        ("verified", False),
    ),
)
async def test_aggregate_public_receipt_requires_matching_nested_contract(repo, field, value):
    creator_uid = f"aggregate-{field}"
    await _creator(repo, creator_uid=creator_uid)
    workflow = PublicOutreachWorkflow(repo, worker_id=f"aggregate-{field}")
    tasks = await workflow.create_public_outreach_tasks(
        "guild",
        creator_uid,
        1,
        "web:account-001",
        ["like", "comment", "follow"],
    )
    group = tasks[0]["payload_json"]["action_group"]
    aggregate = {
        "provider_ref": f"aggregate-{field}",
        "receipt_payload": {
            "receipt_type": "public_action_receipt",
            "sender_account_id": "web:account-001",
            "creator_uid": creator_uid,
            "action_group": group,
            "actions": [
                {
                    "action": action,
                    "action_group": group,
                    "sender_account_id": "web:account-001",
                    "creator_uid": creator_uid,
                    "receipt_type": "public_action_receipt",
                    "verified": True,
                }
                for action in ("like", "comment", "follow")
            ],
        },
        "verification_source": "provider_readback",
        "verified": True,
    }
    aggregate["receipt_payload"]["actions"][1][field] = value
    result = await workflow.record_public_action_result(tasks[0]["task_id"], aggregate)
    assert result["status"] == "unknown"
    assert result["manual_required"] is True
    assert all(task["state"] == "pending" for task in await repo.list_action_tasks("guild", creator_uid, 1))
