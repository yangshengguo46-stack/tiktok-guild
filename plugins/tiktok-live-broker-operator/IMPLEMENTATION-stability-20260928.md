# stability-20260928-messaging delivery

Scope: only the Broker and Guild plugin source trees. No Git repositories or commits; no deployment, running-owner restart, real platform message, credential inspection, TKDesk edit, or project edit.

Baseline: `/tmp/stability-20260928-messaging-baseline` (src/test/scripts/package/README/manifest copies, no profiles or credentials). Unified source/test/doc diff: `/tmp/stability-20260928-messaging.diff`. Changed-file SHA-256 manifest: `/tmp/stability-20260928-messaging-changes.json` (source/test/doc file hashes; this report is separate).

## Changes

- Same-profile browser lease and message-write lease are transactional SQLite rows. A live owner fences other processes. A dead process lease may be acquired by a new process; operation reservations are never removed.
- Minimal profile-local `.message-operations/operations.sqlite` contains only operation keys, sender/recipient/guild binding, body hash, status and receipt. Atomic reservation precedes all execution; uncertainty is committed before the single click. Pending is read as unknown after restart. Keys remain consumed for verified, rejected, unknown and not_executed outcomes; different payload under the same key is a conflict.
- Broker and Guild each carry an independent local copy of the same safety implementation; neither imports the other plugin. The old Guild sender now follows SDK and legacy receipt paths with one trusted click and no synthetic/fallback write.
- All handlers share the session page mutex. Messaging pages are retained and context changes invalidate stale page references. Prepared workflows have a 256-entry limit/30-minute expiry; attempted message workflows are removed while durable keys remain.
- Native sender proof joins the scoped selected account nickname to one unique official IM config record (`getAgencyIMConfigV2`) containing exact handle and AgentTTUserID. The selected row's exact ConversationID, participant membership, native metadata and scoped nickname/header must agree. Config is rechecked immediately before dispatch. Nickname ambiguity, stale rows from another account, arbitrary page text and account attributes in conversation content fail closed.
- Native username search observes only the exact `Handle` request's official `Creators` response, binds exact CreatorUID/Handle, rejects false qualification and nickname ambiguity, then validates the popup and selected UID pair/header. A new creator_id needs a sourced lookup_handle; existing creator_id can use the native exact UID pair without assuming participant order. lookup_handle is valid only with creator_id and belongs to the plan, override validation, durable payload hash and guard. Tool names remain unchanged; schemas document the optional field.
- Native read-only response projections stay in memory and discard raw responses. Page close removes listeners, navigation invalidates facts, search epochs ignore stale responses. Automatic native bootstrap happens at most once per retained observer: failed/missing evidence remains blocked without another automatic reload; naturally observed valid facts can restore readiness. Scoped nickname child selectors exclude rank tags. `inspectMessagingBinding` observes the already-selected sender/conversation without navigation, fill, click or dispatch.
- Receipt observation includes only requests initiated after this dispatch and binds body/recipient/conversation/sender evidence. A real provider response and message ID plus new outgoing read-back are required for verified. Missing receipt yields null provider status/receipt; no synthetic HTTP 200 or message ID. Opaque or incomplete receipt formats and optimistic bubbles remain unknown. Existing matching text cannot verify a new write.
- SQLite BUSY/LOCKED before reservation is classified profile_busy. A lock after dispatch returns honest unknown if the receipt cannot be persisted; the already-committed unknown record consumes the key. Settled lease cleanup deletes only the exact kind/PID/token, uses at most three deferred retries, and may be retried when a distinct operation is requested. Another store in the same live PID cannot reclaim the lease. This maintenance never retries the message.
- Browser starts, mode switches and closes have bounded caller timeouts but retain the underlying transition fence. Late contexts close before another start; an uncertain close keeps the owner fenced.
- Existing tools retain their names; messaging adds `get_operation_status` and `reconcile_message` with `params.idempotency_key`. A prior guild_ref can inspect profile-local state after restart without starting a browser. Reconcile only observes the retained page and never navigates, writes, deletes a key, or changes unknown to verified.
- Legacy Broker localStorage reservations are read only, then preserved as unknown in the new owner record. Historical old Guild operations had no durable keys and cannot be reconstructed by this update.
- README docs describe the new contract. Guild clean-core validator precisely permits the three already-existing native onboarding files and built-in SQLite only from the message reservation owner. Other storage/legacy imports still fail; onboarding execution code is unchanged.

## Reproduction and validation

Actual initial behavioral RED commands:

- Broker: `node --test test/messaging-stability.test.mjs`: 4 failures (concurrent peak 2; restart dispatched twice; changed payload classified duplicate; unrelated sender substring accepted).
- Broker: `node --test test/messaging-live-stability.test.mjs`: 5 failures against a fully intercepted real local Chromium page (wrong first creator; mismatched header; another account sharing display name; optimistic bubble called verified/HTTP 200; existing text lacked explicit unknown result).
- Guild: `node --test --test-name-pattern='stalled launch' test/session-owner.test.mjs`: failed with `hung` rather than bounded timeout.
- Additional RED reproductions: readonly post-restart status required a live binding; legacy localStorage key was clicked again; arbitrary account attribute in chat content was accepted; clean-core rejected the approved native-owner persistence and existing onboarding modules. New operation-store interface tests were also red before its module existed; the actual cross-process/crash behavior is verified by their green child-process tests, not inferred from that missing-module error.

The one grouped review repair also has actual RED commands followed by GREEN:

- `node --test --test-name-pattern='invalid provider status code' test/messaging-live-stability.test.mjs`: null, empty string and false incorrectly verified because Number coerced them to zero. Only explicit integer zero or canonical string "0" now confirms success.
- `node --test --test-name-pattern='opaque' test/messaging-live-stability.test.mjs`: conversation_id and creator_id case mismatches were dispatched. Opaque IDs now compare exact trimmed bytes; only recipient handles normalize case/@.
- `node --test --test-name-pattern='SQLite writer lock' test/operation-store.test.mjs`: pre-dispatch locking exposed ERR_SQLITE_ERROR instead of profile_busy. The real busy/locked codes are now classified.
- `node --test --test-name-pattern='lock after dispatch' test/operation-store.test.mjs`: receipt save/catch/lease deletion locking leaked raw ERR_SQLITE_ERROR and a live-PID lease. The old key now stays unknown and token-fenced cleanup allows a distinct key after lock release.
- `node --test --test-name-pattern='actual native config' test/messaging-live-stability.test.mjs`: fixture-only sender selectors refused the actual DOM shape. Native config + selected-row/header projections now bind the real layout.
- `node --test --test-name-pattern='native row rank|native handle search|native creator UID' test/messaging-live-stability.test.mjs`: native tagged names/search identity were unsupported. Public native response projection, exact UID lookup and nickname children now work.
- `node --test --test-name-pattern='lookup_handle' test/operation-store.test.mjs`: changing the lookup handle was called duplicate instead of a conflict; the durable hash/guard now includes it.
- `node --test --test-name-pattern='stale exact conversation' test/messaging-live-stability.test.mjs`: an exact foreign-account row could be clicked as the current sender. Sender membership now rejects it with zero send clicks.

- `node --test --test-name-pattern='bootstraps at most once' test/messaging-live-stability.test.mjs`: missing config on two attempts caused two page navigations. The observer now remembers the first automatic bootstrap; config-missing attempts navigate once and send zero messages, while two ready distinct operations also navigate once.

Final GREEN (Node v26.4.0), both full suites run together after the final source change:

| Command / directory | Result |
| --- | --- |
| `npm test` / Broker | 57 passed, 0 failed |
| `npm test` / Guild | 109 passed, 0 failed |
| `python3 /Users/yangyucheng/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py .` / Broker | passed |
| same validator / Guild | passed |
| `node scripts/verify-clean-core.mjs` / Guild | passed |

Coverage includes child-process concurrent reservation, process-exit/restart uncertainty, same-key conflict, shared page serialization, scoped sender/recipient checks, no receipt, receipt without message ID, wrong request recipient/conversation, provider rejection, trusted-click uncertainty with exactly one dispatch, old browser marker, readonly reconciliation, workflow capacity/expiry, and pending launch/close fencing. Every browser request in the message fixtures is intercepted; non-fixture URLs are aborted. All operation/session test profiles are temporary.

## Practical limits and release gate

Root independently read the live native IM config/search schema and account/header/selected-row DOM. Its actual read-only CDP preflight passed conversation_id and existing creator_id with the expected official sender UID, rejected wrong sender/creator, made zero send requests and did not touch the composer (`/tmp/stability-20260928-broker-native-preflight.json`). Evidence is in `/tmp/stability-20260928-broker-response-shape-{10,11,12}.json`. This is identity/header verification, not real platform delivery. New qualified search-result selection is exercised only in fully intercepted Chromium; the real observed sample was unqualified and was never selected. Native SDK send payloads/responses remain protobuf; until a reviewed bound receipt can be decoded, they honestly return unknown and keep the key consumed. Other unreviewed/opaque formats fail closed or return unknown. These fixtures and read-only checks do not prove real message delivery. No code was deployed or cache copy updated. Minimum declared Node 22.16 remains unchanged; this machine's test runtime was Node 26.4.0. Independent acceptance belongs to the root agent before any deployment. Reserved keys have no auto-delete or retry API.

## Read-only preflight signature

Import `observeNativeMessaging(page)` from `src/messaging/native-evidence.mjs` before the natural messaging-page navigation. Import `inspectMessagingBinding({ page, senderAccountRef, expectedIdentityText, conversationId, creatorId, recipientHandle })` from `src/messaging/live-write.mjs`; provide exactly one recipient and an already-selected conversation. It returns `{ sender, conversation }` or an actionable authorization error, and performs no navigation/search/fill/click/message write.
