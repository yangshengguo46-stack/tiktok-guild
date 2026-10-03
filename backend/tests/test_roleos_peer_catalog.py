"""Social runtime keeps peer tools inside the native host capability."""

from dataclasses import replace

import pytest
from test_roleos_bridge_route import _connection


def test_social_peer_catalog_requires_registered_capability():
    from roleos.coordination_models import EmployeeRecord
    from roleos.peer_tools import PEER_TOOL_NAMES, PeerTools

    from deerflow.persistence.social import SocialRepository
    from deerflow.social.peer_tools import tools_for_runtime
    from deerflow.social.runtime import SocialRuntime, SocialRuntimeBinding

    connection = _connection(SocialRepository(None))
    identity = connection.roleos_binding
    record = EmployeeRecord(
        identity.company_id, identity.member_id, identity.department_id, identity.source_role, identity.native_owner_id, connection.scope.agent_instance_id, connection.thread_id, identity.source_revision, "http://control"
    )
    client = PeerTools("http://control", token="token", employee=record)
    binding = SocialRuntimeBinding(connection.repository, connection.scope, connection.identity, connection.role, "event", roleos_binding=identity, peer_tools=client)
    assert {tool.name for tool in tools_for_runtime(SocialRuntime(binding))} == PEER_TOOL_NAMES
    with pytest.raises(ValueError):
        replace(binding, peer_tools={"actor": "ceo"})
    assert tools_for_runtime(None) == []


def test_peer_file_capability_keeps_native_file_middlewares():
    from types import SimpleNamespace

    from deerflow.agents.middlewares.thread_data_middleware import ThreadDataMiddleware
    from deerflow.sandbox.middleware import SandboxMiddleware
    from deerflow.social.runtime import middlewares_for_lead

    middlewares = [ThreadDataMiddleware(), SandboxMiddleware()]
    runtime = SimpleNamespace(binding=SimpleNamespace(peer_tools=object(), scope=None))
    assert {"ThreadDataMiddleware", "SandboxMiddleware"} <= {type(m).__name__ for m in middlewares_for_lead(runtime, middlewares)}


from test_social_lead_runtime import repo  # noqa: E402,F401 - actual native SQL fixture


@pytest.mark.asyncio
async def test_sales_native_graph_requests_marketing_over_real_peer_http(repo, monkeypatch, tmp_path):  # noqa: F811
    from fastapi.testclient import TestClient
    from langchain_core.messages import AIMessage, HumanMessage
    from roleos.control_plane_app import create_control_plane_app
    from roleos.cooperation import CompanyScopedCooperationStore
    from roleos.coordination_models import EmployeeRecord
    from roleos.peer_tools import PeerTools
    from test_social_lead_runtime import SCOPE, ScriptedModel, assembly

    from deerflow.social.roleos_binding import RoleOSBinding

    binding = RoleOSBinding("roleos", "sales", "sales", "sales", SCOPE.owner_user_id, SCOPE.agent_instance_id, "native-thread", "sales-v1")
    employee = EmployeeRecord(**{**{k: getattr(binding, k) for k in binding.__dataclass_fields__}, "bridge_endpoint": "http://control"})
    marketing = EmployeeRecord("roleos", "marketing", "marketing", "marketing", "roleos:marketing", "lead_agent", "marketing-thread", "marketing-v7", "http://marketing")
    store = CompanyScopedCooperationStore(tmp_path / "control.db")
    store.register_employee(marketing)
    http = TestClient(create_control_plane_app(store, peer_bindings={"sales-token": employee}))
    peer = PeerTools("http://testserver", token="sales-token", employee=employee, client=http)
    peer.register()
    args = {"recipient": "marketing", "objective": "Prepare a creator-specific brief", "criteria": ["Native evidence"], "request_id": "direct-sales-help"}
    model = ScriptedModel(
        responses=[
            AIMessage(content="", tool_calls=[{"id": "first", "name": "request_help", "args": args}]),
            AIMessage(content="", tool_calls=[{"id": "retry", "name": "request_help", "args": args}]),
            AIMessage(content='{"reply":null,"decision_note":"Peer help requested"}'),
        ]
    )
    from deerflow.config.paths import Paths

    monkeypatch.setattr("deerflow.config.paths._paths", Paths(tmp_path / "native-state"))
    graph, config = await assembly(monkeypatch, repo, model, binding_changes={"roleos_binding": binding, "peer_tools": peer})
    config["context"]["thread_id"] = binding.thread_id
    await graph.ainvoke({"messages": [HumanMessage(content="Ask Marketing directly")]}, config=config, context=config["context"])
    work = store.read_work("roleos", "marketing")
    assert len(work) == 1
    assert (work[0].sender_member_id, work[0].target_member_id, work[0].source_revision) == ("sales", "marketing", "marketing-v7")
    assert all("request_help" in names for names in model.bound_names)
    store.close()


@pytest.mark.asyncio
async def test_channel_manager_registration_initializes_peer_capability(monkeypatch):
    from types import SimpleNamespace
    from unittest.mock import AsyncMock

    from roleos.coordination_models import EmployeeRecord
    from roleos.peer_tools import PeerTools

    from app.gateway.services import admit_registered_roleos_social_work
    from deerflow.persistence.social import SocialRepository
    from deerflow.social.runtime import SocialRuntimeBinding

    connection = _connection(SocialRepository(None))
    identity = connection.roleos_binding
    employee = EmployeeRecord(**{**{k: getattr(identity, k) for k in identity.__dataclass_fields__}, "bridge_endpoint": "http://control"})
    peer = PeerTools("http://control", token="host-token", employee=employee)
    binding = SocialRuntimeBinding(connection.repository, connection.scope, connection.identity, connection.role, "event", roleos_binding=identity)
    manager = SimpleNamespace(_social_connections={"connection": connection}, admit_roleos_social_work=AsyncMock(return_value=binding))
    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(channel_service=SimpleNamespace(manager=manager))))
    monkeypatch.setattr("deerflow.social.peer_tools.host_peer_tools", lambda *args: peer)
    result = await admit_registered_roleos_social_work(request, "connection", object())
    assert result.peer_tools is peer
