"""Approved package integrity and the bounded runtime persona catalog."""

from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from deerflow.social.assets import load_social_assets

ROOT = Path(__file__).resolve().parents[2]
ASSETS = ROOT / "docs" / "product" / "creator-agent-final-persona-rev1"
VERIFY = ROOT / "scripts" / "verify_creator_agent_assets.py"
PERSONA_IDS = {"relaxed_wit", "clear_direct", "curious_explorer", "observant_warmth", "quiet_depth", "warm_candid"}


def _verify(root: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run([sys.executable, str(VERIFY), str(root)], capture_output=True, text=True, check=False)


def test_imported_package_matches_every_manifest_hash():
    result = _verify(ASSETS)
    assert result.returncode == 0, result.stderr
    assert "Verified 76 manifest files (473848 bytes)" in result.stdout


def test_verifier_rejects_symlinked_package_root(tmp_path):
    linked_root = tmp_path / "package-link"
    linked_root.symlink_to(ASSETS, target_is_directory=True)

    result = _verify(linked_root)
    assert result.returncode != 0
    assert "asset root symlink is not allowed" in result.stderr


@pytest.mark.parametrize("change", ["missing", "extra", "modified"])
def test_verifier_rejects_file_set_or_hash_drift(tmp_path, change):
    candidate = tmp_path / "package"
    shutil.copytree(ASSETS, candidate)
    target = candidate / "personas" / "relaxed_wit.json"
    if change == "missing":
        target.unlink()
    elif change == "extra":
        (candidate / "unexpected.txt").write_text("unexpected", encoding="utf-8")
    else:
        target.write_bytes(target.read_bytes() + b" ")

    result = _verify(candidate)
    assert result.returncode != 0
    assert "mismatch" in result.stderr


def test_runtime_loader_exposes_only_six_immutable_expression_assets():
    catalog = load_social_assets(ASSETS)
    assert set(catalog) == PERSONA_IDS
    assert {asset["version"] for asset in catalog.values()} == {"1.0.1"}
    assert set(catalog["relaxed_wit"]) == {"id", "version", "core", "behavior", "interests"}
    assert catalog["clear_direct"]["behavior"]["voice"] == "直接、利落，不居高临下，不机械给清单"
    with pytest.raises(TypeError):
        catalog["relaxed_wit"]["behavior"]["voice"] = "changed"
