# TikTok 公会：全业务范围审计与手机到货前收口

日期：2026-09-30（Asia/Shanghai）。当前任务 ID：`AUDIT-20260930`。

## 结论与审计边界

手机不是最后一道门槛。DeerFlow 原生社交、人格与公开建联状态合同已经实现，但“持续认识一个人、主动兑现约定、真实收信后接着聊、可交付给客户”仍有软件和交付缺口。本次按业务链审查规格、生产调用点、Git/分支/stash、唯一台账、数据库、日志与测试；不是全仓每一行的安全认证，也不是 TikTok 现场试点。

本轮以 `master@c4e10369f` 和安卓交付 `codex/android-outreach-control@238a445ff` 为审计基线，在主目录新建 `codex/pre-device-audit` 承接安卓代码并修复。用户此前已明确将活动执行改为安卓，保留点赞、评论、关注、私信及通用逐台控制。Web/iPhone 的旧计划是历史材料。

## 从哪几份开发手册开始

产品输入是 `CreatorAgent_FINAL_PERSONA_REV1_20260924.zip`，SHA-256 为 `788924f9d7e3d63327d85351f76088ecd6427141396d42a9752bdd448a930ba1`。附件目录有 76 个受清单约束的文件。五份开工材料为：

1. `docs/product/creator-agent-final-persona-rev1/NORTH_STAR.md`：自然交流、连续理解和岗位执行分别评价。
2. `docs/product/creator-agent-final-persona-rev1/docs/FINAL_SPEC.md`：WP0–WP4、来源/承诺、主动性与最终验收。
3. `docs/product/creator-agent-final-persona-rev1/docs/PERSONALITY_SYSTEM.md`：人格只影响表达，版本化与作用域解析。
4. `docs/product/creator-agent-final-persona-rev1/docs/MIGRATION_FROM_FINAL.md`：更正旧版固定人格约束。
5. `docs/product/creator-agent-final-persona-rev1/CODING_AGENT_PROMPT.md`：开发执行入口。

`2026-09-24-deerflow-auto-persona-design.md` 是后续生效修订：日常由 AI 根据有来源的原话自动选择，不要求运营者每轮手动换装。原生实现计划 `2026-09-24-deerflow-social-agent-native-runtime.md` 的 Task 1–10 是工程交付，不等于 WP1–WP4 的全部产品验收。

## Git 与证据是否对得上

| 项目 | 本次查明的事实 | 处置 |
| --- | --- | --- |
| 主目录 | 开始时 master 干净，停在 Web 路线计划提交 `c4e10369f` | 在 `codex/pre-device-audit` 承接安卓成果；原 master 保留 |
| 安卓分支 | 比 master 多 4 个提交，最新 `238a445ff`；代码与新 P1–P8 台账此前仅存在隔离目录 | 已纳入本轮源码、审计与修复基线 |
| Web 网络初始化 | `feature/web-network-init@7deada11c`，4 个未合并提交，属于已放弃的活动路线 | 保留历史；不合并、不重新开启登录试点 |
| 原生运行时分支 | `codex/deerflow-social-runtime` 已是 master 的祖先 | 不重复 Task 1–10 |
| stash | `c17efdf9a13bc9089e0d0d3909a924a375a66892` 保存双通道前工作；含启动日志修复、导航变化和很多现场证据 | 未 apply/pop/drop；仅恢复一个已检查的合成 selector 证据 JSON |
| 远程 | 当前仓库未配置 remote | 本轮为本地交付，没有 push/远端备份证据 |
| 记录矛盾 | 最新 P6 写“只有 stay”，历史 9/29 已记录 switch；文件被留在 stash | 找回 JSON，纠正为“见过一次合成 switch，默认超时与整体质量未验收” |
| 记录过期 | README 仍写工作台占位与 Web/iOS；能力矩阵混有已修复失败 | 更新当前摘要并保留历史验证日期，不覆盖旧事实 |

恢复的 `2026-09-29-project-closeout-selector-evidence.json` 只证明当时 `gpt-6-sol` 的合成行为：默认 10 秒的一次 switch 超时，stay 4.804 秒，另一个 30 秒上限的 switch 5.552 秒成功。它不证明真实主播效果，也不证明今天的模型仍有相同稳定性。

## 业务闭环覆盖

| 业务环节 | 真实代码/证据 | 剩余缺口 | 手机依赖 |
| --- | --- | --- | --- |
| 默认 Lead 和人格 | 六模板、版本、作用域、CAS、真实 ModelRequest、管理 Chat 的生成/预览/启用/清除/回滚存在 | 外部社交遗漏内核已本轮修复；自然度与完整多轮需独立评价 | 无 |
| 同一人的连续理解 | `social_event`、ClaimPatch assert/retract、SQLite 恢复有生产路径 | 自身观点、真实承诺、关系记录的写入未接到生产回合；工具测试预埋不能代替业务入口 | 无 |
| 主动性与约定 | TurnResult 能保存 `followup` | 没有消费/唤醒；下一回合也未装入该字段。需接原生 scheduler、取消与人工接管边界 | 通用部分无 |
| 管理者纠错与禁联 | 仓库有边界更新；管理 Chat 有六个人格工具 | 缺关系级“别主动联系/纠正这条回忆/兑现承诺”管理入口；设备接管不等同关系暂停 | 无 |
| 发现与领取候选 | TKDesk 拥有候选，DeerFlow 原生 handoff/claim、唯一活动 sequence、防重复建联存在 | discovery 的历史 `business_20003` 授权撤销不能由本轮审计清除；实际名单业务需供应商现场状态 | 需授权/服务，不必手机 |
| 公开建联 | Android 四动作、sender/target、原生 task/receipt、灰态及 unknown 恢复有实现 | 本轮修复新通道回归；真实账号/控件版本/新条目读回仍缺 | 真机必需 |
| 收信→聊→查/办→核验 | ChannelManager 的可信事件→Lead→outbox→回执通路有合同 | 无生产 TikTok social provider/身份连接配置，安全工具 allowlist 默认空，不能自动映射 Guild/TKDesk 业务能力 | 通用连接可离线，真实收信需平台 |
| 正式邀约与签后运营 | Guild Operator 拥有后台事实和已有工具合同 | 真实邀约、送达/已读、公会经营数据没有本轮现场证据 | 需账号与平台授权 |
| 客户安装 | 开发 bootstrap、doctor 与本机工具准备存在 | 私人绝对 MCP 路径、Java 临时工作目录、完整 SDK、安装/升级/回退向导、Windows 均未交付 | 大部分无 |
| 多设备 | 可登记 50 台；设备锁、人工接管、逐台控制存在 | 业务 worker 并发仍为 1；按设备排队/掉线隔离/公平性/结果汇总与 20–50 台长跑未交付 | 软件可离线，规模验收需设备 |
| 知识与世界材料 | 附件案例与基本来源合同存在 | 人格库深度、沟通知识库、主页预分析、World Memory 是原本明确后置的 P8 | 大部分无 |
| 发布验收 | 离线输入、局部故障测试与能力矩阵存在 | A/B 盲评、独立真实留出、成本与长期效果、目标客户安装验收缺失 | 部分无 |

### 连续记忆缺口的调用点证据

- `social/runtime.py::restore_context` 会读 `self_state/commitments/relationship`。
- `social/turns.py::commit_turn` 只传 `TurnResult`；`persistence/social/sql.py::commit_turn` 的 `memory_changes=()` 默认为空。
- `SelfMemoryChange` 的实际传入在测试中预埋；没有生产回合/管理工具 caller 负责这类写入。
- `followup` 被保存到 projection，但没有调度消费者。这应记为 **implemented-but-not-connected**，不是“等手机验证效果”。

后续应在原生仓库和回执边界补最小接线：草稿不能写成“我已经说过”，承诺不能在未确认发送时成为对方已知事实；唤醒应复用原生 scheduler，不新增第二业务账本。

## 本轮已定位并处理的具体缺陷

| ID | 业务后果与根因 | 修复/验证边界 |
| --- | --- | --- |
| F1 | external_social 替换默认 prompt 时把 SOCIAL_KERNEL 一并丢掉 | 显式装入受固定 SHA-256 校验的可信内核，再加输出合同；不载入全部管理报告 prompt；真实 Lead ModelRequest 回归 |
| F2 | Android 会话创建超时/失败时远端状态未知，却释放设备占用 | 未知创建与取消保留 cleanup fence；不因没拿到 driver 对象视作会话未创建 |
| F3 | like/follow 执行前状态缺失也可点击，再读 active 判成功 | 必须读到明确 inactive 前态；未知/已active均不点击、不升级 verified |
| F4 | 评论/私信基线截断为100项，第101项旧ID可被误认为新增 | 不能完整核对基线时 fail closed，禁止把既有条目当新回执 |
| F5 | 通用设备操作只查用户自己登记的 device_ref，另一用户可冒用同设备 | 部署 devices 配置绑定 owner；Gateway与Node核验，兼容相同设备的唯一sender owner来源 |
| F6 | 导航期间取消仍可能继续执行平台动作 | 导航后与动作前重新检查取消；聚焦离线回归 |
| F7 | 历史 nginx 文件日志绕过已有轮转器，acceptance 持续失败 | 三服务接现有 log-service；nginx stdout/stderr；启停与日志大小行为测试 |
| F8 | 本地免认证模式监听LAN，生产入口仍强制AUTH_DISABLED=1 | 本机三服务默认loopback；生产禁用bypass，显式local0保留；Docker容器内部拓扑不改 |
| F9 | doctor把配置设备离线/未授权也写为通过，fake acceptance仍用Web合同 | 设备不就绪失败；fake改Android；明确host binaries检查不等于完整SDK/真实会话 |

工作台“恢复”按钮一度被怀疑调用错端点，经追到后端确认 `accounts/{id}/resume` 已委托 Android `resume` 后才启用 sender，因此撤销该误报；不为不存在的问题改业务页面。

## 数据库、运行现场和历史日志

开始时 2026、8001、3000、4723、5432 没有服务监听；历史日志的 Ready 不代表当前服务运行。未启动真实 TikTok provider 或设备会话。

本地 SQLite 从 `0026_social_runtime` 升至 `0032_android_outreach_sender`。流程是 SQLite backup API 备份→副本调用正式 `init_engine` 演练→本地离线库正式迁移→完整性和外键检查。32 张原有表行数全部保留，新版本共39张表，`integrity_check=ok`、外键错误0。checkpoint195、writes246、threads_meta1、runs7保持原样；没有创建主播或平台事实。

回退材料在 Git 外：`backend/.deer-flow/audit-20260930/pre-migration.db`，SHA及前后清单见同目录 `migration.json`。回退应在停止所有写入者后使用完整备份，不能只退代码后混用新旧schema。

历史日志中：

- 9/27 的 Gateway 有 `GraphRecursionError`（limit12）和多次 dangling tool call 占位。属于历史运行失败，本次不能从离线通过推断已消失。
- 9/27–9/29 多次 auth bypass 警告；本轮修复生产配置与本机监听边界。
- 9/29 有 tiktoken warmup 超时后字符计数fallback；未伪称原日志问题现场消失。
- GitHub webhook 未配置404与公会业务无关；nginx空错误日志也不是可用性证明。

## 原本搁置的事项怎么继续

唯一当前台账仍是 `.agents/ledger/2026-09-24-deerflow-social-runtime.md`，本报告只提供证据，不建立第二任务台账。

手机到货前的下一批软件工作按业务闭环排序：

1. 关系管理止联/接管/纠错：认证管理 Chat、明确关系作用域、来源和版本冲突；外部会话无管理权。验收停止后不得再次派发，并覆盖跨账号隔离。
2. 记忆与真实承诺接线：区分草稿、已接受发送、未知、撤回和兑现；重启后保留出处，不能把模型自述直接当已发生事实。
3. followup 原生唤醒：同一关系取消/禁联/接管有效、一次触发、重启恢复、没有材料时 PASS；离线fake渠道先测。
4. 消息统一入口：稳定账号/creator/conversation/message归属、入站去重、同线程回复、安全工具映射；真实provider仍留待现场。
5. 客户本机安装：可移植依赖清单、诊断、受控安装/升级/回退、Windows/macOS验证。现有私人绝对路径及临时JDK路径须消除，SDK许可交互须产品化。
6. 按设备调度：沿用原生任务与执行资源锁，离线先验证掉线隔离、公平排队、取消和逐台结果；不能把50个登记槽宣称50台并发。
7. P8知识/主页/World能力按原规格继续；Jev advisory可选，不应阻挡基本聊天与业务验证。

真机到货后才做：设备授权与Appium会话、版本化TikTok定位器、当前账号/目标身份/新回执映射、单号四动作及真实来信闭环；单号完成后再做三台和更大规模。外部写入继续默认关闭。

## 本轮验收记录

最终收口证据：Social/Android/production/preflight 聚焦 **229 passed, 3 skipped**；blocking-I/O **144 passed**；ruff check/format 通过；operator 当前全套 **36 passed**；`ops/guild-runtime` 当前全套 **111 passed**，`npm run doctor -- --static` **25/25**，在 source 主机环境后 `npm run acceptance -- --static` 返回 `ok:true`（4 MCP、9/2/34/2 tools、fake adapter 无 provider 写入）。临时 PostgreSQL 16 容器上的社交、MCP、scheduler 集成 **25 passed**。

一次在 Android 最后修复完成前启动的 backend full run 返回 **17,631 passed / 21 failed / 186 skipped / 3 deselected**；其中包含当时已被修复的 owner 配置测试，最终 229 项聚焦回归已通过。剩余 full-suite 失败集中在浏览器/浏览器无头抓取、扩展安装联网、sandbox 投影、OpenViking/并行 MCP 和 pnpm 入口环境，未因本轮业务代码声称修复；完整 backend suite 因此仍不能称绿。frontend 本轮没有产品代码修改，公开建联 mocked E2E 1 passed。

本报告中的“修复”仅指对应代码与本地行为，不能升级为真机/平台已通过；没有启动服务、手机、浏览器或 TikTok 平台写入。
