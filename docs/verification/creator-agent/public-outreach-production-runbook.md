# Public outreach production wiring

Gateway owns the native `CreatorOutreachRepository`, `PublicOutreachWorkflow` and a managed Node execution worker. The shipped MCP adapter calls authenticated Gateway routes; it has no task database, claims or browser pool. The workbench and `public_outreach_tasks.execute` use the same explicit execution route. Enqueue, claim, health, list, get and reconcile never write to TikTok. Client claim is rejected because native execution owns leases; complete only reads an already completed task and cannot submit a receipt.

## Deployment gate and private state

External writes are disabled when no execution configuration is supplied. Creating tasks, registering an account or resuming it does not enable writes. `PUBLIC_OUTREACH_EXECUTION_CONFIG` must point to a private JSON file outside Git. The deployment operator must explicitly admit one owner, sender, creator and action allowlist; private messages additionally require `message_enabled: true`.

```json
{
  "pilot": {
    "enabled": false,
    "owner_user_id": "REPLACE_WITH_AUTHENTICATED_USER_ID",
    "sender_account_id": "REPLACE_WITH_NATIVE_SENDER_ID",
    "creator_uid": "REPLACE_WITH_NATIVE_CREATOR_UID",
    "actions": ["like", "comment", "follow"],
    "message_enabled": false
  },
  "sender": {
    "owner_user_id": "REPLACE_WITH_AUTHENTICATED_USER_ID",
    "sender_account_id": "REPLACE_WITH_NATIVE_SENDER_ID",
    "channel": "web",
    "headless": false
  }
}
```

Set `PUBLIC_OUTREACH_RUNTIME_ROOT` to the same external directory for every Gateway worker on the host. Its default is `$HOME/.codex/tiktok-live-public-outreach`. Web profiles live below `web-profiles/profiles/<sha256(owner,sender)>`; resource leases live below `slots/`. The ops runtime's doctor profile root defaults to the same `web-profiles` directory. Keep the private deployment file, cookies, screenshots, device records and UDIDs out of Git. Dependencies are installed in the ignored operator `node_modules` directory using the committed lockfile.

Gateway requires native persistence and initializes its executor in lifespan. The Node process is lazy: a closed pilot gate creates no browser/device process. Gateway injects the existing internal token and the resolved runtime user into each owner/thread stdio MCP session; never configure a globally fixed owner or internal token in extensions JSON. Gateway rehydrates that owner through the existing local auth provider and retains the original role and `threads:read/write` checks. A bare owner header is ignored. The existing synthetic `default` admin works only under the existing local nonproduction auth-disabled gate; production never uses that fallback. `PUBLIC_OUTREACH_GATEWAY_URL` is optional; the default is loopback plus the actual configured Gateway port.

## Provider entry and current pilot blockers

**Observed login stop (2026-09-30):** A user manually tried the dedicated
headed Playwright TikTok login window and reported “访问频繁”. We closed the
context, confirmed the browser process and profile lock were gone, and left
the local resource disabled. The cause is unverified; a persistent profile
does not establish that TikTok accepts this browser for login. Do not retry
that login path, rotate network identities or work around the warning as part
of this pilot. First reconcile the account's normal access through the
platform's official client and review this observation before any later
single-account Web pilot. No provider action or receipt resulted from this
login preflight.

Install the pinned operator dependencies, Playwright Chromium and, for iOS, the pinned Appium/XCUITest driver using the existing ops installation flow. These deployment steps are separate from offline tests. The production Web caller uses actual `chromium.launchPersistentContext`, navigates a new blank page to the fixed `https://www.tiktok.com/` origin, then verifies the logged-in sender before navigating to the native creator handoff. The sender must match the native account's `external_ref` by canonical handle or UID; owner and target cannot come from model parameters. Creator URL/handle comes only from the native handoff, and URL navigation is limited to HTTPS TikTok profile URLs.

For iOS the private sender binding additionally supplies `appium_url`, `wda_url`, optional `bundle_id`, and a `device` object with `udid`, `platform_version` and `wda_bundle_id`. The shipped HTTP client uses W3C session creation and element commands, Appium `mobile: activateApp`, `mobile: deepLink`, `mobile: deviceInfo` and `mobile: isLocked`, and DELETE session cleanup. It accepts semantic accessibility id, XPath, iOS predicate and iOS class-chain locators consistently in single and collection reads. It proves the actual session's iOS/XCUITest capabilities and device UDID, then checks the signed WDA build bundle identifier, build time and iOS status. Config booleans cannot substitute for those responses. A failed session or health check prevents platform writes.

**Real TikTok provider selectors and readback mappings remain unverified.** Deployment `sender.locators` can select the observed controls, but current sender/creator and fresh item proof readers require provider attributes such as `data-sender-handle`, `data-creator-uid` and `data-receipt-id`. The offline HTTP fixture intentionally exposes those attributes. Native XCUITest commonly exposes `name`, `label` and `value`; the fixture is not evidence that TikTok exposes the required identity or item fields. A separate single-account pilot must establish the real mapping, and may require a provider-specific readback implementation. Until then, missing identity or fresh item proof fails closed. Do not enable the deployment allowlist based only on passing fixtures, driver installation or static doctor output.

The live pilot must establish sender identity, canonical target identity, inactive-to-active like/follow transitions and fresh comment/message identities scoped to that same sender and target. An increased count, an old matching text or a changing WebDriver element reference is insufficient. Receipts retain observed identities, transition data, actual new item identity, text and scope evidence; an unknown readback never manufactures a verified completion.

## Execution and recovery

Register accounts through the native accounts API/MCP as an authenticated admin, and use the existing native creator claim/sequence binding. Enqueue the ordered native tasks with their stored comment/message text. Execute explicitly with the workbench **Execute pilot action** button, `POST /api/public-outreach/tasks/{task_id}/execute`, or the MCP `execute` child with `task_id`. The server enforces like → comment → follow → message even when a client directly selects a later task. The workbench distinguishes registered accounts, native ready accounts and actual active Web slots; native readiness is not a live TikTok attestation.

The existing native relationship's `do_not_contact` flag gates admission and dispatch for the same owner, sender and creator. Unrelated owners or senders retain their own relationship scope. A durable native external-attempt fence is committed before calling the provider. A dispatched action whose lease expires becomes failed/manual-required with its sender paused; it cannot return to pending automatically. Undispatched leases may recover normally. Caller enqueue/update payloads cannot set or replace dispatch and manual-recovery fields.

Ordinary comment/message text can be edited only while its task is pending. Native update uses a versioned conditional write; an update racing with dispatch or another text edit fails and must be reloaded. It cannot replace the worker's durable attempt fence or proof. FOLLOW completion and `gray → public_touched`, and DM completion and `public_touched → contacted`, commit together in the native repository after the bound verified receipt, sender, sequence and public action group are checked. If cancellation or process death happens after proof storage but before that commit, explicitly executing the same task again can finish only this native bookkeeping from its bound proof and returns a duplicate; it makes no provider call. The sender remains paused after an unknown attempt until a separate authorized resume. A new no-contact fact, closed/inconsistent sequence, wrong sender, receipt kind or action group blocks this reconciliation. An unbound or caller-supplied receipt cannot drive it.

Verified completion is durable in the same native repository and cannot be retried. Verified proof is stored and linked to its native task in the same transaction, so cancellation or hard death between proof storage and completion cannot permit another platform attempt. Cancellation after durable completion preserves duplicate replay. Timeout, executor exit, cancellation, malformed receipt or receipt persistence failure writes a failed native task with `error_code` and manual-required evidence, and pauses the native sender. Inspect the actual platform result, perform the existing explicit manual recovery/retry and separately resume the account only after reconciling unknown actions. A task with durable verified proof cannot be retried, even if completion was interrupted. Caller receipts cannot mark a task verified. These fences prevent automatic redispatch of unknown attempts; they do not establish exactly-once platform delivery.

The provider deadline is at most 120 seconds, below the native 300 second execution lease. Queueing for the serialized dispatcher occurs before lease acquisition. Request cancellation, pause/takeover/sequence close and Gateway shutdown propagate to the Node action. Shutdown allows bounded cleanup before terminating the Node process group. Browser close failures propagate and retain the context, profile ownership and host slot for another bounded cleanup attempt. Ownership is marked cleanup-required before browser launch and stays occupied after hard Node death until cleanup is confirmed; dead PID alone cannot recover these resources or advertise capacity. The pinned Playwright launcher uses `detached: true` on non-Windows (`playwright-core/lib/server/utils/processLauncher.js:109–112`) and terminates Chromium using its own process group (:202). Killing the Node group does not confirm Chromium has stopped. Before manually clearing an orphan browser fence, inspect and terminate the actual browser children, confirm the profile is unused and record that reconciliation. A killed iOS process may leave a remote Appium session: its shared iPhone slot deliberately stays blocked. Before manually removing that orphan slot, verify and delete the real Appium session and establish that the device is idle. Do not clear a live lease or blindly retry an unknown action.

The shared external root fences at most 50 Web profile registrations, 10 active Web slots across local Gateway/Node processes and one active iPhone. Different owners receive different hashed profile resources. These are host resource locks, not a second business task store. A shared multi-host execution deployment is not supported; use one executor host. Static doctor and offline isolated database tests do not migrate or validate an existing deployment database. Apply the existing required native migrations through the normal deployment workflow before using the feature.
