# DeerFlow Native Guild Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在当前 Mac 上交付一个手动启停的 DeerFlow 公会招募 Lead，直接调用现有 Guild Operator 与 TKDesk，并用小型 Markdown 案件卡保留聊天判断和关系推进状态。

**Architecture:** 新增 `ops/deerflow-native-guild` 本机运行包，固定官方 DeerFlow commit，通过两个 stdio MCP 直连现有插件。一个 DeerFlow Skill 承载聊天、关系推进和证据规则；案件卡由受限 Node CLI 校验并原子写入 Git-ignored 运行目录，不增加数据库或常驻服务。

**Tech Stack:** DeerFlow `769589e8daee14c2587a634b6b43bd96471a41a1`, Node.js >=22.16, stdio MCP, Markdown + YAML, native macOS Chrome.

**Spec:** `docs/superpowers/specs/2026-09-23-deerflow-native-guild-agent-design.md`

## Global Constraints

- Production runs natively on the current Mac and is started and stopped manually.
- DeerFlow source is pinned to `769589e8daee14c2587a634b6b43bd96471a41a1` from `https://github.com/bytedance/deer-flow.git`.
- The only MCP servers are the existing Guild Operator and TKDesk stdio servers.
- Guild Operator remains read-only; TKDesk discovers, qualifies, deduplicates, and hands off candidates but never messages them.
- No Recruiter Worker, Rust Guild bridge, Guild ledger, projection database, noVNC, or production Docker dependency.
- TikTok messages, invitations, follows, comments, gifts, and other external writes are unavailable in phase one.
- Real creator data lives only under the Git-ignored runtime root and is never committed.
- One case file is at most 4096 UTF-8 bytes and never contains full chat history, credentials, cookies, tokens, verification codes, identity documents, or payment data.
- Rejection, opt-out, do-not-contact, and other boundaries survive every later update.
- `unknown`, `partial`, `not_proven`, and failed tool calls never become confirmed facts or completed actions.

---

### Task 1: Define the native runtime contract

**Files:**
- Create: `ops/deerflow-native-guild/package.json`
- Create: `ops/deerflow-native-guild/config/local-manifest.json`
- Create: `ops/deerflow-native-guild/config/extensions_config.json`
- Create: `ops/deerflow-native-guild/config/config.yaml`
- Create: `ops/deerflow-native-guild/src/constants.mjs`
- Create: `ops/deerflow-native-guild/src/runtime-config.mjs`
- Create: `ops/deerflow-native-guild/test/runtime-config.test.mjs`

**Interfaces:**
- `constants.mjs` exports `DEERFLOW_COMMIT`, `GUILD_TOOL_NAMES`, `GUILD_OPERATOR_ROOT`, `TKDESK_ROOT`, and `MCP_SERVER_NAMES`.
- `loadRuntimeConfig({ packageRoot })` reads the three versioned config files and returns normalized absolute paths.
- `validateRuntimeConfig(config, { exists, nodeVersion })` returns `{ valid: true, config }` or throws an actionable `Error`.

- [ ] **Step 1: Write the failing runtime contract tests**

  Cover the valid two-server config, an extra MCP server, a Worker/Rust command, a Guild write tool, a missing plugin path, Node below `22.16`, and a commit other than the pinned SHA.

  ```js
  test('accepts the direct two-plugin runtime', async () => {
    const config = await loadRuntimeConfig({ packageRoot: FIXTURE_ROOT });
    assert.deepEqual(validateRuntimeConfig(config, {
      exists: () => true,
      nodeVersion: '22.16.0'
    }).valid, true);
  });
  ```

- [ ] **Step 2: Run the focused test and confirm the missing-module failure**

  Run: `cd ops/deerflow-native-guild && node --test test/runtime-config.test.mjs`

  Expected: FAIL because `src/runtime-config.mjs` does not exist.

- [ ] **Step 3: Implement the literal runtime contract**

  `extensions_config.json` contains exactly:

  ```json
  {
    "mcpServers": {
      "guild_operator": {
        "enabled": true,
        "required": true,
        "type": "stdio",
        "command": "node",
        "args": ["/Users/yangyucheng/plugins/tiktok-live-guild-operator/src/server.mjs"],
        "cwd": "/Users/yangyucheng/plugins/tiktok-live-guild-operator",
        "tool_name_prefix": false,
        "enabled_tools": [
          "guild_workspace", "guild_creators", "guild_recruitment", "guild_messaging",
          "guild_operations", "guild_revenue", "guild_governance", "guild_intelligence"
        ]
      },
      "tkdesk": {
        "enabled": true,
        "required": true,
        "type": "stdio",
        "command": "/Users/yangyucheng/plugins/tkdesk-agent/scripts/launch_mcp",
        "args": [],
        "cwd": "/Users/yangyucheng/plugins/tkdesk-agent",
        "tool_name_prefix": false
      }
    }
  }
  ```

  Reject any server or enabled Guild tool outside this literal contract. Inspect TKDesk's declared catalog and reject names containing `send_message`, `send_invitation`, `follow`, `comment`, `gift`, or `publish` during acceptance.

- [ ] **Step 4: Add the local DeerFlow and manifest configuration**

  `local-manifest.json` records the official repository, pinned commit, absolute plugin roots, Git-ignored runtime root `.runtime`, cases path `.runtime/cases`, and skills path `skills`. `config.yaml` selects DeerFlow's local sandbox and points its database/checkpoint state inside `.runtime/deerflow`; it does not configure AIO/Docker.

- [ ] **Step 5: Run the contract test and commit**

  Run: `cd ops/deerflow-native-guild && npm test -- --test-name-pattern=runtime`

  Expected: PASS.

  Commit: `feat(deerflow): define native guild runtime`

### Task 2: Add bounded creator case files

**Files:**
- Create: `ops/deerflow-native-guild/src/case-schema.mjs`
- Create: `ops/deerflow-native-guild/src/case-files.mjs`
- Create: `ops/deerflow-native-guild/scripts/case.mjs`
- Create: `ops/deerflow-native-guild/test/case-files.test.mjs`
- Create: `ops/deerflow-native-guild/fixtures/cases/active-creator.json`
- Modify: `.gitignore`

**Interfaces:**
- `validateCaseRecord(value)` returns a normalized record or throws; unknown fields and invalid enums are rejected.
- `readCase(casesRoot, creatorId)` returns the parsed record or `null`.
- `writeCase(casesRoot, record)` writes `<creator_id>.md` through a same-directory temporary file and atomic rename, returning `{ path, bytes }`.
- `mergeCase(previous, next)` preserves existing boundary values and prevents `refused|opted_out` from returning to an active stage.
- `scripts/case.mjs get <creator_id>` prints JSON; `put <json-file>` validates and writes; `validate <case-file>` performs a read-only check.

- [ ] **Step 1: Write failing schema, size, isolation, and boundary tests**

  ```js
  test('an opt-out survives a later active-stage update', () => {
    const merged = mergeCase(optedOutRecord, { ...optedOutRecord, stage: 'replied', boundaries: [] });
    assert.equal(merged.stage, 'opted_out');
    assert.deepEqual(merged.boundaries, optedOutRecord.boundaries);
  });
  ```

  Also prove path traversal is rejected, two creator IDs never share a file, a 4097-byte serialization is rejected, full chat transcript fields and sensitive fields are rejected, and a failed rename leaves the old valid file intact.

- [ ] **Step 2: Run the focused tests and confirm failure**

  Run: `cd ops/deerflow-native-guild && node --test test/case-files.test.mjs`

  Expected: FAIL because the case modules do not exist.

- [ ] **Step 3: Implement the fixed schema and Markdown serialization**

  Use YAML front matter with the exact fields from the spec. Accepted stages, signals, sources, and next-action kinds are literal sets. The body contains only `last_interaction_summary`; the writer enforces 4096 bytes after serialization. Add `yaml` as the package's sole runtime dependency and commit its lockfile.

- [ ] **Step 4: Implement atomic storage and the CLI**

  Require creator IDs to match `/^[A-Za-z0-9._:-]{1,128}$/u`. Create the cases directory with mode `0700`, write the temporary file with mode `0600`, `fsync`, rename, then `fsync` the directory. The CLI defaults to the manifest's `.runtime/cases` and never accepts a different root from model-provided arguments.

- [ ] **Step 5: Ignore runtime data, run tests, and commit**

  Add `/ops/deerflow-native-guild/.runtime/` to `.gitignore`.

  Run: `cd ops/deerflow-native-guild && npm test -- --test-name-pattern=case`

  Expected: PASS.

  Commit: `feat(deerflow): add bounded creator cases`

### Task 3: Port the chat and relationship business skill from its original source

**Files:**
- Create: `ops/deerflow-native-guild/skills/public/guild-recruitment-lead/SKILL.md`
- Create: `ops/deerflow-native-guild/skills/public/guild-recruitment-lead/references/conversation-methods.json`
- Create: `ops/deerflow-native-guild/skills/public/guild-recruitment-lead/references/case-record.md`
- Create: `ops/deerflow-native-guild/skills/public/guild-recruitment-lead/references/source-lock.json`
- Create: `ops/deerflow-native-guild/fixtures/conversation-cases.json`
- Create: `ops/deerflow-native-guild/test/skill-contract.test.mjs`

**Interfaces:**
- Skill name: `guild-recruitment-lead`.
- It routes `respond|share|appreciate|playful|clarify|invite|repair|wait|close` to the four sourced method families.
- Its response contract is: `current_read`, `evidence`, `missing_evidence`, `recommended_action`, `draft`, `change_conditions`, `case_update`.
- `case_update` is omitted until a user-confirmed send, platform-observed reply/state, explicit operator correction, or pause/stop/opt-out instruction occurs.

- [ ] **Step 1: Write the failing skill contract tests**

  Assert the skill front matter is valid, all nine tasks are covered once, all five relationship dimensions exist, the exact eight Guild tool names are referenced, `guild_workspace` precedes guild-scoped calls, TKDesk handoff remains authoritative, and external write verbs are explicitly unavailable.

  Load the six original synthetic Wingman cases plus guild adaptations for `partial` history, explicit opt-out, unsupported benefit claim, and user-confirmed manual send. Assert every fixture declares required facts, forbidden inferences, expected action, and whether a case update is allowed.

- [ ] **Step 2: Run the focused test and confirm failure**

  Run: `cd ops/deerflow-native-guild && node --test test/skill-contract.test.mjs`

  Expected: FAIL because the skill package is absent.

- [ ] **Step 3: Create the source-locked method asset**

  Adapt directly from `codex-rs/ext/wingman/expert/methods.json`: replace dating goals and examples with creator recruitment while retaining evidence requirements, speaker mapping, no invented schedules/commitments, adjustment signals, stop conditions, and the four method IDs. `source-lock.json` records SHA-256 digests of the Wingman methods, original synthetic cases, guild source audit, Guild Operator skill, and TKDesk skill used for this port.

- [ ] **Step 4: Write the DeerFlow Skill and case reference**

  The Skill tells the Lead to read only the references needed for the task, call TKDesk for discovery/handoff, call `guild_workspace {}` before other Guild tools, label facts/inferences/missing evidence separately, create cases only after real communication begins, and write a complete case with DeerFlow `write_file` followed by `read_file` verification. Keep `allow_host_bash: false`; `scripts/case.mjs` remains an atomic operator/import tool rather than a model tool. It must state that drafting does not equal sending and that phase one has no external write tool.

- [ ] **Step 5: Run the skill contract tests and commit**

  Run: `cd ops/deerflow-native-guild && npm test -- --test-name-pattern=skill`

  Expected: PASS.

  Commit: `feat(deerflow): port guild relationship skill`

### Task 4: Add bootstrap, doctor, and manual start commands

**Files:**
- Create: `ops/deerflow-native-guild/src/process.mjs`
- Create: `ops/deerflow-native-guild/scripts/bootstrap.mjs`
- Create: `ops/deerflow-native-guild/scripts/doctor.mjs`
- Create: `ops/deerflow-native-guild/scripts/start.mjs`
- Create: `ops/deerflow-native-guild/test/bootstrap.test.mjs`
- Create: `ops/deerflow-native-guild/test/doctor.test.mjs`
- Create: `ops/deerflow-native-guild/README.md`

**Interfaces:**
- `npm run bootstrap` clones the official source into `.runtime/deer-flow`, checks out the pinned detached commit, and runs the pinned upstream install command.
- `npm run doctor` checks Node, Git, plugin roots, executable TKDesk launcher, Guild package dependencies, pinned DeerFlow HEAD, config validity, cases permissions, and MCP `initialize`/`tools/list` without opening a real TikTok page.
- `npm start` runs doctor, exports `DEER_FLOW_CONFIG_PATH`, `DEER_FLOW_EXTENSIONS_CONFIG_PATH`, `DEER_FLOW_SKILLS_PATH`, and `DEER_FLOW_HOME`, then replaces itself with upstream `make start` in the pinned checkout.

- [ ] **Step 1: Write failing bootstrap and doctor tests with injected process runners**

  Prove bootstrap rejects floating refs, non-official remotes, non-empty foreign checkouts, and a resolved HEAD mismatch. Prove doctor reports each failed check by name and never starts DeerFlow when a required check fails.

- [ ] **Step 2: Run the focused tests and confirm failure**

  Run: `cd ops/deerflow-native-guild && node --test test/bootstrap.test.mjs test/doctor.test.mjs`

  Expected: FAIL because the command modules do not exist.

- [ ] **Step 3: Implement idempotent pinned bootstrap**

  Reuse the validated official repository and full SHA rules from the old fixture package, but place all downloaded source and dependency caches under `.runtime`. A second run at the same commit succeeds without recloning; any other HEAD fails with the exact recovery command and does not delete user data.

- [ ] **Step 4: Implement doctor and MCP catalog probes**

  Start each stdio server separately, send MCP `initialize` and `tools/list`, collect bounded JSON, then close it. Validate the eight Guild names exactly. For TKDesk, require `prepare_handoff` and `commit_handoff`, and reject messaging/publishing names. Do not call a live business tool in doctor.

- [ ] **Step 5: Implement manual startup and operator README**

  Document these commands:

  ```sh
  cd /Users/yangyucheng/Documents/ChatGPT/妹子攻略计划/ops/deerflow-native-guild
  npm install
  npm run bootstrap
  npm run doctor
  npm start
  ```

  Explain native Chrome login, manual `Ctrl-C` stop, case location, read-only phase, and the first safe prompt to run.

- [ ] **Step 6: Run command tests and commit**

  Run: `cd ops/deerflow-native-guild && npm test -- --test-name-pattern='bootstrap|doctor'`

  Expected: PASS.

  Commit: `feat(deerflow): add native guild launcher`

### Task 5: Accept the direct path and retire the old production instructions

**Files:**
- Create: `ops/deerflow-native-guild/scripts/acceptance.mjs`
- Create: `ops/deerflow-native-guild/test/acceptance.test.mjs`
- Create: `ops/deerflow-native-guild/fixtures/mcp/guild-tools.json`
- Create: `ops/deerflow-native-guild/fixtures/mcp/tkdesk-tools.json`
- Modify: `ops/deerflow-guild-runtime/README.md`
- Modify: `docs/superpowers/plans/2026-09-22-deerflow-guild-runtime-migration.md`

**Interfaces:**
- `npm run acceptance` runs offline config, case, skill, bootstrap, doctor-fixture, and MCP catalog checks; it never calls a TikTok business tool or external write.
- The old runtime README begins with a retirement notice pointing to the new package and states its Docker commands are historical fixture commands only.
- The old implementation plan records that `2026-09-23-deerflow-native-guild-agent.md` supersedes it.

- [ ] **Step 1: Write the failing acceptance test**

  Assert one Lead skill, two MCP servers, eight read-only Guild tools, required TKDesk handoff tools, no messaging/publishing tools, one synthetic case round trip across a process restart, no Docker command in the new README, and no reference to Recruiter Worker/Rust bridge/Guild ledger in the new runtime config.

- [ ] **Step 2: Run acceptance and confirm failure**

  Run: `cd ops/deerflow-native-guild && node --test test/acceptance.test.mjs`

  Expected: FAIL until the acceptance script and retirement notices exist.

- [ ] **Step 3: Implement offline acceptance and retirement notices**

  Store bounded tool-catalog snapshots from the actual stdio probes. Compare names and schemas on every run so plugin drift fails clearly. Mark the old production instructions superseded without deleting historical code, profiles, databases, or fixture evidence.

- [ ] **Step 4: Run the package acceptance**

  Run: `cd ops/deerflow-native-guild && npm run acceptance`

  Expected: PASS with two MCP catalogs, one skill, and one synthetic case restart.

- [ ] **Step 5: Perform the local read-only handoff**

  Start DeerFlow with `npm start`. Confirm the UI loads, the Lead sees `guild-recruitment-lead`, Guild Operator, and TKDesk. If either plugin requests login, stop at the native Chrome window for the user. After login, run only `guild_workspace {}` plus one bounded Guild read and one TKDesk status/handoff read. Do not send, invite, follow, comment, gift, or publish.

- [ ] **Step 6: Commit the accepted native runtime**

  Commit: `chore(deerflow): retire layered guild runtime`

## Final Verification

- `cd ops/deerflow-native-guild && npm run acceptance`
- `cd /Users/yangyucheng/plugins/tiktok-live-guild-operator && npm test`
- `cd /Users/yangyucheng/plugins/tkdesk-agent && npm test`
- `git status --short` contains no real creator case, credentials, plugin profile, or `.runtime` file.
- The only remaining interactive step is native TikTok login when the existing plugin opens Chrome.
