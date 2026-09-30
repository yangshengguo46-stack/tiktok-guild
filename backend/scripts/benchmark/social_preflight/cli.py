"""Default to a read-only plan. Live calls require an explicit --live flag."""

import argparse
import asyncio
import json
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]


def output_path(path):
    resolved = Path(path).resolve()
    if not resolved.is_relative_to(ROOT / ".deer-flow"):
        raise ValueError("raw output must remain in the ignored .deer-flow directory")
    if resolved.exists():
        raise ValueError("refusing to overwrite existing preflight evidence")
    return resolved


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--live", action="store_true")
    parser.add_argument("--config", type=Path, default=ROOT / "ops/guild-runtime/config/config.yaml")
    parser.add_argument("--model", default="codex")
    parser.add_argument("--max-calls", type=int, choices=range(1, 13), default=12)
    parser.add_argument("--timeout", type=int, choices=range(1, 61), default=60)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args(argv)
    if not args.live:
        print(
            json.dumps(
                {
                    "live": False,
                    "planned_calls": 12,
                    "max_calls": args.max_calls,
                    "timeout_seconds": args.timeout,
                    "platform_tools": [],
                    "scenarios": ["three-turn conversation", "two-occupation replacement", "generation/activation/model-request/rollback"],
                    "boundary": "SocialRuntime + SocialTurnMiddleware + SQLite; no Gateway or provider",
                }
            )
        )
        return 0
    args.output = output_path(args.output or ROOT / ".deer-flow/audits" / (datetime.now(UTC).strftime("%Y%m%dT%H%M%S") + "-social-preflight.json"))
    from .runner import run_live

    report = asyncio.run(run_live(args))
    print(json.dumps({"complete": report["complete"], "calls": len(report["calls"]), "output": str(args.output), "error": report.get("error")}, ensure_ascii=False))
    return 0 if report["complete"] else 1
