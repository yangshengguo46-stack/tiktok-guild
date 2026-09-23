# TikTok LIVE 公会 DeerFlow Agent

本目录是公会 Agent 的独立项目。当前可运行的是本机 DeerFlow Lead 基线，完整产品目标见 [总体方案](docs/superpowers/specs/2026-09-23-deerflow-tiktok-guild-end-to-end-design.md)，已核对的能力缺口见 [迁移审计](docs/audits/2026-09-23-deerflow-guild-migration-audit.md)。旧 Wingman 仓库保留原运行目录作为回退资料；此处是后续公会开发的项目入口。

This package runs one local DeerFlow Lead on this Mac. It talks directly to the existing read-only Guild Operator and TKDesk MCP servers. There is no recruiter worker, Rust bridge, ledger, or projection database.

External-channel runs now carry a server-owned, bounded provenance descriptor into that same default Lead. The descriptor identifies the channel origin without creating a separate creator agent or restricting ordinary Lead planning and tool use. This package still has no TikTok receive transport, send transport, or delivery-receipt support; it does not receive or send real TikTok messages.

## First setup

```sh
cd /Users/yangyucheng/Documents/ChatGPT/Tiktok公会
npm ci
npm run bootstrap
npm run doctor
npm start
```

`bootstrap` downloads the approved DeerFlow commit and installs its local dependencies. A later run reuses the same checkout only when its remote and exact commit still match.

`doctor` validates the two plugin catalogs without calling a TikTok business tool. `start` reruns doctor and then starts DeerFlow in the foreground. Press `Ctrl-C` to stop it.

## First safe prompt

> As the guild Lead, use current Guild Operator and TKDesk facts for a read-only diagnosis of recruitment readiness. State each fact's source, time, scope, and any missing data. Do not send, invite, follow, comment, gift, publish, or change anything. Tell me which login or configuration step I must complete next.

If an existing plugin opens native Chrome, finish the TikTok login there yourself, then rerun `npm run doctor`. Phase one can read evidence and draft the next action; it cannot perform outreach.

本项目的 `.runtime/` 由 `bootstrap` 在当前目录重新生成，不纳入 Git。旧目录的运行缓存和空案件目录仍保留在原位置，供核对；新 Lead 不读取旧案件目录。
