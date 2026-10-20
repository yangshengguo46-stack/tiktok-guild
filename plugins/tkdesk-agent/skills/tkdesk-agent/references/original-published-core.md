# 原版发布配置直接取榜

用户明确要求复刻原版授权和请求时，可选择独立的原版发布配置源。9.9 从发布方 `/Core/Core.dll` 下载配置，解密后读取 `countries` 与 `mobileHeader[].httpHeader`，把其中授权加入 TikTok 移动榜单请求。它不是由 Web 登录现场生成移动授权。当前公开配置的 MENA 地址是 useast5；旧静态样本是 useast8。

本机 `providers/tksoft-original.json` 必须 `enabled: true` 且 `authorizationSource: user_authorized_original_bundle`。`originalExecutablePath` 指向已核验 SHA-256 的用户提供原版样本，loader 只读取其格式常量；实际榜单授权来自私有 `tksoft-original.Core.dll` 加密缓存。两个文件均为 0600，目录为 0700；不把任何授权明文写入配置、SQLite、日志或 Agent 消息。没有 opt-in 时继续使用已有用户自有 Core；已 opt-in 但解密或结构校验失败时明确报 invalid，不自动换来源。

loader 保留36个显示配置、27组及原版成员定义。复用现有 transport、代理线路和 opaque lease；只接受已编译地区/显示名、允许的 TikTok 域名、固定路径和严格公共参数。请求头按目标域名匹配，不按固定数组下标；重复域名目前保留配置顺序取首条，未经实测的地区仍需验收，不自动轮换授权。固定模板更新允许当前配置更换 public host/anchor/room；调用者不能提供 URL、头或任意参数。

读取 `core_configuration_status` 和按市场/国家查询的 `mobile_authorization_status`，如 source/provenance 是 `user_authorized_original_bundle`，必须如实说明其发布方依赖。ready 表示配置可用，不表示所有地区已经实测或完整资格链路已通过。MENA/SA 本次实测 Top/Hot/Record 各99行，按 DisplayID 合并233候选；TopCode1 的 History 明确跳过。未出现在某榜的对应分数保持未知。

维护更新：在采集与资格批次均空闲时，操作方可运行 `node scripts/refresh_original_core.mjs`。它只对固定公开地址做一次不带登录 Cookie/Authorization 的 GET，禁止重定向，25秒超时、1MB上限；完整解密及域名/参数校验通过后才原子替换加密缓存。失败保留旧缓存、不自动重试。更新后重启空闲 daemon 才载入新配置；正常 status/job 不隐式下载。授权失效时取榜报错，不能宣称永久可用。显式 `clear_mobile_authorization` 停用该源并清零内存授权；不会清除浏览器登录和候选记录。

此路径不调用 TikHub、不登录原供应商账户、不调用其 HMD/update/名单上传，也不进行平台写入。本人发现浏览器与官方采集子后台的初始化和人工验证仍由各自 skill 负责。
