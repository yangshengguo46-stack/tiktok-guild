"""Profile reference and local expression patch validation."""

from __future__ import annotations

from collections.abc import Mapping

from deerflow.social.persona.models import PersonaProfile


def profile_ref(profile: PersonaProfile) -> str:
    return f"{profile.profile_id}@{profile.version}"


def resolve_base(
    ref: str,
    catalog: Mapping[str, Mapping[str, str | tuple[str, ...]]],
    profiles: Mapping[str, PersonaProfile],
) -> tuple[str, Mapping[str, str | tuple[str, ...]]]:
    if ref in catalog:
        return ref, catalog[ref]
    profile = profiles.get(ref)
    if not isinstance(profile, PersonaProfile) or profile_ref(profile) != ref or profile.base_template_ref not in catalog:
        raise ValueError(f"unknown persona profile reference: {ref}")
    return profile.base_template_ref, {**catalog[profile.base_template_ref], **profile.overrides}
