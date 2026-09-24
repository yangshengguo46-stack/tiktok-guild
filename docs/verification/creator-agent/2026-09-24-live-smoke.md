# 2026-09-24 现场试运行记录

时间：2026-09-24（Asia/Shanghai）  
派发号：`DSR-LIVE-20260924-01`  
版本：`master@0d3cf831`

## 本机启动

按 `npm run bootstrap -> npm run doctor -> npm run acceptance -> npm start` 执行。

- bootstrap 成功，固定 pnpm 工具安装在 `ops/guild-runtime/.runtime`，版本 `10.26.2`；
- doctor：15/15 checks passed；
- acceptance：`ok: true`，2 MCP servers，Guild 8 tools，TKDesk 28 tools，`nativeGuildLead: true`；
- Gateway `GET http://127.0.0.1:8001/health`：HTTP 200，`{"status":"healthy"}`；
- 前端直连 `http://127.0.0.1:3000/`：HTTP 200；
- Nginx `http://127.0.0.1:2026/`：HTTP 200；
- `/workspace/guild` 在未创建管理员账户时按设计重定向到 `/setup`；没有代替用户创建账户。

当前本机生产模式进程保持运行：Gateway 8001、Frontend 3000、Nginx 2026。

## 真实模型非业务探针

配置模型：`gpt-6-sol`。本轮只使用合成的“稍微更温和、更简洁”要求，未放入主播真实资料，
未激活候选，也没有任何 TikTok 平台写入。

结果：

- `PersonaProfileGenerator`：`verified-model`；耗时 12.886 秒；生成 `live_smoke@1`；
  生成 6 个表达字段、2 个合成示例；`activated=false`；
- `AutomaticPersonaSelector`：模型返回了可解析的严格 JSON `stay` 决策，置信度 0.99，
  并引用了本轮 creator evidence；没有产生切换，因为模型判断当前模板仍可满足该证据；
- 对“不要玩笑、要耐心温和反思”的合成证据，模型仍返回合规 `stay`，理由是当前六模板中
  没有完全匹配项。该结果说明选择器合同和 fail-closed 边界正常，但不能证明真实模型会
  在语义不匹配时主动切换。

## 结论与阻塞

- 本机启动、原生 Lead、MCP 静态合同和真实模型传输：`verified-local` / `verified-model`；
- 自动人格候选生成：本轮已通过真实模型验证；
- 真实模型的语义“switch”质量：`blocked`，本轮没有把模型的保守 `stay` 解释成成功切换；
- 首次使用仍需要用户在 `http://127.0.0.1:2026/setup` 完成管理员账户创建；这是安全敏感的
  用户动作，不能由代理代填；
- TikTok 真实收信、发信、正式邀约、送达/已读回执仍是 `unverified-external`。
