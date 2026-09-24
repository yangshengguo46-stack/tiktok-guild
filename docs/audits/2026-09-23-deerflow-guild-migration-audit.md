# TikTok 公会 DeerFlow 历史审计（已被取代）

原审计日期：2026-09-23。取代日期：2026-09-24。固定上游基线：
`769589e8daee14c2587a634b6b43bd96471a41a1`。

## 当前结论

本文件只保留 2026-09-23 决策的历史路径，不是当前实现或待执行台账。
2026-09-24 起，唯一生效规格是 `CreatorAgent_FINAL_PERSONA_REV1_20260924.zip`、
[主播自动人格适配设计](../superpowers/specs/2026-09-24-deerflow-auto-persona-design.md)
和当前运行代码。旧招募运行时、`guild_creator_context`、方法卡、通道来源补丁、
累计 patch overlay 与沟通计划全部作废；只保留原工作台 UI 的路由、导航、翻译
和诚实占位。

当前 Social Runtime 是 DeerFlow 本体能力，而不是第二个服务、六个常驻 Agent、
独立 CRM 或平台业务账本。默认 Lead 是唯一 Agent 入口；六份版本化表达人格由
AI 根据当前主播的有来源证据自动选择，不与子 Agent 强制绑定。

## 已验证的本地边界

- 原生 Lead 装配、SocialState、有界恢复/投影、自动人格选择、原子提交与出站闸门已用确定性模型/通道验证。
- 本地 SQLite 已通过正式 bootstrap 路径建立当前 `0026_social_runtime` app schema；旧 LangGraph 四表及其行数保留。
- 工作台和侧边栏 E2E 通过，且两个文件与 Task 8/9 验收哈希一致。
- 具体证据、计数、哈希、上游失败对照和复现步骤见
  [最终验收](../verification/creator-agent/final-verification.md)。

## 仍未验证的能力

| 级别 | 缺口 | 当前处置 |
| --- | --- | --- |
| P0 | 无经现场验证的 TikTok 收信通道、发件人身份和去重回执。 | 不把手工文字或离线 fixture 标成真实 `creator_message`。 |
| P0 | 无经现场验证的 TikTok 发信、正式邀约或送达/已读回执。 | 未知发送不盲目重试；不宣称已发送。 |
| P1 | 配置已改为当前账号支持的 `gpt-6-sol`，真实模型传输成功；第 6 次输出被严格 parser 以非表达层嵌套字段拒绝，补齐 flat contract 后第 7 次最终 probe 以 `invalid generator response` 超时，无候选人格激活。 | 传输为 `verified-model`，人格生成质量仍 `blocked`；不把确定性 fixture 当成真实模型质量证明。 |
| P1 | PostgreSQL 事务/锁语义未在 live server 上运行。 | 只标记为 `blocked`，不用 SQLite 证据替代。 |

## 证据解读

本地 pytest、前端检查、doctor、acceptance 与静态 MCP 合同只能证明本地合同、
离线边界和可复现性。它们不能证明 TikTok 收发、送达、邀约或商业结果。
