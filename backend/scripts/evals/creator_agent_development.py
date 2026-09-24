"""Load the approved offline CreatorAgent development inputs and evidence.

Generation inputs and grader/scenario evidence are deliberately separate APIs.
Nothing in this module evaluates naturalness or model quality.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass(frozen=True, slots=True)
class DevelopmentCase:
    case_id: str
    synthetic: bool
    generation_context: dict[str, Any]
    source_input: dict[str, Any]


def _read_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip():
            raise ValueError(f"blank JSONL row: {path}:{line_number}")
        value = json.loads(line)
        if not isinstance(value, dict):
            raise ValueError(f"JSONL row must be an object: {path}:{line_number}")
        rows.append(value)
    return rows


def _require_count(rows: list[dict[str, Any]], expected: int, label: str) -> None:
    if len(rows) != expected:
        raise ValueError(f"{label} must contain exactly {expected} rows")
    ids = [row.get("id") for row in rows]
    if any(not isinstance(case_id, str) or not case_id for case_id in ids) or len(set(ids)) != len(ids):
        raise ValueError(f"{label} must contain unique nonempty ids")


def _case_input_cases(path: Path, expected: int, label: str) -> tuple[DevelopmentCase, ...]:
    rows = _read_jsonl(path)
    _require_count(rows, expected, label)
    cases: list[DevelopmentCase] = []
    for row in rows:
        if set(row) != {"id", "case_input"} or not isinstance(row["case_input"], dict):
            raise ValueError(f"{label} rows must contain only id and case_input")
        case_input = row["case_input"]
        if case_input.get("synthetic_fixture") is not True:
            raise ValueError(f"{label} rows must be explicit synthetic fixtures")
        cases.append(
            DevelopmentCase(
                case_id=row["id"],
                synthetic=True,
                generation_context=dict(case_input),
                source_input=row,
            )
        )
    return tuple(cases)


def _legacy_cases(path: Path, expected: int, label: str) -> tuple[DevelopmentCase, ...]:
    rows = _read_jsonl(path)
    _require_count(rows, expected, label)
    required = {"id", "family_id", "synthetic", "split", "known_context", "messages"}
    allowed = required | {"family_label", "notes"}
    cases: list[DevelopmentCase] = []
    for row in rows:
        if not required <= set(row) <= allowed or row["synthetic"] is not True:
            raise ValueError(f"{label} row has invalid input fields")
        if not isinstance(row["known_context"], str) or not isinstance(row["messages"], list):
            raise ValueError(f"{label} row has invalid generation context")
        if any(not isinstance(message, dict) or set(message) != {"id", "role", "text"} for message in row["messages"]):
            raise ValueError(f"{label} row has invalid messages")
        cases.append(
            DevelopmentCase(
                case_id=row["id"],
                synthetic=True,
                generation_context={"known_context": row["known_context"], "messages": row["messages"]},
                source_input=row,
            )
        )
    return tuple(cases)


def load_generation_cases(evals_root: Path) -> dict[str, tuple[DevelopmentCase, ...]]:
    """Load model-facing inputs only; no grader or scenario file is read."""

    root = Path(evals_root)
    social = _case_input_cases(root / "inputs.development.jsonl", 72, "social inputs")
    profiles = _case_input_cases(root / "persona_profiles.inputs.development.jsonl", 12, "persona profile inputs")
    legacy = _legacy_cases(root / "legacy_business" / "inputs.development.jsonl", 36, "legacy business inputs")
    jevchat = _legacy_cases(root / "legacy_business" / "jevchat.inputs.development.jsonl", 24, "legacy JevChat inputs")
    return {
        "social": social,
        "persona_profiles": profiles,
        "legacy_business": legacy + jevchat,
    }


def load_development_evidence(evals_root: Path) -> dict[str, tuple[dict[str, Any], ...]]:
    """Load grader/scenario evidence for a separate evaluator process."""

    root = Path(evals_root)
    social = _read_jsonl(root / "graders.development.jsonl")
    profiles = _read_jsonl(root / "persona_profiles.graders.development.jsonl")
    legacy = _read_jsonl(root / "legacy_business" / "scenarios.development.jsonl")
    jevchat = _read_jsonl(root / "legacy_business" / "jevchat.scenarios.development.jsonl")
    _require_count(social, 72, "social grader evidence")
    _require_count(profiles, 12, "persona profile grader evidence")
    _require_count(legacy, 36, "legacy business scenario evidence")
    _require_count(jevchat, 24, "legacy JevChat scenario evidence")

    cases = load_generation_cases(root)
    evidence = {
        "social": tuple(social),
        "persona_profiles": tuple(profiles),
        "legacy_business": tuple(legacy + jevchat),
    }
    for name, rows in evidence.items():
        if [case.case_id for case in cases[name]] != [row["id"] for row in rows]:
            raise ValueError(f"{name} generation inputs and evidence ids differ")
    return evidence
