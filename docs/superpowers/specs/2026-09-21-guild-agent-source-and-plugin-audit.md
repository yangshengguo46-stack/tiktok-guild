# 公会数字员工溯源与 TikTok 插件审计

日期：2026-09-21

## 1. 结论

Wingman 的原始方案并不是一套从零开始的“泡妞程序”，而是把通用数字员工架构适配到恋爱场景：

```text
数字员工底座
+ 行业知识和方法
+ 行业数据模型
+ 行业执行器
= 一个长期工作的业务 Agent
```

公会版应该沿用这个结构，而不是只从 Wingman 拿一个聊天 Prompt，也不是再造一套 CRM 界面。

目标结构是：

```text
OpenAI Codex 通用 Agent Runtime
+ Wingman 已验证的关系推进与行动闭环
+ TKDesk 候选主播 handoff
+ TikTok LIVE Guild Operator 公会后台事实
+ TikTok Recruiter Messaging 聊天和邀约执行
= 公会招募数字员工
```

## 2. Wingman 开源溯源

### 2.1 通用数字员工底座

Wingman 仓库本身是 [OpenAI Codex](https://github.com/openai/codex) fork。它直接继承了下列通用能力：

- 原生 Chat 与一个持续的 Lead；
- 模型调用、流式输出、Provider 和认证；
- Agent loop 和 tool calling；
- 会话上下文、session、resume 和 wakeup；
- MCP、Skills、文件、Shell 和其他执行工具；
- 插件式的 ToolContributor 与 ContextContributor；
- 任务运行、记录、输出截断和异常处理。

这些能力原本就是数字员工的运行底座，不属于恋爱业务，公会版应直接继承。

### 2.2 原方案从其他开源项目提炼的通用能力

| 来源 | 原方案提炼的能力 | 公会版处理 |
|---|---|---|
| [OpenOutFind](https://github.com/eracle/OpenOutFind) | 候选人发现、Qualification、有理由的 Ranking、可恢复任务 | 由 TKDesk 提供现成发现和资格结果，公会 Agent 不重复搜索 |
| [OpenOutreach](https://github.com/eracle/OpenOutreach) / [OpenOutSend](https://github.com/eracle/OpenOutSend) | Discovery 与 Sending 解耦，幂等交接，抑制名单，来信后再决定 | 保留；TKDesk、Agent 记忆、Messaging 三者分工 |
| [RelationsOS](https://github.com/connectos-ai/relationsos) | Person、Interaction、OpenLoop、Commitment、NextAction、事件来源 | 保留并改成 Creator 招募关系 |
| [PingCRM](https://github.com/sneg55/pingcrm) | 统一时间线、身份合并、Follow-up、响应和冷却趋势 | 保留可解释观察，不保留单一总分 |
| [Radiant AI CRM](https://github.com/dylanmeyford/radiant-ai-crm-oss) | ProposedAction、Action Registry、ExecutionReceipt、Outcome | 保留动作与结果闭环，去掉恋爱的逐条人工批准 |
| [LGM GTM System](https://github.com/LaGrowthMachine/gtm-system) | 按适用条件组织 Method/Capability，把实时数据接到执行技能 | 用于组织招募方法和公会运营知识 |
| HingeAuto 类方案 | Profile → Understand → Decide 和资料展示检查 | 保留经纪人账号的 ProfileAudit；`SelfProfileAudit` 是 Wingman 的适配模型，不应说成某个上游的原样代码 |
| [狗头军师](https://github.com/shengjidaguai-china/goutoujunshi/tree/4ced1d57561563f4b556f555ee1c8c91ffb16355) | 恋爱沟通方法、进退条件、边界和对话案例 | 只保留通用沟通机制；去掉恋爱知识、暧昧话术和恋爱目标 |

这些项目是设计来源，不是公会版的运行依赖。对 GPL、AGPL 或许可不清的项目只保留抽象和机制，在公会代码内自行实现。

原 v3.0/v3.1 文档没有记录 HingeAuto 的精确仓库和 commit，因此无法对“SelfProfileAudit 直接来自 HingeAuto”做完整代码级溯源。当前应把它记为 Wingman 对“Profile → Understand → Decide”的自主适配；若未来要复用上游代码，须先补齐精确来源和许可证据。

### 2.3 Wingman 已经工程化的可复用机制

当前代码已经实现并测试了：

- 人物、平台身份和来源一致性；
- Interaction 与原话 Evidence 分开；
- Inference 必须引用 Evidence；
- 有界的当前关系上下文；
- Reciprocity、InitiativeBalance、Responsiveness、Momentum 和 InteractionDepth；
- OpenLoop、Commitment 和不能被快照覆盖的 Boundary；
- 版本化 SelfProfileAudit 与过期检测；
- 幂等候选对象、Qualification、Opportunity；
- 绑定账号、对象、内容和上下文版本的 Action；
- 一次 claim、ExecutionReceipt、`unknown` 不重发和 Outcome 记录；
- `WINGMAN_HOME` 门控、原生扩展注册和独立 SQLite。

公会版应复用这些经验和行为契约，但不依赖 `codex-wingman-extension`、卡片、TUI 或恋爱平台适配器。

## 3. TikTok LIVE Guild Operator 0.12.0 审计

### 3.1 实际覆盖

当前插件暴露 8 个层级工具、31 个业务读操作和 48 个已审查 GET 响应路径：

| 业务域 | 操作 | 后台页面 | 对招募数字员工的作用 |
|---|---|---|---|
| `guild_workspace` | 公会发现、被动状态 | `/portal/overview` | 绑定真实公会、国家、区域、角色和运行会话 |
| `guild_creators` | 主播名单、关系、开播、异常跟进、主播违规 | `/portal/anchor/*` | 联系前去重，入会后确认首播、活跃、异常与风险 |
| `guild_recruitment` | 线索、推荐、邀约列表、邀约额度 | `/portal/anchor/scout-creators`, `/portal/anchor/invitation-management` | 核对官方招募漏斗、已邀约状态和可用额度 |
| `guild_messaging` | 会话列表、指定会话历史 | `/portal/anchor/instant-messages` | 当前只能作辅助读取，不能作可靠消息传输层 |
| `guild_operations` | 活动、Flare Card、Promote 授权与券 | `/portal/tools/*` | 给主播说明公会可提供的支持时，先核对资格、数量和有效期 |
| `guild_revenue` | 总览、激励任务、主播贡献、经营评估 | `/portal/overview`, `/portal/revenue/*` | 决定当前需要什么样的新主播，不盲目只追求人数 |
| `guild_governance` | 公会违规、健康分、举报、申诉、组织、权限 | `/portal/punishment/*`, `/portal/administration/*` | 确认账号权限、当前限制和招募承诺的风险边界 |
| `guild_intelligence` | 招募、主播、团队、公会、周报指标 | `/portal/data/*` | 评估招募转化、新主播表现、团队效率和稳定活跃结果 |

插件自带 10 个 Skills，覆盖公会全面诊断、招募漏斗、主播运营、活动、流水、激励任务、治理、三个月经营方案和经理报告。公会 Agent 应该直接调用这些工具和 Skills，不再包装成第二份公会后台 API。

### 3.2 运行与登录模型

- 只有一个公会后台 Playwright persistent profile；
- 常规读取以 headless 模式运行；
- 登录、CAPTCHA、验证或安全挑战时使用同一 profile 显示官方窗口；
- 登录完成后重回 headless；
- 每个业务读取使用独立 page，一个业务域失败不污染另一个；
- `guild_ref` 是带随机盐的进程内不透明引用，重启 MCP 后需重新 discovery；
- 插件没有公会业务数据库，也没有后台刷新任务。

这个模型适合“公会事实读取”，不适合多经纪人账号的长期消息会话，因此即时消息写能力仍然应该是独立插件。

### 3.3 当前数据契约的真实边界

当前 `readView` 是“有审查白名单的取证器”，不是 31 套完整的语义适配器：

- 只接收 `live-backstage.tiktok.com` 同源、白名单路径、GET、200、JSON 响应；
- 单响应最大 1 MiB，单次调用所有响应最大 4 MiB；
- 同时保留最多 32,000 字符的可见 DOM 和有界表格；
- 返回的主要数据是 `endpoint_path + raw body + surface`，具体业务字段需 Agent 按当前任务解读；
- 当前 `params` 只进入结果，并没有驱动页面筛选、搜索或翻页；
- 通用 `paginate` helper 有边界测试，但尚未接到 live views；
- 因此当前每个 live read 都只证明一页，分页状态是 `not_proven`；
- 不能用局部页面推断全公会的比例、排名或集中度。

即时消息是当前最明确的缺口：

- `list_conversations` 和 `get_messages` 都没有已审查响应路径；
- 它们只能读 `/portal/anchor/instant-messages` 的可见 DOM；
- 测试明确要求空页面返回 `partial + live_read_mapping`，不能假装成成功；
- 无发送消息、发送邀约卡、消息游标、未读订阅或发送核验能力。

### 3.4 测试与现场证据

当前安装包的本地回归结果：

- 38 项 Node 测试全部通过；
- clean-core 验证通过；
- Codex plugin 布局校验通过；
- 回归覆盖 MCP 协议、公会身份、登录切换、独立 page、局部失败、输出边界和 fixture acceptance。

这些证明工程契约成立，不等于 31 个页面已全部通过当前 TikTok 真实账号的现场验收。任何真实业务结论仍然要看调用当时的 `status`、`evidence`、`completeness`、`pagination` 和 `errors`。

## 4. TKDesk 0.9.0 交接审计

TKDesk 已经准备了正式数字员工边界：`tkdesk.candidate-handoff.v4`。

`prepare_handoff` 会冻结：

- `batchId`、`runId` 和 SHA-256 `datasetHash`；
- 稳定 `candidateId`；
- `userId`、`secUid`、handle 等身份证据；
- 国家、路由、时间、新鲜度和来源；
- 粉丝、开播、排名、分数原始字段；
- 官方资格结果和原始理由；
- `outreachStatus: not_contacted`。

`commit_handoff` 必须带精确的 `batchId + datasetHash` 和用户对该冻结数据集的确认；它只生成幂等本地 outbox，仍然不发消息。

TKDesk 契约已经明确把以下责任交给数字员工：

- 接触渠道和具体批次治理；
- 既往接触和重复抑制；
- 拒绝、退订和 do-not-contact；
- 收益、奖励、合约和表现承诺的事实审查；
- 消息、回复和结果记录；
- 把 contacted/refused/opted-out 等反馈回传给后续发现工作。

因此公会 Agent 必须直接消费 v4 handoff，不另造候选名单格式，也不要把 `sendAuthorized: false` 解读成发送禁令；它的准确含义是 TKDesk 不授权、也不负责发送。

## 5. 对公会版的修正

### 5.1 应保留的通用闭环

```text
TKDesk Candidate Handoff
  → Creator Identity Resolution
  → Qualification / Priority
  → Recruiter Account Assignment
  → Conversation + Recruitment Snapshot
  → Next Best Action
  → One-dispatch Messaging Action
  → Receipt / Unknown
  → Guild Operator Confirmation
  → Outcome Case
  → Method Version Improvement
```

`RecruitmentSnapshot` 不应只有一个 stage，而应继承 Wingman 的五个可解释关系维度：

- `reciprocity`：聊天是单向、混合还是双向；
- `initiative_balance`：谁在开话题、延展、联系、提方案和确认安排；
- `responsiveness`：当前可观测回复节奏；
- `momentum`：招募沟通是上升、稳定、冷却还是停滞；
- `interaction_depth`：停留在寒暄，还是已进入需求、疑虑、政策或入会细节。

它们都是带证据的观察，不是“入会概率”。

### 5.2 整个公会后台的按需使用

公会 Agent 在招募中按需调用 Guild Operator，但不默认扫全部后台：

1. 首次接触前：核对 creator/relation/recruitment，防止联系已在管、已邀约或正在跟进的主播。
2. 决定招募优先级：读公会、招募、主播和任务指标，区分“缺人”与“现有主播不活跃”。
3. 说明公会能力：只在读到当前活动、Flare Card、Promote、奖励任务、国家和资格后，才形成 `GuildPolicySnapshot`。
4. 发邀约前：核对 invitation state、合适的 quota/lane 和账号权限。
5. 入会后：用 creator/live/intelligence 确认 joined、first LIVE、activated 和 stable，而不是从聊天推测。
6. 复盘：用 recruitment metrics、creator metrics 和 outcome 区分“有回复但不入会”、“入会但不开播”和“稳定贡献”。

### 5.3 不应实现的内容

- 不复制 Guild Operator 的 8 个业务域；
- 不为后台数据造新 Dashboard 或卡片；
- 不把 Guild Operator 的单一公会 profile 用作多经纪人聊天 profile；
- 不将原始后台响应全量复制进公会 Agent 数据库；
- 不引入中文中间翻译流程；
- 不在首版加模型微调、自改代码或复杂奖励平台。

### 5.4 自进化的实际定义

首版的“自进化”是可审计的方法和案例迭代：

- 保存每次实际发出的原文、当时上下文和方法版本；
- 保存回复、拒绝、邀约、入会、首播和稳定活跃结果；
- 把可复用模式写成有适用条件、反例、停止条件和证据引用的 `RecruitmentMethodVersion`；
- 草拟新消息前检索相似成功和失败案例；
- 方法版本可回溯，新结果不覆盖旧证据；
- 运营事实仍以 TikTok 插件为准，Agent 不能因为过去成功就自行更改当前政策事实。

这是一个可靠的经验学习闭环，不需要先造一个单独的自进化平台。

## 6. 实施前必须固定的契约

1. 直接消费 `tkdesk.candidate-handoff.v4`，不自定义第二份名单 schema。
2. 公会 Agent 只存储业务决策使用过的有来源事实，不镜像 Guild Operator 原始响应。
3. `RecruitmentSnapshot` 保留 stage 和五个可解释沟通维度。
4. 后台页面操作仍由 Guild Operator 和 Messaging 插件拥有；公会 Agent 只拥有判断和长期记忆。
5. Guild Operator 保持只读；多账号聊天与邀约写入放在独立 Messaging 插件。
6. Messaging 上线前必须先对当前即时消息页面做真实契约捕获；不从 Guild Operator 的通用 DOM 读取假设发送控件。
7. 调用 Guild Operator 时始终保留它的完整性和分页语义；`partial` 不写成 complete，`not_proven` 不写成全量。
