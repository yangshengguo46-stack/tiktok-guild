---
name: initialize-collection-backstage
description: Use when starting TKDesk creator collection or qualification after login, opening a fresh collection-backstage page, or resuming after a manual security verification.
---

# 初始化采集后台

启动初始化之一：在 TKDesk 专用采集后台的“邀请主播”窗口，通过一次随机字母用户名查询激活官方页面的验证流程。Agent 操作现有官方前端；执行由固定 `tkdesk` MCP 适配器完成。

## 操作

1. 用 `status` 确认没有活跃采集或资格查询，核对已验证的 `collection_route_status`。保留原有专用 Chrome、登录资料和历史记录。
2. 依据主 skill 的登录规则完成 `collection_backstage` 登录和零查询 `collection_backstage_preflight`。已认证、账号可用、大区匹配、资格适配器就绪后继续。
3. 调用 `initialize_collection_backstage`，只传已验证的 `routeProfileId`（默认线路可省略）。工具打开“邀请主播”，程序生成一串随机字母，输入空白用户名框并点击查询入口一次。不要提供真实主播、任意网址或自定义点击脚本。`inspectOnly: true` 只是检查，不能算初始化完成。
4. 实际发出的测试查询也计入已有资格查询预算及 60–80 秒间隔。工具在请求前持久记账；结果不进入候选库。额度不足、超时、失配、意外命中真实账号或请求被拦截时，保留失败状态，不重复查询、不继续邀约。
5. `requiresUserAction: true` 表示需要用户在这个专用 Chrome 完成人工验证。说明实际原因并等待；不得自动解题。收到用户明确“已验证/好了”后再次调用同一工具，传 `userConfirmedVerification: true`，只完成原初始化的清理，不重新发测试请求。然后重做零查询预检。
6. 只在 `ready: true` 时记为完成。同一页面重复调用复用已完成状态，不消耗新额度；页面刷新或重新打开则需重新核验。工具清空自身测试输入并关闭自身弹窗，不覆盖原有输入，也不发送真实邀请。

工具缺失、登录/线路不明或结果未就绪时，报告具体阻塞，不假称成功。测试初始化完成只证明启动流程完成，不代表真实主播资格已查明。

继续执行 [直播页暂停初始化](../prepare-discovery-live/SKILL.md)。两步就绪后按 [主 skill](../tkdesk-agent/SKILL.md) 启动已授权采集。没有用户新的明确请求，不增加轮次或重发失败查询。
