# TikTok 公会 DeerFlow 协作入口

最后更新：2026-09-30 CST
台账写入者：根 Agent（`/root`）

## 当前主线

DeerFlow 原生 Social Runtime 已在历史基线 `master@a08ff2f0` 完成合并。当前主线是
**双通道公开建联的本地软件收口**；生产接线和终局恢复修复已提交到 `d4fd1444a`，限定独立复审
**CLEAN**。原有现场试运行和真实模型证据保留在既有台账；不重复执行 Task 1–10，也不把
旧 runtime 重新接回活动路径。

当前详细台账：[2026-09-24-deerflow-social-runtime.md](ledger/2026-09-24-deerflow-social-runtime.md)

2026-09-29 双通道公开建联已完成原生合同和离线通道实现，最终审查发现生产接线仍缺失，
生产 Gateway、native adapter 和执行器 transport 已接线到 `75318ad4f`；四项独立发现已在
`e05f83ae9` 同批提交修复，根 Agent 的 backend 104、operator 71、runtime focused 41 检查通过。
限定复审又复现两处原生提交边界缺陷，已在 `d4fd1444a` 修复并经独立正向复现验收。
真实账号身份和新回执的 provider 映射、部署 DB 迁移及 iPhone 登记仍未完成；不得称为已可现场执行。
设计仍沿用同一条原生 DeerFlow 控制链：`like -> comment -> follow ->
message` 的 sender、sequence、action task、verified receipt 和关系状态仍归 DeerFlow；新增的
`public-outreach-operator` 只负责 Web Playwright 普通账号和 iPhone Appium/XCUITest 执行。
Broker Operator 继续只代表公会后台经纪人消息线路，TKDesk 继续只代表候选发现和 handoff。

## 事实基线

- 外层产品仓库：历史 Social Runtime 合并基线 `master@a08ff2f0`；当前公开建联实现 `d4fd1444a`。
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
   进入人工接管。外部派发前写原生持久 attempt 标记；已派发未完成动作不得因过期而自动
   重试，必须先人工核对。已存 verified proof 不可重试；未确认关闭的 Web/iPhone 资源保持
   锁和容量占用，不能仅凭 owner PID 消失回收。
5. 真实 provider 仍是单账号、单设备、明确授权的现场 pilot；离线合同、catalog 连通和
   acceptance 结果不升级为 TikTok 外部完成。

Task 7 review 修复已完成：四 MCP runtime validator、operator lockfile、Appium driver
registration gate、doctor/acceptance 证据语义和现有 ops 测试均已对齐。最新 static doctor 全部
通过；当前完整 ops 测试为 128 passed / 1 failed，CLI acceptance 仍被既有 `docker/nginx/nginx.local.conf` 的
日志文件断言阻塞，该文件不属于本批修复范围。live provider、真实设备和真实 TikTok 写入
仍需要单独授权，不由这些静态门禁推断。

## 当前施工恢复点

- 原有未提交工作已保存在 `stash@{0}`，基线为 `895233fbe`；当前施工不应用该 stash。
- 2026-09-29 最终硬化修复到 `02521d405`：已完成私信幂等重放、Web owner 心跳和 fencing、
  Web/iOS 新回执证明，以及 profile 不保存独立业务任务事实。
- 实现批次 `production-outreach-integration-20260929` 已交付 `75318ad4f`；关键修复批次
  `production-outreach-critical-repair-20260929` 已交付 `e05f83ae9`，限定独立复审为 NOT CLEAN：
  并发 payload 更新可覆盖内部 attempt fence；最后一个 public task 完成后、关系推进前取消
  可使关系滞留 gray。当前须继续同组终局修复并独立验收。
  不重新派遣已完成的软件 Task 1–7；Task 8 的真实 Web/iPhone pilot、live parity、十号扩容
  仍未完成，完整 acceptance 仍有历史 nginx 失败。
- 根 Agent 已用真实 pinned Playwright 启动匿名空白 Chromium 并强制结束 Node，确认过期
  reclaim 被 `profile_cleanup_required` 拒绝，原锁保留；仅验证资源生命周期，没有 TikTok
  导航。演练自身浏览器和临时目录已清理。
- 终局补丁 `d4fd1444a`：仅 pending task 可用版本 CAS 修改普通 payload；可信 FOLLOW/DM
  的 task 完成和关系推进同原生事务，已存 proof 的中断尝试只能作原生结算，不能再调用
  provider。根 Agent backend focused 124、operator 71 通过；限定独立复审 **CLEAN**，
  原三场景正向复现 exit 0、窄后端 20 passed。该结论仅为本地软件边界，不是 pilot 许可。
