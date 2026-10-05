# ZSense Android 设备互联伴侣端

这是 Android 13+ 的独立伴侣应用，不在手机上运行完整 Agent。导入 `android-companion/` 到 Android Studio 构建；需要 Android SDK 35、JDK 17 和 Gradle 8.9。仓库不保存签名私钥或 Gradle wrapper 二进制。

在这台 Mac 上可直接执行 `npm run android:preview`：脚本会启动已有的 `zsense-test` 模拟器、安装“安装包/当前”里的已签名 APK，并打开手机版首页。它不会删除模拟器中的应用数据；预览远程 Web UI 时，模拟器也必须有网络且目标桌面已完成配对。

发布包由 `:app:assembleRelease` 构建。构建机通过 `ZSENSE_ANDROID_KEYSTORE`、`ZSENSE_ANDROID_STORE_PASSWORD`、`ZSENSE_ANDROID_KEY_ALIAS`、`ZSENSE_ANDROID_KEY_PASSWORD` 四个环境变量提供长期签名密钥；不要将密钥或口令提交到仓库。当前本机的密钥在 `/Users/hank/.zsense/android-signing/companion-release.p12`，口令保存在 macOS 钥匙串的 `ai.zsense.companion.signing` 项。必须单独安全备份两者，否则换机后无法给已安装用户提供同签名升级包。此前调试签名 APK 与正式签名 APK 不能覆盖安装；安装正式包前需卸载调试包（会清除该调试包的设备身份）。

首次使用：手机生成本机 Ed25519 身份，向交换中心签名登记；输入邮箱、收验证码后将邮箱绑定到该设备公钥。列表只能通过签名的 `account-peers` 接口获取，不信任手机自报的邮箱。相同邮箱的桌面设备会出现于列表；桌面端需开启设备互联、远程连接与安全锁，并完成同一邮箱验证。点击已配对设备会在应用内打开完整桌面 Web UI；已做局域网配对时优先通过桌面端的已认证设备通道取得 Web 证书指纹并校验，随后申请一次性免密票据；若免密票据不可用则进入同一已校验证书的安全锁/访问口令页面。否则通过云端申请一次性入场票据。局域网首次配对仍需桌面显示的完整 `6 位配对码-16 位证书身份码`；同邮箱发现不等于免配对授权。远程任务仍须桌面端单独授权。

局域网扫描会带入设备实际连接端口；手动配对可分别填写 IPv4 地址和端口（默认 `39072`）。若已配对设备的旧局域网地址无法连接，打开设备时会尝试其已授权的云端入口；证书或授权错误不会自动降级。远程任务使用独立执行队列，等待任务期间仍可刷新设备列表，结果会在任务区展开显示。

交换中心仍默认只允许其配置的单个收件邮箱。管理员可在 Hub 的 `mail.json` 添加 `"allowedTo": ["second@example.com"]`，或设置 `ZSENSE_HUB_MAIL_ALLOWED_TO`（逗号分隔）；不允许任意收件人，以免成为公开发信服务。服务端改动必须部署后，多邮箱验证才会生效。

安全边界：Ed25519 私钥种子由安全随机数生成，用 Android Keystore 的不可导出 AES-GCM 密钥加密后保存在应用私有存储；局域网共享凭证同样加密保存；邮箱不作连接认证。局域网首次连接在发送配对码之前核对桌面 TLS 证书指纹。云端经 Hub/Cloudflare 转发，并非端到端加密。应用卸载或清除数据将丢失设备私钥，需要重新登记和绑定。
