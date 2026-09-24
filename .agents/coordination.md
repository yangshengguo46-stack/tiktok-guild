# TikTok 公会 DeerFlow 协作入口

最后更新：2026-09-24 18:54 CST
台账写入者：根 Agent（`/root`）

## 当前主线

DeerFlow 原生 Social Runtime 已在 `master@a08ff2f0` 完成合并。当前进入
**现场试运行阶段**：本地工作台暂时跳过账号密码初始化，先验证本机启动与真实模型自动人格闭环，再在取得明确授权后
推进真实 TikTok 只读通道；不重复执行 Task 1–10，也不把旧 runtime 重新接回活动路径。

当前详细台账：[2026-09-24-deerflow-social-runtime.md](ledger/2026-09-24-deerflow-social-runtime.md)

## 事实基线

- 外层产品仓库：`master@a08ff2f0`。
- DeerFlow 固定上游基线：`769589e8daee14c2587a634b6b43bd96471a41a1`。
- 已完成的 Phase 0：六人格目录、自动选择、关系作用域、CAS、no-contact 优先、幂等与单飞、Lead 真实 ModelRequest 注入。
- 仅保留之前工作台 UI；2026-09-24 人格方案之前的招募运行时、`guild_creator_context`、方法卡、通道来源补丁和沟通计划全部作废。
- 真实 TikTok 收信、发信、正式邀约和回执仍未验证，不得由离线测试或 MCP 连通推导为已可用。
- `ops/guild-runtime/npm start` 当前只在本地入口注入 `DEER_FLOW_AUTH_DISABLED=1`；账号密码实现保留，
  出厂部署前移除该注入即可恢复认证，且显式 production 环境由后端拒绝 auth bypass。

## 恢复规则

1. 先读本文和当前台账，再核对 `git status` / `git log` / DeerFlow worktree 状态。
2. 用户已指定附件的详细方案直接施工，不再重新选型。Task 1–10 已完成；恢复时从台账的现场试运行阶段继续，禁止重复派工或重做主体研究。启动前必须先执行公会入口的 `npm run bootstrap`，由它安装固定 pnpm 运行时。
3. 每个派工使用唯一 task/dispatch ID；不覆盖历史、不重复派工。
4. 旧 runtime 仅作为可恢复备份保留，不是活动代码路径；不得删除或重新接入。
