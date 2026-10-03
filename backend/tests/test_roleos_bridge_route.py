"""Focused tests for the host-only Guild/Sales RoleOS admission route."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
import pytest_asyncio
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from test_social_channels import IDENTITY, ROLE, ROLEOS, SCOPE

from app.channels.social import SocialConnection
from app.gateway.auth_disabled import AUTH_SOURCE_INTERNAL, AUTH_SOURCE_SESSION
from app.gateway.routers.roleos import RoleOSSocialRunRequest, _connection_fingerprint, admit_roleos_social_run, poll_roleos_social_run
from app.gateway.services import register_roleos_social_connection
from deerflow.persistence.base import Base
from deerflow.persistence.social import SocialRepository
from deerflow.runtime import RunManager, RunStatus
from deerflow.social.roleos_binding import RoleOSBinding


@pytest_asyncio.fixture
async def repository(tmp_path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'roleos-social.db'}")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    try:
        yield SocialRepository(async_sessionmaker(engine, expire_on_commit=False))
    finally:
        await engine.dispose()


def _connection(repository, *, thread_id: str = "social-thread") -> SocialConnection:
    binding = RoleOSBinding(**{**ROLEOS, "thread_id": thread_id})
    return SocialConnection(
        repository,
        SCOPE,
        IDENTITY,
        ROLE,
        thread_id,
        "synthetic-social",
        "external-creator",
        "workspace",
        "chat",
        identity_verified=True,
        roleos_binding=binding,
    )


def _request(connection, *, internal: bool = True):
    app = SimpleNamespace(state=SimpleNamespace(run_manager=RunManager()))
    register_roleos_social_connection(app, "connection", connection)
    return SimpleNamespace(
        app=app,
        headers={},
        state=SimpleNamespace(auth_source=AUTH_SOURCE_INTERNAL if internal else AUTH_SOURCE_SESSION),
    )


def _body(**overrides):
    values = {
        "company_id": "roleos",
        "member_id": "sales",
        "request_id": "request-1",
        "source_revision": "roleos-r1",
        "connection_id": "connection",
        "thread_id": "social-thread",
        "objective": "Prepare a sales follow-up",
        "input_refs": ["artifact://input/1"],
        "artifact_refs": ["artifact://output/1"],
        "evidence_refs": ["evidence://output/1"],
    }
    values.update(overrides)
    return RoleOSSocialRunRequest(**values)


@pytest.mark.asyncio
async def test_internal_route_projects_registered_social_binding(repository):
    request = _request(_connection(repository))
    record = SimpleNamespace(run_id="native-run-1", thread_id="social-thread")
    with patch("app.gateway.routers.roleos.start_run", new=AsyncMock(return_value=record)) as start:
        response = await admit_roleos_social_run(_body(), request)

    assert response.run_id == "native-run-1"
    native_body, thread_id, forwarded_request = start.await_args.args
    assert forwarded_request is request
    assert thread_id == "social-thread"
    assert native_body.assistant_id == "lead_agent"
    assert native_body.input["messages"][0]["content"] == "Prepare a sales follow-up"
    assert native_body.input["input_refs"] == ["artifact://input/1"]
    assert native_body.input["artifact_refs"] == ["artifact://output/1"]
    assert native_body.input["evidence_refs"] == ["evidence://output/1"]
    assert start.await_args.kwargs["social_binding"].roleos_binding.member_id == "sales"


@pytest.mark.asyncio
async def test_route_rejects_forged_identity_before_native_admission(repository):
    request = _request(_connection(repository))
    with patch("app.gateway.routers.roleos.start_run", new=AsyncMock()) as start:
        with pytest.raises(HTTPException) as exc_info:
            await admit_roleos_social_run(_body(company_id="other-company"), request)
    assert exc_info.value.status_code == 409
    start.assert_not_awaited()


@pytest.mark.asyncio
async def test_route_requires_internal_auth_and_forbids_authority_fields(repository):
    with pytest.raises(HTTPException) as exc_info:
        await admit_roleos_social_run(_body(), _request(_connection(repository), internal=False))
    assert exc_info.value.status_code == 403
    with pytest.raises(ValueError):
        RoleOSSocialRunRequest(**(_body().model_dump() | {"provider": "forged"}))


@pytest.mark.asyncio
async def test_poll_missing_run_returns_scoped_unknown_receipt(repository):
    connection = _connection(repository)
    request = _request(connection)

    class Manager:
        async def get(self, run_id, *, user_id):
            assert run_id == "missing-run"
            assert user_id == SCOPE.owner_user_id
            return None

    request.app.state.channel_service = SimpleNamespace(manager=SimpleNamespace(_social_connections={"connection": connection}))
    with patch("app.gateway.routers.roleos.get_run_manager", return_value=Manager()):
        receipt = await poll_roleos_social_run("missing-run", request, connection_id="connection")
    assert receipt.status == "unknown"
    assert receipt.run_id == "missing-run"
    assert receipt.thread_id == connection.thread_id


@pytest.mark.asyncio
async def test_poll_maps_native_refs_and_artifact_failure(repository):
    connection = _connection(repository)
    request = _request(connection)
    record = SimpleNamespace(
        run_id="native-run-1",
        idempotency_key="roleos-social:request-1",
        thread_id=connection.thread_id,
        assistant_id="lead_agent",
        user_id=SCOPE.owner_user_id,
        status=RunStatus.success,
        error=None,
        metadata={
            "roleos_company_id": "roleos",
            "roleos_member_id": "sales",
            "roleos_source_revision": "roleos-r1",
            "roleos_request_id": "request-1",
            "roleos_connection_id": "connection",
            "roleos_social_scope_fingerprint": _connection_fingerprint(connection),
            "artifact_upload_error": "artifact upload timed out",
        },
        kwargs={"input": {"artifact_refs": ["artifact://output/1"], "evidence_refs": ["evidence://output/1"]}},
    )

    class Manager:
        async def get(self, run_id, *, user_id):
            assert user_id == SCOPE.owner_user_id
            return record

    request.app.state.channel_service = SimpleNamespace(manager=SimpleNamespace(_social_connections={"connection": connection}))
    with patch("app.gateway.routers.roleos.get_run_manager", return_value=Manager()):
        receipt = await poll_roleos_social_run("native-run-1", request, connection_id="connection")
    assert receipt.status == "failed"
    assert receipt.artifact_refs == []
    assert receipt.evidence_refs == []
    assert receipt.error == "artifact upload timed out"
