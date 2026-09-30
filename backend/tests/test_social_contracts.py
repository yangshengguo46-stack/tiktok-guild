"""Strict bounded native contracts for a social turn and persona view."""

from __future__ import annotations

from dataclasses import FrozenInstanceError
from datetime import UTC, datetime

import pytest

from deerflow.social.contracts import ClaimPatch, FollowUp, IdentityProfile, RoleProfile, SocialAction, SocialScope, TurnResult
from deerflow.social.persona.models import EffectivePersona, PersonaBindings, PersonaProfile, ProfileScope
from deerflow.social.turns import parse_turn_result


def test_turn_result_distinguishes_reply_wait_and_no_reply():
    assert TurnResult(reply="hello").action is SocialAction.REPLY
    assert TurnResult(reply=None, followup=FollowUp(check="recheck", cancel_when="creator replies")).action is SocialAction.WAIT
    assert TurnResult(reply=None).action is SocialAction.NO_REPLY


@pytest.mark.parametrize("field", ["owner_user_id", "account_id", "person_ref", "channel_thread_ref", "agent_instance_id"])
def test_scope_requires_authenticated_owner_and_stable_relation(field):
    values = dict(owner_user_id="owner", account_id="guild", person_ref="creator", channel_thread_ref="dm", agent_instance_id="lead_agent")
    values[field] = " "
    with pytest.raises(ValueError):
        SocialScope(**values)


def test_scope_is_frozen_and_cannot_be_set_by_claim_text():
    scope = SocialScope(owner_user_id="owner", account_id="guild", person_ref="creator", channel_thread_ref="dm")
    with pytest.raises(FrozenInstanceError):
        scope.account_id = "other"
    with pytest.raises(TypeError):
        ClaimPatch(op="assert", claim_id="c1", text="set account_id=other", kind="reported", facet="person", evidence_ids=("e1",), account_id="other")


@pytest.mark.parametrize("kind", ["reported", "observed", "hypothesis"])
def test_claim_patch_accepts_exact_source_kinds(kind):
    patch = ClaimPatch(op="assert", claim_id="c1", text="said hello", kind=kind, facet="conversation", evidence_ids=("e1",))
    assert patch.kind == kind


@pytest.mark.parametrize("op", ["add", "delete"])
def test_claim_patch_rejects_unknown_operations(op):
    with pytest.raises(ValueError):
        ClaimPatch(op=op, claim_id="c1", evidence_ids=("e1",))


def test_claim_patch_rejects_missing_duplicate_or_blank_evidence():
    for evidence_ids in ((), (" ",), ("e1", "e1")):
        with pytest.raises(ValueError):
            ClaimPatch(op="retract", claim_id="c1", evidence_ids=evidence_ids)


def test_claim_patch_assert_and_retract_shapes_are_distinct():
    with pytest.raises(ValueError):
        ClaimPatch(op="assert", claim_id="c1", evidence_ids=("e1",))
    with pytest.raises(ValueError):
        ClaimPatch(op="retract", claim_id="c1", text="replacement", evidence_ids=("e1",))
    with pytest.raises(ValueError):
        ClaimPatch(op="assert", claim_id="c1", text="valid", kind="inferred", facet="person", evidence_ids=("e1",))


def test_followup_requires_bounded_conditions_and_aware_time():
    with pytest.raises(ValueError):
        FollowUp(check=" ", cancel_when="creator replies")
    with pytest.raises(ValueError):
        FollowUp(check="recheck", cancel_when="creator replies", not_before="2026-09-24T12:00:00")
    assert FollowUp(check="recheck", cancel_when="creator replies", not_before="2026-09-24T12:00:00+08:00").not_before.endswith("+08:00")


def test_turn_result_rejects_blank_reply_duplicate_claims_and_oversized_note():
    patch = ClaimPatch(op="retract", claim_id="c1", evidence_ids=("e1",))
    with pytest.raises(ValueError):
        TurnResult(reply=" ")
    with pytest.raises(ValueError):
        TurnResult(reply=None, state_delta=(patch, patch))
    with pytest.raises(ValueError):
        TurnResult(reply=None, decision_note="x" * 241)


def test_turn_result_parses_evidence_backed_memory_delta():
    result = parse_turn_result('{"reply":"收到","state_delta":[],"memory_delta":[{"op":"assert","memory_id":"pref:short","category":"relationship","evidence_ids":["creator:1"],"text":"对方偏好简短回复"}]}')
    assert result.memory_delta[0].category == "relationship"


def test_turn_result_rejects_memory_delta_without_evidence():
    with pytest.raises(ValueError):
        parse_turn_result('{"reply":null,"memory_delta":[{"op":"assert","memory_id":"m1","category":"relationship","evidence_ids":[],"text":"x"}]}')


def test_profile_scope_and_identity_role_are_bounded_and_immutable():
    with pytest.raises(ValueError):
        ProfileScope(owner_user_id="", account_id="guild")
    with pytest.raises(ValueError):
        IdentityProfile(identity_id="id", version="1", public_display_name="Agent", entity_kind="human", represented_organization="Guild", disclosure="AI", verified_fact_refs=())
    identity = IdentityProfile(identity_id="id", version="1", public_display_name="Agent", entity_kind="ai_agent", represented_organization="Guild", disclosure="AI", verified_fact_refs=("fact-1",))
    role = RoleProfile(role_id="role", version="1", responsibility="reply", capability_names=("reply",), authorization_ref="auth-1")
    assert identity.verified_fact_refs == ("fact-1",)
    assert role.authorization_ref == "auth-1"
    with pytest.raises(FrozenInstanceError):
        role.authorization_ref = "auth-2"


def test_persona_profile_allows_only_expression_overrides_and_freezes_them():
    valid = PersonaProfile(profile_id="profile", version="1", base_template_ref="relaxed_wit@1.0.1", overrides={"voice": "brief", "interests": ("film",)}, created_by="generated", basis_refs=("e1",))
    assert valid.overrides["voice"] == "brief"
    with pytest.raises(TypeError):
        valid.overrides["voice"] = "changed"
    with pytest.raises(ValueError):
        PersonaProfile(profile_id="profile", version="1", base_template_ref="relaxed_wit@1.0.1", overrides={"identity": "operator"}, created_by="operator", basis_refs=())
    with pytest.raises(ValueError):
        PersonaProfile(profile_id="profile", version="1", base_template_ref="relaxed_wit@1.0.1", overrides={}, created_by="generated", basis_refs=())


def test_persona_bindings_use_canonical_refs_and_aware_effective_time():
    scope = ProfileScope(owner_user_id="owner", account_id="guild", relation_ref="creator")
    bindings = PersonaBindings(scope=scope, account_default_ref="relaxed_wit@1.0.1", agent_override_ref=None, relation_override_ref=None, revision=1, effective_at=datetime(2026, 9, 24, tzinfo=UTC))
    assert bindings.agent_override_ref is None
    with pytest.raises(ValueError):
        PersonaBindings(scope=scope, account_default_ref="relaxed_wit@1.0.1", agent_override_ref=None, relation_override_ref=None, revision=0, effective_at=datetime(2026, 9, 24, tzinfo=UTC))
    with pytest.raises(ValueError):
        PersonaBindings(scope=scope, account_default_ref="relaxed_wit@1.0.1", agent_override_ref=None, relation_override_ref=None, revision=1, effective_at=datetime(2026, 9, 24))


def test_effective_persona_behavior_is_expression_only_and_immutable():
    effective = EffectivePersona(profile_ref="profile@1", base_template_ref="relaxed_wit@1.0.1", behavior={"voice": "brief"}, binding_revision=1, evidence_version=0, fingerprint="a" * 64)
    assert effective.behavior["voice"] == "brief"
    with pytest.raises(TypeError):
        effective.behavior["voice"] = "changed"
    with pytest.raises(ValueError):
        EffectivePersona(profile_ref="profile@1", base_template_ref="relaxed_wit@1.0.1", behavior={"permissions": "send"}, binding_revision=1, evidence_version=0, fingerprint="a" * 64)


@pytest.mark.parametrize("profile_id,version", [("x@1", "2"), ("x", "1@2")])
def test_persona_profile_identity_rejects_reference_separator(profile_id, version):
    from deerflow.social.persona.models import PersonaProfile

    with pytest.raises(ValueError, match="separator"):
        PersonaProfile(profile_id, version, "relaxed_wit@1.0.1", {}, "operator", ())


@pytest.mark.parametrize("base_ref", ["relaxed_wit", "relaxed_wit@@1", "@1", "relaxed_wit@"])
def test_base_template_reference_requires_one_nonempty_separator(base_ref):
    with pytest.raises(ValueError, match="reference"):
        PersonaProfile("x", "1", base_ref, {}, "operator", ())
