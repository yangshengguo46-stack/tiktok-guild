# 2026-09-30 Social 模型预验收

派工：`AUDIT-20260930-MODEL`、`AUDIT-20260930-SOCIAL-KERNEL-FIX`。

本轮没有通过完整多轮验收。授权上限为 12 次、每次 60 秒、禁止自动重试；实际调用
`gpt-6-sol` 4 次后，第二轮回复违反输出合同，程序停止。没有 TikTok、MCP、设备、
真实主播资料或平台写入；后续职业替换、生成/启用/回滚场景未执行。

## 修复与证据边界

审计发现 `assemble_lead_agent` 的 external social 分支把包含 SOUL 的常规提示整体
替换成 `TURN_OUTPUT_PROMPT`，结果只有输出合同，没有已指定的社交内核。现改为显式
加载冻结附件 `prompts/SOCIAL_KERNEL.md` 再追加输出合同。加载器校验 SHA-256
`11b45460eaced0a1f3e468624bdfd17d81af793bf59ac7e09a86bec46c8c200c`，拒绝篡改和
symlink；不把可编辑的 SOUL 作为高权限文本带回外部会话。

新增测试先在真实 Lead 的 `ModelRequest` 缺少“话题不必为业务服务”处失败，修复后
`test_social_assets.py` 与 `test_social_lead_runtime.py` 共 130 passed。
管理员 Chat、单人格投影、commit-before-disclosure 和私有输出边界仍由这组测试覆盖。

可复跑入口：

```bash
cd backend
.venv/bin/python -m scripts.benchmark.social_preflight
.venv/bin/python -m scripts.benchmark.social_preflight --live --max-calls 12 --timeout 60
```

默认只显示计划。Live 使用现有配置与生产 `create_chat_model`；每次传输在独立进程
关闭 provider retry，并在超时后终止该进程。父进程执行生产 `SocialRuntime`、
`SocialTurnMiddleware`、`ModelRequest`、`ProfileManagement` 与临时 SQLite。
没有调用完整 Gateway/ChannelManager 或装配 MCP 工具目录，因此这是运行时/模型预验收，
不是平台端到端验收，也不是盲评。独立的完整 Lead 装配由上述离线测试覆盖。

## 真实调用结果

| 调用 | 结果 | 输入/输出 token | 耗时（秒，含进程开销） |
| --- | --- | --- | --- |
| 第 1 轮 selector | 返回 switch，但 `persona_id` 含版本，被宿主拒绝；实际维持默认人格 | 1344 / 77 | 9.435 |
| 第 1 轮 reply | 合规 JSON；2 条有来源 claims 与 pending outbox 写入 | 1356 / 150 | 13.784 |
| 第 2 轮 selector | 返回 stay | 1336 / 92 | 11.029 |
| 第 2 轮 reply | 返回普通文本；严格解析拒绝，停止预验收 | 1560 / 23 | 10.414 |

累计输入 5,596、输出 342、总计 5,938 token；四次传输合计 44.662 秒。
美元费用为 `unknown`，没有使用未核实单价推算。

第 1 轮合成用户要求“直接简短，别绕弯也别逗我”，并聊大学旧照片。selector 给出了
`persona_id="clear_direct@1.0.1"`。当时生产选择器只接受裸 ID、再自行追加版本，所以该
返回被判无效。当前代码已通过离线回归修成同时接受候选中精确的版本化 ref 或对应裸 ID；
本轮没有再次调用模型，因此这项修复尚未有新的 live 证据，不能把原始语义 switch 追认成已切换。

第 2 轮用户延续旧照片，明确不想听建议。模型回复：

> 嗯。照片里那一刻还在，照片外却已经过去很久了。

这段文本承接了语境，但没有包装成 `TurnResult`。生产 middleware 没有把它视为成功
回合，本轮程序据此停止。四次 API 传输均成功；问题属于模型输出合同可靠性，不属于
账号凭证或网络连接。此结果不足以证明自然多轮、职业替换或配置生成质量。

原始合成输入/输出和逐次 usage 属于 Git-ignored 运行证据；本 checkout 只保留上面的脱敏摘要，
没有把原始模型 payload 纳入版本库。后续可验证真实多轮历史中 assistant 的普通可见回复不会使下一轮丢失结构合同；不得通过
删除历史、放松解析或自动重复付费调用把失败转记为通过。

## 尚未实现的业务连接

本轮同时确认：`SelfMemoryChange` 仅由测试预埋，生产 turn 没有填充仓库的
`memory_changes`；保存的 followup 尚无调度消费者，也没有进入下一轮社交上下文。
这些属于待实现连接，不能仅归为“真实效果待验证”。本次没有另建记忆账本、调度服务
或臆造承诺/回执协议。
