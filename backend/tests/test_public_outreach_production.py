from __future__ import annotations

import asyncio
import json
import shutil
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.gateway.public_outreach_service import NodeExecutorTransport, PublicOutreachService
from deerflow.creator_agent.public_outreach import PublicOutreachWorkflow
from deerflow.persistence.base import Base
from deerflow.persistence.creator_agent_relationship import CreatorOutreachRepository

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
async def test_native_web_sequence_uses_shipped_node_composition_and_method_shaped_chromium(repo, tmp_path):
    tasks = await bound(repo, "web")
    configuration = config("http://127.0.0.1:1")
    configuration["sender"] = {"owner_user_id": "owner", "sender_account_id": "sender", "channel": "web"}
    source = tmp_path / "web-config.json"
    source.write_text(json.dumps(configuration))
    worker = ROOT / "ops/guild-runtime/public-outreach-operator/test/fixtures/web-worker.mjs"
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
