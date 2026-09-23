# DeerFlow 公会运行时迁移设计

## 目标

将已经验收的公会 domain、memory、Guild extension 和 Recruiter Worker 迁移到 DeerFlow 作为唯一运行底座。迁移只替换编排、MCP 接入和隔离层，不重写已经通过测试的业务规则、动作 ledger、方法回放、DNC、预算和回执契约。

第一版部署目标是空白电脑：不信任机器上可能存在的旧 DeerFlow、旧 skills、旧 MCP 配置或营销系统残留。部署程序始终从官方 `bytedance/deer-flow` 源码建立干净、固定 commit 的构建输入；旧安装只做只读诊断，不复用其配置、数据库、插件或缓存。

本版本固定使用官方 DeerFlow `v2.1.0-rc0` 的 peeled commit
`769589e8daee14c2587a634b6b43bd96471a41a1`；该 commit 必须能从官方远端重新获取。

## 运行时架构

```text
DeerFlow Gateway
  └── Guild Recruitment Agent（唯一 thread）
        ├── guild_mcp_bridge（Gateway 内固定 stdio 子进程，7 个 Guild tools）
        └── recruiter_worker_adapter（loopback HTTP MCP，13 个 Worker tools）
              └── dedicated Worker container
                    ├── Playwright persistent profile
                    ├── 单经纪人账号状态
                    ├── Worker SQLite / dispatch ledger
                    └── TikTok 官方网络访问

DeerFlow sandbox
  ├── AIO Docker / Apple Container，或 BoxLite micro-VM
  ├── Agent 的文件/bash 工具只在 sandbox 内运行
  ├── Worker 使用独立 runtime volume，不依赖 Agent sandbox 的隐式挂载
  └── 不挂载主用户 home、源码工作树、SSH、旧 Codex/DeerFlow 状态或 Docker socket
```

DeerFlow Agent 只看到显式登记的业务 MCP 工具；首版目录包含现有 7 个 Guild 工具和 13 个 Worker 工具，但不把总数锁死。后续后勤、运营或内容工具必须加入版本化 allowlist、各自的 schema 和验收测试后才能出现。sandbox 的 `bash`、文件写入、浏览器原语、插件发现和任意 MCP 不进入该 Agent 的工具面；沙盒用于隔离 Worker 进程和文件，不替代 Guild/Worker 的语义策略。

DeerFlow 的 Agent sandbox 不会自动成为 MCP server 的执行环境。因此 Worker 必须进入独立的受控 runtime container；不能把“启用了 DeerFlow sandbox”误认为“Worker 已被沙盒化”。Gateway 自身只固定启动 Rust bridge 子进程，不再额外拆出第三个容器，也不向模型暴露容器控制面。

## 干净安装与供应链边界

1. 部署脚本检查目标机的旧 DeerFlow 路径、`extensions_config.json`、skills、MCP cache、`.deer-flow` 和 Docker/Apple Container 状态，仅记录摘要，不复制任何旧内容。
2. 从官方仓库获取 DeerFlow，记录远端 URL、commit SHA、版本文件和构建锁文件摘要。生产构建必须使用固定 commit，不使用浮动 `main`、未知压缩包或旧缓存。
3. 在干净构建上下文中生成 Gateway 镜像和 sandbox 镜像；配置、MCP 清单、skills allowlist 和网络策略作为版本化输入。
4. 生产启动前验证工作树干净、镜像 digest 与 manifest 匹配、配置没有旧用户路径或旧凭据引用。
5. 模型密钥、TikTok 登录、CAPTCHA、2FA、设备验证和充值仍由操作者手动完成，不进入 Git、镜像层、MCP 参数或模型上下文。

## Guild MCP bridge

现有 `codex-guild-extension` 是 Codex 原生 extension，不能被 DeerFlow 直接导入。新增一个窄接口 bridge：

- 复用现有 Guild domain/memory/store 和 schema，不复制业务判定；
- 在 Rust 侧抽取一个 server-scoped public adapter，只暴露现有 7 个 Guild tools；
- bridge 使用 stdio JSON-RPC MCP，工具名、输入 schema、输出 JSON、错误分类与现有 app-server 合同一致；
- bridge 启动时固定 Guild home、数据库边界和 production account binding；
- 不接受 URL、selector、脚本、自由金额、凭据或动态工具名；
- 现有 `guild_*` 测试继续作为底层验收，新增 bridge catalog、schema、replay 和 restart 测试。

## Recruiter Worker 接入

现有 `tiktok-recruiter-worker` 作为第二个 MCP server 接入，保留 13 个工具和完整 `DispatchRequestV1` / `DispatchReceiptV1` 契约。Worker 使用固定的 loopback HTTP MCP 适配层，与 Gateway 共享网络 namespace，但不向主机发布端口；这不改变 Worker 的业务协议。DeerFlow 只负责调度；Worker 仍然是无 AI 执行器，动作选择、文案、方法版本、预算和 policy 由 Guild Agent/ledger 决定。

Worker 的 Playwright profile、SQLite、contract snapshots 和日志放在 sandbox 的受控 persistent volume。外部网络默认 deny，逐步加入 TikTok 官方域名 allowlist；任何 challenge、login_required、verification_required、contract drift 或 unknown 都进入确定性暂停，不由 DeerFlow prompt 自行补救。

## DeerFlow 工具与沙盒策略

- `extensions_config.json` 只启用 `guild_operator` bridge 和 `recruiter_worker`；两者关闭 DeerFlow 自动工具名前缀，以保留现有冻结 wire name，并校验 exact tool set。
- DeerFlow guardrail 使用版本化业务工具 allowlist；未登记的 MCP、`bash`、`write_file`、`str_replace`、浏览器工具和 tool search 均拒绝。工具数量没有硬上限，但每个新增工具必须有明确 owner、schema、权限和回放测试。
- Gateway 不开启 host bash，不把主机 Docker socket 暴露给模型可达进程；需要 Docker sandbox 管理时使用受控 AIO provider 或 provisioner/BoxLite 边界。
- 每个 thread 只获得自己的 `/mnt/user-data`，不直接挂载主用户目录；需要恢复的业务状态通过 Worker/Guild backup contract 管理。
- 第一阶段优先 AIO Docker/Apple Container；若目标电脑没有可用容器运行时，再评估 BoxLite 自定义浏览器镜像，不退回 LocalSandbox 作为生产隔离。

## 调度与人工边界

DeerFlow 只维护一个 `Guild Recruitment Production` thread。周期性 tick 可以先由 DeerFlow 的 thread/MCP task 机制承载；若该机制无法满足现有 lease/lock/turn-completed 契约，保留一个无模型的外部 scheduler，但它只能投递固定 tick，不能创建新 Agent/thread。

以下操作继续只允许本地 operator CLI/人工窗口：登录、CAPTCHA、2FA、设备验证、充值、预算确认、contract accept、pause/resume、emergency stop。模型工具中不得出现 account add/delete/rebind、login start、budget set、gift allow、contract accept、pause/resume、emergency-stop。

## 测试与验收

### 离线测试

- 现有 guild-domain、guild-memory、guild-extension、app-server fixture 全部保持通过；
- Rust bridge exact catalog/schema/replay/restart 测试；
- Worker 13-tool protocol、account-session、operator CLI 测试保持通过；
- DeerFlow config/extension validator 检查只存在登记过的 MCP、每个 server 的工具与 allowlist 一致、无旧路径/凭据；
- prompt-injection fixture 尝试调用 bash、写文件、动态 MCP、修改预算和伪造 Worker namespace，均在 guardrail 或 bridge 前被拒绝。

### 容器验收

- 启动干净 Gateway + dedicated Worker 两个容器；
- MCP `tools/list` 只返回 allowlist 中登记的业务工具；
- Worker 能在 sandbox 内启动并读写自己的 profile/SQLite；
- sandbox 不能读取主用户 home、源码工作树、SSH、旧 `.codex` 或旧 DeerFlow 状态；
- 网络策略在 allowlist 外确定性失败；
- 不执行 TikTok 登录或真实写动作前，完成一次全链路 fixture recruitment run。

2026-09-23 本地 Docker fixture 验收通过：DeerFlow 源码固定在
`769589e8daee14c2587a634b6b43bd96471a41a1`；已验收的本地镜像 ID 为
`deerflow-gateway:upstream-pinned` =
`sha256:4f30bb450cec56ddf3e1896d9183a2982f5da7deffc5067fffb868cd7659d838`、
Gateway acceptance =
`sha256:0c21bfcbd546df45914e9c897806dee7a93fa7b0a690b0297577df33cf1a5cda`、
`tiktok-recruiter-worker:fixture` =
`sha256:99f8731691a7e3d0150c6383eb3baf0959869198608a8a49a0537acbf648153a`、
Worker acceptance =
`sha256:240b1c597c19e001c5553d914a6c12a9336553088614d32ac76f45dda544afdc`。
这些是本机 fixture 证据，不是可分发的 registry digest；空白机生产部署仍必须在 manifest 中固定并校验实际 registry digest。

### 真实上线门

只有在上述门全部通过后，才由操作者在空白电脑上完成 TikTok 登录，并先执行 `account_status`、只读主页观察和工具面复核。首个真实写动作仍必须单动作、低预算、可验证、可暂停；本设计不授权自动充值或批量触达。

## 迁移与回滚

当前已创建的 macOS `tiktok-worker` 账号和未加载的 LaunchAgent 暂时保留为停用状态，直到 DeerFlow 容器验收完成；不自动删除任何账号或目录。若 DeerFlow bridge 或容器验收失败，继续使用已有本地 fixture 验证，不回退到未隔离的 LocalSandbox，也不进行真实 TikTok 操作。
