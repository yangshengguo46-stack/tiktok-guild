# TikTok LIVE 公会 DeerFlow CreatorAgent

本目录为当前 DeerFlow fork 的默认 Lead 提供本机运维配置。2026-09-24 起，产品唯一生效规格是用户提供的 `CreatorAgent_FINAL_PERSONA_REV1_20260924.zip` 及 [AI 自动切换人格修订](../../docs/superpowers/specs/2026-09-24-deerflow-auto-persona-design.md)。较早的招募运行时、关系摘要、方法卡、通道来源和旧计划均已作废；只保留了原有“工作台”的路由、导航、翻译和诚实占位。

当前包内容：

- 六份不可变的 `1.0.1` 表达人格，新关系默认 `relaxed_wit@1.0.1`；
- 同一 DeerFlow SQLite 中按 `(运营者, 公会账号, TikTok 主播 UID)` 隔离的关系证据与人格决策；
- 默认 Lead 根据当前主播本人的有来源交流证据自动保持或切换人格，常规流程没有运营者手动换装器；
- 附件 `SOCIAL_KERNEL.md` 作为默认 Lead 内核；TKDesk 仍拥有候选主播事实，Guild Operator 仍拥有公会后台事实。

人格只改变观察与表达，不改写身份、关系事实、承诺、禁联或权限。不允许用职业、性别、收入、主播规模或推测脆弱性进行配型。

## 当前能力边界

当前尚未验证真实 TikTok 来信、发信、正式邀约或送达回执。现有 CreatorAgent 工具只能记录运营者笔记；未来真实通道必须建立服务端可核验来源后，才能写入“主播原话”。草稿、MCP 连通或离线测试都不代表已收到、已发送或已完成公会运营。

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

原生运行时只读受 Git 跟踪的 `config/extensions_config.guild.json`；它固定两个 MCP server 及它们的精确有序工具 allowlist。本机被 `.gitignore` 忽略的 `extensions_config.json` 不是这个公会运行时的配置来源。

`doctor` 是只读的：它验证 fork 祖先、原生 social 模块和 0026 migration、附件 manifest/六份 `1.0.1` 人格、数据库 revision，以及两份固定 MCP schema-digest catalog。它不启动 MCP server，不创建或迁移数据库，也不调用 TikTok 业务写工具。Task 10 完成本机状态迁移前，缺失或旧版本数据库会被诚实报告为失败。

## 第一个安全提示

> 作为默认 Lead，请只读使用 Guild Operator 和 TKDesk 的当前事实，说明每项事实的来源、时间、作用域和缺失数据。不要发消息、发邀约、关注、评论、送礼、发布或更改平台状态。

`backend/.deer-flow/` 是原生本机状态目录，不纳入 Git。已核对的当前能力与缺口见 [CreatorAgent 能力矩阵](../../docs/verification/creator-agent/capability-matrix.md)。
