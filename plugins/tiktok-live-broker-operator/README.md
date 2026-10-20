# TikTok LIVE 经纪人工作台

这是独立的经纪人工作插件。它和公会长 `guild_operator` 使用不同 MCP 进程、不同浏览器 profile、不同身份配置和不同工具名，避免把发送身份混在一起。

工具只有两个：

- `broker_workspace`：在经纪人 profile 中发现可用公会并返回当前进程的 `guild_ref`；
- `broker_messaging`：用 TKDesk 名单里的精确 `creator_id` 搜索、发送，并验证平台回执和会话回读。

启动前设置经纪人自己的 profile：

```sh
export TIKTOK_BROKER_PROFILE_DIR="$HOME/.codex/tiktok-live-broker-operator/profile"
export TIKTOK_BROKER_ACCOUNT_REF="affiliate:mira.creator_01"
export TIKTOK_BROKER_IDENTITY_TEXT="Mira"
```

先在这个 profile 的可见 Backstage 窗口完成经纪人登录，再调用 `broker_workspace`。`broker_messaging.prepare_message` 与 `broker_messaging.send_message` 必须使用同一个 `workflow_id`；发送器只接受启动时绑定的 `TIKTOK_BROKER_ACCOUNT_REF`，发送前必须在账号区域核验真实账号和 `TIKTOK_BROKER_IDENTITY_TEXT`，搜索结果和聊天 header 必须精确匹配目标；无法核验时拒绝点击。

同一 profile 在进程间只有一个浏览器 owner；页面操作串行执行，发送后保留消息页。浏览器启动、显隐切换和关闭有 30 秒超时，超时的旧操作仍保持隔离，晚到的 context 先关闭，不能重叠启动。

消息 key 在 profile 的 `.message-operations/operations.sqlite` 原子保留，记录只包含 sender/recipient、公会 ID、内容哈希、状态与回执；不保存内容或凭据。同 key 更换内容或目标返回 `idempotency_conflict`，重启或崩溃后未确定的操作返回 `unknown`，所有已保留 key 都禁止重发。旧浏览器 localStorage key 只读检查，已有保留不会重新点击。准备工作流最多 256 个、有效期 30 分钟，尝试发送后清理；持久 key 不随工作流清理。

`broker_messaging` 增加 `get_operation_status` 和 `reconcile_message`，参数是 `params.idempotency_key`。可沿用先前 `guild_ref` 在重启后读取本地状态，无须打开浏览器；reconcile 只观察保留页，不导航、搜索、写入或释放 key。只看到了气泡会返回 `status: unknown` 和 `read_back.visible`，缺少提供方响应时 `provider_status` 与 `provider_receipt` 均为 null。只有本次点击后发起的绑定请求、提供方 message ID 与新增读回证据齐全才返回 `verified`；protobuf 或未审查的 SDK 格式保留 unknown。


这些保证已在隔离本地 fixture 验证。真实页面账号/header 选择器和 SDK 格式仍需只读现场核验，缺失时会拒绝发送或保留 unknown；离线通过不代表真实 TikTok 消息已送达。

本地测试：

```sh
npm test
python3 /Users/yangyucheng/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py .
```

Native messaging binds the selected `.im-layout-account` to public IDs and handles from `getAgencyIMConfigV2`. An exact selected conversation row must include that sender UID. For a `creator_id` send, the numeric creator UID is the authoritative recipient identity: the sourced handle only locates the native search, and display nickname, qualification flags, and other labels do not gate the send. The selected conversation is still read back to confirm the target UID and authenticated sender before the single dispatch. Username-addressed sends retain their exact-handle and qualification checks.

Use exactly one primary recipient identifier. Existing `conversation_id` and existing `creator_id` can use native conversation rows. A new `creator_id` additionally needs `lookup_handle` from a sourced creator record, for example `{ "creator_id": "7667651908912448533", "lookup_handle": "y_livecreator" }`. The handle is a locator only; the returned UID must exactly equal the planned UID before selecting the result. Native search does not support numeric UID input. `lookup_handle` is valid only with `creator_id` and is bound to the prepared workflow, but it is excluded from the durable UID idempotency identity; changing the locator can never authorize a second send. Qualification and display-name checks belong to candidate collection, not this UID-addressed write path.

If SQLite becomes busy after dispatch, the outcome remains unknown. The settled execution lease is cleaned up only by its exact token, with a bounded deferred attempt and later token cleanup when a distinct operation is requested; the old operation key remains consumed. An independent store in the same process cannot reclaim that lease.

A retained native messaging page performs at most one automatic bootstrap. Missing identity evidence keeps writes blocked without repeated reloads; natural read-only responses may restore readiness. The page is reused across ready recipient operations.
