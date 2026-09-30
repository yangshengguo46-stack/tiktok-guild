# TikTok Web account network initialization

Date: 2026-09-30
Status: approved in conversation

## Scope and ownership

This first increment covers the ordinary TikTok Web sender used by `public-outreach-operator`. It does not configure TKDesk, guild Backstage, broker messaging, iPhone control, or the host operating system's proxy. The execution worker owns the browser profile, its explicit proxy connection, and the live network observation. DeerFlow owns the sender, task, attempt fence, and decision to admit an external action. No new MCP or business ledger is introduced.

The existing deployment file named by `PUBLIC_OUTREACH_EXECUTION_CONFIG` binds the pilot sender to a private `web_route` with a loopback proxy URL and required expected exit country. The URL and any credentials stay outside Git and must not be returned to the model, the workbench, or task receipts. A sender without a route cannot be declared ready for Web execution. Each sender retains its separate persistent profile and lease; a route is never borrowed from TKDesk or another sender.

## Initialization sequence

Global `npm run doctor` keeps checking installed browser and writable profile roots without depending on the public network. A per-sender runtime preparation occurs only when that sender is explicitly opened for login or when an admitted Web task is about to run; starting DeerFlow must not launch dozens of browsers.

Before the native workflow claims a task or marks an external attempt, Gateway asks the existing Node worker to prepare the bound sender. The worker validates the private route, checks that the proxy's loopback endpoint is reachable, obtains the sender's normal slot and profile lease, and launches that persistent Playwright context with the proxy specified explicitly. In a page of **that same context**, it loads a fixed non-TikTok exit diagnostic URL with a short timeout. It accepts only a valid response whose observed country matches the configured country. The observed IP is compared with an optional configured expected IP, but never returned raw or persisted in the business ledger. Successful preparation returns an opaque, single-use preparation handle and keeps the context and leases alive for the immediate action. The action must consume that handle and use the same context. A separate explicit release or worker shutdown closes unused preparation and releases resources only after confirmed browser cleanup.

If preparation fails, Gateway returns a named blocked result while the action task remains pending; no external-attempt marker is written. Examples include `web_route_unconfigured`, `proxy_unreachable`, `browser_launch_failed`, `egress_check_failed`, `egress_country_mismatch`, and `egress_ip_mismatch`. The worker may make one bounded reconnect attempt to the **same** configured local endpoint when the socket is temporarily unavailable. It must not change the system proxy, rotate nodes, copy cookies, replay a TikTok action, or infer that a successful exit check means TikTok login is accepted.

After preparation, DeerFlow continues its existing claim and external-attempt fencing. The worker navigates TikTok only when the admitted action uses the preparation handle. Any TikTok challenge or “访问频繁” remains an explicit manual stop and cannot be turned into an automatic retry. A route observation is a short-lived capability check, not account authentication; provider sender identity must still be verified through the existing readback.

## Protocol and failure boundaries

The existing Gateway-owned worker protocol gains narrowly typed `prepare_web` and `release_web` operations, with the existing `execute` operation accepting the opaque handle. Only Gateway's native service calls these operations. Preparation is serialized with action execution for the pilot sender. The handle is bound to the owner and sender, expires quickly, and can be consumed once. Worker exit invalidates it. Gateway releases it in a `finally` block if the action does not consume it. A cleanup failure retains the existing profile/slot fences and returns a distinct manual-cleanup failure; dead PIDs alone cannot free a browser lease.

The private route schema is validated before any browser launch. It allows only an explicitly configured loopback HTTP or SOCKS proxy and a two-letter expected country. Optional expected IP is an address literal. An omitted route fails closed for a Web sender. Secrets and raw proxy strings are absent from normal errors and logs.

## Verification

- Test that an unreachable or mismatched proxy blocks before `mark_external_attempt_started`, leaving the task pending.
- Test that preparation and execution use one context, one account profile, one route, and a single-use owner-bound handle.
- Test failure, cancellation, timeout, and shutdown cleanup, including a browser-close failure that retains resource fences.
- Test two senders cannot exchange handles, profiles, or routes.
- Use a local fake proxy and a local HTTP exit fixture for automated checks. A separate manual non-TikTok diagnostic confirms the real configured route before any new login trial. Offline tests do not claim TikTok acceptance.

## Rollout

Enable the route for one explicitly admitted Web sender first. Observe a passing non-TikTok exit check and confirm its profile and slot cleanup. Preserve the prior stopped login pilot as historical evidence; do not re-enable it merely because network initialization passes. Multi-account rollout follows the same per-sender contract after the single-sender path is validated.
