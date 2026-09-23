# TikTok LIVE 公会 DeerFlow CreatorAgent

本目录运行一个本机 DeerFlow 默认 Lead。2026-09-24 起，产品唯一生效规格是用户提供的 `CreatorAgent_FINAL_PERSONA_REV1_20260924.zip` 及 [AI 自动切换人格修订](docs/superpowers/specs/2026-09-24-deerflow-auto-persona-design.md)。较早的招募运行时、关系摘要、方法卡、通道来源和旧计划均已作废；只保留了原有“工作台”的路由、导航、翻译和诚实占位。

当前包内容：

- 六份不可变的 `1.0.1` 表达人格，新关系默认 `relaxed_wit@1.0.1`；
- 同一 DeerFlow SQLite 中按 `(运营者, 公会账号, TikTok 主播 UID)` 隔离的关系证据与人格决策；
- 默认 Lead 根据当前主播本人的有来源交流证据自动保持或切换人格，常规流程没有运营者手动换装器；
- 附件 `SOCIAL_KERNEL.md` 作为默认 Lead 内核；TKDesk 仍拥有候选主播事实，Guild Operator 仍拥有公会后台事实。

人格只改变观察与表达，不改写身份、关系事实、承诺、禁联或权限。不允许用职业、性别、收入、主播规模或推测脆弱性进行配型。

## 当前能力边界

当前尚未验证真实 TikTok 来信、发信、正式邀约或送达回执。现有 CreatorAgent 工具只能记录运营者笔记；未来真实通道必须建立服务端可核验来源后，才能写入“主播原话”。草稿、MCP 连通或离线测试都不代表已收到、已发送或已完成公会运营。

## 安装与启动

```sh
cd /Users/yangyucheng/Documents/ChatGPT/Tiktok公会
npm ci
npm run bootstrap
npm run doctor
npm start
```

`bootstrap` 校验并使用固定 DeerFlow commit，应用唯一累计补丁，并将社交内核安装到 `.runtime/deerflow-home/SOUL.md`。如果运行目录里恰好是本项目上一版业务优先内核，它会安全迁移；用户自定义的 `SOUL.md` 不会被覆盖。`start` 也会执行同一次安全安装/迁移，再运行 doctor 和 DeerFlow。

`doctor` 验证固定源码、累计补丁、本地依赖、两个 MCP 工具目录，以及 `config/personas.json` 中恰好六份 `1.0.1` 人格。它不调用 TikTok 业务写工具。

## 第一个安全提示

> 作为默认 Lead，请只读使用 Guild Operator 和 TKDesk 的当前事实，说明每项事实的来源、时间、作用域和缺失数据。不要发消息、发邀约、关注、评论、送礼、发布或更改平台状态。

`.runtime/` 是可重建的本机运行目录，不纳入 Git。已核对的当前能力与缺口见 [迁移审计](docs/audits/2026-09-23-deerflow-guild-migration-audit.md)。
