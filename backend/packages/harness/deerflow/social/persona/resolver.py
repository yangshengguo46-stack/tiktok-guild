"""Resolve one full expression profile for a scoped social turn."""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping

from deerflow.social.persona.catalog import DEFAULT_PROFILE_REF
from deerflow.social.persona.models import EffectivePersona, PersonaBindings, PersonaProfile
from deerflow.social.persona.profiles import resolve_base

DECISION_POLICY_VERSION = "1"
_TURN_FIELDS = frozenset({"attention", "voice", "humor", "disagreement", "care", "initiative", "interests", "length", "questions", "language"})


def resolve_profile(
    *,
    catalog: Mapping[str, Mapping[str, str | tuple[str, ...]]],
    profiles: Mapping[str, PersonaProfile],
    bindings: PersonaBindings,
    turn_adjustment: Mapping[str, str | tuple[str, ...]] | None = None,
    evidence_version: int = 0,
) -> EffectivePersona:
    """Apply account, optional agent, relation, then ephemeral expression adjustment."""
    if type(evidence_version) is not int or evidence_version < 0:
        raise ValueError("evidence_version must be nonnegative")
    if DEFAULT_PROFILE_REF not in catalog:
        raise ValueError("default persona template missing")
    for ref in (bindings.account_default_ref, bindings.agent_override_ref, bindings.relation_override_ref):
        if ref is not None:
            resolve_base(ref, catalog, profiles)
    selected = bindings.account_default_ref
    if bindings.agent_override_ref is not None:
        selected = bindings.agent_override_ref
    if bindings.relation_override_ref is not None:
        selected = bindings.relation_override_ref
    base_ref, base_behavior = resolve_base(selected, catalog, profiles)
    adjustment = turn_adjustment or {}
    if not isinstance(adjustment, Mapping) or set(adjustment) - _TURN_FIELDS:
        raise ValueError("turn adjustment contains non-expression fields")
    behavior = {**base_behavior, **adjustment}
    scope = bindings.scope
    payload = {
        "scope": {"owner_user_id": scope.owner_user_id, "account_id": scope.account_id, "agent_instance_id": scope.agent_instance_id, "relation_ref": scope.relation_ref},
        "profile_ref": selected,
        "base_template_ref": base_ref,
        "behavior": behavior,
        "binding_revision": bindings.revision,
        "evidence_version": evidence_version,
        "decision_policy_version": DECISION_POLICY_VERSION,
    }
    fingerprint = hashlib.sha256(json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    return EffectivePersona(profile_ref=selected, base_template_ref=base_ref, behavior=behavior, binding_revision=bindings.revision, evidence_version=evidence_version, fingerprint=fingerprint)
