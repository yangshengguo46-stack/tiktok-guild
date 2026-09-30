# TikTok 公会 DeerFlow 协作入口

最后更新：2026-09-30 CST
台账写入者：根 Agent（`/root`）

## 当前主线

整个项目以[DeerFlow 公会项目总台账](ledger/2026-09-24-deerflow-social-runtime.md)为唯一当前台账，先读其中“当前总览与未完成事项”。本轮审计工作分支为 `codex/pre-device-audit`，基于安卓交付 `codex/android-outreach-control@238a445ff`；原始 `master@c4e10369f` 保留，尚未合并。Social Runtime、安卓离线执行、安全边界和静态运维门禁已有本地证据；真机、真实 TikTok 回执、客户安装、关系记忆写入/followup 唤醒和多设备并发仍未验收。

用户计划对外销售 Agent。客户安装 DeerFlow 后不应再自行安装或配置 Java、Android SDK、ADB、Appium 等工具；本机设备服务/安装向导及 Windows/macOS 验收已列入总台账 P3。手机端调试和电脑授权仍需用户确认。

恢复会话先核对当前分支 `git status`/`git log`、主机与设备状态，再按总台账 P1–P8 继续。旧双通道记录仅为历史本地实施证据，不再启动 Web/iPhone 公开建联 pilot；已完成的 Social Runtime Task 1–10 不重复施工。全量业务审计与本轮证据见 `docs/audits/2026-09-30-business-completion-audit.md`。普通单代理任务不自动启动 Claude 协作。

### 2026-09-30 审计收口

- 运维修复：`ops/guild-runtime` tests **111 passed**，静态 doctor **25/25**，静态 acceptance `ok:true`；backend 运维聚焦 **47 passed**。本机三服务默认 loopback，生产环境不注入 auth bypass，日志接统一轮转器。
- Android hardening：operator 当前全套 **36 passed**，独立 hardening **23 passed**；会话元数据/cleanup fence、明确 inactive 前态、取消竞态、回执 ID/base、部署 owner 绑定和未知结果暂停均已修复。没有启动服务、手机、浏览器或 TikTok 写入。
- PostgreSQL：临时 Postgres 16 容器上社交 CAS、outbox replay、sender sequence 与既有 MCP/scheduler 集成共 **25 passed**。这是 disposable schema 的本地证据，不是目标部署验收。
- SQLite：先备份 `backend/.deer-flow/audit-20260930/pre-migration.db`，演练与现场均到 `0032_android_outreach_sender`，原有表行数保留，`integrity_check=ok`、外键错误 0。
- 真实模型：受控 preflight 实际 4 次 `gpt-6-sol` 调用后因输出合同失败即停；发现 selector 的 persona ID 规范歧义并已通过离线回归修复，后续回合一次纯文本仍未解决，未宣称多轮通过。原始 payload 不进 Git，当前 checkout 只保留脱敏摘要。
- 当前仍禁止把离线合同、真实模型单次结果、MCP catalog、设备配置或静态 acceptance 称为 TikTok 收发完成。

## 以下为双通道时期的归档记录，不作为当前施工指令

### 历史事实基线

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

### 历史恢复规则

1. 先读本文和当前台账，再核对 `git status` / `git log` / DeerFlow worktree 状态。
2. 用户已指定附件的详细方案直接施工，不再重新选型。Task 1–10 已完成；恢复时从台账的现场试运行阶段继续，禁止重复派工或重做主体研究。启动前必须先执行公会入口的 `npm run bootstrap`，由它安装固定 pnpm 运行时。
3. 每个派工使用唯一 task/dispatch ID；不覆盖历史、不重复派工。
4. 旧 runtime 仅作为可恢复备份保留，不是活动代码路径；不得删除或重新接入。

### 历史双通道运行门禁

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

### 历史施工恢复点

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
- 2026-09-30 首次尝试打开专用 Playwright 登录窗口时，用户反馈 TikTok 显示“访问频繁”。
  已立即关闭窗口、释放 profile 锁并禁用本地 `web:pilot_001` 资源；没有点赞、评论、
  关注或私信。成因未确认，Web 登录试跑路径暂停，不重试或规避平台提示；此现象不算
  已完成单账号 Web pilot。

### 2026-10-01 Creator Intelligence integration ruling

Ruling: Creator Intelligence is implemented as a sub-layer of the existing `deerflow.social` runtime — not a separate Agent, CRM, worker, MCP, or business ledger — because the product goal is for the same Lead to combine source-backed creator understanding with the existing persona and social memory. Persona remains the expression authority; intelligence selects grounded content and sales stage; SocialRepository/ChannelManager/scheduler remain facts, delivery, and wakeup authorities. Cost if wrong: a later refactor would be required to remove duplicated state; this keeps one control plane and limits the feature to context, persistence, and native scheduler interfaces.

### 2026-10-01 Creator Intelligence evaluation ruling

离线 preflight 仅使用合成/public-like fixture，报告的 snapshot、plan、memory promotion 和 funnel stage 都是边界证据。P50/P80 只表示阶段目标的估计回合数；没有 consent、verified receipt 或 provider read-back 时，不得升级为 formal invite、application、signed 或 live conversion。手机、真实 provider、客户安装和持续记忆唤醒继续单独验收。

## 2026-10-01 Creator Intelligence final hardening

Final review found no Critical or Important issue. Creator evidence IDs/source refs are host-derived and admitted to the same atomic memory/claim commit; followup scheduling uses pre/post social revision fences; application/signing transitions require a receipt from an outbound action after the current formal-invite/application anchor. Persisted plans validate shape, stage, and revision, with backward-compatible recovery for older plans without `consent_evidence_ids`. Typed creator consent gates `formal_invite`; DNC, takeover, identity revocation, and provider unknown cancel queued followups while preserving running fences.

Final code commits: `764f67d10`, `ca2f35249`, `be3e6d69`, `106ba882`, `1ed00c788`, `97c331208`. Focused social/intelligence/scheduler/repository/preflight suite: **321 passed**; blocking-I/O: **144 passed**; guild runtime ops: **111 passed**; Ruff and `git diff --check` pass. The full backend non-live run recorded **17665 passed, 189 skipped, 21 failed** in existing browser/MCP/pnpm/extension environment coverage; the isolated social persona concurrency case passed on rerun.

These results do not prove a real TikTok provider, Android/Appium session, platform receipt, application/signing, customer installation, or live conversion. Offline fixtures and P50/P80 estimates remain boundary evidence only.

## 2026-10-01 手机前非现场收口批次

用户授权后完成 P3/P5/P6/P7/P8 的本地工程补齐：统一收发 envelope/receipt/管理读口、来源约束的主播主页与作品预分析、离线多轮质量评测、客户安装编排入口和部署合同验收已加入原生路径。聚焦 backend **334 passed**、ops **121 passed**，Ruff 和 `git diff --check` 通过。部署静态合同可通过；当前主机缺 Java，doctor/完整 acceptance 按设计 fail-closed。客户真正免手工安装仍需固定 Node/Java/Android SDK artifacts 或受信镜像，手机/provider/平台回执/生产部署保持未验收。

### 2026-10-01 评估器一致性修复

复核真实模型预检后确认：`persona_consistent=false` 原因为离线评估器比较了包含
`evidence_version` 的 CAS 指纹；每轮刷新证据时该指纹合法变化，并不代表人格切换。
评估器现同时接收 exact `persona_fingerprint` 与稳定的
`persona_consistency_key`，只用后者判断跨轮人格表达是否一致；增加了真实运行夹具断言，
避免把正常证据刷新误报为质量失败。真实模型第二轮纯文本合同失败仍保留为未通过证据。
