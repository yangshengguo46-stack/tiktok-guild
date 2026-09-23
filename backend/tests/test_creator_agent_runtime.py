"""CreatorAgent runtime contracts with deterministic model and repository fakes."""

from __future__ import annotations

import asyncio
import json
from copy import deepcopy

import pytest
from langchain_core.language_models.fake_chat_models import FakeListChatModel
from langchain_core.messages import HumanMessage, SystemMessage
from langchain_core.runnables import RunnableLambda
from langgraph.constants import TAG_NOSTREAM
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from deerflow.creator_agent.middleware import CreatorAgentMiddleware
from deerflow.creator_agent.persona_selector import PersonaSelector
from deerflow.creator_agent.personas import load_personas
from deerflow.creator_agent.runtime import CreatorAgentRuntime
from deerflow.creator_agent.state import CreatorFocus
from deerflow.creator_agent.tools import focus_update, operator_message_event
from deerflow.persistence.base import Base
from deerflow.persistence.creator_agent_relationship import CreatorAgentRelationshipRepository

FOCUS = CreatorFocus(owner_user_id="owner-1", account_id="account-1", creator_uid="uid-1")
SWITCH = '{"action":"switch","persona_id":"clear_direct","confidence":0.92,"evidence_refs":["creator:message-1"],"reason":"主播要求直接表达"}'


def own_quote(*, uid="uid-1"):
    return {"event_id": "event-1", "source_ref": "creator:message-1", "source_kind": "creator_message", "owner_user_id": "owner-1", "account_id": "account-1", "creator_uid": uid, "text": "请直接告诉我下一步，不用寒暄。"}


def snapshot(*, evidence=None, do_not_contact=False):
    return {
        "owner_user_id": "owner-1",
        "account_id": "account-1",
        "creator_uid": "uid-1",
        "evidence_version": 1,
        "persona_revision": 0,
        "evidence": list(evidence if evidence is not None else [own_quote()]),
        "facts": [],
        "commitments": [],
        "do_not_contact": do_not_contact,
        "persona_state": {"persona_ref": "relaxed_wit@1.0.1", "evaluated_evidence_version": 0},
    }


class FakeRepository:
    def __init__(self, data):
        self.data = data
        self.reads = []
        self.writes = []
        self.winner = None

    async def get(self, **scope):
        self.reads.append(scope)
        assert scope == FOCUS.as_kwargs()
        return deepcopy(self.data)

    async def apply_persona_decision(self, *, expected_evidence_version, expected_persona_revision, decision, **scope):
        assert scope == FOCUS.as_kwargs()
        self.writes.append(decision)
        if self.winner is not None:
            self.data = self.winner
            self.winner = None
            raise ValueError("CAS conflict")
        assert expected_evidence_version == self.data["evidence_version"]
        assert expected_persona_revision == self.data["persona_revision"]
        self.data["persona_revision"] += 1
        self.data["persona_state"] = {"persona_ref": decision["persona_ref"], "evaluated_evidence_version": decision["evaluated_evidence_version"]}
        return deepcopy(self.data)


class FakeChatModel:
    def __init__(self, content):
        self.content = content
        self.calls = []

    async def ainvoke(self, messages, **kwargs):
        self.calls.append((messages, kwargs))
        return type("Reply", (), {"content": self.content})()


def make_runtime(content, *, data=None):
    repo = FakeRepository(data or snapshot())
    model = FakeChatModel(content)
    runtime = CreatorAgentRuntime(repository=repo, selector=PersonaSelector(model=model))
    return runtime, repo, model


@pytest.mark.parametrize("catalog_fault", ["missing", "unreadable", "malformed_json", "invalid_schema"])
def test_catalog_failure_keeps_default_lead_assembly_without_creator_extension(monkeypatch, tmp_path, catalog_fault):
    from deerflow.agents.lead_agent import agent as lead_agent_module
    from deerflow.config.app_config import AppConfig
    from deerflow.config.model_config import ModelConfig
    from deerflow.config.sandbox_config import SandboxConfig
    from deerflow.persistence import engine as persistence_engine

    catalog_path = tmp_path / "personas.json"
    if catalog_fault == "unreadable":
        catalog_path.mkdir()
    elif catalog_fault == "malformed_json":
        catalog_path.write_text("{", encoding="utf-8")
    elif catalog_fault == "invalid_schema":
        catalog_path.write_text('{"bad": true}', encoding="utf-8")
    monkeypatch.setenv("DEER_FLOW_GUILD_PERSONAS_PATH", str(catalog_path))
    monkeypatch.setattr(persistence_engine, "get_session_factory", lambda: object())
    monkeypatch.setattr(lead_agent_module, "create_chat_model", lambda **kwargs: object())
    monkeypatch.setattr(lead_agent_module, "create_agent", lambda **kwargs: kwargs)
    app_config = AppConfig(
        models=[ModelConfig(name="m", display_name="m", description=None, use="langchain_openai:ChatOpenAI", model="m", supports_thinking=False, supports_vision=False)],
        sandbox=SandboxConfig(use="deerflow.sandbox.local:LocalSandboxProvider"),
    )
    assembly = lead_agent_module.assemble_lead_agent({"configurable": {"thread_id": "catalog-failure"}, "context": {"user_id": "owner-1"}}, app_config=app_config)
    assert assembly.graph is not None
    assert not [tool for tool in assembly.graph["tools"] if tool.name.startswith("creator_agent_")]
    assert not [middleware for middleware in assembly.graph["middleware"] if isinstance(middleware, CreatorAgentMiddleware)]


def test_creator_runtime_construction_failure_keeps_default_lead_assembly(monkeypatch):
    from deerflow.agents.lead_agent import agent as lead_agent_module
    from deerflow.config.app_config import AppConfig
    from deerflow.config.model_config import ModelConfig
    from deerflow.config.sandbox_config import SandboxConfig
    from deerflow.creator_agent import runtime as runtime_module
    from deerflow.persistence import engine as persistence_engine

    def invalid_runtime(**kwargs):
        raise ValueError("invalid optional CreatorAgent runtime")

    monkeypatch.setattr(persistence_engine, "get_session_factory", lambda: object())
    monkeypatch.setattr(runtime_module, "CreatorAgentRuntime", invalid_runtime)
    monkeypatch.setattr(lead_agent_module, "create_chat_model", lambda **kwargs: object())
    monkeypatch.setattr(lead_agent_module, "create_agent", lambda **kwargs: kwargs)
    app_config = AppConfig(
        models=[ModelConfig(name="m", display_name="m", description=None, use="langchain_openai:ChatOpenAI", model="m", supports_thinking=False, supports_vision=False)],
        sandbox=SandboxConfig(use="deerflow.sandbox.local:LocalSandboxProvider"),
    )
    assembly = lead_agent_module.assemble_lead_agent({"configurable": {"thread_id": "runtime-failure"}, "context": {"user_id": "owner-1"}}, app_config=app_config)
    assert assembly.graph is not None
    assert not [tool for tool in assembly.graph["tools"] if tool.name.startswith("creator_agent_")]
    assert not [middleware for middleware in assembly.graph["middleware"] if isinstance(middleware, CreatorAgentMiddleware)]


@pytest.mark.asyncio
async def test_selector_prompt_contains_bounded_approved_persona_definitions_only():
    runtime, _, model = make_runtime(SWITCH)
    await runtime.aresolve(FOCUS)
    messages, _ = model.calls[0]
    payload = json.loads(messages[1].content)
    candidates = payload["candidates"]
    assert len(candidates) == 6
    assert set(candidates[0]) == {"id", "version", "core", "behavior", "interests"}
    clear_direct = next(candidate for candidate in candidates if candidate["id"] == "clear_direct")
    assert clear_direct["version"] == "1.0.1"
    assert "说话明白" in clear_direct["core"]
    assert "voice" in clear_direct["behavior"]
    assert all(len(candidate["core"]) <= 512 for candidate in candidates)
    assert "occupation, gender, income, audience size, vulnerability" in messages[0].content
    assert "头部主播" not in messages[1].content


@pytest.mark.asyncio
async def test_valid_switch_from_own_verified_quote_persists_once():
    runtime, repo, model = make_runtime(SWITCH)
    first = await runtime.aresolve(FOCUS)
    second = await runtime.aresolve(FOCUS)
    assert first["persona_id"] == second["persona_id"] == "clear_direct"
    assert first["persona_revision"] == 1
    assert len(model.calls) == len(repo.writes) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "content",
    [
        '{"action":"switch","persona_id":"clear_direct","confidence":0.74,"evidence_refs":["creator:message-1"],"reason":"偏好直接"}',
        '{"action":"switch","persona_id":"clear_direct","confidence":0.99,"evidence_refs":["missing"],"reason":"偏好直接"}',
        '{"action":"switch","persona_id":"unknown","confidence":0.99,"evidence_refs":["creator:message-1"],"reason":"偏好直接"}',
        "not json",
    ],
)
async def test_invalid_or_unsupported_switch_stays_with_current_persona(content):
    runtime, repo, _ = make_runtime(content)
    result = await runtime.aresolve(FOCUS)
    assert result["persona_id"] == "relaxed_wit"
    assert repo.writes[0]["action"] == "stay"
    assert repo.writes[0]["evaluated_evidence_version"] == 1


@pytest.mark.asyncio
async def test_cross_scope_quote_cannot_authorize_switch():
    runtime, repo, _ = make_runtime(SWITCH, data=snapshot(evidence=[own_quote(uid="other")]))
    assert (await runtime.aresolve(FOCUS))["persona_id"] == "relaxed_wit"
    assert repo.writes[0]["action"] == "stay"


@pytest.mark.asyncio
async def test_operator_note_is_not_selector_evidence():
    operator_note = {"event_id": "note-1", "source_ref": "chat:human-1", "source_kind": "operator_note", "text": "她是头部主播，应该用强势的话术。"}
    runtime, repo, model = make_runtime(SWITCH, data=snapshot(evidence=[own_quote(), operator_note]))
    assert (await runtime.aresolve(FOCUS))["persona_id"] == "clear_direct"
    assert "头部主播" not in model.calls[0][0][1].content


@pytest.mark.asyncio
async def test_duplicate_json_keys_fail_closed():
    content = '{"action":"stay","action":"switch","persona_id":"clear_direct","confidence":0.99,"evidence_refs":["creator:message-1"],"reason":"偏好直接"}'
    runtime, repo, _ = make_runtime(content)
    assert (await runtime.aresolve(FOCUS))["persona_id"] == "relaxed_wit"
    assert repo.writes[0]["action"] == "stay"


@pytest.mark.asyncio
async def test_selector_is_hidden_under_streaming_callback_context():
    selector = PersonaSelector(model=FakeListChatModel(responses=[SWITCH]))
    catalog = load_personas()

    async def choose(_):
        return await selector.choose(current_persona_id="relaxed_wit", candidates=(catalog["relaxed_wit"], catalog["clear_direct"]), evidence=[{"ref": "creator:message-1", "author": "creator", "text": "请直接说重点"}])

    events = [event async for event in RunnableLambda(choose).astream_events(None, version="v2")]
    starts = [event for event in events if event["event"] == "on_chat_model_start"]
    assert len(starts) == 1
    assert TAG_NOSTREAM in starts[0]["tags"]
    assert not [event for event in events if event["event"] == "on_chat_model_stream"]


@pytest.mark.asyncio
async def test_cas_conflict_reloads_winning_snapshot_without_retrying_selector():
    runtime, repo, model = make_runtime(SWITCH)
    winner = snapshot()
    winner["persona_revision"] = 2
    winner["persona_state"] = {"persona_ref": "quiet_depth@1.0.1", "evaluated_evidence_version": 1}
    repo.winner = winner
    assert (await runtime.aresolve(FOCUS))["persona_id"] == "quiet_depth"
    assert len(model.calls) == 1


@pytest.mark.asyncio
async def test_overlapping_resolves_share_one_selector_call_for_scope_version():
    class GatedModel(FakeChatModel):
        def __init__(self):
            super().__init__(SWITCH)
            self.started = asyncio.Event()
            self.release = asyncio.Event()

        async def ainvoke(self, messages, **kwargs):
            self.calls.append((messages, kwargs))
            self.started.set()
            await self.release.wait()
            return type("Reply", (), {"content": self.content})()

    repo = FakeRepository(snapshot())
    model = GatedModel()
    first_runtime = CreatorAgentRuntime(repository=repo, selector=PersonaSelector(model=model))
    second_runtime = CreatorAgentRuntime(repository=repo, selector=PersonaSelector(model=model))
    first = asyncio.create_task(first_runtime.aresolve(FOCUS))
    await model.started.wait()
    second = asyncio.create_task(second_runtime.aresolve(FOCUS))
    await asyncio.sleep(0)
    model.release.set()
    first_result, second_result = await asyncio.gather(first, second)
    assert first_result["persona_id"] == second_result["persona_id"] == "clear_direct"
    assert len(model.calls) == 1


@pytest.mark.asyncio
async def test_late_stale_read_refreshes_after_claim_before_selecting():
    class DelayedReadRepository(FakeRepository):
        def __init__(self, data):
            super().__init__(data)
            self.delayed_task = None
            self.captured = asyncio.Event()
            self.release_read = asyncio.Event()
            self.delayed_once = False

        async def get(self, **scope):
            if asyncio.current_task() is self.delayed_task and not self.delayed_once:
                self.delayed_once = True
                old = deepcopy(self.data)
                self.captured.set()
                await self.release_read.wait()
                return old
            return await super().get(**scope)

    class GatedModel(FakeChatModel):
        def __init__(self):
            super().__init__(SWITCH)
            self.started = asyncio.Event()
            self.release = asyncio.Event()

        async def ainvoke(self, messages, **kwargs):
            self.calls.append((messages, kwargs))
            self.started.set()
            await self.release.wait()
            return type("Reply", (), {"content": self.content})()

    repo = DelayedReadRepository(snapshot())
    model = GatedModel()
    first_runtime = CreatorAgentRuntime(repository=repo, selector=PersonaSelector(model=model))
    second_runtime = CreatorAgentRuntime(repository=repo, selector=PersonaSelector(model=model))
    first = asyncio.create_task(first_runtime.aresolve(FOCUS))
    await model.started.wait()
    second = asyncio.create_task(second_runtime.aresolve(FOCUS))
    repo.delayed_task = second
    await repo.captured.wait()
    model.release.set()
    first_result = await first
    repo.release_read.set()
    second_result = await second
    assert first_result["persona_id"] == second_result["persona_id"] == "clear_direct"
    assert len(model.calls) == 1
    assert len(repo.writes) == 1


@pytest.mark.asyncio
async def test_no_focus_does_not_read_private_relationship():
    runtime, repo, model = make_runtime(SWITCH)
    assert await runtime.aresolve(None) is None
    assert not repo.writes and not model.calls


@pytest.mark.asyncio
async def test_no_contact_prevents_selector_and_persona_injection():
    runtime, repo, model = make_runtime(SWITCH, data=snapshot(do_not_contact=True))
    assert (await runtime.aresolve(FOCUS))["boundary"] == "do_not_contact"
    assert not repo.writes and not model.calls


@pytest.mark.asyncio
async def test_no_contact_boundary_reaches_lead_without_persona():
    runtime, repo, model = make_runtime(SWITCH, data=snapshot(do_not_contact=True))
    middleware = CreatorAgentMiddleware(runtime)
    request = FakeRequest(state={"creator_agent_focus": FOCUS.as_kwargs()}, runtime=type("Run", (), {"context": {"channel_name": "chat", "user_id": "owner-1"}})())
    observed = []

    async def handler(req):
        observed.append(req)
        return "ok"

    await middleware.awrap_model_call(request, handler)
    systems = [m.content for m in observed[0].messages if isinstance(m, SystemMessage)]
    assert len(systems) == 1
    assert "Do not contact" in systems[0]
    assert "creator-agent-persona" not in systems[0]
    assert model.calls == [] and repo.writes == []


@pytest.mark.asyncio
async def test_cas_conflict_rechecks_new_do_not_contact_boundary():
    runtime, repo, model = make_runtime(SWITCH)
    winner = snapshot(do_not_contact=True)
    winner["evidence_version"] = 2
    repo.winner = winner
    result = await runtime.aresolve(FOCUS)
    assert result["boundary"] == "do_not_contact"
    assert "persona_id" not in result
    assert len(model.calls) == 1


class FakeRequest:
    def __init__(self, *, state, runtime, messages=None):
        self.state = state
        self.runtime = runtime
        self.messages = messages or [HumanMessage(content="Draft a reply")]

    def override(self, **kwargs):
        return FakeRequest(state=self.state, runtime=self.runtime, messages=kwargs.get("messages", self.messages))


@pytest.mark.asyncio
async def test_model_request_has_one_active_persona_and_fingerprint():
    data = snapshot()
    data["facts"] = ["周五直播"]
    runtime, _, _ = make_runtime('{"action":"stay","persona_id":"relaxed_wit","confidence":0.9,"evidence_refs":[],"reason":"证据不足"}', data=data)
    middleware = CreatorAgentMiddleware(runtime)
    request = FakeRequest(state={"creator_agent_focus": FOCUS.as_kwargs()}, runtime=type("Run", (), {"context": {"channel_name": "chat", "user_id": "owner-1"}})())
    observed = []

    async def handler(req):
        observed.append(req)
        return "ok"

    await middleware.awrap_model_call(request, handler)
    system = [m.content for m in observed[0].messages if isinstance(m, SystemMessage)]
    assert len(system) == 1
    assert system[0].count("<creator-agent-persona>") == 1
    assert "relaxed_wit" in system[0]
    assert "effective_persona_fingerprint" in system[0]
    assert '"source": "automatic_decision"' in system[0]
    assert "clear_direct" not in system[0]
    assert any("周五直播" in m.content for m in observed[0].messages if isinstance(m, HumanMessage))


@pytest.mark.asyncio
async def test_unverified_external_channel_gets_no_private_relationship():
    runtime, repo, model = make_runtime(SWITCH)
    middleware = CreatorAgentMiddleware(runtime)
    request = FakeRequest(state={"creator_agent_focus": FOCUS.as_kwargs()}, runtime=type("Run", (), {"context": {"channel_name": "tiktok"}})())
    observed = []

    async def handler(req):
        observed.append(req)
        return "ok"

    await middleware.awrap_model_call(request, handler)
    assert observed[0].messages == request.messages
    assert not repo.writes and not model.calls


@pytest.mark.asyncio
async def test_server_identity_mismatch_blocks_repository_read_without_context_user_id():
    runtime, repo, model = make_runtime(SWITCH)
    middleware = CreatorAgentMiddleware(runtime)
    server_user = type("User", (), {"identity": "owner-2"})()
    server_info = type("Info", (), {"user": server_user})()
    run = type("Run", (), {"context": {"channel_name": "chat"}, "server_info": server_info})()
    request = FakeRequest(state={"creator_agent_focus": FOCUS.as_kwargs()}, runtime=run)
    observed = []

    async def handler(req):
        observed.append(req)
        return "ok"

    await middleware.awrap_model_call(request, handler)
    assert observed[0].messages == request.messages
    assert repo.reads == []
    assert model.calls == []


def test_focus_update_binds_scope_to_authenticated_owner():
    focus = focus_update(owner_user_id="owner-1", account_id="account-2", creator_uid="uid-2")
    assert focus == {"owner_user_id": "owner-1", "account_id": "account-2", "creator_uid": "uid-2"}


def test_record_event_uses_exact_operator_message_and_never_creator_authorship():
    message = HumanMessage(content="Call me tomorrow", id="human-1")
    event = operator_message_event(message, source_message_id="human-1")
    assert event["source_kind"] == "operator_note"
    assert event["source_ref"] == "chat:human-1"
    assert event["text"] == "Call me tomorrow"
    assert operator_message_event(message, source_message_id="missing") is None


@pytest.mark.asyncio
async def test_real_repository_event_provenance_reaches_selector(tmp_path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'creator-runtime.db'}")
    try:
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        repo = CreatorAgentRelationshipRepository(async_sessionmaker(engine, expire_on_commit=False))
        await repo.record_evidence(**FOCUS.as_kwargs(), event={"event_id": "event-1", "source_ref": "creator:message-1", "source_kind": "creator_message", "text": "请直接告诉我下一步。"})
        model = FakeChatModel(SWITCH)
        runtime = CreatorAgentRuntime(repository=repo, selector=PersonaSelector(model=model))
        result = await runtime.aresolve(FOCUS)
        assert len(model.calls) == 1
        assert result["persona_id"] == "clear_direct"
    finally:
        await engine.dispose()
