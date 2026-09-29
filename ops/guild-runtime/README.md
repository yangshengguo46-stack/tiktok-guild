# TikTok LIVE 公会 DeerFlow CreatorAgent

本目录为当前 DeerFlow fork 的默认 Lead 提供本机运维配置。2026-09-24 起，产品唯一生效规格是用户提供的 `CreatorAgent_FINAL_PERSONA_REV1_20260924.zip` 及 [AI 自动切换人格修订](../../docs/superpowers/specs/2026-09-24-deerflow-auto-persona-design.md)。较早的招募运行时、关系摘要、方法卡、通道来源和旧计划均已作废；只保留了原有“工作台”的路由、导航、翻译和诚实占位。

当前包内容：

- 六份不可变的 `1.0.1` 表达人格，新关系默认 `relaxed_wit@1.0.1`；
- 同一 DeerFlow SQLite 中按 `(运营者, 公会账号, TikTok 主播 UID)` 隔离的关系证据与人格决策；
- 默认 Lead 根据当前主播本人的有来源交流证据自动保持或切换人格，常规流程没有运营者手动换装器；
- 附件 `SOCIAL_KERNEL.md` 作为默认 Lead 内核；TKDesk 仍拥有候选主播事实，Guild Operator 仍拥有公会后台事实。
- `public-outreach-operator` 作为第四个直接 MCP，只负责普通账号的 Web/iPhone 执行；主播 claims、action tasks、关系状态和 verified receipts 仍只写入 DeerFlow 原生库。

人格只改变观察与表达，不改写身份、关系事实、承诺、禁联或权限。不允许用职业、性别、收入、主播规模或推测脆弱性进行配型。

## 当前能力边界

公会长和经纪人现在是两套工作插件。`guild_messaging` 只使用公会长 profile；独立的 `broker_operator` MCP 只暴露 `broker_workspace`、`broker_messaging`，使用单独进程、单独浏览器 profile 和固定的 `sender_account_ref`。两边都复用“精确收件人 → 搜索 → 发送 → 平台响应 → 会话回读”流程，主播 ID 直接使用 TKDesk 名单里的 `userId`。代码和离线测试不等于本轮真实 TikTok 发信已验收，仍需在用户指定的经纪人 profile 中完成一次受控现场验证。

运行时会自动把下面三个非敏感配置传给经纪人 MCP；如果要换经纪人，可用本机环境变量覆盖（不会进入工具参数或项目文件）：

```sh
export TIKTOK_BROKER_PROFILE_DIR="$HOME/.codex/tiktok-live-broker-operator/profile"
export TIKTOK_BROKER_ACCOUNT_REF="affiliate:mira.creator_01"
export TIKTOK_BROKER_IDENTITY_TEXT="Mira"
```

首次使用先在这个 profile 的可见 Backstage 窗口登录经纪人账号。之后 Lead 先调用 `broker_workspace` 获取 `guild_ref`，再把候选的 `userId` 作为 `creator_id` 传给 `broker_messaging.prepare_message`，最后用同一 `workflow_id` 调 `broker_messaging.send_message`。没有经纪人 profile 或身份标记不一致时，工具会失败并停止，不会回退到公会长账号。

普通账号的公开建联动作由独立的 `public-outreach-operator` 执行。它支持 Playwright 持久 profile
和 Appium/XCUITest iPhone 会话，但两条线路共用 DeerFlow 的 sender、sequence、task 和 receipt
合同。默认最多登记 50 个 Web profile，每批最多 10 个活动 profile；不会在运行时创建代理池、
指纹伪装、验证码绕过或其他规避检测能力。

这些配置只包含路径、并发和 WDA 连接参数，登录资料、cookies、设备登记和截图证据留在
`$HOME/.codex/tiktok-live-public-outreach/` 或显式指定的本机目录，不进 Git：

```sh
export PUBLIC_OUTREACH_OPERATOR_ROOT="$PWD/ops/guild-runtime/public-outreach-operator"
export PUBLIC_OUTREACH_PROFILE_ROOT="$HOME/.codex/tiktok-live-public-outreach/profiles"
export PUBLIC_OUTREACH_MAX_ACTIVE="10"
export PUBLIC_OUTREACH_IOS_DEVICE_ROOT="$HOME/.codex/tiktok-live-public-outreach/ios-devices"
export PUBLIC_OUTREACH_IOS_WDA_BUNDLE_ID="com.example.WebDriverAgentRunner"
export PUBLIC_OUTREACH_IOS_WDA_PORT="8100"
export PUBLIC_OUTREACH_IOS_WDA_TIMEOUT_MS="10000"
export PUBLIC_OUTREACH_IOS_REQUIRE_WDA_PROBE="true"
```

`PUBLIC_OUTREACH_IOS_REQUIRE_WDA_PROBE` 必须保持为 `true`。只有 macOS、Xcode、已签名
WebDriverAgent、已配对且在线的 iPhone，以及返回 `ready=true`、`device_verified=true`、
`wda_verified=true` 的实时 probe，才能把设备记为 `ready`。doctor 只读设备登记文件，不会
连接手机、启动 Appium、启动浏览器或写入 TikTok。

## 安装与启动

```sh
cd /Users/yangyucheng/Documents/ChatGPT/Tiktok公会
cd ops/guild-runtime
npm ci
npm run bootstrap
npm run doctor
npm start
```

`bootstrap` 校验固定的上游 commit 是当前 fork 的祖先，然后直接在 fork 根目录安装依赖；它不 clone 第二份 DeerFlow，也不应用产品补丁。社交内核安装到原生 `backend/.deer-flow/SOUL.md`；如果恰好是本项目上一版业务优先内核，它会安全迁移，用户自定义的 `SOUL.md` 不会被覆盖。`start` 也会执行同一次安全安装/迁移，再从 fork 根目录运行 `make start`。

当前开发与验收阶段，`npm start` 会临时注入 `DEER_FLOW_AUTH_DISABLED=1`，使用 DeerFlow 内置的本地 synthetic admin，因而不会被 `/setup` 的账号密码注册页拦住。账号、密码、会话和数据库实现均保留；出厂部署前移除该启动注入即可恢复正常认证。后端在 `DEER_FLOW_ENV=production` 或 `ENVIRONMENT=production` 时会忽略此开关，并在本地生效时输出明确警告，因此不要把这个本地模式暴露到共享或生产环境。

原生运行时只读受 Git 跟踪的 `config/extensions_config.guild.json`；它固定
`guild_operator`、`broker_operator`、`tkdesk`、`public_outreach_operator` 四个 MCP server 及它们的
精确有序工具 allowlist。本机被 `.gitignore` 忽略的 `extensions_config.json` 不是这个公会运行时的配置来源。

TKDesk 的 `reopen_login` 是采集子后台恢复工具：经明确授权后，只在已核验的专用 Chrome 中打开固定官方后台页；保留进程、登录资料与人工标签。DeerFlow 的工具白名单已包含它，但调用前仍须验证线路和身份；它只负责名单和 `userId`，公会长消息发送归 `guild_operator`，经纪人消息发送归 `broker_operator`。

`doctor` 是只读的：它验证 fork 祖先、原生 social 模块和 0026 migration、附件 manifest/六份 `1.0.1` 人格、数据库 revision、四个 MCP 配置，以及
public outreach operator 的包元数据、Playwright/Appium/XCUITest 依赖、profile 根目录权限和已登记设备的严格 WDA 健康状态。它不启动 MCP server，
不创建或迁移数据库，不创建 profile 或设备目录，也不调用 TikTok 业务写工具。没有登记 iPhone
时会明确报告 live pilot 尚未就绪；这不等同于设备已通过现场验收。

`acceptance --static` 会运行离线 Node 测试、用 fake DeerFlow adapter 调用 accounts/tasks
协议、探测 public outreach operator 的 `initialize`/`tools/list`，并回报四个 MCP 和工具数量。
fake adapter 只在内存中返回合同数据，acceptance 不启动真实浏览器、不连接 iPhone、不启动
WebDriverAgent，也不向 TikTok 写入。

## 恢复手册

### Profile 锁或活动槽位卡住

先停止持有该 profile 的 operator 进程，再确认没有仍在执行的 action task。Web profile 的锁在
过期后可由 operator 的 `recoverExpired` 回收；不要手工删除包含仍在运行任务的锁。iPhone
设备锁必须使用对应的 session lease token 释放，不能用 device ref 强行覆盖。释放后重新运行
`npm run doctor`，再从 DeerFlow workbench 重试显式可恢复的 unknown task。

### Session 过期或登录要求

收到 `login_required`、challenge 或 provider session 过期时，执行器会暂停账号并生成
`manual_required` takeover 状态。使用同一个 profile 在可见浏览器或同一台 iPhone 上人工登录，
完成平台要求后重新做健康检查；不要把页面存在聊天气泡、草稿或已点击按钮当成成功回执。
恢复后只能重试当前未验证的 action，已经有 verified receipt 的 action 不能重复发送。

### WDA 失败

检查 macOS/Xcode command line tools、签名的 WebDriverAgent bundle id、设备配对状态和 WDA
实时 probe。`wda_probe_required`、`wda_unavailable` 或 `device_unpaired` 都保持
`manual_required`，直到 probe 返回完整的严格健康合同。不要通过坐标盲点或截图推断点赞、
评论、关注已经完成。

### 设备离线

`device_offline` 会保留 offline 状态并释放执行 lease。重新连接并解锁信任设备后做一次只读
health refresh；确认设备回到 `ready` 后再 claim。离线期间不自动换成另一台设备，也不改变
sequence 的 sender identity。

### Provider 返回未知结果

未知、超时、选择器变化或平台拒绝都不能推进 `public_touched` 或 `contacted`。保留 evidence、
provider diagnostic 和 manual takeover 原因，由人工确认平台状态后再按 workbench 的 retry
控制继续。未验证的 provider reference 只作为诊断信息保存，后续 verified receipt 仍可使用
同一 reference 完成幂等收口。

### 人工接管

人工接管只解决当前账号或设备的登录、挑战、WDA 和页面状态，不直接改写关系状态。接管完成后
必须回写健康结果或 verified provider receipt；如果无法确认平台实际状态，就保持
`manual_required`/`unknown`，由运营者关闭 sequence 或补充 closure receipt。所有公开动作仍
按 `like -> comment -> follow -> message` 顺序执行，并且同一 sequence 固定 sender。

## 第一个安全提示

> 作为默认 Lead，请使用 Guild Operator 和 TKDesk 的当前事实，说明每项事实的来源、时间、作用域和缺失数据。发消息必须绑定一个已核验的发送 profile、一个精确主播 `userId` 和明确内容，并保留平台回执与会话回读；不要把草稿或 MCP 连通写成已发送。关注、评论、送礼、发布仍不在此运行时能力内；后台分组、经纪人和邀约卡写入必须逐步取得用户授权，并保留平台回执与读回证据。

`backend/.deer-flow/` 是原生本机状态目录，不纳入 Git。已核对的当前能力与缺口见 [CreatorAgent 能力矩阵](../../docs/verification/creator-agent/capability-matrix.md)。

TKDesk 采集启动先执行 `initialize_collection_backstage`（邀请查询界面一次随机字母测试，人工验证、共享额度、无真实邀约）和 `prepare_discovery_live`（专用发现窗口进入 LIVE 后暂停并延迟复查）。两项 `ready: true` 后启动采集；详见插件对应 skill。工具目录与启用清单为33项。

当前部署关闭 TikHub 榜单来源，使用原生榜单。新增的 `creator_research_status` 与 `research_candidate` 提供可选公开主页/近期作品研究，均由现有 TKDesk daemon 执行。默认缓存读取、明确授权后最多两次固定付费查询；每日请求预算、缓存和不重试未知请求的记录保存在 TKDesk 现有 SQLite 中。没有 TikHub 也能正常采集、核验和沟通。密钥仅在本机私有 provider 配置中，不进入 DeerFlow MCP 配置。
