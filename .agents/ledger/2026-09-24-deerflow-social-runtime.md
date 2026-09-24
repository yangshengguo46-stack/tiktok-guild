# DeerFlow Social Runtime 台账

台账 ID：`DSR-20260924`

原始基线：`master@ad8d9aa`

上游基线：`769589e8daee14c2587a634b6b43bd96471a41a1`

实施分支：`codex/deerflow-social-runtime`

状态：Task 1–10 实施完成，等待独立复审与本地 fast-forward
当前写入者：`/root/task10_migration_final`

## 唯一生效边界

1. 用户提供的 `CreatorAgent_FINAL_PERSONA_REV1_20260924.zip`、
   `docs/superpowers/specs/2026-09-24-deerflow-auto-persona-design.md` 和当前运行代码
   是唯一生效事实源。
2. 2026-09-23 及更早的招募运行时、方法卡、关系摘要、旧后端和累计 patch
   全部作废；只保留原工作台 UI 的路由、导航、翻译和诚实占位。
3. 默认 Lead 是唯一 Agent 入口。Social Runtime 使用原生 Gateway、Channel、
   checkpoint、权限、工具授权和前端，不设置 sidecar 或第二套业务账本。
4. 人设由 Identity + Self Memory + Role + Relationship + TurnContext 构成，
   再穿上当前 EffectivePersona。人格由 AI 依据当前主播的有来源证据
   自动选择，运营者无需手动切换；人格与子 Agent 不强制绑定。
5. 人格库/沟通知识库、主播主页预分析和 World Memory 深度实现保留为后续
   roadmap，不属于本次主体闭环。
6. 真实 TikTok 收信、发信、正式邀约、送达/已读回执全部为
   `unverified-external`；不把草稿、MCP 连通或离线 fixture 宣称为已发送。

## 任务台账

| Task | 状态 | 交付/验收 |
| --- | --- | --- |
| 1 | 完成 | 根仓已是真实 DeerFlow fork；上游与 pre-fork master 均为祖先；备份与外层现场未破坏。 |
| 2 | 完成 | 原生 Social 合同、有来源事件、有界状态和 `reply|tool|wait|no_reply` 已落地。 |
| 3 | 完成 | Identity/Self/Role/Relationship/EffectivePersona/TurnContext 恢复与投影完成。 |
| 4 | 完成 | 六份 `1.0.1` 人格资产、作用域绑定、自动选择、严格生成/激活边界完成。 |
| 5 | 完成 | 同库事件、投影、人格、出站、CAS、重启和未知回执语义完成。 |
| 6 | 完成 | 默认 Lead 原生装配、单人格投影、私有模型输出隔离和 commit-before-disclosure 完成。 |
| 7 | 完成 | 有身份 Channel 门禁、去重、二次边界校验和不盲重试完成；无 TikTok provider。 |
| 8 | 完成 | 默认 Chat 中的认证管理工具完成；ignored start config 已从不受支持的 `gpt-5.4` 改为 `gpt-6-sol`，真实模型传输成功；第 6 次输出触发严格 expression parser，第 7 次最终 probe 超时，未激活。 |
| 9 | 完成 | fork-native bootstrap/start/doctor/acceptance、两个直接 MCP 静态合同和开发评测加载完成。 |
| 10 | 完成 | 隔离副本迁移、SOUL 保留、定向/离线/整库门禁与最终证据完成；等待 root 独立复审和 cutover。 |

## Task 10 迁移纠正

- 源备份 DB 不是 `0025` app DB。它没有 `alembic_version`，
  `PRAGMA user_version=0`，只有 LangGraph 的 `checkpoints`、`store`、
  `store_migrations`、`writes` 四张表。
- 未执行裸 `alembic stamp/upgrade`。隔离副本通过正式
  `init_engine('sqlite') -> bootstrap_schema` 走 `empty -> create_all + stamp head`，
  建立当前 `0026_social_runtime` schema。
- 原四表行数保持 `0 / 0 / 5 / 0`；新 app 社交表均为 0，因此没有可迁移或
  可推断的事实、承诺、禁联、人工接管或人格指纹。
- 迁移后 DB SHA-256：
  `5af704ac1ea4ef774f83332a345108d9bd0459c755a3a6a10a4ea6b8cc639e9c`。
- 恢复后 SOUL 与未变备份 SHA-256 均为
  `3cd8a4d11d8d3cdbeb8df21f305d654926145e97f57b750316a42c9cb5798b02`。

## 验证摘要

- Social + eval focused：`426 passed`。
- 明确离线分支矩阵：`21 passed`。
- MCP focused：`716 passed, 10 skipped`。
- 回归修复：分支新增的 4 个全量失败已在隔离测试中复现，根因修复后
  `4 passed`，关联组合回归 `55 passed`。
- Blocking I/O：`144 passed`；backend lint：通过。
- Frontend check：通过；sidebar/workbench Playwright：`5 passed`。
- Frontend full：201 files / 1626 tests，`1599 passed, 27 failed`；两个 DOM storage
  文件下的完全相同失败已在 untouched upstream + Node 26.4.0 复现。
- Ops：`33 passed`；doctor 15/15；acceptance `ok: true`。
- Backend full：`18 failed, 17531 passed, 189 skipped, 3 deselected`；18 项与 untouched
  upstream 精确匹配，分支新增失败为 0。详见
  `docs/verification/creator-agent/final-verification.md`。

## 外部阻塞

- 真实模型：传输 `verified-model`，人格生成质量 `blocked`。共 7 次授权调用；配置已改为 `gpt-6-sol`。第 6 次 raw/usage 已保存但嵌套 override 被严格 parser 拒绝；补齐 flat contract 后第 7 次最终 probe 以 30.003 秒 `invalid generator response` 超时，WP1 multi-turn 未发送。默认 generator timeout 已由 15 秒调为 45 秒，以覆盖实测 20.532 秒成功响应。
- PostgreSQL：`blocked`，无 live server 集成证据。
- TikTok inbound/outbound/invite/delivery/read receipt：全部 `unverified-external`。

## 历史记录

- 2026-09-24 04:12 CST：建立台账与三项只读审计。
- 2026-09-24 04:27 CST：锁定真实 DeerFlow fork 为唯一代码事实源。
- 2026-09-24 04:34 CST：纠正“人格必须绑定子 Agent”的误解；人格只是可选解析层。
- 2026-09-24 04:58 CST：用户要求按四份详细方案直接施工，实施计划锁定为 10 个任务。
- 2026-09-24 15:xx CST：Task 10 完成隔离状态 bootstrap、全产品验证和证据收口；待独立复审与 cutover。
