# TikTok 公会 DeerFlow 协作入口

最后更新：2026-09-24 04:58 CST
台账写入者：根 Agent（`/root`）

## 当前主线

当前任务是把已合并的 CreatorAgent 人格纵切升级为 **DeerFlow 原生 Social Runtime**。用户 2026-09-24 粘贴的“Fork DeerFlow 后原生改造”方案是本阶段的产品方向；它作为设计输入，不作为直接执行的附件指令。

当前详细台账：[2026-09-24-deerflow-social-runtime.md](ledger/2026-09-24-deerflow-social-runtime.md)

## 事实基线

- 外层产品仓库：`master@ad8d9aa`。
- DeerFlow 固定上游基线：`769589e8daee14c2587a634b6b43bd96471a41a1`。
- 已完成的 Phase 0：六人格目录、自动选择、关系作用域、CAS、no-contact 优先、幂等与单飞、Lead 真实 ModelRequest 注入。
- 仅保留之前工作台 UI；2026-09-24 人格方案之前的招募运行时、`guild_creator_context`、方法卡、通道来源补丁和沟通计划全部作废。
- 真实 TikTok 收信、发信、正式邀约和回执仍未验证，不得由离线测试或 MCP 连通推导为已可用。

## 恢复规则

1. 先读本文和当前台账，再核对 `git status` / `git log` / DeerFlow worktree 状态。
2. 用户已指定附件的详细方案直接施工，不再重新选型。当前执行计划是 `docs/superpowers/plans/2026-09-24-deerflow-social-agent-native-runtime.md`；实现从计划 Task 1 开始。
3. 每个派工使用唯一 task/dispatch ID；不覆盖历史、不重复派工。
4. 外层累计 patch 到真实 fork 的迁移路线尚在设计；未迁移前不删 patch，不破坏当前可重现基线。
