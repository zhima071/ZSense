# ZSense 安装包

- `当前/`：本次可分发的 macOS DMG/ZIP、Windows 安装程序、Android 正式签名 APK，以及 `SHA256SUMS` 校验值。只在这里取最新包。
- `历史版本/`：以前生成的安装包，保留用于回退；调试签名的 Android APK 也在这里，不应当作为正式安装包使用。

正在运行的 Mac 开发应用仍位于 `release/mac-arm64/ZSense.app`，不能在运行时挪走。其他 `release*` 目录是 Electron 构建工作目录，不再作为取安装包的位置。

以后在本机执行 `desktop:build:mac` 或 `desktop:build:win` 时，构建脚本会自动把新安装包归到 `当前/`，同名旧包移入 `历史版本/`。Android 执行 `:app:assembleRelease` 后，运行 `npm run packages:collect:android` 即可归档 APK。CI 构建保持原输出路径，不影响现有发布工作流。
