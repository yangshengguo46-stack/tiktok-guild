"""Scoped, source-backed creator intelligence contracts."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Protocol

from deerflow.social.contracts import SocialScope, bounded_refs, bounded_text

_SOURCE_KINDS = {"tikhub", "crawler", "homepage", "tkdesk", "creator_message", "operator_note"}
_EVIDENCE_KINDS = {"identity", "content", "audience", "goal", "interaction", "constraint"}


def _utc(value: datetime, name: str) -> None:
    if not isinstance(value, datetime) or value.tzinfo is None or value.utcoffset() is None:
        raise ValueError(f"{name} must be timezone-aware UTC")
    if value.utcoffset() != UTC.utcoffset(value):
        raise ValueError(f"{name} must be UTC")


@dataclass(frozen=True)
class CreatorEvidence:
    scope: SocialScope
    evidence_id: str
    source_kind: str
    source_ref: str
    captured_at: datetime
    expires_at: datetime | None
    confidence: float
    kind: str
    text: str
    facts: tuple[tuple[str, str], ...] = ()

    def __post_init__(self) -> None:
        if not isinstance(self.scope, SocialScope):
            raise ValueError("scope must be a SocialScope")
        bounded_text(self.evidence_id, "evidence_id", 256)
        if self.source_kind not in _SOURCE_KINDS:
            raise ValueError("source_kind is not allowed")
        bounded_text(self.source_ref, "source_ref", 512)
        _utc(self.captured_at, "captured_at")
        if self.expires_at is not None:
            _utc(self.expires_at, "expires_at")
            if self.expires_at < self.captured_at:
                raise ValueError("expires_at cannot precede captured_at")
        if not isinstance(self.confidence, (int, float)) or isinstance(self.confidence, bool) or not 0 <= self.confidence <= 1:
            raise ValueError("confidence must be between 0 and 1")
        if self.kind not in _EVIDENCE_KINDS:
            raise ValueError("kind is not allowed")
        bounded_text(self.text, "text", 2048)
        if not isinstance(self.facts, tuple) or len(self.facts) > 16:
            raise ValueError("facts must contain at most 16 entries")
        for fact in self.facts:
            if not isinstance(fact, tuple) or len(fact) != 2:
                raise ValueError("facts must contain key/value pairs")
            bounded_text(fact[0], "fact key", 128)
            bounded_text(fact[1], "fact value", 512)

    def is_expired(self, at: datetime | None = None) -> bool:
        if self.expires_at is None:
            return False
        at = at or datetime.now(UTC)
        _utc(at, "at")
        return self.expires_at <= at

    def source_metadata(self, at: datetime | None = None) -> dict:
        """Return only bounded provenance metadata safe for Lead context."""
        at = at or datetime.now(UTC)
        _utc(at, "at")
        freshness = "expired" if self.is_expired(at) else "fresh"
        return {
            "evidence_id": self.evidence_id,
            "source_ref": self.source_ref,
            "source_kind": self.source_kind,
            "captured_at": self.captured_at.isoformat(),
            "expires_at": self.expires_at.isoformat() if self.expires_at is not None else None,
            "confidence": self.confidence,
            "freshness": freshness,
        }


class CreatorEvidenceProvider(Protocol):
    async def collect(self, scope: SocialScope, *, creator_ref: str) -> tuple[CreatorEvidence, ...]: ...


def _validate_evidence_set(scope: SocialScope, evidence: tuple[CreatorEvidence, ...], *, now: datetime) -> tuple[CreatorEvidence, ...]:
    if not isinstance(scope, SocialScope) or not isinstance(evidence, tuple):
        raise ValueError("scope and evidence are required")
    seen: set[str] = set()
    current: list[CreatorEvidence] = []
    for item in evidence:
        if not isinstance(item, CreatorEvidence):
            raise ValueError("evidence must contain CreatorEvidence records")
        if item.scope != scope:
            raise ValueError("evidence scope does not match snapshot scope")
        if item.evidence_id in seen:
            raise ValueError("duplicate evidence_id")
        seen.add(item.evidence_id)
        if not item.is_expired(now):
            current.append(item)
    return tuple(current)


@dataclass(frozen=True)
class CreatorIntelligenceSnapshot:
    scope: SocialScope
    revision: int
    identity: tuple[CreatorEvidence, ...]
    works: tuple[CreatorEvidence, ...]
    signals: tuple[CreatorEvidence, ...]
    open_questions: tuple[str, ...]
    evidence_refs: tuple[str, ...]
    freshness: str

    def __post_init__(self) -> None:
        if not isinstance(self.scope, SocialScope) or not isinstance(self.revision, int) or self.revision < 0:
            raise ValueError("invalid snapshot scope or revision")
        groups = self.identity + self.works + self.signals
        if any(not isinstance(item, CreatorEvidence) or item.scope != self.scope or item.is_expired() for item in groups):
            raise ValueError("snapshot contains invalid or expired evidence")
        ids = tuple(item.evidence_id for item in groups)
        if len(ids) != len(set(ids)):
            raise ValueError("snapshot contains duplicate evidence")
        bounded_refs(self.evidence_refs, "evidence_refs", maximum=64)
        if set(self.evidence_refs) != set(ids):
            raise ValueError("evidence_refs must cover snapshot evidence exactly")
        if not isinstance(self.open_questions, tuple) or len(self.open_questions) > 16:
            raise ValueError("open_questions must contain at most 16 questions")
        for question in self.open_questions:
            bounded_text(question, "open question", 512)
        bounded_text(self.freshness, "freshness", 32)


def build_snapshot(scope: SocialScope, evidence: tuple[CreatorEvidence, ...], revision: int) -> CreatorIntelligenceSnapshot:
    current = _validate_evidence_set(scope, evidence, now=datetime.now(UTC))
    identity = tuple(item for item in current if item.kind == "identity")
    works = tuple(item for item in current if item.kind == "content")
    signals = tuple(item for item in current if item.kind not in {"identity", "content"})
    refs = tuple(item.evidence_id for item in current)
    questions = () if any(item.kind == "goal" for item in signals) else ("What would you like to improve or achieve right now?",)
    freshness = "fresh" if current else "empty"
    return CreatorIntelligenceSnapshot(scope, revision, identity, works, signals, questions, refs, freshness)
