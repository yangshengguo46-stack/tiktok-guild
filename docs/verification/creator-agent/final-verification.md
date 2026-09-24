# DeerFlow Social Runtime 最终验收

日期：2026-09-24

分支：`codex/deerflow-social-runtime`

Task 10 起始 HEAD：`eabbaf4399c3e6089b9be4d1e0c37836e859e408`

上游对照：`769589e8daee14c2587a634b6b43bd96471a41a1`

## 结论

主体纵向闭环已在隔离 fork 中完成本地验证：有来源外部事件恢复
Identity + Self + Role + Relationship + EffectivePersona + TurnContext，经默认
Lead 产生 `reply | tool | wait | no_reply`，在披露前提交，并经身份、连接、
边界、人格指纹和回执闸门。AI 自动选择有证据的表达人格，不需要运营者
手动切换，也不强制绑定子 Agent。

本结论的确定性闭环是 `verified-local`。配置已改为当前账号支持的 `gpt-6-sol`，真实模型传输是 `verified-model`；但输出未通过严格人格生成合同，质量仍 `blocked`。真实
TikTok 收信、发信、正式邀约、送达/已读回执均为 `unverified-external`。

## 安全迁移证据

只把两个备份复制到隔离 fork 的 ignored `backend/.deer-flow`。备份只用
immutable read-only SQLite 和 SHA-256 检查；未迁移或改写外层主 checkout、旧 runtime
或备份。

| 对象 | 结果 |
| --- | --- |
| DB 备份 SHA-256 | `35820868c20621f09bc57c7e339dfedbac2f7decd809cb5ba084ad882ec92c8e` |
| 迁移后隔离 DB SHA-256 | `5af704ac1ea4ef774f83332a345108d9bd0459c755a3a6a10a4ea6b8cc639e9c` |
| SOUL 备份/恢复后 SHA-256 | `3cd8a4d11d8d3cdbeb8df21f305d654926145e97f57b750316a42c9cb5798b02` |
| 迁移前 app revision | 无 `alembic_version`；`PRAGMA user_version=0` |
| 迁移后 app revision | `0026_social_runtime`；`PRAGMA user_version=0` |
| 迁移前/后总表数 | 4 / 32 |

计划中“`0025 -> 0026`”的假设与实际备份不符。源 DB 是一个只有 LangGraph
checkpoint/store 的旧共享库，不是旧 app DB。因此没有盲目 stamp `0025`，也没有裸跑
Alembic；使用正式 `init_engine('sqlite') -> bootstrap_schema` 路径，由已审查的
`empty -> create_all + stamp head (0026_social_runtime)` 分支建立 app schema。

### 原表保留

SHA-256 是对 `sqlite_master.sql` 原文的 UTF-8 字节计算。

| 表 | 迁移前行数 | 迁移后行数 | 迁移前/后 schema SHA-256 |
| --- | ---: | ---: | --- |
| `checkpoints` | 0 | 0 | `3a0819d8e6bbbe21ce3ab9b11b52a4cb43b092057a5b678146449188836e8ef0` |
| `store` | 0 | 0 | `f5b551914cc65942c74f093481e29159c2d543fb41b9aed957cdb3148da7f02f` |
| `store_migrations` | 5 | 5 | `29d181a53c0ee09ac10b3ad39f8d8c4c063784c845e00bb18451d0571a033b67` |
| `writes` | 0 | 0 | `e8e9a33506c635a673399cc4fad323b2c3e30fc3c873752e7d42e0053afb4a89` |

迁移后 `creator_agent_relationship`、`social_event`、`social_persona_profile`、
`social_persona_binding` 和 `social_outbound` 均为 0 行。所以没有可迁移或可推断的
事实、承诺、禁联、人工接管或代表性人格指纹。

## 验证矩阵

| 门禁 | 结果 |
| --- | --- |
| Social + eval focused | `426 passed` |
| 显式离线分支矩阵 | `21 passed`；覆盖 reply/tool/wait/no_reply、DNC、人工接管、身份未验证、未知回执、重启/去重、CAS loser、账号/代理/关系 stale persona fingerprint、未知发送不盲重试、零部分流与 accepted/delivered/failed/unknown |
| MCP focused | `716 passed, 10 skipped`；1 条已有 Starlette warning |
| Task 10 回归修复 | 新增 4 失败的根因均已修复；最终关联回归 `55 passed` |
| Backend full | `18 failed, 17531 passed, 189 skipped, 3 deselected, 23 warnings`；18 项与 untouched upstream 精确匹配，分支新增失败为 0 |
| Blocking I/O | `144 passed`；2 条已有 deprecation warning |
| Backend lint | Ruff check/format 通过 |
| Frontend check | ESLint + TypeScript 通过；精确 `pnpm@10.26.2` |
| Frontend full | 201 files / 1626 tests；`1599 passed, 27 failed`；精确与 untouched upstream + Node 26.4.0 复现匹配 |
| Workbench/sidebar Playwright | `5 passed` |
| Ops unit | `33 passed` |
| Ops doctor | 15/15 checks passed；DB `0026_social_runtime`，6 人格，Guild 8 tools，TKDesk 28 tools，pnpm `10.26.2` |
| Ops acceptance | `ok: true`；2 MCP servers，nativeGuildLead true |

### 全量失败对照

Untouched upstream `769589e8` 在同一主机上的 backend `make test` 结果为
`18 failed, 16979 passed, 189 skipped, 3 deselected`；`--lf` 再次复现全部 18 项。
失败组为 browser automation 3、Browserless 4、Crawl4AI 4、extension manager 1、
FastCRW 3、OpenViking 1、parallel MCP user-agent 2。它们是 example.com 被私网/回环防护拒绝、
本地 MCP fixture 502/缺少工具等同环境失败。

Frontend 的 27 项失败仅位于 `favorites-store.dom.test.tsx` 17 项与
`user-preferences.dom.test.tsx` 10 项，均是 Node 26.4.0 下 `localStorage`/
`sessionStorage` 为 undefined 后 `.clear()` 的 `TypeError`。Untouched upstream 为同样的
201 files / 1626 tests / 1599 pass / 27 fail。

## 工作台与仓库边界

- `frontend/src/app/workspace/guild/page.tsx` SHA-256：
  `233591c4e040fff792fa961a2e0a5766064590507dd24b986793b87f19771da5`。
- `frontend/tests/e2e/sidebar.spec.ts` SHA-256：
  `35a2d78f35c132258a1a838b5411b5a20762971fbfed54cb5122a2bc03ccc652`。
- 两个哈希与 Task 8/9 一致，本次未重设计或连接假数据。
- 上游 `769589e8` 与 pre-fork `ad8d9aa` 均已验证为当前分支祖先。
- 启动和 bootstrap 不 clone 第二份 DeerFlow，不声明或应用累计 product patch。
- 验证生成的 ops `node_modules` 已移到
  `/tmp/deerflow-task10-ops-node_modules-20260924-final`，未删除、未纳入 Git。

## 现实边界

| 能力 | 状态 | 证据边界 |
| --- | --- | --- |
| 配置模型传输 | `verified-model` | 前 4 次诊断确认 `gpt-5.4` 不支持当前 ChatGPT account；ignored start config 改为 `gpt-6-sol` 后，第 6 次请求从 provider 返回真实 JSON 与 usage（20.532 秒）。第 7 次最终请求在显式 30.003 秒 generator 超时，零平台工具/写入；默认 generator 上限已从 15 秒调为 45 秒。 |
| 配置模型的人格生成/对话质量 | `blocked` | 第 6 次输出含嵌套 `style`/`response_format`，被严格 parser 拒绝；随后补齐 flat whitelist 与标量/数组合同，第 7 次最终请求以 `invalid generator response` 超时。无候选人格激活；第 6 次 raw/usage 已保存，WP1 multi-turn 未发送。 |
| PostgreSQL 事务/锁 | `blocked` | 只有确定性 SQL 分支测试，无 live PostgreSQL server。 |
| TikTok inbound 身份/收信 | `unverified-external` | 无认证 provider、稳定 sender identity 或真实 event 证据。 |
| TikTok outbound | `unverified-external` | 无授权生产 sender 或 provider acceptance 证据。 |
| TikTok 正式邀约 | `unverified-external` | 无认证邀约通道、授权、去重或平台结果。 |
| TikTok delivery/read receipt | `unverified-external` | 无经验证回执合同；unknown 不盲目重试。 |

## 可重复的状态复制与验证

1. 先在隔离 worktree 外校验两个备份的 SHA-256。若需 schema 检查，
   对备份副本使用 read-only/immutable SQLite URI；不在外层 live 目录上运行 bootstrap。
2. 把 DB/SOUL 复制到隔离 fork 的
   `backend/.deer-flow/data/deerflow.db` 和 `backend/.deer-flow/SOUL.md`，立即再次校验 SHA-256。
3. 只对隔离副本执行正式 bootstrap：

   ```bash
   cd backend
   uv run python - <<'PY'
   import asyncio
   from pathlib import Path
   from deerflow.persistence.engine import close_engine, init_engine

   async def main():
       db = Path(".deer-flow/data/deerflow.db").resolve()
       await init_engine(
           "sqlite",
           url=f"sqlite+aiosqlite:///{db}",
           sqlite_dir=str(db.parent),
       )
       await close_engine()

   asyncio.run(main())
   PY
   ```

4. 用 read-only/immutable SQLite URI 对照 revision、表名、四表行数和 app 社交表行数；
   用 `printf '%s' "$(sqlite3 ... \"SELECT sql FROM sqlite_master ...\")" | shasum -a 256`
   对照原表 schema 哈希。
5. 用本文“验证矩阵”中的定向门禁，然后执行
   `make test`、`make test-blocking-io`、`make lint`、精确 `pnpm@10.26.2`
   前端检查/测试和 ops test/doctor/acceptance。
6. 再次校验备份哈希、外层 checkout 状态、两个祖先、工作台哈希和
   `git diff --check`。保留备份与旧 runtime，直到用户另行授权清理。

由于 `backend/.deer-flow` 被 Git 忽略，它不会随分支 fast-forward。最终 cutover 必须
由 root 在独立复审后，把这份已验证状态安全复制到外层主工作区。
ignored `ops/guild-runtime/config/config.yaml` 也必须一起复制，其模型现为 `gpt-6-sol`、
SHA-256 为 `930020f8d924c0d4c4a94616ae1025a34f81d97c616664f30756b04e0f0001b5`。
复制后再跑 doctor/acceptance。
