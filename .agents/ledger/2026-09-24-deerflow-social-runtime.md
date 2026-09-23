# DeerFlow Social Runtime 台账

台账 ID：`DSR-20260924`
基线：`master@ad8d9aa`
状态：设计中
台账写入者：`/root`
当前阶段预算边界：2 个只读子 Agent；本阶段不写产品代码；无法硬控金额，以派工数、阶段门和验收证据控制。

## 已锁定决策

1. 本阶段不是在 DeerFlow 外挂 `social_cognition` wrapper/sidecar/MCP 工作流，而是把 Social Runtime 做成 DeerFlow 本体能力。
2. 核心修改顺序为 Lead → Context → State → Memory → Persona → Conversation loop；业务工具继续作为外部“手脚”。
3. 刚合并的 `deerflow.creator_agent` 是 Phase 0 基础，不推倒重来；它需要向原生 `deerflow.social` 边界演进。
4. 人格库/沟通知识库、主播主页预分析和 World Memory 的深度实现继续放在后续 roadmap，不阻塞主体纵向闭环。
5. 不把工作台变成手动人格切换器；AI 依据当前主播有来源证据自动选择。
6. 不执行或宣称未验证的 TikTok 收发、邀约或回执。
7. `DSR-DEC-001` 已由用户确认：当前项目根目录最终直接成为完整 DeerFlow fork；启动、doctor、本机配置和发行辅助能力搬入 `ops/` 或等价目录；迁移验证完成后退役 `.runtime/deer-flow` 和累计 patch overlay。
8. 保持 PERSONA-REV1 原设计：PersonaProfile 是可换装但不止于浅层语气的独立表达资产；Agent/子 Agent 覆盖只是可选解析层，`agent_override = null` 时直接继承账号/关系配置。不为人格创建或强制绑定子 Agent。
9. “具体人设”不由子 Agent 绑定产生；它由真实 Identity、持续的 Self Memory/观点与承诺、Role 共同组成，再穿上当前有效 Persona，同时保留 Relationship 和 TurnContext。

10. `DSR-DEC-002` 已由用户确认：第一个可验收闭环是 `external event → restore Identity + Self + Role + Relationship + EffectivePersona + TurnContext → Lead → reply/tool/wait/no_reply → commit`；不新增子 Agent 人格工作包。
11. 用户明确要求直接按已提供的详细方案施工；停止重新提出替代架构或反复确认已冻结的产品决策。

## 架构决策状态

- `DSR-DEC-001`（已确认）：把真实 DeerFlow fork 提升为当前项目根仓库/唯一源码事实源，并将当前 Node 引导、doctor、配置与工作台资产搬入 fork 的 `ops/` 或等价发行目录，验证后退役累计 patch overlay。
- `DSR-DEC-002`（已确认）：第一个可验收闭环限定为 `external event → restore Identity + Self + Role + Relationship + EffectivePersona + TurnContext → Lead → reply/tool/wait/no_reply → commit`，将 proactive、candidate compare、Jev advisory 和可选子 Agent 上下文传递放到后续阶段。不存在独立的“子 Agent 人格绑定”必做工作包。

## 任务台账

| Task ID | 任务 | 负责者 | 状态 | 输入/基线 | 交付与验收 |
|---|---|---|---|---|---|
| `DSR-CTRL-001` | 建立协作入口与唯一台账 | `/root` | 完成 | `ad8d9aa` | `.agents/coordination.md` 指向本台账；Git 可跟踪 |
| `DSR-AUDIT-001` | 核查 patch overlay → 真实 fork 事实源的迁移路径 | `/root/audit_fork_migration` | 完成 | 根仓、`.runtime/deer-flow`、包装脚本 | 已交付拓扑、分阶段迁移、5 项主要风险和验证；未改文件 |
| `DSR-AUDIT-002` | 映射 Social Runtime 原生接入点 | `/root/map_social_runtime` | 完成 | Lead/ThreadState/Memory/Subagent/Gateway/Channel | 已交付文件/符号级接入点、数据流、失败关闭与测试切面；未改文件 |
| `DSR-AUDIT-003` | 评估 Phase 0 人格基础的保留与迁移边界 | `/root/audit_persona_foundation` | 完成 | `ad8d9aa`、`deerflow.creator_agent`、关系持久化 | 已交付保留/搬迁/退役矩阵与验收矩阵；未改文件 |
| `DSR-DESIGN-001` | 核对附件方案与当前源码 | `/root` | 完成 | 三项核查结果，FINAL / PERSONA-REV1，本体化补充方案 | 用户确认不再重新选型，直接施工 |
| `DSR-DESIGN-002` | 锁定事实源、纵向闭环和人格/子 Agent 边界 | `/root` | 完成 | `DSR-DEC-001` / `DSR-DEC-002` | 决策已写入“已锁定决策” |
| `DSR-SPEC-001` | 复核用户提供的最终规格 | `/root` | 完成 | FINAL_SPEC、PERSONALITY_SYSTEM、IMPLEMENTATION_MAP、MIGRATION_FROM_FINAL、本体化补充 | 附件方案就是已批准 spec，不重写第二份产品方案 |
| `DSR-PLAN-001` | 生成测试先行的实施计划 | `/root` | 完成 | 用户批准的 spec | `docs/superpowers/plans/2026-09-24-deerflow-social-agent-native-runtime.md`；10 个任务，58 个步骤 |
| `DSR-IMPL-001` | 把当前根仓迁移为真实 DeerFlow fork | 待派工 | 待执行 | plan Task 1 | 上游和旧项目历史均为祖先；Phase 0 成为普通源码提交；不破坏现场数据 |
| `DSR-IMPL-002+` | 按 plan Tasks 2–10 实现与独立验收 | 待派工 | 待执行 | `DSR-IMPL-001` | 依赖图内独立文件域并行，每批 RED/GREEN/审查/提交 |

## Phase 0 保留验收约束

- 六份人格资产与严格 schema/version 校验必须保留。
- 人格指纹必须在数据库、运行时、重载、brief 和 ModelRequest 间一致。
- 作用域隔离、证据版本、persona revision 双 CAS、证据/决策幂等与 selector 单飞必须保留。
- no-contact、身份、权限、承诺与人工接管高于人格；人格选择故障继续当前/默认人格且不阻断 Lead。
- selector 可看六份完整定义，主 Lead 每次只能注入一份已解析人格。
- 迁移期不得破坏 `/workspace/guild` 路由、导航、翻译和诚实未接入状态。

## 只读核查结论

### 事实源与迁移

- 外层仓库当前跟踪配置、启动器和唯一累计 patch；`.runtime/` 整体被忽略。
- `.runtime/deer-flow` 是 detached `769589e8…` 加 26 个产品差异文件，其差异与当前 patch 一致。
- 它的 Git common dir 在 `.runtime/deer-flow.previous-20260924/.git`；旧目录不能直接删除，且其已作废后端代码不能作为新 fork 基线。
- SQLite 数据位于当前 checkout 的 `backend/.deer-flow/data/deerflow.db`，迁移 checkout 时必须备份并对照 migration version、表、行数与关系读回。用户自定义 `SOUL.md` 必须原样保留。

### Social Runtime 闭环

- Lead 稳定入口是 `make_lead_agent` / `assemble_lead_agent`；ThreadState 已支持 middleware state schema 合并，应扩展而不另起 runtime。
- 本阶段最小原生模块为：有来源外部事件、稳定作用域、有界 Social State、restore/context projector、`reply|tool|wait|no_reply` 动作合同、幂等提交与 Channel 出站闸门。
- 现有 Channel 会把空回复改成 `(No response from agent)`，且流式路径可在决策提交前发布部分文本。Social 模式必须缓冲到 commit 后再过闸，`wait/no_reply` 必须是零出站。
- Channel publish 的 listener/provider 异常现在可被吞掉；publish 成功不等于送达。未知回执不得自动重试。
- 当前没有 TikTok Channel provider，因此本阶段只能验收离线/模拟闭环和“零真实 TikTok 写入”。

### Phase 0 演进边界

- 直接保留：persona catalog/resolver/fingerprint、严格 selector、双 CAS、winner reload、当前单飞、Lead 原生装配和单人格 ModelRequest 投影。
- 搬迁/泛化：`CreatorFocus` 变成服务端认证的 SocialContext；同库 `creator_agent_relationship` 用 expand/backfill/switch/contract 演进，不从旧 `guild_creator_context` 导入。
- 退役：Chat 手动 focus/brief/record 作为真实来信入口的角色；测试直写 `creator_message` 不得当成现场通道证据。
- 必须补齐：关系表目前只持久 no-contact，运行时检查的 `human_takeover`、`receipt_unknown`、`identity_verified` 尚无权威持久来源。Chat 重录同一消息会生成新 UUID，幂等 ID 仅保留最近 64 个；这不够作为长期消息幂等。
- selector 单飞只保证同一进程 event loop/scope/version；跨进程依赖 CAS 只能保证唯一提交，不能宣称只调用一次 selector。

## 阶段门

1. **Design gate（当前）**：只读核查完成，向用户呈现方案与分节设计，获得确认。
2. **Spec gate**：设计文档已提交，自审通过，用户复审确认。
3. **Plan gate**：详细实施计划已写入，每批文件归属、RED/GREEN 与验收明确。
4. **Implementation gate**：只在前三门通过后启动；不使用真实 TikTok 外部写入作为本阶段测试。

## 当前阻塞与风险

- 外层仓库目前是产品包装层，实际 DeerFlow 源码是被忽略的 detached worktree，累计 patch 才是 Git 中的持久实现。
- 原生化会改变仓库拓扑和升级流程；必须先证明可回滚和工作台不丢失。
- Social Memory 不得演变为平台真值的第二 CRM；外部事件的来源、身份和去重仍是 P0 边界。

## 历史记录

- 2026-09-24 04:12 CST：建立本台账，登记 2 个只读并行核查任务，未启动实现。
- 2026-09-24 04:21 CST：3 项只读核查全部完成，未改产品代码。进入事实源与首个 Social Runtime 纵向闭环的方案比较。
- 2026-09-24 04:27 CST：用户确认 `DSR-DEC-001`，当前项目根仓将迁移为完整 DeerFlow fork，累计 patch 只作为迁移前对照物。
- 2026-09-24 04:34 CST：根据用户纠正复核 PERSONA-REV1；删除“人格必须绑定子 Agent”的误解。子 Agent 覆盖保持可选，具体人设由 Identity/Self/Role 与当前有效 Persona 组合得到，原计划其他边界不变。
- 2026-09-24 04:36 CST：用户确认 `DSR-DEC-002`，第一阶段纵向闭环范围锁定；进入内部架构方案比较，仍未启动实现。
- 2026-09-24 04:58 CST：用户纠正“不要重新设计，直接按四份详细方案施工”。已将方案映射为 10 个可验收实施任务，下一步直接执行 Task 1。
