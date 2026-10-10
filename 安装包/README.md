# ZSense 安装包

- `当前/`：本次可分发的 macOS DMG/ZIP、Windows 安装程序、Android 正式签名 APK，以及 `SHA256SUMS` 校验值。只在这里取最新包。
- `历史版本/`：后续重复构建时可暂存旧包；此前本地历史包、调试包及故障备份已按要求清理（2026-10-10）。当前不保留旧版本作为回退包。

正在运行的 Mac 开发应用仍位于 `release/mac-arm64/ZSense.app`，不能在运行时挪走。旧 `release-*` 目录和 Windows 解包测试副本已清理；后续生成的构建工作目录不作为取安装包的位置。

以后在本机执行 `desktop:build:mac` 或 `desktop:build:win` 时，构建脚本会自动把新安装包归到 `当前/`，同名旧包移入 `历史版本/`。Android 执行 `:app:assembleRelease` 后，运行 `npm run packages:collect:android` 即可归档 APK。CI 构建保持原输出路径，不影响现有发布工作流。
