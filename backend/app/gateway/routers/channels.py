"""Gateway router for IM channel management."""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from app.gateway.deps import require_admin_user

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/channels", tags=["channels"])

_ADMIN_REQUIRED_DETAIL = "Admin privileges required to manage channel runtime workers."


class ChannelStatusResponse(BaseModel):
    service_running: bool
    channels: dict[str, dict]


class ChannelRestartResponse(BaseModel):
    success: bool
    message: str


class UnifiedChannelStatusResponse(BaseModel):
    service_running: bool
    providers: dict[str, dict[str, str]]


@router.get("/", response_model=ChannelStatusResponse)
async def get_channels_status() -> ChannelStatusResponse:
    """Get the status of all IM channels."""
    from app.channels.service import get_channel_service

    service = get_channel_service()
    if service is None:
        return ChannelStatusResponse(service_running=False, channels={})
    status = service.get_status()
    return ChannelStatusResponse(**status)


@router.get("/unified", response_model=UnifiedChannelStatusResponse)
async def get_unified_channel_status() -> UnifiedChannelStatusResponse:
    """Expose one read-only status contract for inbound/outbound channels.

    This is deliberately a management projection, not a provider connector.
    TikTok remains ``manual_required`` until a host supplied, authenticated
    provider is registered; the endpoint never claims that a configured MCP or
    browser session proves a send or receipt.
    """

    from app.channels.service import get_channel_service
    from app.channels.social import SOCIAL_CAPABILITY_MATRIX

    service = get_channel_service()
    service_running = bool(service and service.get_status().get("service_running"))
    providers: dict[str, dict[str, str]] = {}
    for provider, capabilities in SOCIAL_CAPABILITY_MATRIX.items():
        status = {name: str(capabilities[name]) for name in ("inbound", "outbound", "receipts")}
        status["write_state"] = "manual_required" if status["outbound"] == "unverified" else "ready"
        providers[provider] = status
    return UnifiedChannelStatusResponse(service_running=service_running, providers=providers)


@router.post("/{name}/restart", response_model=ChannelRestartResponse)
async def restart_channel(name: str, request: Request) -> ChannelRestartResponse:
    """Restart a specific IM channel."""
    await require_admin_user(request, detail=_ADMIN_REQUIRED_DETAIL)

    from app.channels.service import get_channel_service

    service = get_channel_service()
    if service is None:
        raise HTTPException(status_code=503, detail="Channel service is not running")

    success = await service.restart_channel(name)
    if success:
        logger.info("Channel %s restarted successfully", name)
        return ChannelRestartResponse(success=True, message=f"Channel {name} restarted successfully")
    else:
        logger.warning("Failed to restart channel %s", name)
        return ChannelRestartResponse(success=False, message=f"Failed to restart channel {name}")
