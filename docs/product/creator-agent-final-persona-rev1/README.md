# CreatorAgent FINAL / PERSONA-REV1 · 2026-09-24

> 一个本身就会交流、会理解语境、会表达观点、会接住不同话题，也能与具体的人形成连续互动的 Agent。公会经纪人是它承担的岗位，而不是它认识世界的边界。

这是更正后的定稿施工包，完整替换旧FINAL及v1/v1.1的人格限制；保留既有DeerFlow与插件。不是已经部署的系统，也不是训练好的新模型。

## 直接使用
将本包放到当前项目的规格/工作目录，让Coding Agent读取`CODING_AGENT_PROMPT.md`后在现有工程实现。不要嵌套第二份DeerFlow，不要将reference启动成服务。

## 包内内容
`docs/FINAL_SPEC.md`总规格；`personas/CATALOG.md`六人格库与36段示例；`personas/*.json`可加载模板；`prompts/`常驻与本轮提示；`contracts/`兼容结果与persona合同；`reference/`离线契约/上下文编译样例；`evals/`72条新合成开发题与60条旧业务回归；`tests/`可重复本地测试；`sources.json`历史来源。新增`persona_profiles/`、两个profile/binding合同、12条人格配置开发场景、`prompts/PERSONA_GENERATION.md`和`docs/MIGRATION_FROM_FINAL.md`。

## 本地检查（只验证资产/契约）
```bash
python -m pip install -r requirements-reference.txt
python -m unittest discover -s tests -v
python scripts/preview_persona.py --persona relaxed_wit --examples
python scripts/preview_profile.py --case relationship
```
这不会调用任何模型、Jev、消息接口或公会后台。预览不是聊天效果。

## 冻结默认值
DeerFlow唯一runtime，同一个Lead；账号有默认persona（松弛有趣），支持Agent/子Agent固定绑定、手动换装、关系定制与生成；岗位身份真实且不主导所有话题；Jev可关闭；真实材料与关系延续产生主动交流；Chat管理，不建新CRM。

生产部署命令必须由开发者从当前实际仓库得出；本包不假造你项目的启动路径、凭证、工具函数或平台能力。具体已完成/未完成见TEST_REPORT.md。
