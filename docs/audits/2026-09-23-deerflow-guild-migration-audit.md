# TikTok 公会 DeerFlow 项目迁移审计

日期：2026-09-23。源仓库：`/Users/yangyucheng/Documents/ChatGPT/妹子攻略计划`，检查时 HEAD 为 `b1f6501c4aeb3ee09c9d95c71fe768d8a9182c0d`。本报告审计的是源仓库的现行 `ops/deerflow-native-guild`，目标以[完整方案](../superpowers/specs/2026-09-23-deerflow-tiktok-guild-end-to-end-design.md)为准。

## 结论

现有项目可作为**单个本机 DeerFlow Lead 的只读起点**，但尚未实现“DeerFlow 原生为 TikTok 公会工作”的完整产品。当前代码主要固定 DeerFlow 版本、装入公会 SOUL、连接两个 MCP，并给上游前端加一个空工作台、给通道运行加来源提示。设计文档的 A–F 阶段大多还没有对应实现；旧计划中的已勾选或已交付表述不得代替本次源码验收。

## 主要发现

| 级别 | 发现与证据 | 影响与处理方向 |
|---|---|---|
| P0 | **真实 TikTok 通道尚未实现。** `README.md` 明确没有接收、发送、送达回执；`config/extensions_config.json` 只有 Guild Operator 和 TKDesk；`patches/0001-feat-add-guild-workbench.patch` 没有 TikTok Channel 或发送记录。 | 不能收主播来信、自动回复、正式邀约或核验送达。先对当前账号取得真实通道与身份、回执契约；未证明前保持只读草稿。 |
| P1 | **主播关系连续性尚未实现。** 产品设计要求按 TikTok 唯一 ID 隔离、跨会话可查的原生关系摘要和禁联边界；当前补丁没有关系状态、数据库迁移、身份映射或相应测试。`config/guild-soul.md` 是行为提示，不能代替持久状态。 | 同名主播、跨 thread、重启和禁联场景无可验证的数据边界。先做唯一 ID、来源、作用域和最小状态的离线验收。 |
| P1 | **外部通道授权仍停留在提示层。** 补丁把通道来源写入 Lead 系统提示，但代码中的 `update_agent` 工具门禁只识别 `github`；没有针对 TikTok 发送者的权限执行边界，也没有已验证的 TikTok 发送者 ID。 | 将来接入主播来信时，不能把这个来源描述当作身份认证或跨主播访问控制。必须在服务端建立权限与数据作用域，再开放外部通道动作。 |
| P1 | **工作台只有导航和“未接入”占位页。** 补丁的 `frontend/src/app/workspace/guild/page.tsx` 没有后台读取、时间范围、完整性或异常事实。 | 不应把它称为公会经营工作台；后续需用现有事实接口实现只读概览并明确部分数据。 |
| P2 | **原生能力被原型配置限制。** `config/config.yaml` 只登记文件读写工具，关闭 `tool_search` 与 `scheduler`；产品方案要求逐项判断哪些 DeerFlow 原生能力应保留。 | 当前更像能调用两个插件的通用 Lead，而非完整垂直产品。扩展工具前需同时验证外部通道授权边界。 |
| P2 | **验收覆盖偏配置与目录。** `npm test` 检查启动、补丁、MCP 清单；`npm run doctor` 和 `npm run acceptance` 证明本机两插件可发现。没有真实 TikTok 收发、跨主播隔离、关系连续性或业务结果端到端验收。 | 测试通过不等于公会运营完成。按完整方案分阶段补行为测试和现场证据。 |
| P2 | **运行配置绑定此 Mac。** `src/constants.mjs` 与 `config/extensions_config.json` 固定 `/Users/yangyucheng/plugins/...`。 | 当前机器可用；迁到别的机器需重新配置插件路径，不能称为可移植交付包。 |

## 已核实的可用基线

- DeerFlow 固定到 `bytedance/deer-flow@769589e8daee14c2587a634b6b43bd96471a41a1`，一个累计补丁可验证应用；旧的容器 Gateway、Worker 与 Rust bridge 已被现行运行入口取代。
- 源目录 `npm test`：35/35 通过；`npm run doctor`：12 项通过；`npm run acceptance`：2 个 MCP、8 个 Guild Operator 工具、28 个 TKDesk 工具，返回 `ok: true`。这些均为当前本机的只读/离线连通性证据。
- Guild Operator 暴露的是八个批准的只读工具；TKDesk 提供候选交接，但工具清单没有发消息或发邀约能力。不能以 MCP 连通推导平台写能力。

## 迁移边界

本仓库接收现行本机运行包、可复现补丁、产品设计与历史方案，以及后续改写可能用到的 Wingman 方法源和许可证。旧 `ops/deerflow-guild-runtime`、`ops/tiktok-worker`、`codex-rs/ext/guild*` 均属已退役架构，没有并入新运行路径。两个 MCP 插件仍由各自项目维护，没有复制 API 或数据。

源目录的 `.runtime/` 约 4.6 GB，包含绝对指向旧路径的 Python/uv 软链接、依赖缓存与本机状态；迁移时不直接复制。新项目在本目录运行 `npm ci`、`npm run bootstrap` 重建本机运行时。源目录保留为回退快照；新目录为公会项目入口。

目标目录首次通过官方 GitHub 地址克隆时连接超时；随后从源目录的已验证 Git 对象建立独立 checkout，把 `origin` 设回官方地址，检出同一固定提交，再由目标包的 `bootstrap` 安装补丁与依赖。目标目录 `npm test` 为 35/35；`npm run doctor` 为 12/12；`npm run acceptance` 返回 `ok: true`、2 个 MCP、8 个 Guild Operator 工具和 28 个 TKDesk 工具。新 checkout 的构建文件与运行状态仍只在被忽略的 `.runtime/` 中。

后续先完成设计中的身份与原生关系状态，再把自然沟通方法装入默认 Lead；真实消息通道必须先验证平台契约，之后才有依据实施发送和回执。每个阶段独立验收，不将设计稿写成已交付能力。
