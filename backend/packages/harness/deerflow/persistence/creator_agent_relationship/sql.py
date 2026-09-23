"""Atomic, scope-checked creator relationship repository."""

from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from deerflow.persistence.creator_agent_relationship.model import CreatorAgentRelationshipRow

_MAX_EVIDENCE = 12
_MAX_IDS = 64
_MAX_LIST = 12
_MAX_SNAPSHOT_BYTES = 6144
_SOURCES = {"creator_message", "operator_note", "tkdesk", "guild_operator"}


class RelationshipConflictError(ValueError):
    """The caller's evidence or persona revision is no longer current."""

    def __init__(self, snapshot: dict[str, Any] | None):
        super().__init__("creator relationship version conflict")
        self.snapshot = snapshot


def _text(value: Any, name: str, limit: int) -> str:
    if not isinstance(value, str) or not value or len(value) > limit:
        raise ValueError(f"{name} must be a non-empty string of at most {limit} characters")
    return value


def _scope(owner_user_id: str, account_id: str, creator_uid: str) -> dict[str, str]:
    return {
        "owner_user_id": _text(owner_user_id, "owner_user_id", 64),
        "account_id": _text(account_id, "account_id", 128),
        "creator_uid": _text(creator_uid, "creator_uid", 128),
    }


def _where(scope: dict[str, str]):
    return (
        CreatorAgentRelationshipRow.owner_user_id == scope["owner_user_id"],
        CreatorAgentRelationshipRow.account_id == scope["account_id"],
        CreatorAgentRelationshipRow.creator_uid == scope["creator_uid"],
    )


def _bounded_strings(value: Any, name: str, *, limit: int = _MAX_LIST) -> list[str]:
    if not isinstance(value, list) or len(value) > limit:
        raise ValueError(f"{name} must be a bounded list")
    return [_text(item, name, 256) for item in value]


def _size(value: Any) -> int:
    return len(json.dumps(value, ensure_ascii=False, sort_keys=True).encode("utf-8"))


def _decision_digest(decision: dict[str, Any]) -> str:
    try:
        payload = json.dumps(decision, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
    except (TypeError, ValueError) as exc:
        raise ValueError("decision must be finite JSON data") from exc
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _event_digest(event: dict[str, Any]) -> str:
    payload = json.dumps(event, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _duplicate_event(ids: list, event_id: str, digest: str) -> bool:
    for item in ids:
        if isinstance(item, dict) and item.get("id") == event_id:
            if item.get("digest") != digest:
                raise ValueError("event_id was reused with different content")
            return True
        if item == event_id:
            # Older ID-only rows cannot prove a payload-equivalent replay.
            raise ValueError("event_id replay has no stored content digest")
    return False


def _duplicate_decision(ids: list[dict[str, str]], decision_id: str, digest: str) -> bool:
    for item in ids:
        if item["id"] == decision_id:
            if item["digest"] != digest:
                raise ValueError("decision_id was reused with different content")
            return True
    return False


def _snapshot(row: CreatorAgentRelationshipRow) -> dict[str, Any]:
    return {
        "owner_user_id": row.owner_user_id,
        "account_id": row.account_id,
        "creator_uid": row.creator_uid,
        "evidence_version": row.evidence_version,
        "persona_revision": row.persona_revision,
        "evidence": row.evidence_json,
        "facts": row.facts_json,
        "commitments": row.commitments_json,
        "do_not_contact": row.do_not_contact,
        "persona_state": row.persona_state_json,
    }


def _validate_event(event: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(event, dict):
        raise ValueError("event must be a mapping")
    source_kind = _text(event.get("source_kind"), "source_kind", 32)
    if source_kind not in _SOURCES:
        raise ValueError("unsupported evidence source_kind")
    text = _text(event.get("text"), "text", 512)
    facts = _bounded_strings(event.get("facts", []), "facts")
    commitments = _bounded_strings(event.get("commitments", []), "commitments")
    boundary = event.get("do_not_contact", False)
    if not isinstance(boundary, bool):
        raise ValueError("do_not_contact must be boolean")
    result = {
        "event_id": _text(event.get("event_id"), "event_id", 128),
        "source_ref": _text(event.get("source_ref"), "source_ref", 256),
        "source_kind": source_kind,
        "text": text,
        "facts": facts,
        "commitments": commitments,
        "do_not_contact": boundary,
    }
    if _size(result) > 2048:
        raise ValueError("evidence event exceeds size limit")
    return result


def _validate_decision(decision: dict[str, Any], snapshot: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(decision, dict):
        raise ValueError("decision must be a mapping")
    action = decision.get("action")
    if action not in {"stay", "switch"}:
        raise ValueError("invalid persona action")
    persona_ref = _text(decision.get("persona_ref"), "persona_ref", 128)
    current_ref = snapshot["persona_state"]["persona_ref"] if snapshot["persona_state"] is not None else "relaxed_wit@1.0.1"
    if action == "stay" and persona_ref != current_ref:
        raise ValueError("stay must preserve the current persona")
    confidence = decision.get("confidence")
    if isinstance(confidence, bool) or not isinstance(confidence, (int, float)) or not 0 <= confidence <= 1:
        raise ValueError("confidence must be between zero and one")
    refs = _bounded_strings(decision.get("evidence_refs"), "evidence_refs", limit=8)
    known = {item["source_ref"] for item in snapshot["evidence"]}
    if any(ref not in known for ref in refs):
        raise ValueError("decision references evidence outside the current relationship")
    if action == "switch":
        creator_refs = {item["source_ref"] for item in snapshot["evidence"] if item["source_kind"] == "creator_message"}
        if confidence < 0.75 or not creator_refs.intersection(refs):
            raise ValueError("switch requires creator quote and confidence >= 0.75")
    evidence_version = decision.get("evaluated_evidence_version")
    if type(evidence_version) is not int or evidence_version != snapshot["evidence_version"]:
        raise ValueError("decision evidence version differs from current context")
    inputs = decision.get("fingerprint_inputs")
    if not isinstance(inputs, dict) or _size(inputs) > 1024 or any(not isinstance(k, str) for k in inputs):
        raise ValueError("fingerprint inputs must be a bounded mapping")
    for value in inputs.values():
        if not isinstance(value, (str, int, float, bool)) or isinstance(value, str) and len(value) > 256:
            raise ValueError("fingerprint input value is invalid")
    return {
        "decision_id": _text(decision.get("decision_id"), "decision_id", 128),
        "action": action,
        "persona_ref": persona_ref,
        "evaluated_evidence_version": evidence_version,
        "policy_version": _text(decision.get("policy_version"), "policy_version", 64),
        "evidence_refs": refs,
        "reason": _text(decision.get("reason"), "reason", 512),
        "confidence": float(confidence),
        "fingerprint_inputs": inputs,
    }


def _validated_fingerprint(inputs: dict[str, Any], scope: dict[str, str], decision: dict[str, Any], revision: int) -> str:
    parts = decision["persona_ref"].split("@")
    if len(parts) != 2 or not all(parts):
        raise ValueError("fingerprint persona_ref must contain id and version")
    expected = {
        "operator_id": scope["owner_user_id"],
        "account_id": scope["account_id"],
        "creator_uid": scope["creator_uid"],
        "persona_id": parts[0],
        "persona_version": parts[1],
        "persona_revision": revision,
        "evidence_version": decision["evaluated_evidence_version"],
        "decision_policy_version": decision["policy_version"],
    }
    if set(inputs) != {*expected, "effective_persona_fingerprint"}:
        raise ValueError("fingerprint inputs have unexpected fields")
    for key, value in expected.items():
        if type(inputs[key]) is not type(value) or inputs[key] != value:
            raise ValueError(f"fingerprint {key} differs from authoritative state")
    digest = inputs["effective_persona_fingerprint"]
    if not isinstance(digest, str) or len(digest) != 64 or any(char not in "0123456789abcdef" for char in digest):
        raise ValueError("fingerprint digest must be 64 lowercase hex characters")
    return digest


class CreatorAgentRelationshipRepository:
    def __init__(self, session_factory: async_sessionmaker[AsyncSession]) -> None:
        self.session_factory = session_factory

    async def get(self, *, owner_user_id: str, account_id: str, creator_uid: str) -> dict[str, Any] | None:
        scope = _scope(owner_user_id, account_id, creator_uid)
        async with self.session_factory() as session:
            row = (await session.execute(select(CreatorAgentRelationshipRow).where(*_where(scope)))).scalar_one_or_none()
            return _snapshot(row) if row is not None else None

    async def record_evidence(self, *, owner_user_id: str, account_id: str, creator_uid: str, event: dict[str, Any]) -> dict[str, Any]:
        scope = _scope(owner_user_id, account_id, creator_uid)
        item = _validate_event(event)
        digest = _event_digest(item)
        for _ in range(5):
            async with self.session_factory() as session:
                row = (await session.execute(select(CreatorAgentRelationshipRow).where(*_where(scope)))).scalar_one_or_none()
                if row is not None and _duplicate_event(row.evidence_ids_json, item["event_id"], digest):
                    return _snapshot(row)
                old_version = row.evidence_version if row is not None else 0
                evidence = [*(row.evidence_json if row is not None else []), item][-_MAX_EVIDENCE:]
                ids = [*(row.evidence_ids_json if row is not None else []), {"id": item["event_id"], "digest": digest}][-_MAX_IDS:]
                facts = list(row.facts_json if row is not None else [])
                commitments = list(row.commitments_json if row is not None else [])
                for value in item["facts"]:
                    if value not in facts:
                        facts.append(value)
                for value in item["commitments"]:
                    if value not in commitments:
                        commitments.append(value)
                facts = facts[-_MAX_LIST:]
                commitments = commitments[-_MAX_LIST:]
                do_not_contact = bool((row.do_not_contact if row is not None else False) or item["do_not_contact"])
                while _size({"evidence": evidence, "facts": facts, "commitments": commitments}) > _MAX_SNAPSHOT_BYTES:
                    if len(evidence) > 1:
                        evidence.pop(0)
                    elif facts:
                        facts.pop(0)
                    elif commitments:
                        commitments.pop(0)
                    else:
                        raise ValueError("evidence event exceeds relationship size limit")
                now = datetime.now(UTC)
                values = dict(
                    evidence_version=old_version + 1,
                    evidence_json=evidence,
                    evidence_ids_json=ids,
                    facts_json=facts,
                    commitments_json=commitments,
                    do_not_contact=do_not_contact,
                    updated_at=now,
                )
                if row is None:
                    session.add(
                        CreatorAgentRelationshipRow(
                            **scope,
                            **values,
                            persona_revision=0,
                            persona_state_json=None,
                            decision_ids_json=[],
                            created_at=now,
                        )
                    )
                    try:
                        await session.commit()
                    except IntegrityError:
                        await session.rollback()
                        continue
                else:
                    result = await session.execute(update(CreatorAgentRelationshipRow).where(*_where(scope), CreatorAgentRelationshipRow.evidence_version == old_version).values(**values))
                    if result.rowcount != 1:
                        await session.rollback()
                        continue
                    await session.commit()
            snapshot = await self.get(**scope)
            assert snapshot is not None
            return snapshot
        raise RelationshipConflictError(await self.get(**scope))

    async def apply_persona_decision(
        self,
        *,
        owner_user_id: str,
        account_id: str,
        creator_uid: str,
        expected_evidence_version: int,
        expected_persona_revision: int,
        decision: dict[str, Any],
    ) -> dict[str, Any]:
        scope = _scope(owner_user_id, account_id, creator_uid)
        async with self.session_factory() as session:
            row = (await session.execute(select(CreatorAgentRelationshipRow).where(*_where(scope)))).scalar_one_or_none()
            current = _snapshot(row) if row is not None else None
            if row is None:
                raise RelationshipConflictError(None)
            decision_id = _text(decision.get("decision_id") if isinstance(decision, dict) else None, "decision_id", 128)
            digest = _decision_digest(decision)
            if _duplicate_decision(row.decision_ids_json, decision_id, digest):
                return current
            if row.evidence_version != expected_evidence_version or row.persona_revision != expected_persona_revision:
                raise RelationshipConflictError(current)
            validated = _validate_decision(decision, current)
            revision = expected_persona_revision + 1
            fingerprint = _validated_fingerprint(validated["fingerprint_inputs"], scope, validated, revision)
            persona_state = {
                **validated,
                "decision_digest": digest,
                "effective_persona_fingerprint": fingerprint,
                "effective_at": datetime.now(UTC).isoformat(),
            }
            result = await session.execute(
                update(CreatorAgentRelationshipRow)
                .where(
                    *_where(scope),
                    CreatorAgentRelationshipRow.evidence_version == expected_evidence_version,
                    CreatorAgentRelationshipRow.persona_revision == expected_persona_revision,
                )
                .values(
                    persona_revision=revision,
                    persona_state_json=persona_state,
                    decision_ids_json=[*row.decision_ids_json, {"id": decision_id, "digest": digest}][-_MAX_IDS:],
                    updated_at=datetime.now(UTC),
                )
            )
            if result.rowcount != 1:
                await session.rollback()
                latest = await self.get(**scope)
                if latest is not None and latest["persona_state"] and latest["persona_state"]["decision_id"] == decision_id:
                    if latest["persona_state"]["decision_digest"] == digest:
                        return latest
                raise RelationshipConflictError(latest)
            await session.commit()
        saved = await self.get(**scope)
        assert saved is not None
        return saved
