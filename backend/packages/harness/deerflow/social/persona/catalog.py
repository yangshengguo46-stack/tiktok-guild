"""Versioned approved expression templates for native social personas."""

from __future__ import annotations

from collections.abc import Mapping
from types import MappingProxyType

from deerflow.social.assets import load_social_assets

DEFAULT_PROFILE_REF = "relaxed_wit@1.0.1"


def load_persona_catalog() -> Mapping[str, Mapping[str, str | tuple[str, ...]]]:
    """Expose all six immutable 1.0.1 templates without identity prose."""
    assets = load_social_assets()
    return MappingProxyType({f"{name}@{asset['version']}": MappingProxyType({"core": asset["core"], **asset["behavior"], "interests": asset["interests"]}) for name, asset in assets.items()})
