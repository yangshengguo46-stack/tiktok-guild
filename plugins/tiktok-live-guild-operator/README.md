# TikTok LIVE Guild Operator

v0.15 Codex plugin for authenticated TikTok LIVE Backstage guild reads plus agent-operated backstage actions. Creator removal remains approval-gated.

## Runtime model

- One MCP process exposes nine hierarchical tools.
- `guild_workspace {}` actively discovers the authenticated guild and returns `guild_ref`.
- `guild_workspace { "child": "get_status" }` is passive and never starts a browser.
- Routine discovery and business reads use one headless persistent Playwright profile, so they do not open or flash a Chrome window.
- Login, verification, CAPTCHA, or security challenges temporarily relaunch that same profile visibly; a successful discovery returns it to headless mode.
- Business reads create isolated pages. Profile operations are serialized to prevent navigation or session-mode changes during a message write; one domain failure remains scoped to its own result.
- The browser profile stores TikTok-owned login state and a minimal `.message-operations/operations.sqlite` reservation/receipt record owned by the sender. It stores identifiers and content hashes, never message bodies or credentials; it is not a CRM, collection ledger, or background job.
- `guild_onboarding` prepares a workflow and can execute `assign_staff`, `assign_affiliate_account`, `grant_messaging_permission`, and `allocate_invitation_cards` after exact identity and target binding. `guild_messaging` prepares and sends a message through the visible Backstage composer after the exact sender, recipient, and body are bound. Message writes are single-attempt. A bound provider response containing a message ID plus a new outgoing read-back is reported as verified; a visible bubble alone remains unknown. Authorization failures, rejections, and unknown outcomes are recorded distinctly and reserved message keys are never retried. Creator removal is the only operation that remains explicitly approval-gated.

## Message execution and recovery

The same profile has one browser owner across processes, an atomic durable message-key reservation, and a shared page mutex. Restarted pending operations are unknown and cannot dispatch again; a reused key with another sender, recipient, or body returns `idempotency_conflict`. The Guild entry uses the same SDK/legacy receipt paths and trusted single-click rule as Broker, so there is no alternate synthetic-click or refresh path around deduplication. Legacy Broker browser markers are read only and retained. Older Guild versions had no persistent message keys; their historical operations cannot be reconstructed by this update.

Sending requires a scoped authenticated account identity and exact search result/conversation header. Optional `TIKTOK_GUILD_SENDER_ACCOUNT_REF` and `TIKTOK_GUILD_SENDER_IDENTITY_TEXT` additionally bind a configured identity; any mismatch fails before dispatch. A sender string or display name in unrelated page text does not establish identity.

`guild_messaging` adds `get_operation_status` and `reconcile_message` with `params.idempotency_key`. The prior `guild_ref` can be used to inspect profile-local records after a restart without starting the browser. Reconcile only observes the retained page, never navigates, sends, clears a key, or promotes an optimistic bubble to provider success. With no response, `provider_status` and `provider_receipt` are null; HTTP 200 without a bound provider message ID remains unknown. New outgoing read-back can report `visible: true` and `message_id: null` honestly.

Prepared workflows are limited to 256 with a 30-minute expiry and message attempts remove their workflow; durable keys remain reserved. Browser starts, mode switches and closes time out after 30 seconds while retaining the underlying transition fence. A late context is closed before another launch; an uncertain close blocks replacement contexts.

Tests use temporary profiles and fully intercepted local Chromium pages. The real Backstage account/header selectors and opaque SDK formats still require read-only live review; absent evidence fails closed or remains unknown. This update has not been deployed or verified by sending a real platform message.

## MCP tools

- `guild_workspace`
- `guild_creators`
- `guild_recruitment`
- `guild_messaging`
- `guild_operations`
- `guild_revenue`
- `guild_governance`
- `guild_intelligence`
- `guild_onboarding`

Business calls use:

```json
{
  "guild_ref": "guild_opaque-reference",
  "child": "list_creators",
  "params": {}
}
```

Each response reports `status`, `data`, `evidence`, `completeness`, `pagination`, and domain-scoped `errors`. Raw authorized creator IDs and numeric values remain available in the active task. Missing endpoints and unseen pages are not treated as zero.

Normal page reads are bounded. The reusable pagination contract supports cursor traversal up to 200 pages and is covered at 169, 1,000, and 20,000 synthetic records. Live page responses continue to report pagination as `not_proven` until the specific endpoint exposes a reviewed next-page cursor; callers should prefer targeted reads or aggregate views instead of assuming a complete roster.

## Login flow

1. Call `guild_workspace {}`.
2. If the response is `login_required`, complete login in the one visible Backstage window without closing it.
3. Call `guild_workspace {}` again. It verifies the session, returns the same profile to headless mode, and provides the `guild_ref` for this MCP process.
4. Call only the business domains needed for the question.

Schema or endpoint mismatch is reported as `adapter_mismatch`; it is not presented as a login problem.

## Development

```bash
npm install
npm test
node scripts/verify-clean-core.mjs
python3 /Users/yangyucheng/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py .
```

Live acceptance requires a fresh Codex task after installation: discover the guild, complete one human login if requested, and read representative creator, revenue, recruitment, and governance data.

Native messaging binds the selected `.im-layout-account` to public IDs and handles from `getAgencyIMConfigV2`. An exact selected conversation row must include that sender UID and its scoped nickname must agree with the active header and native metadata. Username search binds the `Handle` request to the exact returned `CreatorUID`/`Handle`, rejects unqualified or ambiguous creators, and checks the selected conversation after opening the matched popup row.

Use exactly one primary recipient identifier. Existing `conversation_id` and existing `creator_id` can use native conversation rows. A new `creator_id` additionally needs `lookup_handle` from a sourced creator record, for example `{ "creator_id": "7667651908912448533", "lookup_handle": "y_livecreator" }`. The handle is used only for lookup: the returned UID must exactly equal the planned UID before selecting the result. Native search does not support numeric UID input. `lookup_handle` is valid only with `creator_id` and is bound to the prepared workflow, dispatch guard and idempotency hash; changing it conflicts with the reserved operation. An unqualified result remains blocked, including this example if its live qualification is false.

If SQLite becomes busy after dispatch, the outcome remains unknown. The settled execution lease is cleaned up only by its exact token, with a bounded deferred attempt and later token cleanup when a distinct operation is requested; the old operation key remains consumed. An independent store in the same process cannot reclaim that lease.

A retained native messaging page performs at most one automatic bootstrap. Missing identity evidence keeps writes blocked without repeated reloads; natural read-only responses may restore readiness. The page is reused across ready recipient operations.
