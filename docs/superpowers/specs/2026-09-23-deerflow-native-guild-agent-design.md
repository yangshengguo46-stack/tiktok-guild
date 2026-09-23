# DeerFlow 本机直连公会 Agent 设计

日期：2026-09-23

## 1. 决策

公会 Agent 改为在当前 Mac 上原生运行 DeerFlow，并由一个 DeerFlow Lead 直接调用现有 TikTok 插件。生产路径不再经过 Docker Gateway、Recruiter Worker、Rust Guild extension、Guild ledger、SQLite 投影库或第二层业务 API。

本设计取代 `2026-09-22-deerflow-guild-runtime-design.md` 的生产架构。旧设计及代码只作为迁移历史和回滚证据，不再代表目标运行方式。

```text
当前 Mac
└── DeerFlow（一个本机 Lead、手动启停）
    ├── 公会招募聊天与关系推进 Skill
    ├── 活跃主播案件卡（Markdown，小而有界）
    ├── TikTok LIVE Guild Operator（stdio MCP，只读）
    │   └── 本机 Chrome / 现有公会后台登录 profile
    └── TKDesk Agent（stdio MCP，发现、筛选、去重、交接）
        └── TKDesk 自有数据与浏览器 profile
```

这不是把已实现的重架构再搬一次，而是从原始 Wingman 业务方法、现有插件能力和官方 DeerFlow 扩展点重新接线。

## 2. 目标与非目标

### 目标

- DeerFlow 是唯一 Agent 运行入口；用户在一个持续会话里管理候选、聊天判断和关系推进。
- 直接复用 Guild Operator 与 TKDesk 的原生 Skills/MCP，不包装第二层后端。
- 保留 Wingman 已验证的聊天判断、关系阶段、证据约束、边界、承诺、未闭环事项和下一步行动方法。
- 只为活跃招募关系保存最少的案件状态；完整聊天继续以 TikTok 为事实源。
- 第一阶段只读：允许读取候选、公会事实和消息，允许写本机案件卡，不允许向 TikTok 发送消息、邀请、关注、评论、礼物或其他外部动作。
- 手动启动、手动停止；登录、验证码、2FA 和安全挑战都在本机原生浏览器里人工完成。

### 非目标

- 不建设 CRM、数据仓库、业务投影库、后台同步任务或常驻 Worker。
- 不复制 Guild Operator/TKDesk 的数据到 Agent 数据库。
- 不迁移 `guild-domain`、`guild-memory`、`codex-guild-extension` 或 Recruiter Worker 到 DeerFlow。
- 不在第一阶段实现自动发信、定时触达、批量邀约、自动充值或无人值守运营。
- 不新增 Web 管理后台、noVNC、容器控制面或多 Agent 编排。

## 3. 设计来源与防变形原则

本次实现只从以下一手项目材料提取行为，不从已经叠加多层的迁移实现反向推导业务：

- 原始 Wingman 方案和 `.wingman/` 计划：一个 Lead、Chat 主入口、平台是手、业务判断在 Agent；
- `codex-rs/ext/wingman/expert/methods.json` 与现有固定案例：聊天任务、证据约束、草稿边界和调整/停止条件；
- `2026-09-21-guild-agent-source-and-plugin-audit.md`：公会业务适配、五个可解释关系维度和插件真实能力边界；
- Guild Operator 0.12.0：公会后台事实读取与人工登录；
- TKDesk Agent 0.9.0：候选发现、资格判断、去重和冻结交接。

实施遵循四条规则：

1. 能直接调用插件就不复制接口。
2. 能按需读取事实就不做后台投影。
3. 能用一个有界文件表达的状态就不建数据库。
4. 当前插件没有证明的能力不得由 prompt 假装存在。

## 4. 组件边界

### 4.1 DeerFlow Lead

DeerFlow 负责会话、推理、Skill 调用、MCP 调度和本机案件文件读写。生产只保留一个公会招募 Lead，不额外创建“发现 Agent”“聊天 Agent”或“数据库 Agent”。

DeerFlow 固定使用官方 `bytedance/deer-flow` commit：

`769589e8daee14c2587a634b6b43bd96471a41a1`

运行方式为官方本机模式，MCP 通过 `extensions_config.json` 中的 stdio server 启动。生产不依赖 Docker；Docker 只可用于与生产无关的隔离测试。

### 4.2 公会招募聊天与关系推进 Skill

新增一个面向 DeerFlow 的业务 Skill，职责只有三类：

- 根据当前消息与可见历史判断招募阶段、关注点、疑虑和推进节奏；
- 给出下一步建议与回复草稿，但不声称已经发送；
- 在用户确认某段工作已完成后，更新对应案件卡。

Skill 必须保留下列业务能力：

- 任务路由：回应、分享、认可、轻松互动、澄清、邀约、修复、等待、结束联系；
- 关系观察：互惠度、主动性平衡、回应节奏、动量、互动深度；
- 招募阶段：未接触、已接触、已回复、探索需求、处理疑虑、准备邀约、已邀约、已入会、暂停、拒绝/退订；
- 决策：回复、等待、补充事实、发出邀约建议、暂停、停止；
- 约束：不读心、不编造事实、不替用户承诺、不把局部页面当完整数据、不越过拒绝和 do-not-contact。

Skill 不拥有插件、浏览器或数据库。它只说明何时读取哪个事实、如何解释证据、如何维护案件卡。

### 4.3 TikTok LIVE Guild Operator

DeerFlow 直接以 stdio MCP 启动现有 `/Users/yangyucheng/plugins/tiktok-live-guild-operator`。其职责保持不变：

- 先调用 `guild_workspace` 获取当前进程有效的 `guild_ref`；
- 按需读取主播、公会招募、消息、公会运营、流水、治理和经营数据；
- 返回 `status`、`evidence`、`completeness`、`pagination` 和 `errors`，供 Lead 区分事实、推断与缺失证据；
- 遇到登录或验证时使用原生 Mac Chrome 的同一 persistent profile。

第一阶段只启用插件现有的八个只读工具：

- `guild_workspace`
- `guild_creators`
- `guild_recruitment`
- `guild_messaging`
- `guild_operations`
- `guild_revenue`
- `guild_governance`
- `guild_intelligence`

不增加消息发送或后台写工具。

### 4.4 TKDesk Agent

DeerFlow 直接以 stdio MCP 启动现有 `/Users/yangyucheng/plugins/tkdesk-agent/scripts/launch_mcp`。TKDesk 继续独占：

- 主播发现与资格判断；
- 候选身份、去重、任务进度和 checkpoint；
- `prepare_handoff` / `commit_handoff` 及其冻结数据集；
- TKDesk 自己需要的本地数据、daemon 和浏览器状态。

DeerFlow 不复制 TKDesk 数据库，不把 handoff 转成第三种候选格式，也不把 `sendAuthorized: false` 误解为“已获发送权限”。TKDesk 不发消息。

### 4.5 活跃主播案件卡

案件卡是 DeerFlow 工作区中的 Markdown 文件，不是 ledger 或数据库。只为已经进入实际沟通、需要跨会话继续跟进的主播创建；发现阶段的全部候选不落案件卡。

每张卡只包含：

```yaml
creator_id: "稳定 candidateId；没有时使用有来源说明的稳定平台标识"
display_name: "仅作显示，不作为身份主键"
source:
  kind: "tkdesk_handoff | guild_operator | user"
  reference: "batchId/datasetHash、guild evidence 或用户说明"
stage: "contacted | replied | exploring | objection | invite_ready | invited | joined | paused | refused | opted_out"
signals:
  reciprocity: "one_sided | mixed | mutual | unknown"
  initiative_balance: "ours | balanced | theirs | unknown"
  responsiveness: "fast | normal | slow | stalled | unknown"
  momentum: "rising | stable | cooling | stalled | unknown"
  interaction_depth: "greeting | needs | objections | policy | onboarding | unknown"
concerns: []
commitments: []
open_loops: []
boundaries: []
next_action:
  kind: "reply | wait | verify_fact | propose_invite | pause | stop"
  reason: "引用当前证据的简短说明"
  not_before: null
last_interaction_summary: "有界摘要，不复制整段聊天"
updated_at: "带时区的 ISO 8601 时间"
```

约束：

- 单卡正文不超过 4 KiB；超过时压缩旧摘要，不创建无限时间线。
- 不保存密码、cookie、token、验证码、身份证件、支付信息或浏览器 profile 内容。
- 完整消息历史不复制进案件卡；需要时从 TikTok 重新读取。
- `boundaries`、拒绝、退订和 do-not-contact 不得被后续摘要覆盖。
- 案件卡是 Lead 的工作判断，不取代 TKDesk 或 TikTok 的平台事实。
- 案件卡目录属于本机运行数据，默认 Git ignore，不提交真实主播信息。
- DeerFlow Lead 通过受限的 `write_file` 写完整案件卡并立即回读核对；`allow_host_bash` 保持关闭。原子写 CLI 只供人工导入、校验和本机维护使用，不暴露给模型。

## 5. 数据流

### 5.1 候选进入沟通

```text
TKDesk prepare_handoff
  → Lead 检查冻结身份、资格、新鲜度和 outreachStatus
  → Guild Operator 按需核对公会容量、既往邀约或现有公会关系
  → 用户决定是否进入实际沟通
  → 仅此时创建案件卡
```

`commit_handoff` 仍按 TKDesk 自有契约执行；它只完成候选交接，不代表已经联系或已经发送。

### 5.2 分析一段聊天

```text
用户指定主播/会话
  → Lead 读取案件卡（如有）
  → Guild Operator 读取当前可见聊天或用户提供消息
  → 区分可证实事实、合理推断、缺失证据
  → 计算五个关系维度与招募阶段
  → 输出回复草稿、理由、风险和改变建议的条件
  → 不发送
```

消息读取如果是 `partial`、分页未证明或映射缺失，Lead 必须明确说明只看到了什么，不能把它概括为“完整聊天”。

### 5.3 记录推进结果

第一阶段没有发送工具，因此只有以下事件可以更新案件卡：

- 用户明确说某条消息已经人工发送；
- 插件读取到可核验的新回复或新平台状态；
- 用户明确纠正身份、边界、承诺或阶段；
- 用户要求暂停、停止或标记拒绝/退订。

草稿生成、推荐动作或工具调用失败都不能写成已执行结果。

## 6. 事实优先级与冲突处理

事实源按职责并列，不做全量合并：

| 信息 | 权威来源 | DeerFlow 可保存什么 |
|---|---|---|
| 候选发现、资格、冻结交接 | TKDesk | 稳定 ID 与 handoff 引用 |
| 公会后台状态、额度、主播关系 | Guild Operator / TikTok | 结论摘要与证据引用 |
| 完整聊天 | TikTok 当前可见会话或用户提供材料 | 最新关键互动的有界摘要 |
| 关系判断与下一步 | DeerFlow Lead | 案件卡中的阶段、信号与 next_action |
| 人工发送或线下结果 | 用户确认，必要时再由平台读取核验 | 已确认事实和来源 |

冲突时不自动覆盖：Lead 展示冲突、优先请求当前平台事实，并把未解决项写入 `open_loops`。`unknown`、`partial`、`not_proven` 和超时都不能升级为肯定事实。

## 7. 安全、失败与恢复

- **登录缺失或挑战**：暂停当前读取，提示用户完成原生浏览器登录/验证；不改 cookie、不绕过挑战。
- **MCP 启动失败**：指出是 Guild Operator 还是 TKDesk 失败，并给出其本机启动诊断；另一个插件可以继续独立工作。
- **Guild `guild_ref` 失效**：重新调用 `guild_workspace`，不把旧引用持久化进案件卡。
- **局部/分页未证明**：只回答已见范围，列出缺失证据。
- **身份不确定**：不创建或合并案件卡，先要求稳定 `candidateId`、`userId/secUid` 或用户确认。
- **文件损坏**：拒绝静默猜测并报告具体字段错误。人工导入/维护使用临时文件加原子替换；Lead 写完整文件后必须立即回读核对，不为调用 CLI 而开放 host bash。
- **外部写请求**：第一阶段明确拒绝执行，只生成可复制草稿或人工步骤。
- **敏感信息**：发现凭据、cookie、验证码或支付数据时不写案件卡，并提醒用户从聊天材料中移除。

关闭 DeerFlow 后，插件 profile、TKDesk 自有状态和案件卡留在各自本机目录；下次手动启动时恢复。不存在需要恢复的容器、Worker lease 或 Guild ledger。

## 8. 本机布局与启动方式

仓库新增一个窄的本机运行包，负责：

- 固定并校验 DeerFlow commit；
- 生成/校验只包含 Guild Operator 与 TKDesk 的 `extensions_config.json`；
- 安装或链接公会招募 Skill 到 DeerFlow 自定义 Skill 目录；
- 创建 Git-ignored 的案件卡目录；
- 提供 `start`、`doctor` 和只读 acceptance 命令。

启动脚本只启动 DeerFlow 本机进程，不启动 Docker、不拉起 Recruiter Worker、不启动 Rust bridge。用户通过 DeerFlow 官方本机页面聊天；登录需要时由对应插件打开原生 Chrome。

首版配置使用当前 Mac 的稳定插件源码路径，符合“只在这台电脑运行”的部署范围。路径必须由本机 manifest 明确声明并由 `doctor` 校验，不在代码里到处散落。

## 9. 迁移与清理

迁移分为两个可回滚阶段：

1. **旁路验收**：新增本机直连运行包和 Skill，旧容器/Worker/Rust 代码保持停用；用 fixture 与只读真实读取证明新路径可用。
2. **退役旧路径**：验收通过后，从生产 manifest、启动文档和默认命令中删除两容器、Recruiter Worker、Rust bridge 与 Guild ledger。历史设计和 Git 历史保留；真实 profile、TKDesk 数据和旧代码不做破坏性删除。

旧运行包不得与新本机 DeerFlow 同时连接真实账号。回滚只需停止本机 DeerFlow，并恢复使用旧 fixture 做离线诊断；回滚不自动开启真实写动作。

## 10. 测试与验收

### 10.1 离线合同

- 配置只声明 Guild Operator 与 TKDesk 两个 stdio MCP；没有 HTTP Worker、Rust bridge 或第三个业务 server。
- Guild Operator 工具目录精确为现有八个只读工具；TKDesk 目录不含消息发送工具。
- Skill 能覆盖九类聊天任务、五个关系维度、招募阶段和停止条件。
- 固定聊天案例验证：不编造事实、不替用户承诺、拒绝/退订不被推进建议覆盖、`partial` 不被表述为完整记录。
- 案件卡 schema、4 KiB 上限、身份隔离、不可覆盖边界、维护 CLI 原子写入和 Lead 完整写后回读行为通过测试。
- manifest/doctor 能在插件缺失、Node 版本不符、DeerFlow commit 不符或 MCP 无法启动时给出具体错误。

### 10.2 本机集成验收

1. 手动启动 DeerFlow，页面可访问；不需要 Docker。
2. DeerFlow 能发现公会招募 Skill、Guild Operator 与 TKDesk。
3. Guild Operator 需要登录时打开原生 Chrome；登录后完成一次 `guild_workspace` 和一个只读公会事实读取。
4. TKDesk 完成一次只读候选/交接读取，不复制其数据库。
5. 用一个合成聊天案例生成判断、草稿和下一步，创建一张合成案件卡；重启 DeerFlow 后能继续读取。
6. 对真实账号只做只读观察，不发送任何消息、邀约或互动。
7. 进程列表和网络端口证明没有 Gateway/Worker 容器、noVNC、Recruiter Worker 或 Rust Guild bridge。

### 10.3 完成标准

当上述验收全部通过，用户可以在一个 DeerFlow 会话中完成：

- 从 TKDesk 接收一个候选；
- 查询当前公会事实；
- 分析一段招募聊天；
- 得到有证据的回复草稿和下一步；
- 在人工执行后记录最小案件状态；
- 重启后继续该关系。

这就是第一阶段完整产品。自动发送、定时任务和批量触达必须作为未来独立设计重新审批，不能借本设计顺带加入。
