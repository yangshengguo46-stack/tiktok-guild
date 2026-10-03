"""Host-only RoleOS admission for the native Guild/Sales social owner."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Annotated, Literal

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import AliasChoices, BaseModel, ConfigDict, Field, StringConstraints, field_validator

from app.channels.social import SocialInternalWork
from app.gateway.auth_disabled import AUTH_SOURCE_INTERNAL
from app.gateway.deps import get_run_manager
from app.gateway.internal_auth import INTERNAL_AUTH_HEADER_NAME, is_valid_internal_auth_token
from app.gateway.run_models import RunCreateRequest
from app.gateway.services import admit_registered_roleos_social_work, resolve_registered_roleos_social_connection, start_run

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
    return RoleOSSocialRunResponse(run_id=record.run_id, thread_id=record.thread_id, request_id=body.request_id, source_revision=binding.roleos_binding.source_revision)


@router.get("/sales/runs/{run_id}", response_model=RoleOSSocialRunResponse)
@router.get("/guild/runs/{run_id}", response_model=RoleOSSocialRunResponse)
@router.get("/social/runs/{run_id}", response_model=RoleOSSocialRunResponse)
async def poll_roleos_social_run(run_id: str, request: Request, connection_id: str | None = Query(default=None, min_length=1, max_length=128)) -> RoleOSSocialRunResponse:
    """Poll native state for the bridge; unresolved state stays ``unknown``."""
    _require_internal_roleos_request(request)
    from deerflow.runtime import RunStatus

    # Polling is scoped by the registered SocialConnection.  When the bridge
    # omits an explicit selector, accept only a host with one registered
    # connection; never fall back to an unscoped ``user_id=None`` lookup.
    state = getattr(getattr(request, "app", None), "state", None)
    registry = getattr(state, "roleos_social_connections", None)
    if connection_id is None and isinstance(registry, Mapping) and len(registry) == 1:
        connection_id = next(iter(registry))
    if connection_id is None:
        raise HTTPException(status_code=400, detail="RoleOS connection_id is required for scoped polling")
    connection = resolve_registered_roleos_social_connection(request, connection_id)
    binding = connection.roleos_binding
    # RunManager ownership is the SocialScope owner, not the RoleOS native
    # owner string.
    record = await get_run_manager(request).get(run_id, user_id=connection.scope.owner_user_id)
    if record is None:
        return RoleOSSocialRunResponse(
            run_id=run_id,
            thread_id=binding.thread_id,
            request_id=run_id,
            source_revision=binding.source_revision,
            status="unknown",
            error="native run state is unavailable",
        )
    if record.thread_id != binding.thread_id or record.assistant_id != binding.assistant_id or record.user_id not in {None, connection.scope.owner_user_id}:
        return RoleOSSocialRunResponse(
            run_id=run_id,
            thread_id=binding.thread_id,
            request_id=run_id,
            source_revision=binding.source_revision,
            status="unknown",
            error="native run is outside the registered social scope",
        )
    metadata = record.metadata if isinstance(record.metadata, dict) else {}
    if any(
        metadata.get(key) != expected
        for key, expected in (
            ("roleos_company_id", binding.company_id),
            ("roleos_member_id", binding.member_id),
            ("roleos_source_revision", binding.source_revision),
        )
    ):
        return RoleOSSocialRunResponse(
            run_id=run_id,
            thread_id=binding.thread_id,
            request_id=run_id,
            source_revision=binding.source_revision,
            status="unknown",
            error="native run provenance is outside the registered social scope",
        )
    request_id = str(metadata.get("roleos_request_id") or "")
    source_revision = str(metadata.get("roleos_source_revision") or "")
    status = record.status.value if isinstance(record.status, RunStatus) else str(record.status)
    mapped = {RunStatus.success.value: "succeeded", RunStatus.error.value: "failed", RunStatus.timeout.value: "failed", RunStatus.interrupted.value: "failed"}.get(status, "unknown")
    kwargs = record.kwargs if isinstance(record.kwargs, dict) else {}
    native_input = kwargs.get("input") if isinstance(kwargs.get("input"), dict) else {}
    artifact_refs = metadata.get("artifact_refs") or native_input.get("artifact_refs") or []
    evidence_refs = metadata.get("evidence_refs") or native_input.get("evidence_refs") or []
    if not isinstance(artifact_refs, list) or not all(isinstance(ref, str) for ref in artifact_refs):
        artifact_refs = []
    if not isinstance(evidence_refs, list) or not all(isinstance(ref, str) for ref in evidence_refs):
        evidence_refs = []
    artifact_error = metadata.get("artifact_upload_error") or metadata.get("artifact_processing_error")
    if artifact_error is None and isinstance(record.error, str) and any(token in record.error.lower() for token in ("artifact", "evidence", "upload", "process")):
        artifact_error = record.error
    if artifact_error:
        mapped = "failed" if status in {RunStatus.success.value, RunStatus.error.value, RunStatus.timeout.value, RunStatus.interrupted.value} else "unknown"
    return RoleOSSocialRunResponse(
        run_id=record.run_id,
        thread_id=record.thread_id,
        request_id=request_id or run_id,
        source_revision=source_revision or binding.source_revision,
        status=mapped,
        error=str(artifact_error or record.error) if (artifact_error or record.error) else None,
        artifact_refs=artifact_refs,
        evidence_refs=evidence_refs,
    )


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
