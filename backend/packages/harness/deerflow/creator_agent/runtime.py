"""Compatibility entry points for Phase 0 Lead assembly."""

from deerflow.social.persona.legacy_runtime import (
    CreatorAgentRuntime,
)
from deerflow.social.persona.legacy_runtime import (
    middlewares_for_lead as _middlewares_for_lead,
)
from deerflow.social.persona.legacy_runtime import (
    runtime_for_lead as _runtime_for_lead,
)

__all__ = ["CreatorAgentRuntime", "middlewares_for_lead", "runtime_for_lead"]


def runtime_for_lead(app_config, model_name):
    return _runtime_for_lead(app_config, model_name, runtime_cls=CreatorAgentRuntime)


def middlewares_for_lead(app_config, model_name, *, creator_runtime=None):
    # Preserve the historical monkeypatchable factory while implementation
    # and CAS logic live in deerflow.social.persona.legacy_runtime.
    if creator_runtime is None:
        creator_runtime = runtime_for_lead(app_config, model_name)
    return _middlewares_for_lead(app_config, model_name, creator_runtime=creator_runtime) if creator_runtime is not None else []
