# 来源采用与限制

本文件记录所借机制，不是依赖安装清单。模板、提示与新增参考代码为本次独立编写，未打包第三方仓库实现或角色卡。

主线只采用DeerFlow、MaiBot表达/参与、N.E.K.O.材料驱动话题、SillyTavern人格/上下文，以及JevChat可选候选。其余是研究背景，不全部安装。

研究commit不是用户生产依赖锁；用户当前工程和已实现接口优先。GPL、AGPL与自定义限制不得用简单换语言/改名绕过；实质复用时按具体源码版本核对，保留版权与NOTICE，必要时单独许可审查。

每条来源后标示它能支持什么。仅代码存在不支持“会精聊”“转化率更高”“装上即可上线”等结论。

## S1 · OpenAI Memory

https://help.openai.com/en/articles/8590148-memory-faq

Chat记忆能力，不证明其他产品内部机制

## S2 · OpenAI Custom Instructions

https://help.openai.com/en/articles/8096356-chatgpt-custom-instructions

API需自行提供对应指令

## S3 · DeerFlow agents source snapshot

https://github.com/bytedance/deer-flow/blob/fc26204debe2808fa1b4064f8fddfea6db2c71f8/backend/packages/harness/deerflow/agents/AGENTS.md

研究快照，不是用户已检出版本

## S4 · LangChain Structured output

https://docs.langchain.com/oss/python/langchain/structured-output

Provider/Tool策略及同时使用业务工具的模型能力要求

## S4b · LangChain Custom middleware

https://docs.langchain.com/oss/python/langchain/middleware/custom

原生回调位置，不包含本项目实现

## S5 · TypeSafe models

https://docs.typesafe.ai/models

官方Jev适配方式与功能限制

## S6 · TypeSafe state

https://docs.typesafe.ai/concepts/state

共享材料、问题独立性和语言能力边界

## S7 · Kev finetuning recipe

https://github.com/jaredpalmer/kev/blob/main/skills/kev-finetune/README.md

独立开源训练方案，不是Jev官方权重；main未锁定，生产使用另行固定

## S8 · PPDPP paper

https://arxiv.org/abs/2311.00262

策略规划训练研究，不证明主播招募效果

## S9 · GEPA paper

https://arxiv.org/abs/2507.19457

离线提示优化参考，不是首发依赖

## J1 · JevChat facade

https://github.com/jev-chat/jev-chat-jarvis/blob/01f65908536d5b1ac76e3ce6cec4bbb5fe667791/app/src/main/java/com/jev/probe/jev/JevClient.kt

judge与draftAndRank的真实调用与参数，不证明效果

## J2 · JevChat reply generation

https://github.com/jev-chat/jev-chat-jarvis/blob/01f65908536d5b1ac76e3ce6cec4bbb5fe667791/app/src/main/java/com/jev/probe/jev/ReplyClient.kt

固定三候选提示与解析回退；本方案不照搬

## J3 · JevChat questions

https://github.com/jev-chat/jev-chat-jarvis/blob/01f65908536d5b1ac76e3ce6cec4bbb5fe667791/app/src/main/java/com/jev/probe/jev/JevQuestions.kt

原七题、固定候选排序与语义；不证明识别了内心

## J4 · JevChat judge client

https://github.com/jev-chat/jev-chat-jarvis/blob/01f65908536d5b1ac76e3ce6cec4bbb5fe667791/app/src/main/java/com/jev/probe/jev/JudgeClient.kt

调用、概率解析和丢上下文重试路径

## J5 · JevChat development harness

https://github.com/jev-chat/jev-chat-jarvis/blob/01f65908536d5b1ac76e3ce6cec4bbb5fe667791/tools/jev/calibrate.py

本轮读取前110行，证明有fixture加载与输出解析，不推断未读部分的校准效果

## J6 · JevChat README

https://github.com/jev-chat/jev-chat-jarvis/blob/01f65908536d5b1ac76e3ce6cec4bbb5fe667791/README.md

产品定位与声明，未真机测试；README可能滞后实际实现

## J7 · JevChat license

https://github.com/jev-chat/jev-chat-jarvis/blob/01f65908536d5b1ac76e3ce6cec4bbb5fe667791/LICENSE

MIT许可文本；NOTICE另行记录

## J7b · JevChat NOTICE

https://github.com/jev-chat/jev-chat-jarvis/blob/01f65908536d5b1ac76e3ce6cec4bbb5fe667791/NOTICE

上游来源与名称说明；正式复用时核对实际采用版本

## M1 · MaiBot expression selector

https://github.com/Mai-with-u/MaiBot/blob/7ca4f06031328bd4cb5ade261e51362e9247c2d6/src/chat/replyer/maisaka_expression_selector.py

本轮重读：表达记录/选择与情境输入，不证明真实聊天优势

## M2 · MaiBot replyer prompt

https://github.com/Mai-with-u/MaiBot/blob/7ca4f06031328bd4cb5ade261e51362e9247c2d6/prompts/zh-CN/maisaka_replyer.prompt

前轮源码已读：当前话题、自然回应、参考而非固定流程

## M3 · MaiBot README research snapshot

https://github.com/Mai-with-u/MaiBot/blob/7ca4f06031328bd4cb5ade261e51362e9247c2d6/README.md

前轮已读：设计目标和GPL标记，不判断复制代码的完整法律适用性

## N1 · N.E.K.O. proactive prompts

https://github.com/Project-N-E-K-O/N.E.K.O/blob/babfd763f7cc2b9512295ff8406895b9d832c9d9/config/prompts/prompts_proactive.py

本轮重读：新材料/历史/兴趣/PASS，不证明主动触达效果

## N2 · N.E.K.O. character prompts

https://github.com/Project-N-E-K-O/N.E.K.O/blob/babfd763f7cc2b9512295ff8406895b9d832c9d9/config/prompts/prompts_chara.py

前轮已读：反服务腔与记忆、默认亲密/虚构设定不采用

## T1 · SillyTavern character design official docs

https://docs.sillytavern.app/usage/core-concepts/characterdesign/

本轮核对：人格描述/示例/上下文，不复制角色卡，不声称为专业人格模型

## T2 · SillyTavern world info official docs

https://docs.sillytavern.app/usage/core-concepts/worldinfo/

本轮核对：相关背景动态装载；并不保证生成质量
