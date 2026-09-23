"""Persistence contract for a creator-scoped relationship and persona decision."""

from __future__ import annotations

import asyncio
import json

import pytest
import sqlalchemy as sa
from alembic import command
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from deerflow.creator_agent.persona_selector import PersonaSelector
from deerflow.creator_agent.runtime import CreatorAgentRuntime
from deerflow.creator_agent.state import CreatorFocus
from deerflow.persistence.base import Base
from deerflow.persistence.bootstrap import _get_alembic_config
from deerflow.persistence.creator_agent_relationship import (
    CreatorAgentRelationshipRepository,
    RelationshipConflictError,
)

SCOPE = {"owner_user_id": "operator-1", "account_id": "guild-account-1", "creator_uid": "uid-1"}


async def _repository(tmp_path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'relationships.db'}")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine, CreatorAgentRelationshipRepository(async_sessionmaker(engine, expire_on_commit=False))


def _event(event_id="message-1", source_ref="creator:message-1", **extra):
    return {
        "event_id": event_id,
        "source_ref": source_ref,
        "source_kind": "creator_message",
        "text": "我喜欢直接说重点。",
        **extra,
    }


def _decision(decision_id="decision-1", persona_ref="clear_direct@1.0.1", **extra):
    persona_id, persona_version = persona_ref.split("@", 1)
    return {
        "decision_id": decision_id,
        "action": "switch",
        "persona_ref": persona_ref,
        "evaluated_evidence_version": 1,
        "policy_version": "auto-v1",
        "evidence_refs": ["creator:message-1"],
        "reason": "主播要求直接说明重点。",
        "confidence": 0.9,
        "fingerprint_inputs": {
            "operator_id": SCOPE["owner_user_id"],
            "account_id": SCOPE["account_id"],
            "creator_uid": SCOPE["creator_uid"],
            "persona_id": persona_id,
            "persona_version": persona_version,
            "persona_revision": 1,
            "evidence_version": 1,
            "decision_policy_version": "auto-v1",
            "effective_persona_fingerprint": "a" * 64,
        },
        **extra,
    }


@pytest.mark.asyncio
async def test_new_relationship_has_null_persona_state(tmp_path):
    engine, repo = await _repository(tmp_path)
    try:
        assert await repo.get(**SCOPE) is None
        state = await repo.record_evidence(**SCOPE, event=_event())
        assert state["evidence_version"] == 1
        assert state["persona_revision"] == 0
        assert state["persona_state"] is None
        assert state["evidence"][0]["source_ref"] == "creator:message-1"
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_decision_cas_and_duplicate_idempotency(tmp_path):
    engine, repo = await _repository(tmp_path)
    try:
        await repo.record_evidence(**SCOPE, event=_event())
        first = await repo.apply_persona_decision(**SCOPE, expected_evidence_version=1, expected_persona_revision=0, decision=_decision())
        assert first["persona_revision"] == 1
        assert first["persona_state"]["persona_ref"] == "clear_direct@1.0.1"
        assert first["persona_state"]["evaluated_evidence_version"] == 1
        assert first["persona_state"]["effective_persona_fingerprint"] == "a" * 64
        duplicate = await repo.apply_persona_decision(**SCOPE, expected_evidence_version=1, expected_persona_revision=0, decision=_decision())
        assert duplicate == first
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_rejects_stale_evidence_and_stale_persona_revision(tmp_path):
    engine, repo = await _repository(tmp_path)
    try:
        await repo.record_evidence(**SCOPE, event=_event())
        with pytest.raises(RelationshipConflictError):
            await repo.apply_persona_decision(**SCOPE, expected_evidence_version=0, expected_persona_revision=0, decision=_decision())
        await repo.apply_persona_decision(**SCOPE, expected_evidence_version=1, expected_persona_revision=0, decision=_decision())
        with pytest.raises(RelationshipConflictError):
            await repo.apply_persona_decision(**SCOPE, expected_evidence_version=1, expected_persona_revision=0, decision=_decision("decision-2"))
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_scope_isolation_and_restart_persistence(tmp_path):
    engine, repo = await _repository(tmp_path)
    try:
        await repo.record_evidence(**SCOPE, event=_event())
        await repo.apply_persona_decision(**SCOPE, expected_evidence_version=1, expected_persona_revision=0, decision=_decision())
        for changed in ({"creator_uid": "uid-2"}, {"account_id": "guild-account-2"}, {"owner_user_id": "operator-2"}):
            assert await repo.get(**{**SCOPE, **changed}) is None
    finally:
        await engine.dispose()
    reopened = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'relationships.db'}")
    try:
        second_repo = CreatorAgentRelationshipRepository(async_sessionmaker(reopened, expire_on_commit=False))
        saved = await second_repo.get(**SCOPE)
        assert saved["persona_revision"] == 1
        assert saved["persona_state"]["decision_id"] == "decision-1"
    finally:
        await reopened.dispose()


@pytest.mark.asyncio
async def test_decision_cannot_overwrite_relationship_facts_or_boundaries(tmp_path):
    engine, repo = await _repository(tmp_path)
    try:
        before = await repo.record_evidence(
            **SCOPE,
            event=_event(facts=["周五直播"], commitments=["周四再联系"], do_not_contact=True),
        )
        after = await repo.apply_persona_decision(**SCOPE, expected_evidence_version=1, expected_persona_revision=0, decision=_decision())
        for key in ("evidence", "facts", "commitments", "do_not_contact", "evidence_version"):
            assert after[key] == before[key]
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_rejects_unsourced_or_unbounded_decision(tmp_path):
    engine, repo = await _repository(tmp_path)
    try:
        await repo.record_evidence(**SCOPE, event=_event())
        with pytest.raises(ValueError):
            await repo.apply_persona_decision(
                **SCOPE,
                expected_evidence_version=1,
                expected_persona_revision=0,
                decision=_decision(evidence_refs=["creator:missing"]),
            )
        with pytest.raises(ValueError):
            await repo.apply_persona_decision(
                **SCOPE,
                expected_evidence_version=1,
                expected_persona_revision=0,
                decision=_decision(reason="x" * 1000),
            )
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_duplicate_evidence_does_not_advance_context_version(tmp_path):
    engine, repo = await _repository(tmp_path)
    try:
        first = await repo.record_evidence(**SCOPE, event=_event())
        second = await repo.record_evidence(**SCOPE, event=_event())
        assert second == first
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_stay_cannot_silently_change_persona(tmp_path):
    engine, repo = await _repository(tmp_path)
    try:
        await repo.record_evidence(**SCOPE, event=_event())
        with pytest.raises(ValueError):
            await repo.apply_persona_decision(
                **SCOPE,
                expected_evidence_version=1,
                expected_persona_revision=0,
                decision=_decision(action="stay", persona_ref="quiet_depth@1.0.1"),
            )
        assert (await repo.get(**SCOPE))["persona_state"] is None
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_switch_requires_creator_quote_and_threshold(tmp_path):
    engine, repo = await _repository(tmp_path)
    try:
        await repo.record_evidence(**SCOPE, event=_event())
        with pytest.raises(ValueError):
            await repo.apply_persona_decision(
                **SCOPE,
                expected_evidence_version=1,
                expected_persona_revision=0,
                decision=_decision(confidence=0.74),
            )
        assert (await repo.get(**SCOPE))["persona_revision"] == 0
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_decision_id_reuse_with_different_payload_is_rejected(tmp_path):
    engine, repo = await _repository(tmp_path)
    try:
        await repo.record_evidence(**SCOPE, event=_event())
        first = await repo.apply_persona_decision(**SCOPE, expected_evidence_version=1, expected_persona_revision=0, decision=_decision())
        with pytest.raises(ValueError):
            await repo.apply_persona_decision(
                **SCOPE,
                expected_evidence_version=1,
                expected_persona_revision=0,
                decision=_decision(reason="另一个理由"),
            )
        assert await repo.get(**SCOPE) == first
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_valid_multibyte_events_keep_advancing_within_byte_budget_and_preserve_no_contact(tmp_path):
    engine, repo = await _repository(tmp_path)
    try:
        for number in range(1, 8):
            saved = await repo.record_evidence(
                **SCOPE,
                event=_event(
                    event_id=f"message-{number}",
                    source_ref=f"creator:message-{number}",
                    text="请" * 512,
                    do_not_contact=number == 4,
                ),
            )
            assert saved["evidence_version"] == number
            assert saved["evidence"][-1]["source_ref"] == f"creator:message-{number}"
            assert len(json.dumps({key: saved[key] for key in ("evidence", "facts", "commitments")}, ensure_ascii=False).encode()) <= 6144
        assert saved["do_not_contact"] is True
        assert (await repo.get(**SCOPE))["do_not_contact"] is True
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_event_id_reuse_requires_identical_validated_payload_even_after_body_eviction(tmp_path):
    engine, repo = await _repository(tmp_path)
    try:
        original = _event(event_id="message-1", text="直接说", facts=["周五直播"])
        first = await repo.record_evidence(**SCOPE, event=original)
        assert await repo.record_evidence(**SCOPE, event={**original, "commitments": []}) == first
        with pytest.raises(ValueError, match="event_id"):
            await repo.record_evidence(**SCOPE, event={**original, "text": "别再联系", "do_not_contact": True})
        for number in range(2, 15):
            await repo.record_evidence(
                **SCOPE,
                event=_event(event_id=f"message-{number}", source_ref=f"creator:message-{number}"),
            )
        before = await repo.get(**SCOPE)
        assert all(item["event_id"] != "message-1" for item in before["evidence"])
        assert await repo.record_evidence(**SCOPE, event=original) == before
        with pytest.raises(ValueError, match="event_id"):
            await repo.record_evidence(**SCOPE, event={**original, "do_not_contact": True})
        assert await repo.get(**SCOPE) == before
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_simultaneous_evidence_writers_retain_both_updates(tmp_path):
    engine, repo = await _repository(tmp_path)
    try:
        await repo.record_evidence(**SCOPE, event=_event())
        barrier = asyncio.Barrier(2)

        async def write(number):
            await barrier.wait()
            return await repo.record_evidence(
                **SCOPE,
                event=_event(event_id=f"message-{number}", source_ref=f"creator:message-{number}"),
            )

        await asyncio.gather(write(2), write(3))
        saved = await repo.get(**SCOPE)
        assert saved["evidence_version"] == 3
        assert {item["event_id"] for item in saved["evidence"]} == {"message-1", "message-2", "message-3"}
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_simultaneous_persona_writers_have_one_cas_winner(tmp_path):
    engine, repo = await _repository(tmp_path)
    try:
        await repo.record_evidence(**SCOPE, event=_event())
        barrier = asyncio.Barrier(2)

        async def decide(number):
            await barrier.wait()
            try:
                return await repo.apply_persona_decision(
                    **SCOPE,
                    expected_evidence_version=1,
                    expected_persona_revision=0,
                    decision=_decision(decision_id=f"decision-{number}"),
                )
            except RelationshipConflictError as error:
                return error

        results = await asyncio.gather(decide(1), decide(2))
        assert sum(isinstance(item, RelationshipConflictError) for item in results) == 1
        saved = await repo.get(**SCOPE)
        assert saved["persona_revision"] == 1
        assert saved["persona_state"]["decision_id"] in {"decision-1", "decision-2"}
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_0025_migration_adds_and_removes_scoped_relationship_table(tmp_path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'migration.db'}")
    cfg = _get_alembic_config(engine)

    async def shape():
        async with engine.connect() as conn:
            return await conn.run_sync(
                lambda sync_conn: (
                    sa.inspect(sync_conn).has_table("creator_agent_relationship"),
                    {column["name"] for column in sa.inspect(sync_conn).get_columns("creator_agent_relationship")} if sa.inspect(sync_conn).has_table("creator_agent_relationship") else set(),
                    sa.inspect(sync_conn).get_pk_constraint("creator_agent_relationship").get("constrained_columns", []) if sa.inspect(sync_conn).has_table("creator_agent_relationship") else [],
                )
            )

    try:
        await asyncio.to_thread(command.upgrade, cfg, "0024_project_documents")
        assert (await shape())[0] is False
        await asyncio.to_thread(command.upgrade, cfg, "0025_creator_agent_relationship")
        exists, columns, primary_key = await shape()
        assert exists is True
        assert columns == {
            "owner_user_id",
            "account_id",
            "creator_uid",
            "evidence_version",
            "persona_revision",
            "evidence_json",
            "evidence_ids_json",
            "facts_json",
            "commitments_json",
            "do_not_contact",
            "persona_state_json",
            "decision_ids_json",
            "created_at",
            "updated_at",
        }
        assert primary_key == ["owner_user_id", "account_id", "creator_uid"]
        await asyncio.to_thread(command.downgrade, cfg, "0024_project_documents")
        assert (await shape())[0] is False
    finally:
        await engine.dispose()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "changed",
    [
        {"operator_id": "other-owner"},
        {"account_id": "other-account"},
        {"creator_uid": "other-creator"},
        {"persona_id": "quiet_depth"},
        {"persona_version": "9.9.9"},
        {"persona_revision": 2},
        {"evidence_version": 2},
        {"decision_policy_version": "other-policy"},
        {"effective_persona_fingerprint": "A" * 64},
        {"effective_persona_fingerprint": "a" * 63},
    ],
)
async def test_rejects_fingerprint_inputs_inconsistent_with_authoritative_decision(tmp_path, changed):
    engine, repo = await _repository(tmp_path)
    try:
        await repo.record_evidence(**SCOPE, event=_event())
        decision = _decision()
        decision["fingerprint_inputs"] = {**decision["fingerprint_inputs"], **changed}
        with pytest.raises(ValueError, match="fingerprint"):
            await repo.apply_persona_decision(**SCOPE, expected_evidence_version=1, expected_persona_revision=0, decision=decision)
        assert (await repo.get(**SCOPE))["persona_state"] is None
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_real_runtime_and_repository_share_one_effective_fingerprint(tmp_path):
    engine, repo = await _repository(tmp_path)
    try:
        focus = CreatorFocus(**SCOPE)
        await repo.record_evidence(**SCOPE, event=_event())

        class Model:
            async def ainvoke(self, messages, **kwargs):
                return type("Reply", (), {"content": '{"action":"switch","persona_id":"clear_direct","confidence":0.9,"evidence_refs":["creator:message-1"],"reason":"直接表达"}'})()

        runtime = CreatorAgentRuntime(repository=repo, selector=PersonaSelector(model=Model()))
        request_snapshot = await runtime.aresolve(focus)
        durable = await repo.get(**SCOPE)
        assert request_snapshot["persona_id"] == "clear_direct"
        assert durable["persona_state"]["effective_persona_fingerprint"] == request_snapshot["effective_persona_fingerprint"]
        assert (await runtime.aresolve(focus))["effective_persona_fingerprint"] == request_snapshot["effective_persona_fingerprint"]
    finally:
        await engine.dispose()
