# TikTok 公会插件与 Skills

主项目之外的三个配套插件源码完整保存在这里。每个目录均保留独立的
`.codex-plugin/plugin.json`、`.mcp.json`、`package.json`、锁文件、源码、测试和 skill。

| 目录 | 版本 | Skills | 职责 |
| --- | --- | --- | --- |
| [tkdesk-agent](tkdesk-agent/README.md) | 0.9.0 | 3 | 发现主播、采集、官方资格核验、名单去重与交接；可选 TikHub 主页/作品研究 |
| [tiktok-live-guild-operator](tiktok-live-guild-operator/README.md) | 0.15.0 | 11 | 公会长后台经营、主播、招募、消息、活动、营收、治理与入驻 |
| [tiktok-live-broker-operator](tiktok-live-broker-operator/README.md) | 0.1.0 | 1 | 独立经纪人 profile 的消息操作 |

插件声明的版本还包含原安装版本的 `+codex` 标记，源码快照日期为 2026-10-20。
包的 `private: true` 仅防止误发到 npm，不影响 GitHub 源码访问。
各组件原有许可声明保留；TKDesk 插件声明的许可为 `Proprietary`，本次发布未重新授权。

## 安装依赖与本地测试

使用 Node.js 22.16+，进入所需插件目录：

```sh
npm ci --ignore-scripts
npx playwright install chromium
npm test
```

需要通过宿主安装插件时，选择对应目录，具体入口遵循宿主的本地插件安装方式。
主 skill 位于各插件的 `skills/`；参考资料和 `agents/` 元数据与 skill 一起保留。

DeerFlow 的现有运行配置仍引用独立安装目录（例如 `$HOME/plugins/tkdesk-agent`）。
使用本仓库内的源码时，需要把自己的本地 manifest/MCP 配置指向实际绝对路径；
本次源码归档不会切换正在使用的安装实例。运行与验收见
[公会运行说明](../ops/guild-runtime/README.md)。

## 全部 Skills

TKDesk：

- [tkdesk-agent](tkdesk-agent/skills/tkdesk-agent/SKILL.md)
- [prepare-discovery-live](tkdesk-agent/skills/prepare-discovery-live/SKILL.md)
- [initialize-collection-backstage](tkdesk-agent/skills/initialize-collection-backstage/SKILL.md)

公会运营助手：

- [tiktok-live-guild-operator](tiktok-live-guild-operator/skills/tiktok-live-guild-operator/SKILL.md)
- [plan-audit-guild-business](tiktok-live-guild-operator/skills/plan-audit-guild-business/SKILL.md)
- [operate-guild-creators](tiktok-live-guild-operator/skills/operate-guild-creators/SKILL.md)
- [operate-guild-recruitment-messaging](tiktok-live-guild-operator/skills/operate-guild-recruitment-messaging/SKILL.md)
- [operate-guild-revenue](tiktok-live-guild-operator/skills/operate-guild-revenue/SKILL.md)
- [operate-guild-activities](tiktok-live-guild-operator/skills/operate-guild-activities/SKILL.md)
- [govern-guild-backstage](tiktok-live-guild-operator/skills/govern-guild-backstage/SKILL.md)
- [operate-guild-onboarding](tiktok-live-guild-operator/skills/operate-guild-onboarding/SKILL.md)
- [model-guild-task-economics](tiktok-live-guild-operator/skills/model-guild-task-economics/SKILL.md)
- [plan-three-month-guild-economics](tiktok-live-guild-operator/skills/plan-three-month-guild-economics/SKILL.md)
- [produce-guild-manager-report](tiktok-live-guild-operator/skills/produce-guild-manager-report/SKILL.md)

经纪人：

- [broker-messaging](tiktok-live-broker-operator/skills/broker-messaging/SKILL.md)

## 本机数据边界

这里保存代码和必要资源，不包含浏览器 profile/cookies、TikTok 登录态、API 密钥、
TikHub 凭据、Core 授权文件、真实候选/聊天数据库或日志。测试里的身份、令牌和回执是合成夹具。
用户须自行提供所需授权、登录和依赖；公开源码与离线测试不证明真实 TikTok 发送或送达。
