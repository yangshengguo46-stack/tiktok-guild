"""Offline contract tests for the approved CreatorAgent development inputs.

These tests prove data loading and separation only. They do not grade model
quality, naturalness, TikTok behavior, or production outcomes.
"""

from __future__ import annotations

import hashlib
import json
import shutil
from pathlib import Path

import pytest

from scripts.evals import creator_agent_development as eval_loader
from scripts.evals.creator_agent_development import load_development_evidence, load_generation_cases

ROOT = Path(__file__).resolve().parents[3]
EVALS = ROOT / "docs" / "product" / "creator-agent-final-persona-rev1" / "evals"
FORBIDDEN_GENERATION_KEYS = {
    "expected_behavior",
    "failure_behaviors",
    "grading",
    "reasonable_behaviors",
    "review_expectations",
    "rubric",
}


def _all_keys(value: object) -> set[str]:
    if isinstance(value, dict):
        keys = set(value)
        for nested in value.values():
            keys.update(_all_keys(nested))
        return keys
    if isinstance(value, list | tuple):
        keys: set[str] = set()
        for nested in value:
            keys.update(_all_keys(nested))
        return keys
    return set()


def test_loads_exactly_the_three_approved_development_suites() -> None:
    suites = load_generation_cases(EVALS)

    assert list(suites) == ["social", "persona_profiles", "legacy_business"]
    assert len(suites["social"]) == 72
    assert len(suites["persona_profiles"]) == 12
    assert len(suites["legacy_business"]) == 60
    assert len({case.case_id for cases in suites.values() for case in cases}) == 144
    assert all(case.synthetic for cases in suites.values() for case in cases)


def test_generation_context_contains_inputs_only_and_never_grader_or_scenario_fields() -> None:
    suites = load_generation_cases(EVALS)

    assert all(set(case.generation_context) == set(case.source_input["case_input"]) for case in suites["social"])
    assert all(set(case.generation_context) == set(case.source_input["case_input"]) for case in suites["persona_profiles"])
    assert all(set(case.generation_context) == {"known_context", "messages"} for case in suites["legacy_business"])
    for cases in suites.values():
        for case in cases:
            assert _all_keys(case.generation_context).isdisjoint(FORBIDDEN_GENERATION_KEYS)


def test_graders_and_scenarios_are_loaded_as_separate_evidence_with_matching_ids() -> None:
    suites = load_generation_cases(EVALS)
    evidence = load_development_evidence(EVALS)

    assert {key: len(value) for key, value in evidence.items()} == {
        "social": 72,
        "persona_profiles": 12,
        "legacy_business": 60,
    }
    for name in suites:
        assert [case.case_id for case in suites[name]] == [item["id"] for item in evidence[name]]
    assert all("rubric" in item for item in evidence["social"])
    assert all("expected_behavior" in item for item in evidence["persona_profiles"])
    assert all("review_expectations" in item for item in evidence["legacy_business"])


def test_social_and_profile_inputs_do_not_embed_grader_text() -> None:
    suites = load_generation_cases(EVALS)
    evidence = load_development_evidence(EVALS)

    for name in ("social", "persona_profiles"):
        for case, grader in zip(suites[name], evidence[name], strict=True):
            assert case.case_id == grader["id"]
            assert not set(case.source_input) & FORBIDDEN_GENERATION_KEYS
            assert not _all_keys(case.generation_context) & _all_keys(grader)


def _copy_evals(tmp_path: Path) -> Path:
    target = tmp_path / "evals"
    shutil.copytree(EVALS, target)
    return target


def _rewrite_jsonl(path: Path, mutate) -> None:
    rows = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]
    mutate(rows)
    path.write_text("".join(f"{json.dumps(row, ensure_ascii=False)}\n" for row in rows), encoding="utf-8")


def _approve_test_file(monkeypatch: pytest.MonkeyPatch, root: Path, relative: str) -> None:
    digest = hashlib.sha256((root / relative).read_bytes()).hexdigest()
    monkeypatch.setitem(eval_loader._APPROVED_FILE_SHA256, relative, digest)


def test_generation_loader_does_not_open_evidence_files(tmp_path: Path) -> None:
    root = tmp_path / "evals"
    (root / "legacy_business").mkdir(parents=True)
    for relative in (
        "inputs.development.jsonl",
        "persona_profiles.inputs.development.jsonl",
        "legacy_business/inputs.development.jsonl",
        "legacy_business/jevchat.inputs.development.jsonl",
    ):
        shutil.copy2(EVALS / relative, root / relative)

    assert sum(len(cases) for cases in load_generation_cases(root).values()) == 144


def test_rejects_reordered_input_and_evidence_even_when_their_ids_still_match(tmp_path: Path) -> None:
    root = _copy_evals(tmp_path)
    for relative in ("inputs.development.jsonl", "graders.development.jsonl"):
        _rewrite_jsonl(relative_path := root / relative, lambda rows: rows.__setitem__(slice(0, 2), [rows[1], rows[0]]))
        assert relative_path.exists()

    with pytest.raises(ValueError, match="approved.*hash|hash.*approved"):
        load_development_evidence(root)


def test_rejects_recursive_answer_keys_inside_generation_input(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    root = _copy_evals(tmp_path)
    relative = "inputs.development.jsonl"
    _rewrite_jsonl(root / relative, lambda rows: rows[0]["case_input"]["other_profile"].update({"rubric": "leak"}))
    _approve_test_file(monkeypatch, root, relative)

    with pytest.raises(ValueError, match="forbidden generation key"):
        load_generation_cases(root)


def test_rejects_invalid_legacy_message_role_and_text_schema(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    root = _copy_evals(tmp_path)
    relative = "legacy_business/inputs.development.jsonl"
    _rewrite_jsonl(root / relative, lambda rows: rows[0]["messages"][0].update({"role": "grader"}))
    _approve_test_file(monkeypatch, root, relative)

    with pytest.raises(ValueError, match="invalid messages"):
        load_generation_cases(root)


def test_rejects_evidence_extra_fields_under_strict_schema(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    root = _copy_evals(tmp_path)
    relative = "persona_profiles.graders.development.jsonl"
    _rewrite_jsonl(root / relative, lambda rows: rows[0].update({"hidden_answer": "leak"}))
    _approve_test_file(monkeypatch, root, relative)

    with pytest.raises(ValueError, match="persona profile grader evidence.*schema"):
        load_development_evidence(root)


def test_rejects_duplicate_ids_across_suites(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    root = _copy_evals(tmp_path)
    relative = "persona_profiles.inputs.development.jsonl"
    _rewrite_jsonl(root / relative, lambda rows: rows[0].update({"id": "F01-1"}))
    _approve_test_file(monkeypatch, root, relative)

    with pytest.raises(ValueError, match="globally unique"):
        load_generation_cases(root)
