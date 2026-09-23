# PERSONA-REV1 更正与实际测试记录

日期：2026-09-24。范围：当前工作容器中的资产、合同和离线装配；不是生产集成或聊天效果测试。

## 本次确实完成

主方案、人格系统、开工指令、目录与六基础模板的策略元数据、当前回合/认知/候选提示、采用说明和旧persona_stability评审已同步更正。六模板策略版本1.0.1；原36段四轮表达示例保留。新增profile/binding合同、四个profile fixture、五种binding快照、生成任务说明、离线解析/预览和12条合成配置场景。

## 已运行

- `python -m unittest discover -s tests -v`：**104项通过，0失败**；包括原70项与新增34项。原始输出见`test_logs/unittest.txt`。
- `python scripts/preview_persona.py --persona relaxed_wit --examples`：成功。只构建输入，无模型输出。
- `python scripts/preview_profile.py --case account`：选中`account_relaxed@1.0.0`。
- `--case subagent`：选中`worker_quiet@1.0.0`；`--case relationship`：选中`relation_warm_short@1.0.0`。
- `--case switch`：选中`account_direct@1.0.0`；`--case rollback`：新revision重新指向`account_relaxed@1.0.0`。
- 五份预览均为可解析JSON，位于`test_logs/profile_*.json`。
- 包内JSON/JSONL解析检查完成，主文档/prompt/模板中的旧永久固定限制已扫描清除；迁移说明中的旧规则引用仅解释替换内容。

新增单测检查：优先级、清除覆盖、完整换profile而非拼接冲突底色、临时适配不写回、范围隔离、有效依赖指纹、未知引用显式错误、profile来源字段、换装保留身份/历史、回滚后版本仍前进、示例和历史分离。测试只证明这些参考函数的结构行为；不存在“104项心理学/聊天测试通过”的结论。

## 尚未完成或尚未执行

未接用户实际DeerFlow、模型、消息渠道、公会后台；未调用Jev；未运行真正的profile生成模型；没有生产profile存储、管理Chat绑定工具、原生子Agent持久记忆或发送前失效的集成测试。reference只解析已提供的配置视图，不实现上述服务。generated字段的样例由本次手工构造，不能当真实自动生成结果。

未进行真人对话盲评、自然度比较或招募效果实验。旧72条社交开发输入、12条新增配置输入与60条业务回归均为合成素材，不是独立真实留出集。

## 开工入口

本包整体替代旧FINAL的人格规则，不重置已有代码。按CODING_AGENT_PROMPT.md在现有工程接入真实生成、绑定/撤销/回滚、每轮加载与发送版本核对。已有代码可用即复用，不能为让参考测试通过而造第二份runtime。
