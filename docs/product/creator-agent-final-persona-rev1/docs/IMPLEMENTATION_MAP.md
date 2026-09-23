# 原生实施地图

| 本包资产 | 正式工程目标 | 必须看见的证据 |
|---|---|---|
| prompts/SOCIAL_KERNEL.md + CURRENT_TURN.md | 外部聊天profile，不覆盖管理员Chat | 实际模型请求中的profile/hash，不是UI上的提示文本 |
| personas/*.json + persona_profiles/ | 已有配置目录、profile注册与作用域绑定 | 固定/换装/关系生成，解析一份有效配置，重启可恢复，未知引用明确报错 |
| reference/personas.py + persona_profiles.py | 合入原有context assembler，无第二runtime | 模板解析、补丁与临时调整、范围隔离、有效指纹；生成profile须另接真实模型 |
| knowledge/README.md | 已有检索/数据库的材料类型 | 真实source/event、已说记录、可PASS的主动事件 |
| reference/contracts.py/candidates.py | 复用已有契约/投影，不另开服务 | 状态撤回、同快照候选、只reply外发 |
| roles/guild.template.json | 已有公会插件真实能力映射 | 实际接口路径/参数/已测回执，不留假success |
| evals/inputs.development.jsonl | 现有Lead回放入口 | 真实模型输出、调用次数、耗时、grader分离 |

before_agent加载 → wrap_model_call提供短核心与数据 → 原生tool loop → 最终投影/状态提交。具体middleware API以当前安装依赖与现有DeerFlow装配为准。[S3,S4b]

不要将build_context当语义检索器，它只装配调用方已选材料。不要将scripts/preview_persona.py当模型测试，它只生成输入。不要为了案例字面答案加规则，评审是多种合理回应。

新增生产测试：导入实际Lead并替换模型fixture作可复现集成测试；具备真实凭证时再运行实际模型多轮；没有凭证保留明确阻塞与可复现fixture，不混报。

PERSONA-REV1新增：管理Chat可生成/预览/绑定/清除覆盖/回滚profile；配置只改变相应scope，引用与revision进入待发校验。固定到子Agent不自动提供持久会话，宿主必须恢复关系记忆；不反复修改全局SOUL.md。
