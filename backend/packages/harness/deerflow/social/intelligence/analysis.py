"""Bounded, source-backed creator profile analysis for the native social runtime."""

from __future__ import annotations

from dataclasses import dataclass

from deerflow.social.contracts import SocialScope, bounded_refs, bounded_text

from .evidence import CreatorIntelligenceSnapshot


def _unique(values: tuple[str, ...]) -> tuple[str, ...]:
    return tuple(dict.fromkeys(values))


@dataclass(frozen=True)
class CreatorProfileAnalysis:
    """A compact, provenance-preserving view of a creator snapshot.

    This is a derived read model.  It cannot authorize a message or replace
    the evidence records from which it was built.
    """

    scope: SocialScope
    snapshot_revision: int
    summary: str
    hooks: tuple[str, ...]
    risks: tuple[str, ...]
    open_questions: tuple[str, ...]
    evidence_ids: tuple[str, ...]
    source_refs: tuple[str, ...]
    confidence: float
    freshness: str

    def __post_init__(self) -> None:
        if not isinstance(self.scope, SocialScope) or type(self.snapshot_revision) is not int or self.snapshot_revision < 0:
            raise ValueError("analysis scope or revision is invalid")
        bounded_text(self.summary, "analysis summary", 512)
        for name, values, maximum in (("hooks", self.hooks, 8), ("risks", self.risks, 16), ("open_questions", self.open_questions, 16)):
            if not isinstance(values, tuple) or len(values) > maximum:
                raise ValueError(f"{name} must be a bounded tuple")
            for value in values:
                bounded_text(value, name, 512)
        bounded_refs(self.evidence_ids, "analysis evidence_ids", maximum=64)
        bounded_refs(self.source_refs, "analysis source_refs", maximum=64)
        if not isinstance(self.confidence, (int, float)) or isinstance(self.confidence, bool) or not 0 <= self.confidence <= 1:
            raise ValueError("analysis confidence must be between 0 and 1")
        bounded_text(self.freshness, "analysis freshness", 32)

    def to_payload(self) -> dict:
        return {
            "summary": self.summary,
            "hooks": list(self.hooks),
            "risks": list(self.risks),
            "open_questions": list(self.open_questions),
            "evidence_ids": list(self.evidence_ids),
            "source_refs": list(self.source_refs),
            "confidence": self.confidence,
            "freshness": self.freshness,
            "snapshot_revision": self.snapshot_revision,
        }


def analyze_creator_snapshot(snapshot: CreatorIntelligenceSnapshot, *, max_works: int = 3) -> CreatorProfileAnalysis:
    """Derive bounded hooks, risks, and questions from current evidence."""

    if not isinstance(snapshot, CreatorIntelligenceSnapshot) or type(max_works) is not int or not 1 <= max_works <= 8:
        raise ValueError("snapshot and max_works are invalid")
    identity = snapshot.identity[0] if snapshot.identity else None
    summary = identity.text[:512] if identity else (snapshot.works[0].text[:512] if snapshot.works else "Creator profile requires discovery")
    hooks = tuple(item.text[:512] for item in snapshot.works[:max_works])
    risks: list[str] = []
    if not any(item.kind == "goal" for item in snapshot.signals):
        risks.append("goal_unverified")
    for item in snapshot.signals:
        if item.kind == "constraint":
            risks.append(f"constraint:{item.text[:480]}")
    if any(item.confidence < 0.6 for item in (*snapshot.identity, *snapshot.works, *snapshot.signals)):
        risks.append("low_confidence_source")
    if not snapshot.identity:
        risks.append("identity_unverified")
    if not snapshot.works:
        risks.append("no_current_work")
    risks = list(_unique(tuple(risks)))
    questions = list(snapshot.open_questions)
    if snapshot.works and not any(item.kind == "goal" for item in snapshot.signals):
        questions.append("Which result would make your next live session worthwhile?")
    records = (*snapshot.identity, *snapshot.works, *snapshot.signals)
    confidence = sum(item.confidence for item in records) / len(records) if records else 0.0
    return CreatorProfileAnalysis(
        scope=snapshot.scope,
        snapshot_revision=snapshot.revision,
        summary=summary,
        hooks=hooks,
        risks=tuple(risks),
        open_questions=_unique(tuple(questions)),
        evidence_ids=snapshot.evidence_refs,
        source_refs=_unique(tuple(item.source_ref for item in records)),
        confidence=round(confidence, 4),
        freshness=snapshot.freshness,
    )
