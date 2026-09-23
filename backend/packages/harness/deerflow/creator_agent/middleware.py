"""Scoped CreatorAgent expression projected into a single model request."""

from __future__ import annotations

import asyncio
import json
from collections.abc import Awaitable, Callable, Mapping
from typing import override

from deerflow_extension_api import ContentKind, provenance_kwargs
from langchain.agents.middleware import AgentMiddleware
from langchain.agents.middleware.types import ModelCallResult, ModelRequest, ModelResponse
from langchain_core.messages import HumanMessage, SystemMessage

from deerflow.agents.middlewares.message_utils import insert_after_leading_system_messages
from deerflow.creator_agent.state import CreatorAgentState, CreatorFocus
from deerflow.runtime.user_context import resolve_runtime_user_id

_BOUNDARY_INSTRUCTIONS = {
    "do_not_contact": "Do not contact this creator. Do not draft outbound contact, send invitations, or imply permission to contact.",
    "human_takeover": "A human operator has taken over this creator relationship. Do not draft or initiate contact.",
    "receipt_unknown": "The platform receipt is unknown. Do not retry or claim delivery; ask the operator to verify status.",
    "identity_unverified": "The creator identity is unverified. Do not draft or initiate contact for this identity.",
}


def is_operator_surface(context: object) -> bool:
    """Only local authenticated Chat can inspect private relationship state."""
    if not isinstance(context, Mapping):
        return False
    return context.get("channel_name") in (None, "chat") and not context.get("is_subagent")


class CreatorAgentMiddleware(AgentMiddleware):
    state_schema = CreatorAgentState

    def __init__(self, runtime):
        super().__init__()
        self._creator_runtime = runtime

    async def _inject(self, request: ModelRequest) -> ModelRequest:
        run = getattr(request, "runtime", None)
        context = getattr(run, "context", None)
        if not is_operator_surface(context):
            return request
        state = request.state or {}
        focus = CreatorFocus.from_raw(state.get("creator_agent_focus"))
        if focus is None:
            return request
        # A checkpoint may carry focus from another identity. The run's owner
        # remains authoritative even when callers can write ordinary context.
        if resolve_runtime_user_id(run) != focus.owner_user_id:
            return request
        try:
            resolved = await self._creator_runtime.aresolve(focus)
        except Exception:
            return request
        if resolved is None:
            return request
        boundary = resolved.get("boundary")
        if boundary in _BOUNDARY_INSTRUCTIONS:
            restriction = SystemMessage(
                content=_BOUNDARY_INSTRUCTIONS[boundary],
                additional_kwargs=provenance_kwargs(ContentKind.MIDDLEWARE_INJECTION, "creator_agent_boundary"),
            )
            return request.override(messages=insert_after_leading_system_messages(list(request.messages), [restriction]))
        asset = {key: resolved[key] for key in ("persona_id", "persona_version", "core", "behavior", "interests", "persona_revision", "evidence_version", "decision_policy_version", "effective_persona_fingerprint", "source")}
        section = "<creator-agent-persona>\n" + json.dumps(asset, ensure_ascii=False, sort_keys=True) + "\n</creator-agent-persona>"
        persona_message = SystemMessage(content=section, additional_kwargs=provenance_kwargs(ContentKind.MIDDLEWARE_INJECTION, "creator_agent_persona"))
        relationship = {
            "scope": resolved["scope"],
            "evidence": resolved.get("relationship_evidence", []),
            "facts": resolved.get("facts", []),
            "commitments": resolved.get("commitments", []),
            "decision_evidence_refs": resolved.get("decision_evidence_refs", []),
        }
        data_message = HumanMessage(
            content="<creator-agent-relationship-data>\n" + json.dumps(relationship, ensure_ascii=False, sort_keys=True) + "\n</creator-agent-relationship-data>",
            additional_kwargs={"hide_from_ui": True, **provenance_kwargs(ContentKind.DURABLE_CONTEXT, "creator_agent_relationship")},
        )
        return request.override(messages=insert_after_leading_system_messages(list(request.messages), [persona_message, data_message]))

    @override
    def wrap_model_call(self, request: ModelRequest, handler: Callable[[ModelRequest], ModelResponse]) -> ModelCallResult:
        return handler(asyncio.run(self._inject(request)))

    @override
    async def awrap_model_call(self, request: ModelRequest, handler: Callable[[ModelRequest], Awaitable[ModelResponse]]) -> ModelCallResult:
        return await handler(await self._inject(request))
