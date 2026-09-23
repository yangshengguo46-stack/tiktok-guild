# 公会招募数字员工内核 —— 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有 Codex fork 中加入一个与 Wingman 完全隔离、只通过原生 Chat 工作的 TikTok LIVE 公会招募数字员工；它直接消费 TKDesk handoff、按需调用 Guild Operator 和 Recruiter Messaging，并持久保存主播关系、招募阶段、账号包装、动作回执与结果案例。

**Architecture:** 新建 `codex-guild-domain`、`codex-guild-memory`、`codex-guild-extension` 三个 crate。保留 Wingman 已验证的行为契约，但不依赖 `codex-wingman-extension`、Wingman SQLite、卡片、TUI 或恋爱平台适配器。`GUILD_AGENT_HOME` 是唯一启用门，公会数据写入独立 SQLite。外部插件仍由 Codex MCP 直接调用；公会扩展只拥有长期业务状态、判断所需的有来源事实和一次性动作账本。

**Tech Stack:** Rust、SQLx/SQLite、Codex extension API、MCP tools、`insta` 仅在确有用户可见 UI 变化时使用

**Specs:**

- `/Users/yangyucheng/Documents/ChatGPT/妹子攻略计划/docs/superpowers/specs/2026-09-21-guild-recruitment-agent-design.md`
- `/Users/yangyucheng/Documents/ChatGPT/妹子攻略计划/docs/superpowers/specs/2026-09-21-guild-agent-source-and-plugin-audit.md`

## Global constraints

- 不修改或复用 Wingman 的 `WINGMAN_HOME`、数据库和运行状态；公会版只认 `GUILD_AGENT_HOME`。
- 不添加 Dashboard、卡片或 `/wingman` UI；所有结果返回原生 Chat 文本/结构化 tool result。
- 不复制 Guild Operator 的八个业务域，也不镜像其原始响应。
- 不重建 TKDesk 候选 schema；输入契约固定为 `tkdesk.candidate-handoff.v4`。
- 不把展示名作为跨系统自动合并依据；稳定平台 ID 冲突必须拒绝合并。
- `partial`、`not_proven`、过期或国家/层级不适用的后台事实不能升级成确定结论。
- 发送动作只 claim 一次；`unknown` 不自动重发。
- 每个 crate 的新测试模块放在独立 `*_tests.rs` 文件；优先整体对象比较。
- 每个实现批次控制在可审查规模，复杂逻辑批次尽量低于 500 行。

---

### Task 1: 建立独立公会 domain crate

**Files:**

- Create: `codex-rs/ext/guild-domain/Cargo.toml`
- Create: `codex-rs/ext/guild-domain/BUILD.bazel`
- Create: `codex-rs/ext/guild-domain/src/lib.rs`
- Create: `codex-rs/ext/guild-domain/src/ids.rs`
- Create: `codex-rs/ext/guild-domain/src/creator.rs`
- Create: `codex-rs/ext/guild-domain/src/recruitment.rs`
- Create: `codex-rs/ext/guild-domain/src/action.rs`
- Create: `codex-rs/ext/guild-domain/src/policy.rs`
- Create: `codex-rs/ext/guild-domain/src/domain_tests.rs`
- Modify: `codex-rs/Cargo.toml`

- [ ] **Step 1: 写失败测试，固定公会业务不变量**

覆盖：主播稳定身份、`CreatorIdentityLink` 冲突、Evidence/Inference 分离、RecruitmentSnapshot 五个关系维度、拒绝/DNC 边界、招募阶段来源、政策适用范围、一次性 Action 与 `unknown` 结果。

```bash
cd codex-rs
just test -p codex-guild-domain
```

Expected: crate 尚未存在或新测试失败。

- [ ] **Step 2: 实现最小纯 domain 类型**

保持无 I/O、无模型调用。类型至少包含：`Creator`、`CreatorIdentityLink`、`Interaction`、`Evidence`、`Inference`、`OpenLoop`、`Commitment`、`Boundary`、`RecruitmentStage`、`RecruitmentSnapshot`、`RecruiterAccount`、`RecruiterAccountAudit`、`GuildPolicySnapshot`、`PreparedAction`、`ExecutionReceipt`、`OutcomeCase`。

- [ ] **Step 3: 通过 domain 测试并提交**

```bash
cd codex-rs
just test -p codex-guild-domain
git add Cargo.toml ext/guild-domain
git commit -m "feat(guild): add recruitment domain contracts"
```

---

### Task 2: 建立独立 SQLite 记忆层

**Files:**

- Create: `codex-rs/ext/guild-memory/Cargo.toml`
- Create: `codex-rs/ext/guild-memory/BUILD.bazel`
- Create: `codex-rs/ext/guild-memory/src/lib.rs`
- Create: `codex-rs/ext/guild-memory/src/creator.rs`
- Create: `codex-rs/ext/guild-memory/src/recruitment.rs`
- Create: `codex-rs/ext/guild-memory/src/account.rs`
- Create: `codex-rs/ext/guild-memory/src/action.rs`
- Create: `codex-rs/ext/guild-memory/src/case.rs`
- Create: `codex-rs/ext/guild-memory/src/store_tests.rs`
- Create: `codex-rs/ext/guild-memory/migrations/0001_guild_store.sql`
- Modify: `codex-rs/Cargo.toml`

- [ ] **Step 1: 写失败的重启与幂等集成测试**

测试必须覆盖：同一 handoff 重放不重复、消息 ID 重放不重复、两个经纪人账号不串人、边界不能被快照覆盖、claim 只能成功一次、`unknown` 重启后仍不允许自动重发、上下文读取有硬上限。

- [ ] **Step 2: 实现 `GuildStore::open(home)` 和首版迁移**

数据库文件固定为 `guild-agent.sqlite`。使用 `codex-state` SQLite 配置，不直接拼接默认 Codex home。表按领域拆分，原话与推断分表，外部事实保存来源、观察时间、适用范围、完整性和源哈希。

- [ ] **Step 3: 通过记忆层测试并提交**

```bash
cd codex-rs
just test -p codex-guild-memory
git add Cargo.toml ext/guild-memory
git commit -m "feat(guild): persist isolated recruitment memory"
```

---

### Task 3: 接入 TKDesk v4 handoff 和跨源身份

**Files:**

- Create: `codex-rs/ext/guild-domain/src/handoff.rs`
- Create: `codex-rs/ext/guild-memory/src/handoff.rs`
- Create: `codex-rs/ext/guild-memory/migrations/0002_handoff_identity.sql`
- Modify: `codex-rs/ext/guild-domain/src/lib.rs`
- Modify: `codex-rs/ext/guild-memory/src/lib.rs`
- Modify: corresponding `*_tests.rs`

- [ ] **Step 1: 写真实形状 fixture**

fixture 固定 `schemaVersion = tkdesk.candidate-handoff.v4`、`batchId`、`datasetHash`、`candidateId`、`userId/secUid/handle`、资格、来源、新鲜度、国家、`outreachStatus` 和 `sendAuthorized`。

- [ ] **Step 2: 实现严格解析和批次幂等导入**

拒绝未知 schema、哈希格式错误、重复批次内容漂移和稳定 ID 冲突。`sendAuthorized:false` 只表示 TKDesk 不负责发送，不能把它写成永久 DNC。

- [ ] **Step 3: 实现三源身份链接规则**

来源枚举为 TKDesk、Recruiter Messaging、Guild Operator。稳定 ID 可自动链接；handle 只能提出候选链接；仅 display name 必须拒绝自动合并。

- [ ] **Step 4: 测试并提交**

```bash
cd codex-rs
just test -p codex-guild-domain
just test -p codex-guild-memory
git add ext/guild-domain ext/guild-memory
git commit -m "feat(guild): import tkdesk handoffs and link identities"
```

---

### Task 4: 实现招募关系、政策事实和账号包装

**Files:**

- Modify: `codex-rs/ext/guild-domain/src/recruitment.rs`
- Modify: `codex-rs/ext/guild-domain/src/policy.rs`
- Create: `codex-rs/ext/guild-domain/src/account.rs`
- Modify: `codex-rs/ext/guild-memory/src/recruitment.rs`
- Modify: `codex-rs/ext/guild-memory/src/account.rs`
- Create: `codex-rs/ext/guild-memory/migrations/0003_policy_account_method.sql`
- Modify: corresponding `*_tests.rs`

- [ ] **Step 1: 固定 RecruitmentSnapshot 行为**

每个快照都要引用证据，并保存 stage、reciprocity、initiative balance、responsiveness、momentum、interaction depth、concerns、next action。测试明确这些字段是观察，不是入会概率。

- [ ] **Step 2: 实现 `GuildPolicySnapshot` 适用与过期判断**

记录源工具/操作、国家、主播层级、观察时间、源哈希、`status/completeness/pagination/errors`。只有适用且当前的快照能支撑主播可见承诺；`not_proven` 只能支撑局部事实。

- [ ] **Step 3: 实现官方 Organization Account 引用与版本化审计**

保存 TikTok 官方 Organization Account 引用、Official/Affiliate 类型、组织所有权范围、已观察成员权限、定位、资料版本、素材引用、语言能力、可用能力和当前分配。不得保存密码、验证码、cookie，亦不实现第二套账号权限系统。ProfileAudit 覆盖可信度、专业度、账号与公会一致性、社交证明、CTA 和风险；资料变化会使旧审计 stale。

- [ ] **Step 4: 实现版本化方法和结果案例**

方法有适用条件、反例、停止条件和证据；结果案例保存发送原文、上下文版本、方法版本、回复/拒绝/邀约/入会/首播/稳定活跃结果。首版不做自动改代码或模型微调。

- [ ] **Step 5: 测试并提交**

```bash
cd codex-rs
just test -p codex-guild-domain
just test -p codex-guild-memory
git add ext/guild-domain ext/guild-memory
git commit -m "feat(guild): model recruitment context and account audits"
```

---

### Task 5: 建立原生 Chat 公会扩展工具

**Files:**

- Create: `codex-rs/ext/guild/Cargo.toml`
- Create: `codex-rs/ext/guild/BUILD.bazel`
- Create: `codex-rs/ext/guild/src/lib.rs`
- Create: `codex-rs/ext/guild/src/config.rs`
- Create: `codex-rs/ext/guild/src/instructions.rs`
- Create: `codex-rs/ext/guild/src/tool.rs`
- Create: `codex-rs/ext/guild/src/creator.rs`
- Create: `codex-rs/ext/guild/src/context.rs`
- Create: `codex-rs/ext/guild/src/recruitment.rs`
- Create: `codex-rs/ext/guild/src/account.rs`
- Create: `codex-rs/ext/guild/src/action.rs`
- Create: `codex-rs/ext/guild/tests/extension_tools.rs`
- Modify: `codex-rs/Cargo.toml`

- [ ] **Step 1: 写扩展门控失败测试**

未设置、空值或相对路径的 `GUILD_AGENT_HOME` 不注册任何公会工具或上下文；绝不能读取 `WINGMAN_HOME`。设置绝对路径时只注册设计中的七个工具。

- [ ] **Step 2: 实现小工具面**

工具名固定为 `guild_creator`、`guild_record`、`guild_context`、`guild_recruitment`、`guild_recruiter_account`、`guild_account_audit`、`guild_action`。工具输出有界，使用 plain function wire names，不创建卡片 response item。

- [ ] **Step 3: 实现公会专用 PromptContributor**

指令说明三个外部事实来源的权威边界、按主播原语言回复、直接调用 Guild Operator/TKDesk/Messaging、拒绝/DNC 优先、`unknown` 不重发、只把有来源事实写入长期记忆。

- [ ] **Step 4: 实现 `guild_action` 账本协议**

`prepare` 固定 account、conversation、creator identity、exact payload、context/policy/method versions；`claim` 只成功一次；外部 messaging tool 返回后用 `record_receipt` 写 confirmed/refused/unknown。扩展本身不注册浏览器 handler。

- [ ] **Step 5: 测试并提交**

```bash
cd codex-rs
just test -p codex-guild-extension
git add Cargo.toml ext/guild ext/guild-domain ext/guild-memory
git commit -m "feat(guild): expose native recruitment chat tools"
```

---

### Task 6: 在 app-server 安装独立扩展

**Files:**

- Modify: `codex-rs/app-server/Cargo.toml`
- Modify: `codex-rs/app-server/BUILD.bazel`
- Modify: `codex-rs/app-server/src/extensions.rs`
- Modify: `codex-rs/app-server/tests/suite/mod.rs`
- Create: `codex-rs/app-server/tests/suite/guild_extension.rs`
- Modify: `.wingman/patches.md`

- [ ] **Step 1: 写 app-server 公共 JSON-RPC 集成测试**

用 `TestAppServer::builder().build()` 与 `send_thread_start_request_with_auto_env()` 验证：普通 Codex 无公会工具；Guild 启动只出现公会工具；Wingman 启动只出现 Wingman 工具；两种 home 同时设置时显式失败或按实现的互斥规则只启用一种，不能混用数据库。

- [ ] **Step 2: 安装 `codex_guild_extension`**

只在现有 extension registry 增加一个无条件 install 调用，运行时由 `GUILD_AGENT_HOME` 保持 inert。不要把业务逻辑加入 `codex-core`。

- [ ] **Step 3: 更新 patch ledger**

记录 `app-server/src/extensions.rs` 这一处 Codex 原生接入修改及其依赖行为。

- [ ] **Step 4: 运行范围测试并提交**

```bash
cd codex-rs
just test -p codex-app-server
just test -p codex-guild-extension
git add app-server ../.wingman/patches.md
git commit -m "feat(guild): install isolated guild extension"
```

---

### Task 7: 完成端到端业务夹具

**Files:**

- Create: `codex-rs/ext/guild/tests/recruitment_flow.rs`
- Create: `codex-rs/ext/guild/tests/fixtures/tkdesk-handoff-v4.json`
- Create: `codex-rs/ext/guild/tests/fixtures/guild-policy-partial.json`
- Create: `codex-rs/ext/guild/tests/fixtures/messaging-receipts.json`

- [ ] **Step 1: 测完整招募闭环**

同一测试串起：handoff 导入 → 身份链接 → 经纪人分配 → 原话/推断 → RecruitmentSnapshot → 当前政策快照 → exact action → 单次 claim → confirmed receipt → Guild Operator joined/first LIVE 证据 → OutcomeCase。

- [ ] **Step 2: 测四个高风险分支**

覆盖：重复 handoff、display-name-only 误合并、过期政策、消息发送 `unknown` 后重启。再覆盖 creator 拒绝后任何发送 claim 都被 DNC 阻断。

- [ ] **Step 3: 验证原生 Chat 无 UI 依赖**

测试依赖树和 tool outputs 中不得出现 `WingmanCardItem`、TUI view 或 dating platform worker。

- [ ] **Step 4: 运行格式、修复和测试**

```bash
cd codex-rs
just test -p codex-guild-domain
just test -p codex-guild-memory
just test -p codex-guild-extension
just test -p codex-app-server
just fix -p codex-guild-domain
just fix -p codex-guild-memory
just fix -p codex-guild-extension
just fmt
```

不要在 `fix`/`fmt` 后重跑测试。若 Task 1 添加了新的 workspace 依赖，执行：

```bash
just bazel-lock-update
```

- [ ] **Step 5: 提交验收夹具**

```bash
git add ext/guild
git commit -m "test(guild): cover recruitment employee workflow"
```

## Acceptance

- 普通 Codex、Wingman、公会版三者状态互不读取。
- 原生 Chat 可完成候选导入、上下文读取、下一步判断、账号审计、动作准备和结果复盘。
- TKDesk v4 是唯一候选交接输入；Guild Operator 是后台事实源；Messaging receipt 是消息发送事实源。
- 主播拒绝、DNC、稳定身份冲突、政策过期和 `unknown` 都有硬性阻断测试。
- 不包含新面板、卡片或恋爱平台适配器依赖。
- 不包含内容生产或发布模块；后续以独立可插拔模块接入。
- 账号所有权与成员权限以 TikTok Organization Account 官方体系为准，公会 Agent 只保存引用和审计。
