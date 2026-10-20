---
name: prepare-discovery-live
description: Use when initializing a TKDesk TikTok discovery session before collection, when recommendation videos are playing, or after the dedicated discovery window is reopened.
---

# 初始化直播页并暂停播放

启动初始化之二：将 TKDesk 专用 TikTok 账号从推荐页切换到 LIVE，并暂停视频，减少采集时的播放流量。Agent 操作现有页面；不另写前端。

## 操作

1. 按 [主 skill](../tkdesk-agent/SKILL.md) 确认 US 发现线路已验证、`tiktok_discovery` 专用 Chrome 已认证，且采集和资格查询空闲。沿用同一隔离 profile；不要关闭窗口、退出账号或借用其他 Chrome。
2. 调用 `prepare_discovery_live`，只传已验证的 `routeProfileId`（默认可省略）。固定工具只处理该专用发现 profile 中官方主页、推荐页及 LIVE 页：点击现有 LIVE 导航、暂停页面视频，并防止页面自动恢复播放；已有主播直播或视频页只暂停，不跳转。其他账号和标签页不受此操作控制。
3. 工具延迟 3 秒复查每个处理页。必须核对顶层 `ready: true`，以及各页 `paused: true`、`mediaTimeStable: true`、`recheckedAfterMs: 3000`。只有切到 LIVE、静音、看到暂停图标，或瞬间暂停，都不能单独算完成。
4. 导航入口失配、没有视频、页面漂移、自动恢复播放、身份或线路不明时，报告具体失败，保持窗口和资料，不改白名单、不用任意脚本兜底。工具缺失同样不能宣称初始化成功。

暂停播放用于降低流量，不能保证 TikTok 后台预加载、心跳或其他网络请求为零。不要用关闭专用窗口替代暂停；后续采集需要它的登录状态。

确认 [采集后台初始化](../initialize-collection-backstage/SKILL.md) 也已 `ready: true` 后，按主 skill 启动用户授权的轮数。采集核心自己运行循环，Agent 查看状态和结果。
