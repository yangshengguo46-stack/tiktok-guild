"""Load approved offline CreatorAgent development inputs and evaluator evidence."""

from __future__ import annotations

import copy
import hashlib
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

_APPROVED_FILE_SHA256 = {
    "inputs.development.jsonl": "a5c4eaf8434c769afdd834b89606600a59f3c96b44b67093adcf86a72bd6d232",
    "graders.development.jsonl": "d568ec0a59460c9c24bef70b6469e25c2692fdfc615fb1b0aad086225085a30d",
    "scenarios.development.jsonl": "ca3463f83c630b68b4a89a3d08a1454ad44368ee3dc0883384efe2edc18af5dd",
    "persona_profiles.inputs.development.jsonl": "6a7ba943a01e29b7f807cb5e8749ded30a793c5f8b11ca87d5c28fb8be2e6a8b",
    "persona_profiles.graders.development.jsonl": "d4c192609d9d1cb10fc709f0ea85788d822ca3747858c1d85a4dcba8ccfdcfba",
    "legacy_business/inputs.development.jsonl": "ad9307e21eedbc51ecfdba78f7df25b93bfbc1673dc099e4996ae730984cd4f4",
    "legacy_business/scenarios.development.jsonl": "0104df8927f344277f6b59103485eb2ec4aafc0a0e3f7385a402ed2ea4dfe78f",
    "legacy_business/jevchat.inputs.development.jsonl": "de81e95a183f68e57dc6c9102c0d58c76dae64f4efcf2e0cc32af2adf778eb06",
    "legacy_business/jevchat.scenarios.development.jsonl": "a8b712fdd1935f2f9d8d5ce0e550ce02ba55ae8111b9f7dc977105929d81716a",
}
_FORBIDDEN_GENERATION_KEYS = frozenset(
    {
        "expected_behavior",
        "failure_behaviors",
        "grading",
        "reasonable_behaviors",
        "review_expectations",
        "rubric",
    }
)
_PERSONA_REFS = frozenset(
    f"{persona_id}@1.0.1"
    for persona_id in (
        "clear_direct",
        "curious_explorer",
        "observant_warmth",
        "quiet_depth",
        "relaxed_wit",
        "warm_candid",
    )
)
_IDENTIFIER = re.compile(r"^[A-Za-z0-9_.:@-]+$")


@dataclass(frozen=True, slots=True)
class DevelopmentCase:
    case_id: str
    synthetic: bool
    generation_context: dict[str, Any]
    source_input: dict[str, Any]


def _nonempty_string(value: object) -> bool:
    return isinstance(value, str) and bool(value.strip())


def _valid_identifier(value: object) -> bool:
    return _nonempty_string(value) and _IDENTIFIER.fullmatch(value) is not None


def _approved_path(root: Path, relative: str) -> Path:
    if root.is_symlink():
        raise ValueError(f"approved eval root symlink is not allowed: {root}")
    current = root
    for part in Path(relative).parts:
        current /= part
        if current.is_symlink():
            raise ValueError(f"approved eval symlink is not allowed: {relative}")
    return current


def _parse_jsonl(raw: bytes, path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for line_number, line in enumerate(raw.decode("utf-8").splitlines(), start=1):
        if not line.strip():
            raise ValueError(f"blank JSONL row: {path}:{line_number}")
        value = json.loads(line)
        if not isinstance(value, dict):
            raise ValueError(f"JSONL row must be an object: {path}:{line_number}")
        rows.append(value)
    return rows


def _read_approved_jsonl(root: Path, relative: str) -> list[dict[str, Any]]:
    path = _approved_path(root, relative)
    raw = path.read_bytes()
    if hashlib.sha256(raw).hexdigest() != _APPROVED_FILE_SHA256[relative]:
        raise ValueError(f"{relative} does not match its approved SHA-256 hash")
    return _parse_jsonl(raw, path)


def _require_count(rows: list[dict[str, Any]], expected: int, label: str) -> None:
    if len(rows) != expected:
        raise ValueError(f"{label} must contain exactly {expected} rows")
    ids = [row.get("id") for row in rows]
    if any(not _valid_identifier(case_id) for case_id in ids) or len(set(ids)) != len(ids):
        raise ValueError(f"{label} must contain unique nonempty ids")


def _reject_forbidden_generation_keys(value: object, label: str) -> None:
    if isinstance(value, dict):
        for key, nested in value.items():
            if key.casefold() in _FORBIDDEN_GENERATION_KEYS:
                raise ValueError(f"{label} contains forbidden generation key: {key}")
            _reject_forbidden_generation_keys(nested, label)
    elif isinstance(value, list):
        for nested in value:
            _reject_forbidden_generation_keys(nested, label)


def _validate_history(history: object, *, profile: bool, label: str) -> None:
    if not isinstance(history, list) or not history:
        raise ValueError(f"{label} history must be a nonempty list")
    expected = {"speaker", "text"} if profile else {"event_id", "speaker", "text"}
    allowed_speakers = {"other"} if profile else {"event", "other"}
    for message in history:
        if not isinstance(message, dict) or set(message) != expected:
            raise ValueError(f"{label} history has invalid fields")
        if message["speaker"] not in allowed_speakers or not _nonempty_string(message["text"]):
            raise ValueError(f"{label} history has invalid speaker or text")
        if not profile and not _valid_identifier(message["event_id"]):
            raise ValueError(f"{label} history has invalid event_id")


def _validate_case_input(case_input: object, *, profile: bool, label: str) -> None:
    if not isinstance(case_input, dict):
        raise ValueError(f"{label} case_input must be an object")
    _reject_forbidden_generation_keys(case_input, label)
    if profile:
        if set(case_input) != {"history", "relevant_context", "synthetic_fixture"}:
            raise ValueError(f"{label} case_input has invalid fields")
        if case_input["synthetic_fixture"] is not True or not _nonempty_string(case_input["relevant_context"]):
            raise ValueError(f"{label} case_input has invalid values")
        _validate_history(case_input["history"], profile=True, label=label)
        return

    required = {"history", "identity_brief", "persona_ref", "relevant_context", "synthetic_fixture"}
    if not required <= set(case_input) <= required | {"account_binding", "other_profile"}:
        raise ValueError(f"{label} case_input has invalid fields")
    if case_input["synthetic_fixture"] is not True or not _nonempty_string(case_input["identity_brief"]) or not _nonempty_string(case_input["relevant_context"]) or case_input["persona_ref"] not in _PERSONA_REFS:
        raise ValueError(f"{label} case_input has invalid values")
    _validate_history(case_input["history"], profile=False, label=label)
    if "account_binding" in case_input:
        binding = case_input["account_binding"]
        if not isinstance(binding, dict) or set(binding) != {"persona_id", "persona_version"}:
            raise ValueError(f"{label} account_binding has invalid fields")
        if f"{binding['persona_id']}@{binding['persona_version']}" not in _PERSONA_REFS:
            raise ValueError(f"{label} account_binding has invalid values")
    if "other_profile" in case_input:
        other = case_input["other_profile"]
        if not isinstance(other, dict) or set(other) != {"occupation"} or not _nonempty_string(other["occupation"]):
            raise ValueError(f"{label} other_profile has invalid fields")


def _case_input_cases(root: Path, relative: str, expected: int, label: str, *, profile: bool) -> tuple[DevelopmentCase, ...]:
    rows = _read_approved_jsonl(root, relative)
    _require_count(rows, expected, label)
    cases: list[DevelopmentCase] = []
    for row in rows:
        if set(row) != {"id", "case_input"}:
            raise ValueError(f"{label} rows must contain only id and case_input")
        _validate_case_input(row["case_input"], profile=profile, label=label)
        cases.append(DevelopmentCase(row["id"], True, copy.deepcopy(row["case_input"]), copy.deepcopy(row)))
    return tuple(cases)


def _validate_legacy_message(message: object, label: str) -> None:
    if not isinstance(message, dict) or set(message) != {"id", "role", "text"}:
        raise ValueError(f"{label} row has invalid messages")
    if not _valid_identifier(message["id"]) or message["role"] != "creator" or not _nonempty_string(message["text"]):
        raise ValueError(f"{label} row has invalid messages")


def _validate_legacy_input_row(row: dict[str, Any], label: str, *, jevchat: bool) -> None:
    required = {"id", "family_id", "synthetic", "split", "known_context", "messages"}
    expected = required | ({"family_label", "notes"} if jevchat else set())
    _reject_forbidden_generation_keys(row, label)
    if set(row) != expected or row["synthetic"] is not True or row["split"] != "development":
        raise ValueError(f"{label} row has invalid input fields")
    strings = {"family_id", "known_context"} | ({"family_label", "notes"} if jevchat else set())
    if not _valid_identifier(row["family_id"]) or any(not _nonempty_string(row[field]) for field in strings - {"family_id"}):
        raise ValueError(f"{label} row has invalid generation context")
    if not isinstance(row["messages"], list) or not row["messages"]:
        raise ValueError(f"{label} row has invalid messages")
    for message in row["messages"]:
        _validate_legacy_message(message, label)


def _legacy_cases(root: Path, relative: str, expected: int, label: str, *, jevchat: bool) -> tuple[DevelopmentCase, ...]:
    rows = _read_approved_jsonl(root, relative)
    _require_count(rows, expected, label)
    cases: list[DevelopmentCase] = []
    for row in rows:
        _validate_legacy_input_row(row, label, jevchat=jevchat)
        context = {"known_context": row["known_context"], "messages": row["messages"]}
        cases.append(DevelopmentCase(row["id"], True, copy.deepcopy(context), copy.deepcopy(row)))
    return tuple(cases)


def load_generation_cases(evals_root: Path) -> dict[str, tuple[DevelopmentCase, ...]]:
    """Load model-facing inputs only; no grader or scenario file is read."""
    root = Path(evals_root)
    suites = {
        "social": _case_input_cases(root, "inputs.development.jsonl", 72, "social inputs", profile=False),
        "persona_profiles": _case_input_cases(root, "persona_profiles.inputs.development.jsonl", 12, "persona profile inputs", profile=True),
        "legacy_business": _legacy_cases(root, "legacy_business/inputs.development.jsonl", 36, "legacy business inputs", jevchat=False)
        + _legacy_cases(root, "legacy_business/jevchat.inputs.development.jsonl", 24, "legacy JevChat inputs", jevchat=True),
    }
    ids = [case.case_id for cases in suites.values() for case in cases]
    if len(ids) != len(set(ids)):
        raise ValueError("development case ids must be globally unique across suites")
    return suites


def _validate_social_grader(row: dict[str, Any]) -> None:
    if set(row) != {"id", "family_id", "category", "rubric"}:
        raise ValueError("social grader evidence has invalid schema")
    if not all(_nonempty_string(row[field]) for field in ("id", "family_id", "category")):
        raise ValueError("social grader evidence has invalid schema")
    rubric = row["rubric"]
    if not isinstance(rubric, dict) or set(rubric) != {"failure_behaviors", "grading", "reasonable_behaviors"}:
        raise ValueError("social grader evidence has invalid schema")
    if not _nonempty_string(rubric["grading"]):
        raise ValueError("social grader evidence has invalid schema")
    for field in ("failure_behaviors", "reasonable_behaviors"):
        values = rubric[field]
        if not isinstance(values, list) or not values or any(not _nonempty_string(value) for value in values):
            raise ValueError("social grader evidence has invalid schema")


def _validate_profile_grader(row: dict[str, Any]) -> None:
    if set(row) != {"id", "family_id", "synthetic", "expected_behavior", "grading"}:
        raise ValueError("persona profile grader evidence has invalid schema")
    if row["synthetic"] is not True or any(not _nonempty_string(row[field]) for field in ("id", "family_id", "expected_behavior", "grading")):
        raise ValueError("persona profile grader evidence has invalid schema")


def _validate_legacy_evidence(row: dict[str, Any], label: str) -> None:
    expected = {"id", "family_id", "family_label", "synthetic", "split", "known_context", "messages", "review_expectations", "notes"}
    if set(row) != expected or row["synthetic"] is not True or row["split"] != "development":
        raise ValueError(f"{label} has invalid schema")
    if any(not _nonempty_string(row[field]) for field in ("id", "family_id", "family_label", "known_context", "notes")):
        raise ValueError(f"{label} has invalid schema")
    if not isinstance(row["messages"], list) or not row["messages"]:
        raise ValueError(f"{label} has invalid schema")
    for message in row["messages"]:
        _validate_legacy_message(message, label)
    review = row["review_expectations"]
    if not isinstance(review, dict) or set(review) != {"exact_reply_required", "must_consider", "must_not_do"}:
        raise ValueError(f"{label} has invalid schema")
    if type(review["exact_reply_required"]) is not bool or any(not _nonempty_string(review[field]) for field in ("must_consider", "must_not_do")):
        raise ValueError(f"{label} has invalid schema")


def _validate_social_scenarios(root: Path, expected_ids: list[str]) -> None:
    rows = _read_approved_jsonl(root, "scenarios.development.jsonl")
    _require_count(rows, 72, "social scenario evidence")
    for row in rows:
        if set(row) != {"id", "family_id", "category", "synthetic", "split", "case_input", "rubric"}:
            raise ValueError("social scenario evidence has invalid schema")
        if row["synthetic"] is not True or row["split"] != "development_only":
            raise ValueError("social scenario evidence has invalid schema")
        _validate_case_input(row["case_input"], profile=False, label="social scenario evidence")
        _validate_social_grader({key: row[key] for key in ("id", "family_id", "category", "rubric")})
    if [row["id"] for row in rows] != expected_ids:
        raise ValueError("social scenario evidence ids differ from approved inputs")


def load_development_evidence(evals_root: Path) -> dict[str, tuple[dict[str, Any], ...]]:
    """Load grader/scenario evidence for a separate evaluator process."""
    root = Path(evals_root)
    social = _read_approved_jsonl(root, "graders.development.jsonl")
    profiles = _read_approved_jsonl(root, "persona_profiles.graders.development.jsonl")
    legacy = _read_approved_jsonl(root, "legacy_business/scenarios.development.jsonl")
    jevchat = _read_approved_jsonl(root, "legacy_business/jevchat.scenarios.development.jsonl")
    _require_count(social, 72, "social grader evidence")
    _require_count(profiles, 12, "persona profile grader evidence")
    _require_count(legacy, 36, "legacy business scenario evidence")
    _require_count(jevchat, 24, "legacy JevChat scenario evidence")
    for row in social:
        _validate_social_grader(row)
    for row in profiles:
        _validate_profile_grader(row)
    for row in legacy:
        _validate_legacy_evidence(row, "legacy business scenario evidence")
    for row in jevchat:
        _validate_legacy_evidence(row, "legacy JevChat scenario evidence")

    cases = load_generation_cases(root)
    _validate_social_scenarios(root, [case.case_id for case in cases["social"]])
    evidence = {
        "social": tuple(copy.deepcopy(social)),
        "persona_profiles": tuple(copy.deepcopy(profiles)),
        "legacy_business": tuple(copy.deepcopy(legacy + jevchat)),
    }
    for name, rows in evidence.items():
        if [case.case_id for case in cases[name]] != [row["id"] for row in rows]:
            raise ValueError(f"{name} generation inputs and evidence ids differ")
    return evidence
