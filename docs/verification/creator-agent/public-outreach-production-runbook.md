# 安卓公开建联运行说明

DeerFlow 原生库负责 sender、creator claim、sequence、task、lease、禁联和 receipt。`public-outreach-operator` 仅负责安卓设备的 Appium UiAutomator2 执行与通用控制。Web Playwright 与 iPhone XCUITest 不再是活动通道；迁移将旧 sender 标为 `retired`，历史任务和回执仍可读取，旧任务不能重新派单。

## 安装和设备准备

主机可为 macOS 或 Windows。安装 Android SDK Platform Tools、Java 和 Node 22.16+；配置 `ANDROID_HOME` 或 `ANDROID_SDK_ROOT`，并让 `adb` 在 `PATH` 中。安卓手机打开开发者选项和 USB 调试，连接后在手机上授权此电脑。用 `adb devices -l` 确认准确的设备序列号及 `device` 状态。

```sh
cd ops/guild-runtime/public-outreach-operator
npm ci --ignore-scripts
npm run android:doctor
npm run android:server
```

生产配置放在 Git 外，通过 `PUBLIC_OUTREACH_EXECUTION_CONFIG` 指向 JSON 文件，`PUBLIC_OUTREACH_RUNTIME_ROOT` 指向同一主机上 Gateway worker 共用的持久目录。示例先保持业务写入关闭：

```json
{
  "pilot": {
    "enabled": false,
    "owner_user_id": "AUTHENTICATED_USER_ID",
    "sender_account_id": "NATIVE_ANDROID_SENDER_ID",
    "creator_uid": "NATIVE_CREATOR_UID",
    "actions": ["like", "comment", "follow"],
    "message_enabled": false
  },
  "sender": {
    "owner_user_id": "AUTHENTICATED_USER_ID",
    "sender_account_id": "NATIVE_ANDROID_SENDER_ID",
    "channel": "android",
    "device_ref": "host-a:SERIAL",
    "locators": {}
  },
  "devices": [
    {
      "device_ref": "host-a:SERIAL",
      "udid": "SERIAL",
      "system_port": 8201,
      "appium_url": "http://127.0.0.1:4723",
      "app_package": "com.zhiliaoapp.musically"
    }
  ]
}
```

同一主机上每台设备要有不同 `udid` 和 `system_port`。现在的 Gateway 业务试点仍是单 owner、sender、creator，业务执行并发上限为 1；50 是可登记设备数量上限。多机并发、多主机路由与共享锁仍需实现和验收。

## 真机定位器试点

配置的 `sender.locators` 必须有版本号、发送者身份、目标身份，以及当前动作的语义控件和读回规则。支持 `resource_id`、`accessibility_id`、`ui_automator`、`xpath`；坐标不用于业务动作。点赞/关注必须配置状态属性与激活值，并观察 inactive → active。评论/私信必须配置条目定位器，以及稳定的平台条目 ID、发送者和目标属性；发送后出现全新且文本匹配的条目才产生 verified receipt。缺字段会以 `locator_evidence_required` 停止。

点赞和评论的任务还需提供确切的 TikTok `video_url`，并配置 `videoIdentity` 与 `videoIdentityProof.attribute`，在页面上读回与 URL 一致的视频 ID；关注和私信使用原生 creator handoff 的 `profile_url` 与 handle。发送者须与注册的 `external_ref` 一致，目标 handle 须与屏幕读回一致。真实 TikTok 的 Android UI 属性尚未由真机确认，因此离线测试通过后仍应保持 `pilot.enabled=false`，直到逐项采集并审核定位器和回执字段。没有平台生成的评论/消息 ID、目标身份或状态读回时保持 unknown，不能构造随机 `provider_ref` 作为成功证据。

## 设备控制和人工接管

需已登记的安卓 sender 且调用者通过现有 admin/`threads:write` 权限。设备引用必须属于当前 owner：

- `GET /api/public-outreach/devices/{device_ref}/doctor`：ADB 在线和授权检查。
- `POST /api/public-outreach/devices/{device_ref}/control`：`{"commands":[{"type":"observe"}]}` 返回最多 120 个简短可见节点；也支持 `tap`、`type`、`swipe`、`back`、`launch`，一次最多 20 步。
- `POST /api/public-outreach/devices/{device_ref}/takeover`：暂停 sender，取消活动任务，阻断 AI 写入，返回 `scrcpy -s <serial>` 命令供人工投屏。
- `POST /api/public-outreach/devices/{device_ref}/resume`：清除接管标记，设备 doctor 通过后恢复 sender。

实时视频只给人工看，不送入模型。程序按业务步骤执行，模型只在生成文字或异常判断时按任务调用；观察默认传压缩元素树，不持续上传截图或完整 XML。设备命令与业务动作共用同一设备独占锁。写入结果不明时标记人工接管；Appium 会话清理失败时保留锁，核对远端会话后才能恢复。断线不改派另一台设备。

## 原生业务边界

新注册账号只接受 `android` 和 `device_ref`。公开动作仍按 `like → comment → follow → message`，同一 sequence 固定 sender，私信需此前三个动作全部 verified。原生禁联检查同时作用于领取与派发，外部尝试前先持久化 fence；结果未知会失败并暂停 sender，绝不自动重放。只有试点 allowlist 中的显式 `execute` 会触发平台写入。Gateway 未配置执行文件时默认返回 `pilot_required`。

离线验收包含 SQLite 升级/旧账号退休、原生任务和租约测试、模拟 Appium 四动作和设备锁测试。它不能证明 TikTok 真机可用；单台真机 pilot 是启用业务写入的下一个门槛。
