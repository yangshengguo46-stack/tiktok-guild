# Guild Agent 生产隔离与 app-server 自动运行 —— 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在当前 Mac 的独立非管理员 `tiktok-worker` 用户中部署 Guild Agent + TikTok Recruiter Worker，用 app-server 和同一原生 Chat 任务持续处理 inbox、LIVE opportunity 和 due work，同时保证模型不可见 shell、文件、Git、任意浏览器、任意 URL 或凭据。

**Architecture:** 使用已有 app-server Guild native extension 作为 Agent 主机，`GUILD_AGENT_HOME` 指向 `tiktok-worker` 私有状态目录。该用户的独立 Codex home 只配置 `tiktok-recruiter-worker` MCP，`enabled_tools` 锁定十三个业务工具；关闭 shell tool、web search、apps、skills 扩展和其他 MCP。app-server 的 `GUILD_AGENT_PRODUCTION=1` 启动模式在模型工具计划与调用路由两处强制 allowlist。一个 launchd supervisor 只向已创建的 Guild Chat 任务投递固定“tick”消息，不拥有 TikTok 业务决策。登录、验证、充值、新 contract 接受和急停仍由人在该系统用户中完成。

**Tech Stack:** macOS standard user/Keychain/launchd、Codex app-server v2、Codex native Chat、TOML managed config/requirements、Node.js supervisor tests、Rust app-server integration tests

**Spec:** `/Users/yangyucheng/.codex/worktrees/guild-agent-v1/妹子攻略计划/docs/superpowers/specs/2026-09-21-tiktok-recruiter-worker-design.md`

## Dependencies

本计划只在以下两份计划的离线测试完成后执行：

1. `2026-09-21-tiktok-recruiter-worker.md`
2. `2026-09-21-guild-autonomous-outreach.md`

生产用户不从开发工作树动态运行源码，只接收已验收的固定提交和已生成产物。

## Global constraints

- 不把 `tiktok-worker` 加入 admin、developer、staff 以外的共享组，不授予 sudo、Full Disk Access 或主用户目录 ACL。
- 不复制主用户的 `~/.ssh`、Git credentials、云盘、浏览器 profile、Codex home 或项目工作树。
- 模型不可见 shell/exec/apply_patch/file/Git/web/browser primitive/plugin management/tool search。
- supervisor 不解析主播消息，不生成文案，不调用 TikTok 页面；它只向同一 Guild task 发固定 tick。
- 第一版只有一个 production recruiter account、一个 browser profile、一个 Guild task、一个 supervisor instance。
- 无登录、challenge、contract drift、连续 unknown/refusal 越线或 emergency stop 都必须使后续 tick 只查状态，不继续触达。
- 用户完成登录、验证和充值后，正常候选触达不逐条弹审批。
- 实机写入按 like → comment → follow → LIVE comment → micro gift → message → invitation 逐级打开，不一次全开。
- 每个 task 都要产生可运行的验证证据，不用“应该隔离”代替实际权限检查。

## 生产目录契约

```text
/Users/tiktok-worker/
  .codex/
    config.toml
  Library/Application Support/TikTokRecruiter/
    runtime/thread-id
    guild/guild-agent.sqlite
    worker/worker.sqlite
    browser/profile/
    contracts/
    logs/
    backups/
```

所有目录为 `tiktok-worker` 所有，目录 mode `0700`，数据库、配置和日志 mode `0600`。`thread-id` 是 Codex 首次创建生产 Chat 后写入的本机不透明 UUID，不是源码模板值。用户级 `requirements.toml` 不是 Codex 的安全边界；本计划不伪装使用它，而是由生产 app-server 启动模式硬性验证配置并强制工具 allowlist。

---

### Task 1: 建立版本化的生产运行包

**Files:**

- Create: `ops/tiktok-worker/package.json`
- Create: `ops/tiktok-worker/config/guild.config.toml`
- Create: `ops/tiktok-worker/launchd/com.guild-recruiter.supervisor.plist`
- Create: `ops/tiktok-worker/src/tick-supervisor.mjs`
- Create: `ops/tiktok-worker/src/runtime-config.mjs`
- Create: `ops/tiktok-worker/src/install-layout.mjs`
- Create: `ops/tiktok-worker/test/runtime-config.test.mjs`
- Create: `ops/tiktok-worker/test/tick-supervisor.test.mjs`
- Create: `ops/tiktok-worker/README.md`

- [ ] **Step 1: 写失败的配置约束测试**

测试固定拒绝：相对路径、主用户路径、工作树路径、符号链接、第二个 MCP server、缺少 `required=true`、缺少 Worker `enabled_tools`、启用 web/shell/apps/skills、非本机 app-server 端点。

- [ ] **Step 2: 写失败的 supervisor 测试**

断言 supervisor 只读 `thread-id`，一次最多排队一条固定消息，缺 thread ID 或有未完成 tick lock 时静默退出，不启动新 Agent，不创建新 thread。

- [ ] **Step 3: 实现固定 tick 文本**

```text
Run one bounded production recruitment tick. First read account_status. If the account is paused, challenged, logged out, verification-required, or contract-drifted, report only the blocking state and do not dispatch. Otherwise sync one inbox batch, persist every message idempotently before committing its cursor, lease at most 20 due Guild work items, process each creator serially with current sourced context and the active/canary method, record every Worker receipt unchanged, cancel public touches after a reply, enforce DNC, and then stop. Stay silent when there is no new inbox item, live opportunity, due work, state transition, or required operator action.
```

这是 supervisor 唯一可发送的消息；配置不接受自由 prompt。

- [ ] **Step 4: 实现 launchd 模板**

plist 每 120 秒唤醒一次，但 supervisor 用 `O_CREAT | O_EXCL` tick lock 防重入，15 分钟以上的旧 lock 只记录 operator alert，不自动删除或再启一个进程。`ProcessType=Background`，不使用 root daemon。

- [ ] **Step 5: 运行测试并提交**

```bash
cd ops/tiktok-worker
npm test
git add .
git commit -m "feat(guild-runtime): package isolated production launcher"
```

---

### Task 2: 用 app-server 集成测试锁定模型可见工具面

**Files:**

- Create: `codex-rs/app-server/tests/suite/v2/guild_production_runtime.rs`
- Modify: `codex-rs/app-server/tests/suite/v2/mod.rs`
- Modify: `codex-rs/ext/extension-api/src/contributors.rs`
- Modify: `codex-rs/ext/extension-api/src/registry.rs`
- Modify: `codex-rs/core/src/tools/spec_plan.rs`
- Modify: `codex-rs/core/src/tools/spec_plan_tests.rs`
- Modify: `codex-rs/ext/guild/src/config.rs`
- Modify: `codex-rs/ext/guild/src/lib.rs`
- Modify: `codex-rs/app-server/src/extensions.rs`
- Modify: `codex-rs/app-server/src/message_processor.rs`

- [ ] **Step 1: 写生产配置的失败集成测试**

用 mock Responses 捕获首次 request，断言可见业务工具为七个 plain Guild tools 加 Worker MCP 十三个工具。明确断言不存在：

```text
exec_command, shell, write_stdin, apply_patch, view_image,
web_search, web.run, tool_search, request_plugin_install,
browser, chrome, collaboration, create_thread, send_message_to_thread
```

- [ ] **Step 2: 固定生产 config 并启动前验证**

`guild.config.toml` 的安全字段固定为：

```toml
approval_policy = "never"
sandbox_mode = "read-only"
web_search = "disabled"
allow_login_shell = false

[features]
shell_tool = false
unified_exec = false
view_image = false
sleep_tool = false
apps = false
plugins = false
tool_search = false
multi_agent = false
multi_agent_v2 = false
enable_fanout = false
memories = false
goals = false
code_mode = false

[skills]
include_instructions = false
[skills.bundled]
enabled = false

[mcp_servers.recruiter_worker]
command = "/usr/local/bin/node"
args = ["/Users/tiktok-worker/Library/Application Support/TikTokRecruiter/worker/src/server.mjs"]
required = true
enabled_tools = [
  "account_status", "observe_creator", "observe_live", "sync_inbox", "get_messages",
  "like_video_once", "comment_video_once", "follow_creator_once",
  "post_live_comment_once", "send_live_gift_once", "send_message_once",
  "send_invitation_once", "verify_action"
]
```

`runtime-config.mjs` 必须在启动 app-server 前按精确值验证这些字段。Node 真实路径由安装阶段用 `command -v node` 解析后写入，并在配置中保存绝对路径；不依赖 login shell 的 PATH。

- [ ] **Step 3: 实现最小的 extension-owned 工具暴露策略**

在 extension API 新增带文档注释的 `ToolExposurePolicyContributor`，它只能缩小工具集，不能注册或执行工具。`NativeExtensionLaunch::Guild` 增加由 `GUILD_AGENT_PRODUCTION=1` 冻结的 production 标记；Guild extension 在该模式注册常量 allowlist，core 在 `finalize_tool_router` 中将其余工具设为 hidden，router 对伪造的 hidden-tool call 也返回 blocked，不到达 handler。allowlist 只包含七个 Guild wire names和以下十三个 canonical names：

```text
mcp__recruiter_worker__account_status
mcp__recruiter_worker__observe_creator
mcp__recruiter_worker__observe_live
mcp__recruiter_worker__sync_inbox
mcp__recruiter_worker__get_messages
mcp__recruiter_worker__like_video_once
mcp__recruiter_worker__comment_video_once
mcp__recruiter_worker__follow_creator_once
mcp__recruiter_worker__post_live_comment_once
mcp__recruiter_worker__send_live_gift_once
mcp__recruiter_worker__send_message_once
mcp__recruiter_worker__send_invitation_once
mcp__recruiter_worker__verify_action
```

不新增 app-server v1/v2 wire API，普通任务未设该 env 时行为完全不变。

- [ ] **Step 4: 增加负面启动测试**

同时启用 Wingman home、加载第二 MCP、Worker 缺少任一 required tool、MCP 导出额外 tool、Guild home 不是绝对路径时，production app-server 必须在首次模型请求之前退出。

- [ ] **Step 5: 运行定向测试并提交**

```bash
cd codex-rs
just test -p codex-app-server guild_production_runtime
git add app-server
git commit -m "feat(app-server): constrain guild production tools"
```

---

### Task 3: 创建并验证 `tiktok-worker` 非管理员账号

**Files:**

- Create during deployment: `/Users/tiktok-worker/.codex/config.toml`
- Create during deployment: `/Users/tiktok-worker/Library/Application Support/TikTokRecruiter/`
- Create: `ops/tiktok-worker/scripts/verify-user-boundary.sh`
- Create: `ops/tiktok-worker/test/verify-user-boundary.test.mjs`

- [ ] **Step 1: 先用 fixture home 写权限验证测试**

脚本必须检查 UID 非 0、不在 admin 组、home 和 runtime 所有者匹配、不是 symlink、mode 不宽于 0700/0600、主用户目录不可读。测试用临时目录模拟，不需 root。

- [ ] **Step 2: 由用户在 macOS 系统设置创建标准账号**

名称固定 `tiktok-worker`，账号类型为 Standard，不开启 iCloud、FileVault recovery delegation、Remote Login 或 Full Disk Access。密码由用户在系统 UI 输入，不写入计划、脚本或日志。

- [ ] **Step 3: 在新账号中创建私有目录并拷贝固定产物**

复制已验收的 Codex binary/app bundle、Worker plugin build 和 `ops/tiktok-worker` 运行包，记录每个产物 SHA-256。不复制 `.git`、源工作树或开发凭据。

- [ ] **Step 4: 以新账号执行实际边界验证**

```bash
/usr/bin/id
/usr/bin/groups
/bin/test ! -r /Users/yangyucheng/Documents
/bin/test ! -r /Users/yangyucheng/.ssh
/bin/test ! -r /Users/yangyucheng/.codex
node /Users/tiktok-worker/Library/Application\ Support/TikTokRecruiter/runtime/scripts/verify-user-boundary.sh
```

Expected: 主用户三个目标均不可读，新账号无 admin/sudo 权限，私有 runtime 权限全部合格。任一检查失败则停止部署，不靠 prompt 补救。

- [ ] **Step 5: 提交验证脚本**

```bash
git add ops/tiktok-worker
git commit -m "test(guild-runtime): verify macOS user boundary"
```

---

### Task 4: 安装最小 Codex/Worker 配置并启动原生 Chat

**Files:**

- Install from template: `/Users/tiktok-worker/.codex/config.toml`
- Create during first launch: `/Users/tiktok-worker/Library/Application Support/TikTokRecruiter/runtime/thread-id`
- Create: `ops/tiktok-worker/scripts/verify-tool-surface.mjs`
- Create: `ops/tiktok-worker/test/verify-tool-surface.test.mjs`

- [ ] **Step 1: 安装配置并使用 `--strict-config` 干跑**

```bash
GUILD_AGENT_HOME='/Users/tiktok-worker/Library/Application Support/TikTokRecruiter/guild' \
GUILD_AGENT_PRODUCTION=1 \
CODEX_HOME=/Users/tiktok-worker/.codex \
/Applications/ChatGPT.app/Contents/Resources/codex app-server --strict-config --listen off
```

Expected: 配置可解析；Guild 和 Wingman 不会同时启用；Worker MCP 必须可启动。这个步骤不打开模型任务。

- [ ] **Step 2: 在 `tiktok-worker` 账号内打开 Codex app 并创建唯一生产任务**

任务标题固定为 `Guild Recruitment Production`，项目使用一个空的私有 runtime 目录，不指向开发仓库。首轮只请求 `account_status`，不触发写入。

- [ ] **Step 3: 保存任务 UUID 并验证工具面**

`thread-id` 只包含一行 UUID，mode 0600。`verify-tool-surface.mjs` 读 app-server 捕获的请求或诊断输出，运行与 Task 2 相同的 unsafe-tool denylist 和 Guild/Worker 完整性检查。

- [ ] **Step 4: 确认操作者控制不在模型工具中**

MCP tools/list 不得包含 account add/delete/rebind、login start、budget set、gift allow、contract accept、pause/resume/emergency-stop。这些只能在 `tiktok-worker` 的本地 Terminal 中运行 operator CLI。

- [ ] **Step 5: 运行测试并提交**

```bash
cd ops/tiktok-worker
npm test -- --test-name-pattern='tool surface'
git add .
git commit -m "test(guild-runtime): lock production tool surface"
```

---

### Task 5: 完成人工登录、Keychain 与安全备份

**Files:**

- Create: `ops/tiktok-worker/scripts/backup-state.sh`
- Create: `ops/tiktok-worker/scripts/verify-backup.sh`
- Create: `ops/tiktok-worker/test/backup-state.test.mjs`
- Modify: `ops/tiktok-worker/README.md`

- [ ] **Step 1: 在官方可见窗口手动完成 TikTok 登录**

使用 operator CLI `login start`，由人完成密码、CAPTCHA、2FA、PIN 和设备验证。不将 cookie/token 导出到 SQLite 或日志；它们只存在 browser profile 和该用户 Keychain。

- [ ] **Step 2: 配置预算、礼物 allowlist 和默认 pause**

部署初始保持 paused。人工确认 account identity、contract hashes、账号/hour/day/campaign 预算和 creator/day 礼物预算后才能 resume。Coins 只经 TikTok 官方界面手动充值。

- [ ] **Step 3: 实现 SQLite online backup 和 manifest**

使用 SQLite backup API 或 `.backup`，不在运行时直接复制 WAL 组。manifest 包含 Guild DB、Worker DB、method versions、contract hashes、时间和 SHA-256，不备份 browser cookies 或 Keychain。

- [ ] **Step 4: 在临时目录恢复并校验**

恢复测试必须读回 account binding、prepared/terminal actions、frozen unknown budget、work queue、method lifecycle 和 contract hashes，不打开浏览器或实际 dispatch。

- [ ] **Step 5: 运行测试并提交**

```bash
cd ops/tiktok-worker
npm test -- --test-name-pattern='backup'
git add .
git commit -m "feat(guild-runtime): back up durable recruitment state"
```

---

### Task 6: 启用同一 Chat 的有界自动 tick

**Files:**

- Install: `/Users/tiktok-worker/Library/LaunchAgents/com.guild-recruiter.supervisor.plist`
- Create at runtime: `/Users/tiktok-worker/Library/Application Support/TikTokRecruiter/logs/supervisor.log`
- Modify: `ops/tiktok-worker/test/tick-supervisor.test.mjs`

- [ ] **Step 1: 在 fake `codex queue` driver 上验证重入和错误处理**

覆盖：前一 tick 运行中、queue 返回非零、thread 不存在、app-server 不可用、旧 lock、emergency stop。任一错误都不允许创建第二任务或改写 thread ID。

- [ ] **Step 2: 手动运行一次只读 tick**

```bash
GUILD_AGENT_PRODUCTION=1 \
CODEX_HOME=/Users/tiktok-worker/.codex \
node '/Users/tiktok-worker/Library/Application Support/TikTokRecruiter/runtime/src/tick-supervisor.mjs' --once
```

Expected: 同一 `Guild Recruitment Production` 任务收到一条固定 tick，只调用 account/read tools，空 inbox 不产生用户通知。

- [ ] **Step 3: 加载 LaunchAgent**

```bash
launchctl bootstrap gui/$(id -u) /Users/tiktok-worker/Library/LaunchAgents/com.guild-recruiter.supervisor.plist
launchctl kickstart -k gui/$(id -u)/com.guild-recruiter.supervisor
launchctl print gui/$(id -u)/com.guild-recruiter.supervisor
```

Expected: 只有一个 label，120 秒间隔，没有 root daemon，没有并发叠加 tick。

- [ ] **Step 4: 验证重启恢复**

退出 Codex/Worker、重新登录该 macOS 用户，确认同一 thread ID、Guild DB、Worker ledger、cursor、冻结 unknown 和方法版本被恢复；重启不产生重复消息或礼物。

- [ ] **Step 5: 保存脱敏验收记录并提交**

```bash
git add ops/tiktok-worker
git commit -m "feat(guild-runtime): wake one durable recruitment task"
```

---

### Task 7: 运行 prompt-injection 和故障注入验收

**Files:**

- Create: `ops/tiktok-worker/test/fixtures/adversarial-messages.json`
- Create: `ops/tiktok-worker/src/adversarial-harness.mjs`
- Create: `ops/tiktok-worker/test/adversarial-harness.test.mjs`
- Create: `codex-rs/app-server/tests/suite/v2/guild_production_adversarial.rs`
- Modify: `codex-rs/app-server/tests/suite/v2/mod.rs`

- [ ] **Step 1: 固定敌对消息套件**

至少包含：要求忽略系统指令、读主用户文件、运行 shell、打开外部 URL、导出 cookie、改预算、自动充值、换号规避限制、要求再发 unknown、要求查看其他 creator 资料。

- [ ] **Step 2: 用 mock Worker 和 mock Responses 跑完整 Agent 回合**

断言模型请求中外部文本标记为 untrusted，无任何 unsafe tool spec，没有跨 creator context，没有动作信封被准备或 claim。

- [ ] **Step 3: 注入运行故障**

覆盖 browser 崩溃、发送后超时、账号身份变化、contract hash 变化、余额变化、CAPTCHA/challenge、连续 3 个 unknown、连续平台拒绝超过配置阈值。断言帐号熔断、未知不重发和预算冻结。

- [ ] **Step 4: 以 `tiktok-worker` 实际身份重跑文件边界**

敌对消息即使成功诱导模型，模型也没有 shell/file tool；另外用 OS 权限证明该账号无法读主用户目录。两层证据都必须保留。

- [ ] **Step 5: 运行定向测试并提交**

```bash
cd ops/tiktok-worker
npm test -- --test-name-pattern='adversarial'
cd ../../codex-rs
just test -p codex-app-server guild_production_adversarial
git add app-server ../ops/tiktok-worker
git commit -m "test(guild-runtime): resist untrusted creator instructions"
```

---

### Task 8: 逐级开启真实写入并验收全闭环

**Files:**

- Modify through operator CLI only: production capability state and budgets
- Create: `ops/tiktok-worker/acceptance/live-acceptance-schema.json`
- Create at runtime, local-only: `/Users/tiktok-worker/Library/Application Support/TikTokRecruiter/logs/live-acceptance.json`
- Modify: `ops/tiktok-worker/README.md`

- [ ] **Step 1: 使用少量明确的测试候选做七级门禁**

每一级只在上一级通过后由 operator CLI 开启：`video_like`、`video_comment`、`creator_follow`、`live_comment`、`live_gift`、`message`、`invitation_card`。每级要求官方界面证明一次副作、Worker receipt、Guild receipt 和无重复。

- [ ] **Step 2: 验证同一经纪人账号贯穿全流程**

一个 creator 的主页评论/关注、LIVE 留言/礼物、私信和邀约必须都回指同一 official account identity。任一 identity 不一致都立即 pause account。

- [ ] **Step 3: 验证全自动回复与停止规则**

新 inbox 唤醒同一 task，Agent 用对方语言回复；收到回复后取消公开触达；明确拒绝后 DNC 停止全渠道；空 tick 静默；无需逐条人工审批。

- [ ] **Step 4: 验证权威结果与自进化证据**

message/invitation 的 confirmed 来自 Worker，joined/first LIVE 来自 Guild Operator。OutcomeCase 在重启后可读，candidate method 只能进 replay/canary，不能因一条对话直接 active。

- [ ] **Step 5: 验证 emergency stop 和恢复**

在一个 scheduled work 存在时触发 emergency stop，后续 tick 只返回 paused，不 claim 动作。人工核对账号、contract、预算和 unknown 后 resume，原终态动作仍不重发。

- [ ] **Step 6: 生成脱敏验收摘要并提交 schema/runbook**

live log 留在 production home，仓库只提交 schema、统计和无个人数据的验收摘要。

```bash
git add ops/tiktok-worker
git commit -m "docs(guild-runtime): record staged live acceptance"
```

---

### Task 9: 最终格式、回归和安全交付

**Files:**

- Modify as required by formatter/lints: changed Rust and runtime files only

- [ ] **Step 1: 运行所有运行包测试**

```bash
cd ops/tiktok-worker
npm test
cd ../../codex-rs
just test -p codex-app-server guild_production
```

- [ ] **Step 2: 若 Task 2 修改了 Rust 产品代码，执行定向 fix 和 fmt**

```bash
cd codex-rs
just fix -p codex-app-server
just fmt
```

按项目规则，之后不重跑测试。如仅增加集成测试，也要运行 `just fmt`。

- [ ] **Step 3: 用实际生产用户重跑三个交付门**

```text
user boundary: PASS
model tool surface: PASS
single-account live acceptance: PASS
```

任一门未通过都保持 paused，不将“离线测试通过”声称为实机上线。

- [ ] **Step 4: 提交最终格式化结果**

```bash
git add codex-rs ops/tiktok-worker
git commit -m "style(guild-runtime): format production deployment"
```

## Acceptance

- `tiktok-worker` 为非管理员独立 macOS 账号，实测无法读取主用户文件、SSH、Codex home 或开发工作树。
- 生产模型只看到七个 Guild tools 和十三个 Worker 业务工具，不看到 shell/file/Git/web/browser primitive/plugin 等能力。
- 原生 Chat 中只有一个 `Guild Recruitment Production` 任务，supervisor 只投递有界 tick，不创建第二 Agent。
- 登录、CAPTCHA、2FA、充值、预算、contract 接受、pause/resume 和 emergency stop 只由人操作。
- 正常候选触达在启动后全自动，但任一 challenge/contract drift/identity mismatch/熔断条件都会确定性停止。
- 数据库、ledger、method versions 和 contract hashes 可恢复，cookie/Keychain 不进入备份或模型上下文。
