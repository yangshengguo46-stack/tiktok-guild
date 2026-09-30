from __future__ import annotations

import asyncio
import json
import os
import shutil
import signal
import socket
import sys
import threading
from datetime import UTC, datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.gateway.public_outreach_service import NodeExecutorTransport, PublicOutreachService
from deerflow.creator_agent.public_outreach import PublicOutreachWorkflow
from deerflow.persistence.base import Base
from deerflow.persistence.creator_agent_relationship import CreatorOutreachRepository
from deerflow.persistence.creator_agent_relationship.model import CreatorClaimRow, CreatorOutreachActionTaskRow, CreatorOutreachReceiptRow, CreatorOutreachSequenceRow

ROOT = Path(__file__).resolve().parents[2]
WORKER = ROOT / "ops/guild-runtime/public-outreach-operator/src/execution-worker.mjs"


@pytest_asyncio.fixture
async def repo(tmp_path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'native.db'}")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    repository = CreatorOutreachRepository(async_sessionmaker(engine, expire_on_commit=False))
    yield repository
    await engine.dispose()


async def bound(repo, channel="ios"):
    await repo.register_sender_account("owner", "sender", channel, external_ref="@alice", device_ref="test-phone" if channel == "ios" else None)
    await repo.claim_creator(owner_user_id="owner", creator_uid="creator")
    await repo.bind_sequence(owner_user_id="owner", creator_uid="creator", sender_account_id="sender")
    tasks = await PublicOutreachWorkflow(repo).create_public_outreach_tasks("owner", "creator", 1, "sender", ["like", "comment", "follow", "message"])
    for task in tasks:
        await repo.update_action_payload("owner", task["task_id"], {"comment": "hello", "message": "hello"})
    return tasks


@pytest.fixture
def web_proxy_server():
    # The fake Chromium never uses this socket; it verifies the real preflight's TCP gate.
    endpoint = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    endpoint.bind(("127.0.0.1", 0))
    endpoint.listen(16)
    try:
        yield f"http://127.0.0.1:{endpoint.getsockname()[1]}"
    finally:
        endpoint.close()


class Provider(BaseHTTPRequestHandler):
    state = None

    def log_message(self, *args):
        pass

    def do_DELETE(self):
        self.state["deleted"] += 1
        self.send({})

    def do_GET(self):
        value = {}
        if self.path == "/status":
            value = {"ready": True, "build": {"productBundleIdentifier": "test.wda", "time": "today"}, "os": {"name": "iOS"}}
        elif self.path.endswith("/displayed"):
            value = True
        elif "/attribute/" in self.path:
            key = self.path.split("/attribute/")[1]
            control = self.path.split("/element/")[1].split("/")[0]
            attrs = {
                "current-user": {"data-sender-handle": "@alice"},
                "user-profile": {"data-creator-uid": "creator"},
                "like-button": {"aria-pressed": str(self.state["like"]).lower()},
                "follow-button": {"aria-pressed": str(self.state["follow"]).lower()},
                "comment-item": {"data-receipt-id": "new-comment", "data-sender-handle": "@alice", "data-creator-uid": "creator"},
                "message-item": {"data-receipt-id": "new-message", "data-sender-handle": "@alice", "data-creator-uid": "creator"},
            }
            value = attrs.get(control, {}).get(key)
        elif self.path.endswith("/text"):
            value = "hello"
        self.send(value)

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))) or b"{}")
        value = {}
        if self.path == "/session":
            self.state["sessions"] += 1
            value = {"sessionId": f"session-{self.state['sessions']}", "capabilities": {"platformName": "iOS", "appium:automationName": "XCUITest", "appium:udid": "test-udid"}}
        elif body.get("script") == "mobile: deviceInfo":
            value = {"UniqueDeviceID": "test-udid"}
        elif body.get("script") == "mobile: isLocked":
            value = False
        elif self.path.endswith("/element") or self.path.endswith("/elements"):
            name = body["value"]
            self.state["locators"].append((body["using"], name))
            raw = {"element-6066-11e4-a52e-4f735466cecf": name}
            if self.path.endswith("/elements"):
                value = [raw] if self.state.get(name) else []
            elif name in {"login-button", "captcha-container"}:
                return self.send({"error": "no such element"}, 404)
            else:
                value = raw
        elif self.path.endswith("/click"):
            control = self.path.split("/element/")[1].split("/")[0]
            self.state["actions"].append(control)
            if control == "like-button":
                self.state["like"] = True
            if control == "follow-button":
                self.state["follow"] = True
            if control == "comment-submit":
                self.state["comment-item"] = True
            if control == "message-submit":
                self.state["message-item"] = True
        self.send(value)

    def send(self, value, status=200):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps({"value": value}).encode())


@pytest.fixture
def provider():
    state = {"sessions": 0, "deleted": 0, "like": False, "follow": False, "actions": [], "locators": []}
    handler = type("BoundProvider", (Provider,), {"state": state})
    http = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=http.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{http.server_port}", state
    http.shutdown()
    http.server_close()
    thread.join()


def config(url):
    return {
        "pilot": {"enabled": True, "owner_user_id": "owner", "sender_account_id": "sender", "creator_uid": "creator", "actions": ["like", "comment", "follow", "message"], "message_enabled": True},
        "sender": {"owner_user_id": "owner", "sender_account_id": "sender", "channel": "ios", "appium_url": url, "wda_url": url, "device": {"udid": "test-udid", "platform_version": "18", "wda_bundle_id": "test.wda"}},
    }


@pytest.mark.asyncio
async def test_native_task_real_node_appium_transport_stores_receipt_and_never_replays(repo, tmp_path, provider):
    url, state = provider
    tasks = await bound(repo)
    source = tmp_path / "execution.json"
    source.write_text(json.dumps(config(url)))
    transport = NodeExecutorTransport(worker_path=WORKER, config_path=source, runtime_root=tmp_path / "runtime", node=shutil.which("node"))
    service = PublicOutreachService(repo, transport, config=config(url))
    try:
        with pytest.raises(ValueError, match="order"):
            await service.execute_task("owner", tasks[1]["task_id"])
        with pytest.raises(ValueError, match="not found"):
            await service.execute_task("other", tasks[0]["task_id"])
        assert state["sessions"] == 0
        for task in tasks:
            result = await service.execute_task("owner", task["task_id"])
            assert result["task"]["state"] == "completed", result
            receipt = await repo.read_action_receipt("owner", task["task_id"])
            assert receipt["verified"] is True
            assert receipt["payload_json"]["observed_creator"]["creator_uid"] == "creator"
            if task["action"] in {"like", "follow"}:
                assert receipt["payload_json"]["transition"] == {"before": False, "after": True}
            assert receipt["payload_json"]["observed_sender"]["handle"] == "@alice"
        assert (await repo.read_model(owner_user_id="owner", creator_uid="creator"))["claim"]["status"] == "contacted"
        assert state["actions"] == ["like-button", "comment-submit", "follow-button", "message-submit"]
        assert state["deleted"] == 4
        assert (await service.execute_task("owner", tasks[-1]["task_id"]))["status"] == "duplicate"
        assert state["sessions"] == 4
    finally:
        await service.close()
    assert transport.process is None


@pytest.mark.asyncio
async def test_default_gate_never_starts_executor_or_claims_native_task(repo, tmp_path):
    tasks = await bound(repo)
    transport = NodeExecutorTransport(worker_path=WORKER, config_path=None, runtime_root=tmp_path)
    service = PublicOutreachService(repo, transport, config={})
    assert (await service.execute_task("owner", tasks[0]["task_id"]))["error_code"] == "pilot_required"
    assert transport.process is None
    assert (await repo.read_action_task(tasks[0]["task_id"]))["attempt_count"] == 0


class PreparedWebTransport:
    def __init__(self, *, ready=True):
        self.ready = ready
        self.events = []

    async def prepare_web(self, **request):
        self.events.append(("prepare", request["account"]["sender_account_id"]))
        if not self.ready:
            return {"ready": False, "error_code": "egress_country_mismatch"}
        return {"ready": True, "preparation_id": "prepared-once", "observed_country": "US"}

    async def execute(self, **request):
        self.events.append(("execute", request.get("preparation_id")))
        return {
            "verified": True,
            "provider_ref": "web-readback-like-1",
            "verification_source": "provider_readback",
            "receipt_payload": {
                "receipt_type": "public_action_receipt",
                "action": request["action"],
                "sender_account_id": request["account"]["sender_account_id"],
                "creator_uid": request["creator"]["creator_uid"],
                "evidence": ["synthetic-provider-readback"],
            },
        }

    async def release_web(self, **request):
        self.events.append(("release", request["preparation_id"]))
        return {"released": True}

    async def close(self):
        pass


@pytest.mark.asyncio
async def test_web_network_failure_blocks_before_native_claim_or_external_attempt(repo):
    tasks = await bound(repo, channel="web")
    transport = PreparedWebTransport(ready=False)
    service = PublicOutreachService(repo, transport, config=config("http://127.0.0.1:1"))
    result = await service.execute_task("owner", tasks[0]["task_id"])
    assert result["status"] == "blocked"
    assert result["error_code"] == "egress_country_mismatch"
    current = await repo.read_action_task(tasks[0]["task_id"])
    assert current["state"] == "pending"
    assert current["attempt_count"] == 0
    assert transport.events == [("prepare", "sender")]


@pytest.mark.asyncio
async def test_web_action_uses_prepared_browser_and_releases_it_after_native_result(repo):
    tasks = await bound(repo, channel="web")
    transport = PreparedWebTransport()
    service = PublicOutreachService(repo, transport, config=config("http://127.0.0.1:1"))
    result = await service.execute_task("owner", tasks[0]["task_id"])
    assert result["task"]["state"] == "completed"
    assert transport.events == [("prepare", "sender"), ("execute", "prepared-once"), ("release", "prepared-once")]


@pytest.mark.asyncio
async def test_explicit_network_preflight_releases_browser_and_checks_owner(repo):
    await bound(repo, channel="web")
    transport = PreparedWebTransport()
    service = PublicOutreachService(repo, transport, config=config("http://127.0.0.1:1"))
    with pytest.raises(ValueError, match="not found"):
        await service.preflight_web_account("other", "sender")
    result = await service.preflight_web_account("owner", "sender")
    assert result == {"ready": True, "observed_country": "US"}
    assert transport.events == [("prepare", "sender"), ("release", "prepared-once")]


@pytest.mark.asyncio
async def test_prepared_browser_is_released_when_native_workflow_returns_before_action(repo, monkeypatch):
    tasks = await bound(repo, channel="web")
    transport = PreparedWebTransport()
    service = PublicOutreachService(repo, transport, config=config("http://127.0.0.1:1"))

    async def return_before_claim(self, task_id, *, creator):
        return {"status": "blocked", "error_code": "sender_paused", "task": await repo.read_action_task(task_id)}

    monkeypatch.setattr(PublicOutreachWorkflow, "execute_task", return_before_claim)
    result = await service.execute_task("owner", tasks[0]["task_id"])
    assert result["status"] == "blocked"
    assert transport.events == [("prepare", "sender"), ("release", "prepared-once")]
    assert (await repo.read_action_task(tasks[0]["task_id"]))["attempt_count"] == 0


@pytest.mark.asyncio
async def test_ios_action_does_not_prepare_web_browser(repo):
    tasks = await bound(repo, channel="ios")
    transport = PreparedWebTransport()
    service = PublicOutreachService(repo, transport, config=config("http://127.0.0.1:1"))
    result = await service.execute_task("owner", tasks[0]["task_id"])
    assert result["task"]["state"] == "completed"
    assert transport.events == [("execute", None)]


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", ["timeout", "exit", "cancel"])
async def test_lost_execution_becomes_durable_manual_required_without_blind_retry(repo, tmp_path, mode):
    tasks = await bound(repo)
    worker = tmp_path / "worker.mjs"
    worker.write_text("process.stdin.on('data',()=>" + ("process.exit(3)" if mode == "exit" else "setInterval(()=>{},1000)") + ");")
    source = tmp_path / "execution.json"
    source.write_text("{}")
    transport = NodeExecutorTransport(worker_path=worker, config_path=source, runtime_root=tmp_path, node=shutil.which("node"), timeout_seconds=0.2, shutdown_seconds=0.1)
    service = PublicOutreachService(repo, transport, config=config("http://127.0.0.1:1"))
    try:
        if mode == "cancel":
            execution = asyncio.create_task(service.execute_task("owner", tasks[0]["task_id"]))
            await transport.started.wait()
            await service.cancel_task(tasks[0]["task_id"])
            with pytest.raises(asyncio.CancelledError):
                await execution
        else:
            assert (await service.execute_task("owner", tasks[0]["task_id"]))["status"] == "unknown"
        task = await repo.read_action_task(tasks[0]["task_id"])
        assert task["state"] == "failed"
        assert task["error_code"]
        assert (await repo.read_sender_account("owner", "sender"))["status"] == "paused"
        with pytest.raises(ValueError, match="manual"):
            await service.execute_task("owner", task["task_id"])
        assert transport.process is None
    finally:
        await service.close()


@pytest.mark.asyncio
async def test_native_api_auth_owner_admin_permissions_and_no_completion_spoof(repo, tmp_path, monkeypatch):
    from types import SimpleNamespace

    import httpx
    from fastapi import FastAPI

    from app.gateway import authz, deps
    from app.gateway.internal_auth import create_internal_auth_headers
    from app.gateway.routers.public_outreach import router

    tasks = await bound(repo)
    service = PublicOutreachService(repo, NodeExecutorTransport(worker_path=WORKER, config_path=None, runtime_root=tmp_path), config={})
    users = {key: SimpleNamespace(id=key, system_role=role) for key, role in [("owner", "admin"), ("other", "admin"), ("reader", "user"), ("denied", "admin")]}

    async def get_user(owner):
        return users.get(owner)

    async def permissions(request, user):
        return [] if user.id == "denied" else ["threads:read", "threads:write"]

    monkeypatch.setattr(deps, "get_local_provider", lambda: SimpleNamespace(get_user=get_user))
    monkeypatch.setattr(authz, "resolve_route_permissions_for_request", permissions)
    app = FastAPI()
    app.include_router(router)
    app.state.creator_outreach_repo = repo
    app.state.public_outreach_operator = service
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        path = "/api/public-outreach/native/"
        assert (await client.post(path + "getAction", json={"task_id": tasks[0]["task_id"]}, headers={"X-DeerFlow-Owner-User-Id": "owner"})).status_code == 401
        assert (await client.post(path + "getAction", json={"task_id": tasks[0]["task_id"]}, headers={"X-DeerFlow-Internal-Token": "wrong", "X-DeerFlow-Owner-User-Id": "owner"})).status_code == 401
        assert (await client.post(path + "getAction", json={"task_id": tasks[0]["task_id"]}, headers=create_internal_auth_headers(owner_user_id="other"))).status_code == 404
        assert (await client.post(path + "getAction", json={"task_id": tasks[0]["task_id"]}, headers=create_internal_auth_headers(owner_user_id="denied"))).status_code == 403
        assert (await client.post(path + "registerSenderAccount", json={"sender_account_id": "bad", "channel": "web", "external_ref": "@bad"}, headers=create_internal_auth_headers(owner_user_id="reader"))).status_code == 403
        for method in ["claimAction", "completeAction", "failAction"]:
            response = await client.post(path + method, json={"task_id": tasks[0]["task_id"], "receipt": {"verified": True}}, headers=create_internal_auth_headers(owner_user_id="owner"))
            assert response.status_code == 422
        assert (await client.post(path + "completeAction", json={"task_id": tasks[0]["task_id"]}, headers=create_internal_auth_headers(owner_user_id="owner"))).status_code == 409
        assert (await client.post(path + "claimAction", json={"task_id": tasks[0]["task_id"]}, headers=create_internal_auth_headers(owner_user_id="owner"))).status_code == 409
        assert (await client.post(path + "failAction", json={"task_id": tasks[0]["task_id"], "reason": "x" * 501}, headers=create_internal_auth_headers(owner_user_id="owner"))).status_code == 422
        assert (await client.post(path + "getAction", json={"task_id": tasks[0]["task_id"], "owner_user_id": "other"}, headers=create_internal_auth_headers(owner_user_id="owner"))).status_code == 422
        assert (await client.post("/api/public-outreach/tasks/" + tasks[0]["task_id"] + "/execute", json={}, headers=create_internal_auth_headers(owner_user_id="owner"))).json()["error_code"] == "pilot_required"
    assert service.transport.process is None
    assert (await repo.read_action_task(tasks[0]["task_id"]))["state"] == "pending"


@pytest.mark.asyncio
@pytest.mark.parametrize("field,value", [("owner_user_id", "other"), ("sender_account_id", "other"), ("creator_uid", "other"), ("actions", []), ("enabled", False)])
async def test_pilot_allowlist_mismatch_blocks_before_claim_or_provider(repo, tmp_path, field, value):
    tasks = await bound(repo)
    configuration = config("http://127.0.0.1:1")
    configuration["pilot"][field] = value
    service = PublicOutreachService(repo, NodeExecutorTransport(worker_path=WORKER, config_path=None, runtime_root=tmp_path), config=configuration)
    assert (await service.execute_task("owner", tasks[0]["task_id"]))["error_code"] == "pilot_required"
    assert service.transport.process is None
    assert (await repo.read_action_task(tasks[0]["task_id"]))["attempt_count"] == 0


@pytest.mark.asyncio
async def test_message_requires_separate_pilot_permission_before_provider(repo, tmp_path):
    tasks = await bound(repo)
    configuration = config("http://127.0.0.1:1")
    configuration["pilot"]["message_enabled"] = False
    service = PublicOutreachService(repo, NodeExecutorTransport(worker_path=WORKER, config_path=None, runtime_root=tmp_path), config=configuration)
    message = tasks[-1]
    assert message["action"] == "message"
    assert (await service.execute_task("owner", message["task_id"]))["error_code"] == "pilot_required"
    assert service.transport.process is None
    assert (await repo.read_action_task(message["task_id"]))["attempt_count"] == 0


@pytest.mark.asyncio
async def test_gateway_composition_installs_scoped_mcp_identity_and_cleans_lifetime(repo, tmp_path, monkeypatch):
    from fastapi import FastAPI

    from app.gateway.public_outreach_service import close_public_outreach, initialize_public_outreach
    from deerflow.mcp.outreach_auth import public_outreach_session_env

    monkeypatch.delenv("PUBLIC_OUTREACH_EXECUTION_CONFIG", raising=False)
    monkeypatch.setenv("PUBLIC_OUTREACH_RUNTIME_ROOT", str(tmp_path))
    from types import SimpleNamespace

    from app.gateway import config as gateway_config

    monkeypatch.delenv("PUBLIC_OUTREACH_GATEWAY_URL", raising=False)
    monkeypatch.setattr(gateway_config, "get_gateway_config", lambda: SimpleNamespace(port=8765))
    app = FastAPI()
    app.state.creator_outreach_repo = repo
    await initialize_public_outreach(app)
    assert app.state.public_outreach_operator.configured
    alice = public_outreach_session_env("alice")
    bob = public_outreach_session_env("bob")
    assert alice["DEERFLOW_OUTREACH_OWNER_USER_ID"] == "alice"
    assert bob["DEERFLOW_OUTREACH_OWNER_USER_ID"] == "bob"
    assert alice["DEERFLOW_OUTREACH_INTERNAL_TOKEN"]
    assert alice["DEERFLOW_OUTREACH_GATEWAY_URL"] == "http://127.0.0.1:8765"
    assert app.state.public_outreach_operator.transport.process is None
    await close_public_outreach(app)
    assert public_outreach_session_env("alice") == {}


@pytest.mark.asyncio
@pytest.mark.parametrize("production,owner,expected", [(False, "default", 200), (False, "someone", 401), (True, "default", 401)])
async def test_native_mcp_local_synthetic_owner_uses_existing_nonproduction_gate(repo, tmp_path, monkeypatch, production, owner, expected):
    from types import SimpleNamespace

    import httpx
    from fastapi import FastAPI

    from app.gateway import authz, deps
    from app.gateway.internal_auth import create_internal_auth_headers
    from app.gateway.routers.public_outreach import router

    async def get_user(owner):
        return None

    async def permissions(request, user):
        return ["threads:read", "threads:write"]

    monkeypatch.setattr(deps, "get_local_provider", lambda: SimpleNamespace(get_user=get_user))
    monkeypatch.setattr(authz, "resolve_route_permissions_for_request", permissions)
    monkeypatch.setenv("DEER_FLOW_AUTH_DISABLED", "1")
    monkeypatch.setenv("DEER_FLOW_ENV", "production" if production else "development")
    monkeypatch.delenv("ENVIRONMENT", raising=False)
    app = FastAPI()
    app.include_router(router)
    app.state.creator_outreach_repo = repo
    app.state.public_outreach_operator = PublicOutreachService(repo, NodeExecutorTransport(worker_path=WORKER, config_path=None, runtime_root=tmp_path), config={})
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        response = await client.post("/api/public-outreach/native/listSenderAccounts", json={}, headers=create_internal_auth_headers(owner_user_id=owner))
        assert response.status_code == expected


@pytest.mark.asyncio
async def test_mcp_pooled_stdio_credentials_follow_runtime_identity_not_config(tmp_path, monkeypatch):
    from types import SimpleNamespace
    from unittest.mock import AsyncMock, MagicMock

    from langchain_core.tools import StructuredTool

    from deerflow.mcp import tools
    from deerflow.mcp.outreach_auth import set_public_outreach_auth_provider

    session = AsyncMock()
    session.call_tool.return_value = SimpleNamespace(content=[], isError=False, structuredContent=None)
    pool = MagicMock()
    pool.get_session = AsyncMock(return_value=session)
    monkeypatch.setattr(tools, "get_session_pool", lambda: pool)
    monkeypatch.setattr(tools, "get_paths", lambda: MagicMock())
    monkeypatch.setattr(tools, "_prepare_stdio_workspace", lambda *a, **k: (tmp_path, tmp_path / "tmp", {}))
    monkeypatch.setattr(tools, "resolve_runtime_user_id", lambda runtime: runtime.context["user_id"])

    async def call(query: str) -> str:
        return query

    set_public_outreach_auth_provider(lambda owner: {"DEERFLOW_OUTREACH_OWNER_USER_ID": owner, "DEERFLOW_OUTREACH_INTERNAL_TOKEN": "trusted-" + owner})
    try:
        tool = tools._make_session_pool_tool(
            StructuredTool.from_function(coroutine=call, name="public_outreach_accounts", description="accounts"),
            "public_outreach_operator",
            {"transport": "stdio", "command": "node", "env": {"DEERFLOW_OUTREACH_OWNER_USER_ID": "global-owner", "DEERFLOW_OUTREACH_INTERNAL_TOKEN": "untrusted-fixed"}},
            tool_name_prefix=False,
        )
        for owner in ["alice", "bob"]:
            await tool.coroutine(query="list", runtime=SimpleNamespace(context={"user_id": owner, "thread_id": "same-thread"}))
        calls = pool.get_session.call_args_list
        assert calls[0].args[1].startswith("alice:")
        assert calls[1].args[1].startswith("bob:")
        assert calls[0].args[2]["env"]["DEERFLOW_OUTREACH_OWNER_USER_ID"] == "alice"
        assert calls[1].args[2]["env"]["DEERFLOW_OUTREACH_INTERNAL_TOKEN"] == "trusted-bob"
    finally:
        set_public_outreach_auth_provider(None)


@pytest.mark.asyncio
async def test_native_web_sequence_uses_shipped_node_composition_and_method_shaped_chromium(repo, tmp_path, web_proxy_server):
    tasks = await bound(repo, "web")
    configuration = config("http://127.0.0.1:1")
    configuration["sender"] = {"owner_user_id": "owner", "sender_account_id": "sender", "channel": "web", "web_route": {"proxy_server": web_proxy_server, "expected_country": "US"}}
    source = tmp_path / "web-config.json"
    source.write_text(json.dumps(configuration))
    worker = ROOT / "ops/guild-runtime/public-outreach-operator/fixtures/web-worker.mjs"
    transport = NodeExecutorTransport(worker_path=worker, config_path=source, runtime_root=tmp_path / "runtime", node=shutil.which("node"))
    service = PublicOutreachService(repo, transport, config=configuration)
    try:
        for task in tasks:
            result = await service.execute_task("owner", task["task_id"])
            assert result["task"]["state"] == "completed", result
            receipt = await repo.read_action_receipt("owner", task["task_id"])
            assert receipt["verified"] is True
            assert receipt["payload_json"]["observed_creator"]["creator_uid"] == "creator"
            if task["action"] in {"like", "follow"}:
                assert receipt["payload_json"]["transition"] == {"before": False, "after": True}
        assert (await repo.read_model(owner_user_id="owner", creator_uid="creator"))["claim"]["status"] == "contacted"
        assert (await service.capacity())["active"] == 0
    finally:
        await service.close()


@pytest.mark.asyncio
async def test_capacity_keeps_unconfirmed_browser_cleanup_occupied_after_owner_death(repo, tmp_path):
    slots = tmp_path / "slots" / "web"
    slots.mkdir(parents=True)
    (slots / "0.lock").write_text(json.dumps({"pid": 999999999, "cleanup_required": True}))
    (slots / "1.lock").write_text(json.dumps({"pid": 999999998}))
    (slots / "2.lock").write_text("interrupted lock write")
    transport = NodeExecutorTransport(worker_path=WORKER, config_path=None, runtime_root=tmp_path)
    service = PublicOutreachService(repo, transport, config={})
    assert await service.capacity() == {"active": 2, "active_limit": 10}


@pytest.mark.asyncio
@pytest.mark.parametrize("newer", ["dispatched", "ordinary_pending"])
async def test_ordinary_payload_stale_read_cannot_erase_dispatch_or_newer_text(tmp_path, newer):
    entered = asyncio.Event()
    resume = asyncio.Event()

    class DelayedUserRead(AsyncSession):
        async def get(self, entity, *args, **kwargs):
            row = await super().get(entity, *args, **kwargs)
            if entity is CreatorOutreachActionTaskRow and asyncio.current_task().get_name() == "old-caller":
                entered.set()
                await resume.wait()
            return row

    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'stale.db'}")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    repo = CreatorOutreachRepository(async_sessionmaker(engine, class_=DelayedUserRead, expire_on_commit=False))
    try:
        tasks = await bound(repo)
        task = tasks[0]
        if newer == "dispatched":
            claim = await repo.claim_action(task["task_id"], lease_owner="native-worker")
        stale = asyncio.create_task(repo.update_action_payload("owner", task["task_id"], {"comment": "old ordinary text"}), name="old-caller")
        await asyncio.wait_for(entered.wait(), 5)
        if newer == "dispatched":
            await repo.mark_external_attempt_started(task["task_id"], lease_owner=claim["lease_owner"], lease_token=claim["lease_token"])
        else:
            await repo.update_action_payload("owner", task["task_id"], {"comment": "newer ordinary text"})
        resume.set()
        with pytest.raises(ValueError, match="pending|changed|dispatch"):
            await stale
        current = await repo.read_action_task(task["task_id"])
        if newer == "dispatched":
            assert current["payload_json"]["_external_attempt_started"] is True
            await repo.release_expired_action_leases(now=datetime.now(UTC) + timedelta(seconds=301))
            terminal = await repo.read_action_task(task["task_id"])
            assert terminal["state"] == "failed"
            assert terminal["payload_json"]["manual_required"] is True
            assert (await repo.read_sender_account("owner", "sender"))["status"] == "paused"
            assert await repo.claim_action(task["task_id"], lease_owner="blind-replay") is None
        else:
            assert current["payload_json"]["comment"] == "newer ordinary text"
    finally:
        resume.set()
        await engine.dispose()


@pytest.mark.asyncio
@pytest.mark.parametrize("action", ["follow", "message"])
@pytest.mark.parametrize("phase", ["before_commit", "after_commit"])
async def test_verified_terminal_cancellation_replays_only_native_bookkeeping(repo, tmp_path, provider, action, phase, monkeypatch):
    url, state = provider
    tasks = await bound(repo)
    source = tmp_path / "config.json"
    source.write_text(json.dumps(config(url)))
    service = PublicOutreachService(repo, NodeExecutorTransport(worker_path=WORKER, config_path=source, runtime_root=tmp_path / "runtime"), config=config(url))
    target_index = 2 if action == "follow" else 3
    target = tasks[target_index]
    expected_status = "public_touched" if action == "follow" else "contacted"
    original_complete = repo.complete_action
    entered = asyncio.Event()
    target_action = "follow-button" if action == "follow" else "message-submit"
    try:
        for prior in tasks[:target_index]:
            assert (await service.execute_task("owner", prior["task_id"]))["task"]["state"] == "completed"

        async def complete(*args, **kwargs):
            if args[0] != target["task_id"]:
                return await original_complete(*args, **kwargs)
            if phase == "before_commit":
                entered.set()
                await asyncio.Event().wait()
            result = await original_complete(*args, **kwargs)
            entered.set()
            await asyncio.Event().wait()
            return result

        monkeypatch.setattr(repo, "complete_action", complete)
        execution = asyncio.create_task(service.execute_task("owner", target["task_id"]))
        await asyncio.wait_for(entered.wait(), 5)
        await service.cancel_task(target["task_id"])
        if phase == "after_commit":
            assert (await execution)["status"] == "duplicate"
        else:
            with pytest.raises(asyncio.CancelledError):
                await execution
        monkeypatch.setattr(repo, "complete_action", original_complete)
        proof = await repo.read_action_receipt("owner", target["task_id"])
        assert proof["verified"] is True
        if phase == "after_commit":
            assert (await repo.read_model(owner_user_id="owner", creator_uid="creator"))["claim"]["status"] == expected_status
        replay = await service.execute_task("owner", target["task_id"])
        assert replay["status"] == "duplicate"
        assert replay["task"]["state"] == "completed"
        assert (await repo.read_model(owner_user_id="owner", creator_uid="creator"))["claim"]["status"] == expected_status
        assert state["actions"].count(target_action) == 1
        assert (await service.execute_task("owner", target["task_id"]))["status"] == "duplicate"
        assert state["actions"].count(target_action) == 1
    finally:
        monkeypatch.setattr(repo, "complete_action", original_complete)
        await service.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("action", ["follow", "message"])
@pytest.mark.parametrize("phase", ["before_commit", "after_commit"])
async def test_verified_terminal_hard_exit_restarts_without_provider_replay(repo, tmp_path, provider, action, phase):
    url, state = provider
    tasks = await bound(repo)
    source = tmp_path / "config.json"
    source.write_text(json.dumps(config(url)))
    runtime = tmp_path / "runtime"
    target_index = 2 if action == "follow" else 3
    target = tasks[target_index]
    expected_status = "public_touched" if action == "follow" else "contacted"
    service = PublicOutreachService(repo, NodeExecutorTransport(worker_path=WORKER, config_path=source, runtime_root=runtime), config=config(url))
    for prior in tasks[:target_index]:
        assert (await service.execute_task("owner", prior["task_id"]))["task"]["state"] == "completed"
    await service.close()
    pid_file = tmp_path / "worker.pid"
    child_file = tmp_path / "terminal-exit.py"
    child_file.write_text("""import asyncio,json,os,sys
from pathlib import Path
from sqlalchemy.ext.asyncio import create_async_engine,async_sessionmaker
from app.gateway.public_outreach_service import NodeExecutorTransport,PublicOutreachService
from deerflow.persistence.creator_agent_relationship import CreatorOutreachRepository
async def main():
    db,config_path,worker,runtime,task_id,pid_file,phase=sys.argv[1:]
    engine=create_async_engine('sqlite+aiosqlite:///'+db)
    repo=CreatorOutreachRepository(async_sessionmaker(engine,expire_on_commit=False))
    transport=NodeExecutorTransport(worker_path=Path(worker),config_path=Path(config_path),runtime_root=Path(runtime))
    service=PublicOutreachService(repo,transport,config=json.loads(Path(config_path).read_text()))
    original=repo.complete_action
    async def exit_at_boundary(*args,**kwargs):
        if phase=='after_commit':await original(*args,**kwargs)
        Path(pid_file).write_text(str(transport.process.pid))
        os._exit(12)
    repo.complete_action=exit_at_boundary
    await service.execute_task('owner',task_id)
asyncio.run(main())
""")
    child = await asyncio.create_subprocess_exec(
        sys.executable,
        str(child_file),
        str(repo.session_factory.kw["bind"].url.database),
        str(source),
        str(WORKER),
        str(runtime),
        target["task_id"],
        str(pid_file),
        phase,
        cwd=ROOT / "backend",
        env={**os.environ, "PYTHONPATH": str(ROOT / "backend")},
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        output = await asyncio.wait_for(child.communicate(), 10)
        assert child.returncode == 12, output
        proof = await repo.read_action_receipt("owner", target["task_id"])
        assert proof["verified"] is True
        if phase == "before_commit":
            await repo.release_expired_action_leases(now=datetime.now(UTC) + timedelta(seconds=301))
            assert (await repo.read_action_task(target["task_id"]))["state"] == "failed"
        else:
            assert (await repo.read_action_task(target["task_id"]))["state"] == "completed"
            assert (await repo.read_model(owner_user_id="owner", creator_uid="creator"))["claim"]["status"] == expected_status
        restarted = PublicOutreachService(repo, NodeExecutorTransport(worker_path=WORKER, config_path=source, runtime_root=runtime), config=config(url))
        try:
            assert (await restarted.execute_task("owner", target["task_id"]))["status"] == "duplicate"
            assert restarted.transport.process is None
            assert (await repo.read_action_task(target["task_id"]))["state"] == "completed"
            assert (await repo.read_model(owner_user_id="owner", creator_uid="creator"))["claim"]["status"] == expected_status
        finally:
            await restarted.close()
        assert state["actions"].count("follow-button" if action == "follow" else "message-submit") == 1
    finally:
        if child.returncode is None:
            child.kill()
            await child.wait()
        if pid_file.exists():
            pid = int(pid_file.read_text())
            try:
                os.killpg(pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            await asyncio.sleep(0.1)
            try:
                os.killpg(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass


@pytest.mark.asyncio
@pytest.mark.parametrize("action", ["follow", "message"])
async def test_reviewer_web_worker_final_action_cancel_after_commit_has_advanced_native_claim(repo, tmp_path, monkeypatch, action, web_proxy_server):
    tasks = await bound(repo, "web")
    configuration = config("http://127.0.0.1:1")
    configuration["sender"] = {"owner_user_id": "owner", "sender_account_id": "sender", "channel": "web", "web_route": {"proxy_server": web_proxy_server, "expected_country": "US"}}
    source = tmp_path / "web-config.json"
    source.write_text(json.dumps(configuration))
    worker = ROOT / "ops/guild-runtime/public-outreach-operator/fixtures/web-worker.mjs"
    transport = NodeExecutorTransport(worker_path=worker, config_path=source, runtime_root=tmp_path / "runtime", node=shutil.which("node"))
    service = PublicOutreachService(repo, transport, config=configuration)
    target_index = 2 if action == "follow" else 3
    target = tasks[target_index]
    expected_status = "public_touched" if action == "follow" else "contacted"
    calls = []
    original_execute = transport.execute
    original_complete = repo.complete_action
    entered = asyncio.Event()

    async def counted_execute(**kwargs):
        calls.append(kwargs["action"])
        return await original_execute(**kwargs)

    async def after_commit(*args, **kwargs):
        result = await original_complete(*args, **kwargs)
        if args[0] == target["task_id"]:
            entered.set()
            await asyncio.Event().wait()
        return result

    monkeypatch.setattr(transport, "execute", counted_execute)
    try:
        for prior in tasks[:target_index]:
            assert (await service.execute_task("owner", prior["task_id"]))["task"]["state"] == "completed"
        monkeypatch.setattr(repo, "complete_action", after_commit)
        execution = asyncio.create_task(service.execute_task("owner", target["task_id"]))
        await asyncio.wait_for(entered.wait(), 5)
        await service.cancel_task(target["task_id"])
        assert (await execution)["status"] == "duplicate"
        monkeypatch.setattr(repo, "complete_action", original_complete)
        assert (await repo.read_action_receipt("owner", target["task_id"]))["verified"] is True
        assert (await repo.read_model(owner_user_id="owner", creator_uid="creator"))["claim"]["status"] == expected_status
        assert (await service.execute_task("owner", target["task_id"]))["status"] == "duplicate"
        assert calls.count(action) == 1
        if action == "follow":
            assert (await service.execute_task("owner", tasks[3]["task_id"]))["task"]["state"] == "completed"
            assert calls.count("message") == 1
            assert (await service.execute_task("owner", target["task_id"]))["status"] == "duplicate"
    finally:
        monkeypatch.setattr(repo, "complete_action", original_complete)
        await service.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("action", ["follow", "message"])
async def test_terminal_exception_after_durable_completion_replays_without_provider(repo, tmp_path, provider, monkeypatch, action):
    url, state = provider
    tasks = await bound(repo)
    source = tmp_path / "config.json"
    source.write_text(json.dumps(config(url)))
    service = PublicOutreachService(repo, NodeExecutorTransport(worker_path=WORKER, config_path=source, runtime_root=tmp_path / "runtime"), config=config(url))
    target_index = 2 if action == "follow" else 3
    target = tasks[target_index]
    expected_status = "public_touched" if action == "follow" else "contacted"
    original_complete = repo.complete_action
    try:
        for prior in tasks[:target_index]:
            await service.execute_task("owner", prior["task_id"])

        async def interrupted(*args, **kwargs):
            result = await original_complete(*args, **kwargs)
            if args[0] == target["task_id"]:
                raise RuntimeError("response lost after native commit")
            return result

        monkeypatch.setattr(repo, "complete_action", interrupted)
        assert (await service.execute_task("owner", target["task_id"]))["status"] == "duplicate"
        monkeypatch.setattr(repo, "complete_action", original_complete)
        assert (await repo.read_model(owner_user_id="owner", creator_uid="creator"))["claim"]["status"] == expected_status
        assert (await service.execute_task("owner", target["task_id"]))["status"] == "duplicate"
        assert state["actions"].count("follow-button" if action == "follow" else "message-submit") == 1
    finally:
        monkeypatch.setattr(repo, "complete_action", original_complete)
        await service.close()


@pytest.mark.asyncio
async def test_unbound_caller_receipt_cannot_finalize_terminal_action(repo):
    tasks = await bound(repo)
    follow = tasks[2]
    await repo.record_receipt(
        owner_user_id="owner",
        creator_uid="creator",
        sequence_no=1,
        receipt_id="caller-proof",
        kind="public_action_receipt",
        provider_ref="caller-ref",
        verification_source="provider_readback",
        payload={"receipt_type": "public_action_receipt", "action": "follow", "sender_account_id": "sender", "creator_uid": "creator", "action_group": follow["payload_json"]["action_group"]},
        verified=True,
    )
    assert (await repo.reconcile_verified_terminal("owner", follow["task_id"]))["state"] == "pending"
    assert (await repo.read_model(owner_user_id="owner", creator_uid="creator"))["claim"]["status"] == "gray"


@pytest.mark.asyncio
@pytest.mark.parametrize("boundary", ["no_contact", "closed", "sender_mismatch", "receipt_kind", "receipt_group"])
async def test_terminal_proof_recovery_fails_closed_on_native_scope_and_evidence(repo, tmp_path, provider, monkeypatch, boundary):
    from deerflow.persistence.creator_agent_relationship import CreatorAgentRelationshipRepository

    url, state = provider
    tasks = await bound(repo)
    source = tmp_path / "config.json"
    source.write_text(json.dumps(config(url)))
    service = PublicOutreachService(repo, NodeExecutorTransport(worker_path=WORKER, config_path=source, runtime_root=tmp_path / "runtime"), config=config(url))
    target = tasks[2]
    entered = asyncio.Event()
    original_complete = repo.complete_action
    try:
        for prior in tasks[:2]:
            await service.execute_task("owner", prior["task_id"])

        async def before_commit(*args, **kwargs):
            if args[0] == target["task_id"]:
                entered.set()
                await asyncio.Event().wait()
            return await original_complete(*args, **kwargs)

        monkeypatch.setattr(repo, "complete_action", before_commit)
        execution = asyncio.create_task(service.execute_task("owner", target["task_id"]))
        await asyncio.wait_for(entered.wait(), 5)
        await service.cancel_task(target["task_id"])
        with pytest.raises(asyncio.CancelledError):
            await execution
        monkeypatch.setattr(repo, "complete_action", original_complete)
        proof = await repo.read_action_receipt("owner", target["task_id"])
        assert proof["verified"] is True
        if boundary == "no_contact":
            await CreatorAgentRelationshipRepository(repo.session_factory).record_evidence(
                owner_user_id="owner", account_id="sender", creator_uid="creator", event={"event_id": "late-refusal", "source_kind": "creator_message", "source_ref": "terminal-negative", "text": "stop", "do_not_contact": True}
            )
        else:
            async with repo.session_factory() as session:
                if boundary == "closed":
                    (await session.get(CreatorClaimRow, ("owner", "creator"))).status = "closed"
                    (await session.get(CreatorOutreachSequenceRow, ("owner", "creator", 1))).status = "closed"
                elif boundary == "sender_mismatch":
                    (await session.get(CreatorOutreachSequenceRow, ("owner", "creator", 1))).sender_account_id = "other"
                else:
                    receipt = await session.get(CreatorOutreachReceiptRow, ("owner", "creator", 1, proof["receipt_id"]))
                    if boundary == "receipt_kind":
                        receipt.kind = "dm_receipt"
                    else:
                        receipt.payload_json = {**receipt.payload_json, "action_group": "other-group"}
                await session.commit()
        with pytest.raises(ValueError):
            await service.execute_task("owner", target["task_id"])
        assert (await repo.read_action_task(target["task_id"]))["state"] == "failed"
        assert (await repo.read_model(owner_user_id="owner", creator_uid="creator"))["claim"]["status"] in {"gray", "closed"}
        assert state["actions"].count("follow-button") == 1
    finally:
        monkeypatch.setattr(repo, "complete_action", original_complete)
        await service.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("scope", [("owner", "sender", "creator"), ("other", "sender", "creator"), ("owner", "other", "creator")])
async def test_existing_native_no_contact_fences_only_the_exact_scope(repo, tmp_path, provider, scope):
    from deerflow.persistence.creator_agent_relationship import CreatorAgentRelationshipRepository

    url, state = provider
    tasks = await bound(repo)
    await CreatorAgentRelationshipRepository(repo.session_factory).record_evidence(
        owner_user_id=scope[0], account_id=scope[1], creator_uid=scope[2], event={"event_id": "refusal", "source_kind": "creator_message", "source_ref": "test-message", "text": "stop", "do_not_contact": True}
    )
    source = tmp_path / "config.json"
    source.write_text(json.dumps(config(url)))
    service = PublicOutreachService(repo, NodeExecutorTransport(worker_path=WORKER, config_path=source, runtime_root=tmp_path / "runtime"), config=config(url))
    try:
        if scope == ("owner", "sender", "creator"):
            with pytest.raises(ValueError, match="contact"):
                await service.execute_task("owner", tasks[0]["task_id"])
            assert await repo.claim_action(tasks[0]["task_id"], lease_owner="bypass") is None
            assert state["sessions"] == 0
        else:
            assert (await service.execute_task("owner", tasks[0]["task_id"]))["task"]["state"] == "completed"
    finally:
        await service.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("phase", ["storage_before", "storage_after", "complete_before", "complete_after", "malformed", "persistence_exception"])
async def test_unified_external_attempt_terminal_boundary(repo, tmp_path, provider, monkeypatch, phase):
    url, state = provider
    tasks = await bound(repo)
    source = tmp_path / "config.json"
    source.write_text(json.dumps(config(url)))
    transport = NodeExecutorTransport(worker_path=WORKER, config_path=source, runtime_root=tmp_path / "runtime")
    service = PublicOutreachService(repo, transport, config=config(url))
    try:
        await service.execute_task("owner", tasks[0]["task_id"])
        entered = asyncio.Event()
        original_record = repo.record_receipt
        original_complete = repo.complete_action
        original_execute = transport.execute

        async def record(**kwargs):
            if kwargs.get("verified") and phase.startswith("storage"):
                if phase == "storage_after":
                    await original_record(**kwargs)
                entered.set()
                await asyncio.Event().wait()
            if phase == "persistence_exception":
                raise RuntimeError("storage unavailable")
            return await original_record(**kwargs)

        async def complete(*args, **kwargs):
            if phase.startswith("complete"):
                if phase == "complete_after":
                    await original_complete(*args, **kwargs)
                entered.set()
                await asyncio.Event().wait()
            return await original_complete(*args, **kwargs)

        async def execute(**kwargs):
            result = await original_execute(**kwargs)
            if phase == "malformed":
                result["receipt_payload"]["creator_uid"] = "wrong"
            return result

        monkeypatch.setattr(repo, "record_receipt", record)
        monkeypatch.setattr(repo, "complete_action", complete)
        monkeypatch.setattr(transport, "execute", execute)
        if phase.startswith(("storage", "complete")):
            execution = asyncio.create_task(service.execute_task("owner", tasks[1]["task_id"]))
            await asyncio.wait_for(entered.wait(), 5)
            await service.cancel_task(tasks[1]["task_id"])
            if phase == "complete_after":
                assert (await execution)["status"] == "duplicate"
            else:
                with pytest.raises(asyncio.CancelledError):
                    await execution
        else:
            assert (await service.execute_task("owner", tasks[1]["task_id"]))["status"] == "unknown"
        monkeypatch.setattr(repo, "record_receipt", original_record)
        monkeypatch.setattr(repo, "complete_action", original_complete)
        current = await repo.read_action_task(tasks[1]["task_id"])
        if phase == "complete_after":
            assert current["state"] == "completed"
            assert (await service.execute_task("owner", current["task_id"]))["status"] == "duplicate"
        else:
            assert current["state"] == "failed"
            assert current["payload_json"]["manual_required"] is True
            assert (await repo.read_sender_account("owner", "sender"))["status"] == "paused"
            assert await repo.claim_action(current["task_id"], lease_owner="blind", now=datetime.now(UTC) + timedelta(seconds=301)) is None
            await repo.release_expired_action_leases(now=datetime.now(UTC) + timedelta(seconds=301))
            with pytest.raises(ValueError):
                await service.execute_task("owner", current["task_id"])
            if phase in {"storage_after", "complete_before"}:
                proof = await repo.read_action_receipt("owner", current["task_id"])
                assert proof["verified"] is True
                with pytest.raises(ValueError, match="verified"):
                    await repo.mark_action_unknown("owner", current["task_id"], receipt_id="cannot-replace-proof", reason="manual override")
                with pytest.raises(ValueError, match="verified"):
                    await repo.retry_action("owner", current["task_id"], recoverable_error_codes=["cancelled"])
        assert state["actions"].count("comment-submit") == 1
    finally:
        await service.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("recovery", ["claim", "expired", "release"])
async def test_dispatched_native_lease_can_never_be_automatically_reclaimed(repo, recovery):
    tasks = await bound(repo)
    claim = await repo.claim_action(tasks[0]["task_id"], lease_owner="first", lease_seconds=300)
    await repo.mark_external_attempt_started(claim["task_id"], lease_owner=claim["lease_owner"], lease_token=claim["lease_token"])
    future = datetime.now(UTC) + timedelta(seconds=301)
    if recovery == "claim":
        assert await repo.claim_action(claim["task_id"], lease_owner="second", now=future) is None
    elif recovery == "expired":
        assert await repo.release_expired_action_leases(now=future) == 1
    else:
        await repo.release_action_claim(claim["task_id"], lease_owner=claim["lease_owner"], lease_token=claim["lease_token"], now=future)
    current = await repo.read_action_task(claim["task_id"])
    assert current["state"] == "failed"
    assert current["payload_json"]["manual_required"] is True
    assert (await repo.read_sender_account("owner", "sender"))["status"] == "paused"
    await repo.retry_action("owner", claim["task_id"], recoverable_error_codes=["external_attempt_unknown"])
    current = await repo.read_action_task(claim["task_id"])
    assert not current["payload_json"].get("_external_attempt_started")
    assert await repo.claim_action(claim["task_id"], lease_owner="third") is None
    await repo.set_sender_account_status("owner", "sender", status="enabled", reason="manually reconciled")
    assert await repo.claim_action(claim["task_id"], lease_owner="third") is not None


@pytest.mark.asyncio
async def test_native_payload_cannot_forge_dispatch_or_manual_fields(repo):
    tasks = await bound(repo)
    for key in ["_external_attempt_started", "_external_attempt_token", "manual_required"]:
        with pytest.raises(ValueError, match="owned"):
            await repo.update_action_payload("owner", tasks[0]["task_id"], {key: True})
        with pytest.raises(ValueError, match="owned"):
            await repo.enqueue_action(owner_user_id="owner", creator_uid="creator", sequence_no=1, sender_account_id="sender", action="like", idempotency_key="forged-" + key, payload={key: True})


@pytest.mark.asyncio
async def test_no_contact_written_after_claim_still_stops_provider_dispatch(repo, tmp_path, provider, monkeypatch):
    from deerflow.persistence.creator_agent_relationship import CreatorAgentRelationshipRepository

    url, state = provider
    tasks = await bound(repo)
    source = tmp_path / "config.json"
    source.write_text(json.dumps(config(url)))
    transport = NodeExecutorTransport(worker_path=WORKER, config_path=source, runtime_root=tmp_path / "runtime")
    service = PublicOutreachService(repo, transport, config=config(url))
    original = repo.mark_external_attempt_started

    async def changed(*args, **kwargs):
        await CreatorAgentRelationshipRepository(repo.session_factory).record_evidence(
            owner_user_id="owner", account_id="sender", creator_uid="creator", event={"event_id": "late-refusal", "source_kind": "creator_message", "source_ref": "native-event", "text": "stop", "do_not_contact": True}
        )
        return await original(*args, **kwargs)

    monkeypatch.setattr(repo, "mark_external_attempt_started", changed)
    try:
        result = await service.execute_task("owner", tasks[0]["task_id"])
        assert result["status"] == "unknown"
        assert state["sessions"] == 0
        assert transport.process is None
        assert not result["task"]["payload_json"].get("_external_attempt_started")
    finally:
        await service.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("phase", ["before_proof", "after_proof"])
async def test_hard_python_exit_after_real_node_result_never_replays_dispatched_comment(repo, tmp_path, provider, phase):
    url, state = provider
    tasks = await bound(repo)
    source = tmp_path / "config.json"
    source.write_text(json.dumps(config(url)))
    runtime = tmp_path / "runtime"
    service = PublicOutreachService(repo, NodeExecutorTransport(worker_path=WORKER, config_path=source, runtime_root=runtime), config=config(url))
    await service.execute_task("owner", tasks[0]["task_id"])
    await service.close()
    pid_file = tmp_path / "worker.pid"
    child_file = tmp_path / "hard-exit.py"
    child_file.write_text("""import asyncio,json,os,sys
from pathlib import Path
from sqlalchemy.ext.asyncio import create_async_engine,async_sessionmaker
from app.gateway.public_outreach_service import NodeExecutorTransport,PublicOutreachService
from deerflow.persistence.creator_agent_relationship import CreatorOutreachRepository
async def main():
    db,config_path,worker,runtime,task_id,pid_file,phase=sys.argv[1:]
    engine=create_async_engine('sqlite+aiosqlite:///'+db)
    repo=CreatorOutreachRepository(async_sessionmaker(engine,expire_on_commit=False))
    transport=NodeExecutorTransport(worker_path=Path(worker),config_path=Path(config_path),runtime_root=Path(runtime))
    service=PublicOutreachService(repo,transport,config=json.loads(Path(config_path).read_text()))
    original=repo.record_receipt
    async def terminate(**kwargs):
        if kwargs.get('verified'):
            Path(pid_file).write_text(str(transport.process.pid))
            if phase=='after_proof':await original(**kwargs)
            os._exit(12)
        return await original(**kwargs)
    repo.record_receipt=terminate
    await service.execute_task('owner',task_id)
asyncio.run(main())
""")
    db = str(repo.session_factory.kw["bind"].url.database)
    child = await asyncio.create_subprocess_exec(
        sys.executable,
        str(child_file),
        db,
        str(source),
        str(WORKER),
        str(runtime),
        tasks[1]["task_id"],
        str(pid_file),
        phase,
        cwd=ROOT / "backend",
        env={**os.environ, "PYTHONPATH": str(ROOT / "backend")},
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        output = await asyncio.wait_for(child.communicate(), 10)
        assert child.returncode == 12, output
        assert state["actions"].count("comment-submit") == 1
        task = await repo.read_action_task(tasks[1]["task_id"])
        assert task["payload_json"]["_external_attempt_started"] is True
        await repo.release_expired_action_leases(now=datetime.now(UTC) + timedelta(seconds=301))
        task = await repo.read_action_task(tasks[1]["task_id"])
        assert task["state"] == "failed"
        assert (await repo.read_sender_account("owner", "sender"))["status"] == "paused"
        if phase == "after_proof":
            proof = await repo.read_action_receipt("owner", task["task_id"])
            assert proof["verified"] is True
            with pytest.raises(ValueError, match="verified"):
                await repo.retry_action("owner", task["task_id"], recoverable_error_codes=["external_attempt_unknown"])
        restarted = PublicOutreachService(repo, NodeExecutorTransport(worker_path=WORKER, config_path=source, runtime_root=runtime), config=config(url))
        try:
            with pytest.raises(ValueError):
                await restarted.execute_task("owner", task["task_id"])
            assert restarted.transport.process is None
        finally:
            await restarted.close()
        assert state["actions"].count("comment-submit") == 1
    finally:
        if child.returncode is None:
            child.kill()
            await child.wait()
        if pid_file.exists():
            pid = int(pid_file.read_text())
            try:
                os.killpg(pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            await asyncio.sleep(0.1)
            try:
                os.killpg(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
