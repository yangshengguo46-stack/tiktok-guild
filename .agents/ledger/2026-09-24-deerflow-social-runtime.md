# DeerFlow 公会项目总台账

台账 ID：`DSR-20260924`

原始基线：`master@ad8d9aa`

上游基线：`769589e8daee14c2587a634b6b43bd96471a41a1`

原生 Social Runtime 实施分支：`codex/deerflow-social-runtime`

状态：原生 Social Runtime 已完成；公开建联执行已转向安卓隔离分支，真机、真实 TikTok provider、客户交付与规模化仍未验收
当前写入者：`/root`

## 当前总览与未完成事项（2026-10-06）

用户已决定将公开建联的活动执行从 Web Playwright/iPhone XCUITest 转向安卓手机，同时保留点赞、评论、关注、私信业务并增加通用逐台控制。当前施工分支为 `codex/pre-device-audit`，本轮提示词清理基于 checkpoint `3c0785245`；原始 `master` checkout 尚未合并。旧 Web/iPhone 公开建联账号与回执只读保留，不再新派单；以下 2026-09-29 双通道记录仅作为历史实施证据。

安卓代码已包含 ADB 识别、UiAutomator2 通用观察/点击/输入/滑动、设备独占、人工接管/恢复、四种公开建联动作的确定性执行和读回合同。离线测试与前端检查已通过，外部写入默认关闭；本轮修复了未知 Appium session、取消竞态、旧回执 baseline、非字符串 provider ID 和部署 owner 越权。最多可**登记** 50 台，但当前业务 worker 一次只执行 1 台，尚无真机或 20–50 台并发证据。

| ID | 范围 | 状态 | 下一验收点 |
| --- | --- | --- | --- |
| P1 | 安卓单台接入 | 等手机 | 真机授权、Appium 会话、结构化元素操作、断连后的设备归属与人工接管。手机目前尚未到货。 |
| P2 | TikTok 安卓业务闭环 | 待 P1 | 采集版本化定位器，现场核对登录账号、创作者、视频和四种动作后的真实状态/新条目；单账号受控 pilot 后才可评估开启外部写入。 |
| P3 | 客户安装交付 | 编排已实现，客户验收待做 | 已有 `install:customer` 和持久安装状态；仍须固定 Node/SDK artifacts 或受信镜像，并在 Windows/macOS 全新客户环境验证无需手工配置 Java、SDK、ADB、Appium。手机端仍需用户开启调试并授权电脑。本机缺 Java，完整现场验收未通过。 |
| P4 | 多设备运行 | 待真机 | 三台真机先验证逐台任务、独占/人工接管和离线隔离；改造单 worker 为按设备调度，再依次做 20 台、50 台多主机与长时间运行、资源/延迟/token 计量。 |
| P5 | 统一收发业务 | 原生合同已实现，provider 待验收 | 已有统一 envelope、身份与回复路由、去重、typed receipt 和管理读口；本轮补齐内部回复回显检查。TikTok provider、真实来信、正式邀约和回执仍须单独闭环。 |
| P6 | 人格与模型质量 | 待现场验证 | 9/29 的 `gpt-6-sol` 合成证据出现过一次 `switch`，但默认 10 秒边界曾超时；本轮真实 preflight 4 次调用因 selector ID 合同歧义/后续纯文本合同失败即停，完整多轮、职业替换、生成启用回滚仍未通过。 |
| P7 | 上线基础设施 | 静态合同已通过，目标部署待验收 | 已有部署合同验收；临时 PostgreSQL 与 SQLite 迁移有本地证据。生产认证、目标数据库、健康路由和完整安装运行仍须在目标部署复核。 |
| P8 | 资料与经验深化 | 来源预分析与记忆已集成，真实效果待验收 | 主页/作品预分析、ConversationPlan、证据记忆和经验晋升已进入同一原生 Social Runtime；知识资料深度、真实结果反馈、多轮质量及持续唤醒仍待验证。 |

本轮开发提示净化与输出边界修复已完成本地验收；详情见
[2026-10-06 提示词清理记录](../../docs/audits/2026-10-06-runtime-prompt-cleanup.md)。

2026-10-20 用户授权 GitHub 公开发布。本批整理主项目与三插件的完整源码和 15 份 skill，
保留已有代码历史，不携带真实登录态、API 密钥或运行数据库。
见 [公开发布检查](../../docs/audits/2026-10-20-publication-preflight.md)。

### DeerFlow 人格开发材料逐项核对

附件的 `CODING_AGENT_PROMPT.md` 指定先读四份核心文件：`NORTH_STAR.md`、`docs/FINAL_SPEC.md`、`docs/PERSONALITY_SYSTEM.md`、`docs/MIGRATION_FROM_FINAL.md`。连同开工指令是五份入口材料；另有 `2026-09-24-deerflow-auto-persona-design.md` 作为用户后续修订，覆盖附件中“日常由运营者手动换装”的主流程，改为 AI 基于有来源证据自动选择。`2026-09-24-deerflow-social-agent-native-runtime.md` 将主体施工拆成 Task 1–10，不能只数文件推断已经验收。

| 原规格工作包 | 当前证据 | 尚未达到的验收 |
| --- | --- | --- |
| WP0 底座与模型 | DeerFlow fork、原生 Lead 路径和真实模型传输已核对。 | 无需重新选型；后续须在发布配置中复核。 |
| WP1 会聊天与人格 | 六模板、有效人格解析、自动选择、Chat 管理的生成/预览/绑定/清除/回滚、社交上下文和 `TurnResult` 有本地确定性测试。 | 现场真实模型只生成过未激活候选，完整生成/启用流程未验收；跨话题自然多轮、同模型 A/B、真实自动 `switch` 质量未验收。不能把本地 `stay/switch` fixture 当成“精聊完成”。 |
| WP2 连续相处 | 有来源事件、关系/自身状态、可撤回理解和重启恢复的本地合同已实现。 | 用真实对话与真实世界材料验证跨时间延续、事件唤醒、主动分享或 PASS；知识库与 World Memory 深度仍在后续范围。 |
| WP3 做得成工作 | Guild Operator、TKDesk 等工具合同及原生发送/回执边界有本地验证。 | TikTok 真实收信身份、发信、正式邀约、送达/已读回执，以及“收→聊→查/办→核验”的端到端现场闭环未验证。安卓公开建联单号 pilot 是其中一条待测执行路径。 |
| WP4 验证与发布 | 离线开发数据/回归、局部故障测试和能力矩阵已交付。 | 真实模型多轮与盲评、成本/延迟、目标部署验收及产品发布未完成；候选比较、Jev advisory 属后续可选能力。 |

因此总台账中 Task 1–10 的“完成”指**原生代码与本地验收完成**，不等于上述 WP1–WP4 的模型效果、真实材料、平台业务和发布验收都已完成。

## 2026-10-05 业务审计后的首条修复

三项目业务审计见 `docs/audits/2026-10-05-three-project-business-audit.md`。本轮只做
本地、可回归的业务基础修复，没有启用 TikTok 外部写入，也没有改账号或凭据。

嵌套 DeerFlow 当前位于安全分支 `codex/2026-10-05-business-audit`，并保留审计前
已有的 CreatorAgent、关系持久化和工作台未提交改动。发现的运行阻塞是默认人格目录指向
不存在的顶层 `config/personas.json`；已将
`backend/packages/harness/deerflow/creator_agent/personas.py` 的默认路径改为随公会项目
发运的 `ops/guild-runtime/config/personas.json`，同时保留
`DEER_FLOW_GUILD_PERSONAS_PATH` 覆盖。 `backend/tests/test_creator_agent_personas.py`
新增无环境变量的默认目录回归覆盖，并使用发运资产路径。

验证结果：在嵌套 runtime 中清除
`DEER_FLOW_GUILD_PERSONAS_PATH` 后，CreatorAgent persona、relationship、runtime 与输入
清洗回归为 **247 passed**；`git diff --check` 通过。由于工作树原本已很脏，本修复未提交，
避免把用户已有改动混入提交。

营销项目同时新增纯本地 `deerflow.marketing.sales.qualify_sales_handoff`，以显式需求、
许可、匹配和时间事实返回资格状态与单一步骤；它不发送、不创建线索、不发布。营销聚焦回归
为 **104 passed**。下一步仍是用一台明确授权的设备/provider 做真实身份、收发和回执验收；
本地通过不代表 TikTok 现场闭环已完成。

本次材料到代码的本地审计（2026-09-30）：来源 ZIP SHA-256 为 `788924f9d7e3d63327d85351f76088ecd6427141396d42a9752bdd448a930ba1`，与执行性修订记录一致；`python3 scripts/verify_creator_agent_assets.py` 验证 76 个附件文件通过。当前安卓审计分支上指定 Social 测试 **404 passed**；补回冻结 `SOCIAL_KERNEL` 后 Lead ModelRequest 仍只装一份人格。9/29 合成证据确有 `switch`，本轮新 preflight 未完成，见 P6 与业务审计。本次完成的是五份入口材料与原生路径的**本地能力审计**，未进行真实 TikTok/安卓设备或产品发布终验。

## 2026-09-30 全量审计收口

详细报告见 [`docs/audits/2026-09-30-business-completion-audit.md`](../../docs/audits/2026-09-30-business-completion-audit.md)。确认的非手机业务缺口包括：生产 turn 没有 caller 写入 `SelfMemoryChange`，followup 只保存不唤醒，关系级纠错/禁联/承诺管理没有管理入口，客户安装/可移植依赖和按设备调度未交付。它们不是平台现场问题，不能继续写成“等手机即可”。

本轮本地收口证据：ops `111 passed`、static doctor `25/25`、static acceptance `ok:true`、backend 运维 `47 passed`、Social/Android/production/preflight 聚焦 `229 passed, 3 skipped`、blocking-I/O `144 passed`、Android operator `36 passed`；临时 PostgreSQL 16 上社交与既有 PG 集成 `25 passed`；SQLite 0026→0032 正式迁移保留原有行数、完整性和外键检查通过。一次在最后 Android 修复前启动的 backend full run 为 `17631 passed / 21 failed / 186 skipped / 3 deselected`，聚焦回归已消除其中的 Android 测试失败，剩余环境/上游失败仍使完整 backend 不绿。完整 frontend/客户部署终验仍按各自报告的限制处理，不得用这些计数替代真实 provider/设备证据。

主机现状：Mac 上 ADB、Java、Appium/UiAutomator2 已做启动级验证；匹配真机版本的 SDK Platform/Build Tools 尚待补齐，scrcpy 尚不可用，Windows 未验证。现有 `bootstrap`/`doctor` 面向开发与试点，不是客户一键安装。手工准备已实际遇到 JDK 安装权限、scrcpy 动态库不兼容和下载失败，因此 P3 是正式交付前的产品事项，不要求每位客户自行排障。

恢复时先读本节并核对当前分支、主机与设备状态。旧双通道 Task 的“完成”只表示历史本地合同验收，不应重新启动 Web/iPhone pilot，亦不应推断安卓真机、TikTok 写入或 50 台并发已完成。

## 2026-09-29 双通道公开建联运行合同

- DeerFlow 是唯一业务控制面和业务台账。`public-outreach-operator` 是执行壳，不创建第二套
  claim、关系、task 或 receipt 数据库。
- 公开动作固定为 `like -> comment -> follow`，随后才允许同一 sender 执行 message；同一
  sequence 不能静默切换 Web/iPhone sender。
- Web 使用普通 TikTok 账号的持久 profile，最多 50 个登记 profile、每批最多 10 个 active
  lease；iPhone 使用一台真实设备一个 active XCUITest session。
- 只有 provider read-back 形成的 verified receipt 才能推进关系状态。聊天气泡、草稿、按钮
  点击、截图或 unknown provider 结果都不算回执，也不应阻塞真实 verified inbound reply。
- profile、cookies、WDA bundle/session、设备登记和失败证据存放在 Git 外部；运行时环境只传递
  路径、并发和 WDA 连接参数。禁止代理轮换、指纹伪装、验证码绕过和其他规避检测逻辑。

## 2026-09-29 双通道验证门禁

- `ops/guild-runtime` 现在登记第四个直接 MCP：`public_outreach_operator`；已有
  `guild_operator`、`broker_operator`、`tkdesk` allowlist 不扩权。
- `doctor` 只读检查 operator 包、Playwright/Appium/XCUITest 依赖、profile 根目录可用性、
  Appium XCUITest driver catalog 注册、iPhone 登记和严格 WDA health contract；不会创建
  目录、启动浏览器/Appium session 或触发 TikTok 写入。`npm ci --ignore-scripts` 后仍须
  显式执行 `npm run ios:install-driver`；未注册状态是 `registration_required`，不算 ready。
- `acceptance --static` 使用 fake DeerFlow adapter、operator `initialize/tools/list` 和离线
  Node tests，验证四个 MCP 和工具计数；不连接真实手机、不打开真实 TikTok 页面。
- recovery 依据是 profile lease、session 过期、WDA probe、device offline、provider unknown
  和 manual takeover 的明确错误码；未知结果保持 `manual_required`/`unknown`，不能自动重试
  或推进 `public_touched/contacted`。
- Task 7 review 修复验证（2026-09-29）：runtime 相关 `ops/guild-runtime npm test` 97 passed；
  `npm run doctor -- --static` 全部通过；acceptance 的 runtime contract 返回
  `ok: true`，4 MCP、Guild 9 tools、Broker 2 tools、TKDesk 34 tools、public outreach
  2 tool families；CLI acceptance 被既有 nginx 日志文件断言阻塞。operator
  `npm ci --ignore-scripts && npm test` 43 passed。
- 完整 ops 测试的唯一剩余失败是既有 `docker/nginx/nginx.local.conf` 与
  `test/nginx-log.test.mjs` 的日志输出合同不一致；该 Docker 配置不属于双通道 runtime
  修复范围，不能把它记为 public outreach 回归。
- `public_outreach_direct_catalog` 只在 live doctor 中运行，并标记为 `direct-discovery`；
  static doctor 不把 provider catalog 探测当作静态证据。真实 TikTok provider、真实 iPhone
  WDA 和外部写入仍为 `unverified-external`。
- Appium driver registration 使用 operator 内的幂等脚本和 `appium driver list --json`
  回读；Appium CLI 不可用报告 `unavailable`，XCUITest 未注册报告
  `registration_required`，两者都阻止把 iPhone channel 报为 ready。

## 本地运行时初始化（2026-09-24 19:08 CST）

- 已按唯一入口顺序重新执行 `npm run bootstrap -> npm run doctor -> npm run acceptance`；bootstrap
  幂等完成，固定上游仍为 `769589e8daee14c2587a634b6b43bd96471a41a1`，固定 pnpm 为 `10.26.2`。
- 历史现场基线（2026-09-24）：`doctor` 15/15；`acceptance` `ok: true`，当时为 2 个 MCP、
  Guild 8 tools、TKDesk 28 tools。双通道接入后的当前静态配置是 4 个 MCP、Guild 9 tools、
  Broker 2 tools、TKDesk 34 tools、public outreach 2 tool families。
- 原生数据库当前为 `0026_social_runtime`；关系、事件、人格 profile、绑定和出站表均为 0 行，
  这是首次初始化的空状态，不代表任何主播事实或平台动作。
- 原生 `SOUL.md` 保持已核对的 Social Kernel（SHA-256：
  `3cd8a4d11d8d3cdbeb8df21f305d654926145e97f57b750316a42c9cb5798b02`）；真实用户表仍为 0 行，
  当前访问来自本地 synthetic admin，不创建真实账号。
- 三个本机服务继续运行；`/setup` 307 到 `/workspace`，`/workspace/guild` 和
  `/api/v1/auth/me` 均为 200，Gateway `/health` 为 200。

## 现场试运行阶段（DSR-LIVE-20260924-01）

目标：在不声称 TikTok 外部能力已完成的前提下，验证当前唯一版本能在本机启动，
并完成一次不触发平台写入的真实模型自动人格闭环。

顺序：

1. 本机只读 `doctor`、`acceptance` 与启动前置检查；
2. 启动当前 fork 的 Gateway/前端/工作台，做 UI 与原生 Lead 冒烟；
3. 用 `gpt-6-sol` 做一次非业务人格生成与自动选择验证，记录严格 JSON、耗时和结果；
4. 只有在取得明确授权后，才进入 TikTok 只读来信和受控单条写入验证；
5. 人格库、沟通知识库、主页预分析列入后续阶段，不阻塞本轮主体。

安全边界：本阶段不删除旧 runtime、不向远端 push、不执行平台写入；任何模型或通道
阻塞都记录为 `blocked`/`unverified-external`，不以 fixture 或 MCP 连通替代真实证据。

现场发现（DSR-LIVE-20260924-01）：公会入口 `npm start` 已进入真实 `make start`，
但前端依赖安装失败。根因已定位为 `ops/guild-runtime/scripts/start.mjs` 将固定
pnpm 工具路径写成 `ops/guild-runtime/.runtime/...`，实际已安装工具位于 fork 根
`.runtime/tools/pnpm/...`，导致回退到主机 pnpm `11.19.0`。该问题进入单一 TDD
修复批次；现场尚未进入真实模型调用或 TikTok 通道。

Ruling：停止上述“修复 start 路径”的派工——复核入口契约后确认 `npm run bootstrap`
是 `npm start` 的前置步骤，`bootstrap` 会把固定 pnpm 安装到 `ops/guild-runtime/.runtime`；
本次失败来自跳过前置步骤，不是生产代码缺陷。代价：若后续按文档顺序启动仍失败，
再以新的可复现证据开启代码修复批次。

现场结果：按正确顺序 bootstrap/doctor/acceptance/start 后，固定 pnpm `10.26.2` 生效；
Gateway 8001、Frontend 3000、Nginx 2026 均已启动，健康检查 200。当前 `npm start`
仅在本地入口注入 `DEER_FLOW_AUTH_DISABLED=1`，`/setup` 自动进入 `/workspace`，
`/workspace/guild` 返回 200，`/api/v1/auth/me` 返回 synthetic admin。账号密码认证实现、
数据库和 setup 页面均保留；`DEER_FLOW_ENV=production`/`ENVIRONMENT=production` 时后端
忽略此开关。真实 `gpt-6-sol` 人格生成耗时 12.886 秒并产出未激活候选；选择器返回合规
`stay`，真实模型语义 switch 仍未证明。完整证据见
`docs/verification/creator-agent/2026-09-24-live-smoke.md`。

## 唯一生效边界

1. 用户提供的 `CreatorAgent_FINAL_PERSONA_REV1_20260924.zip`、
   `docs/superpowers/specs/2026-09-24-deerflow-auto-persona-design.md` 和当前运行代码
   是唯一生效事实源。
2. 2026-09-23 及更早的招募运行时、方法卡、关系摘要、旧后端和累计 patch
   全部作废；只保留原工作台 UI 的路由、导航、翻译和诚实占位。
3. 默认 Lead 是唯一 Agent 入口。Social Runtime 使用原生 Gateway、Channel、
   checkpoint、权限、工具授权和前端，不设置 sidecar 或第二套业务账本。
4. 人设由 Identity + Self Memory + Role + Relationship + TurnContext 构成，
   再穿上当前 EffectivePersona。人格由 AI 依据当前主播的有来源证据
   自动选择，运营者无需手动切换；人格与子 Agent 不强制绑定。
5. 人格库/沟通知识库、主播主页预分析和 World Memory 深度实现保留为后续
   roadmap，不属于本次主体闭环。
6. 真实 TikTok 收信、发信、正式邀约、送达/已读回执全部为
   `unverified-external`；不把草稿、MCP 连通或离线 fixture 宣称为已发送。

## 任务台账

| Task | 状态 | 交付/验收 |
| --- | --- | --- |
| 1 | 完成 | 根仓已是真实 DeerFlow fork；上游与 pre-fork master 均为祖先；备份与外层现场未破坏。 |
| 2 | 完成 | 原生 Social 合同、有来源事件、有界状态和 `reply|tool|wait|no_reply` 已落地。 |
| 3 | 完成 | Identity/Self/Role/Relationship/EffectivePersona/TurnContext 恢复与投影完成。 |
| 4 | 完成 | 六份 `1.0.1` 人格资产、作用域绑定、自动选择、严格生成/激活边界完成。 |
| 5 | 完成 | 同库事件、投影、人格、出站、CAS、重启和未知回执语义完成。 |
| 6 | 完成 | 默认 Lead 原生装配、单人格投影、私有模型输出隔离和 commit-before-disclosure 完成。 |
| 7 | 完成 | 有身份 Channel 门禁、去重、二次边界校验和不盲重试完成；无 TikTok provider。 |
| 8 | 完成 | 默认 Chat 中的认证管理工具完成；ignored start config 已从不受支持的 `gpt-5.4` 改为 `gpt-6-sol`，真实模型传输成功；第 6 次输出触发严格 expression parser，第 7 次最终 probe 超时，未激活。 |
| 9 | 完成 | fork-native bootstrap/start/doctor/acceptance、两个直接 MCP 静态合同和开发评测加载完成。 |
| 10 | 完成 | 隔离副本迁移、SOUL 保留、定向/离线/整库门禁、独立复审和本地 fast-forward 完成。 |
| Dual-Channel 1 | 完成 | 原生 sender/action task 合同与幂等约束完成；无外部写入。 |
| Dual-Channel 2 | 完成 | 版本化 `public-outreach-operator` MCP shell、Web/iPhone receipt envelope 和四 MCP 注册完成。 |
| Dual-Channel 3 | 完成 | Playwright profile registry、10 槽位 pool、顺序公开动作与人工接管边界完成。 |
| Dual-Channel 4 | 完成 | Appium/XCUITest device registry、WDA 严格健康检查和单设备 session 完成。 |
| Dual-Channel 5 | 完成 | Web/iPhone 统一接入 `gray -> public_touched -> contacted -> replied`，气泡/草稿不抑制真实回复。 |
| Dual-Channel 6 | 完成 | 原生 API 与公开建联 workbench 完成；provider 未配置时 fail closed。 |
| Dual-Channel 7 | 完成 | 运行时环境、只读 doctor、fake acceptance、四 MCP catalog 与恢复手册完成；真实 provider 仍未验收。 |

## Task 10 迁移纠正

- 源备份 DB 不是 `0025` app DB。它没有 `alembic_version`，
  `PRAGMA user_version=0`，只有 LangGraph 的 `checkpoints`、`store`、
  `store_migrations`、`writes` 四张表。
- 未执行裸 `alembic stamp/upgrade`。隔离副本通过正式
  `init_engine('sqlite') -> bootstrap_schema` 走 `empty -> create_all + stamp head`，
  建立当前 `0026_social_runtime` schema。
- 原四表行数保持 `0 / 0 / 5 / 0`；新 app 社交表均为 0，因此没有可迁移或
  可推断的事实、承诺、禁联、人工接管或人格指纹。
- 迁移后 DB SHA-256：
  `5af704ac1ea4ef774f83332a345108d9bd0459c755a3a6a10a4ea6b8cc639e9c`。
- 恢复后 SOUL 与未变备份 SHA-256 均为
  `3cd8a4d11d8d3cdbeb8df21f305d654926145e97f57b750316a42c9cb5798b02`。

## 验证摘要

- Social + eval focused：`426 passed`。
- 明确离线分支矩阵：`21 passed`。
- MCP focused：`716 passed, 10 skipped`。
- 回归修复：分支新增的 4 个全量失败已在隔离测试中复现，根因修复后
  `4 passed`，关联组合回归 `55 passed`。
- Blocking I/O：`144 passed`；backend lint：通过。
- Frontend check：通过；sidebar/workbench Playwright：`5 passed`。
- Frontend full：201 files / 1626 tests，`1599 passed, 27 failed`；两个 DOM storage
  文件下的完全相同失败已在 untouched upstream + Node 26.4.0 复现。
- Ops：`35 passed`；doctor 15/15；acceptance `ok: true`。新增 auth-gate 启动回归和 WAL 快照
  warm-up 回归覆盖本地免注册与 macOS 只读打开语义。
- Backend full：`18 failed, 17531 passed, 189 skipped, 3 deselected`；18 项与 untouched
  upstream 精确匹配，分支新增失败为 0。详见
  `docs/verification/creator-agent/final-verification.md`。

## 外部阻塞

- 真实模型：传输 `verified-model`，人格生成质量 `blocked`。共 7 次授权调用；配置已改为 `gpt-6-sol`。第 6 次 raw/usage 已保存但嵌套 override 被严格 parser 拒绝；补齐 flat contract 后第 7 次最终 probe 以 30.003 秒 `invalid generator response` 超时，WP1 multi-turn 未发送。默认 generator timeout 已由 15 秒调为 45 秒，以覆盖实测 20.532 秒成功响应。
- 现场追加的非业务探针已用 `gpt-6-sol` 在 12.886 秒生成未激活候选；真实选择器能返回严格 `stay` 决策，但尚未证明语义不匹配时会真实 `switch`，因此切换质量继续标记 `blocked`。
- PostgreSQL：`blocked`，无 live server 集成证据。
- TikTok inbound/outbound/invite/delivery/read receipt：全部 `unverified-external`。

## 历史记录

- 2026-09-24 04:12 CST：建立台账与三项只读审计。
- 2026-09-24 04:27 CST：锁定真实 DeerFlow fork 为唯一代码事实源。
- 2026-09-24 04:34 CST：纠正“人格必须绑定子 Agent”的误解；人格只是可选解析层。
- 2026-09-24 04:58 CST：用户要求按四份详细方案直接施工，实施计划锁定为 10 个任务。
- 2026-09-24 15:xx CST：Task 10 完成隔离状态 bootstrap、全产品验证和证据收口；独立复审通过并完成本地 fast-forward。
- 2026-09-24 18:xx CST：现场试运行第一批完成；本机三服务启动成功，真实模型生成候选成功，
  本地 auth gate 暂停，工作台无需注册即可进入；出厂前恢复正常认证。
- 2026-09-24 19:08 CST：按计划完成本地运行时初始化复核；空关系状态保持不变，未创建账号、主播事实或平台动作。

## 2026-09-28 审计收口补记

- 稳定性修复、运行诊断、可选 TikHub、供应商原版配置加载和本地插件合同按现有证据收口；不把离线或只读证据升级为 TikTok 外部完成。
- `business_20003` 事故确认是 Agent 把“检测”误走成真实 `full_auto` 运行。已补 MCP 工具说明、`tkdesk-agent` skill 被动检查门禁和回归测试；保留 20003 的授权撤销与 fail-closed 语义。
- 当前没有活动运行；`tiktok_discovery` 因 20003 保持封锁，collection-backstage 独立 readiness 不替代 discovery 授权。恢复必须由明确的线上运行意图触发，并先做零查询检查。
- 真实长跑、真实来信/发信/邀约/回执、模型语义切换、PostgreSQL live、自有授权替代供应商来源继续是 `unverified-external`、`blocked` 或 roadmap 延后。
- 2026-09-29：当前配置 `gpt-6-sol` 的真实 selector 跟进已记录；合成 `stay` 以 0.99 置信度在 4.804 秒返回，合成 `switch` 曾在默认 10 秒边界超时，随后 30 秒有界探针在 5.552 秒返回 `clear_direct@1.0.1`、置信度 0.99。语义 switch 已验证，默认 10 秒截止的偶发延迟仍待稳定性评估，证据见 `2026-09-29-project-closeout-selector-evidence.json`。

## 2026-09-29 经纪人 profile owner 收口

- 现场确认旧的经纪人 MCP 进程 PID 7480 及其 headless Chromium 子进程 PID 8152 脱离当前 Gateway，独占 `~/.codex/tiktok-live-broker-operator/profile`；当前 Gateway 只留下新的三 MCP 配置，症状表现为 `profile_busy`、`ProcessSingleton` 和重复登录。
- 已备份经纪人操作库后优雅停止旧 owner；没有删除 profile、登录资料或锁文件。现有 profile 的最近登录状态保留。
- Gateway MCP cache 已重置。使用同一 profile 启动新的 broker server，`broker_workspace` 成功读取 Atlantis（guild `103785`），未再出现 `login_required` 或 `profile_busy`。
- 本次仅做 workspace 读取和进程恢复，没有执行 TikTok 发信、邀约或其他平台写入；外部消息/回执继续保持 `unverified-external`。

## 2026-09-29 双通道最终集成复核

- 原有 dirty worktree 已保存在 `stash@{0}`（基线 `895233fbe`），未删除或应用历史变更。
- Task 1–8 的既有软件交付记录仅覆盖已提交的合同、离线执行器、控制面和证据，
  不代表 Task 8 的真实平台 pilot、live parity 或扩容完成。
  最终复核发现 Gateway operator 的生产初始化、native MCP adapter、真实 Playwright/Appium
  transport 未实际接线；整条可执行链继续标记 **执行中**。
- 当前实现 SHA `02521d405` 已修复 completed message replay、Web owner 心跳与 fencing、
  Web/iOS fresh readback 和 profile 独立 task_id 持久化问题。
- Dispatch `production-outreach-integration-20260929`：基线 `02521d405`，唯一实现者
  `/root/implement_production_outreach_integration`，状态 **执行中**。文件归属为生产 bridge、
  Gateway 生命周期/执行入口、native MCP adapter、driver factory、相应测试与运行说明；根
  Agent 维护既有计划、台账和证据并独立验收。未启动 Claude 协作或真实 TikTok 写入。
- Ruling: 生产接线是原计划 Task 2/5/7 的必要补完，不另起产品或业务账本；默认 provider
  写入门禁保持关闭，使用离线真实 transport 合同验证后再进入单号 pilot。若判断错误，成本
  是本批可逆代码返工；不能把 fake adapter 的通过率当作已经可运营。
- 验收要求：认证身份不可由模型参数覆盖；native task 经真实 transport 接口产生结果并写回
  同库；caller receipt 不得伪造完成；timeout/exit/lease loss 不得盲重试；shutdown 不泄漏
  进程或锁。真实 Web/iPhone selector、收发信及十号/五十号容量继续未验证。
- 独立复审 `02521d405` 为 **NOT CLEAN**。离线 API 形状复现确认：当前登录账号未核验；
  count 增长混入历史同文；Playwright `first()/last()` 方法误用；生产 adapter 缺失；
  浏览器启动失败释放锁缺 owner；iOS 单项/集合 selector 转换不一致。后端 focused
  `36 passed` 和 operator `50 passed` 不能推翻这些复现。上述问题合并进入当前唯一实现
  批次，历史证据已撤回“可进入 pilot”的表述。

- 集成交付 `75318ad4fcbd5d637fc1baba1e45fc0dab2596ef`：Gateway 原生服务、per-owner MCP
  认证、Node JSONL worker、Playwright/Appium transport 和显式 execute 入口已提交。根 Agent
  同 SHA 独立验证 backend 87、operator 65、runtime focused 41、真实 auth + native MCP
  HTTP/SQLite smoke、static doctor、frontend lint/types/build 和 mocked E2E 1 均通过。
- 独立验收发现新增 helper 自动发现回归：完整 `acceptance -- --static` 为 122 passed、
  2 failed，失败分别为新增 `test/fixtures/web-worker.mjs` 缺执行配置、历史 nginx 日志断言。
  当前状态 **独立审查中**，前者必须修复，后者不能伪称已通过；真实平台仍未运行。

- 独立集成复审 `75318ad4f` 为 **NOT CLEAN**，前一轮六项接线/读回问题已实质修复；
  本轮真实本地 transport 故障注入仍复现四项：同 owner/sender/creator 的原生
  `do_not_contact` 未门禁；取消/畸形回执/硬退出后，已派发任务租约恢复可重复评论；
  Web close 失败被吞掉并释放 profile/host 锁；worker fixture 被父测试发现后崩溃。
- 唯一关键修复 dispatch `production-outreach-critical-repair-20260929`，BASE
  `75318ad4fcbd5d637fc1baba1e45fc0dab2596ef`，实现者仍为
  `/root/implement_production_outreach_integration`，状态 **执行中**；完整发现一批修复后
  做一次限定复审，禁止把历史 nginx 失败或真实 pilot 混入此批。
- Ruling: 外部尝试开始前写入原生持久标记；未确认完成的已派发动作过期后必须人工核对，
  普通资源锁及未派发任务才可安全回收 — 从上游任务事实阻止重复评论/私信，并保留既有
  同作用域禁联优先级 — 若过度保守，成本是额外人工核对及可逆流程返工，不是盲目重发。
- 前端额外独立检查：执行门禁关闭、原生成功后完成、原生拒绝后显示原因/无自动重试
  三项 UI 冒烟均通过；所有 public-outreach API mocked，TikTok 请求数为零。临时
  Next 服务已停止，没有启动业务后台或操作真实账号。

## 2026-09-30 双通道关键修复与固定 SHA 验收

- 唯一关键修复批次 `production-outreach-critical-repair-20260929` 已交付
  `e05f83ae9216a229d161bc29c1a8c2b0d3962470`（基线 `75318ad4f`）；
  同 owner/sender/creator 原生禁联在受理、claim、provider 派发前均检查，
  不同作用域保持独立。外部 provider I/O 前在原生 task 写持久 attempt 标记；
  调用者不能写入/覆盖内部 dispatch、manual、lease、receipt 字段。
- 已派发而未确认完成的任务，在 claim 过期、显式 release、取消、异常和进程硬退出后
  均保持人工核对/暂停，不再自动回到 pending；普通未派发租约才可回收。
  verified proof 与原生任务关联原子入库；证明已存而 task 未完成时不能重试、用 unknown
  覆盖或重复评论。需要明确人工授权的 retry 与独立 sender resume，不能把它们视为
  已获平台确认；不承诺外部 exactly-once。
- Web `context.close` 失败不释放 profile/host slot。启动前写 cleanup-required 资源标记，
  即使 Node owner 已死/租约已过期仍将锁和容量计为占用，只有确认关闭并清理后恢复。
  iPhone session 删除失败同样保持占用。测试 worker 已移出父包自动发现目录。
- 根 Agent 对固定 SHA 独立运行：backend focused **104 passed**、operator **71 passed**、
  runtime focused **41 passed**；本机 real-auth HTTP/SQLite + shipped stdio native MCP
  冒烟通过且未启动 provider；static doctor 全通过。完整静态 acceptance 为
  **128 passed / 1 failed**，唯一剩余失败是历史 nginx 日志断言，不能称整套绿。
  前端在 `75318ad4f..e05f83ae9` 没有代码变化，沿用此前 TypeScript/lint/build、
  mocked E2E 1 和执行 UI 3 场景通过的同源码证据。
- 根 Agent 另用 pinned Playwright 实际启动匿名 `about:blank` Chromium，强制 SIGKILL
  Node 后发现 Chromium 使用独立进程组；模拟租约过期，重新 claim 返回
  `profile_cleanup_required`，原持久锁内容不变。演练自身 Chromium/临时目录已清理；
  无 TikTok 导航或写入。限定独立复审仍在进行中。
- 原始 dirty worktree 仍由 `stash@{0}` =
  `c17efdf9a13bc9089e0d0d3909a924a375a66892` 保留，不应用、不删除。
  原有计划、本文、协调入口和能力矩阵原位更新，不另起台账/开发手册。
- 部署 DB 仍为 `0026_social_runtime`、public profile root 未初始化、无登记 iPhone；
  TikTok/Web/iOS 真实 sender/creator/新 item read-back 映射没有现场证明。Web/iPhone
  单号 pilot、live receipt parity、十号到五十号扩展保持 `unverified-external`/`blocked`，
  本批未做迁移、真实平台动作、push 或 PR。
- 限定独立复审 `e05f83ae9` 为 **NOT CLEAN**：原四项中的禁联、资源清理与测试 helper
  已关闭；持久派发边界仍有两个可重复的漏窗。R1：并发普通 payload 更新从旧 JSON
  覆盖 `_external_attempt_started`，过期后会误回 pending 并允许盲领；R2：FOLLOW 或 DM
  task 提交完成后取消，proof 留存但关系没有推进，重复执行只返回 duplicate，分别卡在
  `gray` 或 `public_touched`。独立本地复现脚本和精确输出保存在本计划 SDD scratch；
  该报告没有修改源码或触发平台。
- Ruling: 这两处属于已授权目标中的关键原生终局边界，继续由原唯一实现者做一批有限
  修复再做限定复审；不把已知盲重试和永久灰态交给真实 pilot。若判断错误，成本是额外
  一次可逆本地修复/复审，不涉及平台写入、迁移或扩容。
- 终局补丁 `production-outreach-terminal-boundary-20260930` 已交付
  `d4fd1444a1277583387ccb8cb69e690ccda360e9`，仅改 5 个原生实现/测试/runbook 文件。
  普通 payload 修改要求 pending 状态和 `updated_at` CAS，旧读不能覆盖派发标志；
  FOLLOW/DM 的已绑定 verified proof 经原生身份、动作/组/回执类型与禁联/关闭边界校验后，
  task 完成与 claim/sequence 状态推进同一事务。提交前中断后，明确 execute 只用原生
  proof 完成结算并返回 duplicate，不能再次调用 Node/provider。
- 实现者最终 backend focused 124、operator 71、父包静态 128 passed/1 历史 nginx
  failed；根 Agent 在固定 SHA 上独立复跑 backend **124 passed**、operator **71 passed**、
  real-auth native MCP/HTTP/SQLite smoke **passed**、父包静态仍 **128 passed/1 历史
  nginx failed**。前端与 operator 源码在 `75318ad4f..d4fd1444a` 没有变化；
  e05 的匿名真实 Chromium 资源故障演练适用于同一 Web 资源源码。
- 固定 `d4fd1444a` 终局补丁限定独立复审 **CLEAN**：R1、R2 均 ADDRESSED，本补丁未引入
  重要新问题。复审者将旧三个失败场景转为 `--expect-fixed` 正向断言，精确验证普通旧读
  被拒、派发标志保留/过期后 failed+manual_required/暂停 sender/拒绝盲领，以及 FOLLOW/DM
  提交后取消时 claim 与 sequence 分别同达 `public_touched`/`contacted`、proof 保留、
  每目标 provider 仅提交一次、FOLLOW 后 DM 可 verified。独立脚本 3 场景 exit 0，
  窄后端 **20 passed**。这是本地软件限定验收，不能升级为 live provider/device 已通过。

## 2026-09-30 Web 登录预检现场反馈

- 用户要求打开一个窗口手动登录 TikTok。根 Agent 使用已安装的 pinned Playwright
  Chromium，打开单独持久 profile 的 `https://www.tiktok.com/login`；本地资源别名
  `web:pilot_001`，只导航登录页，脚本没有填账号、提交表单或执行任何公开动作/私信。
  用户随后反馈页面在登录时显示“访问频繁”。没有获取页面诊断、实际登录结果或平台
  风控原因的可验证证据，不能把它归因于账号、网络或自动化指纹中的任一种。
- 收到反馈后立即正常关闭该 Chromium context，原进程退出；核对该 profile 的锁不存在、
  关联浏览器进程为 0、资源状态 `disabled`/`unknown`。本地 profile 目录仍保留，不在
  Git 中；没有继续导航、反复登录、切换代理或处理验证挑战。
- 这次仅是登录预检受阻，不是 Task 8 的单账号 Web 行为 pilot；Web provider 身份/
  新回执映射继续 `unverified-external`。暂停 Playwright 登录路径及后续写入测试，先通过
  用户正常使用的官方渠道核对账号状态并评估本次提示，再决定是否另行安排受控试跑。

## 2026-09-30 iPhone 接入预检

- 用户转向 iPhone 单设备试跑，当前仅做只读本机/依赖检查并打开 Xcode，未连接手机、
  启动 Appium/WDA session、打开 TikTok 或执行平台动作。
- `/Applications/Xcode.app` 存在，Xcode `26.5` 可由显式 `DEVELOPER_DIR` 调用；系统当前
  developer directory 仍指向 Command Line Tools。`devicectl` 报 Xcode/SDK 许可尚未
  同意，这一法律许可必须由用户本人阅读并同意；没有代为接受或修改系统选择。
- USB 清单未见 iPhone/iPad，DeerFlow iOS 设备登记目录仍不存在。静态 doctor 检查
  Playwright/Appium `3.1.0`/XCUITest `12.13.3` 均已安装和注册，但没有 ready 设备。
  XCUITest doctor 的模拟器/可选 Remote XPC 项不能代替真机配对、签名 WDA 和健康读回。
- 下一门槛由用户在 Xcode 完成许可/必要组件，USB 连接并信任解锁的 iPhone，按设备
  提示开启 Developer Mode / UI Automation，并在官方 TikTok App 手动登录。之后再做
  `devicectl`、WDA 签名/探针和单号只读检查；遇“访问频繁”立即停止，不绕过提示。

## 2026-10-01 Creator Intelligence implementation direction

The owner clarified the target: a mature broker-style Lead should inspect a creator's sourced profile and works, know the appropriate opening and staged path toward formal guild admission, and update its approach from confirmed outcomes. The implementation is explicitly integrated into the existing Agent stack: `CreatorEvidence`/`ConversationPlan` live under `deerflow.social`, are injected into the native Social Runtime beside the resolved persona, and reuse existing SocialRepository, ChannelManager, checkpoint, and scheduler. It must not become a second Agent, CRM, worker, MCP, or business ledger. Persona controls expression; intelligence controls grounded content and sales stage; memory controls durable continuity. The success target is verified application/signing, while refusal, uncertainty, or provider unknown results pause or hand off.

## 2026-10-01 Creator Intelligence evaluation boundary

Two synthetic/public-like fixtures exercise planner continuity, accepted-memory promotion, stage progression and the formal-invite consent gate. Preflight fields `intelligence_snapshot_revision`, `plan_stage`, `estimate`, `memory_promotions`, and `verified_funnel_stage` are offline evidence only; they do not establish live conversion, provider receipt, phone readiness, customer installation, or TikTok delivery.

### 2026-10-01 Creator Intelligence final acceptance

Final review of the creator-intelligence range found no Critical/Important findings. The final focused suite passed 321 tests; blocking-I/O passed 144 tests with only upstream deprecation warnings; `ops/guild-runtime` passed 111 tests; Ruff and `git diff --check` passed. The full backend non-live run was 17,665 passed, 189 skipped, and 21 failures in existing browser/MCP/pnpm/extension environment coverage; the isolated social concurrency failure passed when rerun.

Current HEAD is `cc7275369` (implementation hardening through `97c331208`). The implementation remains native and offline-bounded: no live TikTok delivery, provider receipt, Android readiness, signing, customer installation, or conversion is claimed.

## 2026-10-01 手机前非现场收口批次

### 2026-10-01 预检评估器一致性修复

真实模型预检后的审计发现已收口：CAS `persona_fingerprint` 会随 `evidence_version` 更新，
因此不能直接用它判定人格是否换了。离线评估现要求 host-derived
`persona_consistency_key`，用于比较 profile/template/表达行为；exact fingerprint 仍作为
每轮提交证据保留。合成运行夹具现明确断言人格一致且评估通过；真实模型第二轮 plain-text
输出合同失败仍是独立阻塞。该修复只改离线评估边界，没有放宽生产解析或平台写入门禁。

用户授权继续完成 P3/P5/P6/P7/P8 的本地工程补齐。本批仍复用原生 Lead、Channel、SocialRepository 和 ops 入口，没有新增 Agent、CRM、worker 或业务账本。

- **P5 统一收发基础**：原生 `message_bus` 提供统一 inbound/outbound envelope、身份与回复路由、adapter-owned message ID 去重、typed delivery receipt 和 `GET /api/channels/unified` 管理读口。没有 provider receipt 的发送保持 `unknown`；TikTok 在 provider 未核验时保持 `manual_required`。这批不是 TikTok 实际发信验收。
- **P6/P8 资料与质量**：CreatorEvidence 之上新增来源约束的主页/作品预分析摘要（hooks、风险、开放问题、证据引用、新鲜度和置信度），并接入 SocialContext；新增离线多轮评测报告，检查阶段推进、人格指纹一致性、证据覆盖、JSON 合同失败和 P50/P95 延迟。评测只使用合成 fixture，不升级为真实转化结论。
- **P3/P7 运维入口**：ops 增加 `npm run install:customer` 和 `npm run acceptance:deployment`，固定 Node/Java/Android/Appium 合同路径、安装状态、生产认证、loopback 发布、迁移、健康路由和日志轮转检查。macOS 通过受控 Homebrew，Windows 通过 winget 编排缺失 Java/Android 工具；Linux 缺少固定工具时 fail-closed。固定 Node/SDK artifacts 或受信镜像仍需产品化，不能记为客户安装完成。

本批验证：backend 统一收发、Social/Intelligence、preflight、scheduler、repository 聚焦 **334 passed**（FastAPI 上游弃用警告 1 条）；Ruff 与 `git diff --check` 通过；`ops/guild-runtime` **121 passed**；部署静态合同 **5 项通过**；本机 doctor 因 Java Runtime 缺失失败，属于现场依赖阻塞。真实 TikTok provider、手机、平台回执、客户跨平台安装和生产部署仍未验收。

## 2026-10-06 开发提示净化与回复边界

用户批准清理本次审计发现的运行时开发说明。通用 Lead/通用子 Agent 提示和模型可见文件工具说明已移除开发示例、虚构研究报告、issue 与其他编程 Agent 的实现比较。官方 SOUL 模板已去除版本/阶段/未来适配器说明，安装器只迁移完全匹配的旧官方版本；自定义文件不被自动覆盖。本机已安装 SOUL 经定向清理，业务要求与追加内容保留，旧内容备份于 Git 外。

外部 Social Lead 仍先校验完整冻结资产，再提取会话原则；未修改原始附件、manifest 或六人格资产。新 `TurnResult.reply` 在提交前拒绝已知内部结构/工程文本；ChannelManager 对历史 pending 在 replay 前、claim 前及实际 claim 输出各检查一次。拒绝时不发送、不自动重新生成、不伪造回执、不把私有文本写进拒绝日志。正常身份披露、技术字段讨论和真实发送状态仍可表达。

验收：最终完整聚焦 backend **468 passed**；补齐精准原句检查后定向 **32 passed**（与前项重叠）；文件工具/安全/子 Agent 路由 **178 passed**；ops **123 passed**；冻结附件 **76 文件通过**；Ruff check/format 和 `git diff --check` 通过。独立复审 **bounded CLEAN**：前次误拦与已知标签/单引号 dump 漏拦已修复。这是已知签名防护，不能据此保证任意自然语言泄漏均被识别。本轮没有真实模型调用、平台写入或现场交付验证。

## 2026-10-20 完整源码与插件公开发布

用户明确要求上传并公开全部项目内容，包含爬虫插件和公会运营助手 skill。
主仓库沿用 `yangshengguo46-stack/tiktok-guild` 和 `codex/pre-device-audit` 默认分支。
增加 `plugins/tkdesk-agent`（0.9.0，110 文件/3 skills）、
`plugins/tiktok-live-guild-operator`（0.15.0，62 文件/11 skills）和
`plugins/tiktok-live-broker-operator`（0.1.0，31 文件/1 skill），含实现、配置模板、
锁文件、测试和参考资料，原有许可声明不变。排除实际 node_modules、浏览器 profile、
Core 授权文件、API 密钥、数据库和日志；不覆盖正在使用的本机插件实例。

发布前新环境 `npm ci --ignore-scripts` 三包均通过；TKDesk 491、公会运营助手 109、
经纪人 58 项离线测试通过（共 658）；冻结附件 76 文件校验通过。
本地所有 Git refs 的 Gitleaks 扫描报告 15 处命中，逐项复核为上游测试/文档假值与
公开 OpenAPI SHA-256 摘要；确切待发布树另有 15 处测试/文档假值命中，含插件的
两个合成幂等 key。没有把扫描 exit 1 表述为零命中，也未通过宽泛 allowlist 隐藏命中。
详情见发布检查记录。源码公开不等于真实 TikTok、手机或生产交付验收。
