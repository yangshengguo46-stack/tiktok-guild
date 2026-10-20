# TKDesk 采集子后台：使用说明与维修手册

适用范围：TKDesk 自己的 `collection_backstage` 会话及主播资格核验。它使用独立的普通 Chrome profile，只允许官方 `https://live-backstage.tiktok.com/portal/anchor/relation`。公会长后台、经纪人即时消息和 TikTok 公开发现浏览器是另外三条链路；不能借用它们的身份或 Cookie，也不能把 TKDesk 的候选记录说成已联系主播。

## 日常使用

1. `status` 查看插件版本、活跃任务、资格批次、预算和会话；`collection_route_status` 核对 US 发现线路与目标国家采集线路，且必须是已验证的 MENA 路由。被动状态不会登录或跳转。
2. `session_status({target:"collection_backstage"})` 查看专用 Chrome。如果原窗口已登录但 Agent 尚未附着，在用户已确认登录的前提下调用 `check_login`；启动或重开后页面状态可能短暂为 `unknown`，等页面加载后再检查。若窗口已关闭，`start_login` 打开同一隔离 profile，登录和安全验证由用户在官方窗口完成。不要索取密码、验证码、Cookie 或 Token。
3. 在任何资格查询前调用 `collection_backstage_preflight`。它从官方页面读账号、大区与固定适配器形状，不提交主播查询，不消耗资格预算。预检结果至少核对：`regionMatched`、`accountAvailable`、`qualificationAdapterReady` 都为 `true`，`qualificationRequestConsumed` 为 `false`。
4. `verificationPresentationReady` 是独立能力。若为 `false`，已验证的资格请求链路仍可能可用；只能在原有明确的查询授权、未超预算及去重条件下尝试一次。若平台返回安全验证，停在 `manual_verification`；底层资格请求适配器本身不展示弹窗；启动时先按 [采集后台初始化 skill](../../initialize-collection-backstage/SKILL.md) 调用官方邀请界面的固定查询操作，让官方页面自行触发验证。人工完成后只结束原初始化，不自动重发。不能解题。`verificationExportShape` 仅是固定模块的导出名称/类型诊断，不是可直接调用的新 API。
5. `automatic_query` 仅用于非原版半自动任务中明确选择的 1–30 名候选，按一次请求计额度；失败、超时、验证或适配器失配都不自动重试。原版 `semi_auto` 只能在用户已于官方子后台手工查询后用 `manual_import` 关联原始数字状态码；它不发请求且不消耗额度。查询结果要报告来源、观察时间、资格状态及是否仍需复核。
6. 出名单先用 `preview_candidates` 看规模、来源和新鲜度；需要具体身份时用带审计理由的 `query_candidates`。`prepare_handoff` 只是待审核本地批次，`commit_handoff` 只是本地 outbox；二者都不发消息。

启动前还必须完成 [直播页暂停初始化](../../prepare-discovery-live/SKILL.md)，两步 `ready: true` 才启动采集。随机测试请求计入原有预算，不进入候选库，不发送邀请。

## 故障定位速查

| 观察 | 下一步 | 禁止误判 |
| --- | --- | --- |
| `stopped` / `authentication_required` | 保留 profile，使用 `start_login`；用户完成官方登录后 `check_login` | 不复制其他账号登录态 |
| `blocked_navigation` | 已获用户批准时调用 `reopen_login({target:"collection_backstage",userConfirmed:true})`，它只在已核验的专用 Chrome 新开固定官方页；再 `check_login` | 不用 `reset_session`、任意 URL 或手点另一后台代替 |
| 线路不匹配 / `restartRequired` | 用 `collection_route_status` 和 `verify_collection_route` 核对每条国家出口；按专用窗口的恢复策略处理 | 不把 US 发现出口当成 SA/QA/EG 采集出口 |
| `COLLECTION_BACKSTAGE_PREFLIGHT_UNAVAILABLE` | 登录后 Redux 账号状态可能尚未加载；短暂等待并重做**零查询**预检。持续失败则查账号/大区，不提交查询 | 不能把登录页可见当成预检成功 |
| `COLLECTION_ADAPTER_MISMATCH` | 看 `failureStage`，停止该批次，按下节维修；若错误发生在请求尝试后，保留已记的额度，不盲重试 | 不放宽白名单或发任意 HTTP 请求 |
| `verificationPresentationReady:false` | 正常资格链路可单独预检；如真实查询触发验证，报告 `manual_verification` 并停止 | 不把 `initCapture` 或其他未知导出猜成验证码 SDK |
| `waiting_quota` / 请求超时 / `manual_verification` | 保留 checkpoint、预算、审计记录，等明确后续指令 | 不自动重发、不得声称资格已查明 |

## 维修步骤（给维护 Agent）

1. 先保存脱敏证据：插件版本、任务/批次 ID、`status`、`collection_route_status`、`collection_backstage_preflight` 的固定布尔值与 `failureStage`、查询前后预算。不要记录账号标识、页面源码、请求头、Cookie、代理凭证或验证码。
2. 先区分故障层：启动预检只看官方 `__portalStore`；资格兼容性预检检查固定 webpack 模块、Axios 传输和本地构造的请求配置，**不调用主播资格端点**。二者通过也不等于真实查询成功。`failureStage` 为 `endpoint_definition`、`official_api_definition`、`request_config_definition`、`transport_definition`、`official_request_export`、`axios_version`、`transport_defaults`、`request_config` 等时，先核对相应固定模块和导出；不要扫描/执行未知模块来碰运气。
3. 只改已查明的失配处，先写能复现的失败测试，再做最小修复。保持官方域名/路径、固定资格端点、同源固定 XHR 适配器、无额外拦截器、单次请求、挑战不自动回放的边界。验证码展示是可选子能力，不应无故阻断正常资格查询；若它失配，仅报告不可展示，不猜测未知导出。
4. 运行 `node --test`。仅在 `status` 证明没有活跃采集任务和资格批次时升级插件/重启守护进程；普通 Chrome profile 和人工标签必须保留。重连后 `check_login`，再做零查询预检。安装副本、源码及 DeerFlow 工具目录需核对同一版本；旧任务中的 MCP 进程不保证热加载。
5. 若需要真实验收，只在明确授权下选定一个候选发起**新的一次**资格查询，记录额度变化、平台结果/挑战及候选观察时间。失败的旧批次不能当成可安全重试。榜单移动授权缺失与资格适配器失配是两种独立故障；前者不能靠此修复解决。

交接结论必须分别写明：会话已认证、零查询预检已通过、真实资格查询已返回、候选可联系、已交接、已发消息和平台回执；只声明有证据的层级。
