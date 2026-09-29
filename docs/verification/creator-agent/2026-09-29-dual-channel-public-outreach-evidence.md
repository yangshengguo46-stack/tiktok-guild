# Dual-channel public outreach staged verification

Date: 2026-09-29; production verification refreshed 2026-09-30 CST

Historical verification revision: `477a67d0a` (`test: fix outreach lease test clock`)

Latest implementation revision: `d4fd1444a1277583387ccb8cb69e690ccda360e9`.
The hardening review at `02521d405` and production review at `75318ad4f` were
**NOT CLEAN**. The first repair was `e05f83ae9`; its scoped review found two
remaining terminal-boundary gaps. They were repaired in `d4fd1444a` with a
scoped **CLEAN** verdict. The historical table below is not current-head
acceptance; the refreshed evidence is recorded at the end.

This evidence records the local verification boundary for the Web Playwright
and iPhone Appium/XCUITest public outreach channels. No TikTok account, physical
iPhone, live WDA session or platform write was used. The refreshed verification
used local Chromium for mocked UI checks and an anonymous blank-page resource
drill. The two real pilots remain `unverified-external`.

## Decision

The software is not yet ready for a live pilot. Production wiring and the six
prior sender/freshness/API/launch issues were repaired in `75318ad4f`. Its four
new independent findings were grouped into one critical repair and committed
at `e05f83ae9`. Local fault verification covers the normal and injected
native no-contact, dispatch/proof recovery, unconfirmed resource cleanup, and
fixture discovery paths; scoped review found two further load-bearing commit
windows (stale payload update can erase the attempt fence, and a final public
task can complete without advancing the claim). Local software acceptance is
still blocked. A clean later review also cannot establish actual TikTok/iOS
identity and fresh-item mappings, deployment migration or device readiness.
Rollout is not approved from this evidence alone.
The single Web pilot and single iPhone pilot were not run, so the staged gate
for expanding to ten Web accounts and eventually fifty registered profiles
remains closed.

## Historical static and unit verification (`477a67d0a`)

| Area                         | Command or evidence                                                                                                                                                                                                                                                                                                                  | Result                                                                    | Boundary                                                                                                                                                                                                                                                      |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backend outreach/persistence | `backend/.venv/bin/pytest -q backend/tests/test_creator_outreach_channels.py backend/tests/test_creator_outreach_repository.py backend/tests/test_public_outreach_workflow.py backend/tests/test_public_outreach_api.py backend/tests/test_persistence_bootstrap.py backend/tests/test_persistence_migrations_env.py` at `477a67d0a` | `82 passed`                                                               | The reclaimed-lease test uses an explicit fixed `now` inside the second lease; production lease expiry validation was unchanged.                                                                                                                              |
| Operator package             | `cd ops/guild-runtime/public-outreach-operator && npm ci --ignore-scripts && npm test`                                                                                                                                                                                                                                               | `43 passed`                                                               | Installs the pinned local dependencies only; no browser, iPhone, WDA, or TikTok write starts. `npm audit` reported dependency advisories and was not auto-fixed.                                                                                              |
| Runtime package              | `cd ops/guild-runtime && npm test`                                                                                                                                                                                                                                                                                                   | `99 passed, 1 failed`                                                     | The only failure is the retained historical nginx log assertion.                                                                                                                                                                                              |
| Static doctor                | `cd ops/guild-runtime && npm run doctor -- --static` after operator `npm ci --ignore-scripts`                                                                                                                                                                                                                                        | Static checks passed                                                      | Doctor verified package metadata, Playwright `1.59.1`, Appium `3.1.0`, XCUITest `12.13.3`, profile-root parent permissions, runtime config, catalog, and driver registration. It reported zero registered iPhones, so the live WDA pilot remains unavailable. |
| Static acceptance            | `cd ops/guild-runtime && npm run acceptance -- --static`                                                                                                                                                                                                                                                                             | Exited `1` at the historical nginx assertion; suite `99 passed, 1 failed` | The CLI stopped before its later fake-adapter, doctor, and catalog stages, so no acceptance pass is claimed. The separately run operator tests and static doctor are recorded above.                                                                          |
| Frontend lint                | `cd frontend && node_modules/.bin/eslint <public outreach workbench files>`                                                                                                                                                                                                                                                          | Passed                                                                    | Direct ESLint invocation avoids the pnpm dependency-install guard.                                                                                                                                                                                            |
| Frontend types               | `cd frontend && node_modules/.bin/tsc --noEmit`                                                                                                                                                                                                                                                                                      | Passed                                                                    | Type checking only.                                                                                                                                                                                                                                           |
| Frontend build               | `cd frontend && SKIP_ENV_VALIDATION=1 DEER_FLOW_AUTH_DISABLED=1 node_modules/.bin/next build`                                                                                                                                                                                                                                        | Passed                                                                    | Production build completed successfully.                                                                                                                                                                                                                      |
| Workbench E2E                | `cd frontend && PLAYWRIGHT_SKIP_WEB_SERVER=1 PLAYWRIGHT_BASE_URL=http://localhost:3000 node_modules/.bin/playwright test tests/e2e/public-outreach-workbench.spec.ts --config=playwright.config.ts` with a temporary local Next server                                                                                               | `1 passed`                                                                | All API routes were mocked. The test covers account state, task state, receipt evidence, retry, takeover, unknown, and closure controls; it never reaches TikTok.                                                                                             |

The first `pnpm check` attempt was stopped by pnpm's ignored-build approval
guard for `esbuild` and `unrs-resolver`. That command also wrote a temporary
placeholder `allowBuilds` block; the file was restored before this evidence was
committed. Direct ESLint, TypeScript, Next build, and mocked E2E checks are the
reproducible frontend evidence.

At `02521d405`, the final reviewer ran the focused backend workflow/API/repository/
channel tests (`36 passed`) and operator tests (`50 passed`). Offline API-shaped
reproductions still exposed the defects above. A passing fixture suite therefore
does not supersede the **NOT CLEAN** integration verdict. No external action was run.

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

The backend persistence run is green after making
`test_action_claim_lease_expiry_and_completion_identity` deterministic. Its
second lease starts at the fixed `created_at + 2s` and the final completion
uses `created_at + 3s`, which is within the ten-second lease. No production
lease check was relaxed or changed.

## Historical local fake 50-profile / 10-slot stress

The stress run used `createProfileRegistry` and `createPlaywrightPool` with a
temporary directory, a fake persistent-context launcher, and a deterministic
clock. It did not open a browser or make network requests.

| Metric                                         |                                       Result |
| ---------------------------------------------- | -------------------------------------------: |
| Profiles registered                            |                                           50 |
| Concurrent leases at capacity                  |                                           10 |
| 51st registration                              |       Rejected with `profile_limit_exceeded` |
| Capacity rejection                             |                         `capacity_exhausted` |
| Stale leases recovered and replacement claimed |                                          Yes |
| Lease recovery time                            |                                     4.255 ms |
| Peak resident set                              |                                    46.17 MiB |
| Process CPU / wall time                        |                      122.05% over 156.059 ms |
| Synthetic profile registration throughput      |                            320.39 profiles/s |
| Fake launch count                              | 11, including one replacement after recovery |

These are historical local fake-runtime measurements on one host. They do not
estimate TikTok throughput, rate limits, detection risk, or provider latency.
The later recovery fix supersedes automatic recovery of launched-resource
leases: only undispatched/unlaunched leases recover automatically; a launched
browser whose cleanup is unconfirmed remains occupied for manual reconciliation.

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

## Production integration checkpoint (not final acceptance)

At `75318ad4fcbd5d637fc1baba1e45fc0dab2596ef`, root independently ran backend 87,
operator 65 and runtime focused 41 tests (all passed), static doctor, frontend
lint/type/build checks, mocked workbench E2E 1 and three execute-UI cases (all
passed). A real-auth HTTP/SQLite + stdio MCP smoke used the shipped default
native adapter, registered and read a native sender, and confirmed that the
closed gate started no provider worker. UI cases used local Chromium and
mocked public-outreach routes; TikTok request count was zero.

Full static acceptance instead returned 122 passed / 2 failed: the new worker
fixture was accidentally run by parent discovery, plus the historical nginx
log assertion. The new fixture is a regression to fix, not an inherited
failure to exempt. No full acceptance pass is claimed.

Independent fault injection used the actual native repository and managed
JSONL transport with a fake Chromium boundary. Cancellation or child Python
hard exit after a verified comment but before native receipt storage left
`leased/error=None/receipt_id=None/sender=enabled`; expiry recovery then
executed the comment twice. A malformed verified receipt had the same missing
lease-finalization fence. The same owner/sender/creator native
`do_not_contact=true` also failed to prevent an action. A context whose close
raised was incorrectly treated as released and permitted another launch.
These four findings blocked software acceptance at that historical revision;
their repair and current verification are recorded below.

The independent doctor found the existing deployment DB still at
`0026_social_runtime`, no registered iPhone and no initialized public profile
root. Provider attributes in local W3C fixtures are fabricated contract
fixtures, not observations of TikTok/XCUITest. Real sender/creator/item proof
mapping and normal deployment migration remain prerequisites, and both live
pilots/account expansion remain unverified or blocked. Operator dependencies
installed for this integration stay locally available under the Git ignore;
no credentials or browser profile data are committed.

## 2026-09-30 fixed-SHA software verification

Implementation `e05f83ae9216a229d161bc29c1a8c2b0d3962470` contains the
first bounded repair for the four findings from the `75318ad4f` integration
review. The original project ledger records the dispatch and ruling. Scoped
re-review at that historical SHA found two residual terminal-boundary failures;
the table records root-run checks, and the later accepted repair follows below.

| Check | Result | Practical limit |
| --- | --- | --- |
| Backend focused workflow/API/repository/production/Gateway/MCP suite | **104 passed** | Native tasks, actual managed Node composition and local fake provider transport only. |
| Operator package | **71 passed** | Includes Web/iOS transport contracts and cleanup-fence fault tests, not live TikTok. |
| Runtime focused catalog/doctor/acceptance/start tests | **41 passed** | Static/local contracts only. |
| Shipped native MCP adapter over actual authenticated Gateway HTTP and SQLite | **Passed** | Account registration/read and closed gate exercised; no provider worker started. |
| Static doctor | **Passed** | Deployment DB at `0026_social_runtime`; no registered iPhone; public profile root not created; no WDA live probe. |
| Full `npm run acceptance -- --static` | **128 passed / 1 failed** | New worker discovery failure fixed. Historical nginx log assertion remains; full acceptance is not green. |
| Frontend TypeScript/lint/build, mocked workbench E2E 1 and explicit execute UI 3 cases | **Passed at `75318ad4f`** | No frontend source changed in `75318ad4f..e05f83ae9`. API mocked; TikTok request count zero. |
| Anonymous real Playwright/Chromium hard-death drill | **Passed** | Pinned SDK launched only `about:blank`; Chromium had a detached process group. After SIGKILL of Node and simulated expiry, reclaim returned `profile_cleanup_required`, preserving the same on-disk lock. Owned Chromium and temp data were then cleaned. No TikTok navigation. |

At `e05f83ae9`, the same native owner/sender/creator no-contact state is
checked before admission, at claim and immediately before provider dispatch.
The native task stores an internal attempt-started fence before external I/O,
but a stale concurrent payload update can erase it even without a caller
supplying forbidden keys. Dispatched but unfinished work is intended to
require manual reconciliation after cancellation, bad receipts, expiry or
process death; that guarantee is not yet established. Verified proof and task
association are stored atomically; a
partially finalized proven task cannot be re-sent. A browser/session that has
not been confirmed closed keeps its profile and host slot occupied, including
after a dead Node owner. Only unlaunched/undispatched leases are eligible for
automatic recovery. A second residual gap allows the final completed public
task to leave its claim `gray` after cancellation, blocking the message.
Neither bug is safe to treat as accepted; no exactly-once external delivery
claim follows from local tests.

The still-open runtime nginx assertion is pre-existing: the checked-in
`docker/nginx/nginx.local.conf` directs logs to files, while the test expects
launcher streams. The historical stash also contains a related older edit,
but it was not applied; changing three nginx directives alone would not prove
the complete bounded logging lifecycle. This remains in runtime ownership.
Provider-specific Web/iOS identity and fresh item read-back, DB migration,
physical iPhone/WDA and both one-account pilots still require separate
verification. Ten-account activity and a fifty-account rollout stay closed.

## 2026-09-30 terminal boundary delivery (`d4fd1444a`)

The one bounded follow-up to the **NOT CLEAN** `e05f83ae9` re-review is
`d4fd1444a1277583387ccb8cb69e690ccda360e9`. Its scoped independent
review is **CLEAN** for R1/R2 with no important new breakage in the five-file
diff. The changes are limited to the native repository,
workflow, Gateway service, regressions and existing production runbook.

- R1 stale ordinary payload writes now require a pending task and a persisted
  `updated_at` version match. A concurrent claim/dispatch or another pending
  update rejects the old read instead of overwriting the newer JSON. In the
  deterministic read-barrier regression, the external-attempt fence survives
  ordinary text, expiry demands manual review/sender pause and blind claim is
  denied.
- R2 FOLLOW and DM now validate a native worker-bound verified receipt,
  owner/sender/creator/sequence, action/group/kind and current
  no-contact/closed constraints. Task completion and the corresponding claim
  and sequence transition commit in one native transaction. If interrupted
  after proof storage but before this transaction, explicit execute reconciles
  only that proof in native storage and returns duplicate without starting
  the Node provider. FOLLOW reaches `public_touched`; DM reaches `contacted`.
  Completed tasks do not force a backward transition from later valid states.

At the fixed SHA, root independently reran backend focused **124 passed**,
operator **71 passed** and actual authenticated native MCP/HTTP/SQLite smoke
**passed**, with no provider worker. Full parent static acceptance remains
**128 passed / 1 historical nginx failed**. Runtime focused 41 and static
doctor passed on unchanged runtime source in the prior revision. Frontend is
unchanged since `75318ad4f`, where lint/types/build, mocked E2E 1 and three
execute UI cases passed. The pinned real anonymous Chromium resource drill
was against unchanged Web source and remains local resource evidence only.

The software is still not live-qualified: there is no verified TikTok/iOS
sender, creator or fresh item mapping, no physical iPhone/WDA session, no
deployment migration and no authorized one-account pilot evidence. These
tests establish local recovery invariants, not platform exactly-once delivery
or multi-account operational safety.

The independent reviewer reran the old three failure observations as strict
positive assertions and passed all of them: stale allowed-text update was
rejected; the persisted attempt marker survived and expiry caused
`failed/manual_required`, sender pause and blind-claim refusal; FOLLOW and DM
post-commit cancellation left both claim and sequence in `public_touched` or
`contacted`, kept their verified proof and submitted to the local provider
only once. FOLLOW then allowed a verified DM. Independent narrow backend:
**20 passed, 35 deselected**. This is a local software acceptance result;
full runtime static acceptance is still not green, and no real TikTok provider
or iPhone receipt has been verified.
