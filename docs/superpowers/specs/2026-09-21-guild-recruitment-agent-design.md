# Guild Recruitment Agent Design

Date: 2026-09-21

Source and plugin audit: `docs/superpowers/specs/2026-09-21-guild-agent-source-and-plugin-audit.md`

## 1. Goal

Build a TikTok LIVE guild recruitment agent that turns real creator candidates into joined guild creators through persistent, context-aware conversation.

The product has one visible interface: the native Codex Chat. There is no guild dashboard, custom card system, or second agent UI.

The system must ground its decisions in three operational sources:

- TKDesk supplies creator discovery and qualification evidence.
- TikTok LIVE Guild Operator supplies guild, invitation, joining, and post-join business facts.
- TikTok Recruiter Messaging supplies recruiter-account conversations, text sending, invitation-card sending, and delivery evidence.

The agent supplies the reasoning layer: creator memory, conversation understanding, recruitment-stage judgment, account selection, response generation, follow-up, and reuse of successful and failed cases. It retains the original digital-employee loop rather than reducing Wingman to a chat prompt.

## 2. Product shape

The user interacts only through native Codex Chat:

```text
User request or scheduled recruitment work
                    |
                    v
          Guild Recruitment Agent
           /          |           \
      TKDesk     Guild Operator    Recruiter Messaging
           \          |           /
                    v
          Guild recruitment memory
```

`Chat` and `Guild Recruitment Agent` are not separate products. Chat is the existing interface. The guild extension contributes the domain instructions, memory, and tools used behind that interface.

## 3. Isolation from Wingman

The guild product is a separate Codex extension, not a `guild_mode` inside the existing Wingman extension.

Runtime isolation:

- Dating Wingman continues to use `WINGMAN_HOME`.
- Guild Recruitment Agent uses `GUILD_AGENT_HOME`.
- TikTok Organization Accounts remain owned by TikTok's official LIVE Backstage/Business Center permission system; the guild runtime stores only opaque account references and observed capabilities.
- Guild and dating databases never share records.

The guild dependency and test path must not include:

- Wingman cards or card emitters;
- the `/wingman` TUI panel;
- Wingman-specific app-server UI RPCs;
- Xiaohongshu, Douyin, or Soul browser adapters;
- dating UI copy or dating-only instructions.

Existing Wingman UI and card code remains untouched. It is not deleted as part of this project, but it is not registered, compiled as a guild dependency, or required by guild acceptance tests.

## 4. Reused Wingman concepts

The guild implementation reuses proven concepts without exposing dating terminology to the user:

| Wingman concept | Guild meaning |
|---|---|
| `Person` | Creator identity |
| `Interaction` | Creator conversation event |
| `Evidence` | Sourced message or platform fact |
| `RelationshipSnapshot` | Current recruitment state |
| `OpenLoop` | Follow-up item or unanswered question |
| `Commitment` | Creator or guild-side promise |
| `Boundary` | Refusal, pause, opt-out, or do-not-contact state |
| `Candidate` | Creator candidate |
| `Qualification` | Recruitment qualification |
| `Opportunity` | Actionable recruitment opportunity |
| `SelfProfileAudit` | Recruiter-account profile audit |
| `Action` and `Receipt` | Message/invitation intent and platform result |

Reuse is selective. The guild extension may depend on focused reusable domain or memory code, but it must not depend on the Wingman extension or its presentation stack. If a reused unit cannot be consumed without pulling in cards, TUI, dating instructions, or platform adapters, implement a small guild-owned equivalent instead of adding that dependency.

The inherited shape is the general digital-employee loop: one Lead, durable state, sourced facts, qualification, relationship progression, next action, one execution, a receipt, an outcome, and versioned method improvement. Dating knowledge is only one former industry pack and is not part of the guild runtime.

## 5. Subsystem A: Guild Recruitment Agent

### 5.1 Responsibilities

The guild agent owns:

- importing a frozen TKDesk creator batch idempotently;
- creator identities and source provenance;
- recruitment qualification snapshots;
- conversation history and evidence;
- recruitment stage and responsible recruiter account;
- creator concerns, commitments, open loops, and next action;
- recruiter-account profiles and profile audits;
- recruitment methods and successful/failed cases;
- versioned guild-policy facts used in creator-facing claims;
- cross-source identity links between TKDesk, messaging, and Guild Operator;
- on-demand use of the complete Guild Operator business surface when it can change a recruitment decision;
- message drafts and, when messaging is available, calls to the messaging plugin;
- reconciliation of invitation, joining, first-LIVE, and later activity facts from Guild Operator.

It does not own:

- TikTok credentials, cookies, tokens, or QR contents;
- low-level browser navigation;
- the full TKDesk candidate database;
- guild financial or roster data already owned by Guild Operator;
- Organization Account creation, ownership, member permissions, credentials, content production, or account nurturing.

### 5.2 Tools

The guild extension exposes a small function-tool surface:

| Tool | Responsibility |
|---|---|
| `guild_creator` | Import, update, find, and read creator identities and TKDesk provenance |
| `guild_record` | Append messages, facts, inferences, commitments, refusals, and outcomes |
| `guild_context` | Return bounded current recruitment context for one creator |
| `guild_recruitment` | Set stage, assign recruiter account, and manage follow-up work |
| `guild_recruiter_account` | Manage multiple recruiter-account profiles, positioning, and material references |
| `guild_account_audit` | Version recruiter-account audits and recommendations |
| `guild_action` | Prepare an exact message or invitation transport envelope, claim it once, and record the messaging receipt |

TKDesk and Guild Operator remain directly callable MCP tools. The guild extension must not duplicate their complete interfaces behind wrapper tools.

### 5.3 Recruitment stages

The first version uses the following stages:

```text
discovered
ready_to_contact
contacted
replied
interested
ready_to_invite
invited
joined
activated
stable

declined
paused
do_not_contact
```

Stage changes must retain their source and observed time. `invited`, `joined`, `activated`, and `stable` may be proposed from conversation evidence, but are confirmed only by the responsible TikTok operational source.

### 5.4 Creator import

The preferred integration boundary is a frozen TKDesk handoff dataset. The import key is:

```text
batchId + datasetHash + candidateId
```

Re-importing the same dataset is idempotent. A changed hash for the same batch is a conflict and is not silently merged.

The guild database stores only fields needed for recruitment, including:

- stable source identity and handle;
- country, language, and current known profile facts;
- qualification result and evidence;
- source run, batch, adapter version, and observation time;
- unknown fields without converting them to false or zero;
- current recruitment stage and assigned recruiter account.

TKDesk remains authoritative for discovery and qualification. The guild agent may record later evidence but does not rewrite the historical TKDesk result.

### 5.5 Cross-source creator identity

One creator may have separate identifiers in TKDesk, the instant-message surface, and Guild Operator. The guild database records an explicit `CreatorIdentityLink` for each source:

```text
creatorId
sourceKind
sourceIdentity
observedHandle
linkedAt
evidence
```

Stable platform identifiers take priority. A handle may support a proposed link, but a display name alone never merges records. A conflicting stable identifier blocks the link and leaves the records separate until stronger evidence is available.

### 5.6 Recruiter accounts

One guild may have multiple TikTok Organization Accounts. The first release uses
TikTok's official account model rather than a self-built account cloud-control
system: the organization owns the accounts, and official roles control which
members may use them. Each account records:

- stable local reference and the platform-side Organization Account identity;
- whether TikTok reports it as an Official Account or Affiliate Account;
- the official owner scope, observed operator permission, and capability status;
- country and language positioning;
- target creator segments;
- profile version and material references;
- latest profile audit;
- current messaging availability and observed account health;
- active assignment count and recent send usage when reported by the messaging plugin.

A creator has at most one current responsible recruiter account. Reassignment is explicit and auditable so two accounts do not contact the same creator concurrently.

### 5.7 Recruiter-account audit

The audit adapts Wingman's `SelfProfileAudit` mechanics to recruiter accounts. It covers:

- nickname, avatar, bio, and visible guild positioning;
- language and country fit;
- credibility and trust evidence;
- clarity about what the guild can actually provide;
- missing material and recommended content;
- suggested bio and next content item;
- statements that could look misleading, spam-like, or unsupported.

Audits are versioned against the exact account profile and material versions they read. Profile or material changes make an older audit stale. Audit results are returned in native Chat text; they do not emit Wingman cards.

### 5.8 Conversation intelligence

The agent applies the original Wingman conversation model to guild recruitment:

- preserve verbatim creator messages separately from inference;
- infer interest, concern, refusal, and unresolved questions with cited evidence;
- adapt language and tone to the creator and recruiter account;
- remember commitments and follow-up dates;
- decide whether to reply, invite, wait, pause, or stop;
- retrieve similar successful and failed cases before drafting when relevant.

`RecruitmentSnapshot` retains the explainable relationship dimensions already proven in Wingman: reciprocity, initiative balance, responsiveness, momentum, and interaction depth. These describe observed recruitment conversation behavior; they are not a join-probability score.

The first version does not introduce a reward platform, model fine-tuning, or self-modifying code. Improvement comes from versioned methods and cases grounded in observed outcomes. Later conversations retrieve those cases and adjust the next action.

Creator-facing claims about guild benefits, activities, rewards, or support cite a `GuildPolicySnapshot` containing the source, applicable country or creator tier, observed time, and policy version or source hash. The agent may speak naturally in the creator's language, but it does not reuse an expired or inapplicable policy snapshot. The original creator message and the exact sent reply are stored as written; no intermediate Chinese translation record is required.

### 5.9 Guild Backstage as an on-demand fact source

The agent uses Guild Operator directly rather than copying its eight business domains into guild-owned tools.

- Before first contact, it may read creator, relationship, and recruitment state to suppress already managed, invited, or actively followed-up creators.
- Recruitment priority may use guild, recruitment, creator, revenue-task, and team metrics to distinguish a roster shortage from an activation problem.
- A `GuildPolicySnapshot` may cite current activities, Flare Card, Promote, incentive, country, tier, permission, or governance facts only from the responsible live domain.
- Before an invitation, it reads current invitation state, the applicable quota or lane, and required account permission.
- After joining, it uses creator, LIVE activity, and intelligence facts to confirm first LIVE, activation, and stable activity.

Guild Operator results retain their `status`, `evidence`, `completeness`, `pagination`, and `errors`. The agent stores only sourced facts used in a decision, not a mirror of raw Backstage responses. A one-page or `not_proven` result never becomes a guild-wide fact.

## 6. Subsystem B: TikTok Recruiter Messaging

### 6.1 Responsibilities

The messaging plugin owns the browser and message transport boundary, but not
the account registry. Account creation, ownership, multi-user login, and member
permissions remain in TikTok Organization Accounts. The plugin:

- discovers authorized Organization Accounts from the official surface and
  maps them to opaque `account_ref` values;
- uses an authorized official member session and verifies the active
  Organization Account before every read or write;
- defers manual login, PIN, security verification, and permission changes to
  the official TikTok window;
- passive login and account-identity checks;
- conversation listing and unread state;
- cursor-based inbox synchronization and notification of newly observed messages;
- bounded message-history reads;
- sending one text message;
- sending one invitation card;
- verifying the resulting message or card in the conversation;
- returning a structured receipt or an explicit unknown result.

It does not decide what to say, which creator to prioritize, or when a creator has joined the guild.

### 6.2 Existing foundation

TikTok LIVE Guild Operator already identifies the official route:

```text
/portal/anchor/instant-messages
```

and exposes read-only `list_conversations` and `get_messages` operations through an authenticated persistent Playwright profile. The new messaging plugin may reuse reviewed session and page-reading patterns, but it remains a separate plugin because:

- Guild Operator must stay read-only;
- messaging needs write-capable tools;
- messaging must support multiple official Organization Accounts without
  inventing a second account-ownership or permission system;
- messaging tests and release gates are different from guild analytics.

The current Guild Operator messaging views have no reviewed response-path mapping and depend on bounded visible-DOM evidence. They are not the transport contract for the new plugin. Messaging implementation begins with a live, read-only contract capture for the current instant-message page, then adds write operations against that observed contract.

### 6.3 Tools

The messaging plugin exposes high-level operations only:

| Tool | Responsibility |
|---|---|
| `list_accounts` | Read authorized Organization Accounts and their observed official capabilities |
| `account_status` | Passive status, type, permission, and current platform identity for one account |
| `start_login` | Open the official TikTok member-login flow when the current session is unavailable |
| `check_login` | Verify login after the user finishes the official flow |
| `list_conversations` | Read a bounded page of conversation summaries |
| `sync_inbox` | Continue from a stored account cursor and return only newly observed messages and the next cursor |
| `get_messages` | Read a bounded page of one explicit conversation |
| `send_message` | Send one exact text to one exact conversation |
| `send_invitation_card` | Send one platform invitation card to one exact conversation |
| `verify_send` | Reconcile an earlier ambiguous attempt without resending it |

The plugin exposes no arbitrary click, selector, evaluate, request, cookie, token, or script primitive.

### 6.4 Inbox synchronization and wakeup

Each official Organization Account has an opaque inbox cursor owned by the messaging plugin. `sync_inbox` returns new messages plus the next cursor; committing the cursor happens only after Guild Recruitment Agent has persisted those messages idempotently.

The scheduler or heartbeat calls `sync_inbox` for active accounts. A non-empty result wakes the same guild agent context for the affected creator. Empty polls remain silent. A repeated page or repeated wakeup is safe because message identity is idempotent in guild memory.

### 6.5 Account and recipient binding

Every read or write identifies an `account_ref`. Every write also identifies a `conversation_ref` and expected creator identity.

Immediately before a write, the plugin confirms:

- the active official member session is authorized for `account_ref`;
- the selected Organization Account identity exactly matches `account_ref`;
- the open conversation matches `conversation_ref` and the expected creator;
- the latest known conversation position is not contradicted by a different recipient.

This is a correctness check, not a per-message approval workflow.

### 6.6 Sending semantics

Sending is one dispatch:

1. Resolve the exact control without clicking it.
2. Bind the request to the account, conversation, creator, and payload.
3. Click or submit once.
4. Inspect the resulting conversation or platform response.
5. Return `sent` only with platform-visible evidence.

If the dispatch may have happened but cannot be verified, return `unknown`. Do not click again and do not automatically resend. `verify_send` may inspect the conversation later but cannot submit the payload.

Invitation cards follow the same one-dispatch rule. The plugin distinguishes unavailable cards, exhausted eligibility or quota, platform refusal, confirmed delivery, and unknown delivery.

### 6.7 Result states

The first release uses explicit states:

```text
login_required
verification_required
conversation_not_found
recipient_mismatch
invitation_unavailable
rate_limited
sent
unknown
```

Errors preserve the last safe state. Missing data is unknown rather than false or zero.

## 7. End-to-end flow

```text
TKDesk frozen candidate batch
        |
        v
Idempotent creator import
        |
        v
Assign recruiter account
        |
        v
Read creator, guild, account, and similar-case context
        |
        v
Read an applicable GuildPolicySnapshot
        |
        v
Draft next recruitment message
        |
        v
Recruiter Messaging sends and verifies once
        |
        v
Incoming reply becomes Interaction + Evidence
        |
        v
Update RecruitmentSnapshot, OpenLoops, Commitments, and stage
        |
        +----> continue conversation
        |
        +----> send invitation card
        |
        v
Guild Operator confirms invitation, joining, activation, and activity
        |
        v
Store outcome as a retrievable success or failure case
```

When no user request is active, the same flow begins with the scheduled `sync_inbox` wakeup rather than a manual Chat message.

Before the messaging plugin passes live acceptance, the same agent flow can stop at a draft and accept manually recorded replies. Adding the messaging handler must not require migrating creator memory or changing the recruitment model.

## 8. Native Chat behavior

Native Codex Chat is the only product interface. Example requests include:

```text
Import the approved TKDesk batch and start with the best 20 creators.
Which creators need a reply today?
Continue the conversation with this creator.
Send the invitation card when the conversation is ready.
Audit our Arabic recruiter accounts and tell me which one should contact this creator.
Which approaches are producing replies but not guild joins?
```

The agent answers with ordinary Markdown text, short lists, or tables. It reads detailed creator records from the responsible tool when needed rather than maintaining a custom dashboard.

## 9. Official account-management and deferred-content boundary

Account ownership and access use TikTok Organization Accounts. Official Accounts
represent the guild, while Affiliate Accounts represent recruiters or other
authorized representatives. LIVE Backstage/Business Center remains authoritative
for account creation, ownership, member access, PIN/security controls, and
capability availability. The guild database keeps references and audit results;
it never stores TikTok passwords, verification codes, cookies, or a competing
permission model.

The following work is explicitly deferred:

- automated Organization/Affiliate Account creation or permission changes;
- account nurturing and all content production or publishing;
- routine profile maintenance;
- operational account-health actions outside the messaging session.

The first messaging release assumes the official account and member permission
already exist. It operates the available official instant-message or Professional
Inbox surface after the user completes TikTok's login flow. Because Professional
Inbox entitlement can vary by account, unavailable capability is reported rather
than replaced with unofficial account automation. A later content module can be
installed without migrating creator memory or changing the recruitment model.

## 10. Error handling and truth boundaries

The system keeps operational facts separate from agent judgment:

- TKDesk confirms discovery and qualification evidence.
- Recruiter Messaging confirms message and invitation-card delivery.
- Guild Operator confirms invitation state, joining, first LIVE, and later performance.
- The current `GuildPolicySnapshot` confirms the benefits, activities, rewards, and support the agent may describe as facts.
- The guild agent may infer intent and recommend a next action, but cannot manufacture any of those external facts.

Partial tool failures do not erase successful evidence from other sources. The agent reports which source was unavailable and limits only conclusions that depend on it.

Technical safeguards remain narrow:

- do not contact a creator in `do_not_contact`;
- do not send the same unresolved payload again after an unknown result;
- do not allow two accounts to own the same active creator assignment;
- do not expose authentication material to the model;
- do not claim an invitation or join without the responsible platform evidence.

These safeguards protect correctness and account integrity. They do not add per-message human approval or a separate policy engine.

## 11. Testing strategy

### 11.1 Guild agent

Package-scoped tests cover:

- idempotent TKDesk batch import and changed-hash conflict;
- two creators and two recruiter accounts never mixing identities or records;
- interaction, inference, commitment, boundary, and follow-up persistence across restart;
- stage provenance and platform-confirmed stage transitions;
- stable cross-source identity linking and display-name-only refusal;
- country/tier applicability and staleness of guild-policy snapshots;
- recruiter-account audit versioning and stale detection;
- bounded context output;
- native function-tool registration only when `GUILD_AGENT_HOME` is set;
- absence of Wingman cards, TUI, and dating instructions from the guild registry.

### 11.2 Messaging plugin

A loopback fixture that models the reviewed instant-message surface covers:

- account-profile isolation;
- login-required and verification-required states;
- conversation listing and message pagination;
- cursor-based inbox synchronization, cursor commit after persistence, and duplicate wakeup safety;
- correct account and recipient binding;
- confirmed text sending;
- confirmed invitation-card sending;
- platform refusal and rate limiting;
- post-dispatch ambiguity returning `unknown`;
- `verify_send` reconciling without resending;
- no secret material in results or logs.

### 11.3 Integration

One deterministic local flow covers:

```text
TKDesk-shaped candidate batch
-> creator import
-> recruiter assignment
-> first message
-> simulated creator reply
-> changed recruitment snapshot
-> invitation card
-> Guild Operator-shaped joined result
-> persisted outcome case
```

Guild tests run only the guild packages and messaging plugin packages. They do not run Wingman card snapshots, TUI tests, or Xiaohongshu/Douyin/Soul browser tests.

### 11.4 Live acceptance

After fixture acceptance, one manually logged-in test recruiter account validates:

- current account identity;
- one bounded conversation read;
- one explicitly selected test conversation;
- one text send with a confirmed receipt;
- one invitation-card send when the official account and target are eligible;
- restart and reattachment to the same isolated account profile.

Live acceptance does not perform bulk outreach and does not bypass TikTok login, CAPTCHA, verification, quota, or rate-limit controls.

## 12. Delivery sequence

The design is implemented as independently reviewable stages:

1. Guild domain, storage isolation, creator import, and recruiter accounts.
2. Conversation memory, recruitment state, native Chat tools, and account audit.
3. Recruiter Messaging read path with multi-account sessions and fixtures.
4. Text sending, invitation-card sending, verification, and receipts.
5. End-to-end integration with TKDesk-shaped and Guild Operator-shaped evidence.
6. One bounded live acceptance pass after the user completes official login.

No stage requires implementing a custom dashboard or the later logistics and operations module.

## 13. Acceptance criteria

The first release is complete when all of the following are true:

1. One frozen TKDesk dataset imports without duplicate creators, and a changed dataset hash is rejected as a conflict.
2. Two official Organization Accounts have isolated identities, cursors, conversations, and send results, while ownership and permissions remain in TikTok.
3. The agent can use sourced creator facts to generate and send a first message through the correct account.
4. A new creator reply is persisted and changes the next recruitment action.
5. An invitation card is sent once to the correct creator and results in either a confirmed receipt or an explicit unknown state.
6. Joined status is accepted only from Guild Operator evidence.
7. Creator context, recruiter assignment, follow-up work, and outcomes survive process restart.
8. A new inbox message wakes the responsible guild context once and remains idempotent when the same page is observed again.
9. TKDesk, messaging, and Guild Operator records link through stable source identities rather than display-name matching.
10. Creator-facing policy claims retain an applicable, current source snapshot.
11. Guild package tests do not require Wingman cards, TUI, or dating platform adapters.
12. The product is usable entirely from native Codex Chat.
