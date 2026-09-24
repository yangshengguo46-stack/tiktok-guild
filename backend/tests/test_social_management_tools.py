"""Native management actions: real SQLite, injected model transport only."""

import importlib.util
import json
from dataclasses import asdict, replace
from types import SimpleNamespace

import pytest
import pytest_asyncio
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from deerflow.persistence.base import Base
from deerflow.persistence.social import ExternalEvent, SelfMemoryChange, SocialConflictError, SocialRepository
from deerflow.social.contracts import ClaimPatch, SocialScope, TurnResult
from deerflow.social.persona.generator import PersonaProfileGenerator
from deerflow.social.persona.models import PersonaProfile, ProfileScope

SCOPE = ProfileScope("owner", "account", "lead_agent", "person")
EVENT_SCOPE = SocialScope("owner", "account", "person", "channel")


def api():
    assert importlib.util.find_spec("deerflow.social.tools"), "native social management tools are missing"
    from deerflow.social import tools

    return tools


class Model:
    def __init__(self, error=None):
        self.error = error
        self.inputs = []

    async def ainvoke(self, messages, **kwargs):
        self.inputs.append(json.loads(messages[-1].content))
        if self.error:
            raise self.error
        return AIMessage(content=json.dumps({"overrides": {"length": "brief"}, "diff_summary": "Shorter expression", "examples": ["Hello.", "Tell me more."]}))


@pytest_asyncio.fixture
async def db(tmp_path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'management.db'}")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    repo = SocialRepository(async_sessionmaker(engine, expire_on_commit=False))
    await repo.record_event(EVENT_SCOPE, ExternalEvent("e1", "note:1", "operator_note", "Keep it brief"))
    await repo.record_event(EVENT_SCOPE, ExternalEvent("e2", "creator:2", "creator_message", "Fewer emojis please"))
    try:
        yield repo
    finally:
        await engine.dispose()


def host(repo, *, model=None):
    module = api()
    capability = module.OperatorManagementCapability("owner", "thread", operator_messages={"m1": "Keep it brief"})
    runtime = SimpleNamespace(context={"__social_management": capability, "user_id": "owner", "channel_name": "chat", "thread_id": "thread"}, config={}, state={"messages": [HumanMessage(id="m1", content="Keep it brief")]})
    return module.ProfileManagement(repo, capability=capability, generator=PersonaProfileGenerator(model or Model())), runtime


@pytest.mark.asyncio
async def test_catalog_preview_resolve_are_expression_only_and_read_only(db):
    service, runtime = host(db)
    before = await db.restore(EVENT_SCOPE)
    result = await service.list_profiles(runtime, SCOPE)
    assert len(result["profiles"]) == 6
    assert result["registry_revision"] == 0
    assert result["operator_source_message_ids"] == ["m1"]
    preview = await service.preview_profile(runtime, SCOPE, "quiet_depth@1.0.1")
    assert preview["current"]["profile_ref"] == "relaxed_wit@1.0.1"
    assert preview["preview"]["profile_ref"] == "quiet_depth@1.0.1"
    assert "events" not in json.dumps(preview) and "Fewer emojis" not in json.dumps(preview)
    assert (await service.resolve_profile(SCOPE))["profile_ref"] == "relaxed_wit@1.0.1"
    assert await db.restore(EVENT_SCOPE) == before


@pytest.mark.asyncio
@pytest.mark.parametrize("context", [{}, {"user_id": "owner"}, {"__social_management": {"owner_user_id": "owner"}, "user_id": "owner"}])
async def test_forged_or_missing_capability_is_denied_even_direct_call(db, context):
    service, runtime = host(db)
    runtime.context = context
    with pytest.raises(PermissionError):
        await service.bind_profile(runtime, SCOPE, "quiet_depth@1.0.1", expected_revision=0, reason="switch")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "patch", [{"channel_name": "social"}, {"channel_name": "github"}, {"channel_name": "telegram"}, {"is_subagent": True}, {"agent_name": "custom"}, {"is_bootstrap": True}, {"social_mode": True}, {"is_internal": True}, {"user_id": "other"}]
)
async def test_runtime_surface_and_owner_rechecked_inside_tools(db, patch):
    service, runtime = host(db)
    runtime.context.update(patch)
    with pytest.raises(PermissionError):
        await service.clear_override(runtime, SCOPE, expected_revision=0, reason="clear")
    assert api().tools_for_lead({"context": runtime.context}, repository=db) == []


@pytest.mark.asyncio
async def test_other_scope_owner_and_released_capability_cannot_execute(db):
    service, runtime = host(db)
    with pytest.raises(PermissionError):
        await service.list_profiles(runtime, replace(SCOPE, owner_user_id="other"))
    runtime.context["__social_management"].release()
    with pytest.raises(PermissionError):
        await service.list_profiles(runtime, SCOPE)


@pytest.mark.asyncio
async def test_bind_clear_and_real_rollback_append_revisions_preserve_facts(db):
    service, runtime = host(db)
    original = await db.restore(EVENT_SCOPE)
    await db.commit_turn(
        EVENT_SCOPE,
        expected_revision=original.revision,
        event_id="e2",
        result=TurnResult(None, (ClaimPatch("assert", "fact", ("creator:2",), "A stated preference", "reported", "person"),)),
        persona_fingerprint=original.effective_persona.fingerprint,
        memory_changes=(SelfMemoryChange("assert", "self", "self_statement", ("note:1",), "I am an AI"), SelfMemoryChange("assert", "promise", "commitment", ("note:1",), "I will follow up")),
    )
    before = await db.restore(EVENT_SCOPE)
    account = ProfileScope("owner", "account")
    await service.bind_profile(runtime, account, "clear_direct@1.0.1", expected_revision=0, reason="default")
    bound = await service.bind_profile(runtime, SCOPE, "quiet_depth@1.0.1", expected_revision=0, reason="override")
    assert bound["scope"] == asdict(SCOPE)
    assert bound["old_profile_ref"] == "clear_direct@1.0.1"
    assert bound["new_profile_ref"] == "quiet_depth@1.0.1"
    assert bound["write_revision"] == 1 and bound["status"] == "active"
    cleared = await service.clear_override(runtime, SCOPE, expected_revision=1, reason="inherit")
    assert cleared["new_profile_ref"] == "clear_direct@1.0.1"
    restored = await service.rollback_binding(runtime, SCOPE, target_revision=1, expected_revision=2, reason="undo clear")
    assert restored["new_profile_ref"] == "quiet_depth@1.0.1"
    assert restored["write_revision"] == 3 and restored["effective_revision"] > cleared["effective_revision"]
    tombstone = await service.rollback_binding(runtime, SCOPE, target_revision=2, expected_revision=3, reason="restore tombstone")
    assert tombstone["new_profile_ref"] == "clear_direct@1.0.1" and tombstone["write_revision"] == 4
    assert tombstone["rollback_of_revision"] == 2
    with pytest.raises(ValueError):
        await service.clear_override(runtime, account, expected_revision=1, reason="invalid")
    after = await db.restore(EVENT_SCOPE)
    assert replace(after, effective_persona=before.effective_persona) == before


async def generate(service, runtime, **kwargs):
    args = dict(base_profile_ref="relaxed_wit@1.0.1", profile_id="short", version="1", requirement="Keep it brief", source_message_id="m1", basis_refs=(), expected_revision=0, reason="requested")
    args.update(kwargs)
    return await service.generate_profile(runtime, SCOPE, **args)


@pytest.mark.asyncio
async def test_generation_persists_candidate_without_binding_and_previews_it(db):
    model = Model()
    service, runtime = host(db, model=model)
    result = await generate(service, runtime)
    assert result["status"] == "candidate" and result["generation_status"] == "candidate"
    assert result["activation_status"] == "not_requested"
    assert result["effective_at"] is None
    assert result["new_profile_ref"] == "short@1" and result["registry_revision"] == 1
    assert (await service.resolve_profile(SCOPE))["profile_ref"] == "relaxed_wit@1.0.1"
    assert (await service.preview_profile(runtime, SCOPE, "short@1"))["preview"]["behavior"]["length"] == "brief"
    assert len(model.inputs[0]["basis_refs"]) == 1 and model.inputs[0]["basis_refs"][0].startswith("chat:")
    assert "immutable_identity_facts" in model.inputs[0]


@pytest.mark.asyncio
async def test_generation_explicit_activation_and_cas(db):
    service, runtime = host(db)
    result = await generate(service, runtime, activate=True, expected_binding_revision=0)
    assert result["generation_status"] == "candidate" and result["activation_status"] == "active"
    assert result["status"] == "active" and result["write_revision"] == 1
    with pytest.raises(SocialConflictError):
        await generate(service, runtime, profile_id="stale", expected_revision=1, activate=True, expected_binding_revision=0)
    assert "stale@1" not in await db.get_profiles(SCOPE)
    with pytest.raises(ValueError):
        await generate(service, runtime, profile_id="missing-cas", expected_revision=1, activate=True)


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["model", "registration", "binding"])
async def test_generation_failure_never_partially_activates(db, monkeypatch, failure):
    service, runtime = host(db, model=Model(RuntimeError("provider unavailable") if failure == "model" else None))
    if failure == "registration":
        await db.register_profile(SCOPE, PersonaProfile("short", "1", "quiet_depth@1.0.1", {}, "operator", ()), expected_revision=0)
    if failure == "binding":

        async def fail(*args, **kwargs):
            raise RuntimeError("binding insert failed")

        monkeypatch.setattr(db, "_insert_binding", fail)
    before = await db.get_profiles(SCOPE)
    with pytest.raises((RuntimeError, ValueError)):
        await generate(service, runtime, expected_revision=len(before), activate=True, expected_binding_revision=0)
    assert await db.get_profiles(SCOPE) == before
    assert (await db.get_binding_state(SCOPE)).write_revision == 0


@pytest.mark.asyncio
@pytest.mark.parametrize("field", ["owner_user_id", "account_id", "agent_instance_id", "relation_ref"])
async def test_generated_profiles_and_basis_cannot_cross_scopes(db, field):
    service, runtime = host(db)
    await generate(service, runtime)
    other = replace(SCOPE, **{field: "other"})
    with pytest.raises((PermissionError, ValueError)):
        await service.preview_profile(runtime, other, "short@1")
    with pytest.raises((PermissionError, ValueError)):
        await service.generate_profile(runtime, other, base_profile_ref="relaxed_wit@1.0.1", profile_id="foreign", version="1", requirement="Keep it brief", basis_refs=("note:1",), expected_revision=1, reason="foreign")


@pytest.mark.asyncio
async def test_preferences_come_from_exact_persisted_events_not_model_claims(db):
    model = Model()
    service, runtime = host(db, model=model)
    await generate(service, runtime, requirement=None, source_message_id=None, basis_refs=("creator:2",))
    assert model.inputs[0]["creator_preferences"] == [{"source_ref": "creator:2", "text": "Fewer emojis please"}]
    with pytest.raises(ValueError):
        await generate(service, runtime, profile_id="invented", expected_revision=1, requirement="Invented request")


def test_registration_only_six_management_tools_no_resolver_or_legacy(tmp_path):
    module = api()
    cap = module.OperatorManagementCapability("owner", "thread")
    config = {"context": {"__social_management": cap, "user_id": "owner", "thread_id": "thread"}}
    repo = SocialRepository(None)
    tools = module.tools_for_lead(config, repository=repo)
    assert {tool.name for tool in tools} == {"social_list_profiles", "social_generate_profile", "social_preview_profile", "social_bind_profile", "social_clear_override", "social_rollback_binding"}
    for tool in tools:
        assert "runtime" not in tool.tool_call_schema.model_fields
    assert module.tools_for_lead({"configurable": {"user_id": "owner", "__social_management": cap}}, repository=repo) == []


@pytest.mark.parametrize("source,role,expected", [("session", "user", True), ("auth_disabled", "user", False), ("internal", "user", False), ("pat", "user", False), (None, "user", False), ("session", "internal", False)])
def test_gateway_only_admits_server_authenticated_operator(source, role, expected):
    from app.gateway import services

    assert hasattr(services, "operator_management_for_request"), "Gateway operator admission is missing"
    request = SimpleNamespace(state=SimpleNamespace(auth_source=source, user=SimpleNamespace(id="owner", system_role=role)))
    cap = services.operator_management_for_request(request, {"context": {"user_id": "forged"}}, thread_id="thread", graph_input={"messages": []})
    assert (cap is not None) is expected
    if cap:
        assert cap.owner_user_id == "owner"


def test_worker_only_installs_runcontext_capability_and_releases_it():
    from deerflow.runtime.runs import worker

    module = api()
    cap = module.OperatorManagementCapability("owner", "thread")
    assert "social_management" in worker.RunContext.__dataclass_fields__, "RunContext capability channel is missing"
    caller = {"__social_management": cap, "user_id": "forged"}
    assert "__social_management" not in worker._build_runtime_context("thread", "run", caller)
    context = worker._build_runtime_context("thread", "run", caller, social_management=cap)
    assert context["__social_management"] is cap and context["user_id"] == "owner"
    config = {"configurable": {"__social_management": cap}, "context": caller}
    worker._install_runtime_context(config, context)
    assert "__social_management" not in config["configurable"]
    worker._release_run_scoped_references([config], context, None)
    assert "__social_management" not in context and not cap.active


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "message",
    [
        AIMessage(id="m1", content="Keep it brief"),
        ToolMessage(id="m1", content="Keep it brief", tool_call_id="t"),
        HumanMessage(id="m1", content="Keep it brief", additional_kwargs={"hide_from_ui": True}),
        HumanMessage(id="old", content="Keep it brief"),
        HumanMessage(id="m1", content="Changed by model"),
    ],
)
async def test_management_source_rejects_hidden_ai_tool_old_or_altered_message(db, message):
    service, runtime = host(db)
    runtime.state["messages"] = [message]
    with pytest.raises(ValueError):
        await generate(service, runtime)
    assert await db.get_profiles(SCOPE) == {}


@pytest.mark.asyncio
async def test_management_note_is_idempotent_scoped_and_never_creator_evidence(db):
    service, runtime = host(db)
    first = await generate(service, runtime)
    second = await generate(service, runtime, expected_revision=1)
    assert first["basis_refs"] == second["basis_refs"]
    assert second["registry_revision"] == 1
    basis = await db.management_basis(SCOPE, tuple(first["basis_refs"]))
    assert len(basis) == 1 and basis[0]["source_kind"] == "operator_note"
    for scope in (ProfileScope("owner", "account"), ProfileScope("owner", "account", "lead_agent")):
        with pytest.raises(ValueError):
            await db.management_basis(scope, tuple(first["basis_refs"]))
    runtime.context["thread_id"] = "other-thread"
    with pytest.raises(PermissionError):
        await generate(service, runtime, expected_revision=1)


@pytest.mark.asyncio
async def test_management_message_duplicate_conflict_and_account_agent_scopes(db):
    service, runtime = host(db)
    for index, scope in enumerate((ProfileScope("owner", "account"), ProfileScope("owner", "account", "lead_agent"), SCOPE)):
        result = await service.generate_profile(
            runtime, scope, base_profile_ref="relaxed_wit@1.0.1", profile_id=f"p{index}", version="1", requirement="Keep it brief", source_message_id="m1", basis_refs=(), expected_revision=index, reason="test"
        )
        assert result["status"] == "candidate"
        with pytest.raises(ValueError):
            await db.record_management_note(scope, thread_id="thread", message_id="m1", text="Different text", expected_revision=index + 1)
    assert (await db.restore(EVENT_SCOPE)).revision == 2


@pytest.mark.asyncio
async def test_preexisting_checkpoint_message_is_not_current_operator_request(db):
    from deerflow.runtime.context_keys import CURRENT_RUN_PRE_EXISTING_MESSAGE_IDS_KEY

    service, runtime = host(db)
    runtime.context[CURRENT_RUN_PRE_EXISTING_MESSAGE_IDS_KEY] = frozenset({"m1"})
    with pytest.raises(ValueError):
        await generate(service, runtime)


@pytest.mark.asyncio
async def test_concurrent_cas_has_one_winner_and_no_lost_update(db):
    import asyncio

    service, runtime = host(db)
    results = await asyncio.gather(*(service.bind_profile(runtime, SCOPE, ref, expected_revision=0, reason="race") for ref in ("quiet_depth@1.0.1", "warm_candid@1.0.1")), return_exceptions=True)
    assert sum(isinstance(result, SocialConflictError) for result in results) == 1
    assert (await db.get_binding_state(SCOPE)).write_revision == 1


def test_management_capability_redacted_from_trace_context():
    from deerflow.runtime.secret_context import redact_config_secrets

    cap = api().OperatorManagementCapability("owner", "thread")
    result = redact_config_secrets({"context": {"__social_management": cap, "user_id": "owner"}})
    assert "__social_management" not in result["context"]


@pytest.mark.asyncio
@pytest.mark.parametrize("carrier", ["context", "config-context", "config-configurable"])
async def test_public_and_internal_http_cannot_supply_management_capability(carrier):
    from fastapi import HTTPException

    from app.gateway import services

    for source in ("session", "internal"):
        config = {}
        context = {}
        if carrier == "context":
            context["__social_management"] = {"owner_user_id": "owner"}
        else:
            config[carrier.removeprefix("config-")] = {"__social_management": {"owner_user_id": "owner"}}
        body = SimpleNamespace(context=context, config=config)
        with pytest.raises(HTTPException) as error:
            await services.start_run(body, "thread", SimpleNamespace(state=SimpleNamespace(auth_source=source)))
        assert error.value.status_code == 403


@pytest.mark.asyncio
@pytest.mark.parametrize("patch", [{}, {"is_subagent": True}, {"agent_name": "custom"}, {"is_bootstrap": True}, {"channel_name": "telegram"}])
async def test_real_lead_assembly_registers_native_management_only_on_operator_chat(db, monkeypatch, patch):
    import asyncio

    from deerflow.agents.lead_agent import agent as lead
    from deerflow.config.app_config import AppConfig
    from deerflow.config.model_config import ModelConfig
    from deerflow.config.sandbox_config import SandboxConfig

    service, runtime = host(db)
    runtime.context.update(patch)
    monkeypatch.setattr(lead, "create_chat_model", lambda **kwargs: object())
    monkeypatch.setattr(lead, "create_agent", lambda **kwargs: kwargs)
    monkeypatch.setattr(lead, "_load_enabled_available_skills", lambda *args, **kwargs: [])
    monkeypatch.setattr(lead, "apply_prompt_template", lambda **kwargs: "Operator")
    monkeypatch.setattr(lead, "build_tracing_callbacks", lambda: [])
    monkeypatch.setattr(lead, "load_agent_config", lambda *args, **kwargs: None)
    monkeypatch.setattr("deerflow.persistence.get_session_factory", lambda: db.session_factory)
    monkeypatch.setattr("deerflow.tools.get_available_tools", lambda **kwargs: [])
    app = AppConfig(models=[ModelConfig(name="fake", use="langchain_openai:ChatOpenAI", model="fake", supports_thinking=False)], sandbox=SandboxConfig(use="deerflow.sandbox.local:LocalSandboxProvider"))
    assembled = await asyncio.to_thread(lead.assemble_lead_agent, {"context": runtime.context}, app_config=app)
    names = [tool.name for tool in assembled.graph["tools"]]
    assert len([name for name in names if name.startswith("social_")]) == (0 if patch else 6)
    assert not any(name.startswith("creator_agent_") for name in names)


@pytest.mark.asyncio
async def test_native_graph_executes_configured_generation_tool_with_injected_runtime(db, monkeypatch):
    from langchain.agents import create_agent
    from test_social_lead_runtime import ScriptedModel

    module = api()
    service, runtime = host(db)
    configured = Model()
    captured = {}

    def factory(**kwargs):
        captured.update(kwargs)
        return configured

    monkeypatch.setattr("deerflow.models.create_chat_model", factory)
    config = {"context": runtime.context}
    app_config = object()
    tools = module.tools_for_lead(config, repository=db, model_name="configured-model", app_config=app_config)
    model = ScriptedModel(
        responses=[
            AIMessage(
                content="",
                tool_calls=[
                    {
                        "id": "g1",
                        "name": "social_generate_profile",
                        "args": {
                            "scope": asdict(SCOPE),
                            "base_profile_ref": "relaxed_wit@1.0.1",
                            "profile_id": "graph-profile",
                            "version": "1",
                            "requirement": "Keep it brief",
                            "source_message_id": "m1",
                            "basis_refs": [],
                            "expected_revision": 0,
                            "reason": "operator request",
                        },
                    }
                ],
            ),
            AIMessage(content="Candidate generated."),
        ]
    )
    graph = create_agent(model=model, tools=tools)
    result = await graph.ainvoke(runtime.state, context=runtime.context)
    receipt = json.loads(next(message.content for message in result["messages"] if isinstance(message, ToolMessage)))
    assert receipt["status"] == "candidate" and receipt["new_profile_ref"] == "graph-profile@1"
    assert captured["name"] == "configured-model" and captured["app_config"] is app_config
    assert (await db.get_binding_state(SCOPE)).write_revision == 0


@pytest.mark.asyncio
async def test_worker_preflight_failure_revokes_admission_capability(monkeypatch):
    from unittest.mock import AsyncMock

    from deerflow.runtime.events.store.memory import MemoryRunEventStore
    from deerflow.runtime.runs.manager import RunManager
    from deerflow.runtime.runs.worker import RunContext, run_agent

    cap = api().OperatorManagementCapability("owner", "thread")
    manager = RunManager()
    record = await manager.create("thread")
    events = MemoryRunEventStore()
    monkeypatch.setattr("deerflow.runtime.runs.worker.aensure_checkpoint_mode_compatible", AsyncMock(side_effect=RuntimeError("incompatible checkpoint")))
    await run_agent(
        SimpleNamespace(publish=AsyncMock(), publish_end=AsyncMock(), cleanup=AsyncMock()),
        manager,
        record,
        ctx=RunContext(checkpointer=object(), event_store=events, social_management=cap),
        agent_factory=lambda _: None,
        graph_input={},
        config={},
    )
    assert not cap.active
    assert "__social_management" not in json.dumps(await events.list_events("thread", record.run_id), default=str)


@pytest.mark.asyncio
async def test_reserved_management_dimensions_do_not_alias_explicit_agent_or_person(db):
    account = ProfileScope("owner", "account")
    ref = await db.record_management_note(account, thread_id="thread", message_id="m", text="brief", expected_revision=0)
    for other in (ProfileScope("owner", "account", "__management__"), ProfileScope("owner", "account", relation_ref="__management__")):
        with pytest.raises(ValueError):
            await db.management_basis(other, (ref,))


@pytest.mark.asyncio
async def test_extra_generation_basis_cannot_include_unselected_operator_notes(db):
    service, runtime = host(db)
    with pytest.raises(ValueError):
        await generate(service, runtime, basis_refs=("note:1",))


def test_gateway_gives_idless_current_operator_message_a_stable_admitted_id():
    from app.gateway.services import operator_management_for_request

    request = SimpleNamespace(state=SimpleNamespace(auth_source="session", user=SimpleNamespace(id="owner", system_role="user")))
    graph_input = {"messages": [HumanMessage(content=" Keep it brief ")]}
    cap = operator_management_for_request(request, {"context": {}}, thread_id="thread", graph_input=graph_input)
    message = graph_input["messages"][0]
    assert message.id and cap.operator_messages == {message.id: "Keep it brief"}
