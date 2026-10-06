"""Reject recognizable internal-context echoes at the public social boundary.

This is a deterministic guard for known runtime signatures, not a semantic
classifier. Ordinary identity disclosure and technical discussion remain valid.
"""

from __future__ import annotations

import re
import unicodedata
from html import unescape

_PRIVATE_TAGS = (
    "social-runtime-context",
    "social-runtime-data",
    "creator-agent-persona",
    "creator-agent-relationship-data",
    "soul",
    "memory",
    "system-reminder",
    "durable_context_data",
    "skill_system",
    "subagent_system",
    "thinking_style",
    "critical_reminders",
    "authorization-ref",
)
_PRIVATE_TAG = re.compile(r"<\s*/?\s*(?:" + "|".join(map(re.escape, _PRIVATE_TAGS)) + r")\b")
_PRIVATE_FIELDS = ("decision_note", "state_delta", "memory_delta", "persona_fingerprint", "__social_binding")
_FIELD_ASSIGNMENT = re.compile(r"(?<![a-z0-9_])(?:" + "|".join(map(re.escape, _PRIVATE_FIELDS)) + r")[\"'`]*\s*[:=]")
_PROTOCOL_SYMBOL = re.compile(r"(?<![a-z0-9_])(?:" + "|".join(map(re.escape, (*_PRIVATE_FIELDS, "turnresult"))) + r")(?![a-z0-9_])")
_INTERNAL_NARRATION = re.compile(r"内部(?:字段|协议|侧记|上下文)|\b(?:internal|private) (?:context|protocol|instructions|fields)\b")
_CONTEXT_KEY = re.compile(r"[\"'](scope_ref|person_ref|channel_thread_ref|profile_ref|fingerprint)[\"']\s*:")
_DEVELOPMENT_PROSE = (
    "final / persona-rev1",
    "social_kernel.md",
    "默认社交内核",
    "未来接入外部消息适配器",
    "当前 deerflow 普通 chat",
    "原生单 lead",
    "输出 turnresult",
    "reply 是唯一外发字段",
    "reply 才是唯一可外发字段",
)


def validate_public_reply(reply: str) -> None:
    """Reject a known context/protocol dump without echoing its private content."""
    normalized = unicodedata.normalize("NFKC", unescape(unescape(reply))).casefold()
    normalized = "".join(character for character in normalized if unicodedata.category(character) != "Cf")
    keys = set(_CONTEXT_KEY.findall(normalized))
    context_dump = ("scope_ref" in keys and bool(keys & {"person_ref", "channel_thread_ref"})) or {"profile_ref", "fingerprint"} <= keys
    internal_narration = _PROTOCOL_SYMBOL.search(normalized) and _INTERNAL_NARRATION.search(normalized)
    if _PRIVATE_TAG.search(normalized) or _FIELD_ASSIGNMENT.search(normalized) or internal_narration or context_dump or any(marker in normalized for marker in _DEVELOPMENT_PROSE):
        raise ValueError("social reply contains internal runtime content")
