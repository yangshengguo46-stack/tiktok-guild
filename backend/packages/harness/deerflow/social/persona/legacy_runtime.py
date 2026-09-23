"""Phase 0 creator expression runtime retained in the native persona package."""

from __future__ import annotations

import asyncio
import logging
import threading
import uuid
from collections.abc import Mapping

from deerflow.creator_agent.state import CreatorFocus
from deerflow.social.persona.legacy_catalog import (
    DECISION_POLICY_VERSION,
    effective_persona_fingerprint,
    load_personas,
    resolve_persona,
)

logger = logging.getLogger(__name__)
_flight_guard = threading.Lock()
_flights: dict[tuple[asyncio.AbstractEventLoop, CreatorFocus, int], asyncio.Future[None]] = {}


def _claim_evaluation(focus: CreatorFocus, evidence_version: int) -> tuple[tuple, asyncio.Future[None], bool]:
    loop = asyncio.get_running_loop()
    key = (loop, focus, evidence_version)
    with _flight_guard:
        existing = _flights.get(key)
        if existing is not None:
            return key, existing, False
        future: asyncio.Future[None] = loop.create_future()
        _flights[key] = future
        return key, future, True


def _release_evaluation(key: tuple, future: asyncio.Future[None]) -> None:
    with _flight_guard:
        if _flights.get(key) is future:
            del _flights[key]
    if not future.done():
        future.set_result(None)


def _current_state(relationship: Mapping, catalog: Mapping) -> dict:
    state = relationship.get("persona_state")
    if not isinstance(state, Mapping):
        return {}
    persona_ref = state.get("persona_ref")
    if not isinstance(persona_ref, str) or "@" not in persona_ref:
        return {}
    persona_id, persona_version = persona_ref.rsplit("@", 1)
    if persona_id not in catalog or catalog[persona_id].version != persona_version:
        return {}
    return {
        "persona_id": persona_id,
        "persona_version": persona_version,
        "persona_revision": relationship.get("persona_revision", 0),
        "evidence_version": state.get("evaluated_evidence_version", 0),
    }


def _sourced_evidence(relationship: Mapping, focus: CreatorFocus) -> list[dict]:
    """Keep bounded, provenance-bearing observations inside the current scope."""
    rows = relationship.get("evidence") or []
    if not isinstance(rows, list):
        return []
    result: list[dict] = []
    for row in rows[:32]:
        if not isinstance(row, Mapping):
            continue
        # The repository's composite key scopes persisted events; older or
        # imported observations may additionally carry their own scope. If
        # present, those fields must agree with the relationship key.
        if any(key in row and row[key] != value for key, value in focus.as_kwargs().items()):
            continue
        ref = row.get("source_ref")
        body = row.get("text")
        if not isinstance(ref, str) or not ref or len(ref) > 256 or not isinstance(body, str) or not body or len(body) > 4000:
            continue
        if row.get("source_kind") not in {"creator_message", "operator_note", "tkdesk", "guild_operator"}:
            continue
        result.append({"ref": ref, "author": "creator" if row["source_kind"] == "creator_message" else "other", "text": body[:512]})
    return result


def _boundary_result(relationship: Mapping | None, focus: CreatorFocus) -> dict | None:
    if not isinstance(relationship, Mapping):
        return None
    for field, status in (
        ("do_not_contact", "do_not_contact"),
        ("human_takeover", "human_takeover"),
        ("receipt_unknown", "receipt_unknown"),
    ):
        if relationship.get(field) is True:
            return {"scope": focus.as_persona_scope(), "boundary": status}
    if relationship.get("identity_verified") is False:
        return {"scope": focus.as_persona_scope(), "boundary": "identity_unverified"}
    return None


class CreatorAgentRuntime:
    def __init__(self, *, repository, selector, catalog=None):
        self.repository = repository
        self.selector = selector
        self.catalog = catalog if catalog is not None else load_personas()

    def _resolve_snapshot(self, focus: CreatorFocus, relationship: Mapping | None) -> dict:
        relationship = relationship or {}
        evidence_version = relationship.get("evidence_version", 0)
        if type(evidence_version) is not int or evidence_version < 0:
            evidence_version = 0
        snapshot = resolve_persona(
            self.catalog,
            _current_state(relationship, self.catalog),
            scope=focus.as_persona_scope(),
            context_version=evidence_version,
        )
        snapshot["effective_persona_fingerprint"] = effective_persona_fingerprint(snapshot)
        snapshot["relationship_evidence"] = _sourced_evidence(relationship, focus)
        snapshot["facts"] = relationship.get("facts", []) if isinstance(relationship.get("facts", []), list) else []
        snapshot["commitments"] = relationship.get("commitments", []) if isinstance(relationship.get("commitments", []), list) else []
        state = relationship.get("persona_state")
        snapshot["source"] = "automatic_decision" if isinstance(state, Mapping) and state.get("evaluated_evidence_version", 0) > 0 else "default"
        snapshot["decision_evidence_refs"] = state.get("evidence_refs", []) if isinstance(state, Mapping) and isinstance(state.get("evidence_refs", []), list) else []
        return snapshot

    async def aresolve(self, focus: CreatorFocus | None) -> dict | None:
        if focus is None:
            return None
        relationship = await self.repository.get(**focus.as_kwargs())
        if relationship is None:
            return self._resolve_snapshot(focus, None)
        boundary = _boundary_result(relationship, focus)
        if boundary is not None:
            return boundary
        current = self._resolve_snapshot(focus, relationship)
        evidence_version = relationship.get("evidence_version", 0)
        stored = relationship.get("persona_state") or {}
        evaluated_version = stored.get("evaluated_evidence_version", 0) if isinstance(stored, Mapping) else 0
        if type(evidence_version) is not int or evidence_version <= evaluated_version:
            return current

        key, flight, leader = _claim_evaluation(focus, evidence_version)
        if not leader:
            await asyncio.shield(flight)
            latest = await self.repository.get(**focus.as_kwargs())
            return _boundary_result(latest, focus) or self._resolve_snapshot(focus, latest)
        try:
            # An earlier get may have captured an unevaluated snapshot but
            # returned only after the previous flight completed. Re-read after
            # claiming leadership so that stale readers never select twice.
            latest = await self.repository.get(**focus.as_kwargs())
            boundary = _boundary_result(latest, focus)
            if boundary is not None:
                return boundary
            if latest is None:
                return self._resolve_snapshot(focus, None)
            latest_version = latest.get("evidence_version", 0)
            latest_state = latest.get("persona_state") or {}
            evaluated_version = latest_state.get("evaluated_evidence_version", 0) if isinstance(latest_state, Mapping) else 0
            if type(latest_version) is not int or latest_version != evidence_version or latest_version <= evaluated_version:
                return self._resolve_snapshot(focus, latest)
            return await self._evaluate_unseen(focus, latest, self._resolve_snapshot(focus, latest), latest_version)
        finally:
            _release_evaluation(key, flight)

    async def _evaluate_unseen(self, focus: CreatorFocus, relationship: Mapping, current: dict, evidence_version: int) -> dict:
        evidence = current["relationship_evidence"]
        decision = None
        creator_evidence = [row for row in evidence if row["author"] == "creator"]
        if creator_evidence:
            decision = await self.selector.choose(
                current_persona_id=current["persona_id"],
                candidates=tuple(self.catalog[persona_id] for persona_id in sorted(self.catalog)),
                evidence=creator_evidence,
            )
        action = "stay"
        target_id = current["persona_id"]
        refs: list[str] = []
        reason = "No validated creator-authored communication supports a switch."
        confidence = 0.0
        if isinstance(decision, dict):
            requested_id = decision["persona_id"]
            selected_refs = decision["evidence_refs"]
            own_refs = {row["ref"] for row in evidence if row["author"] == "creator"}
            if decision["action"] == "switch" and requested_id in self.catalog and decision["confidence"] >= 0.75 and selected_refs and set(selected_refs) <= own_refs:
                action = "switch"
                target_id = requested_id
                refs = selected_refs
                reason = decision["reason"]
                confidence = decision["confidence"]
            elif decision["action"] == "stay" and requested_id == current["persona_id"]:
                reason = decision["reason"]
                confidence = decision["confidence"]

        next_revision = relationship.get("persona_revision", 0) + 1
        target_asset = self.catalog[target_id]
        target_snapshot = resolve_persona(
            self.catalog,
            {"persona_id": target_id, "persona_version": target_asset.version, "persona_revision": next_revision, "evidence_version": evidence_version},
            scope=focus.as_persona_scope(),
            context_version=evidence_version,
        )
        persisted = {
            "decision_id": str(uuid.uuid4()),
            "action": action,
            "persona_ref": f"{target_id}@{target_asset.version}",
            "evaluated_evidence_version": evidence_version,
            "policy_version": DECISION_POLICY_VERSION,
            "evidence_refs": refs,
            "reason": reason,
            "confidence": confidence,
            "fingerprint_inputs": {
                **focus.as_persona_scope(),
                "persona_id": target_id,
                "persona_version": target_asset.version,
                "persona_revision": next_revision,
                "evidence_version": evidence_version,
                "decision_policy_version": DECISION_POLICY_VERSION,
                "effective_persona_fingerprint": effective_persona_fingerprint(target_snapshot),
            },
        }
        try:
            updated = await self.repository.apply_persona_decision(
                **focus.as_kwargs(),
                expected_evidence_version=evidence_version,
                expected_persona_revision=relationship.get("persona_revision", 0),
                decision=persisted,
            )
        except ValueError:
            # A losing writer must use the winner's current state, never retry its
            # stale decision against a later evidence version.
            updated = await self.repository.get(**focus.as_kwargs())
        except Exception:
            logger.exception("CreatorAgent decision persistence failed; using current persona")
            updated = relationship
        boundary = _boundary_result(updated, focus)
        if boundary is not None:
            return boundary
        return self._resolve_snapshot(focus, updated)


def runtime_for_lead(app_config, model_name: str, *, runtime_cls=None) -> CreatorAgentRuntime | None:
    """Create a lazy selector tied to the Lead's already-authorized model."""
    from deerflow.persistence.creator_agent_relationship import CreatorAgentRelationshipRepository
    from deerflow.persistence.engine import get_session_factory
    from deerflow.social.persona.legacy_selector import PersonaSelector

    session_factory = get_session_factory()
    if session_factory is None:
        return None
    try:
        catalog = load_personas()
        repository = CreatorAgentRelationshipRepository(session_factory)
        return (runtime_cls or CreatorAgentRuntime)(
            repository=repository,
            selector=PersonaSelector(model_name=model_name, app_config=app_config),
            catalog=catalog,
        )
    except (OSError, UnicodeError, ValueError):
        logger.warning("CreatorAgent runtime unavailable; leaving ordinary Lead assembly unchanged", exc_info=True)
        return None


def middlewares_for_lead(app_config, model_name: str, *, creator_runtime: CreatorAgentRuntime | None = None) -> list:
    """Return the model-request projection for this Lead assembly."""
    from deerflow.creator_agent.middleware import CreatorAgentMiddleware

    active_runtime = creator_runtime or runtime_for_lead(app_config, model_name)
    return [CreatorAgentMiddleware(active_runtime)] if active_runtime is not None else []
