# DeerFlow Guild Runtime Migration Implementation Plan

> **Superseded:** `2026-09-23-deerflow-native-guild-agent.md` replaces this layered production plan. This file remains historical implementation and rollback evidence only.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将现有已验收的 Guild domain、memory、Guild tools 和 Recruiter Worker 接入一个干净、固定版本、默认隔离的 DeerFlow 运行时，并在真实 TikTok 写操作之前完成离线与容器验收。

**Architecture:** DeerFlow Gateway 是唯一 Agent/thread 运行时；Gateway 内固定启动 Guild MCP bridge，复用现有 Rust domain/memory，只暴露 7 个 Guild tools；Recruiter Worker 作为独立受控容器中的第二个 MCP server，保留现有 13-tool deterministic contract。DeerFlow 只接收版本化 allowlist 中登记的业务工具，首版目录正好是 7+13，但没有总数上限；sandbox、guardrail、网络 allowlist 和 deployment manifest 负责边界，但不替代 Guild/Worker ledger、DNC、预算和回执规则。

**Tech Stack:** DeerFlow 2.x (official `bytedance/deer-flow`, pinned commit), Rust 2021 workspace (`codex-guild-domain`, `codex-guild-memory`, `codex-guild-extension`, `rmcp`), Node.js >=22 validation/launcher scripts, MCP stdio/HTTP, Docker or Apple Container/AIO, Playwright Worker.

**Spec:** `docs/superpowers/specs/2026-09-22-deerflow-guild-runtime-design.md`

## Global Constraints

- Production DeerFlow source is cloned from official `bytedance/deer-flow` at an explicit commit; never reuse old source, cache, config, database, skills, or credentials.
- The initial Agent tool surface is the versioned allowlist of 7 Guild tools plus the existing 13 Worker tools; there is no numeric ceiling, and every later tool must be explicitly added with schema, policy, and replay coverage.
- No host home, source worktree, SSH material, old Codex/DeerFlow state, or Docker socket is mounted into any model-reachable process.
- LocalSandbox is development-only; production uses AIO Docker/Apple Container or an explicitly accepted BoxLite micro-VM.
- The Guild ledger remains the authority for action identity, DNC, budgets, method versions, claims, receipts, and unknown reconciliation.
- Login, CAPTCHA, 2FA, device verification, recharge, account binding, pause/resume, emergency-stop, and contract acceptance remain operator-only.
- No model-facing bash, arbitrary file write, browser primitive, tool search, dynamic MCP discovery, or container control plane.
- Every implementation task follows red-green-refactor; tests must fail for the missing behavior before production code is written.
- Existing `guild-domain`, `guild-memory`, `guild-extension`, app-server fixtures, and Worker protocol tests remain passing.

---

### Task 1: Freeze and validate the DeerFlow runtime contract

**Files:**
- Create: `ops/deerflow-guild-runtime/package.json`
- Create: `ops/deerflow-guild-runtime/src/catalog.mjs`
- Create: `ops/deerflow-guild-runtime/src/validate-config.mjs`
- Create: `ops/deerflow-guild-runtime/test/validate-config.test.mjs`
- Create: `ops/deerflow-guild-runtime/config/extensions_config.json`
- Create: `ops/deerflow-guild-runtime/config/runtime-manifest.json`
- Create: `ops/deerflow-guild-runtime/README.md`

**Interfaces:**
- `catalog.mjs` exports `GUILD_TOOL_NAMES`, `WORKER_TOOL_NAMES`, and `INITIAL_TOOL_NAMES` (the frozen initial 7+13 catalog), plus `canonicalToolNames(serverName)`.
- `validate-config.mjs` exports `validateRuntimeManifest(manifest, { filesystemPaths })` and `validateExtensionsConfig(config)`; both return `{ valid: true }` or throw an actionable `Error`.
- The validator rejects extra MCP servers/tools, old user paths, credentials, host mounts, Docker socket mounts, LocalSandbox, model-visible shell/browser/tool-search, and missing production sandbox/network settings.

- [ ] **Step 1: Write the failing validator tests**

  Add table-driven tests for: valid two-server config with the current allowlists; an unregistered tool; extra MCP server; `/Users/yangyucheng` or `.codex` path; credential-looking field; Docker socket mount; LocalSandbox; enabled shell/tool-search; and missing network allowlist. The validator must not reject a future catalog merely because its total count is greater than 20.

  The first test must assert the public contract directly:

  ```js
  test('accepts the exact two-server production contract', () => {
    assert.deepEqual(validateExtensionsConfig(validExtensions), { valid: true });
  });
  ```

  Each rejection test mutates one literal field and asserts the error mentions that field, so removing a guard makes the test fail.

- [ ] **Step 2: Run the tests to verify they fail**

  Run: `cd ops/deerflow-guild-runtime && npm test -- --test-name-pattern=validator`

  Expected: FAIL because the validator modules and fixtures do not exist.

- [ ] **Step 3: Implement the catalog and validator**

  Use the literal existing 7 Guild names from `codex-rs/ext/guild/src/lib.rs` and the literal 13 Worker names from `ops/tiktok-worker/src/runtime-config.mjs`. Require `guild_operator` and `recruiter_worker` only, exact ordered tool lists, `sandbox.provider` in `aio|apple-container|boxlite`, `network.mode = allowlist`, and reject forbidden path fragments/keys recursively without reading or copying old files. `validateExtensionsConfig` compares server names and each `enabled_tools` array to the exported literals and recursively rejects keys matching `/token|secret|password|cookie|credential|api[_-]?key/i`; `validateRuntimeManifest` rejects `/Users/yangyucheng`, `/.codex`, `/.ssh`, source worktrees, and `docker.sock` in path/mount strings.

- [ ] **Step 4: Add the pinned example configuration and operator notes**

  Store only non-secret JSON. `runtime-manifest.json` records the official DeerFlow repository URL and the inspected commit `769589e8daee14c2587a634b6b43bd96471a41a1` (peeled commit for tag `v2.1.0-rc0`), plus the sandbox provider, network allowlist, and the two MCP server names. The example has no image digest until a built image exists; validation requires a real `sha256:` digest for production mode. README states that credentials and TikTok login never enter Git, images, MCP arguments, or model context.

- [ ] **Step 5: Run the focused tests and commit**

  Run: `cd ops/deerflow-guild-runtime && npm test`

  Expected: PASS for all validator tests. Commit: `feat(deerflow): freeze guild runtime contract`.

### Task 2: Expose the existing Guild extension through a narrow Rust MCP bridge

**Files:**
- Modify: `codex-rs/ext/guild/Cargo.toml`
- Modify: `codex-rs/ext/guild/src/lib.rs`
- Create: `codex-rs/ext/guild/src/mcp_bridge.rs`
- Create: `codex-rs/ext/guild/src/mcp_bridge_tests.rs`
- Create: `codex-rs/ext/guild/src/bin/guild-mcp-bridge.rs`
- Modify: `codex-rs/ext/guild/BUILD.bazel`
- Create: `codex-rs/ext/guild/tests/mcp_bridge.rs`

**Interfaces:**
- `GuildMcpServer::from_env()` pins the admitted Guild home/database boundary and returns a server-scoped MCP service.
- `guild-mcp-bridge` reads newline-delimited MCP JSON-RPC from stdin and writes responses to stdout; stderr is diagnostics only.
- `tools/list` exposes exactly the existing 7 Guild names and their current JSON schemas; `tools/call` routes into the existing `GuildExecutor`/store logic without duplicating domain decisions.

- [ ] **Step 1: Write failing catalog/schema/replay/restart tests**

  Start the bridge with a temporary admitted Guild home, send `initialize` and `tools/list`, and compare the seven names and each `inputSchema` to the existing `ToolSpec` JSON. Add a replay test that executes a fixture prepare/claim/receipt sequence, restarts the process, and proves the same receipt is returned without a second dispatch.
- [ ] **Step 2: Run `just test -p codex-guild-extension` and observe the new tests fail**
- [ ] **Step 3: Implement the public bridge adapter with `rmcp` and fixed environment binding**

  Add `GuildMcpServer` as a thin adapter around `GuildExecutor`; construct `GuildTools::admitted` once, map MCP arguments to the existing `ToolCall` path, and never expose a generic executor or dynamic tool registration.
- [ ] **Step 4: Add restart and malformed/unknown-call error handling**

  Return MCP invalid-params for unknown names/malformed JSON, preserve existing `FunctionCallError` categories in JSON text, and close the store before process exit.
- [ ] **Step 5: Run `just fmt`, `just test -p codex-guild-extension`, and `just fix -p codex-guild-extension`; commit `feat(guild): add DeerFlow MCP bridge`**

### Task 3: Package the Recruiter Worker as a dedicated non-model container service

**Files:**
- Modify: `/Users/yangyucheng/plugins/tiktok-recruiter-worker/src/server.mjs`
- Modify: `/Users/yangyucheng/plugins/tiktok-recruiter-worker/src/router.mjs`
- Create: `/Users/yangyucheng/plugins/tiktok-recruiter-worker/test/deerflow-adapter.test.mjs`
- Create: `ops/deerflow-guild-runtime/worker/Dockerfile`
- Create: `ops/deerflow-guild-runtime/worker/entrypoint.mjs`
- Create: `ops/deerflow-guild-runtime/worker/worker-manifest.json`

**Interfaces:**
- Worker keeps the existing `DispatchRequestV1` / `DispatchReceiptV1` payloads and the exact 13 tool names.
- The container entrypoint accepts only MCP stdio or loopback HTTP selected by a fixed manifest; it never accepts a tool name, account binding, browser selector, or path from the model.
- Persistent profile, Worker SQLite, contracts, and logs live under the dedicated runtime volume; no host home or Docker socket is available.

- [ ] **Step 1: Add failing adapter tests for exact catalog, fixed volume root, and rejected control-plane arguments**

  Send `tools/list` and assert the 13 existing names; invoke the entrypoint with `--account-ref`, `--profile`, `--mount`, and `--socket` and assert it exits non-zero before starting the router.
- [ ] **Step 2: Run `npm test -- --test-name-pattern=deerflow` in the Worker repository and observe failure**
- [ ] **Step 3: Implement the fixed entrypoint/manifest checks while preserving the current router contract**
- [ ] **Step 4: Build a non-root image and run the offline fixture recruitment request**
- [ ] **Step 5: Run Worker tests and commit in the Worker repository; record its commit in `worker-manifest.json`**

### Task 4: Add clean official DeerFlow acquisition and locked deployment inputs

**Files:**
- Create: `ops/deerflow-guild-runtime/scripts/audit-old-install.mjs`
- Create: `ops/deerflow-guild-runtime/scripts/fetch-pinned-deerflow.mjs`
- Create: `ops/deerflow-guild-runtime/scripts/verify-manifest.mjs`
- Create: `ops/deerflow-guild-runtime/test/bootstrap.test.mjs`
- Create: `ops/deerflow-guild-runtime/deerflow/config.yaml`
- Create: `ops/deerflow-guild-runtime/deerflow/extensions_config.json`
- Create: `ops/deerflow-guild-runtime/deerflow/guardrails.json`

**Interfaces:**
- `audit-old-install.mjs` reports presence, owner, mode, and digest only; it never copies or deletes old DeerFlow/skills/MCP/cache data.
- `fetch-pinned-deerflow.mjs` requires an explicit commit, clones the official remote into a clean build directory, records commit/version/lockfile digests, and refuses floating `main` or unknown archives.
- `verify-manifest.mjs` checks clean worktree, image digest, config paths, no credentials, and exact tool catalog before startup.

- [ ] **Step 1: Write failing bootstrap tests with a fake old install and floating-branch input**

  Use a temporary directory containing `extensions_config.json`, `.deer-flow`, and a fake credential file; assert the audit output contains only metadata and the source tree is byte-for-byte unchanged. Pass `main` to the fetch function and assert it rejects before invoking `git`.
- [ ] **Step 2: Run focused bootstrap tests and observe failure**
- [ ] **Step 3: Implement read-only audit, pinned fetch, and manifest verification**
- [ ] **Step 4: Add DeerFlow config with allowlisted MCPs, guardrails, and AIO/Apple Container provider**
- [ ] **Step 5: Run offline bootstrap tests and commit `feat(deerflow): add clean pinned bootstrap`**

### Task 5: Add container acceptance harness and migration runbook

**Files:**
- Create: `ops/deerflow-guild-runtime/scripts/acceptance-fixture.mjs`
- Create: `ops/deerflow-guild-runtime/test/acceptance-fixture.test.mjs`
- Create: `ops/deerflow-guild-runtime/compose.fixture.yaml`
- Create: `ops/deerflow-guild-runtime/README.md` (extend)
- Modify: `docs/superpowers/specs/2026-09-22-deerflow-guild-runtime-design.md` (record accepted commit/digests only after verification)

**Interfaces:**
- The harness starts Gateway, Guild bridge, and Worker fixture services when Docker/Apple Container is available; otherwise it performs deterministic offline checks and reports the missing runtime.
- Acceptance asserts `tools/list` equals the configured allowlist (the initial fixture has 20 entries), Worker profile/SQLite are writable only inside its volume, forbidden host paths are unreadable, non-allowlisted network fails, prompt-injection tool calls are rejected, and one fixture recruitment flow produces a Guild receipt without external TikTok writes.

- [ ] **Step 1: Write failing fixture assertions for allowlisted catalog, filesystem boundary, network policy, and replay evidence**

  Mutate the model request to `bash`, `write_file`, an unknown MCP name, a budget change, and a fake Worker namespace; each request must be rejected without touching the Worker SQLite or Guild ledger.
- [ ] **Step 2: Run the harness in offline mode and observe missing service failures**
- [ ] **Step 3: Implement compose/Apple Container wiring and deterministic fixture services**
- [ ] **Step 4: Run the full offline acceptance suite and, only if a container runtime exists, the container suite**
- [ ] **Step 5: Commit `test(deerflow): add isolated runtime acceptance harness`**

### Task 6: Retire Codex-only production wiring after DeerFlow acceptance

**Files:**
- Modify: `ops/tiktok-worker/README.md`
- Modify: `ops/tiktok-worker/config/runtime.toml`
- Modify: `ops/tiktok-worker/launchd/com.guild-recruiter.supervisor.plist`
- Create: `ops/deerflow-guild-runtime/scripts/migrate-from-codex.mjs`
- Create: `ops/deerflow-guild-runtime/test/migrate-from-codex.test.mjs`

**Interfaces:**
- Migration script marks the existing macOS `tiktok-worker` LaunchAgent and runtime dormant; it never deletes the account, credentials, databases, or directories.
- DeerFlow scheduler replaces the Codex tick supervisor only after Task 5 passes; the same fixed bounded tick and lease/lock semantics are retained.

- [ ] **Step 1: Write failing migration tests proving no deletion and no service start**

  Create a temporary LaunchAgent plist and runtime directory, run migration in dry-run mode, and assert no `launchctl bootstrap`, deletion, or account mutation call is emitted; only a dormant marker is written.
- [ ] **Step 2: Implement a dry-run-first migration marker and operator confirmation gate**
- [ ] **Step 3: Run all ops tests plus the existing Guild/Worker suites**
- [ ] **Step 4: Commit `chore(deerflow): make Codex runtime dormant after acceptance`**

## Final Verification

- `cd ops/deerflow-guild-runtime && npm test`
- `cd ops/tiktok-worker && npm test`
- `cd /Users/yangyucheng/plugins/tiktok-recruiter-worker && npm test`
- `cd codex-rs && just test -p codex-guild-domain && just test -p codex-guild-memory && just test -p codex-guild-extension && just test -p codex-app-server guild_extension`
- `cd ops/deerflow-guild-runtime && node scripts/verify-manifest.mjs config/runtime-manifest.json`
- If a container runtime is available: run the isolated fixture acceptance; otherwise report that the container gate is pending and do not claim production readiness.
