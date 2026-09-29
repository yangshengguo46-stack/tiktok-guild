"""Control-plane API for the native public creator outreach workflow.

The router only exposes DeerFlow-owned state.  Provider execution stays behind
the configured public-outreach operator and every response is owner-scoped and
redacted before it crosses the Gateway boundary.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import desc, select, update

from app.gateway.authz import require_permission
from app.gateway.deps import get_current_user
from deerflow.creator_agent.public_outreach import PublicOutreachWorkflow
from deerflow.persistence.creator_agent_relationship import CreatorOutreachRepository
from deerflow.persistence.creator_agent_relationship.model import (
    CreatorOutreachActionTaskRow,
    CreatorOutreachReceiptRow,
    SenderAccountRow,
)
from deerflow.persistence.engine import get_session_factory

router = APIRouter(prefix="/api/public-outreach", tags=["public-outreach"])

_ACTIVE_ACCOUNT_STATUSES = frozenset({"enabled", "healthy", "ready", "active"})
_RECOVERABLE_ERRORS = frozenset(
    {
        "unknown",
        "provider_unknown",
        "operator_unavailable",
        "timeout",
        "transient",
        "rate_limited",
        "network_error",
        "provider_rejected",
    }
)
_REDACTED_KEY_PARTS = (
    "password",
    "secret",
    "token",
    "cookie",
    "credential",
    "authorization",
    "user_data_dir",
    "profile_path",
    "path",
)
_REDACTED_PATH_KEYS = frozenset({"profile_ref", "profile_path", "storage_state", "cookies"})


class CreateOutreachTaskRequest(BaseModel):
    creator_uid: str = Field(min_length=1, max_length=128)
    sequence_no: int = Field(ge=1)
    sender_account_id: str = Field(min_length=1, max_length=128)
    actions: list[Literal["like", "comment", "follow", "message"]] = Field(
        default_factory=lambda: ["like", "comment", "follow", "message"],
        min_length=1,
    )
    comment: str | None = Field(default=None, max_length=4000)
    message: str | None = Field(default=None, max_length=4000)

    @field_validator("actions")
    @classmethod
    def validate_actions(cls, value: list[str]) -> list[str]:
        if len(set(value)) != len(value):
            raise ValueError("actions must be unique")
        order = {"like": 0, "comment": 1, "follow": 2, "message": 3}
        if value != sorted(value, key=order.__getitem__):
            raise ValueError("actions must run in like, comment, follow, message order")
        if any(action in value for action in ("like", "comment", "follow")) and not {
            "like",
            "comment",
            "follow",
        }.issubset(value):
            raise ValueError("like, comment, and follow must be submitted together")
        return value


class RetryTaskRequest(BaseModel):
    reason: str | None = Field(default=None, max_length=500)


class ManualReasonRequest(BaseModel):
    reason: str = Field(min_length=1, max_length=500)


class CloseSequenceRequest(BaseModel):
    creator_uid: str = Field(min_length=1, max_length=128)
    sequence_no: int = Field(ge=1)
    reason: str = Field(min_length=1, max_length=500)


def _repository(request: Request) -> CreatorOutreachRepository:
    repository = getattr(request.app.state, "creator_outreach_repo", None)
    if repository is None:
        repository = getattr(request.app.state, "public_outreach_repo", None)
    if repository is not None:
        return repository
    session_factory = get_session_factory()
    if session_factory is None:
        raise HTTPException(status_code=503, detail="Public outreach persistence is not configured")
    return CreatorOutreachRepository(session_factory)


def _operator(request: Request) -> Any:
    """Return the explicitly wired operator, or fail closed.

    Task 7 owns process wiring.  Keeping the check here means a workbench never
    reports accounts as ready merely because the SQL tables exist.
    """

    state = request.app.state
    configured = getattr(state, "public_outreach_operator_configured", None)
    operator = getattr(state, "public_outreach_operator", None)
    if configured is None:
        configured = bool(operator is not None and getattr(operator, "configured", True))
    if not configured or operator is None:
        raise HTTPException(status_code=503, detail="Public outreach operator is not configured")
    return operator


async def _user_id(request: Request) -> str:
    value = await get_current_user(request)
    if value is None:
        raise HTTPException(status_code=401, detail="Authentication required")
    return value


def _redact(value: Any, *, key: str = "") -> Any:
    """Bounded recursive redaction for provider metadata and receipts."""

    normalized_key = key.lower()
    if normalized_key in _REDACTED_PATH_KEYS or any(part in normalized_key for part in _REDACTED_KEY_PARTS):
        return None
    if isinstance(value, dict):
        result: dict[str, Any] = {}
        for child_key, child_value in value.items():
            redacted = _redact(child_value, key=str(child_key))
            if redacted is not None:
                result[str(child_key)] = redacted
        return result
    if isinstance(value, list):
        return [_redact(item, key=key) for item in value]
    if isinstance(value, datetime):
        return value.astimezone(UTC).isoformat()
    return value


def _account_response(account: dict[str, Any]) -> dict[str, Any]:
    capabilities = _redact(account.get("capabilities_json") or account.get("capabilities") or {}, key="capabilities")
    return {
        "sender_account_id": account.get("sender_account_id"),
        "channel": account.get("channel"),
        "status": account.get("status"),
        "health": account.get("health") or account.get("status"),
        "device_ref": account.get("device_ref"),
        "capabilities": capabilities or {},
        "last_health_at": _redact(account.get("last_health_at"), key="last_health_at"),
    }


def _task_response(task: dict[str, Any], receipts: list[dict[str, Any]], model: dict[str, Any] | None) -> dict[str, Any]:
    latest = receipts[0] if receipts else None
    latest_payload = (latest or {}).get("payload_json") or {}
    manual_reason = task.get("error_code")
    if latest_payload.get("manual_required"):
        manual_reason = latest_payload.get("error_code") or latest_payload.get("message") or manual_reason
    sequence = next(
        (row for row in (model or {}).get("sequences", []) if row.get("sequence_no") == task.get("sequence_no")),
        None,
    )
    return {
        "task_id": task.get("task_id"),
        "creator_uid": task.get("creator_uid"),
        "sequence_no": task.get("sequence_no"),
        "sender_account_id": task.get("sender_account_id"),
        "action": task.get("action"),
        "current_action": task.get("action"),
        "state": task.get("state"),
        "attempt_count": task.get("attempt_count", 0),
        "error_code": task.get("error_code"),
        "receipt_state": ("verified" if latest and latest.get("verified") else "unknown" if latest else "unavailable"),
        "manual_takeover_reason": manual_reason,
        "sequence_status": sequence.get("status") if sequence else None,
        "payload": _redact(task.get("payload_json") or {}, key="payload"),
        "receipts": [_redact(receipt, key="receipt") for receipt in receipts],
    }


def _public_task(task: dict[str, Any]) -> dict[str, Any]:
    return {key: _redact(value, key=key) for key, value in task.items() if key != "owner_user_id"}


async def _receipts(repository: CreatorOutreachRepository, task: dict[str, Any]) -> list[dict[str, Any]]:
    session_factory = getattr(repository, "session_factory", None)
    if session_factory is None:
        return []
    async with session_factory() as session:
        rows = (
            (
                await session.execute(
                    select(CreatorOutreachReceiptRow)
                    .where(
                        CreatorOutreachReceiptRow.owner_user_id == task["owner_user_id"],
                        CreatorOutreachReceiptRow.creator_uid == task["creator_uid"],
                        CreatorOutreachReceiptRow.sequence_no == task["sequence_no"],
                    )
                    .order_by(desc(CreatorOutreachReceiptRow.created_at))
                )
            )
            .scalars()
            .all()
        )
        return [row.to_dict() for row in rows]


async def _owned_task(
    request: Request,
    task_id: str,
) -> tuple[CreatorOutreachRepository, str, dict[str, Any], list[dict[str, Any]], dict[str, Any] | None]:
    repository = _repository(request)
    owner_user_id = await _user_id(request)
    task = await repository.read_action_task(task_id)
    if task is None or task.get("owner_user_id") != owner_user_id:
        raise HTTPException(status_code=404, detail="Public outreach task not found")
    receipts = await _receipts(repository, task)
    model = await repository.read_model(owner_user_id=owner_user_id, creator_uid=task["creator_uid"])
    return repository, owner_user_id, task, receipts, model


async def _operator_accounts(operator: Any, owner_user_id: str) -> list[dict[str, Any]]:
    for method_name in ("list_accounts", "list_sender_accounts", "accounts"):
        method = getattr(operator, method_name, None)
        if callable(method):
            try:
                result = await method(owner_user_id=owner_user_id)
            except TypeError:
                result = await method(owner_user_id)
            if isinstance(result, dict):
                result = result.get("accounts", [])
            return list(result or [])
    return []


@router.get("/accounts")
@require_permission("threads", "read")
async def list_outreach_accounts(request: Request) -> dict[str, Any]:
    operator = _operator(request)
    owner_user_id = await _user_id(request)
    repository = _repository(request)
    persisted = await repository.list_sender_accounts(owner_user_id)
    operator_accounts = await _operator_accounts(operator, owner_user_id)
    by_id = {row["sender_account_id"]: row for row in persisted}
    for row in operator_accounts:
        if isinstance(row, dict) and row.get("sender_account_id") and row.get("owner_user_id") in {None, owner_user_id}:
            by_id[row["sender_account_id"]] = {**by_id.get(row["sender_account_id"], {}), **row}
    accounts = [_account_response(row) for row in by_id.values()]
    web_accounts = [row for row in accounts if row.get("channel") == "web"]
    ios_accounts = [row for row in accounts if row.get("channel") == "ios"]
    return {
        "accounts": accounts,
        "web_batch_capacity": {
            "registered": len(web_accounts),
            "maximum": 50,
            "active_limit": 10,
            "active": sum(row.get("status") in _ACTIVE_ACCOUNT_STATUSES for row in web_accounts),
        },
        "ios_readiness": {
            "registered": len(ios_accounts),
            "ready": sum(row.get("health") in {"healthy", "ready", "active"} for row in ios_accounts),
        },
        "operator": {"configured": True},
    }


@router.post("/tasks")
@require_permission("threads", "write")
async def create_outreach_tasks(request: Request, body: CreateOutreachTaskRequest) -> dict[str, Any]:
    _operator(request)
    repository = _repository(request)
    owner_user_id = await _user_id(request)
    model = await repository.read_model(owner_user_id=owner_user_id, creator_uid=body.creator_uid)
    if model is None:
        raise HTTPException(status_code=404, detail="Creator must be claimed before outreach")
    sequence = next(
        (row for row in model["sequences"] if row["sequence_no"] == body.sequence_no),
        None,
    )
    if sequence is None:
        raise HTTPException(status_code=404, detail="Outreach sequence not found")
    if sequence["sender_account_id"] != body.sender_account_id:
        raise HTTPException(status_code=409, detail="Sender account differs from the fixed outreach sequence")
    if sequence["status"] == "closed" or model["claim"]["status"] == "closed":
        raise HTTPException(status_code=409, detail="Closed creator sequences cannot be retried")
    sender = await repository.read_sender_account(owner_user_id, body.sender_account_id)
    if sender is None:
        raise HTTPException(status_code=404, detail="Sender account not found")
    if sender.get("status") not in _ACTIVE_ACCOUNT_STATUSES:
        raise HTTPException(status_code=409, detail="Sender account is not healthy")
    payload = {"comment": body.comment, "message": body.message}
    workflow = PublicOutreachWorkflow(repository)
    try:
        tasks = await workflow.create_public_outreach_tasks(
            owner_user_id,
            body.creator_uid,
            body.sequence_no,
            body.sender_account_id,
            body.actions,
        )
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    # The repository owns task identity and idempotency.  Text belongs in the
    # task payload, so persist it after the workflow creates the fixed action
    # set without ever mixing it into an idempotency key.
    if payload["comment"] is not None or payload["message"] is not None:
        session_factory = getattr(repository, "session_factory", None)
        if session_factory is None:
            raise HTTPException(status_code=503, detail="Public outreach persistence is not configured")
        async with session_factory() as session:
            for task in tasks:
                await session.execute(update(CreatorOutreachActionTaskRow).where(CreatorOutreachActionTaskRow.task_id == task["task_id"]).values(payload_json={**(task.get("payload_json") or {}), **payload}))
            await session.commit()
        tasks = [await repository.read_action_task(task["task_id"]) or task for task in tasks]
    return {"tasks": [_public_task(task) for task in tasks], "creator_uid": body.creator_uid, "sequence_no": body.sequence_no}


@router.get("/tasks")
@require_permission("threads", "read")
async def list_outreach_tasks(
    request: Request,
    creator_uid: str | None = None,
    sequence_no: int | None = None,
) -> dict[str, Any]:
    _operator(request)
    repository = _repository(request)
    owner_user_id = await _user_id(request)
    if not creator_uid or sequence_no is None:
        raise HTTPException(status_code=422, detail="creator_uid and sequence_no are required")
    rows = await repository.list_action_tasks(owner_user_id, creator_uid, sequence_no)
    if rows and any(row.get("owner_user_id") != owner_user_id for row in rows):
        raise HTTPException(status_code=404, detail="Public outreach tasks not found")
    receipts_by_task: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        receipts_by_task[row["task_id"]] = await _receipts(repository, row)
    model = await repository.read_model(owner_user_id=owner_user_id, creator_uid=creator_uid)
    return {"tasks": [_task_response(row, receipts_by_task[row["task_id"]], model) for row in rows]}


@router.get("/tasks/{task_id}")
@require_permission("threads", "read")
async def get_outreach_task(task_id: str, request: Request) -> dict[str, Any]:
    _operator(request)
    _, _, task, receipts, model = await _owned_task(request, task_id)
    return _task_response(task, receipts, model)


async def _reset_task(repository: CreatorOutreachRepository, task: dict[str, Any], *, error_code: str | None = None) -> dict[str, Any]:
    session_factory = getattr(repository, "session_factory", None)
    if session_factory is None:
        raise HTTPException(status_code=503, detail="Public outreach persistence is not configured")
    values: dict[str, Any] = {
        "state": "pending",
        "lease_until": None,
        "lease_owner": None,
        "lease_token": None,
        "error_code": error_code,
        "updated_at": datetime.now(UTC),
    }
    async with session_factory() as session:
        await session.execute(update(CreatorOutreachActionTaskRow).where(CreatorOutreachActionTaskRow.task_id == task["task_id"]).values(**values))
        await session.commit()
    refreshed = await repository.read_action_task(task["task_id"])
    if refreshed is None:
        raise HTTPException(status_code=404, detail="Public outreach task not found")
    return refreshed


@router.post("/tasks/{task_id}/retry")
@require_permission("threads", "write")
async def retry_outreach_task(task_id: str, request: Request, body: RetryTaskRequest | None = None) -> dict[str, Any]:
    _operator(request)
    repository, _, task, receipts, model = await _owned_task(request, task_id)
    if task["state"] == "completed" or any(receipt.get("verified") for receipt in receipts):
        raise HTTPException(status_code=409, detail="Verified outreach actions cannot be duplicated")
    latest = receipts[0] if receipts else None
    latest_payload = (latest or {}).get("payload_json") or {}
    error_code = task.get("error_code") or latest_payload.get("error_code")
    if task["state"] == "leased":
        raise HTTPException(status_code=409, detail="Outreach task is currently leased")
    if task["state"] == "failed" and error_code not in _RECOVERABLE_ERRORS:
        raise HTTPException(status_code=409, detail="Only recoverable failures may be retried")
    if task["state"] == "pending" and not latest_payload.get("manual_required") and error_code not in _RECOVERABLE_ERRORS:
        raise HTTPException(status_code=409, detail="Retry requires an explicit unknown or recoverable failure")
    refreshed = await _reset_task(repository, task)
    receipts = await _receipts(repository, refreshed)
    return _task_response(refreshed, receipts, model)


@router.post("/accounts/{sender_account_id}/pause")
@require_permission("threads", "write")
async def pause_outreach_account(sender_account_id: str, request: Request, body: ManualReasonRequest) -> dict[str, Any]:
    _operator(request)
    owner_user_id = await _user_id(request)
    repository = _repository(request)
    return await _set_account_status(repository, owner_user_id, sender_account_id, "paused", body.reason)


@router.post("/accounts/{sender_account_id}/resume")
@require_permission("threads", "write")
async def resume_outreach_account(sender_account_id: str, request: Request, body: ManualReasonRequest | None = None) -> dict[str, Any]:
    _operator(request)
    owner_user_id = await _user_id(request)
    repository = _repository(request)
    return await _set_account_status(repository, owner_user_id, sender_account_id, "enabled", (body.reason if body else "operator_resume"))


async def _set_account_status(
    repository: CreatorOutreachRepository,
    owner_user_id: str,
    sender_account_id: str,
    status: str,
    reason: str,
) -> dict[str, Any]:
    session_factory = getattr(repository, "session_factory", None)
    if session_factory is None:
        raise HTTPException(status_code=503, detail="Public outreach persistence is not configured")
    async with session_factory() as session:
        row = await session.get(SenderAccountRow, (owner_user_id, sender_account_id))
        if row is None:
            raise HTTPException(status_code=404, detail="Sender account not found")
        row.status = status
        row.capabilities_json = {
            **(row.capabilities_json or {}),
            "last_operator_reason": reason,
        }
        row.updated_at = datetime.now(UTC)
        await session.commit()
        return _account_response(row.to_dict())


@router.post("/tasks/{task_id}/takeover")
@require_permission("threads", "write")
async def request_manual_takeover(task_id: str, request: Request, body: ManualReasonRequest) -> dict[str, Any]:
    _operator(request)
    repository, _, task, _, model = await _owned_task(request, task_id)
    refreshed = await _reset_task(repository, task, error_code="manual_takeover")
    refreshed["state"] = "failed"
    refreshed["error_code"] = body.reason
    # Persist the manual boundary after resetting any stale lease.
    session_factory = getattr(repository, "session_factory", None)
    if session_factory is not None:
        async with session_factory() as session:
            await session.execute(update(CreatorOutreachActionTaskRow).where(CreatorOutreachActionTaskRow.task_id == task_id).values(state="failed", error_code=body.reason, updated_at=datetime.now(UTC)))
            await session.commit()
    refreshed = await repository.read_action_task(task_id) or refreshed
    return _task_response(refreshed, await _receipts(repository, refreshed), model)


@router.post("/tasks/{task_id}/unknown")
@require_permission("threads", "write")
async def mark_provider_unknown(task_id: str, request: Request, body: ManualReasonRequest) -> dict[str, Any]:
    """Persist an explicit provider-unknown receipt and leave the task retryable."""

    _operator(request)
    repository, _, task, receipts, model = await _owned_task(request, task_id)
    if task["state"] == "completed" or any(receipt.get("verified") for receipt in receipts):
        raise HTTPException(status_code=409, detail="Verified outreach actions cannot be marked unknown")
    kind = "dm_receipt" if task["action"] == "message" else "public_action_receipt"
    try:
        await repository.record_receipt(
            owner_user_id=task["owner_user_id"],
            creator_uid=task["creator_uid"],
            sequence_no=task["sequence_no"],
            receipt_id=f"unknown:{task['task_id']}:{task.get('attempt_count', 0)}",
            kind=kind,
            provider_ref=None,
            verification_source="operator_unknown",
            payload={
                "receipt_type": "provider_unknown",
                "action": task["action"],
                "error_code": "provider_unknown",
                "message": body.reason,
                "manual_required": True,
            },
            verified=False,
        )
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    refreshed = await _reset_task(repository, task, error_code="provider_unknown")
    return _task_response(refreshed, await _receipts(repository, refreshed), model)


@router.post("/sequences/close")
@require_permission("threads", "write")
async def close_outreach_sequence(request: Request, body: CloseSequenceRequest) -> dict[str, Any]:
    _operator(request)
    repository = _repository(request)
    owner_user_id = await _user_id(request)
    model = await repository.read_model(owner_user_id=owner_user_id, creator_uid=body.creator_uid)
    if model is None or not any(row["sequence_no"] == body.sequence_no for row in model["sequences"]):
        raise HTTPException(status_code=404, detail="Outreach sequence not found")
    receipt = await repository.record_receipt(
        owner_user_id=owner_user_id,
        creator_uid=body.creator_uid,
        sequence_no=body.sequence_no,
        receipt_id=f"closure:{owner_user_id}:{body.creator_uid}:{body.sequence_no}",
        kind="closure_receipt",
        provider_ref=None,
        verification_source="operator_manual",
        payload={"receipt_type": "closure_receipt", "reason": body.reason},
        verified=True,
    )
    try:
        claim = await repository.advance_state(
            owner_user_id=owner_user_id,
            creator_uid=body.creator_uid,
            sequence_no=body.sequence_no,
            receipt_id=receipt["receipt_id"],
            next_status="closed",
        )
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {"claim": _redact(claim, key="claim"), "receipt": _redact(receipt, key="receipt")}


__all__ = ["router"]
