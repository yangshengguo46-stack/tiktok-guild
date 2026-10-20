# GitHub 公开发布检查（2026-10-20）

用户授权：把本项目全部内容上传自己的 GitHub 并公开，包含爬虫插件和公会运营助手 skill。
目标：[yangshengguo46-stack/tiktok-guild](https://github.com/yangshengguo46-stack/tiktok-guild)，
默认分支 `codex/pre-device-audit`；主项目基于 `55c412c3e`，保留既有 Git 历史。

## 发布内容

主项目现有源码、前后端、运维、规格、审计、唯一总台账、测试和必要资源均保留。
另从本机三个插件源码目录导入 203 个源码/资源文件：

| 组件 | 版本 | 文件 | Skills | 新安装后的测试 |
| --- | --- | --- | --- | --- |
| TKDesk 爬虫 | 0.9.0 | 110 | 3 | 491 passed |
| 公会运营助手 | 0.15.0 | 62 | 11 | 109 passed |
| 独立经纪人消息插件 | 0.1.0 | 31 | 1 | 58 passed |

插件元数据保留原 `+codex` 安装版本。全部原文件在导入后做逐文件内容比对；
唯一规范化是删除 TKDesk `key-provider.test.js` 的多余 EOF 空行。
导入操作不改动活动插件目录，不更改原有许可声明。
源码、skill、参考文档、插件声明、MCP 配置和锁文件一并保留。

## 运行数据排除

未导入 node_modules、浏览器 profile、cookies、TikTok 登录态、Core 授权文件、
TikHub/API 密钥、真实候选/聊天数据库或日志；现有 `.deer-flow`、环境变量文件、
真实配置继续被 Git 排除。新增全局依赖目录与插件运行数据忽略规则。
使用者安装自己的依赖并配置自己的授权；不会获得本机已登录会话。

## 密钥扫描与复核

Gitleaks 全本地 Git refs 扫描：15 处命中，逐项复核：

- 14 处来自固定上游祖先中的合成安全测试、示例凭据、测试 PEM 文本、身份隔离 UUID 或文档措辞误报。
- 1 处历史 TikHub 证据中的 `openapiSha256`，值是公开 OpenAPI 文件的 SHA-256，不是 API key。

仅新增插件目录扫描：2 处，均为 Broker 测试中的合成 `idempotency_key`。
对暂存树使用 `git checkout-index` 导出后重新扫描：15 处，均为上述测试/文档夹具。
扫描返回 exit 1 的命中保持可见并逐项复核，未以宽泛 allowlist 隐藏；没有发现实际密钥。
脱敏扫描报告和测试日志只存本机临时审计目录，不上传原始报告或运行日志。

## 本地验证

- 三个插件各自 `npm ci --ignore-scripts --no-audit --no-fund` 成功，完整离线测试 658 passed，0 failed/0 skipped。
- 15 个 skill 与本地说明链接齐全，`.mcp.json` 和插件声明保留。
- 原 CreatorAgent 附件：76 个 manifest 文件校验通过。
- 待发布索引不包含 `node_modules`、`browser-profile`、`.venv` 或 `.deer-flow` 文件。
- Git diff whitespace 检查在 EOF 规范化后执行；GitHub 公开状态与匿名访问在上传后另行核验。

这些检查仅证明源码归档与离线验证。真实模型多轮、手机、TikTok provider/回执和客户部署
仍按唯一总台账单独验收。

## GitHub 实际核验

2026-10-20 已将完整源码提交 `5c8cdf85214457adb37ccb61c18cc10b1a8490b0`
推送到既有默认分支，仓库 visibility 已修改为 `public`。不带登录令牌的 GitHub API 和
网页读取均成功（HTTP 200）；匿名读取的远端 HEAD/tree 与本地一致，包含 3,398 个文件。
递归远端树逐项确认 TKDesk 110、公会运营助手 62、经纪人 31 个文件与全部 15 份 skill。
未改写历史、未强推分支；其他项目仓库未作修改。
