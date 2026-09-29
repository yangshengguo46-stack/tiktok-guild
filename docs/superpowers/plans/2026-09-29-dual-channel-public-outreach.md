# Dual-Channel Public Outreach Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Add two execution channels for the same DeerFlow creator-outreach workflow: Playwright for ordinary TikTok web accounts and Appium/XCUITest for iPhones, while keeping one native claim, sender, task, and receipt model.

**Architecture:** DeerFlow remains the only business control plane and source of creator claims, sequences, tasks, states, and verified receipts. A versioned `public-outreach-operator` runtime owns execution only; it exposes a web channel backed by one persistent Playwright profile per ordinary account and an iPhone channel backed by Appium XCUITest sessions. Broker Operator continues to represent the guild Backstage channel and is not reused as the ordinary-account pool.

**Tech Stack:** DeerFlow native SQLAlchemy/Alembic persistence, FastAPI gateway, React/Next workbench, Node.js 22, Playwright persistent contexts, Appium 3 XCUITest driver, signed WebDriverAgent on macOS, pytest, Node test runner.

**Spec:** Existing contract in `.agents/ledger/2026-09-24-deerflow-social-runtime.md`, especially the `gray → public_touched → contacted → replied → closed` sequence, global `(owner_user_id, creator_uid)` claim, fixed `sender_account_id`, and verified receipt requirement.

## Global Constraints

- DeerFlow native persistence is the only business ledger; do not create a sidecar CRM, second claim store, or new development manual.
- TKDesk remains authoritative for candidate discovery and handoff; Guild Operator remains authoritative for guild Backstage facts; Broker Operator remains the isolated Backstage messaging channel.
- Ordinary TikTok accounts may execute public outreach; a sender account is fixed to one sequence and must be the same account for the public actions and any subsequent direct message.
- Required public sequence is `like → comment → follow`; `public_touched` advances only after verified receipts for the configured action set.
- Account rotation is a resource scheduler. Do not add proxy rotation, fingerprint spoofing, CAPTCHA bypass, or “human-like” evasion behavior.
- A provider read-back or an explicit unknown result is required. UI presence, a chat bubble, a draft, or a clicked button is not a verified receipt.
- CI and default acceptance tests never perform TikTok writes. Real-provider validation is a separately authorized, single-account pilot.
- The initial web pool contains up to 50 persisted profiles with a maximum of 10 active profiles per scheduling batch. The initial iPhone pool is one real iPhone per active account; simulators are test-only.

---

### Task 1: Extend the native sender and action contract

**Files:**
- Modify: `backend/packages/harness/deerflow/persistence/creator_agent_relationship/model.py`
- Modify: `backend/packages/harness/deerflow/persistence/creator_agent_relationship/outreach.py`
- Create: `backend/packages/harness/deerflow/persistence/migrations/versions/0029_outreach_sender_accounts.py`
- Create: `backend/packages/harness/deerflow/persistence/migrations/versions/0030_outreach_action_tasks.py`
- Test: `backend/tests/test_creator_outreach_channels.py`

**Interfaces:**
- `SenderAccountRow`: `(owner_user_id, sender_account_id)` primary key; fields `channel` (`web` or `ios`), `external_ref`, `profile_ref`, `device_ref`, `status`, `capabilities_json`, `last_health_at`, `created_at`, and `updated_at`.
- `CreatorOutreachActionTaskRow`: `(task_id)` primary key; fields `owner_user_id`, `creator_uid`, `sequence_no`, `sender_account_id`, `action` (`like`, `comment`, `follow`, `message`), `idempotency_key`, `state`, `payload_json`, `attempt_count`, `lease_until`, `receipt_id`, `error_code`, `created_at`, and `updated_at`.
- Repository methods: `register_sender_account`, `list_sender_accounts`, `enqueue_action`, `claim_action`, `complete_action`, `fail_action`, `release_expired_action_leases`, and `read_action_task`.

- [x] **Step 1: Write failing repository tests** for sender registration idempotency, channel validation, 50-profile registration, a maximum active batch of 10, action idempotency, lease expiry, and rejection of a task whose sender differs from the active sequence sender.
- [x] **Step 2: Run the focused tests and verify they fail** with missing model/method errors.
- [x] **Step 3: Add the two SQLAlchemy rows and migrations** without modifying already-applied migration files. Add unique constraints for `(owner_user_id, sender_account_id)`, `(owner_user_id, idempotency_key)`, and one active task per `(owner_user_id, creator_uid, sequence_no, action)`.
- [x] **Step 4: Implement repository methods** using the existing bounded-string and JSON-size validation style in `outreach.py`. `claim_action` must acquire a lease atomically; `complete_action` must require the task’s sender and idempotency key.
- [x] **Step 5: Run `pytest backend/tests/test_creator_outreach_channels.py -q`** and the existing `pytest backend/tests/test_creator_outreach_repository.py -q` suite.
- [x] **Step 6: Commit only the new contract files** with `git add` limited to the listed paths; preserve existing user and historical changes in the working tree.

### Task 2: Create the versioned public-outreach operator shell

**Files:**
- Create: `ops/guild-runtime/public-outreach-operator/package.json`
- Create: `ops/guild-runtime/public-outreach-operator/src/contracts.mjs`
- Create: `ops/guild-runtime/public-outreach-operator/src/router.mjs`
- Create: `ops/guild-runtime/public-outreach-operator/src/server.mjs`
- Modify: `ops/guild-runtime/config/extensions_config.guild.json`
- Modify: `ops/guild-runtime/src/mcp-catalog.mjs`
- Modify: `ops/guild-runtime/test/mcp-catalog.test.mjs`
- Create: `ops/guild-runtime/public-outreach-operator/test/router.test.mjs`

**Interfaces:**
- `public_outreach_accounts` children: `list`, `register`, `health`, `disable`.
- `public_outreach_tasks` children: `enqueue`, `get`, `claim`, `execute`, `complete`, `fail`, `reconcile`. Native execution owns claims; `claim` cannot start platform actions, and `complete` cannot accept caller receipts.
- Every tool result includes `task_id`, `sender_account_id`, `channel`, `creator_uid`, `action`, `idempotency_key`, and a completeness status.

- [x] **Step 1: Write router and catalog contract tests** for initialize, tools/list, unknown tools, malformed arguments, and fail-closed behavior when the operator is unconfigured.
- [x] **Step 2: Add the operator package** with pinned Node/Playwright/Appium dependencies and a stdio JSON-RPC server matching the existing plugin server shape.
- [x] **Step 3: Add the MCP server entry** to `extensions_config.guild.json` and the expected tool fixture/catalog tests. Do not widen existing Broker or TKDesk allowlists.
- [x] **Step 4: Implement account and task handlers** as thin adapters over the native DeerFlow repository contract; the operator must not create a second business database.
- [x] **Step 5: Run `npm test` inside the operator package and `npm test -- --test-name-pattern='mcp|catalog'` in `ops/guild-runtime`**.
- [ ] **Step 6: Run `npm run doctor` and `npm run acceptance`** from `ops/guild-runtime`; expected result is a catalog that lists the new operator without starting a browser or device.

### Task 3: Implement the Playwright ordinary-account pool

**Files:**
- Create: `ops/guild-runtime/public-outreach-operator/src/web/profile-registry.mjs`
- Create: `ops/guild-runtime/public-outreach-operator/src/web/playwright-pool.mjs`
- Create: `ops/guild-runtime/public-outreach-operator/src/web/tiktok-web-executor.mjs`
- Create: `ops/guild-runtime/public-outreach-operator/src/web/page-objects.mjs`
- Create: `ops/guild-runtime/public-outreach-operator/test/web-pool.test.mjs`
- Create: `ops/guild-runtime/public-outreach-operator/test/web-executor.test.mjs`

**Interfaces:**
- `createPlaywrightPool({ maxActive = 10, profileRoot, launchPersistentContext })` returns `register`, `health`, `claim`, `release`, and `close`.
- `executeWebAction({ account, creator, action, payload, signal })` returns `{ provider_ref, receipt_payload, verification_source, verified }` or an explicit `{ verified: false, error_code }`.
- `page-objects.mjs` contains versioned locators for creator search, profile, like, comment, follow, and message surfaces; selectors never live in the scheduler.

- [x] **Step 1: Write fake-browser tests** for 50 registered profiles, 10 active leases, same-profile exclusivity, clean close/reopen, expired lease recovery, and no cross-profile storage access.
- [x] **Step 2: Implement the profile registry** with one persistent `userDataDir` per ordinary account and a filesystem lock. Reject a second active owner for the same profile.
- [x] **Step 3: Implement the 10-slot pool scheduler**. It must select only `enabled` and `healthy` accounts, return `capacity_exhausted` when all slots are leased, and close contexts after a batch without deleting login storage.
- [x] **Step 4: Implement the web page objects** for the ordered `like`, `comment`, and `follow` actions, plus the optional `message` action. Every action must verify the post-action UI/read-back state before returning a verified receipt.
- [x] **Step 5: Add explicit handling for login-required, challenge, selector-missing, provider-rejected, and unknown states**. These states pause the account and create a manual-takeover task; they must never be reported as success.
- [x] **Step 6: Run the fake-browser test suite** with no network access. Keep real TikTok selectors behind the operator’s separately authorized pilot flag.

### Task 4: Implement the iPhone Appium/XCUITest channel

**Files:**
- Create: `ops/guild-runtime/public-outreach-operator/src/ios/device-registry.mjs`
- Create: `ops/guild-runtime/public-outreach-operator/src/ios/xcuitest-session.mjs`
- Create: `ops/guild-runtime/public-outreach-operator/src/ios/tiktok-ios-executor.mjs`
- Create: `ops/guild-runtime/public-outreach-operator/src/ios/wda-health.mjs`
- Create: `ops/guild-runtime/public-outreach-operator/test/ios-executor.test.mjs`
- Create: `docs/verification/creator-agent/ios-public-outreach-pilot.md`

**Interfaces:**
- `registerDevice({ device_ref, udid, platform_version, wda_bundle_id })` records a real iPhone and its health state.
- `createXcuitestSession({ device, bundle_id: 'com.zhiliaoapp.musically', noReset: true })` returns a session lease with `launch`, `find`, `tap`, `type`, `screenshot`, and `close`.
- `executeIosAction({ device, account, creator, action, payload, signal })` returns the same receipt envelope as the web executor.

- [x] **Step 1: Write fake-driver tests** for device registration, one active session per device, WDA unavailable, locked device, app launch failure, cancellation, screenshot-on-failure, and manual takeover.
- [x] **Step 2: Implement the device registry and health checks**. Require macOS/Xcode/WDA prerequisites and record `paired`, `ready`, `busy`, `offline`, and `manual_required` states.
- [x] **Step 3: Implement the XCUITest session adapter** using accessibility identifiers and visible text, with no coordinate-only actions unless a locator evidence record is attached.
- [x] **Step 4: Implement the iPhone action executor** for the same ordered public action contract. Persist a screenshot and accessibility snapshot for unknown or failed actions, never as proof of success by itself.
- [x] **Step 5: Add the single-iPhone pilot runbook**: pair and trust one device, sign WebDriverAgent, log into one ordinary account manually, run one creator task, verify each action, then close the session cleanly.
- [x] **Step 6: Run the fake-driver tests** on every platform and reserve real-device validation for the pilot checklist.

### Task 5: Connect both channels to the shared outreach sequence

**Files:**
- Modify: `backend/packages/harness/deerflow/persistence/creator_agent_relationship/outreach.py`
- Create: `backend/packages/harness/deerflow/creator_agent/public_outreach.py`
- Modify: `backend/tests/test_creator_outreach_repository.py`
- Create: `backend/tests/test_public_outreach_workflow.py`

**Interfaces:**
- `create_public_outreach_tasks(owner_user_id, creator_uid, sequence_no, sender_account_id, actions)` creates the ordered action tasks and rejects a sender mismatch.
- `record_public_action_result(task_id, receipt)` persists the receipt and advances `gray → public_touched` only when `like`, `comment`, and `follow` are all verified for the same sender and action group.
- `record_message_result(task_id, receipt)` advances `public_touched → contacted` only for a verified `dm_receipt` from the same sender account.

- [x] **Step 1: Add failing workflow tests** for web execution, iPhone execution, mixed-channel rejection for one sequence, partial public completion, verified aggregate completion, duplicate task delivery, and reply handling.
- [x] **Step 2: Implement the workflow service** as a channel-neutral coordinator that calls the operator tools and writes receipts through `CreatorOutreachRepository`.
- [x] **Step 3: Enforce sender continuity**: `web:account_001` and `ios:device_001:account_001` are different sender identities unless explicitly linked before task creation; a sequence cannot silently switch channels.
- [x] **Step 4: Preserve the existing chat-bubble rule**: bubbles and drafts never advance state and never suppress a real verified inbound reply.
- [x] **Step 5: Run the focused workflow and existing outreach tests**. Expected result is zero real provider calls and explicit unknown states for missing receipts.

### Task 6: Add the control-plane API and workbench surface

**Files:**
- Create: `backend/app/gateway/routers/public_outreach.py`
- Modify: `backend/app/gateway/app.py`
- Create: `frontend/src/app/workspace/guild/public-outreach/page.tsx`
- Create: `frontend/src/components/workspace/guild/public-outreach-account-pool.tsx`
- Create: `frontend/src/components/workspace/guild/public-outreach-task-list.tsx`
- Create: `frontend/src/components/workspace/guild/public-outreach-receipts.tsx`
- Modify: `frontend/src/app/workspace/guild/page.tsx`
- Modify: `frontend/src/core/i18n/locales/zh-CN.ts`
- Modify: `frontend/src/core/i18n/locales/en-US.ts`
- Create: `frontend/tests/e2e/public-outreach-workbench.spec.ts`

**Interfaces:**
- `GET /api/public-outreach/accounts` returns account/device health and channel capabilities.
- `POST /api/public-outreach/tasks` creates a task only for an existing claim and fixed sender sequence.
- `GET /api/public-outreach/tasks/{task_id}` returns task state, current action, receipt state, and manual-takeover reason.
- `POST /api/public-outreach/tasks/{task_id}/retry` retries only an explicit unknown or recoverable failure; it never duplicates a verified action.

- [x] **Step 1: Add API contract tests** for owner isolation, claim requirement, sender mismatch, account health, task creation, retry authorization, and redaction of profile paths and credentials.
- [x] **Step 2: Register the FastAPI router** with existing auth and admin checks; return `503` when the operator is not configured instead of fabricating readiness.
- [x] **Step 3: Replace the current guild placeholder** with a small public-outreach panel showing account pools, web batch capacity, iPhone readiness, task state, and receipt evidence.
- [x] **Step 4: Add manual controls** for pause account, resume account, request takeover, mark provider unknown, and close a sequence with a closure receipt.
- [x] **Step 5: Add Chinese and English translations** and the Playwright E2E test with a mocked gateway; no external TikTok page is opened by CI.

### Task 7: Add runtime wiring, diagnostics, and operator documentation

**Files:**
- Modify: `ops/guild-runtime/src/runtime-environment.mjs`
- Modify: `ops/guild-runtime/src/mcp-catalog.mjs`
- Modify: `ops/guild-runtime/scripts/doctor.mjs`
- Modify: `ops/guild-runtime/scripts/acceptance.mjs`
- Modify: `ops/guild-runtime/README.md`
- Modify: `.agents/coordination.md`
- Modify: `.agents/ledger/2026-09-24-deerflow-social-runtime.md`

- [x] **Step 1: Add non-secret configuration** for `PUBLIC_OUTREACH_OPERATOR_ROOT`, `PUBLIC_OUTREACH_PROFILE_ROOT`, `PUBLIC_OUTREACH_MAX_ACTIVE=10`, and the iPhone WDA settings. Credentials and session data remain outside Git.
- [x] **Step 2: Extend doctor checks** for operator package, Playwright dependency, Appium/XCUITest availability, profile-root permissions, and registered-device readiness. Doctor must remain read-only.
- [x] **Step 3: Extend acceptance checks** with fake adapters and catalog counts. Acceptance must not launch a real browser, attach an iPhone, or write to TikTok.
- [x] **Step 4: Update the existing coordination entry and ledger only** with the new channel contract, verification gates, and rollout evidence; do not create another ledger or manual.
- [x] **Step 5: Document recovery** for profile locks, expired sessions, WDA failure, device offline, unknown provider result, and manual takeover.

### Task 8: Run the staged verification and pilot

**Files:**
- Create: `docs/verification/creator-agent/2026-09-29-dual-channel-public-outreach-evidence.md`
- Modify: `docs/verification/creator-agent/capability-matrix.md`

- [ ] **Step 1: Run static and unit verification**: backend focused tests, operator Node tests, frontend type/check tests, `npm run doctor`, and `npm run acceptance`.
- [x] **Step 2: Run a local fake 50-profile/10-slot stress test** and record peak memory, peak CPU, lease recovery time, and task throughput without platform traffic.
- [ ] **Step 3: Run one authorized web pilot** with one ordinary account and one creator; collect verified like/comment/follow receipts and stop after the first message decision.
- [ ] **Step 4: Run one authorized iPhone pilot** with one real iPhone and one ordinary account; collect the same receipts and record WDA/session recovery behavior.
- [ ] **Step 5: Compare both receipt streams** in the workbench and confirm they produce the same DeerFlow read model. Any missing provider read-back remains `unverified-external`.
- [ ] **Step 6: Expand to 10 web accounts only after the single-account pilot passes**. Add the remaining profiles in batches; do not enable 50 accounts until the 10-slot stress evidence and manual takeover path pass.
- [x] **Step 7: Append the verified local evidence to the existing ledger** and stop all locally started verification processes. Real pilot evidence and its process cleanup remain outstanding with Steps 3–6.

## Execution checkpoint (2026-09-30 CST)

Task 1–7 checkmarks cover committed software and offline contract evidence, not actual TikTok selectors, accounts or iPhone readiness. Production integration is `75318ad4f`; the first bounded repair is `e05f83ae9`, and the independent review's two residual terminal gaps were repaired in `d4fd1444a` with scoped independent verdict **CLEAN**. Gateway owns a managed Node executor; the shipped MCP adapter uses the native authenticated HTTP API. Default external writes are disabled. Only explicit execution of a stored task may act after the exact owner/sender/creator/action pilot allowlist admits it; messages require separate permission.

Root checks at `d4fd1444a`: backend focused 124 passed, operator 71 passed, actual-auth native MCP HTTP/SQLite smoke passed without starting a provider. Runtime focused 41 and static doctor passed at the unchanged runtime source in `e05f83ae9`; frontend has no source change since `75318ad4f`, where lint/types/build, mocked E2E 1 and execute UI 3 cases passed. Parent static acceptance is 128 passed / 1 failed: worker helper discovery was fixed; the historical nginx log assertion remains outside this batch. Step 2.6 and Step 8.1 stay unchecked until complete acceptance is green. Actual anonymous Playwright/Chromium resource drill confirmed that after Node hard death, a detached Chromium process cannot make its expired profile reclaimable; `profile_cleanup_required` and the ownership lock remained. No TikTok navigation occurred.

Task 8 local stress and contract parity do not complete its real pilots. Current deployment DB remains at `0026_social_runtime`; no real iPhone is registered. Actual sender/creator and fresh-item readback mappings remain unverified. Web/iPhone pilots, live receipt comparison and ten-account expansion stay unchecked. Do not start a second ledger or manual.

The final scoped reviewer replayed the earlier three failure observations as positive assertions at `d4fd1444a`: stale ordinary payload update is rejected and cannot erase a dispatched fence; expiry requires manual review and refuses blind claim; FOLLOW and DM reach both the correct claim and sequence status after terminal cancellation while retaining proof and submitting to the provider only once. The independent narrow suite was 20 passed. This closes local software findings, not Step 8's external pilots or the historical nginx acceptance failure.

2026-09-30 Web 登录预检：打开独立 Playwright Chromium 的 TikTok 登录页供用户手动登录后，用户反馈“访问频繁”。已立即关闭窗口、释放锁、禁用该本地资源；未执行 Task 8 的公开动作/私信。平台原因没有证据，暂停这条登录试跑路径，不反复尝试或规避提示。Step 8.3 保持 unchecked；详见既有台账与证据。

## Acceptance Criteria

- A single creator claim has at most one active sender sequence, regardless of whether the sender is web or iPhone.
- The same sender account executes the required public action set and any subsequent message.
- A verified `public_action_receipt` contains separate evidence for `like`, `comment`, and `follow`; partial completion remains actionable and does not advance the claim.
- A verified `dm_receipt` is required for `contacted`; a chat bubble, draft, or page navigation cannot advance it.
- Fifty web profiles can be registered, ten can be leased at once, and profile locks prevent duplicate browser ownership.
- An iPhone session reports explicit readiness, failure, or manual takeover; it never reports success from a screenshot alone.
- The workbench displays account/device state, task state, receipt evidence, and unknown/manual states without exposing credentials or profile paths.
- CI, doctor, and acceptance remain external-write-free; only the separately authorized pilot can touch TikTok.

## Execution Order

Tasks 1 and 2 establish the shared contract and runtime shell. Tasks 3 and 4 can then proceed in parallel as web and iPhone workstreams. Task 5 integrates both streams into the DeerFlow sequence. Task 6 exposes the control plane, Task 7 wires diagnostics and the existing ledger, and Task 8 performs staged verification and rollout.
