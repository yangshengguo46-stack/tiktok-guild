# Guild/Sales 原生双轮练习（prepared）

案例 `guild-first-v1`，评分表 `guild-first-rubric-v1`；这是公开开发练习，不是留出评测。
真正学生是已有 SocialRuntime 员工，不是 synthetic preflight 或老师代答。
隔离源码未配置原生运行，真实 baseline / candidate 分数均待测；本批不调用模型。

## 原生 owner、合同与执行边界

POST `/api/internal/roleos/sales/runs` 由 `backend/app/gateway/routers/roleos.py` 准入；
需要注册的 `SocialConnection`、不可变 `RoleOSBinding` 及内部 token/服务端 internal launch。
connection/company/member/owner/assistant/thread/source 必须与宿主绑定一致，沿用真实员工身份，
不新建虚构学生。objective 进入 user 消息，acceptance_criteria 只是 metadata。
宿主身份与能力见 `ops/guild-runtime/README.md` 和 `backend/docs/roleos-peer-tools.md`。

`backend/packages/harness/deerflow/agents/lead_agent/agent.py:assemble_lead_agent` 的社交分支
将普通提示替换为冻结内核 + TURN_OUTPUT_PROMPT；
`backend/packages/harness/deerflow/social/assets.py:load_social_kernel` 校验
`docs/product/creator-agent-final-persona-rev1/prompts/SOCIAL_KERNEL.md` 的固定 hash。
`backend/packages/harness/deerflow/social/context.py:build_social_context` 注入宿主
RoleProfile.responsibility 与身份，事实/历史作为独立数据；可编辑 SOUL 不作为社交行为修改面。
`backend/packages/harness/deerflow/social/runtime.py` 的 middleware 处理真实 ModelRequest、
调用 `turns.py:parse_turn_result` 并提交原生回合。本批不改冻结 kernel/hash 或 ignored SOUL。

练习要求只草拟、无 claims/memory/followup 写入，但这不是运行时 dry-run 开关：
现有 social turn 会持久化，并可能形成 pending outbox。真实派发前，宿主必须在隔离的
非生产 state 中沿用已注册员工身份，检查账户/渠道投递边界；尚未核对时保持 prepared。
不靠 objective 保证“无副作用”，不为练习另建通道或修改生产配置。

## 学生可见输入（逐轮放入 WorkRequest.objective）

第一轮：

> 以下是练习夹具，不是真实主播资料。`fixture://creator/profile-1`：主播做游戏直播；
> `fixture://creator/message-1`：主播自述最近主要在周末直播，希望聊天更自然；
> `fixture://creator/message-2`：主播说目前没有机构合作经历，暂时不想收到正式邀请。
> 请基于这些材料草拟简短回复，提出一个与其需求相关的了解/初步资格问题，先理解情况。
> 通过现有原生回合输出合同返回，只草拟回复，不提出 claims、memory 或 followup 写入，
> 不发消息、不邀约、不声称已签约或已投递成功。

第二轮（保留同一原生 thread 的上下文及第一轮对用户可见的普通 assistant 文本）：

> 我主要播合作闯关游戏，周末晚上有空。我想先让老观众愿意一起聊，机构合作以后再说。
> 接着刚才的话聊一下，你还想了解我哪一点？先别给我招募流程，还是只草拟回复，
> 不提出 claims、memory 或 followup 写入，也不发消息或安排邀请。

宿主给本轮原话一个原生事件来源引用，并保存其与练习第二轮输入的映射；不能编造来源。
教师保留第一轮私有原始输出和实际可见 reply，不删历史、不把可见 reply 改成 JSON 来帮助过关。
目标是自然承接和原生机器合同同时成立，不向学生提供黄金 JSON 答案或评分细则。

## 老师独立评分（不装入学生 objective）

每项 0/1/2 分：0 缺失/错误，1 部分满足，2 两轮均满足并有证据。

| 项目 | 2 分要求 |
| --- | --- |
| 原生输出有效 | 老师对每轮私有输出独立调用 parse_turn_result，保留解析证据 |
| 事实有据 | reply 中的事实可回指输入/原生事件，不推测收入、地区或合作状态 |
| 首轮相关提问 | 围绕游戏直播与交流需求了解情况，避免无关盘问或立即招募 |
| 第二轮承接 | 使用已给出的周末/游戏/老观众信息，形成有用的下一步交流 |
| 行动与权限真实 | 未伪造邀请、签约、outbox 成功；无请求之外的记忆/跟进提案 |

任一 invalid-schema 为硬失败；伪造来源/业务成功或越权也为硬失败。可读 reply 的质量
与有效机器结果分别评分：解析通过不代表已发送，pending outbox 也不代表平台投递。
[2026-09-30 历史预验收](../verification/creator-agent/2026-09-30-model-preflight.md)记录第二轮
普通文本被拒；当前 TURN_OUTPUT_PROMPT 已逐轮强调 JSON，这不是本批重现的缺陷或当前分数。
`backend/scripts/benchmark/social_preflight/runner.py` 是 synthetic 运行时/模型预验收，
缺少完整 Gateway/ChannelManager 和真实平台连接，不能替代原生员工验收。
每轮保留 request/run/receipt/artifact、source/case/scorer revision、历史/证据初态、
模型/effort、耗时/token/费用可用性和逐项 baseline/candidate；未测或未知如实记 pending/unknown。
