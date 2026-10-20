# 原版功能逐项验收表

本表是 TKDesk 对 TKsoft 主播名单采集插件的功能复刻基线。它只覆盖“主播名单发现与资格核验”子后台，不包含公会总后台、主播沟通或官方账号营销。

基线日期：2026-08-23。基线版本：`0.9.0`。

当前代码验收统计：共 63 项；57 项 `PASS`，5 项 `INTENTIONAL`，1 项 `PARTIAL`，0 项 `MISSING`。B03 的旧边界记录已按 V10 初始化与 HTTP 路径修正：PC/Data 各自持有发现登录初始化的执行期国家 jar，离线契约已通过；真实 E2E 单独记录。这只是实现与模拟验收统计，真实 TikTok E2E 仍以每行“真实 E2E”列为准。

## 2026-09-26 真实试采补充

当前运行构建 `0.9.0+codex.20260926204501` 的 Feed v4 接口兼容改动恢复过名单产出，但尚未稳定：任务 `b33b0f50-5a9a-492a-b433-0ecb98db3614` 在 SA 跑满 5 轮，第一轮收到 6 个房间，国家过滤后 2 人；后四轮 HTTP 200 但正文为空。官方子后台用 1 次批量请求完成 2 人核验，available 1、ineligible 1。三国首次验收仍为 0 人；移动授权缺失、RoomEnter 拒绝各自保留，不得把本次结果称为三国稳定恢复或完整原版复刻。

## 2026-09-27 原版发布配置直接取榜补充

用户明确要求复刻原版授权/请求后，新增独立 opt-in 的原版发布配置 loader。9.9 的 DownloadCoreDLL → 解密 country/mobileHeader → HTTP 请求头路径已核对；2026-09-27 当前公开配置载入 36 个显示记录、27 组。SA 线路三张固定榜业务码均为 0，各 99 行；现有生产 transport 按 DisplayID 合并为 233 个候选，并预填来源分数。该样本把 B07/B08/D04/D05 在 MENA/SA 的实测状态提升为 LIVE-OBSERVED，不升级全地区或完整链路 LIVE-PASS。配置仍依赖发布方，授权来源不是本人移动会话。后续 Feed/DataProcessor/资格/Ranking 完整链/递归、完整六分数与持久入库本轮未验收。详见 [original-published-core.md](original-published-core.md)。

## 2026-09-27 三轮、三组真实资格查询补充

任务 `e2d60a3c-7f75-46bc-84da-4c2c4508404b` 使用原版直接榜单、TikHub 0 调用。SA/QA/EG 的 Mobile bundle 均 complete，Top/Hot/Record 各99行；按 DisplayID 进入持久队列后，90 个不同主播完成 Country/资料过滤及三次官方资格请求，每次30人。可邀请分别4、1、2，共7；不符合条件83、未确定0。名单国别 SA53、EG29、QA8。本机新候选83、关联已有7。资格和名单路径在本次三国样本真实观察通过，不升级完整地区/完整原版复刻。

三国 PC 各执行3次；首轮各6房间，后两轮6次为 `feed_response_not_json`。Country transport failed6、Basic transport failed7、RoomEnter业务拒绝68，失败记录不自动重试；CurrentScore coverage0/90。TopScore与RankingScore各90，HotListScore38、RankRecordScore28，History按TopCode1跳过。7个Ranking seed已持久化但未到期，本次没有WorkID4递归。任务达到90人、三轮、三组后以高层pause_run暂停，候选与队列保留。暂停恢复轮次重置已修复，有限PC轮次与候选上限独立；31项定向与407项完整检查通过。证据位于公会仓库 `docs/verification/creator-agent/2026-09-27-tkdesk-three-rounds-three-groups-evidence.json` 及同名实测记录。

## 判定规则

- `PASS`：实现路径和可观察契约已经存在，并有针对性测试；**不等于真实 TikTok 端到端已经通过**。
- `PARTIAL`：只完成了配置、字段、模拟传输或部分国家/阶段，尚未达到原版闭环。
- `MISSING`：当前执行链没有该功能，或仅有字段占位而没有数据来源。
- `INTENTIONAL`：基于产品边界明确不复制，并有本机等价替代或安全停机行为。
- 真实 E2E 状态单独记录：`LIVE-PASS` 表示同一版本、真实账号、真实线路、真实返回值可重复通过；`LIVE-OBSERVED` 只表示曾单次观察到；`SIM-PASS` 只表示模拟响应/单元或协议测试通过；`BLOCKED` 表示缺少合法的本人会话材料或线路；`NOT-RUN` 表示尚未真实执行；`N/A` 表示有意不对接原供应商能力。
- 只有相关主链行全部为 `LIVE-PASS`（或经用户确认的 `INTENTIONAL`），才能称某个国家“完成原版全自动复刻”。配置目录存在、MCP 字段存在、模拟测试通过都不能替代这个判定。
- 验收记录只能保存非敏感投影：状态、计数、字段覆盖、请求语义、时间和哈希。不得保存或展示 Cookie、Token、密钥、完整签名 URL、完整请求头或原供应商解密材料。

## A. 国家、TopCode 与线路

| ID | 功能 | 原版证据 | 当前状态 | 真实 E2E | 验收方法 | 完成条件 |
|---|---|---|---|---|---|---|
| A01 | 36 条显示配置、27 个路由组、`IncludeCode` | Core 国家数据包含 36 个显示记录，可按配置级 `countryCode` 归并为 27 个路由；成员国来自 `IncludeCode` | PASS | SIM-PASS | 调用 `original_country_catalog`，核对总数、所有显示名、成员国和重叠归属 | 36/27 数量、原始特殊归属、`PR` 双归属均一致，调用者不能注入任意路由 |
| A02 | `TopCode` 随国家配置派生 | `TopCode` 位于 `CountryData`，不是界面或接口调用参数 | PASS | SIM-PASS | 对 36 条记录逐条断言派生值；运行输入中不得出现 `topCode` 参数 | MENA/TR 为 1，其余当前样本为 2；3/default 分支保留且不可由调用者覆盖 |
| A03 | Top/History 请求语义 | EXE 按 `TopCode` 选择 Top/History 的榜单类型；TopCode 1 跳过 History | PASS | SIM-PASS | 为 TopCode 1/2/3/default 跑固定请求契约测试，再在各类至少一个合法本人配置上抓取非敏感响应投影 | 四个分支均由国家配置驱动；Top/History 得到真实分数或按 TopCode 明确跳过；真实授权样本仍需验收 |
| A04 | 三条国家代理槽与 WorkID 1–3 | 原版三个“代理地址/端口/选择国家”槽按顺序映射 WorkID 1/2/3 | PASS | SIM-PASS | 配置 1–3 个国家槽，核对顺序、唯一国家、唯一代理和每条种子的 WorkID 证据 | 每国恰好一条代理；1–3 条槽均可执行；不能生成额外“10 条节点” |
| A05 | 同一大区、不同成员国 | `StartButtonHandler` 比较三个 `CountryData.Code`，不是要求三个 `CountryCode` 相同 | PASS | SIM-PASS | 接受 SA/QA/EG；拒绝跨 MENA/CCA 的组合 | 所选国家全部属于同一路由组，且成员国身份不被大区覆盖 |
| A06 | 四节点拓扑 | 美国 TikTok 登录/会话线路与三个目标国家采集 worker 槽相互独立；子后台使用第一国家槽 | PASS | NOT-RUN | 在运行前逐条探测美国登录出口及每个国家 worker 出口，保存非敏感国家/时间证据 | SA/QA/EG 时恰好为美国 TikTok 登录/会话节点 + SA + QA + EG；Feed、Basic、Country、RoomEnter、Level 均只走对应国家 worker，不走美国登录节点；每次运行和资格批次前复核 |
| A07 | 排名派生行 WorkID 4 | `RankingProcessor.processRankingDataWithGap` 生成 WorkID 4，原版随后选择 `MobileSettings[0]` | PASS | SIM-PASS | 真实榜单产生新主播后，核对其 WorkID=4、排名范围国家仍保留，并通过对应国家线路重新做 DataProcessor | 模拟集成已覆盖 WorkID4 → 国家复核 → 资格 → SQLite 重启 → 再次榜单；仍需至少一个真实派生主播复验，且不把 `MobileSettings[0]` 臆断为美国 |

## B. 登录会话与 PC Feed

| ID | 功能 | 原版证据 | 当前状态 | 真实 E2E | 验收方法 | 完成条件 |
|---|---|---|---|---|---|---|
| B01 | TikTok 与采集子后台独立登录 | 原版分别持有 TikTok/采集后台状态；两者用途不同 | PASS | LIVE-OBSERVED | 分别启动两个隔离 Chrome 配置，人工登录后用被动状态检查验证 | 两个会话可独立重启/过期，Cookie 和本地存储从不互拷 |
| B02 | 连接已打开的同一 Chrome | 原版自动化持续使用已登录浏览器环境 | PASS | LIVE-OBSERVED | 登录后记录进程/调试端点身份，执行 `check_login`，确认没有重启或登出 | 检查前后为同一浏览器进程与配置目录；用户无需重复登录 |
| B03 | 认证会话与国家 worker 执行边界 | V10 GetTaskSettings 读取发现浏览器 Cookie；PC/Data 初始化 HTTP jar 并走国家代理。PC worker jar 持续接收 response-cookie | PASS | SIM-PASS | SessionManager 真实决策边界测试验证 PC/Data 独立国家 jar、响应状态连续性、并发初始化、401 队列封闭、普通网络重试、认证/线路切换与执行结束释放；Data 固定阶段使用认证发现执行器 | jar 只在内存中保留，不写其他持久 profile；全目录固定请求离线覆盖，不自动升级为各国真实 E2E，现场结果另见本次重写验收 |
| B04 | 固定 PC-Web LIVE Feed 与频道轮换 | V10 使用旧 Feed 配置并从 21/1/2/3/44 中选择频道 | PARTIAL | LIVE-OBSERVED | 2026-09-26 原配置返回 10011；仅换域名仍失败；官网当前域名与推荐参数组合在 SA 原线路返回 0 和 6 个房间 | v4 固定当前推荐源频道 87，归档配置保持不变；旧五频道轮换尚未恢复，当前 Feed 返回不代表全部原版功能通过 |
| B05 | 每个国家槽一个 Feed worker | 原版三条代理槽分别启动 PC worker，WorkID 与槽位一致 | PASS | SIM-PASS | 同时选择 SA/QA/EG，记录三条线路各自 Feed 次数、频道和产生的种子 | barrier 集成测试已证明三 worker 真正并发且代理/WorkID/国家隔离；仍需真实线路下每槽产生可验证种子或明确记录真实空结果 |
| B06 | Feed 种子 300 秒去重 | 原版 PC Feed 种子缓存 TTL 为 300 秒 | PASS | SIM-PASS | 同一身份在 0、299、300 秒重复进入；同时测试守护进程重启 | 300 秒内不重复处理，过期可再次进入；TTL 状态持久化，不能仅存在单次函数内存中 |
| B07 | MobileProcessor 最多四张固定整榜发现源 | 原版 `MobileProcessor.processRequests` 按国家配置依次请求 `TopURL`、条件 `HistoryRankURL`、`HotListURL`、`RankRecordURL`；它们是名单发现源，不是 DataProcessor 对每个主播重复执行的后置 join | PASS | LIVE-OBSERVED（MENA/SA，完整持久链待验） | 对一个国家在同一 worker/授权 lease 内按固定顺序取逻辑来源，记录安全请求语义、返回行数和来源标签 | 四个逻辑来源均使用国家配置中仅内部编译的固定 scope，调用方不能传 URL/anchor/room/rank 参数；TopCode 1 明确跳过 History，因此是 3 个网络请求；模板缺失/失败时整轮 partial，PC Feed 不得冒充完整；MENA/SA 原版发布配置请求已实测；其他地区与完整持久链仍待验收 |
| B08 | 四榜合并、身份去重与来源分数预填 | 原版以榜单行的 `DisplayID` 建 map 合并四张榜；按来源标签只给对应的 `TopScore@0x78`、`HistoryRankScore@0x80`、`HotListScore@0x88` 或 `RankRecordScore@0x90` 赋值，再由后续链补缺失字段 | PASS | LIVE-OBSERVED（MENA/SA，完整持久链待验） | 构造四榜有重叠、单榜独有和身份冲突的响应，经过生产 seam 写入 SQLite | 规范化 DisplayID 相同的主播合并为一条且保留各来源分数；稳定 userId/secUid 只作冲突检测，不跨 handle 合并；未出现在某榜时保持未知；合并后进入同一持久 Feed 队列和 DataProcessor；冲突 fail closed |

## C. HMD 等价替代与 DataProcessor

| ID | 功能 | 原版证据 | 当前状态 | 真实 E2E | 验收方法 | 完成条件 |
|---|---|---|---|---|---|---|
| C01 | HMD 20-handle 供应商门禁 | `HmdProcessor` 将最多 20 个 DisplayID 送往供应商私有 `/update`，使用其 `bmd` 结果并做 48 小时抑制 | INTENTIONAL | N/A | 确认 TKDesk 不访问供应商账号/门禁，改用本地去重与明确的资格/过滤证据 | 无供应商登录依赖、不伪造 `bmd`；文档明确该私有质量信号不可能等价恢复 |
| C02 | 四个 DataProcessor consumer | 原版启动 4 个消费者；这是并发数，不是代理数 | PASS | SIM-PASS | 注入多于 4 个种子并观测最大同时执行数 | 10 个种子且调用者传 `maxWorkers=99` 时实测最大并发仍为 4；异步完成不改结果顺序，WorkID 1–4 国家线路亲和保持 |
| C03 | Basic room/user 阶段 | 原版按 DisplayID 获取 RoomID/UserID/SecUID/粉丝和条件性 LiveTime | PASS | SIM-PASS | 用固定响应契约核对字段与短路，再在对应 WorkID 国家线路用真实样本核对 | 字段与原版映射一致、失败保持 `null/partial`；通过 B03 的国家 worker/认证边界验收，并取得真实国家 worker 响应 |
| C04 | 粉丝上下限在 Basic 后过滤 | 原版 Basic 后立即判断 follower min/max | PASS | SIM-PASS | 测试边界值、缺失值和 min>max | 边界包含关系与原版一致；缺失粉丝不被当成 0 |
| C05 | Country gift-list 阶段 | 原版按 RoomID 获取 `pages[0].region`；空 pages 随后走国家不匹配 | PASS | SIM-PASS | 在真实国家线路上核对已知主播，并测试空 pages | 返回国家必须来自响应；不能从代理国家回填；通过 B03 的国家 worker/认证边界验收，并取得真实国家 worker 响应 |
| C06 | 行国家与 WorkID 国家一致 | 原版 DataProcessor 在 Country 后要求返回 Region 与槽位国家一致 | PASS | SIM-PASS | 同一主播分别走匹配和不匹配线路 | 匹配继续，不匹配或缺失被过滤并记录原因 |
| C07 | DataProcessor 三项榜单补全顺序 | Country 匹配后，原版只在字段缺失时依次运行 Ranking → Top → 条件 History；HotList/RankRecord 已由前置 MobileProcessor 四榜发现源预填，不在这里逐主播请求 | PASS | BLOCKED | 对 TopCode 1/2/3 及四榜不同来源候选跑生产链，记录已有字段跳过、缺失字段补全和非敏感请求语义 | 生产链只补缺失 Ranking/Top/History；Ranking 非空标签跳过，Top/History 的 0/null 为缺失 sentinel；TopCode 1 跳过 History；HotList/RankRecord 绝不逐主播请求；真实本人授权仍待验收 |
| C08 | RoomEnter 条件阶段 | 原版仅当入口行 RoomID 非 `"0"` 时执行，并从 ranks 合计 CurrentScore | PASS | SIM-PASS | 分别用入口 RoomID=0/非 0 测试，并在对应 WorkID 国家线路核对真实 ranks 合计 | 条件、合计、UserCount fallback 与原版一致；通过 B03 的国家 worker/认证边界验收 |
| C09 | Anchor level 阶段 | 原版每个存活行都取主播等级；没有目标 badge 时为字符串 `"0"` | PASS | SIM-PASS | 用有/无目标 badge 的响应契约和真实国家 worker 样本核对 | 只在请求成功后允许默认 `"0"`；请求失败保持 `null/partial`；通过 B03 的国家 worker/认证边界验收 |
| C10 | 完整阶段顺序与短路 | 原版先由 PC Feed/最多四张 Mobile 整榜产生种子；单条 DataProcessor 顺序为 Basic → 粉丝 → Country → 国家匹配 → 缺失 Ranking/Top/条件 History → 条件 RoomEnter → Level → 本地过滤 | PASS | SIM-PASS | 用阶段记录器覆盖两类来源、成功、过滤、HTTP 失败和停止信号 | PC Feed 与 MobileProcessor 合并种子进入同一 SQLite 队列和 DataProcessor；前置分数保留、缺失项按序补全、过滤/错误/停止都在安全 checkpoint 短路，Hot/Record 不重复请求 |

## D. 六项原版分数

| ID | 功能 | 原版证据 | 当前状态 | 真实 E2E | 验收方法 | 完成条件 |
|---|---|---|---|---|---|---|
| D01 | `CurrentScore` | RoomEnter `data.ranks[*].score` 合计 | PASS | SIM-PASS | 真实 LIVE 房间核对响应合计与候选落库值 | 非空房间得到原始整数；不适用/失败为 `null` 并带阶段证据 |
| D02 | `TopScore` | 当前国家配置的 Top 模板返回 owner score | PASS | BLOCKED | MENA、TopCode2 国家及可得时 TopCode3 各取真实样本 | 每类 TopCode 都用本人合法授权得到真实值；不能只通过模拟响应 |
| D03 | `HistoryRankScore` | TopCode1 跳过；TopCode2/3 使用相应 previous-gap History | PASS | BLOCKED | 验证 MENA 跳过，并在至少一个 TopCode2 国家获得真实历史值 | 跳过与真实值都能区分；真实授权样本仍需验收 |
| D04 | `HotListScore` | `MobileProcessor` 的固定 `HotListURL` 整榜行进入候选合并时，把该行 score 预填到 `UserData.HotListScore@0x88` | PASS | LIVE-OBSERVED（MENA/SA，完整持久链待验） | 拉取固定 HotList 安全投影，与另外三榜按身份合并，覆盖命中、缺失和冲突 | HotList 只作前置国家整榜来源，按 DisplayID 合并并保留大整数/未知语义；不存在逐主播 HotList 请求；MENA/SA 原版发布配置已取得真实行；其他地区与整链仍待验收 |
| D05 | `RankRecordScore` | `MobileProcessor` 的固定 `RankRecordURL` 整榜行进入候选合并时，把该行 score 预填到 `UserData.RankRecordScore@0x90` | PASS | LIVE-OBSERVED（MENA/SA，完整持久链待验） | 与 D04 相同，但使用 RankRecord 固定整榜 | RankRecord 只作前置国家整榜来源，不能用候选主播的动态 anchor/room 冒充；身份冲突 fail closed；MENA/SA 原版发布配置已取得真实行；其他地区与整链仍待验收 |
| D06 | `RankingScore`、榜名与 countdown | rank-type-16 当前榜 owner score；榜名来自 subtab 标题；响应带 countdown | PASS | BLOCKED | 对一个可资格主播真实请求，核对三字段和原始大整数 | 真实样本应保留原始 score/标题/countdown；若原响应标题缺失，UI 投影可显示 `未知`，但必须带 `rankingTitleState=original_unknown_sentinel` 证据，不能伪造标题；授权缺失时 fail closed |
| D07 | 大整数、单位和缺失语义 | 原版直接保存 score；没有证据表明它等于钱包钻石或可直接换算美元 | PASS | SIM-PASS | 超过 JS 安全整数的字符串、0、负数、空值和缺字段测试 | 原始十进制值无精度损失；单位为 `unknown_rank_score`；`null` 不转 0/USD |
| D08 | 原版优质模式 | Current/History/Hot/RankRecord/Ranking 任一 `>=10`；Top 不参与 | PASS | SIM-PASS | 覆盖任一达标、五项全已知且低于 10、证据不完整三种情况 | 判定函数正确；真实六分数覆盖仍由 D01–D06 的 E2E 状态决定，未知不得被当成低质量 |

## E. 采集子后台 startup 与资格核验

| ID | 功能 | 原版证据 | 当前状态 | 真实 E2E | 验收方法 | 完成条件 |
|---|---|---|---|---|---|---|
| E01 | 原供应商账号与设备授权到期 | 原版 vendor login/设备授权控制软件使用期 | INTENTIONAL | N/A | 确认本机克隆不依赖 vendor 账号、授权期或供应商密钥 | 过期供应商账号不影响 TKDesk；不复制或破解供应商认证材料；官方子后台 startup 预检单列 E02 |
| E02 | 子后台账号/大区启动预检 | 原版固定读取 `/common/startup/?requestFrom=portal`，用 `union.region` 与选择大区比较，并检查账号身份存在 | PASS | SIM-PASS | 登录关系管理页后，在不发资格查询的情况下读取安全的大区和账号可用性布尔证据 | 固定 GET、关系管理页、账号身份存在性和 route 派生大区门禁均已接入 MCP、full-auto 启动/恢复及每批资格预留前；不匹配、挑战页或账号不可用均在资格计数为 0 时 fail closed；仍需本人子后台真实页回归 |
| E03 | 1–30 主播资格批量查询 | 原版固定最多 30 个 DisplayID，一批计一次 | PASS | LIVE-OBSERVED | 同一版本真实提交 1、29、30 条，验证 31 条被拒绝；记录请求/返回计数 | 返回完整一一对应；历史曾观察 27/27，但仍需当前版本可重复回归后升为 LIVE-PASS |
| E04 | `AnchorStatus`、原因与邀约类型映射 | 当前官方前端返回 AnchorStatus/DisplayReason/邀请类型等字段 | PASS | LIVE-OBSERVED | 用多种真实状态核对 raw code、映射和 `eligible` 三态 | raw code 永久保留；`quota_limit` 为未知而非不合格；未知 code fail closed |
| E05 | 只有 available 进入榜单扩散 | 原版资格通过后才做榜单递归；当前后台 raw `AnchorStatus=0` 表示 available | PASS | SIM-PASS | 同批包含 available/ineligible/unresolved，观察扩散输入 | 混合集成已证明仅 available 入持久排名队列；仍需至少一个 available 完成真实榜单扩散 |

## F. 批次、小时/24 小时限额与验证码

| ID | 功能 | 原版证据 | 当前状态 | 真实 E2E | 验收方法 | 完成条件 |
|---|---|---|---|---|---|---|
| F01 | 30 人一批、一次请求记一次 | 原版批量上限 30，查询次数不是主播人数 | PASS | LIVE-OBSERVED | 资格批次表中核对 candidate count 与 request count | 每个尝试在发送前持久化；一批最多 30；27 人仍只计一次 |
| F02 | 小时 50–55、硬上限 55 | 用户确认的工作目标；原版 UI 将小时次数作为批查询上限 | PASS | SIM-PASS | 用可控时钟推进 60 分钟窗口，覆盖目标下浮和硬上限 | 第 56 次永远阻止；目标只能在 50–55 内且只向下波动 |
| F03 | 24 小时 145–150、硬上限 150 | 用户确认的工作目标；原版 UI 有 24 小时最大查询次数 | PASS | SIM-PASS | 用可控时钟覆盖滚动 24 小时边界和进程重启 | 第 151 次永远阻止；用量持久化；窗口释放时间准确 |
| F04 | 批次间隔 60–80 秒 | 用户确认需要适当浮动以降低封控风险 | PASS | SIM-PASS | 固定随机源/时钟验证间隔范围与重启后用量 | 不早于 60 秒、不晚于 80 秒；不得通过重启绕过 |
| F05 | CAPTCHA/失败不自动重放 | 原版前端可能自动重试；TKDesk 的安全等价要求每次显式调用最多一次 | PASS | SIM-PASS | 注入验证码、超时、401、配额错误 | 尝试已计账，状态可恢复但请求不自动重放；用户手动验证后需新调用 |

## G. 榜单递归队列、TTL 与恢复

| ID | 功能 | 原版证据 | 当前状态 | 真实 E2E | 验收方法 | 完成条件 |
|---|---|---|---|---|---|---|
| G01 | 每个 eligible seed 的 gap 0/-1 榜单对 | 原版固定 rank-type-16、region-type-1、gap 0 后 -1 | PASS | BLOCKED | 对真实 eligible 主播获取完整 pair，并校验请求顺序/范围 | 两个响应都成功才标 pair complete；任一失败保留 checkpoint，不伪装成功 |
| G02 | 榜单派生主播重新走 HMD/DataProcessor/资格 | 原版 RankingProcessor 生成新 UserData 后重新入链 | PASS | SIM-PASS | 真实 pair 至少产生一个新身份，跟踪其全部阶段 | 模拟集成已证明派生行不直接落为合格名单，而会重新国家核验和资格核验；仍需真实 pair 复验 |
| G03 | Feed 300 秒 TTL | 原版 Feed 身份缓存 300 秒 | PASS | SIM-PASS | 与 B06 共用测试并增加守护进程重启 | 持久化 TTL 后才完成 |
| G04 | 排名种子 countdown/180 秒缓存 TTL | 9.9 LiveProcessor SetNX Ranking:%s 以 countdown/180秒作为有效期；RankingProcessor扫描立即发0/-1请求 | PASS | SIM-PASS | 长 countdown 的可资格种子首轮立即领取；旧 pending 延迟修复；active lease保持 | 首次扫描无需等待 countdown；原记录保留；不能重启暂停任务或抢占 claim |
| G05 | 排名身份独立去重 | 保留本地600秒最小去重，长 countdown 延长缓存；不宣称完整原版时序等价 | PASS | SIM-PASS | 长 countdown 下已完成种子11分钟再次出现仍不重放，并重启守护进程 | 与 Feed 300 秒键空间分离，状态持久化 |
| G06 | 每 5 分钟扫描持久队列并递归 | 原版 RankingProcessor 每五分钟扫描队列 | PASS | SIM-PASS | 创建多个待处理/失败/到期种子，跨重启观察扫描 | 生产共享 sweeper 已由 daemon startup/timer 调用；SQLite 重启集成由启动扫描自动拾取到期任务（无手工 claim），走过 available WorkID4、国家复核、第二次榜单及 checkpoint/SQLite 持久化；仍需真实榜单回归 |

## H. 过滤与模式

| ID | 功能 | 原版证据 | 当前状态 | 真实 E2E | 验收方法 | 完成条件 |
|---|---|---|---|---|---|---|
| H01 | 粉丝上下限 | 原版任务设置提供 follower min/max | PASS | SIM-PASS | 见 C04，并验证查询/落库/交接保留原值 | 真实样本通过且缺失不误判 |
| H02 | 带货过滤 | 原版 `FilterSeller` 排除 `has_commerce_goods` | PASS | SIM-PASS | 准备一个有带货信号、一个明确无带货信号和一个未知信号的真实样本 | Feed 及排名 row/rank_user/room 的安全布尔投影已贯通 WorkID4，并覆盖 true/false/null；仅 `true` 被排除，未知不伪装为 false；仍需真实样本复验 |
| H03 | 优质模式 | 见 D08 | PASS | SIM-PASS | 见 D08 | PC Feed/Mobile 预填与动态 Ranking/Top/History 已进入同一生产链，五个参与字段任一 `>=10` 即优质、证据不全为 unresolved；D01–D06 的真实 E2E 未全通过前不得称 LIVE-PASS |
| H04 | 停止、暂停与 checkpoint 恢复 | 原版有开始/停止；Agent 版还需可恢复任务 | PASS | SIM-PASS | 在发现、资格等待和榜单阶段分别暂停/重启/恢复 | 发现 fetch 后暂停先持久化 PC/Mobile 种子；资格等待重启不重放已尝试批次；榜单 claim 暂停释放并在重启后同一 seed 仅执行一次；三阶段 checkpoint/候选均不丢 |
| H05 | 原版半自动模式 | `LiveProcessor.process` 在该模式走 `processSemiAutoMode`，不走自动 `sendBatchCheckAnchorRequest`；原浏览器另有 `uploadManualAnchorData`，对应用户手动在官方后台查询后再导入/分类 | PASS | SIM-PASS | 先运行 PC Feed + 固定四榜 → DataProcessor/SQLite，再通过现有高层工具的 `manual_import` 导入 1–30 条人工查询结果；核对规范化 handle 只关联本 run、原始状态/原因/邀约类型/固定 provenance 持久化，自动子后台请求、资格预算和排名扩散始终为 0 | 同一生产 seam 已闭合；人工导入以单个 SQLite 事务写资格观察、候选聚合、run summary 和 audit，摘要/审计故障均整批回滚且同 importId 可重试；未知、歧义、跨 run、重复/冲突整批拒绝。尚无真实 TikTok 人工样本，故不能标 LIVE-PASS，也不能替代 full_auto 真实验收 |

## I. 数据清理、SQLite、审计与交接

| ID | 功能 | 原版证据 | 当前状态 | 真实 E2E | 验收方法 | 完成条件 |
|---|---|---|---|---|---|---|
| I01 | 按时间截止清理采集数据 | 原版“清理数据”日期/时间控件选择删除截止时间 | PASS | SIM-PASS | 在临时库创建截止前后候选、观察、运行、队列和交接引用；覆盖陈旧预览、错误/过期/重复确认与 busy 状态 | 精确预览计数 + 一次性短期确认 + `BEGIN IMMEDIATE` 事务删除；保护审计、已提交交接/outbox、登录、线路/Core 和滚动预算；明确不可恢复且无自动重试 |
| I02 | SQLite 持久化运行/候选/观察/资格/checkpoint | 原版多为进程内队列和本地设置；Agent 版需要可恢复状态 | PASS | SIM-PASS | 数据库迁移、崩溃恢复、重复身份合并和权限测试 | 重启后数据一致；缺失值保持 null；资格历史不被候选合并破坏 |
| I03 | 安全审计 | 原版没有 Agent 身份读取审计；这是 Agent 化新增要求 | PASS | SIM-PASS | 运行登录、查询身份、资格、失败、交接流程后读取审计 | 每次敏感身份读取有 reason；错误中无 Cookie/Token/签名 URL |
| I04 | 匿名预览与精确查询分离 | 原版 UI 直接显示名单；Agent 版需要最小披露 | PASS | SIM-PASS | 对同一集合调用 preview/query | preview 不含可识别身份；query 需要审计理由并返回稳定 provenance |
| I05 | 准备/提交交接 | 原版止于导出/展示；数字员工交接是本项目新增 | PASS | SIM-PASS | prepare 后篡改 hash 验证拒绝；相同 hash 重复 commit 验证幂等 | exact batchId+hash+用户确认；仅写本地 outbox，不自动联系主播 |
| I06 | 六分数进入 SQLite/预览/交接 | 原版六字段在 UserData/列表中流转 | PASS | SIM-PASS | 为六字段分别写入超大整数/null，查询并生成 handoff | 传输无精度损失；真实 E2E 必须由 D01–D06 决定，字段存在不算采到数据 |
| I07 | 无自建业务 UI，MCP/Skill 操作 | 原版是桌面 UI；用户要求插件只给 Agent 使用，登录窗口除外 | INTENTIONAL | SIM-PASS | 列出 MCP 工具并启动流程 | 精确只开放 28 个高层业务工具；危险 token-boundary 回归确认没有 navigate/click/evaluate/fetch/http/request/script/selector/cookie/token/message/invite/publish/captcha 等任意底层原语；仅官方登录/验证时出现 Chrome，无额外账号系统或控制面板 |
| I08 | 原供应商 `performUpload` 名单上传 | 原版将采集结果上传至 TKsoft 厂商后台 | INTENTIONAL | N/A | 完成一轮后检查网络目标、SQLite 与交接 outbox | 绝不向原供应商上传；由本机 SQLite 保存，并只在用户审核后通过 `prepare_handoff`/`commit_handoff` 交给数字员工系统 |
| I09 | 第三方 CAPTCHA 自动识别 | 原版包含验证码识别/点击/刷新相关自动化 | INTENTIONAL | N/A | 注入 CAPTCHA/安全验证并观察请求和页面行为 | 不识别、不点击、不绕过；只将官方页带到前台供用户本人处理，且验证成功后也不隐式重放资格请求 |

## 当前阻塞主链

当前剩余工作按“真实验收优先、代码集成其次”排序：

1. 移动榜单现可使用显式启用的原版当前公开配置，MENA/SA 固定榜已实测；C07、D02/D03/D06、G01 与递归仍需逐项真实验收，不能仅凭授权 ready 升级。
2. 对 SA、QA、EG 做同一 `0.9.x` 版本四节点真实回归：三国 PC Feed + 最多四张 Mobile 整榜 → 全 DataProcessor → 子后台资格 → gap 0/-1 → 榜单五分数 + CurrentScore → 派生主播 WorkID4 → 国家复查 → 再次资格/榜单 → 六分数 → SQLite → handoff。只有真实非空且可重复才能升级 `LIVE-PASS`。
3. A07/B05/E05/G02/G06 的整链模拟验收已完成，其中 G06 已由 daemon 启动扫描自动跑过持久恢复 happy path；下一步用同一真实运行验证 SA/QA/EG 的非空结果、国家亲和及跨重启续跑。
4. E02 子后台账号/大区预检已接入生产链并通过零资格消耗模拟验收；下一步只剩本人真实子后台账号的大区匹配、账号可用和 challenge 分支回归。
5. H05 的半自动代码与模拟闭环已完成，包括 PC Feed/固定整榜发现、DataProcessor、零资格消耗隔离和人工官方结果的原子导入；下一步只剩本人真实人工样本回归。用户当前选定的正常模式是 `full_auto`，不能拿半自动或诊断结果替代它。

每完成一项，先附上测试和匿名化真实验收记录，再更新本表的“当前状态”和“真实 E2E”；不得仅修改状态文字。状态接口也必须验证逐候选/逐阶段持久证据，不能只相信运行摘要。

## V10 rewrite timing evidence

PC queue35/500ms, success3seconds/error60seconds, Mobile refresh120seconds, four Data consumers and Ranking five-minute scans have static/contract evidence. The local threshold35 is applied independently to PC and Mobile source queues, with alternating source claims and rotating country lanes; Mobile's3second backpressure wait is preserved. This admission policy is not a verified original threshold. Identity-matched fresh Country evidence can reject repeated foreign-lane work within the300second execution-local TTL, but matching-country admission always rechecks. Read producer lastFailure diagnostics to distinguish empty/HTML/non-JSON responses from transport timeouts; measurements contain no raw body or private headers. Full timing parity remains unclaimed. Normal available-PC operation is continuous and no longer needs a global calibration/Mobile permission gate; complete ranking readiness still requires its own live evidence and user-owned access.
