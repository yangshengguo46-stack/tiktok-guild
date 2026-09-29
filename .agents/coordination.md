# TikTok 公会 DeerFlow 协作入口

最后更新：2026-09-29  CST
台账写入者：根 Agent（`/root`）

## 当前主线

DeerFlow 原生 Social Runtime 已在 `master@a08ff2f0` 完成合并。当前进入
**现场试运行阶段**：本地工作台暂时跳过账号密码初始化，已完成本地运行时初始化；继续验证真实模型自动人格闭环，再在取得明确授权后
推进真实 TikTok 只读通道；不重复执行 Task 1–10，也不把旧 runtime 重新接回活动路径。

当前详细台账：[2026-09-24-deerflow-social-runtime.md](ledger/2026-09-24-deerflow-social-runtime.md)

2026-09-29 双通道公开建联已接入同一条原生 DeerFlow 控制链：`like -> comment -> follow ->
message` 的 sender、sequence、action task、verified receipt 和关系状态仍归 DeerFlow；新增的
`public-outreach-operator` 只负责 Web Playwright 普通账号和 iPhone Appium/XCUITest 执行。
Broker Operator 继续只代表公会后台经纪人消息线路，TKDesk 继续只代表候选发现和 handoff。

## 事实基线

- 外层产品仓库：`master@a08ff2f0`。
- DeerFlow 固定上游基线：`769589e8daee14c2587a634b6b43bd96471a41a1`。
- 已完成的 Phase 0：六人格目录、自动选择、关系作用域、CAS、no-contact 优先、幂等与单飞、Lead 真实 ModelRequest 注入。
- 仅保留之前工作台 UI；2026-09-24 人格方案之前的招募运行时、`guild_creator_context`、方法卡、通道来源补丁和沟通计划全部作废。
- 真实 TikTok 收信、发信、正式邀约和回执仍未验证，不得由离线测试或 MCP 连通推导为已可用。
- 普通账号最多 50 个持久 Web profile，每批最多 10 个活动 profile；iPhone 按设备 session
  单飞。profile、cookies、WDA、设备登记和截图证据放在 Git 外部，不进入 DeerFlow 业务台账。
- public outreach 只能以 verified provider read-back 推进 `gray -> public_touched -> contacted`；
  气泡、草稿、点击痕迹、unknown 和 provider 错误都不能抑制真实 inbound reply 或推进关系。
- `ops/guild-runtime/npm start` 当前只在本地入口注入 `DEER_FLOW_AUTH_DISABLED=1`；账号密码实现保留，
  出厂部署前移除该注入即可恢复认证，且显式 production 环境由后端拒绝 auth bypass。

## 恢复规则

1. 先读本文和当前台账，再核对 `git status` / `git log` / DeerFlow worktree 状态。
2. 用户已指定附件的详细方案直接施工，不再重新选型。Task 1–10 已完成；恢复时从台账的现场试运行阶段继续，禁止重复派工或重做主体研究。启动前必须先执行公会入口的 `npm run bootstrap`，由它安装固定 pnpm 运行时。
3. 每个派工使用唯一 task/dispatch ID；不覆盖历史、不重复派工。
4. 旧 runtime 仅作为可恢复备份保留，不是活动代码路径；不得删除或重新接入。

## 双通道运行门禁

1. 启动前使用 `npm run doctor` 做只读检查：operator 包元数据、Playwright/Appium/XCUITest
   依赖、Appium XCUITest driver catalog 注册、profile 父目录权限、iPhone 登记状态和四个
   MCP 配置。`npm ci --ignore-scripts` 后必须显式执行 `npm run ios:install-driver`。
2. CI 与 `npm run acceptance -- --static` 只允许 fake adapter、MCP `tools/list` 和离线测试；
   不启动真实浏览器、不连接 iPhone、不调用 TikTok 写工具。
3. iPhone 只有在 macOS/Xcode、已签名 WDA、配对/在线/解锁和严格 WDA probe 全部满足时才可
   进入 `ready`；没有这些证据保持 `manual_required` 或 `offline`。
4. 登录过期、challenge、WDA 失败、设备离线、页面选择器变化和 unknown provider result 都
   进入人工接管；恢复后只重试未验证 action，不能重复 verified action。
5. 真实 provider 仍是单账号、单设备、明确授权的现场 pilot；离线合同、catalog 连通和
   acceptance 结果不升级为 TikTok 外部完成。

Task 7 review 修复已完成：四 MCP runtime validator、operator lockfile、Appium driver
registration gate、doctor/acceptance 证据语义和现有 ops 测试均已对齐。runtime 相关 ops 测试 97 passed，doctor static 全部
通过；当前完整 ops 测试和 CLI acceptance 仍被既有 `docker/nginx/nginx.local.conf` 的
日志文件断言阻塞，该文件不属于本批修复范围。live provider、真实设备和真实 TikTok 写入
仍需要单独授权，不由这些静态门禁推断。
