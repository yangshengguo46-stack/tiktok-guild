# Social runtime model preflight

Run from `backend/` with the existing project Python environment:

```bash
.venv/bin/python -m scripts.benchmark.social_preflight
.venv/bin/python -m scripts.benchmark.social_preflight --live --max-calls 12 --timeout 60
```

The default command prints a plan and never loads credentials or calls a model.
`--live` uses the configured `codex` model from
`ops/guild-runtime/config/config.yaml`; `--config` and `--model` can select an
explicit alternative. Only providers whose retry setting can be disabled are
accepted. Each transport runs in a separate process so a 60-second timeout can
terminate a synchronous provider request too. There are no automatic retries;
the first transport, parsing, or commit failure stops the run.

The twelve-call plan covers three non-business turns, a paired occupation
replacement, five production selector decisions, profile generation and explicit
activation, a real model request using the generated profile, and a local binding
rollback. Inputs are synthetic Chinese messages. A temporary SQLite database is
deleted after the run. Platform tools are empty and outbound rows remain pending;
no connection, message, receipt, invitation or TikTok action is exercised.

The harness invokes production `SocialRuntime`, `SocialTurnMiddleware`,
`ModelRequest`, the transactional repository, `ProfileManagement`, and
`create_chat_model`. It deliberately does not assemble the full Lead tool catalog,
Gateway, ChannelManager or MCP servers. It is a runtime/model preflight, not an
end-to-end platform acceptance or a blinded quality benchmark. The production Lead
assembly is covered separately by `tests/test_social_lead_runtime.py`.

Raw synthetic responses, model identifiers, tokens and elapsed time are saved
under the repository's Git-ignored `.deer-flow/audits/`. Existing reports cannot be
overwritten. Dollar cost is `unknown` because no price has been verified. A failed
run retains partial scenario results and call records; it must not be reported as
passed. Naturalness, memory accuracy and occupation effects need human review of
the responses, not keyword-based success claims.
