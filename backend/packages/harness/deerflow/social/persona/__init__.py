"""Native social persona assets, profiles, selection and generation."""

from deerflow.social.persona.catalog import DEFAULT_PROFILE_REF, load_persona_catalog
from deerflow.social.persona.generator import GeneratedPersonaCandidate, PersonaProfileGenerator
from deerflow.social.persona.models import EffectivePersona, PersonaBindings, PersonaProfile, ProfileScope
from deerflow.social.persona.resolver import resolve_profile


def __getattr__(name: str):
    # ``selector`` depends on ``deerflow.runtime``.  Loading it while
    # ``ThreadState`` imports the social state creates a cycle back through
    # ``runtime.checkpoint_state``.  Keep the public exports, but resolve the
    # selector only when a caller actually asks for it.
    if name in {"AutomaticPersonaChoice", "AutomaticPersonaSelector"}:
        from deerflow.social.persona.selector import AutomaticPersonaChoice, AutomaticPersonaSelector

        return {"AutomaticPersonaChoice": AutomaticPersonaChoice, "AutomaticPersonaSelector": AutomaticPersonaSelector}[name]
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


__all__ = [
    "AutomaticPersonaChoice",
    "AutomaticPersonaSelector",
    "DEFAULT_PROFILE_REF",
    "EffectivePersona",
    "GeneratedPersonaCandidate",
    "PersonaBindings",
    "PersonaProfile",
    "PersonaProfileGenerator",
    "ProfileScope",
    "load_persona_catalog",
    "resolve_profile",
]
