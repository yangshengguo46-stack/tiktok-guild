"""Strict, side-effect-free creator persona catalog and snapshot resolution."""

from __future__ import annotations

import hashlib
import json
import os
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from types import MappingProxyType

DEFAULT_PERSONA_ID = "relaxed_wit"
DECISION_POLICY_VERSION = "1"
_PERSONA_IDS = frozenset(
    {
        DEFAULT_PERSONA_ID,
        "clear_direct",
        "curious_explorer",
        "observant_warmth",
        "quiet_depth",
        "warm_candid",
    }
)
_BEHAVIOR_FIELDS = frozenset({"attention", "voice", "humor", "disagreement", "care", "initiative"})
_ASSET_FIELDS = frozenset({"id", "version", "core", "behavior", "interests"})
_SCOPE_FIELDS = frozenset({"operator_id", "account_id", "creator_uid"})
_FINGERPRINT_FIELDS = (
    "scope",
    "persona_id",
    "persona_version",
    "core",
    "behavior",
    "interests",
    "persona_revision",
    "evidence_version",
    "decision_policy_version",
)
_DEFAULT_CATALOG_PATH = Path(__file__).resolve().parents[5] / "ops" / "guild-runtime" / "config" / "personas.json"


@dataclass(frozen=True)
class PersonaAsset:
    id: str
    version: str
    core: str
    behavior: Mapping[str, str]
    interests: tuple[str, ...]


def _text(value: object, *, max_length: int) -> bool:
    return isinstance(value, str) and bool(value.strip()) and len(value) <= max_length


def _unique_pairs(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate persona catalog field: {key}")
        result[key] = value
    return result


def load_personas(path: str | None = None) -> dict[str, PersonaAsset]:
    """Load exactly the six approved expression assets from a bounded JSON file."""
    source = Path(path or os.environ.get("DEER_FLOW_GUILD_PERSONAS_PATH") or _DEFAULT_CATALOG_PATH)
    with source.open("rb") as file:
        raw = file.read(32_769)
    if len(raw) > 32_768:
        raise ValueError("persona catalog exceeds 32 KiB")
    document = json.loads(raw.decode("utf-8"), object_pairs_hook=_unique_pairs)
    if not isinstance(document, dict) or set(document) != {"schema_version", "personas"}:
        raise ValueError("invalid persona catalog fields")
    if document["schema_version"] != "1.0":
        raise ValueError("unsupported persona catalog schema")
    rows = document["personas"]
    if not isinstance(rows, list) or len(rows) != len(_PERSONA_IDS):
        raise ValueError("persona catalog must contain exactly six assets")

    catalog: dict[str, PersonaAsset] = {}
    for row in rows:
        if not isinstance(row, dict) or set(row) != _ASSET_FIELDS:
            raise ValueError("invalid persona asset fields")
        persona_id = row["id"]
        if not isinstance(persona_id, str) or persona_id not in _PERSONA_IDS or persona_id in catalog:
            raise ValueError("unknown or duplicate persona id")
        if row["version"] != "1.0.1" or not _text(row["core"], max_length=512):
            raise ValueError("invalid persona version or core")
        behavior = row["behavior"]
        if not isinstance(behavior, dict) or set(behavior) != _BEHAVIOR_FIELDS or any(not _text(value, max_length=256) for value in behavior.values()):
            raise ValueError("invalid persona behavior fields")
        interests = row["interests"]
        if not isinstance(interests, list) or not 1 <= len(interests) <= 8 or any(not _text(value, max_length=128) for value in interests):
            raise ValueError("invalid persona interests")
        catalog[persona_id] = PersonaAsset(
            id=persona_id,
            version=row["version"],
            core=row["core"],
            behavior=MappingProxyType(dict(behavior)),
            interests=tuple(interests),
        )
    return catalog


def resolve_persona(
    catalog: Mapping[str, PersonaAsset],
    stored_state: Mapping[str, object] | None,
    *,
    scope: Mapping[str, str],
    context_version: int,
) -> dict:
    """Render one scoped expression asset; invalid stored references use the default."""
    if set(scope) != _SCOPE_FIELDS or any(not _text(scope[key], max_length=128) for key in _SCOPE_FIELDS):
        raise ValueError("invalid persona scope")
    if type(context_version) is not int or context_version < 0:
        raise ValueError("invalid context version")
    state = stored_state if isinstance(stored_state, Mapping) else {}
    persona_id = state.get("persona_id")
    revision = state.get("persona_revision")
    evidence_version = state.get("evidence_version")
    valid_state = (
        isinstance(persona_id, str)
        and persona_id in catalog
        and state.get("scope", scope) == scope
        and type(revision) is int
        and revision >= 0
        and type(evidence_version) is int
        and 0 <= evidence_version <= context_version
        and state.get("persona_version", catalog[persona_id].version) == catalog[persona_id].version
    )
    if not valid_state:
        persona_id = DEFAULT_PERSONA_ID
        revision = 0
        evidence_version = 0
    asset = catalog[persona_id]
    return {
        "scope": {key: scope[key] for key in sorted(_SCOPE_FIELDS)},
        "persona_id": asset.id,
        "persona_version": asset.version,
        "core": asset.core,
        "behavior": dict(asset.behavior),
        "interests": list(asset.interests),
        "persona_revision": revision,
        "evidence_version": evidence_version,
        "decision_policy_version": DECISION_POLICY_VERSION,
    }


def effective_persona_fingerprint(snapshot: dict) -> str:
    """Hash only the effective expression, scope, and decision revision fields."""
    effective = {key: snapshot[key] for key in _FINGERPRINT_FIELDS}
    encoded = json.dumps(effective, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()
