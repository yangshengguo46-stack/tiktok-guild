"""Reference contracts only: no LLM, network, channel, or DeerFlow integration.

Evidence IDs validate provenance membership, not whether a claim is semantically true.
Production must enforce tenancy, persist transactions, and reconcile send receipts.
"""
from __future__ import annotations

from copy import deepcopy
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class ClaimPatch(StrictModel):
    op: Literal["assert", "retract"]
    claim_id: str = Field(min_length=1)
    text: str | None = None
    kind: Literal["reported", "observed", "hypothesis"] | None = None
    facet: Literal["person", "tradeoff", "relationship", "conversation", "shared_topic", "next_step"] | None = None
    evidence_ids: list[str] = Field(min_length=1)

    @model_validator(mode="after")
    def check_shape(self) -> ClaimPatch:
        if not self.claim_id.strip() or any(not item.strip() for item in self.evidence_ids):
            raise ValueError("IDs must be nonblank")
        if len(set(self.evidence_ids)) != len(self.evidence_ids):
            raise ValueError("duplicate evidence IDs")
        if self.op == "assert":
            if not self.text or not self.text.strip() or self.kind is None or self.facet is None:
                raise ValueError("assert requires text, kind and facet")
        elif self.text is not None or self.kind is not None or self.facet is not None:
            raise ValueError("retract refers to an existing claim; do not replace it inline")
        return self


class FollowUp(StrictModel):
    check: str = Field(min_length=1)
    # ISO-8601 string intentionally: consistent model-facing JSON contract.
    not_before: str | None = None
    cancel_when: str = Field(min_length=1)

    @model_validator(mode="after")
    def check_time(self) -> FollowUp:
        if not self.check.strip() or not self.cancel_when.strip():
            raise ValueError("follow-up conditions must be nonblank")
        if self.not_before is not None:
            parsed = datetime.fromisoformat(self.not_before.replace("Z", "+00:00"))
            if parsed.tzinfo is None:
                raise ValueError("not_before requires an explicit timezone")
        return self


class TurnResult(StrictModel):
    reply: str | None
    state_delta: list[ClaimPatch] = Field(default_factory=list)
    decision_note: str = Field(default="", max_length=240)
    followup: FollowUp | None = None

    @model_validator(mode="after")
    def check_reply_and_ids(self) -> TurnResult:
        if self.reply is not None and not self.reply.strip():
            raise ValueError("use null, not an empty reply, for no outbound message")
        ids = [patch.claim_id for patch in self.state_delta]
        if len(ids) != len(set(ids)):
            raise ValueError("at most one operation per claim ID per turn")
        return self


def apply_delta(
    snapshot: dict,
    turn: TurnResult,
    *,
    expected_version: int,
    evidence_kinds: dict[str, str],
) -> dict:
    """Apply atomically to a copy, with scoped provenance and version checks.

    evidence_kinds MUST be supplied by the host for this relation only.
    A production repository must additionally use an atomic database CAS/transaction;
    this pure function does not provide cross-process synchronization.
    """
    if snapshot.get("version") != expected_version:
        raise ValueError("stale snapshot")
    result = deepcopy(snapshot)
    claims = result.setdefault("claims", {})
    for patch in turn.state_delta:
        if any(eid not in evidence_kinds for eid in patch.evidence_ids):
            raise ValueError("missing or out-of-scope evidence")
        if patch.op == "assert":
            if patch.claim_id in claims:
                raise ValueError("claim ID already exists; retract and create a new ID")
            if patch.kind == "observed" and not any(
                evidence_kinds[eid] in {"tool_observation", "verified_receipt"}
                for eid in patch.evidence_ids
            ):
                raise ValueError("observed claims require a tool/receipt source")
            claims[patch.claim_id] = {
                "text": patch.text,
                "kind": patch.kind,
                "facet": patch.facet,
                "evidence_ids": list(patch.evidence_ids),
                "status": "active",
            }
        else:
            if patch.claim_id not in claims or claims[patch.claim_id].get("status") != "active":
                raise ValueError("cannot retract absent or inactive claim")
            claims[patch.claim_id]["status"] = "retracted"
            claims[patch.claim_id]["retraction_evidence_ids"] = list(patch.evidence_ids)
    if turn.state_delta:
        result["version"] += 1
    return result


def project_outbound(turn: TurnResult) -> str | None:
    """Only this field is eligible for delivery; the host binds the destination."""
    return turn.reply


def check_send_context(
    *, planned_version: int, current_version: int,
    planned_event: str, current_event: str, human_takeover: bool,
) -> None:
    """Pre-send reference check; not a distributed send implementation."""
    if human_takeover:
        raise ValueError("human takeover")
    if planned_version != current_version or planned_event != current_event:
        raise ValueError("new context invalidates the prepared send")
