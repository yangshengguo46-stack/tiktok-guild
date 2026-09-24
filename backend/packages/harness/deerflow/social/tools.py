"""Authenticated operator Chat management over native social persistence.

Only six actions are model tools. Resolution remains deterministic host code.
The Gateway admits a typed run capability; JSON context never grants access.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import asdict, dataclass, field, replace
from types import MappingProxyType, SimpleNamespace

from langchain_core.tools import StructuredTool

from deerflow.agents.middlewares.message_utils import is_genuine_user_message
from deerflow.persistence.social import SocialRepository
from deerflow.runtime.context_keys import CURRENT_RUN_PRE_EXISTING_MESSAGE_IDS_KEY
from deerflow.runtime.user_context import resolve_runtime_user_id
from deerflow.social.persona.catalog import load_persona_catalog
from deerflow.social.persona.generator import PersonaProfileGenerator
from deerflow.social.persona.models import PersonaProfile, ProfileScope
from deerflow.social.persona.resolver import resolve_profile
from deerflow.tools.types import Runtime
from deerflow.utils.file_io import run_file_io

MANAGEMENT_CONTEXT_KEY = "__social_management"


@dataclass(eq=False)
class OperatorManagementCapability:
    """Host-only admission, retained solely in RunContext/runtime context.

    Empty identity facts means no verified identity is configured. The generator
    may change expression only; it cannot invent or update identity storage.
    """

    owner_user_id: str
    thread_id: str
    operator_messages: Mapping[str, str] = field(default_factory=dict, repr=False)
    immutable_identity_facts: Mapping[str, str] = field(default_factory=dict, repr=False)
    active: bool = field(default=True, init=False)

    def __post_init__(self):
        ProfileScope(self.owner_user_id, "validation")
        ProfileScope(self.owner_user_id, self.thread_id)
        self.operator_messages = MappingProxyType(dict(self.operator_messages))
        self.immutable_identity_facts = MappingProxyType(dict(self.immutable_identity_facts))

    def release(self):
        self.active = False


def _safe_surface(context):
    return (
        isinstance(context, Mapping)
        and context.get("channel_name") in (None, "chat")
        and not any(context.get(key) for key in ("is_subagent", "agent_name", "is_bootstrap", "social_mode", "__social_binding", "is_internal", "non_interactive"))
    )


def _authorized(runtime, capability):
    context = getattr(runtime, "context", None)
    config = getattr(runtime, "config", None) or {}
    carriers = [context, config.get("context", {}), config.get("configurable", {})]
    return (
        isinstance(capability, OperatorManagementCapability)
        and capability.active
        and isinstance(context, Mapping)
        and context.get(MANAGEMENT_CONTEXT_KEY) is capability
        and all(_safe_surface(value) for value in carriers)
        and resolve_runtime_user_id(runtime) == capability.owner_user_id
        and context.get("thread_id") == capability.thread_id
    )


def _expression(persona):
    return {"profile_ref": persona.profile_ref, "base_template_ref": persona.base_template_ref, "behavior": dict(persona.behavior), "effective_revision": persona.binding_revision, "fingerprint": persona.fingerprint}


class ProfileManagement:
    def __init__(self, repository: SocialRepository, *, capability: OperatorManagementCapability, generator=None):
        self.repository = repository
        self.capability = capability
        self.generator = generator or PersonaProfileGenerator()

    def _check(self, runtime, scope):
        if not isinstance(scope, ProfileScope):
            raise ValueError("explicit ProfileScope is required")
        if not _authorized(runtime, self.capability) or scope.owner_user_id != self.capability.owner_user_id:
            raise PermissionError("authenticated default Lead operator Chat and matching scope owner required")

    async def resolve_profile(self, scope):
        """Read-only deterministic host function, never registered as a tool."""
        profiles, _, state = await self.repository.management_view(scope)
        return _expression(resolve_profile(catalog=await run_file_io(load_persona_catalog), profiles=profiles, bindings=state.bindings))

    async def list_profiles(self, runtime, scope):
        self._check(runtime, scope)
        profiles, revision, state = await self.repository.management_view(scope)
        catalog = await run_file_io(load_persona_catalog)
        active = state.bindings.relation_override_ref or state.bindings.agent_override_ref or state.bindings.account_default_ref
        return {
            "scope": asdict(scope),
            "registry_revision": revision,
            "write_revision": state.write_revision,
            "effective_revision": state.bindings.revision,
            "operator_source_message_ids": sorted(self.capability.operator_messages),
            "profiles": [{"profile_ref": ref, "kind": "template" if ref in catalog else "registered", "status": "active" if ref == active else "available"} for ref in sorted(set(catalog) | set(profiles))],
        }

    async def preview_profile(self, runtime, scope, profile_ref):
        self._check(runtime, scope)
        profiles, _, state = await self.repository.management_view(scope)
        catalog = await run_file_io(load_persona_catalog)
        preview = replace(state.bindings, account_default_ref=profile_ref, agent_override_ref=None, relation_override_ref=None)
        return {"scope": asdict(scope), "current": _expression(resolve_profile(catalog=catalog, profiles=profiles, bindings=state.bindings)), "preview": _expression(resolve_profile(catalog=catalog, profiles=profiles, bindings=preview))}

    async def bind_profile(self, runtime, scope, profile_ref, *, expected_revision, reason):
        self._check(runtime, scope)
        if not isinstance(profile_ref, str) or not profile_ref:
            raise ValueError("explicit profile reference required")
        return await self.repository.manage_profile(scope, profile_ref=profile_ref, expected_revision=expected_revision, reason=reason)

    async def clear_override(self, runtime, scope, *, expected_revision, reason):
        self._check(runtime, scope)
        return await self.repository.manage_profile(scope, expected_revision=expected_revision, reason=reason)

    async def rollback_binding(self, runtime, scope, *, target_revision, expected_revision, reason):
        self._check(runtime, scope)
        return await self.repository.manage_profile(scope, expected_revision=expected_revision, reason=reason, rollback_revision=target_revision)

    async def generate_profile(self, runtime, scope, *, base_profile_ref, profile_id, version, requirement, basis_refs, expected_revision, reason, source_message_id=None, activate=False, expected_binding_revision=None):
        self._check(runtime, scope)
        if type(activate) is not bool or (activate and (type(expected_binding_revision) is not int or expected_binding_revision < 0)):
            raise ValueError("explicit activation requires expected binding revision")
        if type(expected_revision) is not int or expected_revision < 0:
            raise ValueError("explicit expected registry revision is required")
        refs = tuple(basis_refs)
        source_ref = None
        if requirement is not None:
            messages = [message for message in runtime.state.get("messages", []) if getattr(message, "id", None) == source_message_id]
            if not isinstance(source_message_id, str) or len(messages) != 1 or not is_genuine_user_message(messages[0]) or messages[0].additional_kwargs.get("hide_from_ui"):
                raise ValueError("source_message_id must select a genuine current operator message")
            message = messages[0]
            if (
                not isinstance(message.content, str)
                or not isinstance(requirement, str)
                or requirement.strip() != message.content.strip()
                or self.capability.operator_messages.get(source_message_id) != message.content.strip()
                or source_message_id in runtime.context.get(CURRENT_RUN_PRE_EXISTING_MESSAGE_IDS_KEY, ())
            ):
                raise ValueError("requirement must match the admitted current operator message")
            requirement = requirement.strip()
            source_ref = await self.repository.record_management_note(scope, thread_id=self.capability.thread_id, message_id=source_message_id, text=requirement, expected_revision=expected_revision)
            refs = tuple(dict.fromkeys((source_ref, *refs)))
        basis = await self.repository.management_basis(scope, refs)
        if any(item["source_kind"] != "creator_message" and item["source_ref"] != source_ref for item in basis):
            raise ValueError("basis may contain only this management message and selected creator preferences")
        if requirement is not None and not any(item["source_kind"] == "operator_note" and requirement == item["text"] for item in basis):
            raise ValueError("requirement must match a scoped persisted operator note")
        preferences = [{**asdict(scope), "source_kind": "creator_message", "source_ref": item["source_ref"], "text": item["text"]} for item in basis if item["source_kind"] == "creator_message"]
        profiles = await self.repository.get_profiles(scope)
        catalog = await run_file_io(load_persona_catalog)
        if base_profile_ref in catalog:
            base_id, base_version = base_profile_ref.rsplit("@", 1)
            base = PersonaProfile(base_id, base_version, base_profile_ref, {}, "operator", ())
        elif base_profile_ref in profiles:
            base = profiles[base_profile_ref]
        else:
            raise ValueError("unknown or cross-scope base profile")
        generated = await self.generator.generate(
            base_profile=base,
            profile_id=profile_id,
            version=version,
            requirement=requirement,
            creator_preferences=preferences,
            scope=scope,
            immutable_identity_facts=self.capability.immutable_identity_facts,
            basis_refs=refs,
            valid_basis_refs=[item["source_ref"] for item in basis],
        )
        self._check(runtime, scope)  # Recheck after external model I/O, before writing.
        receipt = await self.repository.manage_profile(scope, candidate=generated.candidate, expected_registry_revision=expected_revision, expected_revision=expected_binding_revision, reason=reason, activate=activate)
        return {
            **receipt,
            "generation_status": "candidate",
            "activation_status": "active" if activate else "not_requested",
            "diff_summary": generated.diff_summary,
            "synthetic_examples": list(generated.synthetic_examples),
            "basis_refs": list(generated.candidate.basis_refs),
        }


def tools_for_lead(config, *, repository=None, app_config=None, model_name=None):
    context = config.get("context") or {}
    capability = context.get(MANAGEMENT_CONTEXT_KEY)
    runtime = SimpleNamespace(context=context, config=config)
    if not _authorized(runtime, capability):
        return []
    if repository is None:
        from deerflow.persistence import get_session_factory

        repository = SocialRepository(get_session_factory())
    service = ProfileManagement(repository, capability=capability, generator=PersonaProfileGenerator(app_config=app_config, model_name=model_name))

    async def list_profiles(runtime: Runtime, scope: ProfileScope) -> dict:
        """List six canonical templates and scoped profiles, including CAS revisions."""
        return await service.list_profiles(runtime, scope)

    async def preview_profile(runtime: Runtime, scope: ProfileScope, profile_ref: str) -> dict:
        """Compare expression-only candidate and current effective persona without writing."""
        return await service.preview_profile(runtime, scope, profile_ref)

    async def bind_profile(runtime: Runtime, scope: ProfileScope, profile_ref: str, expected_revision: int, reason: str) -> dict:
        """Explicit operator binding change. Use the target write_revision CAS token."""
        return await service.bind_profile(runtime, scope, profile_ref, expected_revision=expected_revision, reason=reason)

    async def clear_override(runtime: Runtime, scope: ProfileScope, expected_revision: int, reason: str) -> dict:
        """Clear only an agent/relation override and inherit its parent persona."""
        return await service.clear_override(runtime, scope, expected_revision=expected_revision, reason=reason)

    async def rollback_binding(runtime: Runtime, scope: ProfileScope, target_revision: int, expected_revision: int, reason: str) -> dict:
        """Restore an exact scoped historical binding/tombstone by writing a NEW revision."""
        return await service.rollback_binding(runtime, scope, target_revision=target_revision, expected_revision=expected_revision, reason=reason)

    async def generate_profile(
        runtime: Runtime,
        scope: ProfileScope,
        base_profile_ref: str,
        profile_id: str,
        version: str,
        requirement: str | None,
        source_message_id: str | None,
        basis_refs: list[str],
        expected_revision: int,
        reason: str,
        activate: bool = False,
        expected_binding_revision: int | None = None,
    ) -> dict:
        """Generate an expression candidate from a genuine current operator message.

        requirement must equal the message selected by source_message_id. Extra
        basis_refs select same-scope creator preferences. expected_revision is
        registry_revision. Only explicit operator activate=True plus
        expected_binding_revision enables it atomically. Never use for ordinary
        per-message adaptation.
        """
        return await service.generate_profile(
            runtime,
            scope,
            base_profile_ref=base_profile_ref,
            profile_id=profile_id,
            version=version,
            requirement=requirement,
            source_message_id=source_message_id,
            basis_refs=tuple(basis_refs),
            expected_revision=expected_revision,
            reason=reason,
            activate=activate,
            expected_binding_revision=expected_binding_revision,
        )

    return [StructuredTool.from_function(coroutine=fn, name=f"social_{fn.__name__}") for fn in (list_profiles, generate_profile, preview_profile, bind_profile, clear_override, rollback_binding)]
