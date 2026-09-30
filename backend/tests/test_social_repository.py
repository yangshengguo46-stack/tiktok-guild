"""Real SQLite behavioral checks for durable native social state."""

import asyncio
import json
import sys
from dataclasses import replace
from datetime import datetime

import pytest
import pytest_asyncio
import sqlalchemy as sa
from alembic import command
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from deerflow.persistence.base import Base
from deerflow.persistence.bootstrap import _get_alembic_config
from deerflow.social.contracts import ClaimPatch, FollowUp, MemoryCandidate, SocialScope, TurnResult
from deerflow.social.persona.catalog import load_persona_catalog
from deerflow.social.persona.models import PersonaBindings, PersonaProfile, ProfileScope
from deerflow.social.persona.resolver import resolve_profile
from deerflow.social.turns import commit_turn

SCOPE = SocialScope("owner", "account", "person", "channel")


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


async def insert_legacy_profile(repo, *, profile_id, version, revision, length="brief", origin=None):
    """Corrupt/historical fixture bypasses constructors intentionally, not writes under test."""
    from datetime import UTC

    from deerflow.persistence.social.model import social_persona_profile

    payload = {"profile_id": profile_id, "version": version, "base_template_ref": "relaxed_wit@1.0.1", "overrides": {"length": length}, "created_by": "operator", "basis_refs": []}
    if origin:
        payload["management_scope"] = origin
    async with repo.session_factory.begin() as session:
        await session.execute(
            social_persona_profile.insert().values(
                owner_user_id="owner", account_id="account", profile_id=profile_id, version=version, revision=revision, profile_json=payload, basis_refs_json=[], status="registered", created_at=datetime.now(UTC)
            )
        )


@pytest.mark.asyncio
@pytest.mark.parametrize("hidden_duplicate", [False, True])
async def test_corrupt_duplicate_serialized_refs_fail_closed_before_scope_filter(db, hidden_duplicate):
    _, repo, _ = db
    scope = ProfileScope("owner", "account", "lead_agent", "person")
    await insert_legacy_profile(repo, profile_id="x@1", version="2", revision=1)
    origin = {"owner_user_id": "owner", "account_id": "account", "agent_instance_id": "other", "relation_ref": "other"} if hidden_duplicate else None
    await insert_legacy_profile(repo, profile_id="x", version="1@2", revision=2, length="verbose", origin=origin)
    with pytest.raises(ValueError, match="duplicate serialized profile reference"):
        await repo.get_profiles(scope)
    with pytest.raises(ValueError, match="duplicate serialized profile reference"):
        await repo.restore(SCOPE)


@pytest.mark.asyncio
@pytest.mark.parametrize("operation", ["register", "candidate", "activate"])
async def test_repository_revalidates_bypassed_profile_constructor(db, operation):
    _, repo, _ = db
    scope = ProfileScope("owner", "account", "lead_agent", "person")
    active = PersonaProfile("active", "1", "relaxed_wit@1.0.1", {"length": "brief"}, "operator", ())
    await repo.register_profile(scope, active, expected_revision=0)
    await repo.update_binding(scope, "active@1", expected_revision=0, reason="active")
    before = await repo.restore(SCOPE)
    candidate = PersonaProfile("x", "2", "relaxed_wit@1.0.1", {"length": "verbose"}, "operator", ())
    object.__setattr__(candidate, "profile_id", "x@1")
    with pytest.raises(ValueError, match="separator"):
        if operation == "register":
            await repo.register_profile(scope, candidate, expected_revision=1)
        else:
            await repo.manage_profile(scope, candidate=candidate, expected_registry_revision=1, expected_revision=1, reason="collision", activate=operation == "activate")
    assert await repo.restore(SCOPE) == before
    assert set(await repo.get_profiles(scope)) == {"active@1"}


@pytest.mark.asyncio
async def test_concurrent_bypassed_aliases_cannot_write_either_tuple(db):
    _, repo, _ = db
    scope = ProfileScope("owner", "account")
    first = PersonaProfile("x", "2", "relaxed_wit@1.0.1", {"length": "brief"}, "operator", ())
    second = PersonaProfile("x", "2", "relaxed_wit@1.0.1", {"length": "verbose"}, "operator", ())
    object.__setattr__(first, "profile_id", "x@1")
    object.__setattr__(second, "version", "1@2")
    outcomes = await asyncio.gather(repo.register_profile(scope, first, expected_revision=0), repo.register_profile(scope, second, expected_revision=0), return_exceptions=True)
    assert all(isinstance(outcome, ValueError) for outcome in outcomes)
    assert await repo.get_profiles(scope) == {}


@pytest.mark.asyncio
@pytest.mark.parametrize("activate", [False, True])
async def test_second_alias_cannot_overwrite_legacy_active_profile_or_binding(db, activate):
    from deerflow.persistence.social.model import social_persona_binding, social_persona_profile

    _, repo, _ = db
    scope = ProfileScope("owner", "account", "lead_agent", "person")
    # This is the review's first x@1 / 2 profile as it may exist from old code.
    # Existing malformed data is never migrated or served under a new meaning.
    await insert_legacy_profile(repo, profile_id="x@1", version="2", revision=1, length="brief")
    async with repo._write(scope) as session:
        await repo._insert_binding(session, scope, "x@1@2", expected_revision=0, reason="legacy active", evidence_ids=())

    async def rows():
        async with repo.session_factory() as session:
            profiles = (await session.execute(sa.select(social_persona_profile))).mappings().all()
            bindings = (await session.execute(sa.select(social_persona_binding))).mappings().all()
            return profiles, bindings

    before = await rows()
    candidate = PersonaProfile("x", "1", "relaxed_wit@1.0.1", {"length": "verbose"}, "operator", ())
    object.__setattr__(candidate, "version", "1@2")
    with pytest.raises(ValueError, match="separator"):
        await repo.manage_profile(scope, candidate=candidate, expected_registry_revision=1, expected_revision=1, reason="alias", activate=activate)
    assert await rows() == before  # No new row, active behavior/ref/revision unchanged.
    assert before[0][0]["profile_json"]["overrides"]["length"] == "brief"
    with pytest.raises(ValueError, match="separator"):
        await repo.restore(SCOPE)  # Corrupt historical references cannot resolve a changed fingerprint.


def test_postgres_serialized_ref_lookup_is_account_scoped_and_not_tuple_only():
    from sqlalchemy.dialects import postgresql

    from deerflow.persistence.social import sql

    assert hasattr(sql, "_profile_ref_query"), "account-wide serialized reference query is missing"
    query = sql._profile_ref_query(ProfileScope("owner", "account", "agent", "relation"), "x@1@2")
    compiled = query.compile(dialect=postgresql.dialect())
    assert {"owner", "account", "@", "x@1@2"} <= set(compiled.params.values())
    where = str(compiled).split("WHERE", 1)[1]
    assert "||" in where and "profile_id" in where and "version" in where
    assert "scope_key" not in where and "management_scope" not in where


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
@pytest.mark.parametrize("field", ["owner_user_id", "account_id", "person_ref", "channel_thread_ref", "agent_instance_id"])
async def test_scopes_cannot_read_or_dedupe_each_others_events(db, field):
    social, repo, _ = db
    await repo.record_event(SCOPE, event(social))
    other = replace(SCOPE, **{field: "other"})
    assert (await repo.restore(other)).revision == 0
    assert (await repo.record_event(other, replace(event(social), text="different scope"))).revision == 1
    with pytest.raises(ValueError, match="evidence"):
        await repo.commit_turn(
            other, expected_revision=1, event_id="e1", result=TurnResult(None, (ClaimPatch("assert", "foreign", ("missing",), "x", "observed", "person"),)), persona_fingerprint=(await resolved_persona(repo, other)).fingerprint
        )


@pytest.mark.asyncio
async def test_claim_types_retraction_self_and_commitment_remain_distinct(db):
    social, repo, _ = db
    await repo.record_event(SCOPE, event(social))
    patches = tuple(ClaimPatch("assert", kind, ("ref1",), kind, kind, "person") for kind in ("reported", "observed", "hypothesis"))
    memory = tuple(social.SelfMemoryChange("assert", category, category, ("ref1",), text=category) for category in ("self_statement", "self_viewpoint", "commitment", "relationship"))
    saved = await repo.commit_turn(SCOPE, expected_revision=1, event_id="e1", result=TurnResult("hi", patches), persona_fingerprint=(await resolved_persona(repo)).fingerprint, memory_changes=memory)
    assert {claim["kind"] for claim in saved.snapshot.claims} == {"reported", "observed", "hypothesis"}
    assert len(saved.snapshot.self_state) == 2
    assert len(saved.snapshot.commitments) == 1
    assert len(saved.snapshot.relationship) == 1
    assert all(value["status"] == "active" and value["evidence_ids"] == ["ref1"] for value in (*saved.snapshot.claims, *saved.snapshot.self_state, *saved.snapshot.commitments, *saved.snapshot.relationship))
    await repo.record_event(SCOPE, event(social, 2))
    retracted = await repo.commit_turn(SCOPE, expected_revision=3, event_id="e2", result=TurnResult(None, (ClaimPatch("retract", "hypothesis", ("ref2",)),)), persona_fingerprint=(await resolved_persona(repo)).fingerprint)
    hypothesis = next(item for item in retracted.snapshot.claims if item["claim_id"] == "hypothesis")
    assert hypothesis["status"] == "retracted"
    assert hypothesis["evidence_ids"] == ["ref1"]
    assert hypothesis["retraction_evidence_ids"] == ["ref2"]
    assert len(retracted.snapshot.outbound) == 1


@pytest.mark.asyncio
async def test_memory_delta_is_atomic(db):
    social, repo, _ = db
    snapshot = await repo.record_event(SCOPE, event(social))
    snapshot = await repo.set_boundaries(SCOPE, expected_revision=1, update=social.BoundaryUpdate(True, False, False, ("ref1",)))
    result = TurnResult("hi", memory_delta=(MemoryCandidate("assert", "pref:short", "relationship", ("ref1",), "brief"),))
    saved = await commit_turn(repo, snapshot, event_id="e1", result=result)
    assert saved.outbound.reply_text == "hi"
    assert saved.snapshot.relationship[0]["memory_id"] == "pref:short"


@pytest.mark.asyncio
async def test_memory_delta_replay_does_not_duplicate_mutation(db):
    social, repo, _ = db
    snapshot = await repo.record_event(SCOPE, event(social))
    snapshot = await repo.set_boundaries(SCOPE, expected_revision=1, update=social.BoundaryUpdate(True, False, False, ("ref1",)))
    result = TurnResult("hi", memory_delta=(MemoryCandidate("assert", "pref:short", "relationship", ("ref1",), "brief"),))
    first = await commit_turn(repo, snapshot, event_id="e1", result=result)
    replay = await commit_turn(repo, snapshot, event_id="e1", result=result)
    assert replay.snapshot == first.snapshot
    assert len(replay.snapshot.relationship) == 1


@pytest.mark.asyncio
async def test_memory_delta_cross_scope_evidence_fails_closed(db):
    social, repo, _ = db
    snapshot = await repo.record_event(SCOPE, event(social))
    snapshot = await repo.set_boundaries(SCOPE, expected_revision=1, update=social.BoundaryUpdate(True, False, False, ("ref1",)))
    result = TurnResult("hi", memory_delta=(MemoryCandidate("assert", "pref:short", "relationship", ("ref-other",), "brief"),))
    with pytest.raises(ValueError, match="evidence"):
        await commit_turn(repo, snapshot, event_id="e1", result=result)
    restored = await repo.restore(SCOPE)
    assert restored.outbound == ()
    assert restored.relationship == ()


@pytest.mark.asyncio
async def test_invalid_patch_rolls_back_whole_turn_and_outbound(db):
    social, repo, _ = db
    original = await repo.record_event(SCOPE, event(social))
    with pytest.raises(ValueError, match="claim"):
        await repo.commit_turn(
            SCOPE,
            expected_revision=1,
            event_id="e1",
            result=TurnResult("hi", (ClaimPatch("assert", "ok", ("ref1",), "ok", "reported", "person"), ClaimPatch("retract", "missing", ("ref1",)))),
            persona_fingerprint=(await resolved_persona(repo)).fingerprint,
        )
    assert await repo.restore(SCOPE) == original


@pytest.mark.asyncio
async def test_turn_cas_loser_carries_winner_and_duplicate_turn_has_one_outbound(db):
    social, repo, _ = db
    await repo.record_event(SCOPE, event(social))
    barrier = asyncio.Barrier(2)
    fingerprint = (await resolved_persona(repo)).fingerprint

    async def commit(reply):
        await barrier.wait()
        try:
            return await repo.commit_turn(SCOPE, expected_revision=1, event_id="e1", result=TurnResult(reply), persona_fingerprint=fingerprint)
        except social.SocialConflictError as error:
            return error

    results = await asyncio.gather(commit("one"), commit("two"))
    conflicts = [item for item in results if isinstance(item, social.SocialConflictError)]
    assert len(conflicts) == 1
    saved = await repo.restore(SCOPE)
    assert conflicts[0].snapshot == saved
    assert saved.revision == 2 and len(saved.outbound) == 1
    replay = await repo.commit_turn(SCOPE, expected_revision=1, event_id="e1", result=TurnResult(saved.outbound[0].reply_text), persona_fingerprint=fingerprint)
    assert replay.snapshot == saved and replay.outbound == saved.outbound[0]


@pytest.mark.asyncio
@pytest.mark.parametrize("followup", [None, FollowUp("check", "cancel")])
async def test_wait_and_no_reply_never_create_outbound(db, followup):
    social, repo, _ = db
    await repo.record_event(SCOPE, event(social))
    saved = await repo.commit_turn(SCOPE, expected_revision=1, event_id="e1", result=TurnResult(None, followup=followup), persona_fingerprint=(await resolved_persona(repo)).fingerprint)
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
    turn = await repo.commit_turn(SCOPE, expected_revision=1, event_id="e1", result=TurnResult("hi"), persona_fingerprint=(await resolved_persona(repo)).fingerprint)
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
    assert first.account_default_ref == "clear_direct@1.0.1" and first.revision == 2
    assert (await repo.get_binding_state(scope)).write_revision == 1
    noop = await repo.update_binding(scope, "clear_direct@1.0.1", expected_revision=1, reason="automatic selection", mode="automatic")
    assert noop == first
    rollback = await repo.update_binding(scope, "clear_direct@1.0.1", expected_revision=1, reason="administrative rollback")
    assert rollback.revision == 3
    assert (await repo.get_binding_state(scope)).write_revision == 2
    with pytest.raises(social.SocialConflictError) as caught:
        await repo.update_binding(scope, "quiet_depth@1.0.1", expected_revision=1, reason="stale")
    assert caught.value.snapshot == rollback
    relation = ProfileScope("owner", "account", "lead_agent", "person")
    selected = await repo.update_binding(relation, "quiet_depth@1.0.1", expected_revision=0, reason="relation selection")
    assert selected.account_default_ref == "clear_direct@1.0.1" and selected.relation_override_ref == "quiet_depth@1.0.1"
    cleared = await repo.update_binding(relation, None, expected_revision=1, reason="clear")
    assert cleared.relation_override_ref is None and cleared.revision == 5
    assert (await repo.get_binding_state(relation)).write_revision == 2
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
    first = await repo.commit_turn(SCOPE, expected_revision=1, event_id="e1", result=TurnResult("one"), persona_fingerprint=(await resolved_persona(repo)).fingerprint)
    await repo.claim_outbound(SCOPE, first.outbound.action_id, expected_revision=0)
    await repo.record_event(SCOPE, event(social, 2))
    second = await repo.commit_turn(SCOPE, expected_revision=4, event_id="e2", result=TurnResult("two"), persona_fingerprint=(await resolved_persona(repo)).fingerprint)
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
    turn = await repo.commit_turn(SCOPE, expected_revision=1, event_id="e1", result=TurnResult("hi"), persona_fingerprint=(await resolved_persona(repo)).fingerprint)
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
                sa.text(
                    "INSERT INTO social_persona_binding SELECT owner_user_id,account_id,'different-key',agent_instance_id,relation_ref,revision,"
                    "generation+100,profile_ref,reason,evidence_refs_json,status,effective_at FROM social_persona_binding"
                )
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


async def resolved_persona(repo, scope=SCOPE):
    bindings = await repo.get_bindings(ProfileScope(scope.owner_user_id, scope.account_id, scope.agent_instance_id, scope.person_ref))
    profiles = await repo.get_profiles(bindings.scope)
    snapshot = await repo.restore(scope)
    return resolve_profile(catalog=load_persona_catalog(), profiles=profiles, bindings=bindings, evidence_version=snapshot.revision)


@pytest.mark.asyncio
@pytest.mark.parametrize("level", ["account", "agent", "relation"])
async def test_commit_atomically_rejects_changed_effective_binding(db, level):
    social, repo, _ = db
    await repo.record_event(SCOPE, event(social))
    original = await resolved_persona(repo)
    binding_scope = ProfileScope("owner", "account", "lead_agent" if level != "account" else None, "person" if level == "relation" else None)
    await repo.update_binding(binding_scope, "clear_direct@1.0.1", expected_revision=0, reason="changed while generation ran")
    with pytest.raises(social.SocialConflictError) as caught:
        await repo.commit_turn(SCOPE, expected_revision=1, event_id="e1", result=TurnResult("old generation"), persona_fingerprint=original.fingerprint)
    assert caught.value.snapshot.revision == 1
    assert caught.value.snapshot.outbound == ()
    assert (await repo.restore(SCOPE)).outbound == ()


@pytest.mark.asyncio
async def test_agents_have_independent_events_memory_boundaries_and_outbox(db):
    social, repo, _ = db
    await repo.record_event(SCOPE, event(social))
    other = replace(SCOPE, agent_instance_id="independent-agent")
    assert (await repo.restore(other)).revision == 0
    assert (await repo.restore(other)).events == ()
    await repo.record_event(other, replace(event(social), text="agent two"))
    first = await repo.commit_turn(
        SCOPE,
        expected_revision=1,
        event_id="e1",
        result=TurnResult("lead reply"),
        persona_fingerprint=(await resolved_persona(repo)).fingerprint,
        memory_changes=(social.SelfMemoryChange("assert", "self", "self_statement", ("ref1",), "lead self"),),
    )
    second = await repo.commit_turn(
        other,
        expected_revision=1,
        event_id="e1",
        result=TurnResult("other reply"),
        persona_fingerprint=(await resolved_persona(repo, other)).fingerprint,
        memory_changes=(social.SelfMemoryChange("assert", "self", "self_statement", ("ref1",), "other self"),),
    )
    assert first.outbound.action_id != second.outbound.action_id
    assert (await repo.restore(SCOPE)).self_state[0]["text"] == "lead self"
    assert (await repo.restore(other)).self_state[0]["text"] == "other self"
    assert len((await repo.restore(other)).outbound) == 1
    with pytest.raises(ValueError):
        await repo.claim_outbound(other, first.outbound.action_id, expected_revision=0)
    assert (await repo.claim_outbound(other, second.outbound.action_id, expected_revision=0)).claimed
    assert (await repo.restore(SCOPE)).outbound[0].state == "pending"
    await repo.set_boundaries(SCOPE, expected_revision=2, update=social.BoundaryUpdate(True, True, True, ("ref1",)))
    assert not (await repo.restore(other)).do_not_contact


@pytest.mark.asyncio
@pytest.mark.parametrize("level", ["account", "agent"])
async def test_inherited_rollback_preserves_real_provenance_and_fences_old_turn(db, level):
    social, repo, _ = db
    source = ProfileScope("owner", "account", "lead_agent" if level == "agent" else None)
    target = ProfileScope("owner", "account", "lead_agent", "person")
    inherited = await repo.update_binding(source, "relaxed_wit@1.0.1", expected_revision=0, reason="initial inherited")
    before = await repo.get_binding_state(target)
    assert before.write_revision == 0
    assert before.bindings.effective_at == inherited.effective_at
    assert before.source_scope == source
    assert before.source_revision == 1
    assert before.source_effective_at == inherited.effective_at
    await repo.record_event(SCOPE, event(social))
    original = await resolved_persona(repo)
    rollback = await repo.update_binding(source, "relaxed_wit@1.0.1", expected_revision=1, reason="same-profile administrative rollback")
    after = await repo.get_binding_state(target)
    assert after.write_revision == 0
    assert after.source_scope == source and after.source_revision == 2
    assert after.bindings.revision == rollback.revision > before.bindings.revision
    assert after.bindings.effective_at == rollback.effective_at > before.bindings.effective_at
    assert (await resolved_persona(repo)).fingerprint != original.fingerprint
    with pytest.raises(social.SocialConflictError):
        await repo.commit_turn(SCOPE, expected_revision=1, event_id="e1", result=TurnResult("stale"), persona_fingerprint=original.fingerprint)


@pytest.mark.asyncio
async def test_authoritative_fingerprint_restore_keeps_catalog_io_off_event_loop(db):
    _, repo, _ = db
    from support.detectors.blocking_io_runtime import detect_blocking_io_strict

    with detect_blocking_io_strict():
        snapshot = await repo.restore(SCOPE)
    assert snapshot.effective_persona.profile_ref == "relaxed_wit@1.0.1"


@pytest.mark.asyncio
async def test_initial_same_profile_administration_and_override_clear_do_not_allow_aba(db):
    social, repo, _ = db
    await repo.record_event(SCOPE, event(social))
    implicit = await resolved_persona(repo)
    source = ProfileScope("owner", "account")
    target = ProfileScope("owner", "account", "lead_agent", "person")
    await repo.update_binding(source, "relaxed_wit@1.0.1", expected_revision=0, reason="explicit default")
    original = await resolved_persona(repo)
    assert original.fingerprint != implicit.fingerprint
    await repo.update_binding(target, "clear_direct@1.0.1", expected_revision=0, reason="override")
    await repo.update_binding(target, None, expected_revision=1, reason="clear override")
    assert (await resolved_persona(repo)).fingerprint != original.fingerprint
    with pytest.raises(social.SocialConflictError):
        await repo.commit_turn(SCOPE, expected_revision=1, event_id="e1", result=TurnResult("stale"), persona_fingerprint=original.fingerprint)


@pytest.mark.asyncio
async def test_host_adjustment_commits_with_reproducible_durable_provenance(db):
    social, repo, engine = db
    await repo.record_event(SCOPE, event(social))
    profile_scope = ProfileScope("owner", "account", "lead_agent", "person")
    adjustment = social.TurnAdjustment(values={"voice": "brief", "interests": ("music",)}, source_ref="server:turn-policy", evidence_ids=("ref1",))
    bindings = await repo.get_bindings(profile_scope)
    adjusted = resolve_profile(catalog=load_persona_catalog(), profiles={}, bindings=bindings, evidence_version=1, turn_adjustment=adjustment.values)
    assert adjusted.fingerprint != (await resolved_persona(repo)).fingerprint
    saved = await repo.commit_turn(SCOPE, expected_revision=1, event_id="e1", result=TurnResult("brief response"), persona_fingerprint=adjusted.fingerprint, turn_adjustment=adjustment)
    await repo.update_binding(profile_scope, "clear_direct@1.0.1", expected_revision=0, reason="later change")
    await engine.dispose()
    outbound = (await repo.restore(SCOPE)).outbound[0]
    context = outbound.turn_context
    assert context["adjustment"] == {"values": {"voice": "brief", "interests": ["music"]}, "source_ref": "server:turn-policy", "evidence_ids": ["ref1"]}
    basis = dict(context["bindings"])
    basis["scope"] = ProfileScope(**basis["scope"])
    basis["effective_at"] = datetime.fromisoformat(basis["effective_at"])
    values = dict(context["adjustment"]["values"])
    values["interests"] = tuple(values["interests"])
    reproduced = resolve_profile(catalog=load_persona_catalog(), profiles={}, bindings=PersonaBindings(**basis), evidence_version=context["evidence_version"], turn_adjustment=values)
    assert reproduced.fingerprint == outbound.persona_fingerprint == saved.outbound.persona_fingerprint


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", ["missing", "different", "unapproved", "changed_binding", "foreign_evidence"])
async def test_adjusted_fingerprint_needs_exact_approved_host_input(db, mode):
    social, repo, _ = db
    before = await repo.record_event(SCOPE, event(social))
    scope = ProfileScope("owner", "account", "lead_agent", "person")
    bindings = await repo.get_bindings(scope)
    adjusted = resolve_profile(catalog=load_persona_catalog(), profiles={}, bindings=bindings, evidence_version=1, turn_adjustment={"voice": "brief"})
    if mode == "unapproved":
        with pytest.raises(ValueError):
            social.TurnAdjustment(values={"identity_verified": "true"}, source_ref="server:turn-policy")
    else:
        adjustment = None if mode == "missing" else social.TurnAdjustment(values={"voice": "different" if mode == "different" else "brief"}, source_ref="server:turn-policy", evidence_ids=("foreign",) if mode == "foreign_evidence" else ())
        if mode == "changed_binding":
            await repo.update_binding(scope, "clear_direct@1.0.1", expected_revision=0, reason="changed during model call")
        with pytest.raises((ValueError, social.SocialConflictError)):
            await repo.commit_turn(SCOPE, expected_revision=1, event_id="e1", result=TurnResult("reply"), persona_fingerprint=adjusted.fingerprint, turn_adjustment=adjustment)
    after = await repo.restore(SCOPE)
    assert after.revision == before.revision and after.outbound == () and after.claims == ()


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
            event_pk = await conn.run_sync(lambda sync: sa.inspect(sync).get_pk_constraint("social_event")["constrained_columns"])
            assert "agent_instance_id" in event_pk
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
        committed = await repo.commit_turn(SCOPE, expected_revision=1, event_id="e1", result=TurnResult("draft"), persona_fingerprint=(await resolved_persona(repo)).fingerprint)
        assert committed.outbound.state == "pending"
        candidate = PersonaProfile("migrated", "1", "clear_direct@1.0.1", {}, "operator", ())
        assert await repo.register_profile(ProfileScope("owner", "account"), candidate, expected_revision=0) == candidate
    finally:
        await engine.dispose()
