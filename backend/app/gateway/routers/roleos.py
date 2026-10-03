"""Host-only RoleOS admission for the native Guild/Sales social owner."""

from __future__ import annotations

import asyncio
import hashlib
import json
from collections.abc import Mapping
from dataclasses import asdict
from typing import Annotated, Any, BinaryIO, Literal
from urllib.parse import quote, urlencode

from anyio import CancelScope
from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import AliasChoices, BaseModel, ConfigDict, Field, StringConstraints, field_validator

from app.channels.social import SocialInternalWork
from app.gateway.auth_disabled import AUTH_SOURCE_INTERNAL
from app.gateway.deps import get_run_event_store, get_run_manager
from app.gateway.internal_auth import INTERNAL_AUTH_HEADER_NAME, is_valid_internal_auth_token
from app.gateway.path_utils import normalize_outputs_virtual_path
from app.gateway.run_models import RunCreateRequest
from app.gateway.services import admit_registered_roleos_social_work, resolve_registered_roleos_social_connection, start_run
from deerflow.runtime.delivery import ARTIFACT_INTEGRITY_VERSION, read_attested_output, verify_attested_output

router = APIRouter(prefix="/api/internal/roleos", tags=["roleos"])

_Text = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=128)]


class RoleOSSocialRunRequest(BaseModel):
    """Business-only RoleOS work envelope.

    The registered ``SocialConnection`` supplies provider/account/owner,
    scope, persona, relationship and MCP authority.  Those fields are
    intentionally forbidden here, including all client binding carriers.
    """

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    company_id: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=128)]
    member_id: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=128)]
    request_id: _Text
    source_revision: _Text
    connection_id: _Text
    thread_id: _Text = Field(validation_alias=AliasChoices("thread_id", "target_thread_id"))
    objective: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=32_000)]
    input_refs: list[Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=2_048)]] = Field(default_factory=list, max_length=64)
    artifact_refs: list[Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=2_048)]] = Field(default_factory=list, max_length=64)
    evidence_refs: list[Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=2_048)]] = Field(default_factory=list, max_length=64)
    acceptance_criteria: list[Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=2_048)]] = Field(default_factory=list, max_length=64)
    sender_member_id: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=128)] | None = None

    @field_validator("input_refs", "artifact_refs", "evidence_refs", "acceptance_criteria")
    @classmethod
    def reject_duplicate_refs(cls, values: list[str]) -> list[str]:
        if len(values) != len(set(values)):
            raise ValueError("RoleOS work references must be unique")
        return values


class RoleOSSocialRunResponse(BaseModel):
    run_id: str
    thread_id: str
    request_id: str
    source_revision: str
    status: Literal["accepted", "unknown", "succeeded", "failed"] = "accepted"
    error: str | None = None
    artifact_refs: list[str] = Field(default_factory=list)
    evidence_refs: list[str] = Field(default_factory=list)
    native_receipt_ref: str | None = None
    native_receipt: dict[str, Any] | None = None


def _require_internal_roleos_request(request: Request) -> None:
    if getattr(getattr(request, "state", None), "auth_source", None) == AUTH_SOURCE_INTERNAL:
        return
    headers = getattr(request, "headers", {})
    if is_valid_internal_auth_token(headers.get(INTERNAL_AUTH_HEADER_NAME)):
        return
    raise HTTPException(status_code=403, detail="RoleOS admission requires authenticated internal launch")


def _validate_work(body: RoleOSSocialRunRequest, connection: object) -> None:
    binding = getattr(connection, "roleos_binding", None)
    if binding is None:
        raise HTTPException(status_code=503, detail="RoleOS social connection has no registered employee binding")
    if body.company_id != binding.company_id or body.member_id != binding.member_id:
        raise HTTPException(status_code=409, detail="RoleOS identity does not match the registered Guild/Sales employee")
    if body.source_revision != binding.source_revision:
        raise HTTPException(status_code=409, detail="RoleOS source revision does not match the registered social employee")
    if body.thread_id != binding.thread_id or body.thread_id != getattr(connection, "thread_id", None):
        raise HTTPException(status_code=409, detail="RoleOS target thread does not match the registered social connection")


def _native_run_body(body: RoleOSSocialRunRequest, connection: object) -> RunCreateRequest:
    binding = connection.roleos_binding
    graph_input: dict[str, object] = {"messages": [{"role": "user", "content": body.objective}]}
    if body.input_refs:
        graph_input["input_refs"] = list(body.input_refs)
    if body.artifact_refs:
        graph_input["artifact_refs"] = list(body.artifact_refs)
    if body.evidence_refs:
        graph_input["evidence_refs"] = list(body.evidence_refs)
    metadata: dict[str, object] = {
        "roleos_provenance": "roleos_social_work",
        "roleos_company_id": binding.company_id,
        "roleos_member_id": binding.member_id,
        "roleos_request_id": body.request_id,
        "roleos_source_revision": binding.source_revision,
        "roleos_connection_id": body.connection_id,
        "roleos_work_fingerprint": _work_fingerprint(body),
        "roleos_social_scope_fingerprint": _connection_fingerprint(connection),
    }
    if body.sender_member_id is not None:
        metadata["roleos_sender_member_id"] = body.sender_member_id
    if body.acceptance_criteria:
        metadata["roleos_acceptance_criteria"] = list(body.acceptance_criteria)
    return RunCreateRequest(
        assistant_id=binding.assistant_id,
        input=graph_input,
        metadata=metadata,
        context={"non_interactive": True},
        on_disconnect="continue",
        multitask_strategy="reject",
    )


@router.post("/sales/runs", response_model=RoleOSSocialRunResponse, status_code=202)
@router.post("/guild/runs", response_model=RoleOSSocialRunResponse, status_code=202)
@router.post("/social/runs", response_model=RoleOSSocialRunResponse, status_code=202)
async def admit_roleos_social_run(body: RoleOSSocialRunRequest, request: Request) -> RoleOSSocialRunResponse:
    """Admit one typed RoleOS work request onto the registered social scope."""
    _require_internal_roleos_request(request)
    connection = resolve_registered_roleos_social_connection(request, body.connection_id)
    _validate_work(body, connection)
    existing = await get_run_manager(request).get_by_idempotency_key(f"roleos-social:{body.request_id}", user_id=connection.scope.owner_user_id)
    if existing is not None:
        _validate_reuse(existing, body, connection)
        return RoleOSSocialRunResponse(run_id=existing.run_id, thread_id=existing.thread_id, request_id=body.request_id, source_revision=body.source_revision)
    work = SocialInternalWork(body.request_id, body.objective, tuple(body.input_refs), tuple(body.artifact_refs))
    binding = await admit_registered_roleos_social_work(request, body.connection_id, work)
    record = await start_run(
        _native_run_body(body, connection),
        binding.roleos_binding.thread_id,
        request,
        social_binding=binding,
        idempotency_key=f"roleos-social:{body.request_id}",
        require_existing_thread=True,
    )
    if getattr(record, "idempotency_reused", False):
        _validate_reuse(record, body, connection)
    return RoleOSSocialRunResponse(run_id=record.run_id, thread_id=record.thread_id, request_id=body.request_id, source_revision=binding.roleos_binding.source_revision)


def _work_fingerprint(body: RoleOSSocialRunRequest) -> str:
    return hashlib.sha256(json.dumps(body.model_dump(), sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


def _connection_fingerprint(connection: object) -> str:
    """Freeze host connection authority without persisting a runtime capability."""
    values = {
        "scope": asdict(connection.scope),
        "identity": asdict(connection.identity),
        "role": asdict(connection.role),
        "provider": connection.provider,
        "external_account_id": connection.external_account_id,
        "workspace_id": connection.workspace_id,
        "chat_id": connection.chat_id,
        "channel_safe_tool_names": sorted(connection.channel_safe_tool_names),
    }
    return hashlib.sha256(json.dumps(values, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def _in_scope(record: object, connection: object, connection_id: str) -> bool:
    binding = connection.roleos_binding
    metadata = record.metadata if isinstance(record.metadata, dict) else {}
    return (
        getattr(record, "idempotency_key", None) == f"roleos-social:{metadata.get('roleos_request_id')}"
        and record.thread_id == binding.thread_id
        and record.assistant_id == binding.assistant_id
        and record.user_id == connection.scope.owner_user_id
        and all(
            metadata.get(key) == expected
            for key, expected in (
                ("roleos_company_id", binding.company_id),
                ("roleos_member_id", binding.member_id),
                ("roleos_source_revision", binding.source_revision),
                ("roleos_connection_id", connection_id),
                ("roleos_social_scope_fingerprint", _connection_fingerprint(connection)),
            )
        )
    )


def _validate_reuse(record: object, body: RoleOSSocialRunRequest, connection: object) -> None:
    if not _in_scope(record, connection, body.connection_id) or record.metadata.get("roleos_request_id") != body.request_id or record.metadata.get("roleos_work_fingerprint") != _work_fingerprint(body):
        raise HTTPException(status_code=409, detail="RoleOS request_id already belongs to a different work envelope or social scope")


def _poll_connection(request: Request, connection_id: str | None) -> tuple[str, object]:
    state = getattr(getattr(request, "app", None), "state", None)
    registry = getattr(state, "roleos_social_connections", None)
    if connection_id is None and isinstance(registry, Mapping) and len(registry) == 1:
        connection_id = next(iter(registry))
    if connection_id is None:
        raise HTTPException(status_code=400, detail="RoleOS connection_id is required for scoped polling")
    return connection_id, resolve_registered_roleos_social_connection(request, connection_id)


def _unknown(run_id: str, connection: object, error: str, *, request_id: str | None = None) -> RoleOSSocialRunResponse:
    binding = connection.roleos_binding
    return RoleOSSocialRunResponse(run_id=run_id, thread_id=binding.thread_id, request_id=request_id or run_id, source_revision=binding.source_revision, status="unknown", error=error)


def _verified_paths(content: dict) -> list[str]:
    # Native outputs_changed verification is the authority for required material.
    # Never infer material requirements from acceptance-criteria prose.
    paths = content.get("matched_paths") if content.get("produced_paths") else content.get("paths")
    if paths is None and not content.get("produced_paths"):
        paths = []
    if not isinstance(paths, list) or not all(isinstance(path, str) for path in paths):
        raise ValueError("native delivery paths are malformed")
    if content.get("produced_paths") and (content.get("satisfied") is not True or not paths):
        raise ValueError("native artifact delivery verification is unsatisfied")
    return list(dict.fromkeys(normalize_outputs_virtual_path(path) for path in paths))


def _artifact_identity(content: dict, path: str) -> dict:
    if content.get("artifact_integrity_version") != ARTIFACT_INTEGRITY_VERSION:
        raise ValueError("native delivery content identity is unavailable")
    identities = content.get("artifact_integrity")
    if not isinstance(identities, list):
        raise ValueError("native delivery content identity is unavailable")
    matches = [identity for identity in identities if isinstance(identity, dict) and identity.get("path") == path]
    if len(matches) != 1 or matches[0].get("error") or not isinstance(matches[0].get("sha256"), str) or not isinstance(matches[0].get("size_bytes"), int):
        raise ValueError("native delivered output content could not be attested")
    return matches[0]


async def _project_delivery(record: object, request: Request, connection: object, connection_id: str) -> RoleOSSocialRunResponse:
    from deerflow.runtime import RunStatus

    if not _in_scope(record, connection, connection_id):
        return _unknown(record.run_id, connection, "native run provenance is outside the registered social scope")
    metadata = record.metadata
    status = record.status.value if isinstance(record.status, RunStatus) else str(record.status)
    mapped = {"success": "succeeded", "error": "failed", "timeout": "failed", "interrupted": "failed"}.get(status, "unknown")
    response = RoleOSSocialRunResponse(
        run_id=record.run_id, thread_id=record.thread_id, request_id=str(metadata.get("roleos_request_id") or record.run_id), source_revision=connection.roleos_binding.source_revision, status=mapped, error=record.error
    )
    artifact_error = metadata.get("artifact_upload_error") or metadata.get("artifact_processing_error")
    if artifact_error:
        response.status = "failed" if mapped != "unknown" else "unknown"
        response.error = str(artifact_error)
    try:
        events = await get_run_event_store(request).list_events(record.thread_id, record.run_id, event_types=["run.delivery"], limit=2, user_id=connection.scope.owner_user_id)
    except Exception:
        response.status = "unknown" if response.status == "succeeded" else response.status
        response.error = response.error or "native delivery receipt is unavailable"
        return response
    if len(events) != 1 or not isinstance(events[0], dict):
        response.status = "unknown" if response.status == "succeeded" else response.status
        response.error = response.error or "native delivery receipt is unavailable"
        return response
    event = events[0]
    if (
        event.get("run_id") != record.run_id
        or event.get("thread_id") != record.thread_id
        or event.get("event_type") != "run.delivery"
        or event.get("category") != "outputs"
        or not isinstance(event.get("content"), dict)
        or event.get("user_id", connection.scope.owner_user_id) != connection.scope.owner_user_id
    ):
        response.status = "unknown" if response.status == "succeeded" else response.status
        response.error = response.error or "native delivery receipt does not match the registered run"
        return response
    base = f"/api/internal/roleos/sales/runs/{quote(record.run_id, safe='')}"
    query = urlencode({"connection_id": connection_id})
    response.native_receipt_ref = f"{base}/delivery?{query}"
    response.native_receipt = event
    response.evidence_refs = [response.native_receipt_ref]
    try:
        paths = _verified_paths(event["content"])
        available = []
        for path in paths:
            identity = _artifact_identity(event["content"], path)
            await asyncio.to_thread(verify_attested_output, record.thread_id, path, identity, user_id=connection.scope.owner_user_id)
            available.append(f"{base}/artifacts/{quote(path.lstrip('/'), safe='/')}?{query}")
        response.artifact_refs = available
    except (ValueError, HTTPException, OSError) as exc:
        response.status = "failed" if mapped != "unknown" else "unknown"
        response.error = response.error or str(exc)
    return response


@router.get("/sales/requests/{request_id}", response_model=RoleOSSocialRunResponse)
@router.get("/guild/requests/{request_id}", response_model=RoleOSSocialRunResponse)
@router.get("/social/requests/{request_id}", response_model=RoleOSSocialRunResponse)
async def lookup_roleos_social_request(
    request_id: str, request: Request, connection_id: str | None = Query(default=None, min_length=1, max_length=128), source_revision: str | None = Query(default=None, min_length=1, max_length=128)
) -> RoleOSSocialRunResponse:
    """Recover a lost admission response without launching another worker."""
    _require_internal_roleos_request(request)
    connection_id, connection = _poll_connection(request, connection_id)
    if source_revision is not None and source_revision != connection.roleos_binding.source_revision:
        raise HTTPException(status_code=409, detail="RoleOS source revision does not match the registered social employee")
    record = await get_run_manager(request).get_by_idempotency_key(f"roleos-social:{request_id}", user_id=connection.scope.owner_user_id)
    if record is None:
        return _unknown("", connection, "native request state is unavailable", request_id=request_id)
    return await _project_delivery(record, request, connection, connection_id)


@router.get("/sales/runs/{run_id}", response_model=RoleOSSocialRunResponse)
@router.get("/guild/runs/{run_id}", response_model=RoleOSSocialRunResponse)
@router.get("/social/runs/{run_id}", response_model=RoleOSSocialRunResponse)
@router.get("/sales/runs/{run_id}/delivery", response_model=RoleOSSocialRunResponse)
@router.get("/guild/runs/{run_id}/delivery", response_model=RoleOSSocialRunResponse)
@router.get("/social/runs/{run_id}/delivery", response_model=RoleOSSocialRunResponse)
async def poll_roleos_social_run(run_id: str, request: Request, connection_id: str | None = Query(default=None, min_length=1, max_length=128)) -> RoleOSSocialRunResponse:
    """Project the authoritative native run and singleton persisted delivery."""
    _require_internal_roleos_request(request)
    connection_id, connection = _poll_connection(request, connection_id)
    record = await get_run_manager(request).get(run_id, user_id=connection.scope.owner_user_id)
    if record is None:
        return _unknown(run_id, connection, "native run state is unavailable")
    return await _project_delivery(record, request, connection, connection_id)


async def _settle_owned_task(task: asyncio.Task):
    """Drain admitted resource work under both AnyIO and asyncio cancellation."""
    cancellation = None
    with CancelScope(shield=True):
        while True:
            try:
                return await asyncio.shield(task), cancellation
            except asyncio.CancelledError as exc:
                if task.done():
                    return task.result(), exc
                cancellation = exc


async def _close_verified_buffer(buffer: BinaryIO) -> None:
    _, cancellation = await _settle_owned_task(asyncio.create_task(asyncio.to_thread(buffer.close)))
    if cancellation is not None:
        raise cancellation


async def _capture_verified_buffer(*args, **kwargs) -> BinaryIO:
    capture = asyncio.create_task(asyncio.to_thread(read_attested_output, *args, **kwargs))
    try:
        return await asyncio.shield(capture)
    except BaseException:
        # Cancellation cannot abandon a thread that will return a live spool.
        try:
            buffer, _ = await _settle_owned_task(capture)
        except BaseException:
            pass  # Native capture failures already close their private buffer.
        else:
            await _close_verified_buffer(buffer)
        raise


class _VerifiedArtifactResponse(StreamingResponse):
    """Own the exact attested spool even when ASGI send aborts streaming."""

    def __init__(self, buffer: BinaryIO, **kwargs):
        self._verified_buffer = buffer
        super().__init__(self._chunks(), **kwargs)

    def _chunks(self):
        while chunk := self._verified_buffer.read(64 * 1024):
            yield chunk

    async def __call__(self, scope, receive, send):
        try:
            await super().__call__(scope, receive, send)
        finally:
            await _close_verified_buffer(self._verified_buffer)


@router.get("/sales/runs/{run_id}/artifacts/{path:path}")
@router.get("/guild/runs/{run_id}/artifacts/{path:path}")
@router.get("/social/runs/{run_id}/artifacts/{path:path}")
async def read_roleos_social_artifact(run_id: str, path: str, request: Request, connection_id: str | None = Query(default=None, min_length=1, max_length=128)):
    """Read only a file attested by this scoped native delivery event."""
    import mimetypes
    from pathlib import PurePosixPath

    from app.gateway.routers.artifacts import _build_attachment_headers

    _require_internal_roleos_request(request)
    connection_id, connection = _poll_connection(request, connection_id)
    receipt = await poll_roleos_social_run(run_id, request, connection_id=connection_id)
    if receipt.native_receipt is None or not receipt.artifact_refs:
        raise HTTPException(status_code=404, detail="Verified native artifact is unavailable")
    normalized = normalize_outputs_virtual_path(path)
    if normalized not in _verified_paths(receipt.native_receipt["content"]):
        raise HTTPException(status_code=404, detail="Path is not a verified output of this run")
    identity = _artifact_identity(receipt.native_receipt["content"], normalized)
    try:
        buffer = await _capture_verified_buffer(receipt.thread_id, normalized, identity, user_id=connection.scope.owner_user_id)
    except (ValueError, OSError):
        raise HTTPException(status_code=404, detail="Verified native artifact content is unavailable") from None

    try:
        filename = PurePosixPath(normalized).name
        mime_type, _ = await asyncio.to_thread(mimetypes.guess_type, filename)
        headers = _build_attachment_headers(filename, {"ETag": f'"{identity["sha256"]}"', "Content-Length": str(identity["size_bytes"])})
        return _VerifiedArtifactResponse(buffer, media_type=mime_type or "application/octet-stream", headers=headers)
    except BaseException:
        await _close_verified_buffer(buffer)
        raise


RoleOSSalesRunRequest = RoleOSSocialRunRequest
RoleOSSalesRunResponse = RoleOSSocialRunResponse
RoleOSGuildRunRequest = RoleOSSocialRunRequest
RoleOSGuildRunResponse = RoleOSSocialRunResponse

__all__ = [
    "RoleOSSocialRunRequest",
    "RoleOSSocialRunResponse",
    "RoleOSSalesRunRequest",
    "RoleOSSalesRunResponse",
    "RoleOSGuildRunRequest",
    "RoleOSGuildRunResponse",
    "admit_roleos_social_run",
    "poll_roleos_social_run",
    "router",
]
