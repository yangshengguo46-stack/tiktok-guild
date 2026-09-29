# DeerFlow Social Runtime 台账

台账 ID：`DSR-20260924`

原始基线：`master@ad8d9aa`

上游基线：`769589e8daee14c2587a634b6b43bd96471a41a1`

实施分支：`codex/deerflow-social-runtime`

状态：原生 Social Runtime 已完成；双通道公开建联 Task 1–7 已实施并完成本地合同验证，真实 TikTok provider 仍为 `unverified-external`
当前写入者：`/root`

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
