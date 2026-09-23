"""Offline personality-profile selection and context assembly.

No LLM generation, persistence, authorization service or sending is implemented.
The host must verify provenance/authorization before supplying active profiles.
Overrides remain model-visible DATA, never arbitrary high-priority instructions.
"""
from __future__ import annotations

from copy import deepcopy
import hashlib
import json
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator
from .personas import PersonaSpec, PersonaBinding, PersonaExample, build_context


class Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, frozen=True)


class AssetRef(Contract):
    id: str = Field(pattern=r"^[a-z][a-z0-9_]*$")
    version: str = Field(min_length=1)

    @property
    def key(self) -> str:
        return f"{self.id}@{self.version}"


class StylePatch(Contract):
    core: str | None = Field(default=None, min_length=1)
    attention: str | None = Field(default=None, min_length=1)
    voice: str | None = Field(default=None, min_length=1)
    humor: str | None = Field(default=None, min_length=1)
    disagreement: str | None = Field(default=None, min_length=1)
    care: str | None = Field(default=None, min_length=1)
    initiative: str | None = Field(default=None, min_length=1)
    interests: list[str] | None = None
    length: str | None = Field(default=None, min_length=1)
    questions: str | None = Field(default=None, min_length=1)
    language: str | None = Field(default=None, min_length=1)

    @model_validator(mode="after")
    def nonblank(self):
        for value in self.model_dump(exclude_none=True).values():
            values = value if isinstance(value, list) else [value]
            if any(not x.strip() for x in values):
                raise ValueError("blank style field")
        return self


class PersonaProfile(Contract):
    schema_version: Literal["1.0"] = "1.0"
    profile_id: str = Field(pattern=r"^[a-z][a-z0-9_]*$")
    version: str = Field(min_length=1)
    base_template: AssetRef
    overrides: StylePatch = Field(default_factory=StylePatch)
    # None inherits base examples; [] explicitly supplies no style examples.
    examples: list[PersonaExample] | None = None
    created_by: Literal["operator", "generated"] = "operator"
    basis_refs: list[str] = Field(default_factory=list)
    note: str = ""

    @property
    def key(self) -> str:
        return f"{self.profile_id}@{self.version}"

    @model_validator(mode="after")
    def check_basis(self):
        if self.created_by == "generated" and not self.basis_refs:
            raise ValueError("generated profile needs source references verified by host")
        if any(not x.strip() for x in self.basis_refs):
            raise ValueError("blank basis reference")
        if self.examples is not None:
            ids = [x.id for x in self.examples]
            if len(ids) != len(set(ids)):
                raise ValueError("duplicate profile example")
        return self


class RequestScope(Contract):
    tenant_id: str = Field(min_length=1)
    account_id: str = Field(min_length=1)
    agent_instance_id: str = Field(min_length=1)
    relation_id: str = Field(min_length=1)


class PersonaBindings(Contract):
    # An already-loaded active configuration view, not a DB schema or scheduler.
    scope: RequestScope
    revision: int = Field(ge=1)
    effective_at: str = Field(min_length=1)
    account_default: AssetRef
    agent_override: AssetRef | None = None
    relation_override: AssetRef | None = None


def _fingerprint(value: dict) -> str:
    raw = json.dumps(value, ensure_ascii=False, sort_keys=True, allow_nan=False)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def resolve_profile(*, scope: RequestScope, bindings: PersonaBindings,
                    profiles: dict[str, PersonaProfile], templates: dict[str, PersonaSpec],
                    turn_adjustment: StylePatch | None = None) -> dict:
    """Choose one complete profile, then overlay transient expression settings.

    Higher-scope profiles REPLACE lower profiles; they do not inherit arbitrary
    lower-layer patches. Registry aliases are checked, and missing refs are not
    silently converted to the first/default personality.
    """
    if scope != bindings.scope:
        raise ValueError("binding/request scope mismatch")
    selected_scope = "account"
    ref = bindings.account_default
    for level, override in (("agent", bindings.agent_override),
                            ("relationship", bindings.relation_override)):
        if override is not None:
            selected_scope, ref = level, override
    if ref.key not in profiles:
        raise ValueError(f"unknown active profile: {ref.key}")
    profile = profiles[ref.key]
    if profile.key != ref.key:
        raise ValueError("profile registry/reference mismatch")
    base_key = profile.base_template.key
    if base_key not in templates:
        raise ValueError(f"unknown base template: {base_key}")
    base = templates[base_key]
    if f"{base.id}@{base.version}" != base_key:
        raise ValueError("template registry/reference mismatch")
    style = {"core": base.core, **deepcopy(base.behavior),
             "interests": list(base.interests)}
    style.update(profile.overrides.model_dump(exclude_none=True))
    transient = turn_adjustment or StylePatch()
    style.update(transient.model_dump(exclude_none=True))
    examples = base.examples if profile.examples is None else profile.examples
    # Fingerprint records effective dependencies, not unrelated profiles/contacts.
    provenance = {"scope": scope.model_dump(), "binding_revision": bindings.revision,
                  "effective_at": bindings.effective_at, "selected_scope": selected_scope,
                  "profile": profile.model_dump(mode="json"),
                  "template": base.model_dump(mode="json"),
                  "turn_adjustment": transient.model_dump(exclude_none=True)}
    return {"profile_ref": ref.key, "base_template_ref": base_key,
            "selected_scope": selected_scope, "binding_revision": bindings.revision,
            "effective_style": deepcopy(style),
            "examples": [x.model_dump(mode="json") for x in examples],
            "effective_persona_fingerprint": _fingerprint(provenance)}


def build_profile_context(*, scope: RequestScope, bindings: PersonaBindings,
                          profiles: dict[str, PersonaProfile], templates: dict[str, PersonaSpec],
                          kernel: str, identity_brief: str, history: list[dict],
                          materials=None, example_ids: list[str] | None = None,
                          recipient_preferences: str = "",
                          turn_adjustment: StylePatch | None = None) -> dict:
    """Offline reference, preserving the legacy identity/history contract.

    Host pre-selects relevant history and materials. Structured overrides are
    guidance data; the kernel limits them to style, not identity or authority.
    This does not validate the semantic safety or naturalness of their wording.
    """
    resolved = resolve_profile(scope=scope, bindings=bindings, profiles=profiles,
                               templates=templates, turn_adjustment=turn_adjustment)
    base = templates[resolved["base_template_ref"]]
    out = build_context(kernel=kernel, persona=base,
                        binding=PersonaBinding(agent_instance_id=scope.agent_instance_id,
                                               persona_id=base.id, persona_version=base.version),
                        relation_id=scope.relation_id, identity_brief=identity_brief,
                        history=history, materials=materials, example_ids=[],
                        recipient_preferences=recipient_preferences)
    chosen = example_ids or []
    available = {e["id"]: e for e in resolved["examples"]}
    if len(chosen) != len(set(chosen)) or any(x not in available for x in chosen):
        raise ValueError("unknown/duplicate profile example")
    out["data"]["synthetic_style_examples_not_history"] = [deepcopy(available[x]) for x in chosen]
    out["data"]["effective_persona_style"] = deepcopy(resolved["effective_style"])
    out["data"]["persona_configuration"] = {
        k: resolved[k] for k in ("profile_ref", "selected_scope", "binding_revision",
                                 "effective_persona_fingerprint")}
    out["profile_ref"] = resolved["profile_ref"]
    out["effective_persona_fingerprint"] = resolved["effective_persona_fingerprint"]
    out["context_fingerprint"] = _fingerprint({"legacy": out["context_fingerprint"],
                                               "scope": scope.model_dump(),
                                               "resolved": resolved, "data": out["data"]})
    return out
