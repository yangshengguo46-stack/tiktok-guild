"""Request-only social context injection from an explicitly bound runtime."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Protocol, override
from uuid import uuid4

from langchain.agents.middleware import AgentMiddleware
from langchain.agents.middleware.types import ModelCallResult, ModelRequest, ModelResponse
from langchain_core.messages import HumanMessage, SystemMessage

from deerflow.agents.middlewares.message_utils import insert_after_leading_system_messages
from deerflow.social.context import SocialContextSnapshot, build_social_context, build_social_context_data
from deerflow.social.contracts import SocialScope

_SOCIAL_MARKER = "deerflow_social_context"


class SocialSnapshotRuntime(Protocol):
    def snapshot_for(self, scope: SocialScope) -> SocialContextSnapshot: ...


class SocialContextMiddleware(AgentMiddleware):
    """Read one frozen snapshot; change only the current ModelRequest."""

    def __init__(self, *, runtime: SocialSnapshotRuntime, bound_scope: SocialScope) -> None:
        super().__init__()
        self._runtime = runtime
        self._bound_scope = bound_scope
        self._marker_token = uuid4().hex

    def _inject(self, request: ModelRequest) -> ModelRequest:
        social = request.state.get("social")
        if social is None:
            return request
        if not isinstance(social, dict) or not isinstance(social.get("scope"), dict):
            raise ValueError("social state lacks a bound scope")
        if SocialScope(**social["scope"]) != self._bound_scope:
            raise ValueError("social state scope differs from server binding")
        snapshot = self._runtime.snapshot_for(self._bound_scope)
        if not isinstance(snapshot, SocialContextSnapshot) or snapshot.scope != self._bound_scope:
            raise ValueError("runtime returned a mismatched social snapshot")
        messages = [message for message in request.messages if getattr(message, "additional_kwargs", {}).get(_SOCIAL_MARKER) != self._marker_token]
        authority = SystemMessage(content=build_social_context(snapshot), additional_kwargs={_SOCIAL_MARKER: self._marker_token})
        data = HumanMessage(content=build_social_context_data(snapshot), additional_kwargs={_SOCIAL_MARKER: self._marker_token, "hide_from_ui": True})
        return request.override(messages=insert_after_leading_system_messages(messages, [authority, data]))

    @override
    def wrap_model_call(self, request: ModelRequest, handler: Callable[[ModelRequest], ModelResponse]) -> ModelCallResult:
        return handler(self._inject(request))

    @override
    async def awrap_model_call(self, request: ModelRequest, handler: Callable[[ModelRequest], Awaitable[ModelResponse]]) -> ModelCallResult:
        return await handler(self._inject(request))
