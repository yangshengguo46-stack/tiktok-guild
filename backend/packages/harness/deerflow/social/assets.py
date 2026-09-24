"""Load the approved persona expression subset as immutable data."""

from __future__ import annotations

import json
import os
from collections.abc import Mapping
from hashlib import sha256
from pathlib import Path
from types import MappingProxyType

from deerflow.social.contracts import bounded_refs, bounded_text

_PERSONA_IDS = frozenset({"relaxed_wit", "clear_direct", "curious_explorer", "observant_warmth", "quiet_depth", "warm_candid"})
_BEHAVIOR_FIELDS = frozenset({"attention", "voice", "humor", "disagreement", "care", "initiative"})
_DEFAULT_ROOT = Path(__file__).resolve().parents[5] / "docs" / "product" / "creator-agent-final-persona-rev1"
_APPROVED_MANIFEST_SHA256 = "cb1246bdc1a8c2c68dcf3d1df89d0d67e727a60ef1e2db8fe823998d55d69b24"


def _unique_fields(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate asset field: {key}")
        result[key] = value
    return result


def load_social_assets(root: Path | None = None) -> Mapping[str, Mapping[str, object]]:
    """Read six versioned style assets, omitting identity and authority prose.

    The package is verified against MANIFEST.json by
    ``scripts/verify_creator_agent_assets.py`` before packaging. This loader
    accepts only the expression subset for downstream persona resolution.
    """
    if root is not None:
        source = Path(root)
    elif configured := os.environ.get("DEER_FLOW_SOCIAL_ASSETS_PATH"):
        source = Path(configured)
        if not source.is_absolute():
            raise ValueError("DEER_FLOW_SOCIAL_ASSETS_PATH must be absolute")
    else:
        source = _DEFAULT_ROOT
    if source.is_symlink():
        raise ValueError("social asset root symlink is not allowed")
    source = source.resolve(strict=True)
    manifest_path = source / "MANIFEST.json"
    persona_root = source / "personas"
    if manifest_path.is_symlink() or persona_root.is_symlink():
        raise ValueError("social asset symlink is not allowed")
    manifest_raw = manifest_path.read_bytes()
    if sha256(manifest_raw).hexdigest() != _APPROVED_MANIFEST_SHA256:
        raise ValueError("social assets do not match the approved manifest")
    manifest = json.loads(manifest_raw.decode("utf-8"), object_pairs_hook=_unique_fields)
    if not isinstance(manifest, dict) or not isinstance(manifest.get("files"), list):
        raise ValueError("invalid approved social asset manifest")
    approved_files: dict[str, tuple[int, str]] = {}
    for entry in manifest["files"]:
        if not isinstance(entry, dict) or set(entry) != {"path", "bytes", "sha256"}:
            raise ValueError("invalid approved social asset manifest entry")
        approved_files[entry["path"]] = (entry["bytes"], entry["sha256"])
    catalog: dict[str, Mapping[str, object]] = {}
    for persona_id in sorted(_PERSONA_IDS):
        relative = f"personas/{persona_id}.json"
        path = source / relative
        if path.is_symlink():
            raise ValueError(f"social asset symlink is not allowed: {relative}")
        with path.open("rb") as file:
            raw = file.read(16_385)
        if len(raw) > 16_384:
            raise ValueError(f"persona asset exceeds 16 KiB: {persona_id}")
        expected = approved_files.get(relative)
        if expected is None or expected != (len(raw), sha256(raw).hexdigest()):
            raise ValueError(f"persona asset does not match approved manifest: {persona_id}")
        document = json.loads(raw.decode("utf-8"), object_pairs_hook=_unique_fields)
        if not isinstance(document, dict) or document.get("id") != persona_id or document.get("version") != "1.0.1" or document.get("kind") != "behavioral_persona_not_identity":
            raise ValueError(f"invalid persona asset identity: {persona_id}")
        core = document.get("core")
        bounded_text(core, "core", 512)  # type: ignore[arg-type]
        behavior = document.get("behavior")
        if not isinstance(behavior, dict) or set(behavior) != _BEHAVIOR_FIELDS:
            raise ValueError(f"invalid persona behavior: {persona_id}")
        for key, value in behavior.items():
            bounded_text(value, key, 256)
        interests = document.get("interests")
        if not isinstance(interests, list):
            raise ValueError(f"invalid persona interests: {persona_id}")
        bounded_refs(tuple(interests), "interests", maximum=8, minimum=1)
        catalog[persona_id] = MappingProxyType(
            {
                "id": persona_id,
                "version": "1.0.1",
                "core": core,
                "behavior": MappingProxyType(dict(behavior)),
                "interests": tuple(interests),
            }
        )
    return MappingProxyType(catalog)
