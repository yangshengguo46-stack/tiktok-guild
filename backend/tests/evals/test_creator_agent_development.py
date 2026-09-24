"""Offline contract tests for the approved CreatorAgent development inputs.

These tests prove data loading and separation only. They do not grade model
quality, naturalness, TikTok behavior, or production outcomes.
"""

from __future__ import annotations

from pathlib import Path

from scripts.evals.creator_agent_development import load_development_evidence, load_generation_cases

ROOT = Path(__file__).resolve().parents[3]
EVALS = ROOT / "docs" / "product" / "creator-agent-final-persona-rev1" / "evals"
FORBIDDEN_GENERATION_KEYS = {"rubric", "expected_behavior", "grading", "review_expectations"}


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
