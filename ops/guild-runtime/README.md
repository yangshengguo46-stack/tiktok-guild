# TikTok LIVE 公会 DeerFlow CreatorAgent

客户安装与部署验收入口：

```bash
npm run install:customer
npm run acceptance:deployment
```

`install:customer` 使用 `ops/guild-runtime/.runtime` 下的固定运行时目录，准备
DeerFlow、安卓执行器和 pnpm 依赖，检查 Android SDK/Java/ADB 合同，并写入安装状态；
安装过程保持外部 provider 写入关闭。客户仍需在手机端开启调试并授权一台设备。
macOS 缺少 Java 17 或 Android command-line tools 时由受控入口调用固定 Homebrew cask，
Windows 使用固定 winget 包；Linux 缺依赖时会 fail-closed 给出诊断，不会猜测发行版安装命令。
`acceptance:deployment` 检查生产认证、loopback 发布、迁移证据、健康路由和日志轮转；
静态通过不代表真实 TikTok provider 或手机已连接。

本目录为当前 DeerFlow fork 的默认 Lead 提供本机运维配置。2026-09-24 起，产品唯一生效规格是用户提供的 `CreatorAgent_FINAL_PERSONA_REV1_20260924.zip` 及 [AI 自动切换人格修订](../../docs/superpowers/specs/2026-09-24-deerflow-auto-persona-design.md)。较早的招募运行时、关系摘要、方法卡、通道来源和旧计划均已作废；只保留了原有“工作台”的路由、导航、翻译和诚实占位。

当前包内容：

- 六份不可变的 `1.0.1` 表达人格，新关系默认 `relaxed_wit@1.0.1`；
- 同一 DeerFlow SQLite 中按 `(运营者, 公会账号, TikTok 主播 UID)` 隔离的关系证据与人格决策；
- 默认 Lead 根据当前主播本人的有来源交流证据自动保持或切换人格，常规流程没有运营者手动换装器；
- 附件 `SOCIAL_KERNEL.md` 作为默认 Lead 内核；TKDesk 仍拥有候选主播事实，Guild Operator 仍拥有公会后台事实。
- `public-outreach-operator` 作为第四个直接 MCP，只负责普通账号的安卓设备执行；主播 claims、action tasks、关系状态和 verified receipts 仍只写入 DeerFlow 原生库。

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

普通账号的公开建联动作由 `public-outreach-operator` 的安卓 Appium UiAutomator2 通道执行。DeerFlow 原生库仍拥有 sender、sequence、task、租约、禁联和回执。旧 Web/iPhone 账号与历史回执只读保留，不能再建序列或执行。第一阶段仅做单台真机 pilot，业务执行并发上限为 1；可登记最多 50 台设备，20–50 台并发和长期稳定性仍需后续实现与实测。

Gateway 管理 Node worker，MCP 调用同一原生 API。外部业务写入默认关闭；必须在 Git 外配置单 owner/sender/creator 的试点 allowlist，私信另需 `message_enabled`。TikTok 控件定位和回执字段必须先在真机上采样并版本化，离线 fixture 不能证明现场可用。没有实际发送者、目标、状态变化或新条目的读回证据，动作保持 `unknown` 并交人工接管。

```sh
export PUBLIC_OUTREACH_RUNTIME_ROOT="$HOME/.codex/tiktok-live-public-outreach"
export PUBLIC_OUTREACH_EXECUTION_CONFIG="/private/path/android-outreach.json"
```

配置示例及设备控制 API 见[生产运行说明](../../docs/verification/creator-agent/public-outreach-production-runbook.md)。安卓真机需打开 USB 调试并授权电脑，主机需安装 Android SDK Platform Tools、Java 和 Appium UiAutomator2。人工接管可使用 scrcpy/QtScrcpy 连接指定序列号；实时视频仅给人看，模型只按需读取压缩后的结构化元素树，不持续消耗截图 token。

## 安装与启动

```sh
cd /Users/yangyucheng/Documents/ChatGPT/Tiktok公会
cd ops/guild-runtime
npm ci
cd public-outreach-operator
npm ci --ignore-scripts
npm run android:doctor
cd ..
npm run bootstrap
npm run doctor
npm start
```

`public-outreach-operator` 使用提交的 `package-lock.json` 固定 Appium 3 和 UiAutomator2 driver。`npm ci --ignore-scripts` 安装本地依赖，`npm run android:doctor` 检查 SDK/Java。`bootstrap` 校验固定的上游 commit 是当前 fork 的祖先，然后直接在 fork 根目录安装依赖；它不 clone 第二份 DeerFlow，也不应用产品补丁。会话原则安装到原生 `backend/.deer-flow/SOUL.md`，不包含开发版本和阶段说明。安装器只迁移完全匹配的上一版官方社交模板或业务优先模板，用户自定义的 `SOUL.md`（包括追加内容）不会被覆盖。`start` 也会执行同一次安全安装/迁移，再从 fork 根目录运行 `make start`。

当前开发与验收阶段，`npm start` 默认临时注入 `DEER_FLOW_AUTH_DISABLED=1`，使用 DeerFlow 内置的本地 synthetic admin，因而不会被 `/setup` 的账号密码注册页拦住。设 `DEER_FLOW_AUTH_DISABLED=0` 可在本地保留正常认证；`DEER_FLOW_ENV` 或 `ENVIRONMENT` 为 `prod`/`production` 时，启动器强制设置 `DEER_FLOW_AUTH_DISABLED=0`，进入原生账号、密码和会话认证流程。只有本地绕过实际生效时才输出 synthetic admin 警告。

本机启动的 Nginx、Gateway 和 Frontend 均只监听 loopback（统一入口为 `http://localhost:2026`），本地 synthetic admin 模式不可用作共享或对外服务。正式部署仍需单独验收身份、权限、入口与目标数据库；生产模式标记本身不是发布验收。

三项服务的标准输出和错误输出统一写入仓库 `logs/{gateway,frontend,nginx}.log`，每个文件默认最多 10 MiB、保留 3 个备份，重启继续保留最近记录。可用 `DEER_FLOW_LOG_MAX_BYTES` 和 `DEER_FLOW_LOG_BACKUPS` 设置上限。Nginx 不再另写无界增长的 access/error 文件；已有历史日志保留供审计。

原生运行时只读受 Git 跟踪的 `config/extensions_config.guild.json`；它固定
`guild_operator`、`broker_operator`、`tkdesk`、`public_outreach_operator` 四个 MCP server 及它们的
精确有序工具 allowlist。本机被 `.gitignore` 忽略的 `extensions_config.json` 不是这个公会运行时的配置来源。

TKDesk 的 `reopen_login` 是采集子后台恢复工具：经明确授权后，只在已核验的专用 Chrome 中打开固定官方后台页；保留进程、登录资料与人工标签。DeerFlow 的工具白名单已包含它，但调用前仍须验证线路和身份；它只负责名单和 `userId`，公会长消息发送归 `guild_operator`，经纪人消息发送归 `broker_operator`。

`doctor` 只读检查 Appium/UiAutomator2、Android SDK 环境变量、ADB/Java 主机命令、运行目录、配置中的设备序列号和 `adb devices -l` 在线状态。已配置设备只要有一台缺失、离线或未授权，就检查失败并阻止启动；没有配置试点设备时，报告外部写入关闭。主机命令可用不等于完整 SDK、Appium session 或 TikTok UI 已验证；完整 Android 依赖检查仍用 `npm run android:doctor`，真实 UI 定位器和平台回执仍需单台真机验证。两项 doctor 都不登录 TikTok或产生业务动作。

`acceptance --static` 使用 fake adapter 验证 Android 通道的 MCP 目录和原生合同；`doctor --live` 额外探测实际 MCP 目录。两者都不能替代真机验收。本文安装步骤仍属于开发和受控试点；客户无需命令行的依赖安装、升级/回退和 Windows/macOS 交付向导尚未实现。

## 恢复手册

设备离线、ADB 未授权或 Appium 连接失败时，先恢复同一设备的连接，再调用 `/api/public-outreach/devices/{device_ref}/doctor`。不自动改派另一台设备。

人工接管先暂停绑定的 sender，取消活动任务，再创建该设备的人工接管标记；返回的 `scrcpy -s <serial>` 可在 Mac/Windows 上投屏操作。`/api/public-outreach/devices/{device_ref}/resume` 只有在设备 doctor 通过后才恢复 sender。Appium 清理结果不明时保留设备锁，必须核对远端会话后人工处理，不能直接删锁重试。

未知、超时、界面变化和新内容读回不足，都不能推进业务状态。已确认的原生 verified receipt 不重复发送；未确认任务需人工核对平台实际状态后显式恢复。所有公开动作按 `like -> comment -> follow -> message` 顺序，同一 sequence 固定 sender。

## 第一个安全提示

> 作为默认 Lead，请使用 Guild Operator 和 TKDesk 的当前事实，说明每项事实的来源、时间、作用域和缺失数据。发消息、点赞、评论和关注必须绑定已核验的 sender、精确主播 `userId` 和明确 action，并保留平台回执与读回证据；不要把草稿、聊天气泡、按钮点击或 MCP 连通写成已完成。公开建联由 `public_outreach_operator` 按 `like -> comment -> follow -> message` 顺序执行；后台分组、经纪人和邀约卡写入必须逐步取得用户授权，并保留平台回执与读回证据。

`backend/.deer-flow/` 是原生本机状态目录，不纳入 Git。已核对的当前能力与缺口见 [CreatorAgent 能力矩阵](../../docs/verification/creator-agent/capability-matrix.md)。

TKDesk 采集启动先执行 `initialize_collection_backstage`（邀请查询界面一次随机字母测试，人工验证、共享额度、无真实邀约）和 `prepare_discovery_live`（专用发现窗口进入 LIVE 后暂停并延迟复查）。两项 `ready: true` 后启动采集；详见插件对应 skill。当前 TKDesk 工具目录与启用清单为 34 项。

当前部署关闭 TikHub 榜单来源，使用原生榜单。新增的 `creator_research_status` 与 `research_candidate` 提供可选公开主页/近期作品研究，均由现有 TKDesk daemon 执行。默认缓存读取、明确授权后最多两次固定付费查询；每日请求预算、缓存和不重试未知请求的记录保存在 TKDesk 现有 SQLite 中。没有 TikHub 也能正常采集、核验和沟通。密钥仅在本机私有 provider 配置中，不进入 DeerFlow MCP 配置。
