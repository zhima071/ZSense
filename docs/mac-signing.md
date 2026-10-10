# macOS 固定代码签名

本机开发更新和正式发布都使用固定代码签名身份，不再静默沿用 Electron linker 签名或改成 ad-hoc。应用和 helper ID 固定为 `ai.zsense.studio` 和 `ai.zsense.studio.helper`（GPU、Renderer、Plugin 使用对应后缀）。

## 本机配置

本机配置保存在用户目录，不进入仓库：

`~/Library/Application Support/ZSense Development/mac-signing.json`

```json
{
  "version": 1,
  "identitySha1": "专用代码签名证书的40位SHA1指纹",
  "keychainPath": "/Users/用户名/Library/Keychains/login.keychain-db"
}
```

证书公钥路径可以额外存入 `certificatePath` 供人工检查，但构建不读取私钥文件；私钥只由 macOS 钥匙串中的 `/usr/bin/codesign` 使用。首次创建、导入私钥和限定 `codeSign` 信任必须经用户明确批准。不要创建 SSL/全用途信任，不要用 `security import -A` 对所有应用开放私钥。

允许通过 `ZSENSE_MAC_SIGN_IDENTITY_SHA1` 和 `ZSENSE_MAC_SIGN_KEYCHAIN` 切换到预先安装的正式 Developer ID Application 身份。切换签名证书属于应用身份变化，需单独安排权限迁移和真实验收；环境变量不能指定 `-` 或只有证书名称的模糊身份。

## 构建与验收

`node scripts/desktop-build.mjs --dir --config.directories.output=/绝对路径/临时构建目录`

构建开始前检查固定指纹是否是目标钥匙串中有效的代码签名身份。缺失、失效、未获 `codeSign` 信任时立即失败，不使用替代证书、不自动创建新身份、不降级 ad-hoc。可接受的 CLI 配置覆盖仅为输出目录和 Electron runtime 路径，不能绕过签名 hook 或更换 app/helper ID。

维护中的 `@electron/osx-sign` 签名器按嵌套深度签名，最后签顶层应用；`--deep` 只用于只读验证，不用于签名。非 Mach-O 媒体资源不单独签名，但受顶层资源封印保护。验证检查全部 Mach-O/应用/framework 的证书 leaf SHA1、稳定 designated requirement，以及 `codesign --verify --deep --strict` 的内容完整性。helper 必须齐全并保持预期身份，外部或递归符号链接会失败。

原生 TTS 可执行文件和 dylib 嵌入固定证书签名后，文件大小和 SHA256 会改变。签名前仍以官方原始摘要严格验证；签后只在打包副本中更新 TTS 清单，保存 `originalFiles`（原始可信摘要）和 `packaging`（固定证书身份），再单独重签顶层应用封印，不重新改动已签原生文件。原始 native 文件仍比对固定官方大小/摘要，许可证仍比对官方摘要，第三方声明比对确定性生成的摘要；完整文件清单必须匹配可信目录。Melo、Whisper、许可证和三个语音清单的签前字节都不得被签名流程改动。签名转换版只有在固定身份、全部嵌套签名和顶层资源封印验证通过后才能被包验收接受；来源目录的官方文件和摘要不改动，运行时完整性检查不放松。

本机自签身份 `ZSense Local Code Signing` 保持此前未启用 hardened runtime 的运行策略，使用空 entitlement 文件，不新增禁用 library validation 等宽松 entitlement，不关闭 Gatekeeper、SIP、TCC 或钥匙串保护。正式 Developer ID 身份启用 hardened runtime、默认 Electron entitlements 和时间戳；正式公证仍需单独提供 Apple 账号或公证凭据并完成发布验收，本机自签不等于 Developer ID/公证。

```sh
node scripts/mac-signing-regression.mjs
node scripts/mac-signed-voice-regression.mjs
node scripts/mac-verify-signing.mjs /绝对路径/ZSense.app
```

第一次从旧 ad-hoc 身份迁移仍可能需要用户重新确认钥匙串或录屏授权。用户应在系统设置对当前应用授予权限，然后正常退出并重新打开应用。不能编辑 TCC 数据库、重置所有权限、降低指定要求或恢复旧签名来绕过授权；代码层的权限检查只能停止重复请求，不能替代系统授予真实权限。

“显示 → 全局截图”提供只读的“检测权限”和显式“重新申请权限”。后者只在用户点击时，从主进程调用 Apple 的 `CGRequestScreenCaptureAccess()`，每次应用启动最多一次；不捕获屏幕、不在启动或状态检测时申请，已拒绝时仍由系统决定是否弹窗，不能绕过拒绝。授权组件是应用内固定路径的 N-API 模块，和其他嵌套代码一起固定签名。源码位于 `native/mac-screen-permission.c`；macOS 构建使用本机 Xcode 命令行工具和已安装 Node 的官方开发头编译，用户运行时不下载组件。系统仍未授权时，所有自动截图保持阻止。

官方依据：[Electron Code Signing](https://www.electronjs.org/docs/latest/tutorial/code-signing)、[Apple TN2206](https://developer.apple.com/library/archive/technotes/tn2206/_index.html)、[Electron systemPreferences](https://www.electronjs.org/docs/latest/api/system-preferences)。

## 屏幕录制授权桥接

`native/mac-screen-permission.c` 只导出 `requestScreenCapturePermission()`，调用系统官方 `CGRequestScreenCaptureAccess()` 并返回布尔值。加载模块不会申请权限、预检权限或捕获任何屏幕内容。调用者必须在 Electron 主进程主线程中由显式用户操作触发；它不读取、重置或修改 TCC，也不能绕过用户拒绝。Apple 的 SDK 文档明确：尚未决定时会提示用户，之前拒绝过的进程不会再次提示，须用户在系统设置的隐私与安全中开启屏幕录制权限。

macOS 构建在打包和固定身份签名之前，以本机已安装的官方 Node N-API 头和 Apple SDK 编译，使用稳定的 N-API 8；不下载运行时组件，不手写 ABI。源码生成到 `bundled-tools/darwin-arm64/screen-permission.node` 或 `bundled-tools/darwin-x64/screen-permission.node`，随既有资源规则复制到应用固定 `Contents/Resources/bundled-tools/screen-permission.node`，由现有 Mach-O 签名遍历签名和验证。运行时应只从该固定 bundle 路径加载，不接受 cwd、环境变量或外部路径覆盖。

```sh
node scripts/build-mac-screen-permission.mjs --arch=arm64
node scripts/mac-screen-permission-regression.mjs
```

回归测试只在隔离临时目录编译并验证 Node / Electron 的模块导出类型，绝不调用权限函数。首次申请、拒绝后重新开启以及重复截图仍需真实应用中的用户授权验收。官方接口：[CGRequestScreenCaptureAccess](https://developer.apple.com/documentation/coregraphics/cgrequestscreencaptureaccess())；详细授权语义也见 Apple SDK `CoreGraphics/CGWindow.h`。
