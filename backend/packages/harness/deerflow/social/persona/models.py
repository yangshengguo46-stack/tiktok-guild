"""Immutable persona profiles and binding snapshots; resolution is separate."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime
from types import MappingProxyType
from typing import Literal

from deerflow.social.contracts import bounded_refs, bounded_text

_EXPRESSION_FIELDS = frozenset({"core", "attention", "voice", "humor", "disagreement", "care", "initiative", "interests", "length", "questions", "language"})


def _expression(values: Mapping[str, str | tuple[str, ...]]) -> Mapping[str, str | tuple[str, ...]]:
    if not isinstance(values, Mapping) or len(values) > len(_EXPRESSION_FIELDS) or set(values) - _EXPRESSION_FIELDS:
        raise ValueError("persona behavior contains non-expression fields")
    result: dict[str, str | tuple[str, ...]] = {}
    for key, value in values.items():
        if key == "interests":
            bounded_refs(value, "interests", maximum=8)  # type: ignore[arg-type]
        else:
            bounded_text(value, key, 512 if key == "core" else 256)  # type: ignore[arg-type]
        result[key] = value
    return MappingProxyType(result)


@dataclass(frozen=True)
class ProfileScope:
    owner_user_id: str
    account_id: str
    agent_instance_id: str | None = None
    relation_ref: str | None = None

    def __post_init__(self) -> None:
        bounded_text(self.owner_user_id, "owner_user_id", 128)
        bounded_text(self.account_id, "account_id", 128)
        for name in ("agent_instance_id", "relation_ref"):
            value = getattr(self, name)
            if value is not None:
                bounded_text(value, name, 128)


@dataclass(frozen=True)
class PersonaProfile:
    profile_id: str
    version: str
    base_template_ref: str
    overrides: Mapping[str, str | tuple[str, ...]]
    created_by: Literal["operator", "generated"]
    basis_refs: tuple[str, ...]

    def __post_init__(self) -> None:
        for name in ("profile_id", "version", "base_template_ref"):
            bounded_text(getattr(self, name), name, 128)
        if "@" in self.profile_id or "@" in self.version:
            raise ValueError("profile_id and version must not contain the @ reference separator")
        if self.base_template_ref.count("@") != 1 or not all(self.base_template_ref.split("@")):
            raise ValueError("base_template_ref must be an id@version reference")
        if self.created_by not in {"operator", "generated"}:
            raise ValueError("invalid profile creator")
        bounded_refs(self.basis_refs, "basis_refs", minimum=1 if self.created_by == "generated" else 0)
        object.__setattr__(self, "overrides", _expression(self.overrides))


@dataclass(frozen=True)
class PersonaBindings:
    scope: ProfileScope
    account_default_ref: str
    agent_override_ref: str | None
    relation_override_ref: str | None
    revision: int
    effective_at: datetime

    def __post_init__(self) -> None:
        if not isinstance(self.scope, ProfileScope):
            raise ValueError("scope must be a ProfileScope")
        bounded_text(self.account_default_ref, "account_default_ref", 128)
        for name in ("agent_override_ref", "relation_override_ref"):
            value = getattr(self, name)
            if value is not None:
                bounded_text(value, name, 128)
        if type(self.revision) is not int or self.revision < 1:
            raise ValueError("revision must be positive")
        if not isinstance(self.effective_at, datetime) or self.effective_at.tzinfo is None or self.effective_at.utcoffset() is None:
            raise ValueError("effective_at must be timezone-aware")


@dataclass(frozen=True)
class EffectivePersona:
    profile_ref: str
    base_template_ref: str
    behavior: Mapping[str, str | tuple[str, ...]]
    binding_revision: int
    evidence_version: int
    fingerprint: str

    def __post_init__(self) -> None:
        bounded_text(self.profile_ref, "profile_ref", 128)
        bounded_text(self.base_template_ref, "base_template_ref", 128)
        object.__setattr__(self, "behavior", _expression(self.behavior))
        if type(self.binding_revision) is not int or self.binding_revision < 1:
            raise ValueError("binding_revision must be positive")
        if type(self.evidence_version) is not int or self.evidence_version < 0:
            raise ValueError("evidence_version must be nonnegative")
        if not isinstance(self.fingerprint, str) or len(self.fingerprint) != 64 or any(c not in "0123456789abcdef" for c in self.fingerprint):
            raise ValueError("fingerprint must be a SHA-256 hex digest")
