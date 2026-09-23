"""Checkpointed, server-bound social references for one channel thread."""

from __future__ import annotations

from typing import NotRequired, TypedDict

from deerflow.social.contracts import SocialScope, bounded_text


class SocialScopeState(TypedDict):
    owner_user_id: str
    account_id: str
    person_ref: str
    channel_thread_ref: str
    agent_instance_id: str


class SocialState(TypedDict):
    scope: SocialScopeState
    identity_ref: NotRequired[str]
    role_ref: NotRequired[str]
    relationship_revision: NotRequired[int]
    self_revision: NotRequired[int]
    persona_fingerprint: NotRequired[str]
    latest_external_event_id: NotRequired[str]
    pending_action_id: NotRequired[str]


_REF_FIELDS = frozenset({"identity_ref", "role_ref", "persona_fingerprint", "latest_external_event_id", "pending_action_id"})
_REVISION_FIELDS = frozenset({"relationship_revision", "self_revision"})


def merge_social(existing: SocialState | None, new: SocialState | None) -> SocialState | None:
    """Merge event progress without allowing a checkpoint to change its scope or bindings."""
    if new is None:
        return existing
    if not isinstance(new, dict) or set(new) - ({"scope"} | _REF_FIELDS | _REVISION_FIELDS):
        raise ValueError("invalid social state update")
    if existing is None and "scope" not in new:
        raise ValueError("social state requires a server-bound scope")
    scope_data = new.get("scope", existing["scope"] if existing else None)
    if not isinstance(scope_data, dict):
        raise ValueError("social scope must be a mapping")
    scope = SocialScope(**scope_data)
    normalized_scope: SocialScopeState = {
        "owner_user_id": scope.owner_user_id,
        "account_id": scope.account_id,
        "person_ref": scope.person_ref,
        "channel_thread_ref": scope.channel_thread_ref,
        "agent_instance_id": scope.agent_instance_id,
    }
    if existing is not None and normalized_scope != existing["scope"]:
        raise ValueError("social scope cannot change within a thread")
    merged: SocialState = {**(existing or {}), **new, "scope": normalized_scope}
    for key in _REF_FIELDS:
        if key in merged:
            bounded_text(merged[key], key, 128 if key != "persona_fingerprint" else 64)
        if existing is not None and key in {"identity_ref", "role_ref", "persona_fingerprint"} and key in new and key in existing and new[key] != existing[key]:
            raise ValueError(f"{key} binding cannot change through social state")
    for key in _REVISION_FIELDS:
        if key in merged and (type(merged[key]) is not int or merged[key] < 0):
            raise ValueError(f"{key} must be nonnegative")
    return merged
