"""Transactional native social persistence. No model calls or channel I/O."""

from __future__ import annotations

import hashlib
import json
import secrets
from contextlib import asynccontextmanager
from copy import deepcopy
from dataclasses import asdict, fields, replace
from datetime import UTC, datetime
from typing import Literal

import sqlalchemy as sa
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from deerflow.persistence.channel_connections.model import ChannelConnectionRow
from deerflow.persistence.creator_agent_relationship.model import CreatorAgentRelationshipRow
from deerflow.persistence.social.model import (
    BindingState,
    BoundaryUpdate,
    CommitResult,
    ExternalEvent,
    Outbound,
    OutboundClaim,
    PersonaEvaluationClaim,
    SelfMemoryChange,
    SocialConflictError,
    SocialConnectionGuard,
    SocialSnapshot,
    TurnAdjustment,
    social_event,
    social_outbound,
    social_persona_binding,
    social_persona_profile,
)
from deerflow.social.contracts import SocialScope, TurnResult, bounded_refs, bounded_text
from deerflow.social.persona.catalog import load_persona_catalog
from deerflow.social.persona.models import PersonaBindings, PersonaProfile, ProfileScope
from deerflow.social.persona.resolver import resolve_profile
from deerflow.utils.file_io import run_file_io


def _digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


def _account(table, scope):
    return (table.c.owner_user_id == scope.owner_user_id, table.c.account_id == scope.account_id)


def _profile_ref_query(scope, ref):
    """Registry identity is the serialized reference across the whole account.

    The account write lock serializes this read with inserts on both supported
    databases; tuple primary keys alone cannot protect legacy separator aliases.
    """
    return sa.select(social_persona_profile).where(*_account(social_persona_profile, scope), (social_persona_profile.c.profile_id + "@" + social_persona_profile.c.version) == ref)


def _event_scope(scope):
    return (*_account(social_event, scope), social_event.c.person_ref == scope.person_ref, social_event.c.channel_thread_ref == scope.channel_thread_ref, social_event.c.agent_instance_id == scope.agent_instance_id)


def _outbound_scope(scope):
    return (*_account(social_outbound, scope), social_outbound.c.relation_ref == scope.person_ref, social_outbound.c.channel_thread_ref == scope.channel_thread_ref, social_outbound.c.agent_instance_id == scope.agent_instance_id)


def _projection_key(scope):
    return _digest([scope.channel_thread_ref, scope.agent_instance_id])


def _scope_key(scope):
    return _digest([scope.agent_instance_id, scope.relation_ref])


def _check_revision(actual, expected, snapshot):
    if type(expected) is not int or expected < 0:
        raise ValueError("expected_revision must be nonnegative")
    if actual != expected:
        raise SocialConflictError(snapshot)


def _outbound(row):
    return Outbound(
        **{key: row[key] for key in ("action_id", "turn_revision", "persona_fingerprint", "reply_text", "state", "provider_ref", "revision")}, evidence_ids=tuple(row["evidence_ids_json"]), turn_context=deepcopy(row["turn_context_json"])
    )


async def _relationship(session, scope, *, create=False):
    row = await session.get(CreatorAgentRelationshipRow, (scope.owner_user_id, scope.account_id, scope.person_ref))
    if row is None and create:
        row = CreatorAgentRelationshipRow(owner_user_id=scope.owner_user_id, account_id=scope.account_id, creator_uid=scope.person_ref)
        session.add(row)
        await session.flush()
    return row


async def _restore(session, scope):
    row = await _relationship(session, scope)
    projection = deepcopy((row.social_snapshots_json or {}).get(_projection_key(scope), {})) if row else {}
    # Phase 0 only had a person-wide stop flag. Preserve that conservative
    # boundary without importing its untyped claims or guessing channel events.
    if row is not None and row.do_not_contact:
        projection["do_not_contact"] = True
    events = (await session.execute(sa.select(social_event.c.body_json).where(*_event_scope(scope)).order_by(social_event.c.created_at, social_event.c.source_event_id))).scalars().all()
    actions = (await session.execute(sa.select(social_outbound).where(*_outbound_scope(scope)).order_by(social_outbound.c.turn_revision))).mappings().all()
    if any(item["state"] == "unknown" for item in actions):
        projection["receipt_state"] = "unknown"
    for key in ("claims", "self_state", "commitments", "relationship", "boundary_history"):
        projection[key] = tuple(projection.get(key, ()))
    return SocialSnapshot(scope=scope, events=tuple(deepcopy(events)), outbound=tuple(_outbound(item) for item in actions), **projection)


async def _save(session, scope, projection):
    row = await _relationship(session, scope, create=True)
    row.social_snapshots_json = {**(row.social_snapshots_json or {}), _projection_key(scope): projection}
    row.updated_at = datetime.now(UTC)
    await session.flush()


def _projection(snapshot):
    return {field.name: deepcopy(getattr(snapshot, field.name)) for field in fields(snapshot) if field.name not in {"scope", "events", "outbound", "effective_persona"}}


def _evidence(snapshot, refs, *, additional_refs=()):
    if not set(refs) <= ({event["source_ref"] for event in snapshot.events} | set(additional_refs)):
        raise ValueError("evidence references must belong to this channel scope")


def _consent_event_refs(snapshot):
    """Return creator-authored event refs carrying host-typed consent."""
    refs = []
    for event in snapshot.events:
        consent = event.get("creator_consent")
        if event.get("source_kind") != "creator_message" or not isinstance(consent, dict):
            continue
        if consent.get("purpose") == "formal_invite" and consent.get("granted") is True and consent.get("source_ref") == event.get("source_ref"):
            refs.append(event["source_ref"])
    return tuple(refs)


def _patch(items, patch, *, id_key):
    items = deepcopy(list(items))
    identifier = patch[id_key]
    current = next((value for value in items if value[id_key] == identifier), None)
    if patch["op"] == "assert":
        value = {key: val for key, val in patch.items() if key != "op"}
        value["evidence_ids"] = list(value["evidence_ids"])
        value["status"] = "active"
        if current is not None:
            if current != value:
                raise ValueError("claim or memory id is immutable; retract and use a new id")
        else:
            items.append(value)
    else:
        if current is None:
            raise ValueError("cannot retract a missing claim or memory")
        if "category" in patch and current["category"] != patch["category"]:
            raise ValueError("cannot change memory category")
        if current["status"] == "retracted":
            if current["retraction_evidence_ids"] != list(patch["evidence_ids"]):
                raise ValueError("retraction evidence is immutable")
        else:
            current["status"] = "retracted"
            current["retraction_evidence_ids"] = list(patch["evidence_ids"])
    return items


class SocialRepository:
    def __init__(self, session_factory: async_sessionmaker[AsyncSession]):
        self.session_factory = session_factory

    async def _snapshot(self, session, scope):
        snapshot = await _restore(session, scope)
        profile_scope = ProfileScope(scope.owner_user_id, scope.account_id, scope.agent_instance_id, scope.person_ref)
        bindings = await self._bindings(session, profile_scope)
        profiles, _ = await self._profiles(session, profile_scope)
        persona = resolve_profile(catalog=await run_file_io(load_persona_catalog), profiles=profiles, bindings=bindings, evidence_version=snapshot.revision)
        return replace(snapshot, effective_persona=persona)

    @asynccontextmanager
    async def _read(self):
        async with self.session_factory.begin() as session:
            if session.get_bind().dialect.name == "sqlite":
                # Python SQLite legacy transaction control does not BEGIN on
                # SELECT. Without an explicit read transaction, the event query
                # can observe a newer revision than the relationship query.
                await session.execute(sa.text("BEGIN"))
            elif session.get_bind().dialect.name == "postgresql":
                await session.execute(sa.text("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ"))
            yield session

    @asynccontextmanager
    async def _write(self, scope):
        # Serialize before any read, including absent rows and NULL binding scopes.
        # SQLite's deferred BEGIN cannot safely upgrade two concurrent readers.
        async with self.session_factory.begin() as session:
            dialect = session.get_bind().dialect.name
            if dialect == "sqlite":
                await session.execute(sa.text("BEGIN IMMEDIATE"))
            elif dialect == "postgresql":
                key = int(_digest(["social", scope.owner_user_id, scope.account_id])[:16], 16)
                if key >= 2**63:
                    key -= 2**64
                await session.execute(sa.text("SELECT pg_advisory_xact_lock(:key)"), {"key": key})
                if isinstance(scope, SocialScope):
                    # Legacy DNC updates do not take the native advisory lock.
                    # Lock their exact row before any snapshot read; PostgreSQL
                    # UPDATE writers then serialize through the outbox commit.
                    # A valid creator turn already has this relationship row.
                    await session.execute(
                        sa.select(CreatorAgentRelationshipRow.owner_user_id)
                        .where(
                            CreatorAgentRelationshipRow.owner_user_id == scope.owner_user_id,
                            CreatorAgentRelationshipRow.account_id == scope.account_id,
                            CreatorAgentRelationshipRow.creator_uid == scope.person_ref,
                        )
                        .with_for_update()
                    )
            else:
                raise ValueError("social persistence supports SQLite and PostgreSQL")
            yield session

    async def restore(self, scope: SocialScope) -> SocialSnapshot:
        async with self._read() as session:
            return await self._snapshot(session, scope)

    async def is_turn_committed(self, scope: SocialScope, event_id: str) -> bool:
        async with self._read() as session:
            digest = (await session.execute(sa.select(social_event.c.turn_digest).where(*_event_scope(scope), social_event.c.source_event_id == event_id))).scalar_one_or_none()
            return digest is not None

    async def claim_persona_evaluation(self, scope: SocialScope, *, expected_revision: int, event_id: str, expected_binding_generation: int) -> PersonaEvaluationClaim | None:
        """Durably consume one creator-event attempt before calling a selector.

        No lease or retry: a crash leaves an attempted audit row. A later turn
        can proceed with the currently resolved persona, without calling again.
        """
        from deerflow.social.turns import contact_blocked

        async with self._write(scope) as session:
            snapshot = await self._snapshot(session, scope)
            _check_revision(snapshot.revision, expected_revision, snapshot)
            _check_revision(snapshot.effective_persona.binding_revision, expected_binding_generation, snapshot)
            event_where = (*_event_scope(scope), social_event.c.source_event_id == event_id)
            event = (await session.execute(sa.select(social_event).where(*event_where))).mappings().one_or_none()
            if event is None:
                raise ValueError("selector event does not belong to scope")
            if event["turn_digest"] is not None or event["source_kind"] != "creator_message" or contact_blocked(snapshot):
                return None
            if not snapshot.events or snapshot.events[-1]["source_event_id"] != event_id:
                raise SocialConflictError(snapshot)
            if (event["turn_context_json"] or {}).get("persona_evaluation") is not None:
                return None
            claim = PersonaEvaluationClaim(scope, event_id, expected_revision, expected_binding_generation, secrets.token_hex(24))
            audit = {"event_id": event_id, "evidence_version": expected_revision, "binding_generation": expected_binding_generation, "token": claim.token, "status": "attempted", "evidence_refs": [], "reason": ""}
            await session.execute(social_event.update().where(*event_where).values(turn_context_json={"persona_evaluation": audit}))
            await _save(session, scope, {**_projection(snapshot), "evaluated_persona_evidence_version": expected_revision, "persona_evaluation": audit})
            return claim

    async def finish_persona_evaluation(self, claim: PersonaEvaluationClaim, *, choice=None) -> SocialSnapshot:
        """Finish exactly the claimed evaluation, with evidence and binding CAS."""
        from deerflow.social.persona.selector import AutomaticPersonaChoice
        from deerflow.social.turns import contact_blocked

        if not isinstance(claim, PersonaEvaluationClaim) or (choice is not None and not isinstance(choice, AutomaticPersonaChoice)):
            raise ValueError("evaluation requires typed host inputs")
        scope = claim.scope
        async with self._write(scope) as session:
            snapshot = await self._snapshot(session, scope)
            _check_revision(snapshot.revision, claim.evidence_version, snapshot)
            _check_revision(snapshot.effective_persona.binding_revision, claim.binding_generation, snapshot)
            event_where = (*_event_scope(scope), social_event.c.source_event_id == claim.event_id)
            event = (await session.execute(sa.select(social_event).where(*event_where))).mappings().one_or_none()
            audit = (event["turn_context_json"] or {}).get("persona_evaluation") if event else None
            if (
                not audit
                or audit.get("token") != claim.token
                or audit.get("status") != "attempted"
                or audit.get("evidence_version") != claim.evidence_version
                or audit.get("binding_generation") != claim.binding_generation
                or contact_blocked(snapshot)
            ):
                raise SocialConflictError(snapshot)
            if choice is not None:
                _check_revision(choice.expected_evidence_version, claim.evidence_version, snapshot)
                _check_revision(choice.expected_binding_revision, claim.binding_generation, snapshot)
                bounded_refs(choice.evidence_refs, "evidence_refs", minimum=1, maximum=8)
                bounded_text(choice.reason, "reason", 512, allow_empty=True)
                if choice.profile_ref not in await run_file_io(load_persona_catalog) or type(choice.confidence) not in {int, float} or not 0.75 <= choice.confidence <= 1:
                    raise ValueError("invalid automatic persona choice")
                # The selector sees only this exact current creator-authored event.
                if event["source_kind"] != "creator_message" or set(choice.evidence_refs) != {event["body_json"]["source_ref"]}:
                    raise ValueError("selector evidence must identify the current creator event")
                profile_scope = ProfileScope(scope.owner_user_id, scope.account_id, scope.agent_instance_id, scope.person_ref)
                binding_state = await self._binding_state(session, profile_scope)
                if choice.profile_ref != snapshot.effective_persona.profile_ref:
                    await self._insert_binding(session, profile_scope, choice.profile_ref, expected_revision=binding_state.write_revision, reason=choice.reason or "automatic selection", evidence_ids=choice.evidence_refs)
            completed = {
                **audit,
                "status": "completed",
                "evidence_refs": list(choice.evidence_refs) if choice else [],
                "reason": choice.reason if choice else "stay_or_invalid",
                "profile_ref": choice.profile_ref if choice else snapshot.effective_persona.profile_ref,
            }
            await session.execute(social_event.update().where(*event_where).values(turn_context_json={"persona_evaluation": completed}))
            await _save(session, scope, {**_projection(snapshot), "persona_evaluation": completed})
            return await self._snapshot(session, scope)

    async def record_event(self, scope: SocialScope, event: ExternalEvent, *, expected_revision: int | None = None) -> SocialSnapshot:
        if not isinstance(event, ExternalEvent):
            raise ValueError("event must be an ExternalEvent")
        if event.creator_consent is not None:
            if event.source_kind != "creator_message" or event.creator_consent.source_ref != event.source_ref:
                raise ValueError("creator consent must belong to the creator event source")
        body = asdict(event)
        digest = _digest(body)
        async with self._write(scope) as session:
            snapshot = await self._snapshot(session, scope)
            existing = (await session.execute(sa.select(social_event).where(*_event_scope(scope), social_event.c.source_event_id == event.source_event_id))).mappings().one_or_none()
            if existing:
                if existing["payload_digest"] != digest:
                    raise ValueError("event ID reused with different payload")
                return snapshot
            if expected_revision is not None:
                _check_revision(snapshot.revision, expected_revision, snapshot)
            await session.execute(
                social_event.insert().values(
                    owner_user_id=scope.owner_user_id,
                    account_id=scope.account_id,
                    person_ref=scope.person_ref,
                    channel_thread_ref=scope.channel_thread_ref,
                    agent_instance_id=scope.agent_instance_id,
                    source_event_id=event.source_event_id,
                    payload_digest=digest,
                    source_kind=event.source_kind,
                    body_json=body,
                    created_at=datetime.now(UTC),
                )
            )
            await _save(session, scope, {**_projection(snapshot), "revision": snapshot.revision + 1})
            return await self._snapshot(session, scope)

    async def set_boundaries(self, scope: SocialScope, *, expected_revision: int, update: BoundaryUpdate) -> SocialSnapshot:
        """Host-authoritative mutation; callers must verify the evidence, never parse text into this DTO."""
        if not isinstance(update, BoundaryUpdate):
            raise ValueError("update must be BoundaryUpdate")
        async with self._write(scope) as session:
            snapshot = await self._snapshot(session, scope)
            _check_revision(snapshot.revision, expected_revision, snapshot)
            _evidence(snapshot, update.evidence_ids)
            value = asdict(update)
            history = [*snapshot.boundary_history, {**value, "status": "applied", "revision": expected_revision + 1}]
            await _save(session, scope, {**_projection(snapshot), **{key: value[key] for key in ("identity_verified", "human_takeover", "do_not_contact")}, "revision": expected_revision + 1, "boundary_history": history})
            return await self._snapshot(session, scope)

    async def advance_conversation_stage(self, scope: SocialScope, *, expected_revision: int, target_stage: str, evidence_ids: tuple[str, ...], reason: str) -> SocialSnapshot:
        """Advance the host-owned sales stage with CAS and provider evidence."""
        from deerflow.social.intelligence import ConversationStage

        try:
            target = ConversationStage(target_stage)
        except (TypeError, ValueError) as exc:
            raise ValueError("invalid conversation stage") from exc
        bounded_refs(evidence_ids, "evidence_ids", minimum=1, maximum=16)
        bounded_text(reason, "reason", 512)
        stages = (
            ConversationStage.first_contact,
            ConversationStage.rapport,
            ConversationStage.discovery,
            ConversationStage.value_fit,
            ConversationStage.objection_handling,
            ConversationStage.permission_to_invite,
            ConversationStage.formal_invite,
            ConversationStage.application,
            ConversationStage.signed,
        )
        order = {stage: index for index, stage in enumerate(stages)}
        async with self._write(scope) as session:
            snapshot = await self._snapshot(session, scope)
            _check_revision(snapshot.revision, expected_revision, snapshot)
            try:
                current = ConversationStage(snapshot.conversation_stage)
            except (TypeError, ValueError):
                current = ConversationStage.first_contact
            known_refs = {event["source_ref"] for event in snapshot.events}
            known_refs.update(ref for action in snapshot.outbound for ref in action.evidence_ids)
            if not set(evidence_ids) <= known_refs:
                raise ValueError("stage evidence must belong to this channel scope")
            if target == ConversationStage.formal_invite:
                if not set(evidence_ids) & set(_consent_event_refs(snapshot)):
                    if current == ConversationStage.first_contact:
                        raise ValueError("formal invitation requires verified consent evidence (typed creator consent)")
                    raise ValueError("formal sales stages require verified consent evidence")
            if target in {ConversationStage.application, ConversationStage.signed}:
                anchor_stage = ConversationStage.formal_invite if target == ConversationStage.application else ConversationStage.application
                anchors = [item for item in snapshot.boundary_history if item.get("conversation_stage") == anchor_stage.value]
                anchor_revision = anchors[-1].get("revision") if anchors else None
                receipt_refs = {ref for action in snapshot.outbound if action.state in {"accepted", "delivered"} and (anchor_revision is None or action.turn_revision > anchor_revision) for ref in action.evidence_ids}
                if snapshot.receipt_state not in {"accepted", "delivered"} or not set(evidence_ids) & receipt_refs:
                    raise ValueError("application and signing require an explicit receipt tied to the current stage")
            if current in {ConversationStage.paused, ConversationStage.human_takeover} and target != current:
                raise ValueError("paused or human takeover stages are terminal")
            if target not in {ConversationStage.paused, ConversationStage.human_takeover} and current in order and target in order:
                next_stage = tuple(order)[min(order[current] + 1, len(order) - 1)]
                if target not in {current, next_stage}:
                    raise ValueError("conversation stage transition is not monotonic")
            projection = _projection(snapshot)
            projection.update({"conversation_stage": target.value, "conversation_plan": None, "revision": expected_revision + 1})
            history = list(projection.get("boundary_history", ()))
            history.append({"conversation_stage": target.value, "evidence_ids": list(evidence_ids), "reason": reason, "revision": expected_revision + 1})
            projection["boundary_history"] = history
            await _save(session, scope, projection)
            return await self._snapshot(session, scope)

    async def mark_followup_schedule_failure(self, scope: SocialScope, *, expected_revision: int, error: str) -> SocialSnapshot:
        """Persist a retry marker after a turn commit outruns task enqueue.

        Social turns and the generic scheduled-task repository intentionally
        use separate native transactions.  If enqueue fails after the social
        commit, the followup intent is still durable in ``followup``; this
        marker lets a host reconciliation loop distinguish it from an
        intentionally unscheduled turn without exposing provider details.
        """
        bounded_text(error, "error", 512)
        async with self._write(scope) as session:
            snapshot = await self._snapshot(session, scope)
            _check_revision(snapshot.revision, expected_revision, snapshot)
            if snapshot.followup is None:
                return snapshot
            projection = _projection(snapshot)
            projection.update({"followup_schedule_error": error, "revision": expected_revision + 1})
            await _save(session, scope, projection)
            return await self._snapshot(session, scope)

    async def clear_followup_schedule_failure(self, scope: SocialScope, *, expected_revision: int) -> SocialSnapshot:
        """Clear a reconciled followup marker with the same CAS discipline."""
        async with self._write(scope) as session:
            snapshot = await self._snapshot(session, scope)
            _check_revision(snapshot.revision, expected_revision, snapshot)
            if snapshot.followup_schedule_error is None:
                return snapshot
            projection = _projection(snapshot)
            projection.update({"followup_schedule_error": None, "revision": expected_revision + 1})
            await _save(session, scope, projection)
            return await self._snapshot(session, scope)

    async def commit_turn(
        self,
        scope: SocialScope,
        *,
        expected_revision: int,
        event_id: str,
        result: TurnResult,
        persona_fingerprint: str,
        memory_changes: tuple[SelfMemoryChange, ...] = (),
        turn_adjustment: TurnAdjustment | None = None,
        enforce_contact_boundaries: bool = False,
        conversation_plan: dict | None = None,
        creator_evidence_refs: tuple[str, ...] = (),
    ) -> CommitResult:
        if not isinstance(result, TurnResult):
            raise ValueError("result must be TurnResult")
        if not isinstance(memory_changes, tuple) or len(memory_changes) > 16 or any(not isinstance(item, SelfMemoryChange) for item in memory_changes):
            raise ValueError("memory_changes must be bounded host-owned SelfMemoryChange values")
        if len({item.memory_id for item in memory_changes}) != len(memory_changes):
            raise ValueError("duplicate memory ids")
        if len(persona_fingerprint) != 64 or any(c not in "0123456789abcdef" for c in persona_fingerprint):
            raise ValueError("persona_fingerprint must be a SHA-256 digest")
        if turn_adjustment is not None and not isinstance(turn_adjustment, TurnAdjustment):
            raise ValueError("turn_adjustment must be a host-owned TurnAdjustment")
        if not isinstance(creator_evidence_refs, tuple) or len(creator_evidence_refs) > 128:
            raise ValueError("creator_evidence_refs must be a bounded tuple")
        bounded_refs(creator_evidence_refs, "creator_evidence_refs", maximum=128)
        if conversation_plan is not None:
            from deerflow.social.intelligence import ConversationPlan

            if not isinstance(conversation_plan, dict):
                raise ValueError("conversation_plan must be a host-owned JSON projection")
            try:
                validated_plan = ConversationPlan.from_payload(conversation_plan)
            except (TypeError, ValueError) as exc:
                raise ValueError("conversation_plan failed validation") from exc
            conversation_plan = validated_plan.to_payload()
        adjustment_payload = turn_adjustment.to_payload() if turn_adjustment else None
        digest = _digest(
            {
                "result": asdict(result),
                "memory_changes": [asdict(item) for item in memory_changes],
                "persona_fingerprint": persona_fingerprint,
                "turn_adjustment": adjustment_payload,
                "conversation_plan": deepcopy(conversation_plan),
                "creator_evidence_refs": list(creator_evidence_refs),
            }
        )
        async with self._write(scope) as session:
            snapshot = await self._snapshot(session, scope)
            event_where = (*_event_scope(scope), social_event.c.source_event_id == event_id)
            if enforce_contact_boundaries:
                from deerflow.social.turns import contact_blocked

                if result.reply is not None and contact_blocked(snapshot):
                    raise SocialConflictError(snapshot)
            event = (await session.execute(sa.select(social_event).where(*event_where))).mappings().one_or_none()
            if event is None:
                raise ValueError("turn event does not exist in this scope")
            if event["turn_digest"] is not None:
                if event["turn_digest"] != digest:
                    raise SocialConflictError(snapshot)
                return CommitResult(snapshot, next((item for item in snapshot.outbound if item.action_id == event["action_id"]), None))
            _check_revision(snapshot.revision, expected_revision, snapshot)
            if conversation_plan is not None:
                if conversation_plan["stage"] != snapshot.conversation_stage:
                    raise ValueError("conversation_plan stage does not match the current funnel stage")
                if conversation_plan["snapshot_revision"] != snapshot.revision:
                    raise ValueError("conversation_plan revision does not match the current snapshot")
            profile_scope = ProfileScope(scope.owner_user_id, scope.account_id, scope.agent_instance_id, scope.person_ref)
            bindings = await self._bindings(session, profile_scope)
            authoritative_persona = snapshot.effective_persona
            if turn_adjustment:
                _evidence(snapshot, turn_adjustment.evidence_ids)
                profiles, _ = await self._profiles(session, profile_scope)
                authoritative_persona = resolve_profile(catalog=await run_file_io(load_persona_catalog), profiles=profiles, bindings=bindings, evidence_version=snapshot.revision, turn_adjustment=turn_adjustment.values)
            if authoritative_persona.fingerprint != persona_fingerprint:
                raise SocialConflictError(snapshot)
            turn_context = {"bindings": {**asdict(bindings), "effective_at": bindings.effective_at.isoformat()}, "evidence_version": snapshot.revision, "adjustment": adjustment_payload}
            event_context = {**(event["turn_context_json"] or {}), **turn_context}
            projection = _projection(snapshot)
            for patch in result.state_delta:
                _evidence(snapshot, patch.evidence_ids, additional_refs=creator_evidence_refs)
                projection["claims"] = _patch(projection["claims"], asdict(patch), id_key="claim_id")
            for change in memory_changes:
                _evidence(snapshot, change.evidence_ids, additional_refs=creator_evidence_refs)
                section = "self_state" if change.category.startswith("self_") else "commitments" if change.category == "commitment" else "relationship"
                projection[section] = _patch(projection[section], asdict(change), id_key="memory_id")
            projection["revision"] = expected_revision + 1
            projection["followup"] = asdict(result.followup) if result.followup else None
            if conversation_plan is not None:
                projection["conversation_plan"] = deepcopy(conversation_plan)
            action_id = None
            if result.reply is not None:
                action_id = _digest([scope.owner_user_id, scope.account_id, scope.person_ref, scope.channel_thread_ref, scope.agent_instance_id, event_id])
                now = datetime.now(UTC)
                await session.execute(
                    social_outbound.insert().values(
                        owner_user_id=scope.owner_user_id,
                        account_id=scope.account_id,
                        relation_ref=scope.person_ref,
                        channel_thread_ref=scope.channel_thread_ref,
                        agent_instance_id=scope.agent_instance_id,
                        action_id=action_id,
                        turn_revision=expected_revision + 1,
                        persona_fingerprint=persona_fingerprint,
                        reply_text=result.reply,
                        state="pending",
                        provider_ref=None,
                        revision=0,
                        evidence_ids_json=[event["body_json"]["source_ref"]],
                        history_json=[],
                        turn_context_json=turn_context,
                        created_at=now,
                        updated_at=now,
                    )
                )
            await session.execute(social_event.update().where(*event_where).values(turn_digest=digest, action_id=action_id, turn_context_json=event_context))
            await _save(session, scope, projection)
            saved = await self._snapshot(session, scope)
            return CommitResult(saved, next((item for item in saved.outbound if item.action_id == action_id), None))

    async def _profiles(self, session, scope):
        rows = (await session.execute(sa.select(social_persona_profile).where(*_account(social_persona_profile, scope)).order_by(social_persona_profile.c.revision))).mappings().all()
        refs = [f"{row['profile_id']}@{row['version']}" for row in rows]
        if len(refs) != len(set(refs)):
            raise ValueError("duplicate serialized profile reference in account registry")
        profiles = {}
        for row in rows:
            value = deepcopy(row["profile_json"])
            origin = value.pop("management_scope", None)
            if origin and any(origin[key] is not None and origin[key] != getattr(scope, key) for key in ("agent_instance_id", "relation_ref")):
                continue
            value["basis_refs"] = tuple(value["basis_refs"])
            if "interests" in value["overrides"]:
                value["overrides"]["interests"] = tuple(value["overrides"]["interests"])
            profiles[f"{row['profile_id']}@{row['version']}"] = PersonaProfile(**value)
        return profiles, rows[-1]["revision"] if rows else 0

    async def get_profiles(self, scope: ProfileScope) -> dict[str, PersonaProfile]:
        async with self._read() as session:
            return (await self._profiles(session, scope))[0]

    async def management_view(self, scope: ProfileScope):
        """One snapshot for listing, previews and deterministic resolution."""
        async with self._read() as session:
            profiles, revision = await self._profiles(session, scope)
            return profiles, revision, await self._binding_state(session, scope)

    async def management_basis(self, scope: ProfileScope, refs: tuple[str, ...]):
        """Exact optional dimensions; never broaden a missing agent/relation."""
        bounded_refs(refs, "basis_refs", minimum=1, maximum=8)
        async with self._read() as session:
            return await self._management_basis(session, scope, refs)

    async def record_management_note(self, scope, *, thread_id, message_id, text, expected_revision):
        """Idempotent admitted Chat provenance; never a creator event/projection."""
        bounded_text(thread_id, "thread_id", 128)
        bounded_text(message_id, "message_id", 128)
        bounded_text(text, "requirement", 1024)
        event_id = _digest([asdict(scope), thread_id, message_id])
        source_ref = "chat:" + event_id
        body = {"source_event_id": event_id, "source_ref": source_ref, "source_kind": "operator_note", "text": text, "management_scope": asdict(scope), "chat_thread_ref": thread_id, "source_message_id": message_id}
        key = dict(
            owner_user_id=scope.owner_user_id,
            account_id=scope.account_id,
            person_ref=scope.relation_ref or "__management__",
            channel_thread_ref="management:" + _digest(thread_id),
            agent_instance_id=scope.agent_instance_id or "__management__",
            source_event_id=event_id,
        )
        async with self._write(scope) as session:
            _, revision = await self._profiles(session, scope)
            _check_revision(revision, expected_revision, {"revision": revision})
            existing = (await session.execute(sa.select(social_event.c.body_json).where(*(social_event.c[name] == value for name, value in key.items())))).scalar_one_or_none()
            if existing is not None:
                if existing != body:
                    raise ValueError("management message id content conflict")
            else:
                await session.execute(social_event.insert().values(**key, body_json=body, source_kind="operator_note", payload_digest=_digest(body), created_at=datetime.now(UTC)))
        return source_ref

    async def _management_basis(self, session, scope, refs):
        bodies = (
            (
                await session.execute(
                    sa.select(social_event.c.body_json).where(
                        *_account(social_event, scope),
                        social_event.c.person_ref == (scope.relation_ref or "__management__"),
                        social_event.c.agent_instance_id == (scope.agent_instance_id or "__management__"),
                    )
                )
            )
            .scalars()
            .all()
        )
        by_ref = {}
        for body in bodies:
            origin = body.get("management_scope")
            # Optional dimensions are not string sentinels: preserve their
            # exact typed scope so a literal reserved name cannot alias None.
            if (origin is not None or scope.agent_instance_id is None or scope.relation_ref is None) and origin != asdict(scope):
                continue
            if body["source_ref"] in refs:
                if body["source_ref"] in by_ref and by_ref[body["source_ref"]] != body:
                    raise ValueError("ambiguous scoped basis reference")
                by_ref[body["source_ref"]] = body
        if set(refs) != set(by_ref):
            raise ValueError("generation basis must belong to exact scope")
        return tuple(by_ref[ref] for ref in refs)

    async def manage_profile(self, scope, *, candidate=None, expected_registry_revision=None, profile_ref=None, expected_revision=None, reason, activate=True, rollback_revision=None):
        """Register a candidate and optionally bind in ONE account transaction.

        Management provenance is stored alongside the immutable profile JSON;
        historical rows without this optional metadata remain compatible.
        """
        if candidate is not None:
            if not isinstance(candidate, PersonaProfile):
                raise ValueError("candidate must be PersonaProfile")
            candidate = replace(candidate)  # Revalidate even if a caller bypassed the frozen constructor.
        bounded_text(reason, "reason", 512)
        if type(activate) is not bool:
            raise ValueError("activation intent must be boolean")
        if not activate and candidate is None:
            raise ValueError("candidate is required")
        async with self._write(scope) as session:
            before = await self._binding_state(session, scope)
            profiles, registry_revision = await self._profiles(session, scope)
            if activate:
                _check_revision(before.write_revision, expected_revision, before)
            if candidate is not None:
                _check_revision(registry_revision, expected_registry_revision, {"revision": registry_revision})
                profile_ref = f"{candidate.profile_id}@{candidate.version}"
                bounded_text(profile_ref, "profile_ref", 128)
                catalog = await run_file_io(load_persona_catalog)
                if candidate.base_template_ref not in catalog or profile_ref in catalog:
                    raise ValueError("profile must extend a canonical template")
                await self._management_basis(session, scope, candidate.basis_refs)
                row = (await session.execute(_profile_ref_query(scope, profile_ref))).mappings().one_or_none()
                if row is not None:
                    if (row["profile_id"], row["version"]) != (candidate.profile_id, candidate.version) or profiles.get(profile_ref) != candidate or row["profile_json"].get("management_scope") != asdict(scope):
                        raise ValueError("profile versions and provenance are immutable")
                else:
                    value = {
                        "profile_id": candidate.profile_id,
                        "version": candidate.version,
                        "base_template_ref": candidate.base_template_ref,
                        "overrides": dict(candidate.overrides),
                        "created_by": candidate.created_by,
                        "basis_refs": list(candidate.basis_refs),
                        "management_scope": asdict(scope),
                    }
                    registry_revision += 1
                    await session.execute(
                        social_persona_profile.insert().values(
                            owner_user_id=scope.owner_user_id,
                            account_id=scope.account_id,
                            profile_id=candidate.profile_id,
                            version=candidate.version,
                            revision=registry_revision,
                            profile_json=value,
                            basis_refs_json=list(candidate.basis_refs),
                            status="candidate",
                            created_at=datetime.now(UTC),
                        )
                    )
                    profiles[profile_ref] = candidate
            if rollback_revision is not None:
                if type(rollback_revision) is not int or rollback_revision < 1:
                    raise ValueError("rollback target must be a persisted revision")
                historic = (
                    (await session.execute(sa.select(social_persona_binding).where(*_account(social_persona_binding, scope), social_persona_binding.c.scope_key == _scope_key(scope), social_persona_binding.c.revision == rollback_revision)))
                    .mappings()
                    .one_or_none()
                )
                if historic is None:
                    raise ValueError("no binding history at target scope/revision")
                profile_ref = historic["profile_ref"]
                reason = f"rollback:{rollback_revision}: {reason}"
                bounded_text(reason, "reason", 512)
            if activate:
                if profile_ref is None and scope.agent_instance_id is None and scope.relation_ref is None:
                    raise ValueError("account default cannot be cleared")
                if profile_ref is not None and profile_ref not in profiles and profile_ref not in await run_file_io(load_persona_catalog):
                    raise ValueError("unknown or cross-scope profile reference")
                await self._insert_binding(session, scope, profile_ref, expected_revision=expected_revision, reason=reason, evidence_ids=candidate.basis_refs if candidate else ())
            after = await self._binding_state(session, scope)

            def effective(state):
                binding = state.bindings
                return binding.relation_override_ref or binding.agent_override_ref or binding.account_default_ref

            return {
                "scope": asdict(scope),
                "old_profile_ref": effective(before),
                "new_profile_ref": effective(after) if activate else profile_ref,
                "write_revision": after.write_revision,
                "effective_revision": after.bindings.revision,
                "registry_revision": registry_revision,
                "effective_at": after.bindings.effective_at.isoformat() if activate else None,
                "status": "active" if activate else "candidate",
                "reason": reason,
                "rollback_of_revision": rollback_revision,
            }

    async def register_profile(self, scope: ProfileScope, candidate: PersonaProfile, *, expected_revision: int) -> PersonaProfile:
        if not isinstance(candidate, PersonaProfile):
            raise ValueError("candidate must be PersonaProfile")
        candidate = replace(candidate)
        async with self._write(scope) as session:
            profiles, revision = await self._profiles(session, scope)
            ref = f"{candidate.profile_id}@{candidate.version}"
            bounded_text(ref, "profile_ref", 128)
            row = (await session.execute(_profile_ref_query(scope, ref))).mappings().one_or_none()
            if row is not None:
                if (row["profile_id"], row["version"]) != (candidate.profile_id, candidate.version) or profiles.get(ref) != candidate:
                    raise ValueError("profile versions are immutable")
                return profiles[ref]
            _check_revision(revision, expected_revision, {"revision": revision, "profiles": profiles})
            catalog = await run_file_io(load_persona_catalog)
            if candidate.base_template_ref not in catalog or ref in catalog:
                raise ValueError("profile must extend a canonical template without replacing it")
            if candidate.basis_refs:
                predicates = list(_account(social_event, scope))
                if scope.relation_ref:
                    predicates.append(social_event.c.person_ref == scope.relation_ref)
                if scope.agent_instance_id:
                    predicates.append(social_event.c.agent_instance_id == scope.agent_instance_id)
                bodies = (await session.execute(sa.select(social_event.c.body_json).where(*predicates))).scalars().all()
                if not set(candidate.basis_refs) <= {body["source_ref"] for body in bodies}:
                    raise ValueError("profile evidence must belong to its scope")
            value = {
                "profile_id": candidate.profile_id,
                "version": candidate.version,
                "base_template_ref": candidate.base_template_ref,
                "overrides": dict(candidate.overrides),
                "created_by": candidate.created_by,
                "basis_refs": list(candidate.basis_refs),
            }
            await session.execute(
                social_persona_profile.insert().values(
                    owner_user_id=scope.owner_user_id,
                    account_id=scope.account_id,
                    profile_id=candidate.profile_id,
                    version=candidate.version,
                    revision=revision + 1,
                    profile_json=value,
                    basis_refs_json=list(candidate.basis_refs),
                    status="registered",
                    created_at=datetime.now(UTC),
                )
            )
            return candidate

    async def _binding_row(self, session, scope):
        return (
            (await session.execute(sa.select(social_persona_binding).where(*_account(social_persona_binding, scope), social_persona_binding.c.scope_key == _scope_key(scope)).order_by(social_persona_binding.c.revision.desc()).limit(1)))
            .mappings()
            .one_or_none()
        )

    async def _binding_state(self, session, scope):
        account = await self._binding_row(session, ProfileScope(scope.owner_user_id, scope.account_id))
        agent = await self._binding_row(session, ProfileScope(scope.owner_user_id, scope.account_id, scope.agent_instance_id)) if scope.agent_instance_id else None
        relation = await self._binding_row(session, scope) if scope.relation_ref else None
        target = relation if scope.relation_ref else agent if scope.agent_instance_id else account
        rows = [row for row in (account, agent, relation) if row is not None]
        # Every contributing update, including clear tombstones, advances this
        # resolution fence. Scope-local revisions alone allow cross-scope ABA.
        latest = max(rows, key=lambda row: row["generation"]) if rows else None
        source = next((row for row in (relation, agent, account) if row is not None and row["profile_ref"] is not None), None)

        def aware(value):
            return value if value.tzinfo is not None else value.replace(tzinfo=UTC)

        bindings = PersonaBindings(
            scope,
            account["profile_ref"] if account else "relaxed_wit@1.0.1",
            agent["profile_ref"] if agent else None,
            relation["profile_ref"] if relation else None,
            latest["generation"] if latest else 1,
            aware(latest["effective_at"]) if latest else datetime(1970, 1, 1, tzinfo=UTC),
        )
        return BindingState(
            target["revision"] if target else 0,
            bindings,
            ProfileScope(scope.owner_user_id, scope.account_id, source["agent_instance_id"], source["relation_ref"]) if source else None,
            source["revision"] if source else 0,
            aware(source["effective_at"]) if source else None,
        )

    async def _bindings(self, session, scope):
        return (await self._binding_state(session, scope)).bindings

    async def get_bindings(self, scope: ProfileScope) -> PersonaBindings:
        """An unregistered scope resolves the canonical default; writes expect revision 0."""
        async with self._read() as session:
            return await self._bindings(session, scope)

    async def get_binding_state(self, scope: ProfileScope) -> BindingState:
        async with self._read() as session:
            return await self._binding_state(session, scope)

    async def update_binding(
        self, scope: ProfileScope, profile_ref: str | None, *, expected_revision: int, reason: str, mode: Literal["administrative", "automatic"] = "administrative", evidence_ids: tuple[str, ...] = ()
    ) -> PersonaBindings:
        bounded_text(reason, "reason", 512)
        bounded_refs(evidence_ids, "evidence_ids")
        if mode not in {"administrative", "automatic"}:
            raise ValueError("invalid binding mode")
        if profile_ref is None and scope.agent_instance_id is None and scope.relation_ref is None:
            raise ValueError("account default cannot be cleared")
        async with self._write(scope) as session:
            row = await self._binding_row(session, scope)
            bindings = await self._bindings(session, scope)
            _check_revision(row["revision"] if row else 0, expected_revision, bindings)
            if profile_ref is not None:
                profiles, _ = await self._profiles(session, scope)
                if profile_ref not in await run_file_io(load_persona_catalog) and profile_ref not in profiles:
                    raise ValueError("unknown profile reference")
            effective = bindings.relation_override_ref or bindings.agent_override_ref or bindings.account_default_ref
            if mode == "automatic" and profile_ref == effective:
                return bindings
            if mode == "automatic" and not evidence_ids:
                raise ValueError("automatic changes require scoped evidence")
            if evidence_ids:
                predicates = list(_account(social_event, scope))
                if scope.relation_ref:
                    predicates.append(social_event.c.person_ref == scope.relation_ref)
                if scope.agent_instance_id:
                    predicates.append(social_event.c.agent_instance_id == scope.agent_instance_id)
                bodies = (await session.execute(sa.select(social_event.c.body_json).where(*predicates))).scalars().all()
                if not set(evidence_ids) <= {body["source_ref"] for body in bodies}:
                    raise ValueError("binding evidence must belong to its scope")
            await self._insert_binding(session, scope, profile_ref, expected_revision=expected_revision, reason=reason, evidence_ids=evidence_ids)
            return await self._bindings(session, scope)

    async def _insert_binding(self, session, scope, profile_ref, *, expected_revision, reason, evidence_ids):
        generation = (await session.execute(sa.select(sa.func.max(social_persona_binding.c.generation)).where(*_account(social_persona_binding, scope)))).scalar_one_or_none() or 1
        await session.execute(
            social_persona_binding.insert().values(
                owner_user_id=scope.owner_user_id,
                account_id=scope.account_id,
                scope_key=_scope_key(scope),
                agent_instance_id=scope.agent_instance_id,
                relation_ref=scope.relation_ref,
                revision=expected_revision + 1,
                generation=generation + 1,
                profile_ref=profile_ref,
                reason=reason,
                evidence_refs_json=list(evidence_ids),
                status="applied",
                effective_at=datetime.now(UTC),
            )
        )

    async def _action(self, session, scope, action_id):
        row = (await session.execute(sa.select(social_outbound).where(*_outbound_scope(scope), social_outbound.c.action_id == action_id))).mappings().one_or_none()
        if row is None:
            raise ValueError("outbound action does not exist in this scope")
        return row

    async def get_turn_outbound(self, scope: SocialScope, event_id: str) -> Outbound | None:
        """Resolve only the committed action belonging to this exact sourced turn."""
        async with self._read() as session:
            row = (await session.execute(sa.select(social_event).where(*_event_scope(scope), social_event.c.source_event_id == event_id))).mappings().one_or_none()
            if row is None or row["turn_digest"] is None or row["action_id"] is None:
                return None
            return _outbound(await self._action(session, scope, row["action_id"]))

    async def _validate_connection_guard(self, session, scope, guard):
        if guard.owner_user_id != scope.owner_user_id:
            raise ValueError("send connection owner does not match social scope")
        query = sa.select(ChannelConnectionRow).where(ChannelConnectionRow.id == guard.connection_id)
        if session.get_bind().dialect.name == "postgresql":
            query = query.with_for_update()
        # SQLite's enclosing BEGIN IMMEDIATE already serializes UPDATE writers.
        # PostgreSQL must lock this exact connection, not just the social rows:
        # disconnect/transfer UPDATEs do not acquire the social advisory lock.
        connection = (await session.execute(query)).scalar_one_or_none()
        if connection is None or connection.status != "connected" or any(getattr(connection, name) != getattr(guard, name) for name in ("owner_user_id", "provider", "external_account_id", "workspace_id")):
            raise ValueError("send connection is no longer authorized")

    async def claim_outbound(self, scope: SocialScope, action_id: str, *, expected_revision: int, event_id: str | None = None, persona_fingerprint: str | None = None, connection_guard: SocialConnectionGuard | None = None) -> OutboundClaim:
        if (event_id is None) != (persona_fingerprint is None):
            raise ValueError("send claim requires event and persona fingerprint together")
        if connection_guard is not None and (not isinstance(connection_guard, SocialConnectionGuard) or event_id is None):
            raise ValueError("send connection guard requires a typed host identity and event")
        async with self._write(scope) as session:
            if connection_guard is not None:
                await self._validate_connection_guard(session, scope, connection_guard)
            row = await self._action(session, scope, action_id)
            if row["state"] != "pending":
                return OutboundClaim(_outbound(row), False)
            snapshot = await self._snapshot(session, scope)
            _check_revision(row["revision"], expected_revision, snapshot)
            if event_id is not None:
                from deerflow.social.turns import contact_blocked

                event = (await session.execute(sa.select(social_event).where(*_event_scope(scope), social_event.c.source_event_id == event_id))).mappings().one_or_none()
                if event is None or event["turn_digest"] is None or event["action_id"] != action_id or event["source_kind"] != "creator_message":
                    raise ValueError("send claim requires the exact committed creator event")
                if contact_blocked(snapshot) or row["persona_fingerprint"] != persona_fingerprint or snapshot.revision != row["turn_revision"]:
                    raise SocialConflictError(snapshot)
                profile_scope = ProfileScope(scope.owner_user_id, scope.account_id, scope.agent_instance_id, scope.person_ref)
                bindings = await self._bindings(session, profile_scope)
                profiles, _ = await self._profiles(session, profile_scope)
                context = row["turn_context_json"]
                adjustment = context.get("adjustment")
                # The committed evidence version is immutable; outbox bookkeeping
                # advances snapshot revision but must not invalidate its own turn.
                current = resolve_profile(catalog=await run_file_io(load_persona_catalog), profiles=profiles, bindings=bindings, evidence_version=context["evidence_version"], turn_adjustment=adjustment["values"] if adjustment else None)
                if current.fingerprint != persona_fingerprint:
                    raise SocialConflictError(snapshot)
            await session.execute(
                social_outbound.update()
                .where(*_outbound_scope(scope), social_outbound.c.action_id == action_id, social_outbound.c.revision == expected_revision)
                .values(state="unknown", revision=expected_revision + 1, updated_at=datetime.now(UTC), history_json=[*row["history_json"], {"state": "unknown", "status": "claimed", "evidence_ids": row["evidence_ids_json"]}])
            )
            await _save(session, scope, {**_projection(snapshot), "revision": snapshot.revision + 1, "receipt_state": "unknown"})
            return OutboundClaim(_outbound(await self._action(session, scope, action_id)), True)

    async def record_outbound_result(self, scope: SocialScope, action_id: str, *, expected_revision: int, state: str, provider_ref: str | None, evidence_ids: tuple[str, ...]) -> Outbound:
        bounded_refs(evidence_ids, "evidence_ids", minimum=1)
        if state not in {"accepted", "delivered", "unknown", "failed"}:
            raise ValueError("invalid outbound result state")
        if provider_ref is not None:
            bounded_text(provider_ref, "provider_ref", 128)
        if state in {"accepted", "delivered"} and provider_ref is None:
            raise ValueError("provider evidence is required for confirmed result")
        async with self._write(scope) as session:
            row = await self._action(session, scope, action_id)
            if row["state"] == state and row["provider_ref"] == provider_ref and row["evidence_ids_json"] == list(evidence_ids):
                return _outbound(row)
            snapshot = await self._snapshot(session, scope)
            _check_revision(row["revision"], expected_revision, snapshot)
            allowed = {"pending": {"failed"}, "unknown": {"unknown", "accepted", "delivered", "failed"}, "accepted": {"delivered", "unknown", "failed"}, "delivered": set(), "failed": set()}
            if state not in allowed[row["state"]]:
                raise ValueError("invalid outbound state transition")
            if row["provider_ref"] is not None and provider_ref != row["provider_ref"]:
                raise ValueError("provider reference cannot change")
            await session.execute(
                social_outbound.update()
                .where(*_outbound_scope(scope), social_outbound.c.action_id == action_id, social_outbound.c.revision == expected_revision)
                .values(
                    state=state,
                    provider_ref=provider_ref,
                    revision=expected_revision + 1,
                    evidence_ids_json=list(evidence_ids),
                    history_json=[*row["history_json"], {"state": state, "status": "recorded", "evidence_ids": list(evidence_ids)}],
                    updated_at=datetime.now(UTC),
                )
            )
            await _save(session, scope, {**_projection(snapshot), "revision": snapshot.revision + 1, "receipt_state": state})
            return _outbound(await self._action(session, scope, action_id))
