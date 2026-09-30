from datetime import UTC, datetime, timedelta

import pytest

from deerflow.social.contracts import SocialScope
from deerflow.social.intelligence import (
    ConversationStage,
    CreatorEvidence,
    CreatorEvidenceProvider,
    CreatorIntelligenceSnapshot,
    build_snapshot,
    plan_conversation,
)

UTC = UTC
SCOPE = SocialScope("owner", "account", "creator", "thread")
NOW = datetime(2026, 10, 1, 12, tzinfo=UTC)
WORK = CreatorEvidence(SCOPE, "work-1", "tikhub", "video:1", NOW, NOW + timedelta(days=7), 0.9, "content", "A live makeup tutorial", (("format", "tutorial"),))
PROFILE = CreatorEvidence(SCOPE, "profile-1", "homepage", "profile:1", NOW, None, 0.8, "identity", "Creator profile", (("display_name", "Mia"),))


def test_valid_tikhub_work_and_page_records_are_bounded():
    assert WORK.source_kind == "tikhub"
    assert PROFILE.source_kind == "homepage"
    assert PROFILE.facts == (("display_name", "Mia"),)


def test_evidence_rejects_invalid_scope_source_time_confidence_and_kind():
    with pytest.raises(ValueError):
        CreatorEvidence("scope", "id", "tikhub", "ref", NOW, None, 0.5, "content", "text")
    with pytest.raises(ValueError):
        CreatorEvidence(SCOPE, "id", "tikhub", "", NOW, None, 0.5, "content", "text")
    with pytest.raises(ValueError):
        CreatorEvidence(SCOPE, "id", "tikhub", "ref", datetime(2026, 10, 1, 12), None, 0.5, "content", "text")
    with pytest.raises(ValueError):
        CreatorEvidence(SCOPE, "id", "tikhub", "ref", NOW, None, 1.1, "content", "text")
    with pytest.raises(ValueError):
        CreatorEvidence(SCOPE, "id", "tikhub", "ref", NOW, None, 0.5, "unknown", "text")


def test_build_snapshot_drops_expired_and_rejects_cross_scope_or_duplicate_ids():
    expired = CreatorEvidence(SCOPE, "old", "crawler", "old", NOW - timedelta(days=3), NOW - timedelta(days=1), 0.7, "content", "old")
    snapshot = build_snapshot(SCOPE, (expired, WORK, PROFILE), revision=3)
    assert snapshot.evidence_refs == ("work-1", "profile-1")
    assert all(e.evidence_id != "old" for e in snapshot.works)
    other = SocialScope("owner", "account", "other", "thread")
    foreign = CreatorEvidence(other, "foreign", "homepage", "foreign", NOW, None, 0.5, "identity", "foreign")
    with pytest.raises(ValueError):
        build_snapshot(SCOPE, (WORK, foreign), revision=1)
    with pytest.raises(ValueError):
        build_snapshot(SCOPE, (WORK, WORK), revision=1)


def test_snapshot_evidence_reference_coverage_and_immutability():
    snapshot = build_snapshot(SCOPE, (WORK, PROFILE), revision=3)
    assert isinstance(snapshot, CreatorIntelligenceSnapshot)
    with pytest.raises(Exception):
        snapshot.evidence_refs += ("x",)
    with pytest.raises(ValueError):
        CreatorIntelligenceSnapshot(SCOPE, 1, (PROFILE,), (), (), (), ("missing",), "fresh")


def test_plan_uses_current_work_and_stops_before_invite_without_consent():
    snapshot = build_snapshot(SCOPE, (WORK, PROFILE), revision=3)
    plan = plan_conversation(snapshot, stage=ConversationStage.discovery, goal="了解是否愿意听公会方案")
    assert plan.opening_candidates[0]["evidence_ids"] == (WORK.evidence_id,)
    assert plan.consent_checkpoint == "before_formal_invitation"
    assert "creator says stop" in plan.stop_conditions
    assert plan.estimate["p50_turns"] >= 1
    assert all("invite" not in turn["objective"].lower() for turn in plan.turns)


def test_plan_stage_transitions_and_explicit_consent_gate():
    snapshot = build_snapshot(SCOPE, (WORK, PROFILE), revision=4)
    plan = plan_conversation(snapshot, stage=ConversationStage.permission_to_invite)
    assert plan.stage is ConversationStage.permission_to_invite
    assert plan.turns[0]["next_if_yes"] == "formal_invite"
    assert plan.turns[0]["next_if_no"] == "paused"
    with pytest.raises(ValueError, match="consent"):
        plan_conversation(snapshot, stage=ConversationStage.formal_invite)
    formal = plan_conversation(snapshot, stage=ConversationStage.formal_invite, consent_evidence_ids=("creator:consent",))
    assert formal.turns[0]["objective"]
    assert formal.consent_evidence_ids == ("creator:consent",)
    restored = type(formal).from_payload(formal.to_payload())
    assert restored == formal


def test_persisted_formal_plan_without_consent_fails_closed():
    with pytest.raises(ValueError, match="consent"):
        from deerflow.social.intelligence.planner import ConversationPlan

        ConversationPlan(
            "p",
            1,
            ConversationStage.formal_invite,
            (),
            (),
            ({"objective": "send terms", "allowed_evidence_ids": (), "success_signal": "reply", "next_if_yes": "application", "next_if_no": "paused"},),
            "before_formal_invitation",
            ("stop",),
            {"p50_turns": 1, "p80_turns": 2, "confidence": 0.5, "basis": ("x",)},
        )


def test_provider_protocol_is_runtime_checkable_by_shape():
    assert hasattr(CreatorEvidenceProvider, "collect")


def test_plan_nested_payloads_are_immutable():
    plan = plan_conversation(build_snapshot(SCOPE, (WORK, PROFILE), revision=3), stage=ConversationStage.discovery)
    with pytest.raises(TypeError):
        plan.opening_candidates[0]["text"] = "changed"
    with pytest.raises(TypeError):
        plan.turns[0]["objective"] = "changed"
    with pytest.raises(TypeError):
        plan.estimate["p50_turns"] = 99


def test_plan_validates_candidate_estimate_and_goal_bounds():
    snapshot = build_snapshot(SCOPE, (WORK, PROFILE), revision=3)
    with pytest.raises(ValueError):
        plan_conversation(snapshot, stage=ConversationStage.discovery, goal=" ")
    with pytest.raises(ValueError):
        plan_conversation(snapshot, stage=ConversationStage.discovery, goal="x" * 513)
    with pytest.raises(ValueError):
        from deerflow.social.intelligence.planner import ConversationPlan

        ConversationPlan(
            "p",
            1,
            ConversationStage.discovery,
            ({"text": "x", "evidence_ids": ()},),
            (),
            ({"objective": "x", "allowed_evidence_ids": (), "success_signal": "x", "next_if_yes": "x", "next_if_no": "x"},),
            "before_formal_invitation",
            ("stop",),
            {"p50_turns": 1, "p80_turns": 2, "confidence": 0.5, "basis": ()},
        )
