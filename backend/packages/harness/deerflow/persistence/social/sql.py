"""Transactional native social persistence. No model calls or channel I/O."""

from __future__ import annotations

import hashlib
import json
from contextlib import asynccontextmanager
from copy import deepcopy
from dataclasses import asdict
from datetime import UTC, datetime
from typing import Literal

import sqlalchemy as sa
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from deerflow.persistence.creator_agent_relationship.model import CreatorAgentRelationshipRow
from deerflow.persistence.social.model import (
    BindingState,
    BoundaryUpdate,
    CommitResult,
    ExternalEvent,
    Outbound,
    OutboundClaim,
    SelfMemoryChange,
    SocialConflictError,
    SocialSnapshot,
    social_event,
    social_outbound,
    social_persona_binding,
    social_persona_profile,
)
from deerflow.social.contracts import SocialScope, TurnResult, bounded_refs, bounded_text
from deerflow.social.persona.catalog import load_persona_catalog
from deerflow.social.persona.models import PersonaBindings, PersonaProfile, ProfileScope


def _digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


def _account(table, scope):
    return (table.c.owner_user_id == scope.owner_user_id, table.c.account_id == scope.account_id)


def _event_scope(scope):
    return (*_account(social_event, scope), social_event.c.person_ref == scope.person_ref, social_event.c.channel_thread_ref == scope.channel_thread_ref)


def _outbound_scope(scope):
    return (*_account(social_outbound, scope), social_outbound.c.relation_ref == scope.person_ref, social_outbound.c.channel_thread_ref == scope.channel_thread_ref)


def _scope_key(scope):
    return _digest([scope.agent_instance_id, scope.relation_ref])


def _check_revision(actual, expected, snapshot):
    if type(expected) is not int or expected < 0:
        raise ValueError("expected_revision must be nonnegative")
    if actual != expected:
        raise SocialConflictError(snapshot)


def _outbound(row):
    return Outbound(**{key: row[key] for key in ("action_id", "turn_revision", "persona_fingerprint", "reply_text", "state", "provider_ref", "revision")}, evidence_ids=tuple(row["evidence_ids_json"]))


async def _relationship(session, scope, *, create=False):
    row = await session.get(CreatorAgentRelationshipRow, (scope.owner_user_id, scope.account_id, scope.person_ref))
    if row is None and create:
        row = CreatorAgentRelationshipRow(owner_user_id=scope.owner_user_id, account_id=scope.account_id, creator_uid=scope.person_ref)
        session.add(row)
        await session.flush()
    return row


async def _restore(session, scope):
    row = await _relationship(session, scope)
    projection = deepcopy((row.social_snapshots_json or {}).get(scope.channel_thread_ref, {})) if row else {}
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
    row.social_snapshots_json = {**(row.social_snapshots_json or {}), scope.channel_thread_ref: projection}
    row.updated_at = datetime.now(UTC)
    await session.flush()


def _projection(snapshot):
    return {key: value for key, value in asdict(snapshot).items() if key not in {"scope", "events", "outbound"}}


def _evidence(snapshot, refs):
    if not set(refs) <= {event["source_ref"] for event in snapshot.events}:
        raise ValueError("evidence references must belong to this channel scope")


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
            else:
                raise ValueError("social persistence supports SQLite and PostgreSQL")
            yield session

    async def restore(self, scope: SocialScope) -> SocialSnapshot:
        async with self._read() as session:
            return await _restore(session, scope)

    async def record_event(self, scope: SocialScope, event: ExternalEvent, *, expected_revision: int | None = None) -> SocialSnapshot:
        if not isinstance(event, ExternalEvent):
            raise ValueError("event must be an ExternalEvent")
        body = asdict(event)
        digest = _digest(body)
        async with self._write(scope) as session:
            snapshot = await _restore(session, scope)
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
                    source_event_id=event.source_event_id,
                    payload_digest=digest,
                    source_kind=event.source_kind,
                    body_json=body,
                    created_at=datetime.now(UTC),
                )
            )
            await _save(session, scope, {**_projection(snapshot), "revision": snapshot.revision + 1})
            return await _restore(session, scope)

    async def set_boundaries(self, scope: SocialScope, *, expected_revision: int, update: BoundaryUpdate) -> SocialSnapshot:
        """Host-authoritative mutation; callers must verify the evidence, never parse text into this DTO."""
        if not isinstance(update, BoundaryUpdate):
            raise ValueError("update must be BoundaryUpdate")
        async with self._write(scope) as session:
            snapshot = await _restore(session, scope)
            _check_revision(snapshot.revision, expected_revision, snapshot)
            _evidence(snapshot, update.evidence_ids)
            value = asdict(update)
            history = [*snapshot.boundary_history, {**value, "status": "applied", "revision": expected_revision + 1}]
            await _save(session, scope, {**_projection(snapshot), **{key: value[key] for key in ("identity_verified", "human_takeover", "do_not_contact")}, "revision": expected_revision + 1, "boundary_history": history})
            return await _restore(session, scope)

    async def commit_turn(self, scope: SocialScope, *, expected_revision: int, event_id: str, result: TurnResult, persona_fingerprint: str, memory_changes: tuple[SelfMemoryChange, ...] = ()) -> CommitResult:
        if not isinstance(result, TurnResult):
            raise ValueError("result must be TurnResult")
        if not isinstance(memory_changes, tuple) or len(memory_changes) > 16 or any(not isinstance(item, SelfMemoryChange) for item in memory_changes):
            raise ValueError("memory_changes must be bounded host-owned SelfMemoryChange values")
        if len({item.memory_id for item in memory_changes}) != len(memory_changes):
            raise ValueError("duplicate memory ids")
        if len(persona_fingerprint) != 64 or any(c not in "0123456789abcdef" for c in persona_fingerprint):
            raise ValueError("persona_fingerprint must be a SHA-256 digest")
        digest = _digest({"result": asdict(result), "memory_changes": [asdict(item) for item in memory_changes], "persona_fingerprint": persona_fingerprint})
        async with self._write(scope) as session:
            snapshot = await _restore(session, scope)
            event_where = (*_event_scope(scope), social_event.c.source_event_id == event_id)
            event = (await session.execute(sa.select(social_event).where(*event_where))).mappings().one_or_none()
            if event is None:
                raise ValueError("turn event does not exist in this scope")
            if event["turn_digest"] is not None:
                if event["turn_digest"] != digest:
                    raise SocialConflictError(snapshot)
                return CommitResult(snapshot, next((item for item in snapshot.outbound if item.action_id == event["action_id"]), None))
            _check_revision(snapshot.revision, expected_revision, snapshot)
            projection = _projection(snapshot)
            for patch in result.state_delta:
                _evidence(snapshot, patch.evidence_ids)
                projection["claims"] = _patch(projection["claims"], asdict(patch), id_key="claim_id")
            for change in memory_changes:
                _evidence(snapshot, change.evidence_ids)
                section = "self_state" if change.category.startswith("self_") else "commitments" if change.category == "commitment" else "relationship"
                projection[section] = _patch(projection[section], asdict(change), id_key="memory_id")
            projection["revision"] = expected_revision + 1
            projection["followup"] = asdict(result.followup) if result.followup else None
            action_id = None
            if result.reply is not None:
                action_id = _digest([scope.owner_user_id, scope.account_id, scope.person_ref, scope.channel_thread_ref, event_id])
                now = datetime.now(UTC)
                await session.execute(
                    social_outbound.insert().values(
                        owner_user_id=scope.owner_user_id,
                        account_id=scope.account_id,
                        relation_ref=scope.person_ref,
                        channel_thread_ref=scope.channel_thread_ref,
                        action_id=action_id,
                        turn_revision=expected_revision + 1,
                        persona_fingerprint=persona_fingerprint,
                        reply_text=result.reply,
                        state="pending",
                        provider_ref=None,
                        revision=0,
                        evidence_ids_json=[event["body_json"]["source_ref"]],
                        history_json=[],
                        created_at=now,
                        updated_at=now,
                    )
                )
            await session.execute(social_event.update().where(*event_where).values(turn_digest=digest, action_id=action_id))
            await _save(session, scope, projection)
            saved = await _restore(session, scope)
            return CommitResult(saved, next((item for item in saved.outbound if item.action_id == action_id), None))

    async def _profiles(self, session, scope):
        rows = (await session.execute(sa.select(social_persona_profile).where(*_account(social_persona_profile, scope)).order_by(social_persona_profile.c.revision))).mappings().all()
        profiles = {}
        for row in rows:
            value = deepcopy(row["profile_json"])
            value["basis_refs"] = tuple(value["basis_refs"])
            if "interests" in value["overrides"]:
                value["overrides"]["interests"] = tuple(value["overrides"]["interests"])
            profiles[f"{row['profile_id']}@{row['version']}"] = PersonaProfile(**value)
        return profiles, rows[-1]["revision"] if rows else 0

    async def get_profiles(self, scope: ProfileScope) -> dict[str, PersonaProfile]:
        async with self._read() as session:
            return (await self._profiles(session, scope))[0]

    async def register_profile(self, scope: ProfileScope, candidate: PersonaProfile, *, expected_revision: int) -> PersonaProfile:
        if not isinstance(candidate, PersonaProfile):
            raise ValueError("candidate must be PersonaProfile")
        async with self._write(scope) as session:
            profiles, revision = await self._profiles(session, scope)
            ref = f"{candidate.profile_id}@{candidate.version}"
            bounded_text(ref, "profile_ref", 128)
            if ref in profiles:
                if profiles[ref] != candidate:
                    raise ValueError("profile versions are immutable")
                return profiles[ref]
            _check_revision(revision, expected_revision, {"revision": revision, "profiles": profiles})
            if candidate.base_template_ref not in load_persona_catalog() or ref in load_persona_catalog():
                raise ValueError("profile must extend a canonical template without replacing it")
            if candidate.basis_refs:
                predicates = list(_account(social_event, scope))
                if scope.relation_ref:
                    predicates.append(social_event.c.person_ref == scope.relation_ref)
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

    async def _bindings(self, session, scope):
        account = await self._binding_row(session, ProfileScope(scope.owner_user_id, scope.account_id))
        agent = await self._binding_row(session, ProfileScope(scope.owner_user_id, scope.account_id, scope.agent_instance_id)) if scope.agent_instance_id else None
        relation = await self._binding_row(session, scope) if scope.relation_ref else None
        selected = relation if scope.relation_ref else agent if scope.agent_instance_id else account
        effective_at = selected["effective_at"] if selected else datetime(1970, 1, 1, tzinfo=UTC)
        if effective_at.tzinfo is None:
            effective_at = effective_at.replace(tzinfo=UTC)
        return PersonaBindings(scope, account["profile_ref"] if account else "relaxed_wit@1.0.1", agent["profile_ref"] if agent else None, relation["profile_ref"] if relation else None, selected["revision"] if selected else 1, effective_at)

    async def get_bindings(self, scope: ProfileScope) -> PersonaBindings:
        """An unregistered scope resolves the canonical default; writes expect revision 0."""
        async with self._read() as session:
            return await self._bindings(session, scope)

    async def get_binding_state(self, scope: ProfileScope) -> BindingState:
        async with self._read() as session:
            row = await self._binding_row(session, scope)
            return BindingState(row["revision"] if row else 0, await self._bindings(session, scope))

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
                if profile_ref not in load_persona_catalog() and profile_ref not in profiles:
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
                bodies = (await session.execute(sa.select(social_event.c.body_json).where(*predicates))).scalars().all()
                if not set(evidence_ids) <= {body["source_ref"] for body in bodies}:
                    raise ValueError("binding evidence must belong to its scope")
            await session.execute(
                social_persona_binding.insert().values(
                    owner_user_id=scope.owner_user_id,
                    account_id=scope.account_id,
                    scope_key=_scope_key(scope),
                    agent_instance_id=scope.agent_instance_id,
                    relation_ref=scope.relation_ref,
                    revision=expected_revision + 1,
                    profile_ref=profile_ref,
                    reason=reason,
                    evidence_refs_json=list(evidence_ids),
                    status="applied",
                    effective_at=datetime.now(UTC),
                )
            )
            return await self._bindings(session, scope)

    async def _action(self, session, scope, action_id):
        row = (await session.execute(sa.select(social_outbound).where(*_outbound_scope(scope), social_outbound.c.action_id == action_id))).mappings().one_or_none()
        if row is None:
            raise ValueError("outbound action does not exist in this scope")
        return row

    async def claim_outbound(self, scope: SocialScope, action_id: str, *, expected_revision: int) -> OutboundClaim:
        async with self._write(scope) as session:
            row = await self._action(session, scope, action_id)
            if row["state"] != "pending":
                return OutboundClaim(_outbound(row), False)
            snapshot = await _restore(session, scope)
            _check_revision(row["revision"], expected_revision, snapshot)
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
            snapshot = await _restore(session, scope)
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
