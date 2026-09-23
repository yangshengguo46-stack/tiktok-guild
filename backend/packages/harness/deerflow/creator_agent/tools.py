"""Operator Chat tools for scoped focus and source-preserving relationship notes."""

from __future__ import annotations

import asyncio
import json
import uuid

from langchain_core.messages import HumanMessage, ToolMessage
from langchain_core.tools import StructuredTool
from langgraph.types import Command

from deerflow.agents.middlewares.message_utils import is_genuine_user_message
from deerflow.creator_agent.middleware import is_operator_surface
from deerflow.creator_agent.state import CreatorFocus
from deerflow.runtime.user_context import resolve_runtime_user_id
from deerflow.tools.types import Runtime


def focus_update(*, owner_user_id: str, account_id: str, creator_uid: str) -> dict[str, str]:
    return CreatorFocus(owner_user_id, account_id, creator_uid).as_kwargs()


def operator_message_event(message: object, *, source_message_id: str) -> dict | None:
    """Copy a real operator Chat message; never mint creator-authored evidence."""
    if not is_genuine_user_message(message) or getattr(message, "id", None) != source_message_id:
        return None
    body = getattr(message, "content", None)
    if not isinstance(body, str) or not body.strip() or len(body) > 512:
        return None
    return {"event_id": str(uuid.uuid4()), "source_ref": f"chat:{source_message_id}", "source_kind": "operator_note", "text": body}


def make_creator_agent_tools(repository, creator_runtime) -> list[StructuredTool]:
    def creator_agent_focus(runtime: Runtime, account_id: str, creator_uid: str) -> Command | str:
        """Focus one creator in this operator's private Chat session by account and TikTok UID."""
        if not is_operator_surface(getattr(runtime, "context", None)):
            return json.dumps({"error": "operator_chat_required"})
        try:
            focus = focus_update(owner_user_id=resolve_runtime_user_id(runtime), account_id=account_id, creator_uid=creator_uid)
        except ValueError:
            return json.dumps({"error": "invalid_focus"})
        return Command(update={"creator_agent_focus": focus, "messages": [ToolMessage(content=json.dumps({"status": "focused", "account_id": account_id, "creator_uid": creator_uid}), tool_call_id=runtime.tool_call_id)]})

    async def creator_agent_brief(runtime: Runtime) -> str:
        """Read the focused creator's current relationship and active expression fingerprint."""
        if not is_operator_surface(getattr(runtime, "context", None)):
            return json.dumps({"error": "operator_chat_required"})
        focus = CreatorFocus.from_raw(runtime.state.get("creator_agent_focus"))
        if focus is None or focus.owner_user_id != resolve_runtime_user_id(runtime):
            return json.dumps({"error": "focus_unavailable"})
        relationship = await repository.get(**focus.as_kwargs())
        if relationship and relationship.get("do_not_contact"):
            return json.dumps({"do_not_contact": True, "status": "no_contact"})
        resolved = creator_runtime._resolve_snapshot(focus, relationship)
        return json.dumps(
            {
                "persona_id": resolved["persona_id"],
                "persona_revision": resolved["persona_revision"],
                "effective_persona_fingerprint": resolved["effective_persona_fingerprint"],
                "evidence": resolved["relationship_evidence"],
                "commitments": resolved["commitments"],
            },
            ensure_ascii=False,
        )

    async def creator_agent_record(runtime: Runtime, source_message_id: str) -> str:
        """Record a cited operator Chat message verbatim as an operator note for the focused creator."""
        if not is_operator_surface(getattr(runtime, "context", None)):
            return json.dumps({"error": "operator_chat_required"})
        focus = CreatorFocus.from_raw(runtime.state.get("creator_agent_focus"))
        if focus is None or focus.owner_user_id != resolve_runtime_user_id(runtime):
            return json.dumps({"error": "focus_unavailable"})
        message = next((item for item in reversed(runtime.state.get("messages", [])) if isinstance(item, HumanMessage) and item.id == source_message_id), None)
        event = operator_message_event(message, source_message_id=source_message_id)
        if event is None:
            return json.dumps({"error": "operator_message_unavailable"})
        result = await repository.record_evidence(**focus.as_kwargs(), event=event)
        return json.dumps({"status": "recorded", "source_ref": event["source_ref"], "evidence_version": result["evidence_version"]})

    def sync_brief(runtime: Runtime) -> str:
        """Read the focused creator's current relationship and expression fingerprint."""
        return asyncio.run(creator_agent_brief(runtime))

    def sync_record(runtime: Runtime, source_message_id: str) -> str:
        """Record a cited operator Chat message as a scoped operator note."""
        return asyncio.run(creator_agent_record(runtime, source_message_id))

    return [
        StructuredTool.from_function(creator_agent_focus, name="creator_agent_focus"),
        StructuredTool.from_function(sync_brief, coroutine=creator_agent_brief, name="creator_agent_brief"),
        StructuredTool.from_function(sync_record, coroutine=creator_agent_record, name="creator_agent_record"),
    ]
