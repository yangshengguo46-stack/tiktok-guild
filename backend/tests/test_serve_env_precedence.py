"""Regression coverage for approved runtime paths passed to ``serve.sh``."""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

import pytest
from support.shell import require_script_bash

REPO_ROOT = Path(__file__).resolve().parents[2]
ENV_HELPER = REPO_ROOT / "scripts" / "serve-env.sh"
SERVE_SH = REPO_ROOT / "scripts" / "serve.sh"
RUNTIME_PATHS = (
    "DEER_FLOW_CONFIG_PATH",
    "DEER_FLOW_EXTENSIONS_CONFIG_PATH",
    "DEER_FLOW_SKILLS_PATH",
    "DEER_FLOW_HOME",
    "DEER_FLOW_SOCIAL_ASSETS_PATH",
)


def _load_env(env_file: Path, explicit: dict[str, str]) -> dict[str, str]:
    shell = require_script_bash()
    environment = os.environ.copy()
    for name in (*RUNTIME_PATHS, "ONLY_FROM_DOTENV"):
        environment.pop(name, None)
    environment.update(explicit)
    script = """
source "$1"
load_deerflow_env_preserving_runtime_paths "$2"
printf 'DEER_FLOW_CONFIG_PATH=%s\n' "${DEER_FLOW_CONFIG_PATH-}"
printf 'DEER_FLOW_EXTENSIONS_CONFIG_PATH=%s\n' "${DEER_FLOW_EXTENSIONS_CONFIG_PATH-}"
printf 'DEER_FLOW_SKILLS_PATH=%s\n' "${DEER_FLOW_SKILLS_PATH-}"
printf 'DEER_FLOW_HOME=%s\n' "${DEER_FLOW_HOME-}"
printf 'DEER_FLOW_SOCIAL_ASSETS_PATH=%s\n' "${DEER_FLOW_SOCIAL_ASSETS_PATH-}"
printf 'ONLY_FROM_DOTENV=%s\n' "${ONLY_FROM_DOTENV-}"
"""
    completed = subprocess.run(
        [shell, "-c", script, "--", str(ENV_HELPER), str(env_file)],
        check=True,
        capture_output=True,
        text=True,
        env=environment,
    )
    return dict(line.split("=", 1) for line in completed.stdout.splitlines())


@pytest.mark.parametrize("explicit_name", RUNTIME_PATHS)
def test_explicit_runtime_path_wins_while_unset_values_load_from_dotenv(tmp_path: Path, explicit_name: str) -> None:
    env_file = tmp_path / ".env"
    from_dotenv = {name: f"/dotenv/{index}" for index, name in enumerate(RUNTIME_PATHS)}
    env_file.write_text(
        "".join(f"{name}={value}\n" for name, value in from_dotenv.items()) + "ONLY_FROM_DOTENV=loaded\n",
        encoding="utf-8",
    )
    explicit = {explicit_name: "/explicit/value"}

    loaded = _load_env(env_file, explicit)

    expected = from_dotenv | explicit
    assert {name: loaded[name] for name in RUNTIME_PATHS} == expected
    assert loaded["ONLY_FROM_DOTENV"] == "loaded"


def test_unset_runtime_paths_may_load_from_dotenv(tmp_path: Path) -> None:
    env_file = tmp_path / ".env"
    expected = {name: f"/dotenv/{index}" for index, name in enumerate(RUNTIME_PATHS)}
    env_file.write_text(
        "".join(f"{name}={value}\n" for name, value in expected.items()),
        encoding="utf-8",
    )

    loaded = _load_env(env_file, {})

    assert {name: loaded[name] for name in RUNTIME_PATHS} == expected


def test_serve_uses_env_helper_before_startup() -> None:
    serve = SERVE_SH.read_text(encoding="utf-8")

    source_line = 'source "$REPO_ROOT/scripts/serve-env.sh"'
    load_line = 'load_deerflow_env_preserving_runtime_paths "$REPO_ROOT/.env"'
    assert source_line in serve
    assert load_line in serve
    assert serve.index(source_line) < serve.index(load_line) < serve.index("_pick_python()")
