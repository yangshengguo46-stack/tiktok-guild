from __future__ import annotations

from types import SimpleNamespace

import pytest
import pytest_asyncio
from _router_auth_helpers import call_unwrapped
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.gateway.auth_disabled import AUTH_SOURCE_AUTH_DISABLED
from app.gateway.routers.public_outreach import (
    CloseSequenceRequest,
    CreateOutreachTaskRequest,
    ManualReasonRequest,
    close_outreach_sequence,
    create_outreach_tasks,
    get_outreach_task,
    list_outreach_accounts,
    mark_provider_unknown,
    retry_outreach_task,
)
from deerflow.persistence.base import Base
from deerflow.persistence.creator_agent_relationship import CreatorOutreachRepository


class _Operator:
    configured = True

    def __init__(self, accounts: list[dict] | None = None) -> None:
        self._accounts = accounts or []

    async def list_accounts(self, *, owner_user_id: str) -> list[dict]:
        return self._accounts


_DEFAULT_OPERATOR = object()


class _Request:
    def __init__(
        self,
        repository: CreatorOutreachRepository,
        *,
        owner_user_id: str = "owner-a",
        admin: bool = True,
        operator: object = _DEFAULT_OPERATOR,
    ) -> None:
        configured_operator = _Operator() if operator is _DEFAULT_OPERATOR else operator
        self.app = SimpleNamespace(
            state=SimpleNamespace(
                creator_outreach_repo=repository,
                public_outreach_operator=configured_operator,
                public_outreach_operator_configured=configured_operator is not None,
            )
        )
        self.state = SimpleNamespace(
            user=SimpleNamespace(id=owner_user_id, system_role="admin" if admin else "user"),
            auth_source=AUTH_SOURCE_AUTH_DISABLED,
        )
        self.cookies = {}


@pytest_asyncio.fixture
async def repo(tmp_path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'public-outreach-api.db'}")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    repository = CreatorOutreachRepository(async_sessionmaker(engine, expire_on_commit=False))
    yield repository
    await engine.dispose()


async def _bound(repo: CreatorOutreachRepository, *, owner: str = "owner-a", creator: str = "creator-1", sender: str = "web-1"):
    await repo.register_sender_account(
        owner,
        sender,
        "web",
        profile_ref="/private/profile",
        capabilities={
            "auth_metadata": "secret",
            "profile_path": "/private/profile",
            "path": "/private/path",
            "safe": "visible",
        },
    )
    await repo.claim_creator(owner_user_id=owner, creator_uid=creator)
    await repo.bind_sequence(owner_user_id=owner, creator_uid=creator, sender_account_id=sender)


async def _tasks(repo: CreatorOutreachRepository, *, owner: str = "owner-a", creator: str = "creator-1"):
    from deerflow.creator_agent.public_outreach import PublicOutreachWorkflow

    return await PublicOutreachWorkflow(repo).create_public_outreach_tasks(
        owner,
        creator,
        1,
        "web-1",
        ["like", "comment", "follow", "message"],
    )


@pytest.mark.asyncio
async def test_accounts_are_owner_isolated_and_redact_provider_metadata(repo):
    await _bound(repo)
    request = _Request(
        repo,
        operator=_Operator(
            [
                {
                    "owner_user_id": "owner-a",
                    "sender_account_id": "operator-a",
                    "channel": "web",
                    "status": "healthy",
                    "capabilities": {
                        "auth_metadata": "secret",
                        "auth": "bearer",
                        "profile": "/private/profile",
                        "profile_url": "https://private.example",
                        "path": "/private/path",
                        "safe": "visible",
                    },
                },
                {
                    "sender_account_id": "operator-without-owner",
                    "channel": "web",
                    "status": "healthy",
                },
                {
                    "owner_user_id": "owner-b",
                    "sender_account_id": "operator-other-owner",
                    "channel": "web",
                    "status": "healthy",
                },
            ]
        ),
    )

    response = await call_unwrapped(list_outreach_accounts, request)

    accounts = {row["sender_account_id"]: row for row in response["accounts"]}
    assert set(accounts) == {"web-1", "operator-a"}
    assert accounts["web-1"]["health"] == "enabled"
    assert accounts["web-1"]["capabilities"] == {"safe": "visible"}
    assert accounts["operator-a"]["capabilities"] == {"safe": "visible"}


@pytest.mark.asyncio
async def test_operator_must_be_configured_for_account_reads(repo):
    request = _Request(repo, operator=None)

    with pytest.raises(HTTPException) as error:
        await call_unwrapped(list_outreach_accounts, request)

    assert getattr(error.value, "status_code", None) == 503


@pytest.mark.asyncio
async def test_task_get_is_owner_isolated_and_unknown_retry_uses_current_receipt(repo):
    await _bound(repo)
    owner_request = _Request(repo)
    created = await call_unwrapped(
        create_outreach_tasks,
        owner_request,
        CreateOutreachTaskRequest(
            creator_uid="creator-1",
            sequence_no=1,
            sender_account_id="web-1",
            comment="Hello from the creator team.",
        ),
    )
    tasks = created["tasks"]
    comment_task = next(task for task in tasks if task["action"] == "comment")
    like_task = next(task for task in tasks if task["action"] == "like")

    unknown = await call_unwrapped(
        mark_provider_unknown,
        comment_task["task_id"],
        owner_request,
        ManualReasonRequest(reason="provider did not confirm comment"),
    )
    assert unknown["receipt_state"] == "unknown"
    assert unknown["receipts"][0]["verified"] is False

    # A verified receipt on a different action in the same sequence must not
    # block retrying this comment task.
    like_claim = await repo.claim_action(like_task["task_id"], lease_owner="test-worker")
    assert like_claim is not None
    live_like_claim = await repo.read_action_task(like_task["task_id"])
    assert live_like_claim is not None
    await repo.record_receipt(
        owner_user_id="owner-a",
        creator_uid="creator-1",
        sequence_no=1,
        receipt_id="verified-like",
        kind="public_action_receipt",
        provider_ref="provider-like",
        verification_source="provider_readback",
        payload={"action": "like"},
        verified=True,
    )
    await repo.complete_action(
        like_task["task_id"],
        sender_account_id="web-1",
        idempotency_key=like_claim["idempotency_key"],
        receipt_id="verified-like",
        lease_owner="test-worker",
        lease_token=live_like_claim["lease_token"],
    )

    retried = await call_unwrapped(
        retry_outreach_task,
        comment_task["task_id"],
        owner_request,
    )
    assert retried["state"] == "pending"
    assert retried["receipt_state"] == "unknown"

    owner_detail = await call_unwrapped(
        get_outreach_task,
        comment_task["task_id"],
        owner_request,
    )
    assert owner_detail["task_id"] == comment_task["task_id"]

    with pytest.raises(HTTPException) as error:
        await call_unwrapped(
            get_outreach_task,
            comment_task["task_id"],
            _Request(repo, owner_user_id="owner-b"),
        )
    assert getattr(error.value, "status_code", None) == 404


@pytest.mark.asyncio
async def test_create_task_rejects_sender_mismatch_and_close_blocks_claims(repo):
    await _bound(repo)
    request = _Request(repo)
    with pytest.raises(HTTPException) as error:
        await call_unwrapped(
            create_outreach_tasks,
            request,
            CreateOutreachTaskRequest(
                creator_uid="creator-1",
                sequence_no=1,
                sender_account_id="different-sender",
            ),
        )
    assert getattr(error.value, "status_code", None) == 409

    tasks = await _tasks(repo)
    for receipt_id, kind, next_status in (
        ("public", "public_action_receipt", "public_touched"),
        ("dm", "dm_receipt", "contacted"),
        ("inbound", "verified_inbound", "replied"),
    ):
        await repo.record_receipt(
            owner_user_id="owner-a",
            creator_uid="creator-1",
            sequence_no=1,
            receipt_id=receipt_id,
            kind=kind,
            provider_ref=f"provider-{receipt_id}",
            verification_source="provider_readback",
            payload={"action": receipt_id},
            verified=True,
        )
        await repo.advance_state(
            owner_user_id="owner-a",
            creator_uid="creator-1",
            sequence_no=1,
            receipt_id=receipt_id,
            next_status=next_status,
        )

    closed = await call_unwrapped(
        close_outreach_sequence,
        request,
        CloseSequenceRequest(creator_uid="creator-1", sequence_no=1, reason="sequence complete"),
    )
    assert closed["claim"]["claim"]["status"] == "closed"
    assert await repo.claim_action(tasks[0]["task_id"], lease_owner="worker") is None


@pytest.mark.asyncio
async def test_admin_boundary_is_retained_on_management_writes(repo):
    await _bound(repo)
    tasks = await _tasks(repo)
    non_admin = _Request(repo, admin=False)

    with pytest.raises(HTTPException) as error:
        await call_unwrapped(
            retry_outreach_task,
            tasks[0]["task_id"],
            non_admin,
        )
    assert getattr(error.value, "status_code", None) == 403


@pytest.mark.asyncio
async def test_paused_sender_cannot_claim_pending_action(repo):
    await _bound(repo)
    tasks = await _tasks(repo)
    task_id = tasks[0]["task_id"]

    await repo.set_sender_account_status("owner-a", "web-1", status="paused", reason="health check")
    assert await repo.claim_action(task_id, lease_owner="worker-a") is None

    await repo.set_sender_account_status("owner-a", "web-1", status="enabled", reason="recovered")
    claimed = await repo.claim_action(task_id, lease_owner="worker-a")
    assert claimed is not None
    assert claimed["lease_owner"] == "worker-a"


@pytest.mark.asyncio
async def test_leased_controls_require_cas_lease_and_takeover_preserves_worker(repo):
    await _bound(repo)
    tasks = await _tasks(repo)
    task_id = next(task["task_id"] for task in tasks if task["action"] == "comment")
    claimed = await repo.claim_action(task_id, lease_owner="worker-a")
    assert claimed is not None
    lease = await repo.read_action_task(task_id)
    assert lease is not None
    lease_token = lease["lease_token"]
    assert lease_token

    with pytest.raises(ValueError, match="owned by another worker"):
        await repo.retry_action(
            "owner-a",
            task_id,
            recoverable_error_codes={"provider_unknown"},
        )
    with pytest.raises(ValueError, match="owned by another worker"):
        await repo.mark_action_unknown(
            "owner-a",
            task_id,
            receipt_id="unknown-without-lease",
            reason="provider did not confirm",
        )

    requested = await repo.request_manual_takeover(
        "owner-a",
        task_id,
        reason="operator needs review",
    )
    assert requested["state"] == "leased"
    assert requested["lease_owner"] == "worker-a"
    assert requested["lease_token"] == lease_token
    assert requested["payload_json"]["manual_required"] is True

    unknown = await repo.mark_action_unknown(
        "owner-a",
        task_id,
        receipt_id="unknown-with-lease",
        reason="worker readback unavailable",
        lease_owner="worker-a",
        lease_token=lease_token,
    )
    assert unknown["state"] == "pending"
    assert unknown["lease_token"] is None

    reclaimed = await repo.claim_action(task_id, lease_owner="worker-b")
    assert reclaimed is not None
    reclaimed_row = await repo.read_action_task(task_id)
    assert reclaimed_row is not None
    reclaimed_token = reclaimed_row["lease_token"]
    assert reclaimed_token

    with pytest.raises(ValueError, match="owned by another worker"):
        await repo.retry_action(
            "owner-a",
            task_id,
            recoverable_error_codes={"provider_unknown"},
            lease_owner="worker-a",
            lease_token=lease_token,
        )
    still_owned = await repo.read_action_task(task_id)
    assert still_owned is not None
    assert still_owned["lease_owner"] == "worker-b"

    retried = await repo.retry_action(
        "owner-a",
        task_id,
        recoverable_error_codes={"provider_unknown"},
        lease_owner="worker-b",
        lease_token=reclaimed_token,
    )
    assert retried["state"] == "pending"
    assert retried["lease_token"] is None

    takeover_task_id = next(task["task_id"] for task in tasks if task["action"] == "follow")
    takeover_claim = await repo.claim_action(takeover_task_id, lease_owner="worker-c")
    assert takeover_claim is not None
    takeover_row = await repo.read_action_task(takeover_task_id)
    assert takeover_row is not None
    taken = await repo.request_manual_takeover(
        "owner-a",
        takeover_task_id,
        reason="operator takes over",
        lease_owner="worker-c",
        lease_token=takeover_row["lease_token"],
    )
    assert taken["state"] == "failed"
    assert taken["lease_owner"] is None


@pytest.mark.asyncio
async def test_task_responses_never_expose_lease_credentials(repo):
    await _bound(repo)
    created = await call_unwrapped(
        create_outreach_tasks,
        _Request(repo),
        CreateOutreachTaskRequest(
            creator_uid="creator-1",
            sequence_no=1,
            sender_account_id="web-1",
        ),
    )
    task_id = created["tasks"][0]["task_id"]
    claimed = await repo.claim_action(task_id, lease_owner="worker-private")
    assert claimed is not None
    response = await call_unwrapped(get_outreach_task, task_id, _Request(repo))
    assert "lease_owner" not in response
    assert "lease_token" not in response
