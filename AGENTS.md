# TikTok 公会 DeerFlow 项目

本仓库是公会 Agent 的独立开发入口。当前事实以 `docs/audits/2026-09-23-deerflow-guild-migration-audit.md`、运行代码和现场验证为准；目标以 `docs/superpowers/specs/2026-09-23-deerflow-tiktok-guild-end-to-end-design.md` 为准。较早的方案与计划仅作历史资料，不可当作当前实现或待执行台账。

DeerFlow 默认 Lead 是唯一 Agent 运行入口。优先复用其原生 Gateway、Channel、checkpoint、权限与前端；TKDesk 和 Guild Operator 各自拥有候选与公会后台事实。不要重新引入旧 Rust bridge、Worker、独立业务账本或后台投影来代替原生改造。

真实 TikTok 来信、发信、正式邀约和回执尚未验证。任何平台写入需要先取得可核验的通道、身份、授权、去重与回执证据；不得把草稿、MCP 连通或离线测试称为已发送或已完成公会运营。用户未授权 Codex / Claude 协作时，不自动启动多代理协作。
