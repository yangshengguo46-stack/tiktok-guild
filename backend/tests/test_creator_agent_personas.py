"""Offline contracts for the versioned creator expression assets."""

from __future__ import annotations

import json
from copy import deepcopy
from pathlib import Path

import pytest

from deerflow.creator_agent.personas import (
    effective_persona_fingerprint,
    load_personas,
    resolve_persona,
)

CATALOG_PATH = Path(__file__).resolve().parents[2] / "ops" / "guild-runtime" / "config" / "personas.json"
IDS = {
    "relaxed_wit",
    "clear_direct",
    "curious_explorer",
    "observant_warmth",
    "quiet_depth",
    "warm_candid",
}
SCOPE = {"operator_id": "op-1", "account_id": "acct-1", "creator_uid": "uid-1"}


def test_catalog_loads_exact_six_versioned_expression_assets(monkeypatch):
    monkeypatch.setenv("DEER_FLOW_GUILD_PERSONAS_PATH", str(CATALOG_PATH))
    catalog = load_personas(None)

    assert set(catalog) == IDS
    assert {asset.version for asset in catalog.values()} == {"1.0.1"}
    assert catalog["relaxed_wit"].core == ("先进入事情本身；能看到日常的小反差，语气不紧绷，认真时不硬抖机灵。")
    assert catalog["clear_direct"].behavior["voice"] == ("直接、利落，不居高临下，不机械给清单")
    assert catalog["warm_candid"].interests == (
        "日常生活与习惯",
        "人与人如何相处",
        "作品中的具体感受",
    )


def test_catalog_rejects_unknown_id_and_identity_fields(tmp_path):
    payload = json.loads(CATALOG_PATH.read_text(encoding="utf-8"))
    payload["personas"][0]["id"] = "unknown"
    candidate = tmp_path / "personas.json"
    candidate.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    with pytest.raises(ValueError, match="persona"):
        load_personas(str(candidate))

    payload["personas"][0]["id"] = "relaxed_wit"
    payload["personas"][0]["identity_policy"] = "pretend to be someone else"
    candidate.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    with pytest.raises(ValueError, match="field"):
        load_personas(str(candidate))


def test_catalog_rejects_non_string_id_and_oversized_file(tmp_path):
    payload = json.loads(CATALOG_PATH.read_text(encoding="utf-8"))
    payload["personas"][0]["id"] = ["relaxed_wit"]
    candidate = tmp_path / "personas.json"
    candidate.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    with pytest.raises(ValueError, match="persona id"):
        load_personas(str(candidate))

    candidate.write_text(" " * 32_769, encoding="utf-8")
    with pytest.raises(ValueError, match="32 KiB"):
        load_personas(str(candidate))


def test_missing_state_and_unknown_stored_id_resolve_to_default():
    catalog = load_personas(str(CATALOG_PATH))

    for state in (None, {"persona_id": "missing", "persona_revision": 7}):
        snapshot = resolve_persona(catalog, state, scope=SCOPE, context_version=4)
        assert snapshot["persona_id"] == "relaxed_wit"
        assert snapshot["persona_version"] == "1.0.1"
        assert snapshot["persona_revision"] == 0
        assert snapshot["evidence_version"] == 0


def test_foreign_scoped_state_cannot_select_persona():
    catalog = load_personas(str(CATALOG_PATH))
    state = {
        "scope": {**SCOPE, "creator_uid": "other-creator"},
        "persona_id": "quiet_depth",
        "persona_revision": 2,
        "evidence_version": 5,
    }

    snapshot = resolve_persona(catalog, state, scope=SCOPE, context_version=5)
    assert snapshot["persona_id"] == "relaxed_wit"
    assert snapshot["persona_revision"] == 0


def test_resolver_renders_only_one_persona_without_identity_or_permission():
    catalog = load_personas(str(CATALOG_PATH))
    snapshot = resolve_persona(
        catalog,
        {"persona_id": "quiet_depth", "persona_revision": 2, "evidence_version": 5},
        scope=SCOPE,
        context_version=5,
    )

    assert snapshot["persona_id"] == "quiet_depth"
    assert snapshot["persona_revision"] == 2
    assert snapshot["core"] == catalog["quiet_depth"].core
    assert snapshot["behavior"] == dict(catalog["quiet_depth"].behavior)
    assert snapshot["interests"] == list(catalog["quiet_depth"].interests)
    assert "relaxed_wit" not in json.dumps(snapshot, ensure_ascii=False)
    assert not ({"identity", "permission", "recipient", "commitments"} & snapshot.keys())


def test_resolution_and_fingerprint_do_not_mutate_inputs():
    catalog = load_personas(str(CATALOG_PATH))
    state = {"persona_id": "quiet_depth", "persona_revision": 2, "evidence_version": 5}
    scope = deepcopy(SCOPE)
    before_state = deepcopy(state)
    snapshot = resolve_persona(catalog, state, scope=scope, context_version=5)
    before_snapshot = deepcopy(snapshot)

    effective_persona_fingerprint(snapshot)
    snapshot["behavior"]["voice"] = "changed copy"
    snapshot["interests"].append("changed copy")

    assert scope == SCOPE
    assert state == before_state
    assert before_snapshot["behavior"]["voice"] == catalog["quiet_depth"].behavior["voice"]
    assert catalog["quiet_depth"].interests == ("书与作品", "器物和历史细节", "生活观察")


def test_fingerprint_tracks_scope_asset_revision_evidence_and_policy():
    catalog = load_personas(str(CATALOG_PATH))
    base = resolve_persona(
        catalog,
        {"persona_id": "quiet_depth", "persona_revision": 2, "evidence_version": 5},
        scope=SCOPE,
        context_version=5,
    )
    digest = effective_persona_fingerprint(base)
    assert len(digest) == 64

    for key, value in (
        ("scope", {**SCOPE, "creator_uid": "uid-2"}),
        ("core", "asset content changed"),
        ("persona_revision", 3),
        ("evidence_version", 6),
        ("decision_policy_version", "2"),
    ):
        changed = deepcopy(base)
        changed[key] = value
        assert effective_persona_fingerprint(changed) != digest

    unrelated = deepcopy(base)
    unrelated["operator_note"] = "another creator changed"
    assert effective_persona_fingerprint(unrelated) == digest
