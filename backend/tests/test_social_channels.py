"""Synthetic social transport only; no TikTok provider or platform calls."""

import asyncio
import hashlib
import importlib.util
from dataclasses import FrozenInstanceError, replace
from types import SimpleNamespace

import pytest
import pytest_asyncio
import sqlalchemy as sa
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from test_gateway_services import _stub_app_config  # noqa: F401

from app.channels.base import Channel
from app.channels.manager import ChannelManager
from app.channels.message_bus import InboundMessage, MessageBus
from app.channels.store import ChannelStore
from deerflow.persistence.base import Base
from deerflow.persistence.channel_connections.model import ChannelConnectionRow
from deerflow.persistence.social import BoundaryUpdate, ExternalEvent, SocialConflictError, SocialRepository
from deerflow.social.contracts import IdentityProfile, RoleProfile, SocialScope, TurnResult
from deerflow.social.persona.models import ProfileScope

SCOPE = SocialScope("owner", "account", "creator", "conversation")
REF = "channel:" + hashlib.sha256(b"synthetic-social:e1").hexdigest()
IDENTITY = IdentityProfile("guild-ai", "1", "Guild AI", "ai_agent", "Guild", "I am an AI assistant.", ())
ROLE = RoleProfile("social", "1", "Have a helpful conversation", ("lookup",), "verified-role")
ROLEOS = {
    "company_id": "roleos",
    "department_id": "sales",
    "source_role": "sales",
    "member_id": "sales",
    "native_owner_id": "roleos:sales",
    "assistant_id": "lead_agent",
    "thread_id": "social-thread",
    "source_revision": "roleos-r1",
}


@pytest_asyncio.fixture
async def repository(tmp_path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'social.db'}")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    repo = SocialRepository(async_sessionmaker(engine, expire_on_commit=False))
    await repo.record_event(SCOPE, ExternalEvent("e1", REF, "creator_message", "hello"))
    await repo.set_boundaries(SCOPE, expected_revision=1, update=BoundaryUpdate(True, False, False, (REF,)))
    try:
        yield repo
    finally:
        await engine.dispose()


@pytest_asyncio.fixture
async def empty_repository(tmp_path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'empty-social.db'}")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    try:
        yield SocialRepository(async_sessionmaker(engine, expire_on_commit=False))
    finally:
        await engine.dispose()


async def pending(repo):
    snapshot = await repo.restore(SCOPE)
    return (await repo.commit_turn(SCOPE, expected_revision=snapshot.revision, event_id="e1", result=TurnResult("hi"), persona_fingerprint=snapshot.effective_persona.fingerprint)).outbound


@pytest.mark.asyncio
@pytest.mark.parametrize("change", ["persona", "takeover", "dnc", "identity"])
async def test_claim_rechecks_persona_and_boundaries_inside_transaction(repository, change):
    action = await pending(repository)
    if change == "persona":
        await repository.update_binding(ProfileScope("owner", "account"), expected_revision=0, profile_ref="clear_direct@1.0.1", reason="admin", evidence_ids=())
    else:
        snapshot = await repository.restore(SCOPE)
        await repository.set_boundaries(SCOPE, expected_revision=snapshot.revision, update=BoundaryUpdate(change != "identity", change == "takeover", change == "dnc", (REF,)))
    with pytest.raises(SocialConflictError):
        await repository.claim_outbound(SCOPE, action.action_id, expected_revision=action.revision, event_id="e1", persona_fingerprint=action.persona_fingerprint)
    assert (await repository.restore(SCOPE)).outbound[0].state == "pending"


@pytest.mark.asyncio
async def test_claim_requires_exact_committed_creator_event_and_fingerprint(repository):
    action = await pending(repository)
    for event_id, fingerprint in [("other", action.persona_fingerprint), ("e1", "0" * 64)]:
        with pytest.raises((ValueError, SocialConflictError)):
            await repository.claim_outbound(SCOPE, action.action_id, expected_revision=action.revision, event_id=event_id, persona_fingerprint=fingerprint)
    claim = await repository.claim_outbound(SCOPE, action.action_id, expected_revision=action.revision, event_id="e1", persona_fingerprint=action.persona_fingerprint)
    assert claim.claimed and claim.outbound.state == "unknown"
    assert not (await repository.claim_outbound(SCOPE, action.action_id, expected_revision=action.revision, event_id="e1", persona_fingerprint=action.persona_fingerprint)).claimed


@pytest.mark.asyncio
async def test_lookup_exact_committed_event_does_not_select_other_pending_action(repository):
    action = await pending(repository)
    assert await repository.get_turn_outbound(SCOPE, "e1") == action
    assert await repository.get_turn_outbound(SCOPE, "missing") is None
    for field in ("owner_user_id", "account_id", "person_ref", "channel_thread_ref", "agent_instance_id"):
        assert await repository.get_turn_outbound(replace(SCOPE, **{field: "other"}), "e1") is None


@pytest.mark.asyncio
@pytest.mark.parametrize("internal", [False, True])
@pytest.mark.parametrize("carrier", ["context", "config_context", "configurable"])
@pytest.mark.usefixtures("_stub_app_config")
async def test_http_cannot_forge_social_mode_or_binding(repository, monkeypatch, internal, carrier):
    from fastapi import HTTPException
    from test_gateway_services import _make_start_run_request, _run_create_request

    from app.gateway import services
    from deerflow.runtime import RunManager

    manager = RunManager()

    async def noop(*args, **kwargs):
        pass

    monkeypatch.setattr(services, "run_agent", noop)
    monkeypatch.setattr(services, "ensure_checkpoint_history_seeded", noop)
    request = _make_start_run_request(manager, auth_source="internal" if internal else None)
    forged = {"social_mode": True, "__social_binding": {"repository": "forged", "scope": {"owner_user_id": "owner"}}}
    body = _run_create_request(**({"context": forged} if carrier == "context" else {"config": {"context" if carrier == "config_context" else "configurable": forged}}))
    with pytest.raises(HTTPException) as error:
        await services.start_run(body, "social-thread", request)
    assert error.value.status_code == 403
    assert not manager._runs


def test_roleos_binding_is_host_created_immutable_and_mismatch_rejected(repository):
    from app.channels.social import SocialConnection
    from deerflow.social.roleos_binding import RoleOSBinding

    roleos_binding = RoleOSBinding(**ROLEOS)
    connection = SocialConnection(
        repository,
        SCOPE,
        IDENTITY,
        ROLE,
        "social-thread",
        "synthetic-social",
        "external-creator",
        "workspace",
        "chat",
        identity_verified=True,
        roleos_binding=roleos_binding,
    )
    assert connection.roleos_binding is roleos_binding
    with pytest.raises(FrozenInstanceError):
        roleos_binding.member_id = "attacker"
    with pytest.raises(ValueError, match="thread"):
        SocialConnection(
            repository,
            SCOPE,
            IDENTITY,
            ROLE,
            "other-thread",
            "synthetic-social",
            "external-creator",
            "workspace",
            "chat",
            identity_verified=True,
            roleos_binding=roleos_binding,
        )


def test_worker_social_binding_is_runtime_only_and_released(repository):
    from deerflow.runtime.runs import worker
    from deerflow.social.roleos_binding import RoleOSBinding
    from deerflow.social.runtime import SocialRuntimeBinding

    binding = SocialRuntimeBinding(repository, SCOPE, IDENTITY, ROLE, "e1", roleos_binding=RoleOSBinding(**ROLEOS))
    host = worker.RunContext(checkpointer=None, social_binding=binding)
    with pytest.raises(ValueError, match="thread"):
        worker._build_runtime_context("other-thread", "run", None, social_binding=host.social_binding)
    runtime = worker._build_runtime_context(
        "social-thread",
        "run",
        {"__social_binding": "forged", "__roleos_binding": "forged", "social_mode": False},
        social_binding=host.social_binding,
    )
    config = {
        "context": {"__social_binding": "forged", "__roleos_binding": "forged"},
        "configurable": {"__social_binding": "forged", "__roleos_binding": "forged", "social_mode": True},
    }
    worker._install_runtime_context(config, runtime)
    assert config["context"]["__social_binding"] is binding
    assert config["context"]["__roleos_binding"] is binding.roleos_binding
    assert config["context"]["social_mode"] is True
    assert "__social_binding" not in config["configurable"]
    assert "__roleos_binding" not in config["configurable"]
    assert "social_mode" not in config["configurable"]
    worker._release_run_scoped_references([config], runtime, None)
    assert "__social_binding" not in config["context"]
    assert "__roleos_binding" not in config["context"]
    assert "__social_binding" not in runtime
    assert "__roleos_binding" not in runtime


def test_direct_operator_runtime_has_no_roleos_binding():
    from deerflow.runtime.runs import worker

    runtime = worker._build_runtime_context("thread", "run", {"__roleos_binding": "forged"})
    assert "__roleos_binding" not in runtime


@pytest.mark.asyncio
@pytest.mark.parametrize("thread_backend", ["memory", "sqlite"])
async def test_native_gateway_launch_uses_runmanager_without_persisting_binding(repository, monkeypatch, thread_backend):
    from test_gateway_services import _make_start_run_request

    from app.gateway import services
    from deerflow.config.app_config import AppConfig, reset_app_config, set_app_config
    from deerflow.runtime import MemoryStreamBridge, RunManager, RunStatus
    from deerflow.social.runtime import SocialRuntimeBinding

    assert hasattr(services, "launch_social_channel_turn"), "native social launch adapter is missing"
    binding = SocialRuntimeBinding(repository, SCOPE, IDENTITY, ROLE, "e1")
    manager = RunManager()
    request = _make_start_run_request(manager)
    request.app.state.stream_bridge = MemoryStreamBridge()
    if thread_backend == "sqlite":
        from deerflow.persistence.thread_meta.sql import ThreadMetaRepository

        request.app.state.thread_store = ThreadMetaRepository(repository.session_factory)
    await request.app.state.thread_store.create("social-thread", user_id="owner")
    seen = []

    async def worker(bridge, run_manager, record, *, ctx, **kwargs):
        seen.append(ctx.social_binding)
        await run_manager.set_status(record.run_id, RunStatus.success)
        await bridge.publish_end(record.run_id)

    async def noop(*args, **kwargs):
        pass

    set_app_config(AppConfig.model_validate({"sandbox": {"use": "deerflow.sandbox.local:LocalSandboxProvider"}}))
    monkeypatch.setattr(services, "run_agent", worker)
    monkeypatch.setattr(services, "ensure_checkpoint_history_seeded", noop)
    monkeypatch.setattr(services, "resolve_trusted_internal_owner_for_attribution", noop)
    try:
        completed = await services.launch_social_channel_turn(app=request.app, binding=binding, thread_id="social-thread", text="hello")
        assert completed is True
        assert seen == [binding]
        assert len(manager._runs) == 1
        record = next(iter(manager._runs.values()))
        assert record.user_id == "owner"
        assert "__social_binding" not in repr(record.kwargs)
        assert "SocialRuntimeBinding" not in repr(record.kwargs)
        assert await services.launch_social_channel_turn(app=request.app, binding=binding, thread_id="social-thread", text="hello") is True
        assert len(manager._runs) == len(seen) == 1
        from fastapi import HTTPException

        with pytest.raises(HTTPException) as missing:
            await services.launch_social_channel_turn(app=request.app, binding=binding, thread_id="missing", text="hello")
        assert missing.value.status_code == 404
    finally:
        reset_app_config()


def social_api():
    assert importlib.util.find_spec("app.channels.social"), "authenticated social channel contract is missing"
    from app.channels import social

    return social


@pytest.mark.asyncio
@pytest.mark.parametrize("owner", [None, "default", "unrelated", "missing"])
@pytest.mark.parametrize("phase", ["initial", "admission"])
@pytest.mark.parametrize("thread_backend", ["memory", "sqlite"])
@pytest.mark.parametrize("strict_flag", [True, False])
@pytest.mark.usefixtures("_stub_app_config")
async def test_social_launch_requires_exact_persisted_thread_owner(repository, monkeypatch, owner, phase, thread_backend, strict_flag):
    from fastapi import HTTPException
    from test_gateway_services import _make_start_run_request

    from app.gateway import services
    from deerflow.runtime import MemoryStreamBridge, RunManager
    from deerflow.social.runtime import SocialRuntimeBinding

    manager = RunManager()
    request = _make_start_run_request(manager)
    request.app.state.stream_bridge = MemoryStreamBridge()
    if thread_backend == "sqlite":
        from deerflow.persistence.thread_meta.sql import ThreadMetaRepository

        request.app.state.thread_store = ThreadMetaRepository(repository.session_factory)
    store = request.app.state.thread_store
    if phase == "admission" or owner != "missing":
        await store.create("social-thread", user_id="owner" if phase == "admission" else owner)

    async def prepare(*args, **kwargs):
        if phase == "admission":
            await store.delete("social-thread", user_id=None)
            if owner != "missing":
                await store.create("social-thread", user_id=owner)

    async def noop(*args, **kwargs):
        pass

    monkeypatch.setattr(services, "ensure_checkpoint_history_seeded", prepare)
    monkeypatch.setattr(services, "resolve_trusted_internal_owner_for_attribution", noop)

    async def worker(bridge, run_manager, record, **kwargs):
        from deerflow.runtime import RunStatus

        await run_manager.set_status(record.run_id, RunStatus.success)
        await bridge.publish_end(record.run_id)

    monkeypatch.setattr(services, "run_agent", worker)
    if not strict_flag:
        original_start = services.start_run

        async def default_start(*args, **kwargs):
            kwargs.pop("require_existing_thread")
            return await original_start(*args, **kwargs)

        monkeypatch.setattr(services, "start_run", default_start)
    binding = SocialRuntimeBinding(repository, SCOPE, IDENTITY, ROLE, "e1")
    with pytest.raises(HTTPException) as denied:
        await services.launch_social_channel_turn(app=request.app, binding=binding, thread_id="social-thread", text="hello")
    assert denied.value.status_code == 404
    assert not manager._runs


@pytest.mark.asyncio
@pytest.mark.parametrize("field,value", [("status", "revoked"), ("owner_user_id", "new-owner")])
async def test_connection_change_after_final_read_before_claim_never_publishes(repository, tmp_path, monkeypatch, field, value):
    fixture = await channel_fixture(repository, tmp_path)
    original = repository.claim_outbound

    async def claim_after_connection_change(*args, **kwargs):
        async with repository.session_factory.begin() as session:
            await session.execute(sa.update(ChannelConnectionRow).where(ChannelConnectionRow.id == "connection").values(**{field: value}))
        return await original(*args, **kwargs)

    monkeypatch.setattr(repository, "claim_outbound", claim_after_connection_change)
    await fixture.manager._handle_message(fixture.msg)
    assert fixture.provider.sent == fixture.published == []
    assert (await repository.get_turn_outbound(SCOPE, "e1")).state == "pending"


def connection_guard(**changes):
    from deerflow.persistence.social.model import SocialConnectionGuard

    return SocialConnectionGuard(**{"connection_id": "connection", "owner_user_id": "owner", "provider": "synthetic-social", "external_account_id": "external-creator", "workspace_id": "workspace", **changes})


@pytest.mark.asyncio
@pytest.mark.parametrize("field,value", [("connection_id", "missing"), ("owner_user_id", "other"), ("provider", "other"), ("external_account_id", "other"), ("workspace_id", "other")])
async def test_claim_connection_guard_requires_all_exact_dimensions(repository, tmp_path, field, value):
    await channel_fixture(repository, tmp_path)
    action = await pending(repository)
    with pytest.raises(ValueError):
        await repository.claim_outbound(SCOPE, action.action_id, expected_revision=0, event_id="e1", persona_fingerprint=action.persona_fingerprint, connection_guard=connection_guard(**{field: value}))
    assert (await repository.get_turn_outbound(SCOPE, "e1")).state == "pending"


@pytest.mark.asyncio
@pytest.mark.parametrize("field,value", [("status", "revoked"), ("owner_user_id", "new-owner")])
@pytest.mark.parametrize("winner", ["claim", "update"])
async def test_sqlite_claim_serializes_with_connection_revoke_and_transfer(repository, tmp_path, monkeypatch, field, value, winner):
    from contextlib import asynccontextmanager

    await channel_fixture(repository, tmp_path)
    action = await pending(repository)
    guard = connection_guard()
    locked, release, competing = asyncio.Event(), asyncio.Event(), asyncio.Event()
    original_write = repository._write

    @asynccontextmanager
    async def controlled_write(scope):
        if winner == "update":
            competing.set()
        async with original_write(scope) as session:
            if winner == "claim":
                locked.set()
                await release.wait()
            yield session

    monkeypatch.setattr(repository, "_write", controlled_write)

    async def claim():
        return await repository.claim_outbound(SCOPE, action.action_id, expected_revision=0, event_id="e1", persona_fingerprint=action.persona_fingerprint, connection_guard=guard)

    async def update():
        async with repository.session_factory.begin() as session:
            if winner == "claim":
                competing.set()
            await session.execute(sa.update(ChannelConnectionRow).where(ChannelConnectionRow.id == "connection").values(**{field: value}))
            if winner == "update":
                locked.set()
                await release.wait()

    first = asyncio.create_task(claim() if winner == "claim" else update())
    await asyncio.wait_for(locked.wait(), 2)
    second = asyncio.create_task(update() if winner == "claim" else claim())
    try:
        await asyncio.wait_for(competing.wait(), 2)
        with pytest.raises(TimeoutError):
            await asyncio.wait_for(asyncio.shield(second), 0.05)
    finally:
        release.set()
    if winner == "claim":
        assert (await first).claimed
        await second
        assert (await repository.get_turn_outbound(SCOPE, "e1")).state == "unknown"
    else:
        await first
        with pytest.raises(ValueError):
            await second
        assert (await repository.get_turn_outbound(SCOPE, "e1")).state == "pending"
    async with repository.session_factory() as session:
        row = await session.get(ChannelConnectionRow, "connection")
        assert getattr(row, field) == value


@pytest.mark.asyncio
async def test_postgres_connection_authorization_emits_exact_row_lock(repository):
    from sqlalchemy.dialects import postgresql

    statements = []

    class Session:
        def get_bind(self):
            return SimpleNamespace(dialect=postgresql.dialect())

        async def execute(self, statement):
            statements.append(statement)
            return SimpleNamespace(scalar_one_or_none=lambda: ChannelConnectionRow(id="connection", owner_user_id="owner", provider="synthetic-social", external_account_id="external-creator", workspace_id="workspace", status="connected"))

    await repository._validate_connection_guard(Session(), SCOPE, connection_guard())
    sql = statements[0].compile(dialect=postgresql.dialect())
    assert "FROM channel_connections" in str(sql)
    assert "WHERE channel_connections.id =" in str(sql)
    assert str(sql).endswith("FOR UPDATE")
    assert sql.params == {"id_1": "connection"}


class SyntheticSocialProvider(Channel):
    """Only the test transport can attest its delivered objects; metadata cannot."""

    def __init__(self, bus, repo):
        super().__init__("synthetic-social", bus, {})
        self.repo = repo
        self.authenticated = {}
        self.receipts = {}
        self.sent = []
        self.result = None

    @property
    def social_capabilities(self):
        return social_api().SocialCapabilities(inbound=True, outbound=True, receipts=True)

    async def start(self):
        pass

    async def stop(self):
        pass

    async def send(self, msg):
        raise AssertionError("ordinary send/typing/streaming must never run")

    async def authenticate_social_event(self, msg):
        return self.authenticated.get(id(msg))

    async def authenticate_social_receipt(self, receipt):
        return self.receipts.get(id(receipt))

    async def send_social(self, msg, *, action_id):
        saved = await self.repo.get_turn_outbound(SCOPE, "e1")
        assert saved and saved.action_id == action_id and saved.state == "unknown"
        self.sent.append(msg)
        if isinstance(self.result, BaseException):
            raise self.result
        return self.result


async def channel_fixture(repository, tmp_path, *, reply="hi", result="accepted", source_kind="creator_message"):
    social = social_api()
    bus = MessageBus()
    published = []

    async def listener(msg):
        published.append(msg)

    bus.subscribe_outbound(listener)
    provider = SyntheticSocialProvider(bus, repository)
    provider.result = social.SocialProviderResult(result, "provider-message", "provider-evidence", "provider-evidence" if result == "delivered" else None)
    binding = social.SocialConnection(repository, SCOPE, IDENTITY, ROLE, "social-thread", "synthetic-social", "external-creator", "workspace", "chat", identity_verified=True)
    connection = {"id": "connection", "owner_user_id": "owner", "provider": "synthetic-social", "external_account_id": "external-creator", "workspace_id": "workspace", "status": "connected"}
    async with repository.session_factory.begin() as session:
        if await session.get(ChannelConnectionRow, "connection") is None:
            session.add(ChannelConnectionRow(**connection))

    async def resolve(**kwargs):
        assert kwargs == {"provider": "synthetic-social", "external_account_id": "external-creator", "workspace_id": "workspace"}
        return connection.copy()

    launched = []

    async def launch(*, binding, thread_id, text):
        assert binding.scope == SCOPE and thread_id == "social-thread" and text == "hello"
        assert binding.event_id == "e1" and not binding.channel_safe_tool_names
        if await repository.is_turn_committed(SCOPE, "e1"):
            return True
        launched.append(binding)
        snapshot = await repository.restore(SCOPE)
        if reply == "error":
            raise RuntimeError("PRIVATE_EXCEPTION")
        if reply == "invalid":
            return True
        from deerflow.social.contracts import FollowUp

        turn = TurnResult(None, followup=FollowUp("tomorrow", "new message")) if reply == "wait" else TurnResult(reply)
        await repository.commit_turn(SCOPE, expected_revision=snapshot.revision, event_id="e1", result=turn, persona_fingerprint=snapshot.effective_persona.fingerprint, enforce_contact_boundaries=True)
        return True

    store = await asyncio.to_thread(ChannelStore, tmp_path / "channels.json")
    manager = ChannelManager(bus, store, connection_repo=SimpleNamespace(find_connection_by_external_identity=resolve), social_channels={provider.name: provider}, social_connections={"connection": binding}, launch_social_turn=launch)
    msg = InboundMessage(provider.name, "chat", "external-creator", "hello", connection_id="connection", owner_user_id="owner", workspace_id="workspace", metadata={"social_mode": True, "scope": {"owner_user_id": "attacker"}})
    provider.authenticated[id(msg)] = social.AuthenticatedSocialEvent("e1", "hello", "external-creator", "workspace", "chat", source_kind)
    return SimpleNamespace(manager=manager, provider=provider, msg=msg, published=published, launched=launched, connection=connection)


@pytest.mark.asyncio
@pytest.mark.parametrize("reply", [None, "wait", "invalid", "error"])
async def test_social_intentional_and_failed_silence_has_no_bus_or_provider_output(repository, tmp_path, reply):
    fixture = await channel_fixture(repository, tmp_path, reply=reply)
    await fixture.manager._handle_message(fixture.msg)
    assert fixture.provider.sent == fixture.published == []


@pytest.mark.asyncio
async def test_conversation_stage_is_host_only_and_requires_verified_receipt(repository):
    from deerflow.social.intelligence import ConversationStage

    snapshot = await repository.restore(SCOPE)
    with pytest.raises(ValueError, match="verified consent"):
        await repository.advance_conversation_stage(SCOPE, expected_revision=snapshot.revision, target_stage=ConversationStage.formal_invite.value, evidence_ids=(REF,), reason="draft")
    with pytest.raises(ValueError):
        await repository.advance_conversation_stage(SCOPE, expected_revision=snapshot.revision, target_stage=ConversationStage.signed.value, evidence_ids=(REF,), reason="model confidence")

    moved = await repository.advance_conversation_stage(SCOPE, expected_revision=snapshot.revision, target_stage=ConversationStage.rapport.value, evidence_ids=(REF,), reason="creator replied")
    with pytest.raises(ValueError, match="formal sales"):
        await repository.advance_conversation_stage(SCOPE, expected_revision=moved.revision, target_stage=ConversationStage.formal_invite.value, evidence_ids=(REF,), reason="jump")


@pytest.mark.asyncio
async def test_manager_exposes_host_stage_and_boundary_mutations_with_followup_fence(repository, tmp_path):
    fixture = await channel_fixture(repository, tmp_path)

    class SchedulerSpy:
        def __init__(self):
            self.cancelled = []

        async def cancel_for_scope_event(self, scope, event_id, *, reason):
            self.cancelled.append((scope, event_id, reason))
            return []

    scheduler = SchedulerSpy()
    fixture.manager._social_followup_scheduler = scheduler
    moved = await fixture.manager.advance_social_stage(
        "connection",
        expected_revision=(await repository.restore(SCOPE)).revision,
        target_stage="rapport",
        evidence_ids=(REF,),
        reason="authenticated creator reply",
    )
    assert moved.conversation_stage == "rapport"
    snapshot = await repository.restore(SCOPE)
    stopped = await fixture.manager.set_social_boundaries(
        "connection",
        expected_revision=snapshot.revision,
        update=BoundaryUpdate(True, False, True, (REF,)),
        event_id="operator-dnc-1",
    )
    assert stopped.do_not_contact is True
    assert scheduler.cancelled == [(SCOPE, "operator-dnc-1", "safety boundary")]


@pytest.mark.asyncio
@pytest.mark.parametrize("state,want", [("accepted", "accepted"), ("delivered", "delivered"), ("rejected", "failed"), ("unknown", "unknown")])
async def test_social_publish_once_after_commit_records_only_provider_evidence(repository, tmp_path, state, want):
    fixture = await channel_fixture(repository, tmp_path, result=state)
    await fixture.manager._handle_message(fixture.msg)
    assert len(fixture.provider.sent) == 1
    assert fixture.provider.sent[0].text == "hi"
    assert fixture.published == []
    assert (await repository.get_turn_outbound(SCOPE, "e1")).state == want
    await fixture.manager._handle_message(fixture.msg)
    assert len(fixture.provider.sent) == len(fixture.launched) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("forgery", ["unattested", "connection", "owner", "workspace", "chat", "sender", "revoked", "operator_note", "platform_observation"])
async def test_social_ingress_cannot_forge_connection_or_creator_authorship(repository, tmp_path, forgery):
    fixture = await channel_fixture(repository, tmp_path, source_kind=forgery if forgery in {"operator_note", "platform_observation"} else "creator_message")
    if forgery == "unattested":
        fixture.provider.authenticated.clear()
    elif forgery == "revoked":
        fixture.connection["status"] = "revoked"
    elif forgery not in {"operator_note", "platform_observation"}:
        setattr(fixture.msg, {"connection": "connection_id", "owner": "owner_user_id", "workspace": "workspace_id", "chat": "chat_id", "sender": "user_id"}[forgery], "attacker")
    await fixture.manager._handle_message(fixture.msg)
    assert fixture.launched == fixture.provider.sent == fixture.published == []


@pytest.mark.asyncio
@pytest.mark.parametrize("error", [TimeoutError("ambiguous"), RuntimeError("ambiguous")])
async def test_unknown_send_survives_restart_and_is_never_blindly_retried(repository, tmp_path, error):
    fixture = await channel_fixture(repository, tmp_path)
    fixture.provider.result = error
    await fixture.manager._handle_message(fixture.msg)
    assert (await repository.get_turn_outbound(SCOPE, "e1")).state == "unknown"
    restarted = await channel_fixture(repository, tmp_path)
    await restarted.manager._handle_message(restarted.msg)
    assert restarted.provider.sent == restarted.launched == []


@pytest.mark.asyncio
async def test_social_waits_until_run_completion_without_publishing_partial_output(repository, tmp_path):
    fixture = await channel_fixture(repository, tmp_path)
    launch = fixture.manager._launch_social_turn
    completed = asyncio.Event()
    ready = asyncio.Event()

    async def delayed(**kwargs):
        await launch(**kwargs)
        ready.set()
        await completed.wait()
        return True

    fixture.manager._launch_social_turn = delayed
    task = asyncio.create_task(fixture.manager._handle_message(fixture.msg))
    try:
        await asyncio.wait_for(ready.wait(), timeout=10)
        assert fixture.provider.sent == fixture.published == []
    finally:
        completed.set()
        await task
    assert len(fixture.provider.sent) == 1


def test_no_production_tiktok_connector_and_capabilities_unverified():
    social = social_api()
    from app.channels.service import _CHANNEL_REGISTRY

    assert "tiktok" not in _CHANNEL_REGISTRY
    assert social.SOCIAL_CAPABILITY_MATRIX["tiktok"] == {"inbound": "unverified", "outbound": "unverified", "receipts": "unverified"}


@pytest.mark.asyncio
@pytest.mark.parametrize("payload,expected", [('{"reply":"hello back","decision_note":"PRIVATE_DECISION"}', "hello back"), ('{"reply":null}', None), ('{"reply":', None)])
async def test_real_native_worker_channel_flow_keeps_binding_and_raw_json_private(repository, tmp_path, monkeypatch, payload, expected):
    from langchain_core.messages import AIMessage
    from test_gateway_services import _make_start_run_request
    from test_social_lead_runtime import ScriptedModel

    from app.gateway import services
    from deerflow.agents.lead_agent import agent as lead
    from deerflow.config.app_config import AppConfig, reset_app_config, set_app_config
    from deerflow.runtime import MemoryStreamBridge, RunManager
    from deerflow.runtime.runs.store.memory import MemoryRunStore
    from deerflow.social.persona.selector import AutomaticPersonaSelector

    monkeypatch.setenv("DEER_FLOW_HOME", str(tmp_path / "home"))
    model = ScriptedModel(responses=[AIMessage(content=payload)])
    monkeypatch.setattr(lead, "create_chat_model", lambda **kwargs: model)
    monkeypatch.setattr(lead, "_load_enabled_available_skills", lambda *args, **kwargs: [])
    monkeypatch.setattr(lead, "apply_prompt_template", lambda **kwargs: "Operator base prompt.")
    monkeypatch.setattr(lead, "build_tracing_callbacks", lambda: [])
    monkeypatch.setattr("deerflow.tools.get_available_tools", lambda **kwargs: [])

    async def stay(*args, **kwargs):
        return None

    monkeypatch.setattr(AutomaticPersonaSelector, "choose", stay)
    monkeypatch.setattr(services, "resolve_trusted_internal_owner_for_attribution", stay)
    app_config = AppConfig.model_validate({"models": [{"name": "fake", "use": "langchain_openai:ChatOpenAI", "model": "fake"}], "sandbox": {"use": "deerflow.sandbox.local:LocalSandboxProvider"}})
    set_app_config(app_config)
    run_store = MemoryRunStore()
    request = _make_start_run_request(RunManager(store=run_store))
    request.app.state.stream_bridge = MemoryStreamBridge()
    await request.app.state.thread_store.create("social-thread", user_id="owner")
    fixture = await channel_fixture(repository, tmp_path)
    fixture.manager._launch_social_turn = lambda **kwargs: services.launch_social_channel_turn(app=request.app, **kwargs)
    try:
        await asyncio.wait_for(fixture.manager._handle_message(fixture.msg), timeout=30)
        records = list(request.app.state.run_manager._runs.values())
        assert len(records) == 1
        record = records[0]
        assert record.status.value == "success", record.error
        assert len(model.seen) == 1
        assert [msg.text for msg in fixture.provider.sent] == ([] if expected is None else [expected])
        assert fixture.published == []
        events = await request.app.state.run_event_store.list_events("social-thread", record.run_id)
        checkpoint = await request.app.state.checkpointer.aget_tuple({"configurable": {"thread_id": "social-thread"}})
        persisted_run = await run_store.get(record.run_id, user_id="owner")
        stream = request.app.state.stream_bridge._streams[record.run_id]
        for surface in (repr(record.kwargs), repr(events), repr(checkpoint), repr(persisted_run), repr(stream.events)):
            assert "SocialRuntimeBinding" not in surface
            assert "__social_binding" not in surface
            assert "PRIVATE_DECISION" not in surface
            assert payload not in surface
        await fixture.manager._handle_message(fixture.msg)
        assert len(model.seen) == 1
        # A newly constructed manager hydrates the persisted admission rather
        # than executing a second native model call after restart.
        request.app.state.run_manager = RunManager(store=run_store)
        await fixture.manager._handle_message(fixture.msg)
        assert len(model.seen) == 1
    finally:
        reset_app_config()


@pytest.mark.asyncio
async def test_social_receipt_requires_authenticated_connection_and_same_provider_ref(repository, tmp_path):
    social = social_api()
    fixture = await channel_fixture(repository, tmp_path)
    await fixture.manager._handle_message(fixture.msg)
    action = await repository.get_turn_outbound(SCOPE, "e1")
    assert hasattr(social, "AuthenticatedSocialReceipt"), "receipt authentication contract missing"
    receipt = social.AuthenticatedSocialReceipt("receipt-1", action.action_id, "external-creator", "workspace", "chat", social.SocialProviderResult("delivered", "provider-message", "receipt-1", "receipt-1"))
    raw = {"raw": "receipt"}
    await fixture.manager.handle_social_receipt(fixture.provider.name, raw)
    assert (await repository.get_turn_outbound(SCOPE, "e1")).state == "accepted"
    fixture.provider.receipts[id(raw)] = replace(receipt, result=social.SocialProviderResult("delivered", "other-message", "receipt-1", "receipt-1"))
    await fixture.manager.handle_social_receipt(fixture.provider.name, raw)
    assert (await repository.get_turn_outbound(SCOPE, "e1")).state == "accepted"
    fixture.provider.receipts[id(raw)] = receipt
    await fixture.manager.handle_social_receipt(fixture.provider.name, raw)
    delivered = await repository.get_turn_outbound(SCOPE, "e1")
    assert delivered.state == "delivered" and delivered.provider_ref == "provider-message"
    await fixture.manager.handle_social_receipt(fixture.provider.name, raw)
    assert await repository.get_turn_outbound(SCOPE, "e1") == delivered
    assert len(fixture.provider.sent) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("change", ["persona", "dnc", "takeover", "identity"])
async def test_boundary_or_persona_change_after_run_completion_prevents_publish(repository, tmp_path, change):
    fixture = await channel_fixture(repository, tmp_path)
    launch = fixture.manager._launch_social_turn

    async def raced(**kwargs):
        await launch(**kwargs)
        if change == "persona":
            await repository.update_binding(ProfileScope("owner", "account"), "clear_direct@1.0.1", expected_revision=0, reason="admin")
        else:
            snapshot = await repository.restore(SCOPE)
            await repository.set_boundaries(SCOPE, expected_revision=snapshot.revision, update=BoundaryUpdate(change != "identity", change == "takeover", change == "dnc", (REF,)))
        return True

    fixture.manager._launch_social_turn = raced
    await fixture.manager._handle_message(fixture.msg)
    assert fixture.provider.sent == fixture.published == []
    assert (await repository.get_turn_outbound(SCOPE, "e1")).state == "pending"


@pytest.mark.asyncio
async def test_concurrent_managers_claim_the_same_committed_action_once(repository, tmp_path):
    await pending(repository)
    first = await channel_fixture(repository, tmp_path)
    second = await channel_fixture(repository, tmp_path)
    await asyncio.gather(first.manager._handle_message(first.msg), second.manager._handle_message(second.msg))
    assert len(first.provider.sent) + len(second.provider.sent) == 1
    assert first.launched == second.launched == []


@pytest.mark.asyncio
async def test_changed_payload_same_event_id_cannot_generate_or_send(repository, tmp_path):
    fixture = await channel_fixture(repository, tmp_path)
    fixture.provider.authenticated[id(fixture.msg)] = replace(fixture.provider.authenticated[id(fixture.msg)], text="forged replay")
    await fixture.manager._handle_message(fixture.msg)
    assert fixture.launched == fixture.provider.sent == fixture.published == []


@pytest.mark.asyncio
async def test_newer_creator_evidence_invalidates_pending_reply(repository):
    action = await pending(repository)
    await repository.record_event(SCOPE, ExternalEvent("e2", "ref2", "creator_message", "stop, changed my mind"))
    with pytest.raises(SocialConflictError):
        await repository.claim_outbound(SCOPE, action.action_id, expected_revision=action.revision, event_id="e1", persona_fingerprint=action.persona_fingerprint)


@pytest.mark.asyncio
async def test_committed_pending_turn_still_requires_successful_native_completion(repository, tmp_path):
    await pending(repository)
    fixture = await channel_fixture(repository, tmp_path)

    async def failed_completion(**kwargs):
        return False

    fixture.manager._launch_social_turn = failed_completion
    await fixture.manager._handle_message(fixture.msg)
    assert fixture.provider.sent == fixture.published == []
    assert (await repository.get_turn_outbound(SCOPE, "e1")).state == "pending"


@pytest.mark.asyncio
async def test_authenticated_new_event_is_durable_before_native_launch(repository, tmp_path):
    fixture = await channel_fixture(repository, tmp_path)
    fixture.provider.authenticated[id(fixture.msg)] = replace(fixture.provider.authenticated[id(fixture.msg)], event_id="new-event")
    seen = []

    async def inspect(*, binding, **kwargs):
        snapshot = await repository.restore(binding.scope)
        event = next(row for row in snapshot.events if row["source_event_id"] == "new-event")
        seen.append(event)
        return False

    fixture.manager._launch_social_turn = inspect
    await fixture.manager._handle_message(fixture.msg)
    assert len(seen) == 1 and seen[0]["text"] == "hello" and seen[0]["source_kind"] == "creator_message"


@pytest.mark.asyncio
async def test_delivery_without_explicit_provider_receipt_stays_unknown(repository, tmp_path):
    fixture = await channel_fixture(repository, tmp_path, result="accepted")
    fixture.provider.result = social_api().SocialProviderResult("delivered", "provider-message", "acceptance-only")
    await fixture.manager._handle_message(fixture.msg)
    assert (await repository.get_turn_outbound(SCOPE, "e1")).state == "unknown"


@pytest.mark.asyncio
@pytest.mark.parametrize("change", ["revoked", "transferred"])
async def test_connection_change_while_run_executes_prevents_publish(repository, tmp_path, change):
    fixture = await channel_fixture(repository, tmp_path)
    launch = fixture.manager._launch_social_turn

    async def changed(**kwargs):
        await launch(**kwargs)
        fixture.connection["status" if change == "revoked" else "owner_user_id"] = "revoked" if change == "revoked" else "new-owner"
        return True

    fixture.manager._launch_social_turn = changed
    await fixture.manager._handle_message(fixture.msg)
    assert fixture.provider.sent == []
    assert (await repository.get_turn_outbound(SCOPE, "e1")).state == "pending"


@pytest.mark.asyncio
@pytest.mark.parametrize("verified", [True, False])
async def test_only_host_verified_person_initializes_first_identity_fact(empty_repository, tmp_path, verified):
    fixture = await channel_fixture(empty_repository, tmp_path)
    fixture.manager._social_connections["connection"] = replace(fixture.manager._social_connections["connection"], identity_verified=verified)
    await fixture.manager._handle_message(fixture.msg)
    snapshot = await empty_repository.restore(SCOPE)
    assert snapshot.identity_verified is verified
    assert len(snapshot.boundary_history) == (1 if verified else 0)
    if verified:
        assert snapshot.boundary_history[0]["evidence_ids"] == [REF]
    assert len(fixture.provider.sent) == (1 if verified else 0)


@pytest.mark.asyncio
async def test_verified_envelope_does_not_override_explicit_identity_revocation(repository, tmp_path):
    snapshot = await repository.restore(SCOPE)
    await repository.set_boundaries(SCOPE, expected_revision=snapshot.revision, update=BoundaryUpdate(False, False, False, (REF,)))
    fixture = await channel_fixture(repository, tmp_path)
    await fixture.manager._handle_message(fixture.msg)
    assert (await repository.restore(SCOPE)).identity_verified is False
    assert len((await repository.restore(SCOPE)).boundary_history) == 2
    assert fixture.provider.sent == []


@pytest.mark.asyncio
@pytest.mark.parametrize("boundary", ["do_not_contact", "human_takeover"])
async def test_identity_initialization_cas_preserves_concurrent_boundary(empty_repository, tmp_path, monkeypatch, boundary):
    fixture = await channel_fixture(empty_repository, tmp_path)
    original = empty_repository.set_boundaries
    raced = []

    async def competing(scope, *, expected_revision, update):
        raced.append(True)
        await original(scope, expected_revision=expected_revision, update=BoundaryUpdate(False, boundary == "human_takeover", boundary == "do_not_contact", (REF,)))
        return await original(scope, expected_revision=expected_revision, update=update)

    monkeypatch.setattr(empty_repository, "set_boundaries", competing)
    await fixture.manager._handle_message(fixture.msg)
    snapshot = await empty_repository.restore(SCOPE)
    assert raced == [True]
    assert getattr(snapshot, boundary) is True and snapshot.identity_verified is False
    assert len(snapshot.boundary_history) == 1
    assert fixture.provider.sent == []


@pytest.mark.asyncio
async def test_worker_uses_authenticated_durable_event_ids_not_generic_metadata_dedupe(repository, tmp_path):
    fixture = await channel_fixture(repository, tmp_path)
    fixture.msg.metadata["event_id"] = "shared-untrusted-id"
    second = replace(fixture.msg)
    fixture.provider.authenticated[id(second)] = replace(fixture.provider.authenticated[id(fixture.msg)], event_id="e2")
    seen = []

    async def silent(**kwargs):
        seen.append(kwargs["binding"].event_id)
        return False

    fixture.manager._launch_social_turn = silent
    await fixture.manager.bus.publish_inbound(fixture.msg)
    await fixture.manager.bus.publish_inbound(second)
    await fixture.manager._worker_loop(0)
    assert seen == ["e1", "e2"]
    assert {row["source_event_id"] for row in (await repository.restore(SCOPE)).events} == {"e1", "e2"}


@pytest.mark.asyncio
async def test_cancelled_provider_attempt_keeps_unknown_crash_fence(repository, tmp_path):
    fixture = await channel_fixture(repository, tmp_path)
    fixture.provider.result = asyncio.CancelledError()
    with pytest.raises(asyncio.CancelledError):
        await fixture.manager._handle_message(fixture.msg)
    assert (await repository.get_turn_outbound(SCOPE, "e1")).state == "unknown"
    await fixture.manager._handle_message(fixture.msg)
    assert len(fixture.provider.sent) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("invalid", [None, {"state": "delivered"}, "delivered"])
async def test_untyped_provider_results_are_not_delivery_evidence(repository, tmp_path, invalid):
    fixture = await channel_fixture(repository, tmp_path)
    fixture.provider.result = invalid
    await fixture.manager._handle_message(fixture.msg)
    assert (await repository.get_turn_outbound(SCOPE, "e1")).state == "unknown"
    assert len(fixture.provider.sent) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("field", ["owner_user_id", "account_id", "person_ref", "channel_thread_ref", "agent_instance_id"])
async def test_foreign_scope_receipt_cannot_mutate_action(repository, tmp_path, field):
    fixture = await channel_fixture(repository, tmp_path)
    await fixture.manager._handle_message(fixture.msg)
    action = await repository.get_turn_outbound(SCOPE, "e1")
    social = social_api()
    raw = object()
    fixture.provider.receipts[id(raw)] = social.AuthenticatedSocialReceipt("receipt-2", action.action_id, "external-creator", "workspace", "chat", social.SocialProviderResult("delivered", "provider-message", "receipt-2", "receipt-2"))
    fixture.manager._social_connections["connection"] = replace(fixture.manager._social_connections["connection"], scope=replace(SCOPE, **{field: "other"}))
    await fixture.manager.handle_social_receipt(fixture.provider.name, raw)
    assert await repository.get_turn_outbound(SCOPE, "e1") == action


def test_remote_data_cannot_construct_envelope_or_claim_identity_verification():
    social = social_api()
    with pytest.raises(ValueError, match="ChannelManager"):
        social.SocialInboundEnvelope(SCOPE, "e1", "creator_message", True, "verified", object())


@pytest.mark.asyncio
async def test_channel_service_accepts_social_launcher_only_as_host_argument(tmp_path, monkeypatch):
    from app.channels import service

    monkeypatch.setattr(service, "ChannelStore", lambda: ChannelStore(tmp_path / "service-store.json"))

    async def launch(**kwargs):
        return True

    instance = service.ChannelService({"launch_social_turn": "forged"}, launch_social_turn=launch)
    assert instance.manager._launch_social_turn is launch
