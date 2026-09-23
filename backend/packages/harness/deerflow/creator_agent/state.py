"""Scoped, checkpointed focus for the Lead's creator expression context."""

from __future__ import annotations

from dataclasses import dataclass
from typing import NotRequired

from langchain.agents import AgentState


@dataclass(frozen=True)
class CreatorFocus:
    owner_user_id: str
    account_id: str
    creator_uid: str

    def __post_init__(self) -> None:
        for value in (self.owner_user_id, self.account_id, self.creator_uid):
            if not isinstance(value, str) or not value.strip() or len(value) > 128:
                raise ValueError("invalid creator focus")

    def as_kwargs(self) -> dict[str, str]:
        return {"owner_user_id": self.owner_user_id, "account_id": self.account_id, "creator_uid": self.creator_uid}

    def as_persona_scope(self) -> dict[str, str]:
        return {"operator_id": self.owner_user_id, "account_id": self.account_id, "creator_uid": self.creator_uid}

    @classmethod
    def from_raw(cls, raw: object) -> CreatorFocus | None:
        if isinstance(raw, cls):
            return raw
        if not isinstance(raw, dict):
            return None
        try:
            return cls(raw["owner_user_id"], raw["account_id"], raw["creator_uid"])
        except (KeyError, TypeError, ValueError):
            return None


class CreatorAgentState(AgentState):
    creator_agent_focus: NotRequired[dict[str, str] | None]
