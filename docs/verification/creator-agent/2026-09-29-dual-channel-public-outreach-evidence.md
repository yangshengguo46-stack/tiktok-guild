# Dual-channel public outreach staged verification

Date: 2026-09-29

Repository revision: `e1eeddbff` (`fix: gate outreach on registered xcuitest driver`)

This evidence records the local verification boundary for the Web Playwright
and iPhone Appium/XCUITest public outreach channels. No TikTok account, device,
browser session, WDA session, provider catalog, or provider write was used by
this run. The two real pilots remain `unverified-external`.

## Decision

The local control plane and both executor contracts are ready for a separately
authorized one-account pilot. Rollout is not approved from this evidence alone.
The single Web pilot and single iPhone pilot were not run, so the staged gate
for expanding to ten Web accounts and eventually fifty registered profiles
remains closed.

One backend lease regression also remains open: the focused persistence run
reproduces a failure when a reclaimed SQLite action lease is completed with the
new owner's token. This is a Task 1 contract defect and blocks calling the
backend focused suite green.

## Static and unit verification

| Area | Command or evidence | Result | Boundary |
| --- | --- | --- | --- |
| Backend outreach/persistence | `backend/.venv/bin/pytest -q backend/tests/test_creator_outreach_channels.py backend/tests/test_creator_outreach_repository.py backend/tests/test_public_outreach_workflow.py backend/tests/test_public_outreach_api.py backend/tests/test_persistence_bootstrap.py backend/tests/test_persistence_migrations_env.py` | `81 passed, 1 failed` | The failing test is `test_action_claim_lease_expiry_and_completion_identity`; see the lease defect below. |
| Operator package | `cd ops/guild-runtime/public-outreach-operator && npm ci --ignore-scripts && npm test` | `43 passed` | Installs the pinned local dependencies only; no browser, iPhone, WDA, or TikTok write starts. `npm audit` reported dependency advisories and was not auto-fixed. |
| Runtime package | `cd ops/guild-runtime && npm test` | `99 passed, 1 failed` | The only failure is the retained historical nginx log assertion. |
| Static doctor | `cd ops/guild-runtime && npm run doctor -- --static` after operator `npm ci --ignore-scripts` | Static checks passed | Doctor verified package metadata, Playwright `1.59.1`, Appium `3.1.0`, XCUITest `12.13.3`, profile-root parent permissions, runtime config, catalog, and driver registration. It reported zero registered iPhones, so the live WDA pilot remains unavailable. |
| Static acceptance | `cd ops/guild-runtime && npm run acceptance -- --static` | Runtime checks passed; suite `99 passed, 1 failed` | Acceptance used fake adapters and catalog probes. It did not launch a browser, attach an iPhone, start WDA, or write to TikTok. |
| Frontend lint | `cd frontend && node_modules/.bin/eslint <public outreach workbench files>` | Passed | Direct ESLint invocation avoids the pnpm dependency-install guard. |
| Frontend types | `cd frontend && node_modules/.bin/tsc --noEmit` | Passed | Type checking only. |
| Frontend build | `cd frontend && SKIP_ENV_VALIDATION=1 DEER_FLOW_AUTH_DISABLED=1 node_modules/.bin/next build` | Passed | Production build completed successfully. |
| Workbench E2E | `cd frontend && PLAYWRIGHT_SKIP_WEB_SERVER=1 PLAYWRIGHT_BASE_URL=http://localhost:3000 node_modules/.bin/playwright test tests/e2e/public-outreach-workbench.spec.ts --config=playwright.config.ts` with a temporary local Next server | `1 passed` | All API routes were mocked. The test covers account state, task state, receipt evidence, retry, takeover, unknown, and closure controls; it never reaches TikTok. |

The first `pnpm check` attempt was stopped by pnpm's ignored-build approval
guard for `esbuild` and `unrs-resolver`. That command also wrote a temporary
placeholder `allowBuilds` block; the file was restored before this evidence was
committed. Direct ESLint, TypeScript, Next build, and mocked E2E checks are the
reproducible frontend evidence.

## Historical failure boundary

The runtime suite still fails:

```text
test/nginx-log.test.mjs
local nginx log directives use the launcher streams instead of opening unbounded files
actual:   nginx-access.log, nginx-error.log
expected: []
```

This assertion is unchanged by the dual-channel outreach implementation and is
outside Task 8's evidence-only scope. It must be repaired in the existing nginx
runtime ownership before the full runtime suite can be called green.

The focused backend failure is different and is actionable for the outreach
implementation. It reproduces in three consecutive runs:

```text
test_action_claim_lease_expiry_and_completion_identity
ValueError: action task lease is stale or expired
```

The test successfully reclaims the expired lease as `worker-b`, but the final
completion update does not match the row's persisted lease expiry in SQLite.
No production workaround was added in Task 8; the owner of the persistence
contract must fix and re-run this test before declaring the sequence ready.

## Local fake 50-profile / 10-slot stress

The stress run used `createProfileRegistry` and `createPlaywrightPool` with a
temporary directory, a fake persistent-context launcher, and a deterministic
clock. It did not open a browser or make network requests.

| Metric | Result |
| --- | ---: |
| Profiles registered | 50 |
| Concurrent leases at capacity | 10 |
| 51st registration | Rejected with `profile_limit_exceeded` |
| Capacity rejection | `capacity_exhausted` |
| Stale leases recovered and replacement claimed | Yes |
| Lease recovery time | 4.255 ms |
| Peak resident set | 46.17 MiB |
| Process CPU / wall time | 122.05% over 156.059 ms |
| Synthetic profile registration throughput | 320.39 profiles/s |
| Fake launch count | 11, including one replacement after recovery |

These are local fake-runtime measurements on one host. They are useful for
lock, cap, and recovery behavior only; they do not estimate TikTok throughput,
rate limits, detection risk, or provider latency.

## Receipt parity

The Web and iPhone executor tests both produce the shared receipt envelope for
the ordered `like -> comment -> follow` workflow and optional message step.
The contract requires:

- separate evidence for `like`, `comment`, and `follow`;
- provider read-back before `verified: true`;
- `public_action_receipt` before `public_touched`;
- a verified `dm_receipt` from the same sender before `contacted`;
- partial, unknown, draft, chat-bubble, screenshot-only, or navigation-only
  outcomes to remain actionable and never advance the relationship.

The workflow tests cover Web, iPhone, mixed-channel sender rejection, partial
completion, aggregate receipts, duplicate delivery, verified inbound reply, and
manual takeover. The workbench E2E displays the same receipt fields in the
DeerFlow UI using mocked responses.

There is no live provider receipt stream to compare. Therefore a claim that
Web and iPhone produced the same real DeerFlow read model remains
`unverified-external`; local executor parity is `verified-local`.

## Pilot gates

### Web pilot

Status: `unverified-external`, not run.

Required before running:

- one explicitly authorized ordinary TikTok account and one creator UID;
- one registered Web sender and a visible persistent profile;
- current creator identity read-back;
- no existing lease for the profile;
- operator health `enabled/healthy`;
- an evidence destination with restricted local access.

Stop immediately on `login_required`, challenge, selector/provider error,
unknown result, missing creator read-back, missing provider read-back, or
manual takeover. Stop before the first message decision unless the separate
pilot authorization includes messaging. Never retry an action with a verified
receipt.

### iPhone pilot

Status: `unverified-external`, not run.

Required before running:

- one paired and unlocked physical iPhone;
- signed WebDriverAgent and registered bundle ID;
- Appium and pinned XCUITest driver installed;
- exactly one registered device with a live probe returning
  `ready=true`, `device_verified=true`, and `wda_verified=true`;
- one ordinary TikTok account logged in manually;
- no active device session lease.

Stop on `wda_unavailable`, `device_locked`, `device_offline`,
`device_unpaired`, `app_launch_failed`, `selector_missing`,
`locator_evidence_required`, `pilot_required`, or `unknown`. Screenshots and
accessibility snapshots are diagnostic evidence only and cannot prove a
receipt. Close the session and verify the device returns to `ready` after the
pilot.

### Expansion to ten and fifty Web profiles

Expansion is blocked until both single-account pilot gates pass and the
manual-takeover path is exercised. The local fake stress proves the hard
50-profile/10-active-slot limits and profile exclusivity; it does not authorize
ten-account activity or platform traffic. Any missing external read-back keeps
the capability at `unverified-external`.

## Cleanup

The temporary Next server was stopped after the mocked E2E. The operator
dependency directory created by `npm ci --ignore-scripts` was removed before
the Task 8 commit. No pilot process, browser, WDA session, iPhone session,
credential, cookie, profile path, screenshot, or provider payload was added to
the repository.

