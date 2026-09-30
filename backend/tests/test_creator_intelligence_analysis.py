from datetime import UTC, datetime, timedelta

import pytest

from deerflow.social.contracts import SocialScope
from deerflow.social.intelligence import (
    ConversationStage,
    CreatorEvidence,
    analyze_creator_snapshot,
    build_snapshot,
    evaluate_conversation,
)

SCOPE = SocialScope("owner", "account", "creator", "thread")
NOW = datetime(2026, 10, 1, 12, tzinfo=UTC)


def _snapshot():
    records = (
        CreatorEvidence(SCOPE, "profile", "homepage", "profile:creator", NOW, None, 0.9, "identity", "Mia, beauty creator", (("display_name", "Mia"),)),
        CreatorEvidence(SCOPE, "work-1", "tikhub", "video:1", NOW, NOW + timedelta(days=7), 0.8, "content", "Live makeup tutorial with chat Q&A", (("format", "tutorial"),)),
        CreatorEvidence(SCOPE, "goal", "tkdesk", "note:goal", NOW, None, 0.7, "goal", "wants steadier live income"),
        CreatorEvidence(
            SCOPE,
            "constraint",
            "creator_message",
            "message:1",
            NOW,
            None,
            0.8,
            "constraint",
            "does not want pressure",
        ),
    )
    return build_snapshot(SCOPE, records, revision=4)


def test_creator_analysis_is_source_backed_and_exposes_hooks_and_risks():
    analysis = analyze_creator_snapshot(_snapshot())

    assert analysis.summary == "Mia, beauty creator"
    assert analysis.hooks[0].startswith("Live makeup tutorial")
    assert analysis.evidence_ids == ("profile", "work-1", "goal", "constraint")
    assert analysis.source_refs == ("profile:creator", "video:1", "note:goal", "message:1")
    assert "constraint:does not want pressure" in analysis.risks
    assert "goal_unverified" not in analysis.risks
    payload = analysis.to_payload()
    assert set(payload) == {"summary", "hooks", "risks", "open_questions", "evidence_ids", "source_refs", "confidence", "freshness", "snapshot_revision"}


def test_creator_analysis_marks_missing_goal_and_low_confidence():
    snapshot = build_snapshot(
        SCOPE,
        (CreatorEvidence(SCOPE, "work", "crawler", "video:1", NOW, None, 0.3, "content", "A live stream"),),
        revision=1,
    )
    analysis = analyze_creator_snapshot(snapshot)
    assert "goal_unverified" in analysis.risks
    assert "low_confidence_source" in analysis.risks
    assert analysis.open_questions


def test_conversation_evaluation_reports_stage_persona_evidence_latency_and_contract_failures():
    snapshot = _snapshot()
    first = __import__("deerflow.social.intelligence", fromlist=["plan_conversation"]).plan_conversation(snapshot, stage=ConversationStage.first_contact)
    second = __import__("deerflow.social.intelligence", fromlist=["plan_conversation"]).plan_conversation(snapshot, stage=ConversationStage.discovery)
    report = evaluate_conversation(
        "fixture-creator",
        (
            {"plan": first, "persona_fingerprint": "a" * 64, "persona_consistency_key": "persona-a", "latency_ms": 120.0, "contract_error": None},
            {"plan": second, "persona_fingerprint": "b" * 64, "persona_consistency_key": "persona-a", "latency_ms": 180.0, "contract_error": "plain_text"},
        ),
        required_evidence_ids=snapshot.evidence_refs,
    )
    assert report.stage_progression == ("first_contact", "discovery")
    assert report.persona_consistent is True
    assert report.evidence_coverage == 1.0
    assert report.contract_failures == ("plain_text",)
    assert report.latency_p50_ms == 120.0
    assert report.latency_p95_ms == 180.0
    assert report.passed is False


def test_conversation_evaluation_rejects_foreign_opening_evidence():
    snapshot = _snapshot()
    plan = __import__("deerflow.social.intelligence", fromlist=["plan_conversation"]).plan_conversation(snapshot, stage=ConversationStage.first_contact)
    with pytest.raises(ValueError, match="evidence"):
        evaluate_conversation(
            "fixture-creator",
            ({"plan": plan, "persona_fingerprint": "b" * 64, "persona_consistency_key": "persona-b", "latency_ms": 10.0, "contract_error": None},),
            required_evidence_ids=("missing",),
        )


def test_conversation_evaluation_allows_multiple_turns_in_one_stage():
    snapshot = _snapshot()
    plan = __import__("deerflow.social.intelligence", fromlist=["plan_conversation"]).plan_conversation(snapshot, stage=ConversationStage.rapport)
    report = evaluate_conversation(
        "fixture-creator",
        (
            {"plan": plan, "persona_fingerprint": "c" * 64, "persona_consistency_key": "persona-c", "latency_ms": 50.0, "contract_error": None},
            {"plan": plan, "persona_fingerprint": "d" * 64, "persona_consistency_key": "persona-c", "latency_ms": 60.0, "contract_error": None},
        ),
        required_evidence_ids=snapshot.evidence_refs,
    )
    assert report.passed is True
    assert report.stage_progression == ("rapport", "rapport")
