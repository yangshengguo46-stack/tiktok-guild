# TikTok LIVE 公会 DeerFlow CreatorAgent

本目录为当前 DeerFlow fork 的默认 Lead 提供本机运维配置。2026-09-24 起，产品唯一生效规格是用户提供的 `CreatorAgent_FINAL_PERSONA_REV1_20260924.zip` 及 [AI 自动切换人格修订](../../docs/superpowers/specs/2026-09-24-deerflow-auto-persona-design.md)。较早的招募运行时、关系摘要、方法卡、通道来源和旧计划均已作废；只保留了原有“工作台”的路由、导航、翻译和诚实占位。

当前包内容：

- 六份不可变的 `1.0.1` 表达人格，新关系默认 `relaxed_wit@1.0.1`；
- 同一 DeerFlow SQLite 中按 `(运营者, 公会账号, TikTok 主播 UID)` 隔离的关系证据与人格决策；
- 默认 Lead 根据当前主播本人的有来源交流证据自动保持或切换人格，常规流程没有运营者手动换装器；
- 附件 `SOCIAL_KERNEL.md` 作为默认 Lead 内核；TKDesk 仍拥有候选主播事实，Guild Operator 仍拥有公会后台事实。

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

原生运行时只读受 Git 跟踪的 `config/extensions_config.guild.json`；它固定 `guild_operator`、`broker_operator`、`tkdesk` 三个 MCP server 及它们的精确有序工具 allowlist。本机被 `.gitignore` 忽略的 `extensions_config.json` 不是这个公会运行时的配置来源。

TKDesk 的 `reopen_login` 是采集子后台恢复工具：经明确授权后，只在已核验的专用 Chrome 中打开固定官方后台页；保留进程、登录资料与人工标签。DeerFlow 的工具白名单已包含它，但调用前仍须验证线路和身份；它只负责名单和 `userId`，公会长消息发送归 `guild_operator`，经纪人消息发送归 `broker_operator`。

`doctor` 是只读的：它验证 fork 祖先、原生 social 模块和 0026 migration、附件 manifest/六份 `1.0.1` 人格、数据库 revision，以及三份固定 MCP schema-digest catalog。它不启动 MCP server，不创建或迁移数据库，也不调用 TikTok 业务写工具。Task 10 完成本机状态迁移前，缺失或旧版本数据库会被诚实报告为失败。

## 第一个安全提示

> 作为默认 Lead，请使用 Guild Operator 和 TKDesk 的当前事实，说明每项事实的来源、时间、作用域和缺失数据。发消息必须绑定一个已核验的发送 profile、一个精确主播 `userId` 和明确内容，并保留平台回执与会话回读；不要把草稿或 MCP 连通写成已发送。关注、评论、送礼、发布仍不在此运行时能力内；后台分组、经纪人和邀约卡写入必须逐步取得用户授权，并保留平台回执与读回证据。

`backend/.deer-flow/` 是原生本机状态目录，不纳入 Git。已核对的当前能力与缺口见 [CreatorAgent 能力矩阵](../../docs/verification/creator-agent/capability-matrix.md)。

TKDesk 采集启动先执行 `initialize_collection_backstage`（邀请查询界面一次随机字母测试，人工验证、共享额度、无真实邀约）和 `prepare_discovery_live`（专用发现窗口进入 LIVE 后暂停并延迟复查）。两项 `ready: true` 后启动采集；详见插件对应 skill。工具目录与启用清单为33项。

当前部署关闭 TikHub 榜单来源，使用原生榜单。新增的 `creator_research_status` 与 `research_candidate` 提供可选公开主页/近期作品研究，均由现有 TKDesk daemon 执行。默认缓存读取、明确授权后最多两次固定付费查询；每日请求预算、缓存和不重试未知请求的记录保存在 TKDesk 现有 SQLite 中。没有 TikHub 也能正常采集、核验和沟通。密钥仅在本机私有 provider 配置中，不进入 DeerFlow MCP 配置。
