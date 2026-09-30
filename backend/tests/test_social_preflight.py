"""Offline fences for an explicitly opted-in, bounded model preflight."""

import asyncio
import importlib
import json
from pathlib import Path

import pytest


def module():
    return importlib.import_module("scripts.benchmark.social_preflight.cli")


def test_default_cli_prints_plan_without_importing_live_runner(monkeypatch, capsys):
    import sys

    monkeypatch.setitem(sys.modules, "scripts.benchmark.social_preflight.runner", None)
    assert module().main([]) == 0
    result = json.loads(capsys.readouterr().out)
    assert result["live"] is False and result["planned_calls"] == 12
    assert result["platform_tools"] == []


@pytest.mark.parametrize("args", [["--max-calls", "13"], ["--timeout", "61"], ["--max-calls", "0"]])
def test_cli_rejects_budget_expansion(args):
    with pytest.raises(SystemExit):
        module().main(args)


def test_cli_rejects_raw_output_outside_ignored_workspace(tmp_path):
    with pytest.raises(ValueError, match="ignored"):
        module().output_path(tmp_path / "raw.json")


def test_synthetic_intelligence_cases_bound_plan_and_funnel_stage():
    from pathlib import Path

    from scripts.benchmark.social_preflight.intelligence_cases import evaluate_fixtures

    cases = evaluate_fixtures(Path(__file__).parent / "fixtures" / "social_intelligence")
    assert len(cases) == 2
    assert all(case["intelligence_snapshot_revision"] == 1 for case in cases)
    assert all(case["plan_stage"] == "discovery" and case["formal_invite_allowed"] is False for case in cases)


@pytest.mark.asyncio
async def test_runtime_intelligence_case_derives_memory_and_consent_gate(tmp_path):
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from deerflow.persistence.base import Base
    from deerflow.persistence.social import SocialRepository
    from scripts.benchmark.social_preflight.intelligence_cases import evaluate_runtime_fixture

    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'intelligence.db'}")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    try:
        result = await evaluate_runtime_fixture(Path(__file__).parent / "fixtures" / "social_intelligence" / "creator_001.json", SocialRepository(async_sessionmaker(engine, expire_on_commit=False)))
        assert result["second_turn_loaded_memory"] is True
        assert result["memory_promotions"] == ["memory-1"]
        assert result["formal_invite_allowed"] is False
        assert result["followup_cancelled"] is True and result["followup_task_id"]
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_budget_stops_before_extra_transport_call():
    from scripts.benchmark.social_preflight.runner import Budget

    calls = []

    async def transport(messages):
        calls.append(messages)
        return {"content": "hi", "usage": {"input_tokens": 2, "output_tokens": 1, "total_tokens": 3}, "model": "fixture"}

    budget = Budget(1, 1, transport)
    await budget.request("reply", [])
    with pytest.raises(RuntimeError, match="budget"):
        await budget.request("reply", [])
    assert len(calls) == 1
    assert budget.calls[0]["cost_usd"] == "unknown"
    assert budget.calls[0]["usage"]["total_tokens"] == 3


@pytest.mark.asyncio
async def test_budget_timeout_stops_run_without_retry():
    from scripts.benchmark.social_preflight.runner import Budget

    calls = []

    async def transport(messages):
        calls.append(messages)
        await asyncio.sleep(10)

    budget = Budget(12, 0.01, transport)
    with pytest.raises(TimeoutError):
        await budget.request("reply", [])
    with pytest.raises(RuntimeError, match="stopped"):
        await budget.request("reply", [])
    assert len(calls) == 1


@pytest.mark.asyncio
async def test_offline_preflight_commits_and_activates_then_rolls_back(tmp_path):
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from deerflow.persistence.base import Base
    from deerflow.persistence.social import SocialRepository
    from scripts.benchmark.social_preflight.runner import Budget, run_cases

    async def transport(messages):
        system = str(messages[0].content)
        if "Choose one supplied expression" in system:
            payload = json.loads(messages[-1].content)
            value = {"action": "switch", "persona_id": "clear_direct", "confidence": 0.99, "evidence_refs": [payload["evidence"][0]["ref"]], "reason": "explicit communication preference"}
        elif "Generate an expression-only" in system:
            value = {"overrides": {"length": "short"}, "diff_summary": "shorter", "examples": ["Hello.", "Good point."]}
        else:
            value = {"reply": "A synthetic response."}
        return {"content": json.dumps(value), "model": "fixture", "usage": None}

    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'social.db'}")
    try:
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        budget = Budget(12, 1, transport)
        results = await run_cases(SocialRepository(async_sessionmaker(engine, expire_on_commit=False)), budget)
        assert len(budget.calls) == 12
        assert results[-2]["profile"] == "preflight-generated@1"
        assert results[-1]["effective"]["profile_ref"] == "relaxed_wit@1.0.1"
        assert all(row["outbound_states"] == ["pending"] * len(row["outbound_states"]) for row in results if "outbound_states" in row)
    finally:
        await engine.dispose()
