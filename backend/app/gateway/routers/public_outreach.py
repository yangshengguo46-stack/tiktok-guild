"""Control-plane API for the native public creator outreach workflow.

The router only exposes DeerFlow-owned state.  Provider execution stays behind
the configured public-outreach operator and every response is owner-scoped and
redacted before it crosses the Gateway boundary.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.gateway.authz import require_permission
from app.gateway.deps import get_current_user, require_admin_user
from deerflow.creator_agent.public_outreach import PublicOutreachWorkflow
from deerflow.persistence.creator_agent_relationship import CreatorOutreachRepository
from deerflow.persistence.engine import get_session_factory


async def _resolve_native_internal_owner(request: Request) -> None:
    """Existing internal auth identifies transport; real User owns permissions."""
    from starlette.datastructures import Headers

    from app.gateway.auth_disabled import AUTH_SOURCE_SESSION
    from app.gateway.deps import get_local_provider
    from app.gateway.internal_auth import INTERNAL_AUTH_HEADER_NAME, INTERNAL_OWNER_USER_ID_HEADER_NAME, is_valid_internal_auth_token

    token = request.headers.get(INTERNAL_AUTH_HEADER_NAME)
    if token is None:
        return  # An unauthenticated owner header conveys no identity.
    if not is_valid_internal_auth_token(token):
        raise HTTPException(status_code=401, detail="Authentication required")
    owner = (request.headers.get(INTERNAL_OWNER_USER_ID_HEADER_NAME) or "").strip()
    if not owner:
        raise HTTPException(status_code=401, detail="Authenticated owner is required")
    from app.gateway.auth_disabled import get_auth_disabled_user, is_auth_disabled

    synthetic = get_auth_disabled_user()
    if is_auth_disabled() and owner == str(synthetic.id):
        user = synthetic
    else:
        user = await get_local_provider().get_user(owner)
    if user is None:
        raise HTTPException(status_code=401, detail="Authenticated owner is unavailable")
    request.state.user = user
    request.state.auth_source = AUTH_SOURCE_SESSION
    request.state.auth = None
    # Keep route authorization on the real user path. The generic internal
    # role has transport privilege elsewhere, not outreach admin privilege.
    internal_names = {INTERNAL_AUTH_HEADER_NAME.lower().encode(), INTERNAL_OWNER_USER_ID_HEADER_NAME.lower().encode()}
    request.scope["headers"] = [(key, value) for key, value in request.scope["headers"] if key.lower() not in internal_names]
    request._headers = Headers(scope=request.scope)


router = APIRouter(prefix="/api/public-outreach", tags=["public-outreach"], dependencies=[Depends(_resolve_native_internal_owner)])

_ACTIVE_ACCOUNT_STATUSES = frozenset({"enabled", "healthy", "ready", "active"})
_RECOVERABLE_ERRORS = frozenset(
    {
        "unknown",
        "provider_unknown",
        "external_attempt_unknown",
        "receipt_persistence_failed",
        "cancelled",
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
    "auth",
    "bearer",
    "api_key",
    "private_key",
    "access_key",
    "user_data_dir",
    "profile_path",
    "profile",
    "storage",
    "session",
    "path",
)
_REDACTED_PATH_KEYS = frozenset(
    {
        "profile_ref",
        "profile_path",
        "profile_url",
        "profile_dir",
        "storage_state",
        "cookies",
        "auth_metadata",
    }
)
_ADMIN_REQUIRED_DETAIL = "Admin privileges are required to manage public outreach."


class CreateOutreachTaskRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
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
    lease_owner: str | None = Field(default=None, min_length=1, max_length=128, exclude=True)
    lease_token: str | None = Field(default=None, min_length=1, max_length=128, exclude=True)


class ManualReasonRequest(BaseModel):
    reason: str = Field(min_length=1, max_length=500)
    lease_owner: str | None = Field(default=None, min_length=1, max_length=128, exclude=True)
    lease_token: str | None = Field(default=None, min_length=1, max_length=128, exclude=True)


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


async def _require_outreach_admin(request: Request) -> None:
    await require_admin_user(request, detail=_ADMIN_REQUIRED_DETAIL)


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
    return {key: _redact(value, key=key) for key, value in task.items() if key not in {"owner_user_id", "lease_owner", "lease_token", "lease_until"}}


async def _receipts(repository: CreatorOutreachRepository, task: dict[str, Any]) -> list[dict[str, Any]]:
    receipt = await repository.read_action_receipt(task["owner_user_id"], task["task_id"])
    return [receipt] if receipt is not None else []


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
        if isinstance(row, dict) and row.get("sender_account_id") and row.get("owner_user_id") == owner_user_id:
            by_id[row["sender_account_id"]] = {**by_id.get(row["sender_account_id"], {}), **row}
    accounts = [_account_response(row) for row in by_id.values()]
    capacity = await operator.capacity() if callable(getattr(operator, "capacity", None)) else {"active": 0}
    web_accounts = [row for row in accounts if row.get("channel") == "web"]
    ios_accounts = [row for row in accounts if row.get("channel") == "ios"]
    return {
        "accounts": accounts,
        "web_batch_capacity": {
            "registered": len(web_accounts),
            "maximum": 50,
            "active_limit": 10,
            "active": capacity["active"],
            "ready": sum(row.get("status") in _ACTIVE_ACCOUNT_STATUSES for row in web_accounts),
        },
        "ios_readiness": {
            "registered": len(ios_accounts),
            "ready": sum(row.get("health") in {"healthy", "ready", "active"} for row in ios_accounts),
        },
        "operator": {"configured": True, "external_writes_enabled": getattr(operator, "config", {}).get("pilot", {}).get("enabled") is True},
    }


@router.post("/tasks")
@require_permission("threads", "write")
async def create_outreach_tasks(request: Request, body: CreateOutreachTaskRequest) -> dict[str, Any]:
    await _require_outreach_admin(request)
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
        try:
            tasks = [await repository.update_action_payload(owner_user_id, task["task_id"], payload) for task in tasks]
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
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


@router.post("/tasks/{task_id}/retry")
@require_permission("threads", "write")
async def retry_outreach_task(task_id: str, request: Request, body: RetryTaskRequest | None = None) -> dict[str, Any]:
    await _require_outreach_admin(request)
    _operator(request)
    repository, owner_user_id, task, _, model = await _owned_task(request, task_id)
    try:
        refreshed = await repository.retry_action(
            owner_user_id,
            task["task_id"],
            recoverable_error_codes=_RECOVERABLE_ERRORS,
            lease_owner=body.lease_owner if body else None,
            lease_token=body.lease_token if body else None,
        )
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    receipts = await _receipts(repository, refreshed)
    return _task_response(refreshed, receipts, model)


@router.post("/accounts/{sender_account_id}/pause")
@require_permission("threads", "write")
async def pause_outreach_account(sender_account_id: str, request: Request, body: ManualReasonRequest) -> dict[str, Any]:
    await _require_outreach_admin(request)
    _operator(request)
    owner_user_id = await _user_id(request)
    repository = _repository(request)
    if await repository.read_sender_account(owner_user_id, sender_account_id) is None:
        raise HTTPException(status_code=404, detail="Sender account not found")
    operator = _operator(request)
    if callable(getattr(operator, "cancel_account", None)):
        await operator.cancel_account(owner_user_id, sender_account_id)
    return await _set_account_status(repository, owner_user_id, sender_account_id, "paused", body.reason)


@router.post("/accounts/{sender_account_id}/resume")
@require_permission("threads", "write")
async def resume_outreach_account(sender_account_id: str, request: Request, body: ManualReasonRequest | None = None) -> dict[str, Any]:
    await _require_outreach_admin(request)
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
    try:
        row = await repository.set_sender_account_status(
            owner_user_id,
            sender_account_id,
            status=status,
            reason=reason,
        )
    except ValueError as exc:
        if "does not exist" in str(exc):
            raise HTTPException(status_code=404, detail="Sender account not found") from exc
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return _account_response(row)


@router.post("/tasks/{task_id}/takeover")
@require_permission("threads", "write")
async def request_manual_takeover(task_id: str, request: Request, body: ManualReasonRequest) -> dict[str, Any]:
    await _require_outreach_admin(request)
    _operator(request)
    repository, owner_user_id, _, _, model = await _owned_task(request, task_id)
    await _cancel_execution(request, task_id)
    try:
        refreshed = await repository.request_manual_takeover(
            owner_user_id,
            task_id,
            reason=body.reason,
            lease_owner=body.lease_owner,
            lease_token=body.lease_token,
        )
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return _task_response(refreshed, await _receipts(repository, refreshed), model)


@router.post("/tasks/{task_id}/unknown")
@require_permission("threads", "write")
async def mark_provider_unknown(task_id: str, request: Request, body: ManualReasonRequest) -> dict[str, Any]:
    """Persist an explicit provider-unknown receipt and leave the task retryable."""

    await _require_outreach_admin(request)
    _operator(request)
    repository, owner_user_id, task, _, model = await _owned_task(request, task_id)
    await _cancel_execution(request, task_id)
    try:
        refreshed = await repository.mark_action_unknown(
            owner_user_id,
            task_id,
            receipt_id=f"unknown:{task['task_id']}:{task.get('attempt_count', 0)}",
            reason=body.reason,
            lease_owner=body.lease_owner,
            lease_token=body.lease_token,
        )
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return _task_response(refreshed, await _receipts(repository, refreshed), model)


@router.post("/sequences/close")
@require_permission("threads", "write")
async def close_outreach_sequence(request: Request, body: CloseSequenceRequest) -> dict[str, Any]:
    await _require_outreach_admin(request)
    _operator(request)
    repository = _repository(request)
    owner_user_id = await _user_id(request)
    operator = _operator(request)
    if callable(getattr(operator, "cancel_sequence", None)):
        await operator.cancel_sequence(owner_user_id, body.creator_uid, body.sequence_no)
    try:
        result = await repository.close_sequence(
            owner_user_id,
            body.creator_uid,
            body.sequence_no,
            reason=body.reason,
        )
    except ValueError as exc:
        status_code = 404 if "does not exist" in str(exc) else 409
        raise HTTPException(status_code=status_code, detail=str(exc)) from exc
    return _redact(result, key="close_sequence")


__all__ = ["router"]


async def _cancel_execution(request: Request, task_id: str) -> None:
    operator = _operator(request)
    if callable(getattr(operator, "cancel_task", None)):
        await operator.cancel_task(task_id)


@router.post("/tasks/{task_id}/execute")
@require_permission("threads", "write")
async def execute_outreach_task(task_id: str, request: Request) -> dict[str, Any]:
    import asyncio

    await _require_outreach_admin(request)
    repository, owner, _, _, _ = await _owned_task(request, task_id)
    operator = _operator(request)
    if not callable(getattr(operator, "execute_task", None)):
        raise HTTPException(status_code=503, detail="Public outreach execution is unavailable")
    execution = asyncio.create_task(operator.execute_task(owner, task_id))

    async def disconnected() -> None:
        while not execution.done():
            if await request.is_disconnected():
                await operator.cancel_task(task_id)
                return
            await asyncio.sleep(0.2)

    monitor = asyncio.create_task(disconnected())
    try:
        result = await execution
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    finally:
        monitor.cancel()
        await asyncio.gather(monitor, return_exceptions=True)
    _, _, task, receipts, model = await _owned_task(request, task_id)
    return {**_task_response(task, receipts, model), "execution_status": result.get("status"), "error_code": result.get("error_code") or task.get("error_code")}


class RegisterSenderRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    sender_account_id: str = Field(min_length=1, max_length=128)
    channel: Literal["web", "ios"]
    external_ref: str = Field(min_length=1, max_length=255)
    device_ref: str | None = Field(default=None, max_length=128)


@router.post("/native/{method}")
@require_permission("threads", "read")
async def native_outreach_adapter(method: str, request: Request, body: dict[str, Any]) -> dict[str, Any]:
    from pydantic import ValidationError

    methods = {"listSenderAccounts", "registerSenderAccount", "healthSenderAccount", "disableSenderAccount", "enqueueAction", "getAction", "claimAction", "executeAction", "completeAction", "failAction", "reconcileActions"}
    if method not in methods:
        raise HTTPException(status_code=404, detail="Native outreach method not found")
    forbidden = {"owner_user_id", "receipt", "receipt_payload", "verified", "provider_ref", "verification_source", "lease_owner", "lease_token", "_external_attempt_started", "_external_attempt_token", "manual_required"}
    if forbidden.intersection(body):
        raise HTTPException(status_code=422, detail="Caller identity, receipts and execution leases cannot be supplied")
    reads = {"listSenderAccounts", "healthSenderAccount", "getAction", "reconcileActions"}
    if method not in reads:
        # The nested write decorator performs the same permission check as the
        # workbench; the admin check additionally narrows management writes.
        await _require_outreach_admin(request)
        from app.gateway.authz import resolve_route_permissions_for_request

        user = request.state.user
        if "threads:write" not in await resolve_route_permissions_for_request(request, user):
            raise HTTPException(status_code=403, detail="Permission denied: threads:write")
    owner = await _user_id(request)
    repository = _repository(request)
    _operator(request)
    if method == "listSenderAccounts":
        return await list_outreach_accounts(request)
    if method == "registerSenderAccount":
        try:
            registration = RegisterSenderRequest.model_validate(body)
            row = await repository.register_sender_account(owner, **registration.model_dump())
        except (ValueError, ValidationError) as exc:
            raise HTTPException(status_code=422, detail="Invalid sender registration") from exc
        return _account_response(row)
    if method in {"healthSenderAccount", "disableSenderAccount"}:
        sender = body.get("sender_account_id")
        row = await repository.read_sender_account(owner, sender or "")
        if row is None:
            raise HTTPException(status_code=404, detail="Sender account not found")
        if method == "disableSenderAccount":
            operator = _operator(request)
            if callable(getattr(operator, "cancel_account", None)):
                await operator.cancel_account(owner, sender)
            return await _set_account_status(repository, owner, sender, "paused", "operator_disable")
        return _account_response(row)
    if method == "enqueueAction":
        try:
            definition = CreateOutreachTaskRequest.model_validate(body)
        except ValidationError as exc:
            raise HTTPException(status_code=422, detail="Invalid outreach task definition") from exc
        return await create_outreach_tasks(request, definition)
    if method == "reconcileActions":
        return await list_outreach_tasks(request, body.get("creator_uid"), body.get("sequence_no"))
    task_id = body.get("task_id")
    if not isinstance(task_id, str) or not task_id:
        raise HTTPException(status_code=422, detail="task_id is required")
    _, _, task, receipts, model = await _owned_task(request, task_id)
    if method == "claimAction":
        raise HTTPException(status_code=409, detail="Task leases belong to the native executor; use explicit execute for provider writes")
    if method == "executeAction":
        return await execute_outreach_task(task_id, request)
    if method == "completeAction" and task["state"] != "completed":
        raise HTTPException(status_code=409, detail="Completion requires the trusted executor receipt")
    if method == "failAction":
        try:
            reason = ManualReasonRequest(reason=body.get("reason") or "operator_unknown")
        except ValidationError as exc:
            raise HTTPException(status_code=422, detail="Invalid manual review reason") from exc
        return await mark_provider_unknown(task_id, request, reason)
    return _task_response(task, receipts, model)
