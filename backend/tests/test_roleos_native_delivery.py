"""HTTP/native persistence regressions; only the model agent is scripted."""

from dataclasses import replace
from types import SimpleNamespace
from uuid import uuid4

import httpx
import pytest
import pytest_asyncio
from fastapi import FastAPI
from langchain_core.messages import AIMessage, ToolMessage
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.store.memory import InMemoryStore
from langgraph.types import Command
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from test_roleos_bridge_route import _body, _connection

from app.gateway.auth_middleware import AuthMiddleware
from app.gateway.internal_auth import create_internal_auth_headers
from app.gateway.routers.roleos import router
from app.gateway.services import register_roleos_social_connection
from deerflow.config.app_config import AppConfig, reset_app_config, set_app_config
from deerflow.config.paths import Paths
from deerflow.persistence.base import Base
from deerflow.persistence.run import RunRepository
from deerflow.persistence.social import SocialRepository
from deerflow.persistence.thread_meta.memory import MemoryThreadMetaStore
from deerflow.runtime import MemoryStreamBridge, RunManager, RunStatus
from deerflow.runtime.events.store.db import DbRunEventStore
from deerflow.runtime.user_context import reset_current_user, set_current_user


@pytest_asyncio.fixture
async def native_host(tmp_path, monkeypatch):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'native.db'}")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    sf = async_sessionmaker(engine, expire_on_commit=False)
    paths = Paths(base_dir=tmp_path / "state")
    monkeypatch.setattr("deerflow.config.paths._paths", paths)
    set_app_config(AppConfig.model_validate({"sandbox": {"use": "deerflow.sandbox.local:LocalSandboxProvider"}}))
    app = FastAPI()
    app.include_router(router)
    app.add_middleware(AuthMiddleware)
    app.state.store = InMemoryStore()
    app.state.thread_store = MemoryThreadMetaStore(app.state.store)
    app.state.checkpointer = InMemorySaver()
    app.state.stream_bridge = MemoryStreamBridge()
    app.state.run_events_config = None
    app.state.run_event_store = DbRunEventStore(sf)
    run_store = RunRepository(sf)
    app.state.run_manager = RunManager(store=run_store, event_store=app.state.run_event_store)
    connection = _connection(SocialRepository(sf))
    register_roleos_social_connection(app, "connection", connection)
    await app.state.thread_store.create("social-thread", user_id="owner")
    host = SimpleNamespace(app=app, paths=paths, run_store=run_store, sf=sf, mode="present", executions=0)

    class ScriptedAgent:
        async def astream(self, graph_input, config=None, stream_mode=None, subgraphs=False):
            host.executions += 1
            if host.mode == "error":
                raise RuntimeError("artifact upload failed")
            if host.mode != "empty":
                output = paths.sandbox_outputs_dir("social-thread", user_id="owner") / "report.md"
                output.parent.mkdir(parents=True, exist_ok=True)
                output.write_text("native generated report", encoding="utf-8")
                if host.mode != "unpresented":
                    journal = config["configurable"]["__pregel_runtime"].context["__run_journal"]
                    journal._remember_current_run_tool_calls(AIMessage(content="", tool_calls=[{"id": "present", "name": "present_files", "args": {}}]), caller="lead_agent")
                    presented = "/mnt/user-data/outputs/old.md" if host.mode == "mismatched" else "/mnt/user-data/outputs/report.md"
                    journal.on_tool_end(Command(update={"artifacts": [presented], "messages": [ToolMessage("Presented", tool_call_id="present")]}), run_id=uuid4())
            yield {"messages": [AIMessage(content="Finished")]}

    monkeypatch.setattr("app.gateway.services.resolve_agent_factory", lambda _: lambda *, config: ScriptedAgent())
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://native", headers=create_internal_auth_headers()) as client:
        host.client = client
        try:
            yield host
        finally:
            for record in list(app.state.run_manager._runs.values()):
                if record.task is not None:
                    await record.task
    reset_app_config()
    await engine.dispose()


async def _execute(host):
    admitted = await host.client.post("/api/internal/roleos/sales/runs", json=_body().model_dump())
    assert admitted.status_code == 202, admitted.text
    run_id = admitted.json()["run_id"]
    record = await host.app.state.run_manager.get(run_id, user_id="owner")
    await record.task
    return run_id


async def _poll(host, run_id, **params):
    return (await host.client.get(f"/api/internal/roleos/sales/runs/{run_id}", params=params)).json()


@pytest.mark.asyncio
async def test_native_generated_file_and_delivery_are_projected_without_input_refs(native_host):
    host = native_host
    run_id = await _execute(host)
    body = await _poll(host, run_id, connection_id="connection")
    assert body["status"] == "succeeded"
    assert len(body["artifact_refs"]) == 1
    assert body["artifact_refs"][0].startswith(f"/api/internal/roleos/sales/runs/{run_id}/artifacts/")
    assert body["native_receipt"]["run_id"] == run_id
    assert body["native_receipt"]["content"]["matched_paths"] == ["/mnt/user-data/outputs/report.md"]
    assert body["evidence_refs"] == [body["native_receipt_ref"]]
    read = await host.client.get(body["artifact_refs"][0])
    assert read.status_code == 200
    assert read.text == "native generated report"
    receipt = await host.client.get(body["native_receipt_ref"])
    assert receipt.json()["native_receipt"] == body["native_receipt"]
    assert not set(_body().artifact_refs + _body().evidence_refs + _body().input_refs).intersection(body["artifact_refs"] + body["evidence_refs"])


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", ["unpresented", "mismatched", "error"])
async def test_native_failed_material_delivery_remains_failed(native_host, mode):
    host = native_host
    host.mode = mode
    body = await _poll(host, await _execute(host), connection_id="connection")
    assert body["status"] == "failed"
    assert body["artifact_refs"] == []
    assert body["native_receipt"]["event_type"] == "run.delivery"
    assert body["error"]


@pytest.mark.asyncio
async def test_no_material_native_terminal_has_empty_output_and_receipt(native_host):
    host = native_host
    host.mode = "empty"
    body = await _poll(host, await _execute(host))
    assert body["status"] == "succeeded"
    assert body["artifact_refs"] == []
    assert body["native_receipt"]["content"] == {"presented": 0, "paths": [], "by_tool": {}}


@pytest.mark.asyncio
async def test_response_loss_lookup_and_duplicate_request_survive_restart(native_host):
    host = native_host
    run_id = await _execute(host)
    await host.app.state.run_manager.cleanup(run_id, delay=0)
    host.app.state.run_manager = RunManager(store=host.run_store, event_store=DbRunEventStore(host.sf))
    host.app.state.run_event_store = DbRunEventStore(host.sf)
    recovered = await host.client.get("/api/internal/roleos/sales/requests/request-1", params={"connection_id": "connection", "source_revision": "roleos-r1"})
    assert recovered.status_code == 200
    assert recovered.json()["run_id"] == run_id
    assert recovered.json()["status"] == "succeeded"
    duplicate = await host.client.post("/api/internal/roleos/guild/runs", json=_body().model_dump())
    assert duplicate.status_code == 202, duplicate.text
    assert duplicate.json()["run_id"] == run_id
    assert host.executions == 1
    conflict = await host.client.post("/api/internal/roleos/sales/runs", json=_body(acceptance_criteria=["changed"]).model_dump())
    assert conflict.status_code == 409
    assert host.executions == 1


@pytest.mark.asyncio
async def test_scoped_artifact_read_rejects_unverified_path_and_other_connection(native_host):
    host = native_host
    run_id = await _execute(host)
    result = await _poll(host, run_id)
    unverified = f"/api/internal/roleos/sales/runs/{run_id}/artifacts/mnt/user-data/outputs/other.md"
    assert (await host.client.get(unverified, params={"connection_id": "connection"})).status_code == 404
    assert (await host.client.get(result["artifact_refs"][0], headers={"X-DeerFlow-Internal-Token": "wrong"})).status_code in {401, 403}
    connection = host.app.state.roleos_social_connections["connection"]
    register_roleos_social_connection(host.app, "other", connection)
    other = await _poll(host, run_id, connection_id="other")
    assert other["status"] == "unknown"
    assert other["native_receipt"] is None
    assert (await host.client.get(result["artifact_refs"][0].replace("connection_id=connection", "connection_id=other"))).status_code == 404
    wrong_source = await host.client.get("/api/internal/roleos/sales/requests/request-1", params={"connection_id": "connection", "source_revision": "other"})
    assert wrong_source.status_code == 409
    outsider = replace(connection, scope=replace(connection.scope, owner_user_id="outsider"))
    register_roleos_social_connection(host.app, "outsider", outsider)
    out = await _poll(host, run_id, connection_id="outsider")
    assert out["status"] == "unknown"
    assert out["artifact_refs"] == []


@pytest.mark.asyncio
async def test_missing_native_receipt_or_missing_output_cannot_report_success(native_host):
    host = native_host
    run_id = await _execute(host)
    host.paths.sandbox_outputs_dir("social-thread", user_id="owner").joinpath("report.md").unlink()
    missing_file = await _poll(host, run_id)
    assert missing_file["status"] == "failed"
    assert missing_file["artifact_refs"] == []
    token = set_current_user(SimpleNamespace(id="owner"))
    try:
        await host.app.state.run_event_store.delete_by_run("social-thread", run_id)
    finally:
        reset_current_user(token)
    missing_receipt = await _poll(host, run_id)
    assert missing_receipt["status"] == "unknown"
    assert missing_receipt["native_receipt"] is None
    assert missing_receipt["artifact_refs"] == []


@pytest.mark.asyncio
@pytest.mark.parametrize("status", [RunStatus.error, RunStatus.timeout, RunStatus.interrupted, RunStatus.pending, RunStatus.running])
async def test_all_native_statuses_keep_terminal_mapping(native_host, status):
    host = native_host
    host.mode = "empty"
    run_id = await _execute(host)
    record = await host.app.state.run_manager.get(run_id)
    record.status = status
    result = await _poll(host, run_id)
    assert result["status"] == ("failed" if status in {RunStatus.error, RunStatus.timeout, RunStatus.interrupted} else "unknown")


@pytest.mark.asyncio
async def test_active_duplicate_request_executes_once(native_host):
    import asyncio

    host = native_host
    started, release = asyncio.Event(), asyncio.Event()

    class WaitingAgent:
        async def astream(self, graph_input, config=None, stream_mode=None, subgraphs=False):
            host.executions += 1
            started.set()
            await release.wait()
            yield {"messages": []}

    from unittest.mock import patch

    with patch("app.gateway.services.resolve_agent_factory", return_value=lambda *, config: WaitingAgent()):
        first = await host.client.post("/api/internal/roleos/sales/runs", json=_body().model_dump())
        await started.wait()
        try:
            duplicate = await host.client.post("/api/internal/roleos/social/runs", json=_body().model_dump())
            assert duplicate.status_code == 202
            assert duplicate.json()["run_id"] == first.json()["run_id"]
            assert host.executions == 1
            assert (await _poll(host, first.json()["run_id"]))["status"] == "unknown"
        finally:
            release.set()
            record = await host.app.state.run_manager.get(first.json()["run_id"])
            await record.task


@pytest.mark.asyncio
async def test_native_receipt_for_another_run_cannot_be_borrowed(native_host, monkeypatch):
    host = native_host
    run_id = await _execute(host)
    native = (await _poll(host, run_id))["native_receipt"]
    from unittest.mock import AsyncMock

    monkeypatch.setattr(host.app.state.run_event_store, "list_events", AsyncMock(return_value=[{**native, "run_id": "foreign-run"}]))
    result = await _poll(host, run_id)
    assert result["status"] == "unknown"
    assert result["native_receipt"] is None
    assert result["artifact_refs"] == []


@pytest.mark.asyncio
async def test_missing_request_lookup_does_not_execute(native_host):
    result = await native_host.client.get("/api/internal/roleos/guild/requests/missing", params={"connection_id": "connection"})
    assert result.status_code == 200
    assert result.json()["status"] == "unknown"
    assert result.json()["request_id"] == "missing"
    assert result.json()["run_id"] == ""
    assert native_host.executions == 0


@pytest.mark.asyncio
async def test_verified_path_symlink_escape_and_traversal_are_rejected(native_host):
    host = native_host
    run_id = await _execute(host)
    result = await _poll(host, run_id)
    output = host.paths.sandbox_outputs_dir("social-thread", user_id="owner") / "report.md"
    output.unlink()
    target = output.parent.parent / "private.txt"
    target.write_text("private input", encoding="utf-8")
    output.symlink_to(target)
    assert (await _poll(host, run_id))["status"] == "failed"
    assert (await host.client.get(result["artifact_refs"][0])).status_code == 404
    traversal = f"/api/internal/roleos/sales/runs/{run_id}/artifacts/mnt/user-data/outputs/%2e%2e/private.txt?connection_id=connection"
    assert (await host.client.get(traversal)).status_code in {400, 404}


@pytest.mark.asyncio
@pytest.mark.parametrize("reconstructed", [False, True])
async def test_request_reuse_rejects_other_native_owner_without_execution(native_host, reconstructed):
    host = native_host
    await _execute(host)
    if reconstructed:
        host.app.state.run_manager = RunManager(store=host.run_store, event_store=DbRunEventStore(host.sf))
    connection = host.app.state.roleos_social_connections["connection"]
    outsider = replace(connection, scope=replace(connection.scope, owner_user_id="outsider"), thread_id="other-thread", roleos_binding=replace(connection.roleos_binding, thread_id="other-thread"))
    register_roleos_social_connection(host.app, "outsider", outsider)
    await host.app.state.thread_store.create("other-thread", user_id="outsider")
    conflict = await host.client.post("/api/internal/roleos/sales/runs", json=_body(connection_id="outsider", thread_id="other-thread").model_dump())
    assert conflict.status_code == 409
    assert host.executions == 1


@pytest.mark.asyncio
async def test_memory_request_lookup_enforces_owner_before_and_after_reconstruction():
    from deerflow.runtime.runs.store.memory import MemoryRunStore

    store = MemoryRunStore()
    manager = RunManager(store=store)
    record = await manager.create_or_reject("thread", user_id="owner", idempotency_key="request")
    assert await manager.get_by_idempotency_key("request", user_id="other") is None
    assert (await manager.get_by_idempotency_key("request", user_id="owner")).run_id == record.run_id
    await manager.set_status(record.run_id, RunStatus.success)
    recovered = RunManager(store=store)
    assert (await recovered.get_by_idempotency_key("request", user_id="owner")).run_id == record.run_id
    assert await recovered.get_by_idempotency_key("request", user_id="other") is None


@pytest.mark.asyncio
async def test_reconfigured_native_account_cannot_borrow_previous_delivery(native_host):
    from types import MappingProxyType

    host = native_host
    run_id = await _execute(host)
    original = host.app.state.roleos_social_connections["connection"]
    replacement = replace(original, scope=replace(original.scope, account_id="different-account"))
    host.app.state.roleos_social_connections = MappingProxyType({"connection": replacement})
    response = await _poll(host, run_id)
    assert response["status"] == "unknown"
    assert response["native_receipt"] is None


@pytest.mark.asyncio
async def test_copied_client_metadata_without_native_request_reservation_is_rejected(native_host):
    host = native_host
    run_id = await _execute(host)
    record = await host.app.state.run_manager.get(run_id)
    record.idempotency_key = None
    response = await _poll(host, run_id)
    assert response["status"] == "unknown"
    assert response["native_receipt"] is None


@pytest.mark.asyncio
async def test_missing_native_matched_material_stays_failed(native_host, monkeypatch):
    from unittest.mock import AsyncMock

    host = native_host
    run_id = await _execute(host)
    native = (await _poll(host, run_id))["native_receipt"]
    content = dict(native["content"])
    content.pop("matched_paths")
    monkeypatch.setattr(host.app.state.run_event_store, "list_events", AsyncMock(return_value=[{**native, "content": content}]))
    response = await _poll(host, run_id)
    assert response["status"] == "failed"
    assert response["artifact_refs"] == []
