# TikTok 公会 DeerFlow 项目

本仓库是公会 Agent 的独立开发入口。2026-09-24 起，产品唯一生效规格为用户提供的 `CreatorAgent_FINAL_PERSONA_REV1_20260924.zip` 及 `docs/superpowers/specs/2026-09-24-deerflow-auto-persona-design.md` 中的“AI 自动切换人格”修订。当前事实以运行代码和现场验证为准。2026-09-23 及更早的审计、方案、招募运行时、关系摘要、方法卡和计划仅作历史资料，不可当作当前实现或待执行台账。

DeerFlow 默认 Lead 是唯一 Agent 运行入口。优先复用其原生 Gateway、Channel、checkpoint、权限与前端；TKDesk 和 Guild Operator 各自拥有候选与公会后台事实。旧后端改造全部作废，只保留原工作台 UI 的路由、导航、翻译和诚实占位。不要重新引入旧 Rust bridge、Worker、独立业务账本或后台投影来代替原生改造。

真实 TikTok 来信、发信、正式邀约和回执尚未验证。任何平台写入需要先取得可核验的通道、身份、授权、去重与回执证据；不得把草稿、MCP 连通或离线测试称为已发送或已完成公会运营。用户未授权 Codex / Claude 协作时，不自动启动多代理协作。
