"""Hidden candidate generation; activation is a separate repository operation."""

from __future__ import annotations

import asyncio
import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass

from langchain_core.messages import HumanMessage, SystemMessage
from langgraph.constants import TAG_NOSTREAM

from deerflow.social.persona.catalog import load_persona_catalog
from deerflow.social.persona.models import PersonaProfile, ProfileScope

_SYSTEM = (
    "Generate an expression-only persona profile candidate. Identity, self memory, role, relationship, "
    "facts, commitments and permissions are immutable and must not be changed or inferred. "
    "Return only JSON with overrides, diff_summary, examples. Examples must be synthetic and "
    "must not represent actual conversation history. Provide two or three examples."
)


@dataclass(frozen=True)
class GeneratedPersonaCandidate:
    candidate: PersonaProfile
    diff_summary: str
    synthetic_examples: tuple[str, ...]
    activated: bool = False


def _unique_pairs(pairs: list[tuple[str, object]]) -> dict:
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate generator field")
        result[key] = value
    return result


class PersonaProfileGenerator:
    def __init__(self, model=None, *, model_name: str | None = None, app_config=None, timeout_seconds: float = 15.0):
        self._model = model
        self._bound_model = None
        self._model_name = model_name
        self._app_config = app_config
        self._timeout_seconds = timeout_seconds

    def _get_model(self):
        if self._model is None:
            from deerflow.models import create_chat_model

            self._model = create_chat_model(name=self._model_name, thinking_enabled=False, app_config=self._app_config, attach_tracing=False, disable_streaming=True)
        if self._bound_model is None:
            tags = list((getattr(self._model, "config", None) or {}).get("tags") or [])
            if TAG_NOSTREAM not in tags:
                tags.append(TAG_NOSTREAM)
            tags.append("middleware:social_persona_generator")
            self._bound_model = self._model.with_config(tags=tags) if hasattr(self._model, "with_config") else self._model
        return self._bound_model

    async def generate(
        self,
        *,
        base_profile: PersonaProfile,
        profile_id: str,
        version: str,
        requirement: str | None,
        creator_preferences: Sequence[Mapping[str, object]],
        scope: ProfileScope | None = None,
        immutable_identity_facts: Mapping[str, str],
        basis_refs: tuple[str, ...],
        valid_basis_refs: Sequence[str],
    ) -> GeneratedPersonaCandidate:
        if not isinstance(base_profile, PersonaProfile):
            raise ValueError("base_profile must be immutable PersonaProfile")
        # Validate the proposed reference before any configured model I/O.
        # This uses the same canonical contract as persisted profile content.
        PersonaProfile(profile_id, version, base_profile.base_template_ref, {}, "operator", ())
        if base_profile.base_template_ref not in load_persona_catalog():
            raise ValueError("base profile must use an approved template")
        if not isinstance(requirement, (str, type(None))) or (requirement is not None and not 0 < len(requirement.strip()) <= 1024):
            raise ValueError("invalid operator requirement")
        if not isinstance(creator_preferences, (tuple, list)) or len(creator_preferences) > 8:
            raise ValueError("invalid creator preferences")
        if requirement is None and not creator_preferences:
            raise ValueError("generation requires a requirement or creator preferences")
        if not isinstance(basis_refs, tuple) or not basis_refs or len(basis_refs) > 8 or len(set(basis_refs)) != len(basis_refs) or not set(basis_refs) <= set(valid_basis_refs):
            raise ValueError("unvalidated generation basis")
        sourced_preferences = []
        for item in creator_preferences:
            if not isinstance(item, Mapping) or not isinstance(scope, ProfileScope) or item.get("source_kind") != "creator_message":
                raise ValueError("invalid creator preference source")
            if any(item.get(key) != getattr(scope, key) for key in ("owner_user_id", "account_id", "agent_instance_id", "relation_ref")):
                raise ValueError("cross-scope creator preference")
            ref, preference = item.get("source_ref"), item.get("text")
            if not isinstance(ref, str) or ref not in basis_refs or not isinstance(preference, str) or not 0 < len(preference) <= 512:
                raise ValueError("unvalidated creator preference")
            sourced_preferences.append({"source_ref": ref, "text": preference})
        if (
            not isinstance(immutable_identity_facts, Mapping)
            or len(immutable_identity_facts) > 16
            or any(not isinstance(key, str) or not isinstance(value, str) or len(key) > 128 or len(value) > 512 for key, value in immutable_identity_facts.items())
        ):
            raise ValueError("invalid immutable identity facts")
        payload = {
            "base_profile": {"ref": f"{base_profile.profile_id}@{base_profile.version}", "base_template_ref": base_profile.base_template_ref, "overrides": dict(base_profile.overrides)},
            "requirement": requirement,
            "creator_preferences": sourced_preferences,
            "immutable_identity_facts": dict(immutable_identity_facts),
            "basis_refs": list(basis_refs),
        }
        try:
            reply = await asyncio.wait_for(self._get_model().ainvoke([SystemMessage(content=_SYSTEM), HumanMessage(content=json.dumps(payload, ensure_ascii=False, sort_keys=True))], stream=False), timeout=self._timeout_seconds)
            content = getattr(reply, "content", None)
            if not isinstance(content, str) or len(content) > 8192:
                raise ValueError("invalid generator response")
            raw = json.loads(content, object_pairs_hook=_unique_pairs)
        except (TimeoutError, TypeError, ValueError) as exc:
            raise ValueError("invalid generator response") from exc
        if not isinstance(raw, dict) or set(raw) != {"overrides", "diff_summary", "examples"}:
            raise ValueError("invalid generator response fields")
        summary, examples = raw["diff_summary"], raw["examples"]
        if not isinstance(summary, str) or not 0 < len(summary) <= 512 or not isinstance(examples, list) or not 2 <= len(examples) <= 3 or any(not isinstance(item, str) or not 0 < len(item) <= 512 for item in examples):
            raise ValueError("invalid generator explanation")
        patch = PersonaProfile(profile_id=profile_id, version=version, base_template_ref=base_profile.base_template_ref, overrides=raw["overrides"], created_by="generated", basis_refs=basis_refs)
        candidate = PersonaProfile(
            profile_id=profile_id,
            version=version,
            base_template_ref=base_profile.base_template_ref,
            overrides={**base_profile.overrides, **patch.overrides},
            created_by="generated",
            basis_refs=basis_refs,
        )
        return GeneratedPersonaCandidate(candidate=candidate, diff_summary=summary, synthetic_examples=tuple(examples))
