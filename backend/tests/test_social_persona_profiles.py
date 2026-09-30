"""Native persona resolution and automatic adaptation boundaries."""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from deerflow.social.assets import load_social_assets
from deerflow.social.persona.catalog import load_persona_catalog
from deerflow.social.persona.generator import PersonaProfileGenerator
from deerflow.social.persona.models import PersonaBindings, PersonaProfile, ProfileScope
from deerflow.social.persona.resolver import resolve_profile
from deerflow.social.persona.selector import AutomaticPersonaSelector

SCOPE = ProfileScope(owner_user_id="owner", account_id="account", relation_ref="creator")
TIME = datetime(2026, 9, 24, tzinfo=UTC)


def bindings(*, account="relaxed_wit@1.0.1", agent=None, relation=None, revision=1):
    return PersonaBindings(scope=SCOPE, account_default_ref=account, agent_override_ref=agent, relation_override_ref=relation, revision=revision, effective_at=TIME)


def test_catalog_preserves_exact_six_approved_templates():
    from deerflow.social.persona import resolve_profile as public_resolve

    assert public_resolve is resolve_profile
    catalog = load_persona_catalog()
    assets = load_social_assets()
    assert set(catalog) == {f"{name}@1.0.1" for name in assets}
    for name, asset in assets.items():
        assert catalog[f"{name}@1.0.1"] == {"core": asset["core"], **asset["behavior"], "interests": asset["interests"]}


def test_null_agent_override_inherits_account_then_relation():
    catalog = load_persona_catalog()
    effective = resolve_profile(catalog=catalog, profiles={}, bindings=bindings(account="relaxed_wit@1.0.1", relation="warm_candid@1.0.1", revision=3), turn_adjustment={"length": "short"})
    assert effective.profile_ref == "warm_candid@1.0.1"
    assert effective.behavior["length"] == "short"
    assert effective.binding_revision == 3
    assert effective.behavior["core"] == catalog["warm_candid@1.0.1"]["core"]
    assert effective.behavior["core"] != catalog["relaxed_wit@1.0.1"]["core"]


def test_profile_patch_is_local_and_fingerprint_tracks_revision_and_evidence():
    catalog = load_persona_catalog()
    profile = PersonaProfile(profile_id="brief", version="2", base_template_ref="quiet_depth@1.0.1", overrides={"voice": "brief"}, created_by="operator", basis_refs=())
    profiles = {"brief@2": profile}
    first = resolve_profile(catalog=catalog, profiles=profiles, bindings=bindings(agent="brief@2"), evidence_version=4)
    assert first.profile_ref == "brief@2"
    assert first.behavior["voice"] == "brief"
    assert first.behavior["core"] == catalog["quiet_depth@1.0.1"]["core"]
    assert first.fingerprint != resolve_profile(catalog=catalog, profiles=profiles, bindings=bindings(agent="brief@2", revision=2), evidence_version=4).fingerprint
    assert first.fingerprint != resolve_profile(catalog=catalog, profiles=profiles, bindings=bindings(agent="brief@2"), evidence_version=5).fingerprint
    assert first.fingerprint == resolve_profile(catalog=catalog, profiles=profiles, bindings=bindings(agent="brief@2"), evidence_version=4).fingerprint


def test_clear_and_rollback_increase_revision_without_mutating_profile():
    catalog = load_persona_catalog()
    switched = resolve_profile(catalog=catalog, profiles={}, bindings=bindings(relation="clear_direct@1.0.1", revision=2))
    cleared = resolve_profile(catalog=catalog, profiles={}, bindings=bindings(revision=3))
    rolled_back = resolve_profile(catalog=catalog, profiles={}, bindings=bindings(relation="clear_direct@1.0.1", revision=4))
    assert cleared.profile_ref == "relaxed_wit@1.0.1"
    assert switched.profile_ref == rolled_back.profile_ref
    assert switched.fingerprint != rolled_back.fingerprint


def test_unknown_reference_and_non_expression_adjustment_fail_closed():
    catalog = load_persona_catalog()
    with pytest.raises(ValueError):
        resolve_profile(catalog=catalog, profiles={}, bindings=bindings(relation="missing@1"))
    with pytest.raises(ValueError):
        resolve_profile(catalog=catalog, profiles={}, bindings=bindings(), turn_adjustment={"identity": "someone else"})
    with pytest.raises(ValueError):
        resolve_profile(catalog=catalog, profiles={}, bindings=bindings(account="missing@1", relation="warm_candid@1.0.1"))


@pytest.mark.parametrize("profile_id,version", [("x@1", "2"), ("x", "1@2")])
def test_persona_profile_never_produces_ambiguous_serialized_ref(profile_id, version):
    with pytest.raises(ValueError, match="separator"):
        PersonaProfile(profile_id, version, "relaxed_wit@1.0.1", {}, "operator", ())


@pytest.mark.asyncio
@pytest.mark.parametrize("profile_id,version", [("x@1", "2"), ("x", "1@2")])
async def test_generator_rejects_ambiguous_identity_before_model_call(profile_id, version):
    model = FakeModel('{"overrides":{"length":"brief"},"diff_summary":"brief","examples":["One","Two"]}')
    with pytest.raises(ValueError, match="separator"):
        await PersonaProfileGenerator(model).generate(
            base_profile=PersonaProfile("base", "1", "relaxed_wit@1.0.1", {}, "operator", ()),
            profile_id=profile_id,
            version=version,
            requirement="brief",
            creator_preferences=(),
            immutable_identity_facts={},
            basis_refs=("note",),
            valid_basis_refs=("note",),
        )
    assert model.calls == []


class FakeModel:
    def __init__(self, content):
        self.content = content
        self.calls = []

    async def ainvoke(self, messages, **kwargs):
        self.calls.append((messages, kwargs))
        return type("Reply", (), {"content": self.content})()


@pytest.mark.asyncio
async def test_automatic_choice_requires_new_owned_creator_evidence_and_cas_inputs():
    model = FakeModel('{"action":"switch","persona_id":"clear_direct","confidence":0.8,"evidence_refs":["creator:m1"],"reason":"asked for directness"}')
    selector = AutomaticPersonaSelector(model=model)
    evidence = [{"source_ref": "creator:m1", "source_kind": "creator_message", "owner_user_id": "owner", "account_id": "account", "relation_ref": "creator", "evidence_version": 2, "text": "Be direct"}]
    result = await selector.choose(scope=SCOPE, current_profile_ref="relaxed_wit@1.0.1", candidates=load_persona_catalog(), evidence=evidence, evidence_version=2, evaluated_evidence_version=1, binding_revision=3)
    assert result is not None
    assert result.profile_ref == "clear_direct@1.0.1"
    assert (result.expected_evidence_version, result.expected_binding_revision) == (2, 3)
    assert len(model.calls) == 1
    assert await selector.choose(scope=SCOPE, current_profile_ref="relaxed_wit@1.0.1", candidates=load_persona_catalog(), evidence=evidence, evidence_version=2, evaluated_evidence_version=2, binding_revision=3) is None
    assert len(model.calls) == 1


@pytest.mark.asyncio
async def test_automatic_choice_accepts_canonical_versioned_ref_without_double_suffix():
    model = FakeModel('{"action":"switch","persona_id":"clear_direct@1.0.1","confidence":0.8,"evidence_refs":["creator:m1"],"reason":"asked for directness"}')
    selector = AutomaticPersonaSelector(model=model)
    evidence = [{"source_ref": "creator:m1", "source_kind": "creator_message", "owner_user_id": "owner", "account_id": "account", "relation_ref": "creator", "evidence_version": 2, "text": "Be direct"}]
    result = await selector.choose(scope=SCOPE, current_profile_ref="relaxed_wit@1.0.1", candidates=load_persona_catalog(), evidence=evidence, evidence_version=2, evaluated_evidence_version=1, binding_revision=3)
    assert result is not None
    assert result.profile_ref == "clear_direct@1.0.1"


@pytest.mark.asyncio
async def test_automatic_choice_rejects_cross_scope_and_low_confidence():
    model = FakeModel('{"action":"switch","persona_id":"clear_direct","confidence":0.74,"evidence_refs":["creator:m1"],"reason":"direct"}')
    selector = AutomaticPersonaSelector(model=model)
    evidence = [{"source_ref": "creator:m1", "source_kind": "creator_message", "owner_user_id": "other", "account_id": "account", "relation_ref": "creator", "evidence_version": 2, "text": "Be direct"}]
    assert await selector.choose(scope=SCOPE, current_profile_ref="relaxed_wit@1.0.1", candidates=load_persona_catalog(), evidence=evidence, evidence_version=2, evaluated_evidence_version=1, binding_revision=3) is None
    assert not model.calls


@pytest.mark.asyncio
async def test_selector_ignores_old_creator_quote_when_new_version_is_other_source():
    model = FakeModel('{"action":"switch","persona_id":"clear_direct","confidence":0.99,"evidence_refs":["creator:m1"],"reason":"direct"}')
    selector = AutomaticPersonaSelector(model=model)
    evidence = [{"source_ref": "creator:m1", "source_kind": "creator_message", "owner_user_id": "owner", "account_id": "account", "relation_ref": "creator", "evidence_version": 1, "text": "Be direct"}]
    assert await selector.choose(scope=SCOPE, current_profile_ref="relaxed_wit@1.0.1", candidates=load_persona_catalog(), evidence=evidence, evidence_version=2, evaluated_evidence_version=1, binding_revision=3) is None
    assert not model.calls


@pytest.mark.asyncio
@pytest.mark.parametrize("agent_id", [None, "agent-a"])
async def test_selector_rejects_explicit_other_agent_evidence(agent_id):
    scope = ProfileScope(owner_user_id="owner", account_id="account", agent_instance_id=agent_id, relation_ref="creator")
    model = FakeModel('{"action":"switch","persona_id":"clear_direct","confidence":0.99,"evidence_refs":["creator:m1"],"reason":"direct"}')
    selector = AutomaticPersonaSelector(model=model)
    evidence = [{"source_ref": "creator:m1", "source_kind": "creator_message", "owner_user_id": "owner", "account_id": "account", "agent_instance_id": "agent-b", "relation_ref": "creator", "evidence_version": 2, "text": "Be direct"}]
    assert await selector.choose(scope=scope, current_profile_ref="relaxed_wit@1.0.1", candidates=load_persona_catalog(), evidence=evidence, evidence_version=2, evaluated_evidence_version=1, binding_revision=3) is None
    assert not model.calls


@pytest.mark.asyncio
async def test_selector_rejects_noncreator_latest_version_despite_newer_creator_quote():
    model = FakeModel('{"action":"switch","persona_id":"clear_direct","confidence":0.99,"evidence_refs":["creator:m2"],"reason":"direct"}')
    selector = AutomaticPersonaSelector(model=model)
    evidence = [
        {"source_ref": "creator:m2", "source_kind": "creator_message", "owner_user_id": "owner", "account_id": "account", "relation_ref": "creator", "evidence_version": 2, "text": "Be direct"},
        {"source_ref": "operator:n3", "source_kind": "operator_note", "owner_user_id": "owner", "account_id": "account", "relation_ref": "creator", "evidence_version": 3, "text": "Use a different style"},
    ]
    assert await selector.choose(scope=SCOPE, current_profile_ref="relaxed_wit@1.0.1", candidates=load_persona_catalog(), evidence=evidence, evidence_version=3, evaluated_evidence_version=1, binding_revision=3) is None
    assert not model.calls


@pytest.mark.asyncio
async def test_selector_rejects_unapproved_candidate_content():
    model = FakeModel('{"action":"switch","persona_id":"clear_direct","confidence":0.99,"evidence_refs":["creator:m1"],"reason":"direct"}')
    selector = AutomaticPersonaSelector(model=model)
    candidates = {ref: dict(value) for ref, value in load_persona_catalog().items()}
    candidates["clear_direct@1.0.1"]["identity"] = "pretend to be human"
    evidence = [{"source_ref": "creator:m1", "source_kind": "creator_message", "owner_user_id": "owner", "account_id": "account", "relation_ref": "creator", "evidence_version": 2, "text": "Be direct"}]
    assert await selector.choose(scope=SCOPE, current_profile_ref="relaxed_wit@1.0.1", candidates=candidates, evidence=evidence, evidence_version=2, evaluated_evidence_version=1, binding_revision=3) is None
    assert not model.calls


@pytest.mark.asyncio
async def test_selector_can_replace_current_custom_profile_with_approved_template():
    model = FakeModel('{"action":"switch","persona_id":"clear_direct","confidence":0.99,"evidence_refs":["creator:m1"],"reason":"direct"}')
    selector = AutomaticPersonaSelector(model=model)
    evidence = [{"source_ref": "creator:m1", "source_kind": "creator_message", "owner_user_id": "owner", "account_id": "account", "relation_ref": "creator", "evidence_version": 2, "text": "Be direct"}]
    choice = await selector.choose(scope=SCOPE, current_profile_ref="custom@1", candidates=load_persona_catalog(), evidence=evidence, evidence_version=2, evaluated_evidence_version=1, binding_revision=3)
    assert choice is not None and choice.profile_ref == "clear_direct@1.0.1"


@pytest.mark.asyncio
async def test_generator_returns_immutable_unactivated_candidate_with_synthetic_examples():
    model = FakeModel('{"overrides":{"voice":"brief and warm"},"diff_summary":"Shorter replies","examples":["Synthetic: Hello briefly.","Synthetic: Thanks for sharing."]}')
    generator = PersonaProfileGenerator(model=model)
    base = PersonaProfile(profile_id="base", version="1", base_template_ref="relaxed_wit@1.0.1", overrides={}, created_by="operator", basis_refs=())
    result = await generator.generate(
        base_profile=base, profile_id="brief", version="1", requirement="Keep replies short", creator_preferences=(), immutable_identity_facts={"name": "Guild AI"}, basis_refs=("operator:req-1",), valid_basis_refs=("operator:req-1",)
    )
    assert result.candidate.profile_id == "brief"
    assert result.candidate.overrides["voice"] == "brief and warm"
    assert result.diff_summary == "Shorter replies"
    assert len(result.synthetic_examples) == 2
    assert result.activated is False
    with pytest.raises(TypeError):
        result.candidate.overrides["voice"] = "changed"
    assert model.calls[0][1]["stream"] is False


@pytest.mark.asyncio
async def test_generator_normalizes_json_interests_array_to_immutable_tuple():
    model = FakeModel('{"overrides":{"interests":["tea"],"voice":"brief"},"diff_summary":"Shorter replies","examples":["Synthetic: Hello briefly.","Synthetic: Thanks for sharing."]}')
    generator = PersonaProfileGenerator(model=model)
    base = PersonaProfile(profile_id="base", version="1", base_template_ref="relaxed_wit@1.0.1", overrides={}, created_by="operator", basis_refs=())

    result = await generator.generate(
        base_profile=base,
        profile_id="brief",
        version="1",
        requirement="Keep replies short",
        creator_preferences=(),
        immutable_identity_facts={"name": "Guild AI"},
        basis_refs=("operator:req-1",),
        valid_basis_refs=("operator:req-1",),
    )

    assert result.candidate.overrides["interests"] == ("tea",)


@pytest.mark.asyncio
async def test_generator_rejects_non_string_json_interest_items():
    model = FakeModel('{"overrides":{"interests":["tea",1],"voice":"brief"},"diff_summary":"Shorter replies","examples":["Synthetic: Hello briefly.","Synthetic: Thanks for sharing."]}')
    generator = PersonaProfileGenerator(model=model)
    base = PersonaProfile(profile_id="base", version="1", base_template_ref="relaxed_wit@1.0.1", overrides={}, created_by="operator", basis_refs=())

    with pytest.raises(ValueError, match="invalid generator interests"):
        await generator.generate(
            base_profile=base,
            profile_id="brief",
            version="1",
            requirement="Keep replies short",
            creator_preferences=(),
            immutable_identity_facts={"name": "Guild AI"},
            basis_refs=("operator:req-1",),
            valid_basis_refs=("operator:req-1",),
        )


@pytest.mark.asyncio
async def test_generator_prompt_states_exact_json_contract_and_no_commentary():
    model = FakeModel('{"overrides":{"voice":"brief and warm"},"diff_summary":"Shorter replies","examples":["Synthetic: Hello briefly.","Synthetic: Thanks for sharing."]}')
    generator = PersonaProfileGenerator(model=model)
    base = PersonaProfile(profile_id="base", version="1", base_template_ref="relaxed_wit@1.0.1", overrides={}, created_by="operator", basis_refs=())

    await generator.generate(
        base_profile=base,
        profile_id="brief",
        version="1",
        requirement="Keep replies short",
        creator_preferences=(),
        immutable_identity_facts={"name": "Guild AI"},
        basis_refs=("operator:req-1",),
        valid_basis_refs=("operator:req-1",),
    )

    system_prompt = model.calls[0][0][0].content
    assert "exactly these top-level JSON keys: overrides, diff_summary, examples" in system_prompt
    assert "overrides must be a flat JSON object" in system_prompt
    assert "keys must be a subset of exactly: core, attention, voice, humor, disagreement, care, initiative, interests, length, questions, language" in system_prompt
    assert "Every value must be a string, except interests which must be an array of strings" in system_prompt
    assert "Do not use nested objects such as style or response_format" in system_prompt
    assert "diff_summary must be a non-empty string of 1..512 characters" in system_prompt
    assert "examples must be a JSON array of exactly 2 or 3 non-empty strings, each 1..512 characters" in system_prompt
    assert "Do not include markdown, code fences, or commentary" in system_prompt


def test_generator_default_timeout_covers_configured_model_latency():
    assert PersonaProfileGenerator()._timeout_seconds >= 30


@pytest.mark.asyncio
async def test_generator_rejects_unknown_basis_and_identity_rewrite():
    model = FakeModel('{"overrides":{"identity":"human"},"diff_summary":"identity changed","examples":["Synthetic: one","Synthetic: two"]}')
    generator = PersonaProfileGenerator(model=model)
    base = PersonaProfile(profile_id="base", version="1", base_template_ref="relaxed_wit@1.0.1", overrides={}, created_by="operator", basis_refs=())
    with pytest.raises(ValueError):
        await generator.generate(base_profile=base, profile_id="brief", version="1", requirement="brief", creator_preferences=(), immutable_identity_facts={"name": "Guild AI"}, basis_refs=("unknown",), valid_basis_refs=("operator:req-1",))
    assert not model.calls
    with pytest.raises(ValueError):
        await generator.generate(
            base_profile=base, profile_id="brief", version="1", requirement="brief", creator_preferences=(), immutable_identity_facts={"name": "Guild AI"}, basis_refs=("operator:req-1",), valid_basis_refs=("operator:req-1",)
        )


@pytest.mark.asyncio
async def test_generator_rejects_unsourced_or_cross_scope_creator_preference():
    model = FakeModel('{"overrides":{"voice":"brief"},"diff_summary":"brief","examples":["Synthetic: one","Synthetic: two"]}')
    generator = PersonaProfileGenerator(model=model)
    base = PersonaProfile(profile_id="base", version="1", base_template_ref="relaxed_wit@1.0.1", overrides={}, created_by="operator", basis_refs=())
    for source_kind, owner in (("operator_note", "owner"), ("creator_message", "other")):
        with pytest.raises(ValueError):
            await generator.generate(
                base_profile=base,
                profile_id="brief",
                version="1",
                requirement=None,
                creator_preferences=({"source_ref": "creator:m1", "source_kind": source_kind, "owner_user_id": owner, "account_id": "account", "relation_ref": "creator", "text": "Please be brief"},),
                scope=SCOPE,
                immutable_identity_facts={"name": "Guild AI"},
                basis_refs=("creator:m1",),
                valid_basis_refs=("creator:m1",),
            )
    assert not model.calls


@pytest.mark.asyncio
@pytest.mark.parametrize("agent_id", [None, "agent-a"])
async def test_generator_rejects_explicit_other_agent_preference(agent_id):
    scope = ProfileScope(owner_user_id="owner", account_id="account", agent_instance_id=agent_id, relation_ref="creator")
    model = FakeModel('{"overrides":{"voice":"brief"},"diff_summary":"brief","examples":["Synthetic: one","Synthetic: two"]}')
    generator = PersonaProfileGenerator(model=model)
    base = PersonaProfile(profile_id="base", version="1", base_template_ref="relaxed_wit@1.0.1", overrides={}, created_by="operator", basis_refs=())
    with pytest.raises(ValueError):
        await generator.generate(
            base_profile=base,
            profile_id="brief",
            version="1",
            requirement=None,
            creator_preferences=({"source_ref": "creator:m1", "source_kind": "creator_message", "owner_user_id": "owner", "account_id": "account", "agent_instance_id": "agent-b", "relation_ref": "creator", "text": "Please be brief"},),
            scope=scope,
            immutable_identity_facts={"name": "Guild AI"},
            basis_refs=("creator:m1",),
            valid_basis_refs=("creator:m1",),
        )
    assert not model.calls


@pytest.mark.asyncio
async def test_generator_patches_custom_base_preserving_unspecified_fields():
    model = FakeModel('{"overrides":{"voice":"direct"},"diff_summary":"More direct","examples":["Synthetic: one","Synthetic: two"]}')
    generator = PersonaProfileGenerator(model=model)
    base = PersonaProfile(profile_id="custom", version="1", base_template_ref="relaxed_wit@1.0.1", overrides={"voice": "soft", "care": "patient"}, created_by="operator", basis_refs=())
    result = await generator.generate(
        base_profile=base, profile_id="updated", version="2", requirement="Speak directly", creator_preferences=(), immutable_identity_facts={"name": "Guild AI"}, basis_refs=("operator:req-1",), valid_basis_refs=("operator:req-1",)
    )
    assert dict(result.candidate.overrides) == {"voice": "direct", "care": "patient"}
    assert dict(base.overrides) == {"voice": "soft", "care": "patient"}


@pytest.mark.asyncio
async def test_generator_requires_approved_base_template():
    model = FakeModel('{"overrides":{"voice":"brief"},"diff_summary":"brief","examples":["Synthetic: one","Synthetic: two"]}')
    generator = PersonaProfileGenerator(model=model)
    base = PersonaProfile(profile_id="base", version="1", base_template_ref="invented@1", overrides={}, created_by="operator", basis_refs=())
    with pytest.raises(ValueError):
        await generator.generate(base_profile=base, profile_id="brief", version="1", requirement="brief", creator_preferences=(), immutable_identity_facts={}, basis_refs=("operator:req-1",), valid_basis_refs=("operator:req-1",))
    assert not model.calls


def test_phase_zero_imports_reexport_native_implementations():
    from deerflow.creator_agent.persona_selector import PersonaSelector
    from deerflow.creator_agent.personas import load_personas
    from deerflow.creator_agent.runtime import CreatorAgentRuntime
    from deerflow.social.persona.legacy_catalog import load_personas as native_load
    from deerflow.social.persona.legacy_runtime import CreatorAgentRuntime as NativeRuntime
    from deerflow.social.persona.legacy_selector import PersonaSelector as NativeSelector

    assert PersonaSelector is NativeSelector
    assert load_personas is native_load
    assert CreatorAgentRuntime is NativeRuntime
