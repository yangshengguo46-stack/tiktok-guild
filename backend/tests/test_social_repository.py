"""Real SQLite behavioral checks for durable native social state."""

import asyncio
import json
import sys
from dataclasses import replace

import pytest
import pytest_asyncio
import sqlalchemy as sa
from alembic import command
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from deerflow.persistence.base import Base
from deerflow.persistence.bootstrap import _get_alembic_config
from deerflow.social.contracts import ClaimPatch, FollowUp, SocialScope, TurnResult
from deerflow.social.persona.models import PersonaProfile, ProfileScope

SCOPE = SocialScope("owner", "account", "person", "channel")
FINGERPRINT = "a" * 64


def api():
    # A missing implementation is an assertion failure, not a collection error.
    import importlib.util

    assert importlib.util.find_spec("deerflow.persistence.social") is not None, "native social persistence is missing"
    from deerflow.persistence import social

    return social


@pytest_asyncio.fixture
async def db(tmp_path):
    social = api()
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'social.db'}")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    try:
        yield social, social.SocialRepository(factory), engine
    finally:
        await engine.dispose()


def event(social, number=1, **kwargs):
    return social.ExternalEvent(source_event_id=f"e{number}", source_ref=f"ref{number}", source_kind="creator_message", text="hello", **kwargs)


@pytest.mark.asyncio
async def test_event_idempotency_survives_restart_and_70_later_events(db):
    social, repo, engine = db
    first = await repo.record_event(SCOPE, event(social))
    assert first.revision == 1
    for number in range(2, 73):
        await repo.record_event(SCOPE, event(social, number))
    await engine.dispose()
    reopened = social.SocialRepository(async_sessionmaker(engine, expire_on_commit=False))
    saved = await reopened.restore(SCOPE)
    assert saved.revision == 72
    assert await reopened.record_event(SCOPE, event(social)) == saved
    with pytest.raises(ValueError, match="event"):
        await reopened.record_event(SCOPE, replace(event(social), text="changed"))
    assert await reopened.restore(SCOPE) == saved


@pytest.mark.asyncio
@pytest.mark.parametrize("field", ["owner_user_id", "account_id", "person_ref", "channel_thread_ref"])
async def test_scopes_cannot_read_or_dedupe_each_others_events(db, field):
    social, repo, _ = db
    await repo.record_event(SCOPE, event(social))
    other = replace(SCOPE, **{field: "other"})
    assert (await repo.restore(other)).revision == 0
    assert (await repo.record_event(other, replace(event(social), text="different scope"))).revision == 1
    with pytest.raises(ValueError, match="evidence"):
        await repo.commit_turn(other, expected_revision=1, event_id="e1", result=TurnResult(None, (ClaimPatch("assert", "foreign", ("missing",), "x", "observed", "person"),)), persona_fingerprint=FINGERPRINT)


@pytest.mark.asyncio
async def test_claim_types_retraction_self_and_commitment_remain_distinct(db):
    social, repo, _ = db
    await repo.record_event(SCOPE, event(social))
    patches = tuple(ClaimPatch("assert", kind, ("ref1",), kind, kind, "person") for kind in ("reported", "observed", "hypothesis"))
    memory = tuple(social.SelfMemoryChange("assert", category, category, ("ref1",), text=category) for category in ("self_statement", "self_viewpoint", "commitment", "relationship"))
    saved = await repo.commit_turn(SCOPE, expected_revision=1, event_id="e1", result=TurnResult("hi", patches), persona_fingerprint=FINGERPRINT, memory_changes=memory)
    assert {claim["kind"] for claim in saved.snapshot.claims} == {"reported", "observed", "hypothesis"}
    assert len(saved.snapshot.self_state) == 2
    assert len(saved.snapshot.commitments) == 1
    assert len(saved.snapshot.relationship) == 1
    assert all(value["status"] == "active" and value["evidence_ids"] == ["ref1"] for value in (*saved.snapshot.claims, *saved.snapshot.self_state, *saved.snapshot.commitments, *saved.snapshot.relationship))
    await repo.record_event(SCOPE, event(social, 2))
    retracted = await repo.commit_turn(SCOPE, expected_revision=3, event_id="e2", result=TurnResult(None, (ClaimPatch("retract", "hypothesis", ("ref2",)),)), persona_fingerprint=FINGERPRINT)
    hypothesis = next(item for item in retracted.snapshot.claims if item["claim_id"] == "hypothesis")
    assert hypothesis["status"] == "retracted"
    assert hypothesis["evidence_ids"] == ["ref1"]
    assert hypothesis["retraction_evidence_ids"] == ["ref2"]
    assert len(retracted.snapshot.outbound) == 1


@pytest.mark.asyncio
async def test_invalid_patch_rolls_back_whole_turn_and_outbound(db):
    social, repo, _ = db
    original = await repo.record_event(SCOPE, event(social))
    with pytest.raises(ValueError, match="claim"):
        await repo.commit_turn(
            SCOPE, expected_revision=1, event_id="e1", result=TurnResult("hi", (ClaimPatch("assert", "ok", ("ref1",), "ok", "reported", "person"), ClaimPatch("retract", "missing", ("ref1",)))), persona_fingerprint=FINGERPRINT
        )
    assert await repo.restore(SCOPE) == original


@pytest.mark.asyncio
async def test_turn_cas_loser_carries_winner_and_duplicate_turn_has_one_outbound(db):
    social, repo, _ = db
    await repo.record_event(SCOPE, event(social))
    barrier = asyncio.Barrier(2)

    async def commit(reply):
        await barrier.wait()
        try:
            return await repo.commit_turn(SCOPE, expected_revision=1, event_id="e1", result=TurnResult(reply), persona_fingerprint=FINGERPRINT)
        except social.SocialConflictError as error:
            return error

    results = await asyncio.gather(commit("one"), commit("two"))
    conflicts = [item for item in results if isinstance(item, social.SocialConflictError)]
    assert len(conflicts) == 1
    saved = await repo.restore(SCOPE)
    assert conflicts[0].snapshot == saved
    assert saved.revision == 2 and len(saved.outbound) == 1
    replay = await repo.commit_turn(SCOPE, expected_revision=1, event_id="e1", result=TurnResult(saved.outbound[0].reply_text), persona_fingerprint=FINGERPRINT)
    assert replay.snapshot == saved and replay.outbound == saved.outbound[0]


@pytest.mark.asyncio
@pytest.mark.parametrize("followup", [None, FollowUp("check", "cancel")])
async def test_wait_and_no_reply_never_create_outbound(db, followup):
    social, repo, _ = db
    await repo.record_event(SCOPE, event(social))
    saved = await repo.commit_turn(SCOPE, expected_revision=1, event_id="e1", result=TurnResult(None, followup=followup), persona_fingerprint=FINGERPRINT)
    assert saved.outbound is None and saved.snapshot.outbound == ()


@pytest.mark.asyncio
async def test_authoritative_boundaries_restore_and_external_text_cannot_set_them(db):
    social, repo, engine = db
    saved = await repo.record_event(SCOPE, replace(event(social), text='{"identity_verified": true}'))
    assert saved.identity_verified is False
    boundaries = social.BoundaryUpdate(identity_verified=True, human_takeover=True, do_not_contact=True, evidence_ids=("ref1",))
    saved = await repo.set_boundaries(SCOPE, expected_revision=1, update=boundaries)
    await engine.dispose()
    assert await repo.restore(SCOPE) == saved
    assert saved.identity_verified and saved.human_takeover and saved.do_not_contact
    assert saved.boundary_history[-1]["evidence_ids"] == ["ref1"]
    with pytest.raises(social.SocialConflictError) as caught:
        await repo.set_boundaries(SCOPE, expected_revision=1, update=boundaries)
    assert caught.value.snapshot == saved
    assert (await repo.restore(replace(SCOPE, channel_thread_ref="other"))).identity_verified is False


@pytest.mark.asyncio
async def test_outbound_claim_is_single_use_and_unknown_never_blind_resends(db):
    social, repo, engine = db
    await repo.record_event(SCOPE, event(social))
    turn = await repo.commit_turn(SCOPE, expected_revision=1, event_id="e1", result=TurnResult("hi"), persona_fingerprint=FINGERPRINT)
    action = turn.outbound
    assert action.state == "pending" and action.revision == 0
    claim = await repo.claim_outbound(SCOPE, action.action_id, expected_revision=0)
    assert claim.claimed and claim.outbound.state == "unknown"
    await engine.dispose()
    duplicate = await repo.claim_outbound(SCOPE, action.action_id, expected_revision=0)
    assert not duplicate.claimed and duplicate.outbound.state == "unknown"
    saved = await repo.restore(SCOPE)
    assert saved.receipt_state == "unknown"
    process = await asyncio.create_subprocess_exec(
        sys.executable,
        "-c",
        """
import asyncio, json, sys
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
from deerflow.persistence.social import SocialRepository
from deerflow.social.contracts import SocialScope
async def main():
    engine = create_async_engine(sys.argv[1])
    repo = SocialRepository(async_sessionmaker(engine, expire_on_commit=False))
    scope = SocialScope('owner', 'account', 'person', 'channel')
    result = await repo.claim_outbound(scope, sys.argv[2], expected_revision=0)
    snapshot = await repo.restore(scope)
    print(json.dumps([result.claimed, result.outbound.state, snapshot.receipt_state]))
    await engine.dispose()
asyncio.run(main())
""",
        str(engine.url),
        action.action_id,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await asyncio.wait_for(process.communicate(), 15)
    assert process.returncode == 0, stderr.decode()
    assert json.loads(stdout) == [False, "unknown", "unknown"]
    with pytest.raises(ValueError):
        await repo.record_outbound_result(SCOPE, action.action_id, expected_revision=1, state="pending", provider_ref=None, evidence_ids=("ref1",))
    accepted = await repo.record_outbound_result(SCOPE, action.action_id, expected_revision=1, state="accepted", provider_ref="provider-1", evidence_ids=("receipt:1",))
    assert accepted.state == "accepted" and accepted.revision == 2
    assert await repo.record_outbound_result(SCOPE, action.action_id, expected_revision=1, state="accepted", provider_ref="provider-1", evidence_ids=("receipt:1",)) == accepted
    delivered = await repo.record_outbound_result(SCOPE, action.action_id, expected_revision=2, state="delivered", provider_ref="provider-1", evidence_ids=("receipt:2",))
    assert delivered.state == "delivered"
    with pytest.raises(ValueError):
        await repo.record_outbound_result(SCOPE, action.action_id, expected_revision=3, state="failed", provider_ref="provider-1", evidence_ids=("receipt:3",))
    with pytest.raises(ValueError):
        await repo.claim_outbound(replace(SCOPE, person_ref="other"), action.action_id, expected_revision=3)


@pytest.mark.asyncio
async def test_profile_versions_are_immutable_and_registration_has_cas(db):
    social, repo, _ = db
    scope = ProfileScope("owner", "account")
    candidate = PersonaProfile("custom", "1", "relaxed_wit@1.0.1", {"voice": "brief"}, "operator", ())
    assert await repo.register_profile(scope, candidate, expected_revision=0) == candidate
    assert await repo.register_profile(scope, candidate, expected_revision=0) == candidate
    with pytest.raises(ValueError, match="immutable"):
        await repo.register_profile(scope, replace(candidate, overrides={"voice": "long"}), expected_revision=1)
    with pytest.raises(social.SocialConflictError):
        await repo.register_profile(scope, replace(candidate, version="2"), expected_revision=0)
    await repo.register_profile(scope, replace(candidate, version="2"), expected_revision=1)
    assert set(await repo.get_profiles(scope)) == {"custom@1", "custom@2"}
    assert await repo.get_profiles(ProfileScope("other", "account")) == {}


@pytest.mark.asyncio
async def test_nullable_binding_scopes_cas_automatic_noop_and_admin_rollback(db):
    social, repo, _ = db
    scope = ProfileScope("owner", "account")
    first = await repo.update_binding(scope, "clear_direct@1.0.1", expected_revision=0, reason="set account default")
    assert first.account_default_ref == "clear_direct@1.0.1" and first.revision == 1
    noop = await repo.update_binding(scope, "clear_direct@1.0.1", expected_revision=1, reason="automatic selection", mode="automatic")
    assert noop == first
    rollback = await repo.update_binding(scope, "clear_direct@1.0.1", expected_revision=1, reason="administrative rollback")
    assert rollback.revision == 2
    with pytest.raises(social.SocialConflictError) as caught:
        await repo.update_binding(scope, "quiet_depth@1.0.1", expected_revision=1, reason="stale")
    assert caught.value.snapshot == rollback
    relation = ProfileScope("owner", "account", "lead_agent", "person")
    selected = await repo.update_binding(relation, "quiet_depth@1.0.1", expected_revision=0, reason="relation selection")
    assert selected.account_default_ref == "clear_direct@1.0.1" and selected.relation_override_ref == "quiet_depth@1.0.1"
    cleared = await repo.update_binding(relation, None, expected_revision=1, reason="clear")
    assert cleared.relation_override_ref is None and cleared.revision == 2
    with pytest.raises(ValueError):
        await repo.update_binding(scope, None, expected_revision=2, reason="cannot clear default")
    with pytest.raises(ValueError):
        await repo.update_binding(scope, "missing@1", expected_revision=2, reason="invalid profile")


@pytest.mark.asyncio
async def test_absent_binding_exposes_write_revision_zero_without_fabricating_history(db):
    _, repo, engine = db
    scope = ProfileScope("owner", "account", "lead_agent", "person")
    state = await repo.get_binding_state(scope)
    assert state.write_revision == 0 and state.bindings.revision == 1
    selected = await repo.update_binding(scope, "relaxed_wit@1.0.1", expected_revision=state.write_revision, reason="same effective", mode="automatic")
    assert selected.relation_override_ref is None
    assert (await repo.get_binding_state(scope)).write_revision == 0
    async with engine.connect() as conn:
        assert (await conn.execute(sa.text("SELECT count(*) FROM social_persona_binding"))).scalar() == 0


@pytest.mark.asyncio
async def test_phase0_no_contact_is_conservative_person_wide_boundary_without_fact_promotion(db):
    _, repo, engine = db
    from deerflow.persistence.creator_agent_relationship import CreatorAgentRelationshipRepository

    legacy = CreatorAgentRelationshipRepository(async_sessionmaker(engine, expire_on_commit=False))
    original = await legacy.record_evidence(
        owner_user_id="owner", account_id="account", creator_uid="person", event={"event_id": "old", "source_ref": "old-ref", "source_kind": "creator_message", "text": "stop", "facts": ["untyped"], "do_not_contact": True}
    )
    for channel in ("channel", "other-channel"):
        saved = await repo.restore(replace(SCOPE, channel_thread_ref=channel))
        assert saved.do_not_contact is True
        assert saved.claims == () and saved.events == ()
    assert await legacy.get(owner_user_id="owner", account_id="account", creator_uid="person") == original


@pytest.mark.asyncio
async def test_receipt_projection_preserves_other_unknown_actions(db):
    social, repo, _ = db
    await repo.record_event(SCOPE, event(social))
    first = await repo.commit_turn(SCOPE, expected_revision=1, event_id="e1", result=TurnResult("one"), persona_fingerprint=FINGERPRINT)
    await repo.claim_outbound(SCOPE, first.outbound.action_id, expected_revision=0)
    await repo.record_event(SCOPE, event(social, 2))
    second = await repo.commit_turn(SCOPE, expected_revision=4, event_id="e2", result=TurnResult("two"), persona_fingerprint=FINGERPRINT)
    await repo.claim_outbound(SCOPE, second.outbound.action_id, expected_revision=0)
    await repo.record_outbound_result(SCOPE, first.outbound.action_id, expected_revision=1, state="delivered", provider_ref="p1", evidence_ids=("receipt1",))
    assert (await repo.restore(SCOPE)).receipt_state == "unknown"


@pytest.mark.asyncio
async def test_automatic_binding_mutation_retains_scoped_evidence_and_status(db):
    social, repo, engine = db
    scope = ProfileScope("owner", "account", "lead_agent", "person")
    await repo.record_event(SCOPE, event(social))
    with pytest.raises(ValueError, match="evidence"):
        await repo.update_binding(scope, "clear_direct@1.0.1", expected_revision=0, reason="auto", mode="automatic", evidence_ids=("foreign",))
    await repo.update_binding(scope, "clear_direct@1.0.1", expected_revision=0, reason="auto", mode="automatic", evidence_ids=("ref1",))
    async with engine.connect() as conn:
        record = (await conn.execute(sa.text("SELECT status,evidence_refs_json FROM social_persona_binding"))).one()
        assert record[0] == "applied" and '"ref1"' in record[1]


@pytest.mark.asyncio
async def test_simultaneous_event_writers_and_explicit_stale_cas(db):
    social, repo, _ = db
    await asyncio.gather(repo.record_event(SCOPE, event(social)), repo.record_event(SCOPE, event(social, 2)))
    saved = await repo.restore(SCOPE)
    assert saved.revision == 2 and len(saved.events) == 2
    with pytest.raises(social.SocialConflictError) as caught:
        await repo.record_event(SCOPE, event(social, 3), expected_revision=1)
    assert caught.value.snapshot == saved
    assert await repo.restore(SCOPE) == saved


@pytest.mark.asyncio
async def test_two_claimers_receive_payload_authority_once(db):
    social, repo, _ = db
    await repo.record_event(SCOPE, event(social))
    turn = await repo.commit_turn(SCOPE, expected_revision=1, event_id="e1", result=TurnResult("hi"), persona_fingerprint=FINGERPRINT)
    claims = await asyncio.gather(*(repo.claim_outbound(SCOPE, turn.outbound.action_id, expected_revision=0) for _ in range(2)))
    assert sum(claim.claimed for claim in claims) == 1
    assert all(claim.outbound.state == "unknown" for claim in claims)


@pytest.mark.asyncio
async def test_direct_sql_cannot_duplicate_null_binding_revision(db):
    _, repo, engine = db
    await repo.update_binding(ProfileScope("owner", "account"), "clear_direct@1.0.1", expected_revision=0, reason="one")
    async with engine.begin() as conn:
        with pytest.raises(sa.exc.IntegrityError):
            await conn.execute(
                sa.text("INSERT INTO social_persona_binding SELECT owner_user_id,account_id,'different-key',agent_instance_id,relation_ref,revision,profile_ref,reason,evidence_refs_json,status,effective_at FROM social_persona_binding")
            )


@pytest.mark.asyncio
async def test_binding_concurrent_cas_and_agent_relation_resolution(db):
    social, repo, _ = db
    scope = ProfileScope("owner", "account")

    async def write(ref):
        try:
            return await repo.update_binding(scope, ref, expected_revision=0, reason="first")
        except social.SocialConflictError as error:
            return error

    results = await asyncio.gather(write("clear_direct@1.0.1"), write("quiet_depth@1.0.1"))
    assert sum(isinstance(value, social.SocialConflictError) for value in results) == 1
    state = await repo.get_binding_state(scope)
    assert state.write_revision == 1
    assert next(value for value in results if isinstance(value, social.SocialConflictError)).snapshot == state.bindings
    agent = ProfileScope("owner", "account", "lead_agent")
    await repo.update_binding(agent, "relaxed_wit@1.0.1", expected_revision=0, reason="agent")
    relation = ProfileScope("owner", "account", "lead_agent", "person")
    resolved = await repo.get_bindings(relation)
    assert resolved.agent_override_ref == "relaxed_wit@1.0.1" and resolved.relation_override_ref is None
    assert (await repo.get_bindings(ProfileScope("owner", "account", "other-agent", "person"))).agent_override_ref is None


@pytest.mark.asyncio
async def test_restore_reads_one_transaction_snapshot_during_a_concurrent_write(db):
    social, repo, engine = db
    async with engine.connect() as conn:
        await conn.execute(sa.text("PRAGMA journal_mode=WAL"))
    await repo.record_event(SCOPE, event(social))
    read_started, write_done = asyncio.Event(), asyncio.Event()

    class PausingSession(AsyncSession):
        async def get(self, *args, **kwargs):
            row = await super().get(*args, **kwargs)
            read_started.set()
            await write_done.wait()
            return row

    reader = social.SocialRepository(async_sessionmaker(engine, class_=PausingSession, expire_on_commit=False))
    task = asyncio.create_task(reader.restore(SCOPE))
    try:
        await asyncio.wait_for(read_started.wait(), 3)
        await repo.record_event(SCOPE, event(social, 2))
    finally:
        write_done.set()
    snapshot = await asyncio.wait_for(task, 3)
    assert snapshot.revision == 1
    assert len(snapshot.events) == 1


@pytest.mark.asyncio
async def test_0026_roundtrip_preserves_0025_rows_and_backfills_only_phase0(tmp_path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'migration-roundtrip.db'}")
    cfg = _get_alembic_config(engine)
    try:
        await asyncio.to_thread(command.upgrade, cfg, "0025_creator_agent_relationship")
        async with engine.begin() as conn:
            before_columns = await conn.run_sync(lambda sync: {column["name"] for column in sa.inspect(sync).get_columns("creator_agent_relationship")})
            await conn.execute(
                sa.text("INSERT INTO creator_agent_relationship VALUES ('owner','account','person',1,1,'[]','[]','[\"legacy fact\"]','[]',1,'{\"persona_ref\":\"clear_direct@1.0.1\"}','[]',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)")
            )
            await conn.execute(sa.text("CREATE TABLE guild_creator_context (secret TEXT)"))
            await conn.execute(sa.text("INSERT INTO guild_creator_context VALUES ('obsolete')"))
            before_row = (await conn.execute(sa.text("SELECT * FROM creator_agent_relationship"))).one()
        from alembic.script import ScriptDirectory

        assert "0026_social_runtime" in {rev.revision for rev in ScriptDirectory.from_config(cfg).walk_revisions()}, "social migration is missing"
        await asyncio.to_thread(command.upgrade, cfg, "0026_social_runtime")
        async with engine.connect() as conn:
            tables = await conn.run_sync(lambda sync: set(sa.inspect(sync).get_table_names()))
            assert {"social_event", "social_persona_profile", "social_persona_binding", "social_outbound"} <= tables
            row = (await conn.execute(sa.text("SELECT identity_verified,human_takeover,receipt_state,social_snapshots_json FROM creator_agent_relationship"))).one()
            assert row[:3] == (0, 0, "unknown")
            assert "legacy fact" not in str(row[3])
            assert (await conn.execute(sa.text("SELECT profile_ref FROM social_persona_binding"))).scalars().all() == ["clear_direct@1.0.1"]
            assert (await conn.execute(sa.text("SELECT count(*) FROM social_event"))).scalar() == 0
        await asyncio.to_thread(command.downgrade, cfg, "0025_creator_agent_relationship")
        async with engine.connect() as conn:
            columns = await conn.run_sync(lambda sync: {column["name"] for column in sa.inspect(sync).get_columns("creator_agent_relationship")})
            assert columns == before_columns
            assert (await conn.execute(sa.text("SELECT * FROM creator_agent_relationship"))).one() == before_row
            assert (await conn.execute(sa.text("SELECT secret FROM guild_creator_context"))).scalar() == "obsolete"
        await asyncio.to_thread(command.upgrade, cfg, "0026_social_runtime")
        async with engine.connect() as conn:
            assert (await conn.execute(sa.text("SELECT count(*) FROM social_persona_binding"))).scalar() == 1
        social = api()
        repo = social.SocialRepository(async_sessionmaker(engine, expire_on_commit=False))
        restored_binding = await repo.get_binding_state(ProfileScope("owner", "account", "lead_agent", "person"))
        assert restored_binding.write_revision == 1
        assert restored_binding.bindings.relation_override_ref == "clear_direct@1.0.1"
        saved = await repo.record_event(SCOPE, event(social))
        assert saved.do_not_contact and saved.revision == 1
        committed = await repo.commit_turn(SCOPE, expected_revision=1, event_id="e1", result=TurnResult("draft"), persona_fingerprint=FINGERPRINT)
        assert committed.outbound.state == "pending"
        candidate = PersonaProfile("migrated", "1", "clear_direct@1.0.1", {}, "operator", ())
        assert await repo.register_profile(ProfileScope("owner", "account"), candidate, expected_revision=0) == candidate
    finally:
        await engine.dispose()
