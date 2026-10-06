"""The active prompt and tool schemas must not carry development examples or history."""

from types import SimpleNamespace

import pytest

from deerflow.agents.lead_agent import prompt as prompt_module
from deerflow.sandbox import tools as sandbox_tools
from deerflow.subagents.builtins.general_purpose import GENERAL_PURPOSE_CONFIG


@pytest.mark.parametrize("concurrency", [1, 3])
def test_rendered_lead_prompt_excludes_development_examples(monkeypatch, concurrency):
    config = SimpleNamespace(
        sandbox=SimpleNamespace(mounts=[]),
        memory=SimpleNamespace(enabled=False),
        acp_agents={},
    )
    monkeypatch.setattr(prompt_module, "get_skills_prompt_section", lambda *args, **kwargs: "")
    monkeypatch.setattr(prompt_module, "get_agent_soul", lambda *args, **kwargs: "")
    monkeypatch.setattr(prompt_module, "get_available_subagent_names", lambda **kwargs: ["general-purpose", "bash"])
    monkeypatch.setattr("deerflow.subagents.batch_runtime.is_subagent_batch_runtime_available", lambda: False)

    prompt = prompt_module.apply_prompt_template(subagent_enabled=True, max_concurrent_subagents=concurrency, app_config=config)

    for development_text in (
        "issue #",
        "Claude Code's",
        "Codex's",
        "Deploy the application",
        "Deploy the app",
        "create a web scraper",
        "Optimize the code",
        "Add authentication",
        "Refactor authentication",
        'bash("npm test")',
        "DeerFlow is an open-source AI agent framework",
        "AI Trends 2026",
        "https://deer-flow.dev/docs",
    ):
        assert development_text not in prompt

    assert "ask_clarification" in prompt
    assert "risk_confirmation" in prompt
    assert "[citation:TITLE](URL)" in prompt
    assert "Sources" in prompt
    assert "str_replace" in prompt
    assert "append=True" in prompt
    assert "HARD LIMITS - NON-NEGOTIABLE" in prompt
    assert "System-Context Confidentiality" in prompt


def test_general_purpose_prompt_excludes_development_history():
    prompt = GENERAL_PURPOSE_CONFIG.system_prompt

    for development_text in ("issue #", "Claude Code's", "Codex's", "mid-stream chunk-gap"):
        assert development_text not in prompt

    assert "str_replace" in prompt
    assert "append=True" in prompt
    assert "NEVER attempt to call `task`" in prompt


@pytest.mark.parametrize("tool", [sandbox_tools.write_file_tool, sandbox_tools.str_replace_tool], ids=["write_file", "str_replace"])
def test_file_tool_descriptions_exclude_development_history(tool):
    description = tool.description

    for development_text in ("issue #", "Claude Code's", "Codex's", "DEERFLOW_WRITE_FILE_MAX_BYTES"):
        assert development_text not in description

    assert "read_file" in description
    assert "CURRENT" in description


def test_write_file_size_error_excludes_development_history(monkeypatch):
    monkeypatch.setenv("DEERFLOW_WRITE_FILE_MAX_BYTES", "1")

    result = sandbox_tools.write_file_tool.func(runtime=None, path="/mnt/user-data/outputs/test.txt", content="too long")

    assert "issue #" not in result
    assert "tool docstring" not in result
    assert "single-call limit" in result
    assert "str_replace" in result
    assert "append=True" in result
