"""Deterministic offline quality checks for creator conversation plans."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from math import ceil

from deerflow.social.contracts import bounded_refs, bounded_text

from .planner import ConversationPlan, ConversationStage

_STAGE_ORDER = {stage: index for index, stage in enumerate(ConversationStage)}


def _bounded_sequence(values: tuple[str, ...], name: str, maximum: int) -> None:
    if not isinstance(values, tuple) or not 1 <= len(values) <= maximum:
        raise ValueError(f"{name} must contain 1 to {maximum} entries")
    for value in values:
        bounded_text(value, name, 128)


def _percentile(values: tuple[float, ...], percentile: float) -> float:
    return values[max(0, ceil(len(values) * percentile) - 1)]


@dataclass(frozen=True)
class ConversationEvaluationReport:
    scenario_id: str
    passed: bool
    stage_progression: tuple[str, ...]
    persona_consistent: bool
    evidence_coverage: float
    contract_failures: tuple[str, ...]
    latency_p50_ms: float
    latency_p95_ms: float

    def __post_init__(self) -> None:
        bounded_text(self.scenario_id, "scenario_id", 128)
        _bounded_sequence(self.stage_progression, "stage_progression", 32)
        if type(self.persona_consistent) is not bool or not 0 <= self.evidence_coverage <= 1:
            raise ValueError("invalid evaluation summary")
        bounded_refs(self.contract_failures, "contract_failures", maximum=32)
        if any(type(value) not in {int, float} or value < 0 for value in (self.latency_p50_ms, self.latency_p95_ms)):
            raise ValueError("latency values must be nonnegative")

    def to_payload(self) -> dict:
        return {
            "scenario_id": self.scenario_id,
            "passed": self.passed,
            "stage_progression": list(self.stage_progression),
            "persona_consistent": self.persona_consistent,
            "evidence_coverage": self.evidence_coverage,
            "contract_failures": list(self.contract_failures),
            "latency_p50_ms": self.latency_p50_ms,
            "latency_p95_ms": self.latency_p95_ms,
        }


def evaluate_conversation(
    scenario_id: str,
    turns: tuple[Mapping[str, object], ...],
    *,
    required_evidence_ids: tuple[str, ...],
) -> ConversationEvaluationReport:
    """Evaluate a model scenario without calling a provider or changing state."""

    bounded_text(scenario_id, "scenario_id", 128)
    bounded_refs(required_evidence_ids, "required_evidence_ids", maximum=64)
    if not isinstance(turns, tuple) or not turns:
        raise ValueError("turns must contain at least one evaluation turn")
    stages: list[str] = []
    fingerprints: list[str] = []
    latencies: list[float] = []
    failures: list[str] = []
    allowed: set[str] = set()
    for turn in turns:
        if not isinstance(turn, Mapping) or set(turn) != {"plan", "persona_fingerprint", "latency_ms", "contract_error"}:
            raise ValueError("evaluation turn has invalid fields")
        plan = turn["plan"]
        if not isinstance(plan, ConversationPlan):
            raise ValueError("evaluation turn requires a ConversationPlan")
        fingerprint = turn["persona_fingerprint"]
        bounded_text(fingerprint, "persona_fingerprint", 128)
        latency = turn["latency_ms"]
        if type(latency) not in {int, float} or latency < 0:
            raise ValueError("latency_ms must be nonnegative")
        error = turn["contract_error"]
        if error is not None:
            bounded_text(error, "contract_error", 128)
            if error not in failures:
                failures.append(error)
        stages.append(plan.stage.value)
        fingerprints.append(fingerprint)
        latencies.append(float(latency))
        allowed.update(plan.turns[0]["allowed_evidence_ids"])
        allowed.update(evidence_id for opening in plan.opening_candidates for evidence_id in opening["evidence_ids"])
    missing = set(required_evidence_ids) - allowed
    if missing:
        raise ValueError(f"evaluation evidence is missing: {sorted(missing)}")
    progression = tuple(ConversationStage(stage) for stage in stages)
    monotonic = all(_STAGE_ORDER[current] >= _STAGE_ORDER[previous] for previous, current in zip(progression, progression[1:]))
    persona_consistent = len(set(fingerprints)) == 1
    coverage = 1.0 if not required_evidence_ids else len(set(required_evidence_ids) & allowed) / len(required_evidence_ids)
    ordered_latencies = tuple(sorted(latencies))
    passed = monotonic and persona_consistent and coverage == 1.0 and not failures
    return ConversationEvaluationReport(
        scenario_id=scenario_id,
        passed=passed,
        stage_progression=tuple(stage.value for stage in progression),
        persona_consistent=persona_consistent,
        evidence_coverage=coverage,
        contract_failures=tuple(failures),
        latency_p50_ms=_percentile(ordered_latencies, 0.5),
        latency_p95_ms=_percentile(ordered_latencies, 0.95),
    )
