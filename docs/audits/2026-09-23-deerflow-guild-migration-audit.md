# TikTok 公会 DeerFlow 当前实现审计

原审计日期：2026-09-23。当前结论更新：2026-09-24。固定 DeerFlow 基线：`769589e8daee14c2587a634b6b43bd96471a41a1`。

## 结论

2026-09-24 起，唯一生效规格是 `CreatorAgent_FINAL_PERSONA_REV1_20260924.zip` 和 [主播自动人格适配设计](../superpowers/specs/2026-09-24-deerflow-auto-persona-design.md)。较早的招募运行时、`guild_creator_context`、方法卡、通道来源补丁和沟通计划全部作废；原版只保留“工作台”UI 的路由、导航、翻译与未接入占位。

当前运行差异实现了一个新的 `deerflow.creator_agent`、同库 `creator_agent_relationship` 关系状态、六份版本化人格，以及默认 Lead 模型请求前的证据驱动自动选择。它不是第二个服务、六个常驻 Agent、独立 CRM 或平台业务账本。

## 已实现的离线边界

- `config/personas.json` 只登记 `relaxed_wit`、`clear_direct`、`curious_explorer`、`observant_warmth`、`quiet_depth` 和 `warm_candid`，版本均为 `1.0.1`。
- 新关系以 `(运营者, 稳定公会账号, TikTok 主播 UID)` 隔离，并用证据版本与人格 revision 的 CAS 防止并发双写。
- 新关系默认 `relaxed_wit@1.0.1`。切换必须引用当前作用域的主播原话，且置信度至少 `0.75`；选择异常或冲突时保留当前/默认人格，不阻断 Lead。
- 有效模型请求只注入一份已解析人格、当前 revision、选择来源和指纹。人格不覆盖事实、权限、承诺或禁联。
- 默认 `SOUL.md` 来自附件 `SOCIAL_KERNEL.md`。包可安全迁移上一版恰好匹配的业务优先内核，但保留真实用户自定义内容。
- TKDesk 仍拥有候选主播事实，Guild Operator 仍拥有公会后台事实；人格决策和关系笔记不是平台真值。

## 仍未验证的能力

| 级别 | 缺口 | 当前处置 |
|---|---|---|
| P0 | 没有经现场验证的 TikTok 收信通道，也没有可核验的主播发件人身份与去重回执。 | 运营者工具只能写 `operator_note`；不得把手工文字标成已验证的 `creator_message`。 |
| P0 | 没有经现场验证的 TikTok 发信、正式邀约或送达回执。 | 继续保持只读诊断与草稿边界；不宣称已发送或已完成运营。 |
| P1 | `/workspace/guild` 仍是诚实的未接入占位，没有后台概览、CRM、手动人格切换或发送队列。 | 本轮明确保留该状态，不用 UI 占位冒充已接入能力。 |
| P1 | 六种人格的真实主播长期效果尚无线上评测。 | 当前证据只覆盖 schema、决策边界、持久化、模型请求组装与离线故障回退。 |
| P2 | 两个 MCP 路径仍绑定当前 Mac。 | 迁移到其他机器时需重新配置插件路径和身份。 |

## 验收证据解读

Node 包测试、doctor、acceptance、相关后端 pytest 与累计补丁的 forward/reverse check 只能证明本地包装、离线边界和可重现性。它们不能证明 TikTok 收发、送达或商业结果。具体本次命令与计数应以 `.superpowers/sdd/2026-09-24-deerflow-auto-persona/` 下的任务报告和最终验收记录为准，不沿用 2026-09-23 的旧计数。
