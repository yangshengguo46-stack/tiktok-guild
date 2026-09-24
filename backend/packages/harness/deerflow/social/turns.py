"""Strict model-output parsing and host contact policy for native social turns."""

from __future__ import annotations

import json

from deerflow.social.contracts import ClaimPatch, FollowUp, TurnResult


def _unique(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate turn field")
        result[key] = value
    return result


def parse_turn_result(content: object) -> TurnResult:
    """Accept one bounded JSON object, never markdown, extensions or coercion."""
    if not isinstance(content, str) or len(content) > 65536:
        raise ValueError("turn must be bounded JSON text")
    raw = json.loads(content, object_pairs_hook=_unique, parse_constant=lambda value: (_ for _ in ()).throw(ValueError("nonfinite JSON")))
    if not isinstance(raw, dict) or "reply" not in raw or set(raw) - {"reply", "state_delta", "decision_note", "followup"}:
        raise ValueError("invalid turn fields")
    patches = raw.get("state_delta", [])
    if not isinstance(patches, list) or len(patches) > 16:
        raise ValueError("state_delta must be a bounded array")
    parsed = []
    for patch in patches:
        if not isinstance(patch, dict) or set(patch) - {"op", "claim_id", "evidence_ids", "text", "kind", "facet"} or not {"op", "claim_id", "evidence_ids"} <= set(patch) or not isinstance(patch["evidence_ids"], list):
            raise ValueError("invalid claim patch fields")
        parsed.append(ClaimPatch(**{**patch, "evidence_ids": tuple(patch["evidence_ids"])}))
    followup = raw.get("followup")
    if followup is not None:
        if not isinstance(followup, dict) or set(followup) - {"check", "cancel_when", "not_before"} or not {"check", "cancel_when"} <= set(followup):
            raise ValueError("invalid followup fields")
        followup = FollowUp(**followup)
    return TurnResult(raw["reply"], tuple(parsed), raw.get("decision_note", ""), followup)


def receipt_status(snapshot):
    """Project actual action history; an unsubmitted first turn has no receipt."""
    states = {item.state for item in snapshot.outbound}
    if "unknown" in states or states - {"pending", "accepted", "delivered", "failed"}:
        return "unknown"
    return "known" if states & {"accepted", "delivered", "failed"} else "none"


def contact_blocked(snapshot) -> bool:
    return snapshot.identity_verified is not True or snapshot.do_not_contact is not False or snapshot.human_takeover is not False or receipt_status(snapshot) == "unknown"


async def commit_turn(repository, snapshot, *, event_id: str, result: TurnResult):
    """No retry: the repository owns transaction, evidence, fingerprint and CAS."""
    return await repository.commit_turn(
        snapshot.scope,
        expected_revision=snapshot.revision,
        event_id=event_id,
        result=result,
        persona_fingerprint=snapshot.effective_persona.fingerprint,
        enforce_contact_boundaries=True,
    )
