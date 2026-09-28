"""Native persistence for TKDesk handoffs and creator outreach ownership."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from deerflow.persistence.creator_agent_relationship.model import (
    CreatorClaimRow,
    CreatorHandoffBatchRow,
    CreatorHandoffCandidateRow,
    CreatorOutreachSequenceRow,
)

_MAX_JSON_BYTES = 32_768
_ALLOWED_STATES = ("gray", "public_touched", "contacted", "replied", "closed")
_ALLOWED_TRANSITIONS = {
    "gray": {"public_touched"},
    "public_touched": {"contacted"},
    "contacted": {"replied"},
    "replied": {"closed"},
    "closed": set(),
}
_REQUIRED_EVIDENCE = {
    "public_touched": "public_action_receipt",
    "contacted": "dm_receipt",
    "replied": "verified_inbound",
}


def _bounded(value: Any, *, field: str) -> Any:
    if not isinstance(value, (dict, list)):
        raise ValueError(f"{field} must be a JSON object or array")
    if len(json.dumps(value, ensure_ascii=False, separators=(",", ":"))) > _MAX_JSON_BYTES:
        raise ValueError(f"{field} exceeds {_MAX_JSON_BYTES} bytes")
    return value


def _text(value: Any, field: str, limit: int = 128) -> str:
    if not isinstance(value, str) or not value or len(value) > limit:
        raise ValueError(f"{field} must be a non-empty bounded string")
    return value


class CreatorOutreachRepository:
    """Repository whose claim key is owner plus creator, independent of sender."""

    def __init__(self, session_factory: async_sessionmaker[AsyncSession]) -> None:
        self.session_factory = session_factory

    async def import_handoff(
        self,
        *,
        owner_user_id: str,
        batch_id: str,
        dataset_hash: str,
        provenance: dict[str, Any],
        candidates: list[dict[str, Any]],
    ) -> dict[str, int | str]:
        owner_user_id = _text(owner_user_id, "owner_user_id")
        batch_id = _text(batch_id, "batch_id")
        dataset_hash = _text(dataset_hash, "dataset_hash", 64)
        provenance = _bounded(provenance, field="provenance")
        if not isinstance(candidates, list):
            raise ValueError("candidates must be a list")
        prepared: list[tuple[str, dict[str, Any]]] = []
        seen: set[str] = set()
        for candidate in candidates:
            if not isinstance(candidate, dict):
                raise ValueError("candidate must be an object")
            uid = _text(candidate.get("creator_uid"), "creator_uid")
            if uid in seen:
                continue
            seen.add(uid)
            payload = _bounded(candidate.get("payload", candidate), field="candidate payload")
            prepared.append((uid, payload))
        async with self.session_factory() as session:
            batch = await session.get(CreatorHandoffBatchRow, (owner_user_id, batch_id))
            if batch is None:
                batch = CreatorHandoffBatchRow(owner_user_id=owner_user_id, batch_id=batch_id, dataset_hash=dataset_hash, provenance_json=provenance)
                session.add(batch)
                try:
                    await session.flush()
                except IntegrityError:
                    await session.rollback()
                    batch = await session.get(CreatorHandoffBatchRow, (owner_user_id, batch_id))
            if batch is None:
                raise RuntimeError("handoff batch could not be persisted")
            if batch.dataset_hash != dataset_hash:
                raise ValueError("batch_id already belongs to a different dataset")
            inserted = 0
            for uid, payload in prepared:
                existing = await session.get(CreatorHandoffCandidateRow, (owner_user_id, batch_id, uid))
                if existing is None:
                    session.add(CreatorHandoffCandidateRow(owner_user_id=owner_user_id, batch_id=batch_id, creator_uid=uid, payload_json=payload))
                    inserted += 1
            await session.commit()
            return {"owner_user_id": owner_user_id, "batch_id": batch_id, "dataset_hash": dataset_hash, "accepted": len(prepared), "inserted": inserted}

    async def claim_creator(self, *, owner_user_id: str, creator_uid: str, batch_id: str | None = None) -> dict[str, Any]:
        owner_user_id = _text(owner_user_id, "owner_user_id")
        creator_uid = _text(creator_uid, "creator_uid")
        async with self.session_factory() as session:
            claim = await session.get(CreatorClaimRow, (owner_user_id, creator_uid))
            if claim is not None:
                return await self._read_claim(session, claim)
            candidate = None
            batch = None
            if batch_id is not None:
                batch_id = _text(batch_id, "batch_id")
                candidate = await session.get(CreatorHandoffCandidateRow, (owner_user_id, batch_id, creator_uid))
                if candidate is None:
                    raise ValueError("creator is not present in the handoff batch")
                batch = await session.get(CreatorHandoffBatchRow, (owner_user_id, batch_id))
            claim = CreatorClaimRow(
                owner_user_id=owner_user_id,
                creator_uid=creator_uid,
                batch_id=batch_id,
                dataset_hash=batch.dataset_hash if batch else None,
                candidate_payload_json=candidate.payload_json if candidate else {},
                status="gray",
            )
            session.add(claim)
            try:
                await session.commit()
            except IntegrityError:
                await session.rollback()
                claim = await session.get(CreatorClaimRow, (owner_user_id, creator_uid))
                if claim is None:
                    raise
            return await self._read_claim(session, claim)

    async def bind_sequence(self, *, owner_user_id: str, creator_uid: str, sender_account_id: str) -> dict[str, Any]:
        owner_user_id = _text(owner_user_id, "owner_user_id")
        creator_uid = _text(creator_uid, "creator_uid")
        sender_account_id = _text(sender_account_id, "sender_account_id")
        async with self.session_factory() as session:
            claim = await session.get(CreatorClaimRow, (owner_user_id, creator_uid))
            if claim is None:
                raise ValueError("creator must be claimed before sequence binding")
            max_no = await session.scalar(select(func.max(CreatorOutreachSequenceRow.sequence_no)).where(CreatorOutreachSequenceRow.owner_user_id == owner_user_id, CreatorOutreachSequenceRow.creator_uid == creator_uid))
            sequence_no = int(max_no or 0) + 1
            row = CreatorOutreachSequenceRow(owner_user_id=owner_user_id, creator_uid=creator_uid, sequence_no=sequence_no, sender_account_id=sender_account_id, status="pending")
            session.add(row)
            await session.commit()
            return row.to_dict()

    async def advance_state(self, *, owner_user_id: str, creator_uid: str, next_status: str, evidence_kind: str) -> dict[str, Any]:
        if next_status not in _ALLOWED_STATES:
            raise ValueError("unknown outreach state")
        async with self.session_factory() as session:
            claim = await session.get(CreatorClaimRow, (_text(owner_user_id, "owner_user_id"), _text(creator_uid, "creator_uid")))
            if claim is None:
                raise ValueError("creator is not claimed")
            if next_status not in _ALLOWED_TRANSITIONS.get(claim.status, set()):
                raise ValueError(f"invalid outreach transition {claim.status} -> {next_status}")
            if _REQUIRED_EVIDENCE.get(next_status) != evidence_kind:
                raise ValueError(f"{next_status} requires {_REQUIRED_EVIDENCE[next_status]}")
            claim.status = next_status
            claim.updated_at = datetime.now(UTC)
            await session.commit()
            return await self._read_claim(session, claim)

    async def read_model(self, *, owner_user_id: str, creator_uid: str) -> dict[str, Any] | None:
        async with self.session_factory() as session:
            claim = await session.get(CreatorClaimRow, (_text(owner_user_id, "owner_user_id"), _text(creator_uid, "creator_uid")))
            if claim is None:
                return None
            return await self._read_claim(session, claim)

    async def _read_claim(self, session: AsyncSession, claim: CreatorClaimRow) -> dict[str, Any]:
        sequences = (
            (
                await session.execute(
                    select(CreatorOutreachSequenceRow)
                    .where(
                        CreatorOutreachSequenceRow.owner_user_id == claim.owner_user_id,
                        CreatorOutreachSequenceRow.creator_uid == claim.creator_uid,
                    )
                    .order_by(CreatorOutreachSequenceRow.sequence_no)
                )
            )
            .scalars()
            .all()
        )
        candidates = (
            (
                await session.execute(
                    select(CreatorHandoffCandidateRow)
                    .where(
                        CreatorHandoffCandidateRow.owner_user_id == claim.owner_user_id,
                        CreatorHandoffCandidateRow.creator_uid == claim.creator_uid,
                    )
                    .order_by(CreatorHandoffCandidateRow.created_at)
                )
            )
            .scalars()
            .all()
        )
        return {"claim": claim.to_dict(), "sequences": [row.to_dict() for row in sequences], "handoff": [{"batch_id": row.batch_id, "payload": row.payload_json} for row in candidates]}
