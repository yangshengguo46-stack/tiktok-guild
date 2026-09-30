"""Synthetic creator-intelligence evaluation cases; no provider access."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path

from deerflow.social.contracts import SocialScope
from deerflow.social.intelligence import ConversationStage, CreatorEvidence, build_snapshot, plan_conversation


def evaluate_fixture(path: Path) -> dict:
    raw = json.loads(path.read_text(encoding="utf-8"))
    scope = SocialScope("fixture-owner", "fixture-account", raw["creator_ref"], "fixture-thread")
    evidence = tuple(CreatorEvidence(scope, item["id"], "operator_note", item["source_id"], datetime.now(UTC), None, item["confidence"], item["kind"], item["text"]) for item in raw["evidence"])
    snapshot = build_snapshot(scope, evidence, revision=1)
    first = plan_conversation(snapshot, stage=ConversationStage.first_contact)
    second = plan_conversation(snapshot, stage=ConversationStage.discovery)
    return {
        "creator_ref": raw["creator_ref"],
        "intelligence_snapshot_revision": snapshot.revision,
        "plan_stage": second.stage.value,
        "estimate": dict(second.estimate),
        "memory_promotions": ["synthetic accepted memory"],
        "verified_funnel_stage": "discovery",
        "formal_invite_allowed": False,
        "first_opening": first.opening_candidates[0]["text"] if first.opening_candidates else None,
    }


def evaluate_fixtures(directory: Path) -> list[dict]:
    return [evaluate_fixture(path) for path in sorted(directory.glob("creator_*.json"))]
