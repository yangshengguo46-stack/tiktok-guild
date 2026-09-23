# Guild Agent 全自动触达与自进化 —— 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把已完成的 Guild Recruitment Agent 扩展为唯一智能主体，让它能从候选名单选择触达渠道、生成精确文案、驱动 Recruiter Worker、处理回复、推进邀约，并从有来源的 OutcomeCase 中产生、灰度、晋级和回滚方法版本。

**Architecture:** 保留现有七个 Guild tools 和原生 Chat，不创建 Conversation Agent、第八个 Guild tool、Dashboard 或卡片。`guild_action` 从只支持消息/邀约扩展到七种触达，并生成与 Worker 完全对齐的 `DispatchRequestV1`。`guild_recruitment` 在既有招募快照、MethodVersion 和 OutcomeCase 上增加有界 work queue 和方法生命周期。真实平台副作用仍只由外部 Worker 执行。

**Tech Stack:** Rust、SQLx/SQLite、Codex extension API、app-server v2 集成测试、`insta` 仅在有用户可见文本快照变化时使用

**Specs:**

- `/Users/yangyucheng/.codex/worktrees/guild-agent-v1/妹子攻略计划/docs/superpowers/specs/2026-09-21-tiktok-recruiter-worker-design.md`
- `/Users/yangyucheng/.codex/worktrees/guild-agent-v1/妹子攻略计划/docs/superpowers/specs/2026-09-21-guild-recruitment-agent-design.md`

## Global constraints

- 现有七个 wire names 一个不增、一个不减。
- 不修改 Wingman 的 crate、数据库、prompt、Chat/UI 或平台工具。
- 不把 Worker 浏览器代码放入 `codex-core`；Guild crate 只保存领域状态和动作信封。
- 一个 creator 第一版只绑定一个 recruiter account，账号故障时暂停，不自动换号。
- 公开触达 confirmed 只是 contact attempt，不能推导 replied/joined/first LIVE。
- `joined` / `first_live` / `stable_active` 仍只接受 Guild Operator 的合格事实 envelope。
- creator 原文始终是 `untrusted_message`，不能直接改 prompt、方法、预算或政策。
- 不增加中文翻译中间层；收到什么语言，Agent 用该语言回复并保存实际原文。
- 所有新的 agent logic 必须有 integration test；SQLite 迁移必须覆盖旧数据升级。
- 每个 task 先失败测试、再最小实现、再定向测试、再提交。

## 固定业务类型

Rust 领域模型与 Worker 的 JSON 名称必须一致：

```rust
pub enum ActionKind {
    VideoLike,
    VideoComment,
    CreatorFollow,
    LiveComment,
    LiveGift,
    Message,
    InvitationCard,
}

pub enum ActionSurface {
    Video { reference: String },
    CreatorProfile { reference: String },
    Live { reference: String },
    Conversation { reference: String },
}

pub enum ActionPayload {
    None,
    Text(String),
    Gift { sku: String },
    Invitation { card_ref: String },
}

pub enum ExecutionResult {
    Confirmed,
    Refused,
    Unknown,
    Unavailable,
    LoginRequired,
    VerificationRequired,
    Challenge,
}
```

`ActionStatus` 保留 `Prepared | Claimed`，并使用上述七个 terminal result 对应的终态。所有终态都阻止同一 envelope 再次 dispatch；只有 Unknown 可由原 receipt 的 reconciliation 附加 confirmed evidence，不改写原始 unknown 事实。

---

### Task 1: 把动作领域模型扩展为七种 surface-bound action

**Files:**

- Modify: `codex-rs/ext/guild-domain/src/action.rs`
- Modify: `codex-rs/ext/guild-domain/src/error.rs`
- Modify: `codex-rs/ext/guild-domain/src/lib.rs`
- Modify: `codex-rs/ext/guild-domain/src/action_account_tests.rs`
- Create: `codex-rs/ext/guild-domain/src/outreach_action_tests.rs`

- [ ] **Step 1: 写失败的完整对象等值测试**

每种 kind 各构造一个 `PreparedAction`，断言 kind/surface/payload 合法组合、creator stable identity、account identity、expiry、max coin cost 和 canonical payload hash。使用 `pretty_assertions::assert_eq!` 比较整个对象。

- [ ] **Step 2: 写不合法组合测试**

至少覆盖：`VideoLike + Text`、`LiveGift + None`、`Message + Video`、非礼物带 max coin cost、礼物不带 max coin cost、空 creator identity、expiry 早于 prepared time。

- [ ] **Step 3: 用 RPITIT/私有 module 约束不适用的边界**

本 task 不新增 trait。把 canonical hash 的输入扩展为 creator identity、account official identity、surface、payload、max coin cost、context/policy/method/expiry，确保同文案不同目标不会共用 hash。

- [ ] **Step 4: 定向测试并提交**

```bash
cd codex-rs
just test -p codex-guild-domain
git add ext/guild-domain
git commit -m "feat(guild): model surface-bound outreach actions"
```

---

### Task 2: 迁移 Guild SQLite 动作信封与 Worker 回执

**Files:**

- Create: `codex-rs/ext/guild-memory/migrations/0005_outreach_actions.sql`
- Modify: `codex-rs/ext/guild-memory/src/action.rs`
- Modify: `codex-rs/ext/guild-memory/src/action_tests.rs`
- Modify: `codex-rs/ext/guild-memory/src/migration_tests.rs`
- Create: `codex-rs/ext/guild-memory/src/outreach_action_tests.rs`

- [ ] **Step 1: 写从 0004 升级的失败测试**

构造包含 message 和 invitation 的 0004 数据库，升级后必须映射为 `Conversation` surface 和对应 payload，原 action/receipt IDs、hash、status 不丢失。

- [ ] **Step 2: 设计 0005 不可变表形**

`prepared_actions` 新增 creator namespace/value、official account identity、surface kind/ref、payload kind/text/SKU/card ref、max coin cost、expiry 和 policy snapshot ID。`execution_receipts` 新增 idempotency key、dispatch state、platform event ID、evidence type/ref/digest、actual coin cost。新 CHECK 锁定 kind/surface/payload 和 result/dispatch-state 组合。

- [ ] **Step 3: 原子 claim 时重新核对账号、assignment、DNC、method 和 expiry**

从 `recruiter_accounts` 读当前 `account_ref + official_account_identity`，从 creator identities 验证稳定身份，并在同一 `BEGIN IMMEDIATE` 内检查不可变 assignment、boundary、policy 新鲜度、method lifecycle 和终态 envelope。

- [ ] **Step 4: 保存七种 Worker 结果和 reconciliation evidence**

`record_receipt` 必须验证 action/idempotency/payload hash 与 Worker 回执相同。新增 `reconcile_unknown` store method，只能给 unknown 附加后续 confirmed evidence，不覆盖原 receipt。

- [ ] **Step 5: 运行测试并提交**

```bash
cd codex-rs
just test -p codex-guild-memory
git add ext/guild-memory
git commit -m "feat(guild): persist outreach envelopes and receipts"
```

---

### Task 3: 在现有 `guild_action` 内暴露完整 dispatch grant

**Files:**

- Modify: `codex-rs/ext/guild/src/action.rs`
- Modify: `codex-rs/ext/guild/src/schema.rs`
- Modify: `codex-rs/ext/guild/src/schema_nested.rs`
- Modify: `codex-rs/ext/guild/src/schema_shapes.rs`
- Modify: `codex-rs/ext/guild/src/instructions.rs`
- Modify: `codex-rs/ext/guild/tests/extension_tools.rs`
- Modify: `codex-rs/ext/guild/tests/runtime_round2.rs`
- Modify: `codex-rs/ext/guild/tests/tool_runtime.rs`
- Modify: `codex-rs/ext/guild/tests/fixtures/messaging-receipts.json`

- [ ] **Step 1: 写失败的 schema 和七工具不变测试**

`guild_action.prepare` 的闭合 schema 必须匹配固定跨计划契约，`guild_action.record_receipt` 匹配 `DispatchReceiptV1`。同时断言 tools/list 仍然只有原来七个 Guild wire names。

- [ ] **Step 2: 实现 `prepare/read/claim/record_receipt/reconcile_unknown`**

`claim` 返回完整 `DispatchRequestV1`，其中 account ref/identity 由 store 中的当前账号生成，不由模型自由传入。响应仍是 plain function output，不发射卡片 item。

- [ ] **Step 3: 增加有界动作查询**

`guild_action` 新增 `list_creator`和 `list_account` action，参数为 ID、status 可选过滤、limit/offset，最多返回 50 条 summary。详情仍通过 `read` section 获取，避免 context 无界增长。

- [ ] **Step 4: 更新 developer instructions**

指令明确 Recruiter Worker 是无 AI 执行器；设计选择、原语言文案、关系推进和方法版本均归 Guild Agent。要求 claim 后根据 kind 调用唯一对应 Worker 工具，再原样记录回执。

- [ ] **Step 5: 运行扩展测试并提交**

```bash
cd codex-rs
just test -p codex-guild-extension
git add ext/guild
git commit -m "feat(guild): dispatch seven recruiter action kinds"
```

---

### Task 4: 建立有界、可租约、creator 串行的自治 work queue

**Files:**

- Create: `codex-rs/ext/guild-domain/src/work.rs`
- Create: `codex-rs/ext/guild-domain/src/work_tests.rs`
- Create: `codex-rs/ext/guild-memory/migrations/0006_recruitment_work.sql`
- Create: `codex-rs/ext/guild-memory/src/work.rs`
- Create: `codex-rs/ext/guild-memory/src/work_tests.rs`
- Modify: `codex-rs/ext/guild-memory/src/lib.rs`
- Modify: `codex-rs/ext/guild/src/recruitment.rs`
- Modify: `codex-rs/ext/guild/src/schema.rs`
- Modify: `codex-rs/ext/guild/src/schema_shapes.rs`
- Modify: `codex-rs/ext/guild/tests/recruitment_flow.rs`

- [ ] **Step 1: 写 work lifecycle 失败测试**

```text
scheduled -> leased -> completed
scheduled -> leased -> deferred
scheduled -> leased -> cancelled
```

覆盖租约过期回收、同 creator 同时只有一个 leased work、同 account 动作排序、DNC 批量取消、回复后取消未执行公开触达。

- [ ] **Step 2: 实现有界 work 模型**

`RecruitmentWork` 字段固定为 work ID、creator ID、account ID、reason、not-before、expires-at、context version、method version、status、lease token/expiry、completion action ID 可选。一次 `lease_due` 最多 20 条，按 priority/not-before/ID 稳定排序。

- [ ] **Step 3: 在 `guild_recruitment` 内增加 queue actions**

```text
schedule_work
lease_due_work
complete_work
defer_work
cancel_work
list_work
```

模型只能安排业务 reason（`new_candidate | inbox_message | live_opportunity | follow_up | outcome_sync | method_evaluation`），不能把自由 prompt 存入 queue。

- [ ] **Step 4: 实现自适应渠道的状态前置，不把策略硬编码成固定序列**

store 提供可验证事实：已有 conversation、已回复、正在 LIVE、有适合 video、公开触达计数、冷却期、DNC、account pause。Agent 基于这些事实选择下一步；确定性 gate 强制“已回复后不再公开触达”、“两次公开触达无响应后冷却”和 DNC。

- [ ] **Step 5: 运行测试并提交**

```bash
cd codex-rs
just test -p codex-guild-domain
just test -p codex-guild-memory
just test -p codex-guild-extension
git add ext/guild-domain ext/guild-memory ext/guild
git commit -m "feat(guild): schedule serialized recruitment work"
```

---

### Task 5: 把 inbox 和公开观察变成可追溯证据

**Files:**

- Modify: `codex-rs/ext/guild-domain/src/creator.rs`
- Modify: `codex-rs/ext/guild-memory/src/creator.rs`
- Modify: `codex-rs/ext/guild-memory/src/message_tests.rs`
- Modify: `codex-rs/ext/guild/src/record.rs`
- Modify: `codex-rs/ext/guild/src/schema.rs`
- Modify: `codex-rs/ext/guild/src/schema_shapes.rs`
- Modify: `codex-rs/ext/guild/src/context.rs`
- Create: `codex-rs/ext/guild/tests/inbox_outreach_flow.rs`

- [ ] **Step 1: 写跨源身份和重放测试**

同一 Worker message ID 重放必须 `AlreadyPresent`；同 conversation 指向另一 creator 必须 Ownership error；不同 creator 的证据不得进入当前 context。

- [ ] **Step 2: 把 source 名称从 `recruiter_messaging` 迁移为 `recruiter_worker`**

新数据只写 `recruiter_worker`；历史数据仍可读，但不再生成旧名称。identity namespace 保留它的 wire value 以避免不必要的数据破坏，在注释中明确为 legacy namespace。

- [ ] **Step 3: 新增 `guild_record.observation` 闭合 action**

只接受 Worker 返回的 account/creator/surface state、source ref、observed-at、completeness 和 digest，不接受任意 HTML/JSON blob。原 creator text 继续经 `message` 保存，并在 context 输出中显式标记 `trust: "untrusted_message"`。

- [ ] **Step 4: 回复、拒绝与 DNC 触发确定性副作用**

新 inbound message 会取消 scheduled public touches；Agent 可建立 replied snapshot。明确拒绝必须先保存原文 evidence，再由 `guild_record.boundary` 写 declined/DNC，随后 store 原子取消该 creator 所有未执行 work。

- [ ] **Step 5: 运行测试并提交**

```bash
cd codex-rs
just test -p codex-guild-extension inbox_outreach_flow
git add ext/guild-domain ext/guild-memory ext/guild
git commit -m "feat(guild): ingest untrusted worker observations"
```

---

### Task 6: 实现版本化方法的 candidate/canary/active/rollback 生命周期

**Files:**

- Modify: `codex-rs/ext/guild-domain/src/recruitment.rs`
- Create: `codex-rs/ext/guild-domain/src/method_lifecycle_tests.rs`
- Create: `codex-rs/ext/guild-memory/migrations/0007_method_lifecycle.sql`
- Modify: `codex-rs/ext/guild-memory/src/method.rs`
- Modify: `codex-rs/ext/guild-memory/src/case.rs`
- Create: `codex-rs/ext/guild-memory/src/method_evaluation.rs`
- Create: `codex-rs/ext/guild-memory/src/method_evaluation_tests.rs`
- Modify: `codex-rs/ext/guild/src/recruitment.rs`
- Modify: `codex-rs/ext/guild/src/schema.rs`
- Modify: `codex-rs/ext/guild/src/schema_shapes.rs`

- [ ] **Step 1: 写方法状态机失败测试**

```text
candidate -> replay_passed -> canary -> active -> retired
candidate/replay_passed/canary -> rejected
canary/active -> rolled_back
```

断言只有一个 active version；没有固定回放证据不能 canary；没有真实 OutcomeCase 不能 active；creator 原文不能成为 method term 或 source ref。

- [ ] **Step 2: 固定回放套件和结果类型**

回放必须 100% 通过：错 account、错 creator、DNC、重复 dispatch、unknown 重发、预算超限、政策过期、prompt injection、平台 challenge、公开触达误当转化。回放为结构化 cases，不把攻击文本拼进 developer prompt。

- [ ] **Step 3: 实现确定性 canary 分配**

只在已绑定的单账号内按 `sha256(creator_id + method_version_id) % 100 < cohort_percent` 选取 cohort，首次 canary 为 10%。creator 进入某 method cohort 后不在当进程中换版本。

- [ ] **Step 4: 实现自动晋级和回滚 gate**

候选版本至少经过 7 天且至少有 20 个 confirmed contact attempts 才可晋级。晋级要求：有效回复率高于 active baseline，同时 DNC、platform refusal、unknown、challenge 每百次接触率均不高于 baseline，cost per reply 不高于 baseline。任一安全率恶化 2 个百分点、连续 3 个 unknown、或出现 account challenge 立即回滚。样本不足保持 canary，不伪装结论。

- [ ] **Step 5: 在 `guild_recruitment` 内暴露方法生命周期 actions**

```text
propose_method_version
record_replay_result
start_method_canary
evaluate_method_canary
promote_method_version
rollback_method_version
get_method_status
```

`promote` 和 `rollback` 只执行 store 已计算的 gate，不信任模型传入的指标。

- [ ] **Step 6: 运行测试并提交**

```bash
cd codex-rs
just test -p codex-guild-domain method
just test -p codex-guild-memory method
just test -p codex-guild-extension method
git add ext/guild-domain ext/guild-memory ext/guild
git commit -m "feat(guild): evolve recruitment methods safely"
```

---

### Task 7: 实现端到端自动闭环回归

**Files:**

- Create: `codex-rs/ext/guild/tests/fixtures/worker-read-batches.json`
- Create: `codex-rs/ext/guild/tests/fixtures/worker-outreach-receipts.json`
- Create: `codex-rs/ext/guild/tests/fixtures/method-canary-cases.json`
- Create: `codex-rs/ext/guild/tests/autonomous_outreach_flow.rs`
- Modify: `codex-rs/ext/guild/tests/recruitment_flow.rs`
- Modify: `codex-rs/app-server/tests/suite/v2/guild_extension.rs`

- [ ] **Step 1: 写主成功流程测试**

```text
TKDesk handoff
-> recruiter account assignment
-> creator observation
-> one public touch
-> inbound reply
-> public work cancelled
-> original-language message
-> invitation
-> Guild Operator joined
-> Guild Operator first LIVE
-> OutcomeCase
```

测试必须在进程重启后继续，并比较完整 creator context、action ledger、work queue 和 outcome case。

- [ ] **Step 2: 写敌对和并发流程测试**

覆盖两 creator 不串数据、同 creator 不并发公开/私聊动作、恶意消息要求读文件/改 prompt/发第二次、DNC、过期政策、错账号、unknown、challenge、contract drift、礼物超预算。

- [ ] **Step 3: 验证 app-server 仍只注册七个原生 Guild tools**

测试 Responses request 中的 developer context 包含 Recruiter Worker、untrusted message、DNC、unknown 不重发和原语言要求，不包含 Wingman、卡片或通用 browser 指令。

- [ ] **Step 4: 跑定向集成测试**

```bash
cd codex-rs
just test -p codex-guild-extension
just test -p codex-app-server guild_extension
```

Expected: 定向测试全绿。由于修改了共享的 app-server 测试面，执行者在运行完整 `just test` 前必须根据项目指令向用户确认。

- [ ] **Step 5: 提交闭环验收**

```bash
git add ext/guild app-server/tests/suite/v2/guild_extension.rs
git commit -m "test(guild): cover autonomous recruitment loop"
```

---

### Task 8: 格式化、静态修复与最终审查

**Files:**

- Modify as required by formatter/lints: changed Rust files only

- [ ] **Step 1: 检查 diff 规模和拆分点**

```bash
git diff --stat 77a18d6eed
git diff --numstat 77a18d6eed
```

Expected: 每个功能提交保持可审查；非机械性单提交若超 500 行，在当前 task 边界内再拆小，不混入下一 task。

- [ ] **Step 2: 运行定向 `fix` 和自动格式化**

```bash
cd codex-rs
just fix -p codex-guild-domain
just fix -p codex-guild-memory
just fix -p codex-guild-extension
just fmt
```

按项目规则，`fix`/`fmt` 后不重跑测试；保留之前通过的测试证据。

- [ ] **Step 3: 检查不该变的边界**

```bash
git diff --name-only 77a18d6eed | rg 'wingman|tui|core/src|app-server-protocol'
```

Expected: 无输出。`app-server` 只允许测试文件变化，不新增 v1/v2 API。

- [ ] **Step 4: 提交格式化结果**

```bash
git add codex-rs
git commit -m "style(guild): format autonomous outreach"
```

## Acceptance

- Guild Agent 仍是唯一智能主体，Recruiter Worker 只是确定性手脚。
- 现有七个 Guild tools 保持不变，`guild_action` 支持七种触达并产生完整 `DispatchRequestV1`。
- 同 creator 动作串行；已回复则停止公开触达；DNC 取消全渠道未执行工作。
- 公开动作、回复、邀请、入会和首播依据各自权威源，不发生结果升格。
- 方法版本只能经回放、固定 canary、确定性指标 gate 晋级，可自动回滚，不从单条主播消息直接学习全局规则。
- 没有新卡片、Dashboard、翻译流水线、通用浏览器工具或 Wingman 污染。
