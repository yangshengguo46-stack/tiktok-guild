# Web Account Network Initialization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bind each ordinary TikTok Web sender to a checked proxy route before DeerFlow records any external action attempt.

**Architecture:** The existing private execution config owns one Web sender's loopback proxy and expected egress. The Node operator launches that sender's persistent context with the explicit route, probes egress in the context, and keeps a short-lived prepared lease for execution. Gateway prepares before calling the native workflow and releases the lease if no action consumes it. The native task/receipt ledger stays in DeerFlow.

**Tech Stack:** Node.js ESM, Playwright 1.59.1, Python async Gateway, SQLite-backed DeerFlow tests.

**Spec:** `docs/superpowers/specs/2026-09-30-web-account-network-initialization-design.md`

## Global Constraints

- First increment covers `public-outreach-operator` Web senders only.
- Route config lives outside Git and may name only a loopback HTTP or SOCKS proxy.
- Per-sender persistent profile and host slot fences remain the existing resource owners.
- Probe a non-TikTok URL in the exact context that will perform the action.
- A failed preparation leaves the native task pending and writes no external-attempt marker.
- Do not switch system proxy, rotate endpoints, copy cookies, retry TikTok warnings, or send TikTok requests during tests.
- Preserve the disabled `web:pilot_001` resource and the existing live-login stop.

---

### Task 1: Private Web Route and Browser Egress Check

**Files:**
- Create: `ops/guild-runtime/public-outreach-operator/src/web/network-route.mjs`
- Test: `ops/guild-runtime/public-outreach-operator/test/network-route.test.mjs`

**Interfaces:**
- Produces `parseWebRoute(value)` returning `{ proxy: { server }, expectedCountry, expectedIp }` or a typed `web_route_unconfigured` / `web_route_invalid` error.
- Produces `checkProxyEndpoint(route, { connect, timeoutMs })` and `probeBrowserEgress(context, route, { diagnosticUrl })`, returning `{ ready, error_code, observedCountry }` without raw IP.

- [ ] **Step 1: Write failing tests** for missing route, non-loopback URL, unreachable endpoint, a matching synthetic diagnostic, and country/IP mismatch. Use a local `net.createServer()` endpoint and a fake `context.newPage()` that records navigation; assert no TikTok URL is used.
- [ ] **Step 2: Run** `node --test test/network-route.test.mjs` from the operator package; expect missing export failures.
- [ ] **Step 3: Implement** the validator and probe. Core checks must use:

```js
const url = new URL(value.proxy_server);
if (!['http:', 'socks5:'].includes(url.protocol) || !['127.0.0.1', '::1', 'localhost'].includes(url.hostname)) throw routeError('web_route_invalid');
const response = await page.goto('https://www.cloudflare.com/cdn-cgi/trace', { waitUntil: 'domcontentloaded', timeout: 10000 });
const fields = Object.fromEntries((await response.text()).split(/\r?\n/u).filter(line => line.includes('=')).map(line => line.split('=', 2)));
```

  Close the diagnostic page in `finally`; never return `fields.ip`, route URL, or credentials. Retry only one failed TCP connect to the same endpoint.
- [ ] **Step 4: Re-run** `node --test test/network-route.test.mjs`; expect all cases to pass.
- [ ] **Step 5: Commit** this self-contained route module and its test.

### Task 2: Prepared Web Context in the Existing Worker

**Files:**
- Modify: `ops/guild-runtime/public-outreach-operator/src/production-executor.mjs`
- Modify: `ops/guild-runtime/public-outreach-operator/src/worker-protocol.mjs`
- Test: `ops/guild-runtime/public-outreach-operator/test/web-initialization.test.mjs`

**Interfaces:**
- `executor.prepareWeb({ account }) -> { ready: true, preparation_id } | { ready: false, error_code }`.
- `executor.releaseWeb({ preparation_id }) -> { released: boolean, error_code? }`.
- `executor.execute({ ..., preparation_id })` consumes a matching handle once and uses its already checked context.
- Worker messages add `operation: 'prepare_web' | 'release_web'`; absence of `operation` means existing `execute`.

- [ ] **Step 1: Write failing tests** with fake Chromium, profile registry, and slot. Prove preparation calls `launchPersistentContext(profile, { headless: false, proxy: route.proxy })`, the diagnostic runs before any TikTok navigation, execute uses the same context, another account or replay cannot consume the handle, and release/close preserve cleanup fences on close failure.
- [ ] **Step 2: Run** `node --test test/web-initialization.test.mjs`; expect missing `prepareWeb`.
- [ ] **Step 3: Implement** a `Map` of short-lived prepared leases bound to owner/sender and one-time IDs. Reuse `createPlaywrightPool` and `acquireResourceSlot`; release through their existing cleanup methods. Dispatch narrow worker operations:

```js
const result = request.operation === 'prepare_web'
  ? await executor.prepareWeb(request)
  : request.operation === 'release_web'
    ? await executor.releaseWeb(request)
    : await executor.execute(request);
```

  Keep iOS execution untouched. A missing Web route returns `web_route_unconfigured` before browser launch. Do not return the raw proxy endpoint or observed IP.
- [ ] **Step 4: Re-run** the new test and existing `node --test test/web-pool.test.mjs test/web-executor.test.mjs test/production-transport.test.mjs`.
- [ ] **Step 5: Commit** worker preparation and focused tests.

### Task 3: Native Gateway Admission Before Attempt Fencing

**Files:**
- Modify: `backend/app/gateway/public_outreach_service.py`
- Modify: `backend/app/gateway/routers/public_outreach.py`
- Test: `backend/tests/test_public_outreach_production.py`

**Interfaces:**
- `NodeExecutorTransport.prepare_web(account=...)` and `.release_web(preparation_id=...)` call the same managed worker with the typed operation.
- `PublicOutreachService.execute_task` awaits preparation under `_dispatch_lock` for Web senders before `workflow.execute_task`; it passes the opaque handle to the callback and releases any unused preparation in `finally`.
- `POST /api/public-outreach/accounts/{sender_account_id}/network-preflight` is an admin-only explicit check. It prepares and immediately releases the sender; it never opens TikTok or claims a task.
- A failed preparation returns `{status: 'blocked', error_code: ..., task: ...}` without task claim or attempt mutation.

- [ ] **Step 1: Write failing Python tests** using a fake transport. Assert `prepare_web` precedes provider execution, mismatched egress leaves `state == 'pending'` and `attempt_count == 0`, release occurs if workflow returns early, iOS does not call Web preparation, and the admin-only preflight route cannot be used for another owner's sender.
- [ ] **Step 2: Run** `uv run pytest tests/test_public_outreach_production.py -q` from `backend/`; expect the new assertion to fail.
- [ ] **Step 3: Implement** the transport request helper and service gate:

```python
async with self._dispatch_lock:
    preparation = await self.transport.prepare_web(account=sender) if sender['channel'] == 'web' else None
    if preparation is not None and preparation.get('ready') is not True:
        return {'status': 'blocked', 'error_code': preparation['error_code'], 'task': task}
    try:
        return await workflow.execute_task(task_id, creator=creator)
    finally:
        if preparation is not None:
            await self.transport.release_web(preparation_id=preparation['preparation_id'])
```

  The callback adds only the preparation ID to the worker request. Keep old iOS behavior and the native attempt fence intact.
- [ ] **Step 4: Re-run** the focused Python file and Node worker protocol tests.
- [ ] **Step 5: Commit** Gateway admission and tests.

### Task 4: Operator Documentation and Final Verification

**Files:**
- Modify: `docs/verification/creator-agent/public-outreach-production-runbook.md`
- Modify: `ops/guild-runtime/public-outreach-operator/README.md` if present; otherwise document in the existing runbook only.
- Modify: `backend/AGENTS.md` for the new Gateway/worker boundary.

**Interfaces:** No new MCP tools. Private route example is `sender.web_route: { proxy_server: 'http://127.0.0.1:PORT', expected_country: 'US' }`; optional `expected_ip` is an IP literal.

- [ ] **Step 1: Document** the private route schema, preflight order, named failures, cleanup, and the difference between network readiness and TikTok login. Include a non-TikTok manual diagnostic and preserve the stopped live pilot.
- [ ] **Step 2: Run** `node --test` in the operator package and the focused backend production tests. Inspect the diff for proxy URL, IP, Cookie, or token leakage.
- [ ] **Step 3: Run** the existing `npm run doctor -- --static` from `ops/guild-runtime` to ensure global startup checks still pass without private route configuration.
- [ ] **Step 4: Commit** docs and any test repairs, then report what is verified and what still needs a single-account live login review.
