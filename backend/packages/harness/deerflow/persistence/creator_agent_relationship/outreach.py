"""Native persistence for TKDesk handoffs and creator outreach ownership."""

from __future__ import annotations

import json
from collections.abc import Iterable
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import uuid4

from sqlalchemy import and_, exists, func, or_, select, text, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from deerflow.persistence.creator_agent_relationship.model import (
    CreatorClaimRow,
    CreatorHandoffBatchRow,
    CreatorHandoffCandidateRow,
    CreatorOutreachActionTaskRow,
    CreatorOutreachReceiptRow,
    CreatorOutreachSequenceRow,
    SenderAccountRow,
)

_MAX_JSON_BYTES = 32_768
_ALLOWED_STATES = ("gray", "public_touched", "contacted", "replied", "closed")
_ALLOWED_TRANSITIONS = {
    "gray": {"public_touched", "replied"},
    "public_touched": {"contacted", "replied"},
    "contacted": {"replied"},
    "replied": {"closed"},
    "closed": set(),
}
_REQUIRED_EVIDENCE = {
    "public_touched": "public_action_receipt",
    "contacted": "dm_receipt",
    "replied": "verified_inbound",
    "closed": "closure_receipt",
}
_RECEIPT_KINDS = frozenset(_REQUIRED_EVIDENCE.values())
_SENDER_CHANNELS = frozenset({"web", "ios"})
_ACTION_KINDS = frozenset({"like", "comment", "follow", "message"})
_ACTION_STATES = frozenset({"pending", "leased", "completed", "failed"})
_ACTIVE_SEQUENCE_STATES = ("pending", "public_touched", "contacted", "replied")
_ACTIVE_SENDER_STATES = frozenset({"enabled", "healthy", "ready", "active"})
_MAX_WEB_SENDER_ACCOUNTS = 50
_MAX_ACTIVE_SENDER_ACCOUNTS = 10


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


def _dataset_hash(value: str) -> str:
    value = _text(value, "dataset_hash", 64)
    if len(value) != 64 or any(char not in "0123456789abcdef" for char in value):
        raise ValueError("dataset_hash must be 64 lowercase hex characters")
    return value


def _same_datetime(left: datetime | None, right: datetime | None) -> bool:
    if left is None or right is None:
        return left is right
    if left.tzinfo is not None:
        left = left.astimezone(UTC).replace(tzinfo=None)
    if right.tzinfo is not None:
        right = right.astimezone(UTC).replace(tzinfo=None)
    return left == right


class CreatorOutreachRepository:
    """Repository whose claim key is owner plus creator, independent of sender."""

    def __init__(self, session_factory: async_sessionmaker[AsyncSession]) -> None:
        self.session_factory = session_factory

    async def register_sender_account(
        self,
        owner_user_id: str,
        sender_account_id: str,
        channel: str,
        *,
        external_ref: str | None = None,
        profile_ref: str | None = None,
        device_ref: str | None = None,
        status: str = "enabled",
        capabilities: dict[str, Any] | list[Any] | None = None,
        capabilities_json: dict[str, Any] | list[Any] | None = None,
        last_health_at: datetime | None = None,
    ) -> dict[str, Any]:
        """Register one sender identity, preserving identical replays."""
        owner_user_id = _text(owner_user_id, "owner_user_id")
        sender_account_id = _text(sender_account_id, "sender_account_id")
        if channel not in _SENDER_CHANNELS:
            raise ValueError("channel must be web or ios")
        status = _text(status, "status", 32)
        if capabilities is not None and capabilities_json is not None and capabilities != capabilities_json:
            raise ValueError("capabilities and capabilities_json conflict")
        capabilities = capabilities if capabilities is not None else capabilities_json
        capabilities = _bounded({} if capabilities is None else capabilities, field="capabilities")
        for value, field, limit in (
            (external_ref, "external_ref", 255),
            (profile_ref, "profile_ref", 255),
            (device_ref, "device_ref", 255),
        ):
            if value is not None:
                _text(value, field, limit)
        async with self.session_factory() as session:
            await self._lock_sender_owner(session, owner_user_id)
            existing = await session.get(SenderAccountRow, (owner_user_id, sender_account_id))
            if existing is not None:
                expected = (channel, external_ref, profile_ref, device_ref, status, capabilities, last_health_at)
                actual = (
                    existing.channel,
                    existing.external_ref,
                    existing.profile_ref,
                    existing.device_ref,
                    existing.status,
                    existing.capabilities_json,
                    existing.last_health_at,
                )
                if actual[:-1] != expected[:-1] or not _same_datetime(actual[-1], expected[-1]):
                    raise ValueError("sender account replay conflict")
                return existing.to_dict()
            if channel == "web":
                web_count = await session.scalar(select(func.count()).select_from(SenderAccountRow).where(SenderAccountRow.owner_user_id == owner_user_id, SenderAccountRow.channel == "web"))
                if int(web_count or 0) >= _MAX_WEB_SENDER_ACCOUNTS:
                    raise ValueError("maximum of 50 web sender accounts reached")
            row = SenderAccountRow(
                owner_user_id=owner_user_id,
                sender_account_id=sender_account_id,
                channel=channel,
                external_ref=external_ref,
                profile_ref=profile_ref,
                device_ref=device_ref,
                status=status,
                capabilities_json=capabilities,
                last_health_at=last_health_at,
            )
            try:
                async with session.begin_nested():
                    session.add(row)
                    await session.flush()
            except IntegrityError:
                existing = await session.get(SenderAccountRow, (owner_user_id, sender_account_id))
                if existing is None:
                    raise
                if (
                    existing.channel,
                    existing.external_ref,
                    existing.profile_ref,
                    existing.device_ref,
                    existing.status,
                    existing.capabilities_json,
                ) != (channel, external_ref, profile_ref, device_ref, status, capabilities) or not _same_datetime(existing.last_health_at, last_health_at):
                    raise ValueError("sender account replay conflict")
                return existing.to_dict()
            await session.commit()
            return row.to_dict()

    async def list_sender_accounts(
        self,
        owner_user_id: str,
        *,
        channel: str | None = None,
        status: str | None = None,
        active_only: bool = False,
        limit: int | None = None,
        active_limit: int | None = None,
        max_active: int | None = None,
    ) -> list[dict[str, Any]]:
        owner_user_id = _text(owner_user_id, "owner_user_id")
        if channel is not None and channel not in _SENDER_CHANNELS:
            raise ValueError("channel must be web or ios")
        if status is not None:
            status = _text(status, "status", 32)
        if active_limit is not None and max_active is not None and active_limit != max_active:
            raise ValueError("active_limit and max_active conflict")
        if max_active is not None:
            active_limit = max_active
        if active_limit is not None:
            active_only = True
            if limit is not None and limit != active_limit:
                raise ValueError("limit and active_limit conflict")
            limit = active_limit
        if limit is not None and (type(limit) is not int or limit <= 0):
            raise ValueError("limit must be a positive integer")
        if active_only and limit is not None and limit > _MAX_ACTIVE_SENDER_ACCOUNTS:
            raise ValueError("active sender batch cannot exceed 10 accounts")
        stmt = select(SenderAccountRow).where(SenderAccountRow.owner_user_id == owner_user_id)
        if channel is not None:
            stmt = stmt.where(SenderAccountRow.channel == channel)
        if status is not None:
            stmt = stmt.where(SenderAccountRow.status == status)
        if active_only:
            stmt = stmt.where(SenderAccountRow.status.in_(_ACTIVE_SENDER_STATES))
            if limit is None:
                limit = _MAX_ACTIVE_SENDER_ACCOUNTS
        stmt = stmt.order_by(SenderAccountRow.created_at, SenderAccountRow.sender_account_id)
        if limit is not None:
            stmt = stmt.limit(limit)
        async with self.session_factory() as session:
            rows = (await session.execute(stmt)).scalars().all()
            return [row.to_dict() for row in rows]

    async def read_sender_account(self, owner_user_id: str, sender_account_id: str) -> dict[str, Any] | None:
        owner_user_id = _text(owner_user_id, "owner_user_id")
        sender_account_id = _text(sender_account_id, "sender_account_id")
        async with self.session_factory() as session:
            row = await session.get(SenderAccountRow, (owner_user_id, sender_account_id))
            return row.to_dict() if row is not None else None

    async def enqueue_action(
        self,
        owner_user_id: str,
        creator_uid: str,
        sequence_no: int,
        sender_account_id: str,
        action: str,
        idempotency_key: str,
        *,
        payload: dict[str, Any] | list[Any] | None = None,
        payload_json: dict[str, Any] | list[Any] | None = None,
        task_id: str | None = None,
    ) -> dict[str, Any]:
        owner_user_id = _text(owner_user_id, "owner_user_id")
        creator_uid = _text(creator_uid, "creator_uid")
        sender_account_id = _text(sender_account_id, "sender_account_id")
        if type(sequence_no) is not int or sequence_no < 1:
            raise ValueError("sequence_no must be a positive integer")
        if action not in _ACTION_KINDS:
            raise ValueError("unsupported outreach action")
        idempotency_key = _text(idempotency_key, "idempotency_key", 255)
        if payload is not None and payload_json is not None and payload != payload_json:
            raise ValueError("payload and payload_json conflict")
        payload = payload if payload is not None else payload_json
        payload = _bounded({} if payload is None else payload, field="action payload")
        if task_id is None:
            task_id = uuid4().hex
        else:
            task_id = _text(task_id, "task_id")
        async with self.session_factory() as session:
            existing = await session.scalar(
                select(CreatorOutreachActionTaskRow).where(
                    CreatorOutreachActionTaskRow.owner_user_id == owner_user_id,
                    CreatorOutreachActionTaskRow.idempotency_key == idempotency_key,
                )
            )
            expected = (creator_uid, sequence_no, sender_account_id, action, payload)
            if existing is not None:
                actual = (
                    existing.creator_uid,
                    existing.sequence_no,
                    existing.sender_account_id,
                    existing.action,
                    existing.payload_json,
                )
                if actual != expected:
                    raise ValueError("action idempotency replay conflict")
                return existing.to_dict()
            sender = await session.get(SenderAccountRow, (owner_user_id, sender_account_id))
            if sender is None:
                raise ValueError("sender account must be registered before enqueueing actions")
            sequence = await session.get(CreatorOutreachSequenceRow, (owner_user_id, creator_uid, sequence_no))
            if sequence is None or sequence.status not in _ACTIVE_SEQUENCE_STATES:
                raise ValueError("an active bound sequence is required")
            if sequence.sender_account_id != sender_account_id:
                raise ValueError("action sender differs from the active sequence sender")
            row = CreatorOutreachActionTaskRow(
                task_id=task_id,
                owner_user_id=owner_user_id,
                creator_uid=creator_uid,
                sequence_no=sequence_no,
                sender_account_id=sender_account_id,
                action=action,
                idempotency_key=idempotency_key,
                payload_json=payload,
                state="pending",
            )
            try:
                async with session.begin_nested():
                    session.add(row)
                    await session.flush()
            except IntegrityError:
                existing = await session.scalar(
                    select(CreatorOutreachActionTaskRow).where(
                        CreatorOutreachActionTaskRow.owner_user_id == owner_user_id,
                        CreatorOutreachActionTaskRow.idempotency_key == idempotency_key,
                    )
                )
                if existing is not None:
                    if (
                        existing.creator_uid,
                        existing.sequence_no,
                        existing.sender_account_id,
                        existing.action,
                        existing.payload_json,
                    ) != expected:
                        raise ValueError("action idempotency replay conflict")
                    return existing.to_dict()
                raise ValueError("an active action task already exists") from None
            await session.commit()
            return row.to_dict()

    async def claim_action(
        self,
        task_id: str,
        *,
        lease_seconds: int = 60,
        now: datetime | None = None,
        lease_owner: str,
    ) -> dict[str, Any] | None:
        task_id = _text(task_id, "task_id")
        if type(lease_seconds) is not int or lease_seconds <= 0:
            raise ValueError("lease_seconds must be a positive integer")
        lease_owner = _text(lease_owner, "lease_owner")
        now = now or datetime.now(UTC)
        lease_until = now + timedelta(seconds=lease_seconds)
        lease_token = uuid4().hex
        async with self.session_factory() as session:
            task = await session.get(CreatorOutreachActionTaskRow, task_id)
            if task is None:
                return None
            active_sequence = exists(
                select(CreatorOutreachSequenceRow.sequence_no).where(
                    CreatorOutreachSequenceRow.owner_user_id == task.owner_user_id,
                    CreatorOutreachSequenceRow.creator_uid == task.creator_uid,
                    CreatorOutreachSequenceRow.sequence_no == task.sequence_no,
                    CreatorOutreachSequenceRow.status.in_(_ACTIVE_SEQUENCE_STATES),
                )
            )
            active_sender = exists(
                select(SenderAccountRow.sender_account_id).where(
                    SenderAccountRow.owner_user_id == task.owner_user_id,
                    SenderAccountRow.sender_account_id == task.sender_account_id,
                    SenderAccountRow.status.in_(_ACTIVE_SENDER_STATES),
                )
            )
            stmt = (
                update(CreatorOutreachActionTaskRow)
                .where(
                    CreatorOutreachActionTaskRow.task_id == task_id,
                    active_sequence,
                    active_sender,
                    or_(
                        CreatorOutreachActionTaskRow.state == "pending",
                        and_(
                            CreatorOutreachActionTaskRow.state == "leased",
                            or_(
                                CreatorOutreachActionTaskRow.lease_until.is_(None),
                                CreatorOutreachActionTaskRow.lease_until <= now,
                            ),
                        ),
                    ),
                )
                .values(
                    state="leased",
                    lease_until=lease_until,
                    lease_owner=lease_owner,
                    lease_token=lease_token,
                    attempt_count=CreatorOutreachActionTaskRow.attempt_count + 1,
                    updated_at=now,
                )
                .execution_options(synchronize_session=False)
            )
            result = await session.execute(stmt)
            await session.commit()
            if not result.rowcount:
                return None
            await session.refresh(task)
            return task.to_dict()

    async def complete_action(
        self,
        task_id: str,
        *,
        sender_account_id: str,
        idempotency_key: str,
        receipt_id: str | None = None,
        receipt: dict[str, Any] | None = None,
        now: datetime | None = None,
        lease_owner: str | None = None,
        lease_token: str | None = None,
    ) -> dict[str, Any]:
        task_id = _text(task_id, "task_id")
        sender_account_id = _text(sender_account_id, "sender_account_id")
        idempotency_key = _text(idempotency_key, "idempotency_key", 255)
        if lease_owner is None or lease_token is None:
            raise ValueError("an active lease owner and token are required")
        lease_owner = _text(lease_owner, "lease_owner")
        lease_token = _text(lease_token, "lease_token")
        if receipt is not None:
            receipt = _bounded(receipt, field="receipt")
            receipt_id = receipt_id or receipt.get("receipt_id")
        receipt_id = _text(receipt_id, "receipt_id")
        now = now or datetime.now(UTC)
        async with self.session_factory() as session:
            row = await session.get(CreatorOutreachActionTaskRow, task_id)
            if row is None:
                raise ValueError("action task does not exist")
            if row.sender_account_id != sender_account_id or row.idempotency_key != idempotency_key:
                raise ValueError("action completion identity does not match task")
            if row.state != "leased":
                raise ValueError("action task has no active lease")
            if row.lease_owner != lease_owner or row.lease_token != lease_token:
                raise ValueError("action task lease is stale or owned by another worker")
            stmt = (
                update(CreatorOutreachActionTaskRow)
                .where(
                    CreatorOutreachActionTaskRow.task_id == task_id,
                    CreatorOutreachActionTaskRow.state == "leased",
                    CreatorOutreachActionTaskRow.lease_owner == lease_owner,
                    CreatorOutreachActionTaskRow.lease_token == lease_token,
                    CreatorOutreachActionTaskRow.lease_until > now,
                )
                .values(
                    state="completed",
                    lease_until=None,
                    lease_owner=None,
                    lease_token=None,
                    receipt_id=receipt_id,
                    error_code=None,
                    updated_at=now,
                )
                .execution_options(synchronize_session=False)
            )
            result = await session.execute(stmt)
            if not result.rowcount:
                raise ValueError("action task lease is stale or expired")
            await session.commit()
            await session.refresh(row)
            return row.to_dict()

    async def fail_action(
        self,
        task_id: str,
        *,
        error_code: str,
        sender_account_id: str,
        idempotency_key: str,
        now: datetime | None = None,
        lease_owner: str | None = None,
        lease_token: str | None = None,
    ) -> dict[str, Any]:
        task_id = _text(task_id, "task_id")
        error_code = _text(error_code, "error_code", 128)
        sender_account_id = _text(sender_account_id, "sender_account_id")
        idempotency_key = _text(idempotency_key, "idempotency_key", 255)
        if lease_owner is None or lease_token is None:
            raise ValueError("an active lease owner and token are required")
        lease_owner = _text(lease_owner, "lease_owner")
        lease_token = _text(lease_token, "lease_token")
        now = now or datetime.now(UTC)
        async with self.session_factory() as session:
            row = await session.get(CreatorOutreachActionTaskRow, task_id)
            if row is None:
                raise ValueError("action task does not exist")
            if row.sender_account_id != sender_account_id:
                raise ValueError("action failure identity does not match task")
            if row.idempotency_key != idempotency_key:
                raise ValueError("action failure identity does not match task")
            if row.state != "leased":
                raise ValueError("action task has no active lease")
            if row.lease_owner != lease_owner or row.lease_token != lease_token:
                raise ValueError("action task lease is stale or owned by another worker")
            stmt = (
                update(CreatorOutreachActionTaskRow)
                .where(
                    CreatorOutreachActionTaskRow.task_id == task_id,
                    CreatorOutreachActionTaskRow.state == "leased",
                    CreatorOutreachActionTaskRow.lease_owner == lease_owner,
                    CreatorOutreachActionTaskRow.lease_token == lease_token,
                    CreatorOutreachActionTaskRow.lease_until > now,
                )
                .values(
                    state="failed",
                    lease_until=None,
                    lease_owner=None,
                    lease_token=None,
                    error_code=error_code,
                    updated_at=now,
                )
                .execution_options(synchronize_session=False)
            )
            result = await session.execute(stmt)
            if not result.rowcount:
                raise ValueError("action task lease is stale or expired")
            await session.commit()
            await session.refresh(row)
            return row.to_dict()

    async def release_expired_action_leases(self, *, now: datetime | None = None) -> int:
        now = now or datetime.now(UTC)
        stmt = (
            update(CreatorOutreachActionTaskRow)
            .where(
                CreatorOutreachActionTaskRow.state == "leased",
                or_(
                    CreatorOutreachActionTaskRow.lease_until.is_(None),
                    CreatorOutreachActionTaskRow.lease_until <= now,
                ),
            )
            .values(state="pending", lease_until=None, lease_owner=None, lease_token=None, updated_at=now)
            .execution_options(synchronize_session=False)
        )
        async with self.session_factory() as session:
            result = await session.execute(stmt)
            await session.commit()
            return int(result.rowcount or 0)

    async def release_action_claim(
        self,
        task_id: str,
        *,
        lease_owner: str,
        lease_token: str,
        now: datetime | None = None,
    ) -> dict[str, Any]:
        """Return a leased action to pending after an unverified provider result."""
        task_id = _text(task_id, "task_id")
        lease_owner = _text(lease_owner, "lease_owner")
        lease_token = _text(lease_token, "lease_token")
        now = now or datetime.now(UTC)
        stmt = (
            update(CreatorOutreachActionTaskRow)
            .where(
                CreatorOutreachActionTaskRow.task_id == task_id,
                CreatorOutreachActionTaskRow.state == "leased",
                CreatorOutreachActionTaskRow.lease_owner == lease_owner,
                CreatorOutreachActionTaskRow.lease_token == lease_token,
            )
            .values(
                state="pending",
                lease_until=None,
                lease_owner=None,
                lease_token=None,
                updated_at=now,
            )
            .execution_options(synchronize_session=False)
        )
        async with self.session_factory() as session:
            result = await session.execute(stmt)
            await session.commit()
            if not result.rowcount:
                row = await session.get(CreatorOutreachActionTaskRow, task_id)
                if row is None:
                    raise ValueError("action task does not exist")
                return row.to_dict()
            row = await session.get(CreatorOutreachActionTaskRow, task_id)
            if row is None:
                raise ValueError("action task does not exist")
            return row.to_dict()

    async def read_action_task(self, task_id: str) -> dict[str, Any] | None:
        task_id = _text(task_id, "task_id")
        async with self.session_factory() as session:
            row = await session.get(CreatorOutreachActionTaskRow, task_id)
            return row.to_dict() if row is not None else None

    async def read_action_receipt(self, owner_user_id: str, task_id: str) -> dict[str, Any] | None:
        """Read only the receipt bound to one owner-scoped action task."""
        owner_user_id = _text(owner_user_id, "owner_user_id")
        task_id = _text(task_id, "task_id")
        async with self.session_factory() as session:
            task = await session.get(CreatorOutreachActionTaskRow, task_id)
            if task is None or task.owner_user_id != owner_user_id or task.receipt_id is None:
                return None
            receipt = await session.get(
                CreatorOutreachReceiptRow,
                (owner_user_id, task.creator_uid, task.sequence_no, task.receipt_id),
            )
            return receipt.to_dict() if receipt is not None else None

    async def update_action_payload(
        self,
        owner_user_id: str,
        task_id: str,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        """Merge bounded user-visible payload into an uncompleted action."""
        owner_user_id = _text(owner_user_id, "owner_user_id")
        task_id = _text(task_id, "task_id")
        payload = _bounded(payload, field="action payload")
        async with self.session_factory() as session:
            row = await session.get(CreatorOutreachActionTaskRow, task_id)
            if row is None or row.owner_user_id != owner_user_id:
                raise ValueError("action task does not exist")
            if row.state == "completed":
                raise ValueError("completed action payload cannot be changed")
            sequence = await session.get(
                CreatorOutreachSequenceRow,
                (owner_user_id, row.creator_uid, row.sequence_no),
            )
            if sequence is None or sequence.status not in _ACTIVE_SEQUENCE_STATES:
                raise ValueError("closed outreach sequences cannot be changed")
            row.payload_json = {**(row.payload_json or {}), **payload}
            row.updated_at = datetime.now(UTC)
            await session.commit()
            return row.to_dict()

    async def retry_action(
        self,
        owner_user_id: str,
        task_id: str,
        *,
        recoverable_error_codes: Iterable[str],
        lease_owner: str | None = None,
        lease_token: str | None = None,
    ) -> dict[str, Any]:
        """Reset one explicitly unknown/recoverable task without duplicating verified work."""
        owner_user_id = _text(owner_user_id, "owner_user_id")
        task_id = _text(task_id, "task_id")
        if (lease_owner is None) != (lease_token is None):
            raise ValueError("lease owner and token must be supplied together")
        if lease_owner is not None:
            lease_owner = _text(lease_owner, "lease_owner")
            lease_token = _text(lease_token, "lease_token")
        allowed = {_text(code, "error_code", 128) for code in recoverable_error_codes}
        async with self.session_factory() as session:
            row = await session.get(CreatorOutreachActionTaskRow, task_id)
            if row is None or row.owner_user_id != owner_user_id:
                raise ValueError("action task does not exist")
            if row.state == "completed":
                raise ValueError("verified outreach actions cannot be retried")
            if row.state == "leased":
                if row.lease_owner != lease_owner or row.lease_token != lease_token:
                    raise ValueError("action task lease is owned by another worker")
            receipt = None
            if row.receipt_id is not None:
                receipt = await session.get(
                    CreatorOutreachReceiptRow,
                    (owner_user_id, row.creator_uid, row.sequence_no, row.receipt_id),
                )
            if receipt is not None and receipt.verified:
                raise ValueError("verified outreach actions cannot be retried")
            receipt_error_code = (receipt.payload_json or {}).get("error_code") if receipt is not None else None
            error_code = row.error_code or receipt_error_code
            if error_code not in allowed:
                raise ValueError("only recoverable failures may be retried")
            sequence = await session.get(
                CreatorOutreachSequenceRow,
                (owner_user_id, row.creator_uid, row.sequence_no),
            )
            if sequence is None or sequence.status not in _ACTIVE_SEQUENCE_STATES:
                raise ValueError("closed outreach sequences cannot be retried")
            now = datetime.now(UTC)
            conditions = [
                CreatorOutreachActionTaskRow.task_id == task_id,
                CreatorOutreachActionTaskRow.owner_user_id == owner_user_id,
            ]
            if row.state == "leased":
                conditions.extend(
                    [
                        CreatorOutreachActionTaskRow.state == "leased",
                        CreatorOutreachActionTaskRow.lease_owner == lease_owner,
                        CreatorOutreachActionTaskRow.lease_token == lease_token,
                        CreatorOutreachActionTaskRow.lease_until > now,
                    ]
                )
            else:
                conditions.append(CreatorOutreachActionTaskRow.state.in_(("pending", "failed")))
            result = await session.execute(
                update(CreatorOutreachActionTaskRow)
                .where(*conditions)
                .values(
                    state="pending",
                    lease_until=None,
                    lease_owner=None,
                    lease_token=None,
                    error_code=None,
                    updated_at=now,
                )
                .execution_options(synchronize_session=False)
            )
            if not result.rowcount:
                raise ValueError("action task lease changed before retry")
            await session.commit()
            await session.refresh(row)
            return row.to_dict()

    async def set_sender_account_status(
        self,
        owner_user_id: str,
        sender_account_id: str,
        *,
        status: str,
        reason: str,
    ) -> dict[str, Any]:
        """Change one owner-scoped sender status through the native repository."""
        owner_user_id = _text(owner_user_id, "owner_user_id")
        sender_account_id = _text(sender_account_id, "sender_account_id")
        status = _text(status, "status", 32)
        reason = _text(reason, "reason", 500)
        async with self.session_factory() as session:
            row = await session.get(SenderAccountRow, (owner_user_id, sender_account_id))
            if row is None:
                raise ValueError("sender account does not exist")
            row.status = status
            row.capabilities_json = {**(row.capabilities_json or {}), "last_operator_reason": reason}
            row.updated_at = datetime.now(UTC)
            await session.commit()
            return row.to_dict()

    async def request_manual_takeover(
        self,
        owner_user_id: str,
        task_id: str,
        *,
        reason: str,
        lease_owner: str | None = None,
        lease_token: str | None = None,
    ) -> dict[str, Any]:
        """Stop one task or queue a takeover request without stealing a live lease."""
        owner_user_id = _text(owner_user_id, "owner_user_id")
        task_id = _text(task_id, "task_id")
        reason = _text(reason, "reason", 128)
        if (lease_owner is None) != (lease_token is None):
            raise ValueError("lease owner and token must be supplied together")
        if lease_owner is not None:
            lease_owner = _text(lease_owner, "lease_owner")
            lease_token = _text(lease_token, "lease_token")
        async with self.session_factory() as session:
            row = await session.get(CreatorOutreachActionTaskRow, task_id)
            if row is None or row.owner_user_id != owner_user_id:
                raise ValueError("action task does not exist")
            if row.state == "completed":
                raise ValueError("verified outreach actions cannot be taken over")
            sequence = await session.get(
                CreatorOutreachSequenceRow,
                (owner_user_id, row.creator_uid, row.sequence_no),
            )
            if sequence is None or sequence.status not in _ACTIVE_SEQUENCE_STATES:
                raise ValueError("closed outreach sequences cannot be changed")
            now = datetime.now(UTC)
            if row.state == "leased" and (row.lease_owner != lease_owner or row.lease_token != lease_token):
                result = await session.execute(
                    update(CreatorOutreachActionTaskRow)
                    .where(
                        CreatorOutreachActionTaskRow.task_id == task_id,
                        CreatorOutreachActionTaskRow.owner_user_id == owner_user_id,
                        CreatorOutreachActionTaskRow.state == "leased",
                    )
                    .values(
                        payload_json={
                            **(row.payload_json or {}),
                            "manual_required": True,
                            "manual_takeover_requested": True,
                            "manual_takeover_reason": reason,
                        },
                        updated_at=now,
                    )
                    .execution_options(synchronize_session=False)
                )
                if not result.rowcount:
                    raise ValueError("action task lease changed before takeover request")
                await session.commit()
                await session.refresh(row)
                return row.to_dict()
            conditions = [
                CreatorOutreachActionTaskRow.task_id == task_id,
                CreatorOutreachActionTaskRow.owner_user_id == owner_user_id,
            ]
            if row.state == "leased":
                conditions.extend(
                    [
                        CreatorOutreachActionTaskRow.state == "leased",
                        CreatorOutreachActionTaskRow.lease_owner == lease_owner,
                        CreatorOutreachActionTaskRow.lease_token == lease_token,
                        CreatorOutreachActionTaskRow.lease_until > now,
                    ]
                )
            else:
                conditions.append(CreatorOutreachActionTaskRow.state.in_(("pending", "failed")))
            result = await session.execute(
                update(CreatorOutreachActionTaskRow)
                .where(*conditions)
                .values(
                    state="failed",
                    error_code=reason,
                    lease_until=None,
                    lease_owner=None,
                    lease_token=None,
                    updated_at=now,
                )
                .execution_options(synchronize_session=False)
            )
            if not result.rowcount:
                raise ValueError("action task lease changed before takeover")
            await session.commit()
            await session.refresh(row)
            return row.to_dict()

    async def mark_action_unknown(
        self,
        owner_user_id: str,
        task_id: str,
        *,
        receipt_id: str,
        reason: str,
        lease_owner: str | None = None,
        lease_token: str | None = None,
    ) -> dict[str, Any]:
        """Persist an unverified provider result and keep the task retryable."""
        owner_user_id = _text(owner_user_id, "owner_user_id")
        task_id = _text(task_id, "task_id")
        receipt_id = _text(receipt_id, "receipt_id")
        reason = _text(reason, "reason", 500)
        if (lease_owner is None) != (lease_token is None):
            raise ValueError("lease owner and token must be supplied together")
        if lease_owner is not None:
            lease_owner = _text(lease_owner, "lease_owner")
            lease_token = _text(lease_token, "lease_token")
        async with self.session_factory() as session:
            row = await session.get(CreatorOutreachActionTaskRow, task_id)
            if row is None or row.owner_user_id != owner_user_id:
                raise ValueError("action task does not exist")
            if row.state == "completed":
                raise ValueError("verified outreach actions cannot be marked unknown")
            if row.state == "leased" and (row.lease_owner != lease_owner or row.lease_token != lease_token):
                raise ValueError("action task lease is owned by another worker")
            sequence = await session.get(
                CreatorOutreachSequenceRow,
                (owner_user_id, row.creator_uid, row.sequence_no),
            )
            if sequence is None or sequence.status not in _ACTIVE_SEQUENCE_STATES:
                raise ValueError("closed outreach sequences cannot be changed")
            kind = "dm_receipt" if row.action == "message" else "public_action_receipt"
            receipt = CreatorOutreachReceiptRow(
                owner_user_id=owner_user_id,
                creator_uid=row.creator_uid,
                sequence_no=row.sequence_no,
                receipt_id=receipt_id,
                kind=kind,
                provider_ref=None,
                verification_source="operator_unknown",
                payload_json={
                    "receipt_type": "provider_unknown",
                    "action": row.action,
                    "error_code": "provider_unknown",
                    "message": reason,
                    "manual_required": True,
                },
                verified=False,
            )
            existing = await session.get(
                CreatorOutreachReceiptRow,
                (owner_user_id, row.creator_uid, row.sequence_no, receipt_id),
            )
            if existing is None:
                session.add(receipt)
            elif existing.payload_json != receipt.payload_json or existing.verified:
                raise ValueError("receipt replay conflict")
            now = datetime.now(UTC)
            conditions = [
                CreatorOutreachActionTaskRow.task_id == task_id,
                CreatorOutreachActionTaskRow.owner_user_id == owner_user_id,
            ]
            if row.state == "leased":
                conditions.extend(
                    [
                        CreatorOutreachActionTaskRow.state == "leased",
                        CreatorOutreachActionTaskRow.lease_owner == lease_owner,
                        CreatorOutreachActionTaskRow.lease_token == lease_token,
                        CreatorOutreachActionTaskRow.lease_until > now,
                    ]
                )
            else:
                conditions.append(CreatorOutreachActionTaskRow.state.in_(("pending", "failed")))
            result = await session.execute(
                update(CreatorOutreachActionTaskRow)
                .where(*conditions)
                .values(
                    state="pending",
                    receipt_id=receipt_id,
                    error_code="provider_unknown",
                    lease_until=None,
                    lease_owner=None,
                    lease_token=None,
                    updated_at=now,
                )
                .execution_options(synchronize_session=False)
            )
            if not result.rowcount:
                raise ValueError("action task lease changed before unknown result")
            await session.commit()
            await session.refresh(row)
            return row.to_dict()

    async def close_sequence(
        self,
        owner_user_id: str,
        creator_uid: str,
        sequence_no: int,
        *,
        reason: str,
    ) -> dict[str, Any]:
        """Record a closure receipt and close one native outreach sequence."""
        owner_user_id = _text(owner_user_id, "owner_user_id")
        creator_uid = _text(creator_uid, "creator_uid")
        if type(sequence_no) is not int or sequence_no < 1:
            raise ValueError("sequence_no must be a positive integer")
        reason = _text(reason, "reason", 500)
        model = await self.read_model(owner_user_id=owner_user_id, creator_uid=creator_uid)
        sequence = next(
            (row for row in (model or {}).get("sequences", []) if row["sequence_no"] == sequence_no),
            None,
        )
        if sequence is None:
            raise ValueError("outreach sequence does not exist")
        if sequence["status"] != "replied":
            raise ValueError("outreach sequence must be replied before closure")
        receipt_id = f"closure:{owner_user_id}:{creator_uid}:{sequence_no}"
        receipt = await self.record_receipt(
            owner_user_id=owner_user_id,
            creator_uid=creator_uid,
            sequence_no=sequence_no,
            receipt_id=receipt_id,
            kind="closure_receipt",
            provider_ref=None,
            verification_source="operator_manual",
            payload={"receipt_type": "closure_receipt", "reason": reason},
            verified=True,
        )
        claim = await self.advance_state(
            owner_user_id=owner_user_id,
            creator_uid=creator_uid,
            sequence_no=sequence_no,
            receipt_id=receipt["receipt_id"],
            next_status="closed",
        )
        return {"claim": claim, "receipt": receipt}

    async def list_action_tasks(
        self,
        owner_user_id: str,
        creator_uid: str,
        sequence_no: int,
        *,
        action: str | None = None,
    ) -> list[dict[str, Any]]:
        """Read the durable action set for one creator sequence in order."""
        owner_user_id = _text(owner_user_id, "owner_user_id")
        creator_uid = _text(creator_uid, "creator_uid")
        if type(sequence_no) is not int or sequence_no < 1:
            raise ValueError("sequence_no must be a positive integer")
        if action is not None and action not in _ACTION_KINDS:
            raise ValueError("unsupported outreach action")
        stmt = (
            select(CreatorOutreachActionTaskRow)
            .where(
                CreatorOutreachActionTaskRow.owner_user_id == owner_user_id,
                CreatorOutreachActionTaskRow.creator_uid == creator_uid,
                CreatorOutreachActionTaskRow.sequence_no == sequence_no,
            )
            .order_by(CreatorOutreachActionTaskRow.created_at, CreatorOutreachActionTaskRow.task_id)
        )
        if action is not None:
            stmt = stmt.where(CreatorOutreachActionTaskRow.action == action)
        async with self.session_factory() as session:
            rows = (await session.execute(stmt)).scalars().all()
            return [row.to_dict() for row in rows]

    @staticmethod
    async def _lock_sender_owner(session: AsyncSession, owner_user_id: str) -> None:
        """Serialize sender-capacity checks across workers for one owner."""
        dialect = session.get_bind().dialect.name
        if dialect == "postgresql":
            await session.execute(text("SELECT pg_advisory_xact_lock(hashtext(:owner_user_id))"), {"owner_user_id": owner_user_id})
        elif dialect == "sqlite":
            await session.execute(text("BEGIN IMMEDIATE"))

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
        dataset_hash = _dataset_hash(dataset_hash)
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
                    try:
                        async with session.begin_nested():
                            session.add(CreatorHandoffCandidateRow(owner_user_id=owner_user_id, batch_id=batch_id, creator_uid=uid, payload_json=payload))
                            await session.flush()
                        inserted += 1
                    except IntegrityError:
                        existing = await session.get(CreatorHandoffCandidateRow, (owner_user_id, batch_id, uid))
                if existing is not None and existing.payload_json != payload:
                    raise ValueError("handoff candidate replay conflict")
            await session.commit()
            return {"owner_user_id": owner_user_id, "batch_id": batch_id, "dataset_hash": dataset_hash, "accepted": len(prepared), "inserted": inserted}

    async def claim_creator(self, *, owner_user_id: str, creator_uid: str, batch_id: str | None = None) -> dict[str, Any]:
        owner_user_id = _text(owner_user_id, "owner_user_id")
        creator_uid = _text(creator_uid, "creator_uid")
        if batch_id is not None:
            batch_id = _text(batch_id, "batch_id")
        async with self.session_factory() as session:
            claim = await session.get(CreatorClaimRow, (owner_user_id, creator_uid))
            if claim is not None:
                if batch_id is not None and claim.batch_id != batch_id:
                    raise ValueError("creator claim already belongs to a different handoff batch")
                return await self._read_claim(session, claim)
            candidate = None
            batch = None
            if batch_id is not None:
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
            sender = await session.get(SenderAccountRow, (owner_user_id, sender_account_id))
            if sender is None:
                raise ValueError("sender account must be registered before binding a sequence")
            claim = await session.get(CreatorClaimRow, (owner_user_id, creator_uid))
            if claim is None:
                raise ValueError("creator must be claimed before sequence binding")
            if claim.status == "closed":
                raise ValueError("closed creator claims cannot start a new outreach sequence")
            active = await session.scalar(
                select(CreatorOutreachSequenceRow).where(
                    CreatorOutreachSequenceRow.owner_user_id == owner_user_id,
                    CreatorOutreachSequenceRow.creator_uid == creator_uid,
                    CreatorOutreachSequenceRow.status.in_(("pending", "public_touched", "contacted", "replied")),
                )
            )
            if active is not None:
                if active.sender_account_id != sender_account_id:
                    raise ValueError("creator already has an active sender sequence")
                return active.to_dict()
            max_no = await session.scalar(select(func.max(CreatorOutreachSequenceRow.sequence_no)).where(CreatorOutreachSequenceRow.owner_user_id == owner_user_id, CreatorOutreachSequenceRow.creator_uid == creator_uid))
            sequence_no = int(max_no or 0) + 1
            row = CreatorOutreachSequenceRow(owner_user_id=owner_user_id, creator_uid=creator_uid, sequence_no=sequence_no, sender_account_id=sender_account_id, status="pending")
            try:
                async with session.begin_nested():
                    session.add(row)
                    await session.flush()
            except IntegrityError:
                active = await session.scalar(
                    select(CreatorOutreachSequenceRow).where(
                        CreatorOutreachSequenceRow.owner_user_id == owner_user_id,
                        CreatorOutreachSequenceRow.creator_uid == creator_uid,
                        CreatorOutreachSequenceRow.status.in_(("pending", "public_touched", "contacted", "replied")),
                    )
                )
                if active is None or active.sender_account_id != sender_account_id:
                    raise ValueError("creator already has an active sender sequence")
                row = active
            await session.commit()
            return row.to_dict()

    async def record_receipt(self, *, owner_user_id: str, creator_uid: str, sequence_no: int, receipt_id: str, kind: str, provider_ref: str | None, verification_source: str, payload: dict[str, Any], verified: bool) -> dict[str, Any]:
        """Persist a provider/verifier-owned receipt; callers must record its source."""
        owner_user_id = _text(owner_user_id, "owner_user_id")
        creator_uid = _text(creator_uid, "creator_uid")
        if type(sequence_no) is not int or sequence_no < 1:
            raise ValueError("sequence_no must be a positive integer")
        receipt_id = _text(receipt_id, "receipt_id")
        kind = _text(kind, "kind", 32)
        if kind not in _RECEIPT_KINDS:
            raise ValueError("unsupported outreach receipt kind")
        verification_source = _text(verification_source, "verification_source", 64)
        if type(verified) is not bool:
            raise ValueError("verified must be boolean")
        payload = _bounded(payload, field="receipt payload")
        if provider_ref is not None:
            provider_ref = _text(provider_ref, "provider_ref")
        async with self.session_factory() as session:
            sequence = await session.get(CreatorOutreachSequenceRow, (owner_user_id, creator_uid, sequence_no))
            if sequence is None:
                raise ValueError("sequence does not exist")
            existing = await session.get(CreatorOutreachReceiptRow, (owner_user_id, creator_uid, sequence_no, receipt_id))
            if existing is not None:
                if (existing.kind, existing.provider_ref, existing.verification_source, existing.payload_json, existing.verified) != (kind, provider_ref, verification_source, payload, verified):
                    raise ValueError("receipt replay conflict")
                return existing.to_dict()
            row = CreatorOutreachReceiptRow(
                owner_user_id=owner_user_id,
                creator_uid=creator_uid,
                sequence_no=sequence_no,
                receipt_id=receipt_id,
                kind=kind,
                provider_ref=provider_ref,
                verification_source=verification_source,
                payload_json=payload,
                verified=verified,
            )
            try:
                async with session.begin_nested():
                    session.add(row)
                    await session.flush()
            except IntegrityError:
                existing = await session.get(CreatorOutreachReceiptRow, (owner_user_id, creator_uid, sequence_no, receipt_id))
                if existing is None:
                    raise
                if (existing.kind, existing.provider_ref, existing.verification_source, existing.payload_json, existing.verified) != (kind, provider_ref, verification_source, payload, verified):
                    raise ValueError("receipt replay conflict")
                return existing.to_dict()
            await session.commit()
            return row.to_dict()

    async def advance_state(self, *, owner_user_id: str, creator_uid: str, sequence_no: int, receipt_id: str, next_status: str) -> dict[str, Any]:
        if next_status not in _ALLOWED_STATES:
            raise ValueError("unknown outreach state")
        if type(sequence_no) is not int or sequence_no < 1:
            raise ValueError("sequence_no must be a positive integer")
        async with self.session_factory() as session:
            claim = await session.get(CreatorClaimRow, (_text(owner_user_id, "owner_user_id"), _text(creator_uid, "creator_uid")))
            if claim is None:
                raise ValueError("creator is not claimed")
            if next_status not in _ALLOWED_TRANSITIONS.get(claim.status, set()):
                raise ValueError(f"invalid outreach transition {claim.status} -> {next_status}")
            sequence = await session.get(CreatorOutreachSequenceRow, (claim.owner_user_id, claim.creator_uid, sequence_no))
            if sequence is None or sequence.status not in ("pending", "public_touched", "contacted", "replied"):
                raise ValueError("an active bound sequence is required")
            expected_sequence_status = "pending" if claim.status == "gray" else claim.status
            if sequence.status != expected_sequence_status:
                raise ValueError("claim and outreach sequence states are inconsistent")
            receipt = await session.get(CreatorOutreachReceiptRow, (claim.owner_user_id, claim.creator_uid, sequence_no, _text(receipt_id, "receipt_id")))
            if receipt is None or not receipt.verified:
                raise ValueError("a verified receipt is required")
            if receipt.kind != _REQUIRED_EVIDENCE.get(next_status):
                raise ValueError(f"{next_status} requires {_REQUIRED_EVIDENCE[next_status]}")
            claim.status = next_status
            sequence.status = next_status
            sequence.updated_at = datetime.now(UTC)
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
        batches = {row.batch_id: await session.get(CreatorHandoffBatchRow, (claim.owner_user_id, row.batch_id)) for row in candidates}
        handoff = [
            {
                "batch_id": row.batch_id,
                "dataset_hash": batches[row.batch_id].dataset_hash,
                "provenance": batches[row.batch_id].provenance_json,
                "payload": row.payload_json,
            }
            for row in candidates
        ]
        return {"claim": claim.to_dict(), "sequences": [row.to_dict() for row in sequences], "handoff": handoff}
