# ZSense 桌面端

## 开发运行

```bash
npm install
npm run desktop:dev
```

完整的登录、SQLite、系统安全存储、文件选择、消息网关、语音和 Office 侧栏只在 Electron 桌面端可用。`npm run dev` 只用于快速检查界面。

## macOS 构建

```bash
npm run desktop:build:mac
```

命令依次运行 TypeScript 检查、Vite 构建和 electron-builder，输出 `.dmg` 与 `.zip` 到 `release/`。安装包内含 Electron/Node 运行环境和 ZSense Agent Core，最终用户不需要安装开发环境。

macOS 包从 `bundled-tools/darwin-${arch}` 携带当前架构的 `officecli`、`dws` 与 `kdocs-cli`。首次启动会把它们部署到 `<userData>/agent-core/toolchain/bin`，不会修改系统 PATH，也不会复用 WorkBuddy 或系统中已有的同名工具。

## Windows 构建

Windows x64 使用固定版本、带 SHA-256 校验的完整离线资源包。首次准备资源后，Mac 可以交叉生成 NSIS 安装包；发布前仍由 GitHub Actions 的 Windows x64 构建机实际执行 Office、语音和工具测试。

```bash
npm run tools:prepare:win
npm run tools:verify:win
npm run desktop:build:win
```

`tools:prepare:win` 获取 OfficeCLI、dws、kdocs-cli、whisper.cpp CPU 版和 Microsoft VC++ 离线运行库。可通过 `ZSENSE_WINDOWS_TOOLS_MIRROR` 指向国内对象存储镜像，通过 `ZSENSE_WINDOWS_ASSET_CACHE` 复用已校验的下载缓存。最终安装时不会访问网络。

Windows 安装前检查包括：

- Windows 10 / 11；
- x64 处理器；
- 至少 3 GB 可用空间；
- `%APPDATA%\ZSense` 可写；
- 当前是否有 ZSense 实例需要安全关闭。

安装器不下载 Python、Node.js、Git 或单独 Agent Runtime。Electron 自带应用所需的 Node 运行环境；本地语音需要的 Microsoft VC++ 运行库随安装包静默安装。OfficeCLI、dws、kdocs-cli、Whisper 模型和 MOSS-TTS 模型全部位于安装包中。

## 首次启动

首次进入应用时必须：

1. 创建本机管理员账号和密码；
2. 选择默认全局工作区；
3. 保存至少一个模型供应商与模型 ID。

登录态加密保存在本机。正常关闭并再次打开会恢复登录；只有主动退出登录后才需要重新输入账号密码。

在“设置 → 语音交互”可以直接输入自定义唤醒词，或打开录入向导说出并测试唤醒词。唤醒和主动语音交流统一使用内置本地语音链路，不读取模型密钥，也不要求配置 OpenAI Audio API。

本地 STT 使用随安装包部署的 whisper.cpp base 多语言模型，本地 TTS 使用 MOSS-TTS-Nano ONNX 模型。音频不会上传到语音服务。

## Agent Core 生命周期

Agent Core 是 Electron 主进程中的 JavaScript 模块，不是单独守护进程，因此随应用自然启动和退出。消息网关与语音服务由主进程显式管理：

- 打开应用后启动在线 Bot 的已启用连接；
- 每 30 秒执行连接健康检查；
- 连接异常时停止并重建对应实例；
- Bot 暂停、连接停用、退出登录或应用退出时释放资源；
- 定时任务在主进程启动后恢复，应用退出前等待当前安全收尾。
- Goal、Loop 和 Heartbeat 在主进程启动后从本地状态恢复；无变化的 Heartbeat 保持静默。

“设置 → 核心服务”显示 Core、Gateway、Voice、数据目录和巡检状态。诊断只检查 ZSense 自己的组件。

“设置 → 工具与 MCP”用于配置 MCP 服务器、导入或重载本地插件，并查看和管理 Goal、Loop、Heartbeat。插件是主进程可信代码，导入前必须确认来源；OAuth Token 与模型密钥一样进入系统安全存储。

“设置 → 设备互联”用于在同一局域网内发现并配对其他 ZSense 设备。

**浏览器访问（局域网 Web UI）**：在同一页面下方可以打开「浏览器访问」。开启后会显示形如 `http://192.168.3.14:39073` 的地址与 6 位访问口令；局域网内的手机、平板或另一台电脑用浏览器打开该地址、输入口令，就能使用**与桌面窗口一致的完整界面**（对话、Bot、定时任务、设置等）。实现方式：静态资源仍是构建产物 `dist/`，页面里注入一层桥接脚本，把界面发出的调用转发给主进程里同一批 IPC 处理器（参数校验与错误格式完全一致）；事件通过 SSE 推回浏览器。只接受局域网来源，账号与安全类管理动作（新建/修改用户、改安全锁密码）仍然只能在桌面窗口里做；可以在面板里查看已登录的浏览器并逐个让它们退出，换口令会让所有网页会话失效。默认端口 `39073`（被占用时回退随机端口），并在 `39074` 上开一个只做跳转的 http 端口（老地址 http://… 会自动跳到 https）。**默认启用 HTTPS**：首次开启时用 `openssl` 生成本机自签证书（SAN 覆盖当前所有局域网地址与 localhost，存于数据目录的 `web-bridge/tls/`；局域网地址变化会自动重签）。浏览器首次访问会提示“不是私密连接”，点“高级 → 继续前往”即可；接受后页面才是**安全上下文**，剪贴板、麦克风这类能力才可用。面板里会显示证书指纹与有效期。

复制按钮在任何一端都可用：桌面窗口走应用自带的剪贴板通道（`zsense:clipboard:write-text`，Electron 的权限策略会拒绝 `navigator.clipboard`），浏览器里则写进**访问者自己设备**的剪贴板（HTTPS 提供安全上下文，并要求页面处于聚焦状态 —— 这是浏览器规则）。

自动发现先走 UDP 组播（`239.255.90.71:39071`）。**部分路由器会隔离设备之间的组播**——访客网络、AP 隔离、两台设备接在不同的路由/网段（例如一台在光猫下、一台在路由器下）都会让发现列表一直是空的。扫描**只在三种情况下触发**：开启设备互联时、每次打开这个界面时、以及点右上角的刷新图标（或让 Agent 调 `list_devices { scan: true }`）。不做后台轮询；应用启动时若设备互联本来就是开着的，不会扫描。仍然搜不到时，用面板里的**「搜不到对方？按 IP 直连」**：填对方设备的局域网地址、端口（默认 `39072`，面板“本机设备”一行能看到自己的地址与端口）和对方屏幕上显示的 6 位配对码即可完成配对，后续心跳、状态读取与远程任务全部走单播，不依赖组播。设备互联的 HTTP 端口默认固定为 `39072`，端口被占用时才会回退到随机端口（这时按界面上显示的端口填写）。配对成功后可以按设备开启“允许对方读取本机状态”和“允许对方在本机执行任务”；配对好的设备在对话里同样可见：AI 会用 `list_devices` 列出设备、用 `read_device_data` **直接读取对方的内容**（运行状态、Bot、会话列表、某个会话的完整对话、技能、记忆、定时任务、设置、目录与文件；凭据类字段对方会自动隐藏），需要在那台机器上真实执行操作时用 `run_task_on_device`（对方需开启“允许执行任务”，且每次都需要本机确认）。远程任务在接收方以 `channel_id='device-link'` 的 AI 对话形式留痕，涉及审批的操作一律拒绝，不会因为请求来自已配对设备而绕过本机用户。

“设置 → 核心服务”中的“软件更新”默认从公开的 GitHub Releases 检查版本。官方 Release 正文中的 SHA-256 与对应附件匹配时，应用会在自己的数据目录下载安装包、显示速度与进度；暂停保留缓存并使用 HTTP Range 断点续传，取消清理未完成缓存，并在安装前再次校验。macOS 应用位于可写目录时，更新助手会等待旧应用退出后替换同一位置的 `.app` 并重新打开；Windows 更新助手会在旧应用退出后启动 NSIS 安装向导。安装失败时原安装包及 `updates/install-版本.log` 保留以便排查。自定义 `latest-mac.yml` / `latest.yml` / JSON 更新源仍可检查版本，但未满足官方包校验条件时只提供手动安装。GitHub Release 仍只上传 macOS DMG、Windows EXE、Android APK 三种安装包，发布前可运行 `node scripts/publish-github-release.mjs --repo=zhima071/ZSense` 校验，确认后加 `--publish` 发布新版本；已有同版本 Release 不覆盖。

## 模型与密钥

“设置 → AI 模型”通过供应商官方模型接口同步当前账号可用的模型，然后保存供应商、模型 ID、Base URL 和上下文长度。API Key 进入系统安全存储，界面与 SQLite 只保存“是否已配置”。

Bot 可以固定使用任意已保存模型；未固定时使用全局默认模型。对话输入区可以在已保存模型之间快速切换，切换结果持久化到当前会话。

## 本地数据与备份

主要目录：

```text
<userData>/
├─ zsense.sqlite
├─ agent-core/
│  ├─ skills/
│  ├─ plugins/
│  ├─ mcp/servers.json
│  ├─ capabilities/state.json
│  ├─ capabilities/checkpoints/
│  ├─ toolchain/bin/
│  └─ gateway/
└─ scheduled-task-workspaces/
```

备份时应完全退出 ZSense，再复制整个 `userData`。普通应用更新不会覆盖会话、记忆、技能、网关授权或用户工作区。

## 发布前检查

```bash
npm run typecheck
npm run test:auth
npm run test:first-run
npm run test:bots
npm run test:conversation
npm run test:memory-skills
npm run test:settings-native
npm run test:scheduled-display
npm run test:office
npm run test:runtime
npm run tools:verify:win
npm run test:windows-tools
npm run test:windows-installer
npm run test:chat
npm run test:voice-wake
npm run test:voice-conversation
npm run test:voice
npm run test:agent-core
npm run test:capabilities
npm run test:mcp
npm run test:plugins
npm run test:autonomy
npm run test:device-link
npm run test:device-task-runner
npm run test:memory-intelligence
npm run test:pdf-parser
npm run test:secrets-vault
npm run test:update-service
npm run test:independence
npm run build
```

`test:configuration-transfer`、`test:canvas`、`test:computer-use` 与 `icon:generate` 通过 `scripts/run-electron.mjs` 启动真实 Electron；父进程如果自己运行在 Electron 内（例如从桌面应用里执行），脚本会主动清掉继承来的 `ELECTRON_RUN_AS_NODE`，否则 Electron 会退化成纯 Node 并报 `electron does not provide an export named 'clipboard'`。`test:computer-use` 需要 macOS 的屏幕录制与辅助功能权限，未授权时会等待系统授权而超时，属于环境问题而不是测试失败。

打包后还要确认应用资源中不存在 `hermes-runtime` 目录或旧 Agent 适配器文件，并对 `win-unpacked/resources/bundled-tools` 再执行一次完整清单校验。

## 打包与校验

macOS 与 Windows 产物都从同一份源码构建，版本号取 `package.json`：

```bash
npm run desktop:build:mac   # → release/ZSense-<版本>-mac-arm64.dmg 与 .zip
npm run desktop:build:win   # → release/ZSense-<版本>-win-x64.exe（NSIS，内置离线工具链）
```

出包后要自检，不能只看「命令没报错」：

1. **应用目录**：`npm run verify:packaged`（等价于 `desktop:pack` 后再跑 `scripts/verify-packaged-app.mjs`），确认 `release/mac-arm64/ZSense.app` 里关键实现文件与界面文案都在。新增功能时应把对应的文件名或不会被压缩改名的标记加进该脚本的清单。
2. **安装包本体**：`hdiutil verify release/ZSense-<版本>-mac-arm64.dmg` 须输出 `checksum ... is VALID`；挂载后用 `/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" <挂载点>/ZSense.app/Contents/Info.plist` 核对版本号与 `package.json` 一致。
3. **三份产物内容一致**：分别计算 `release/mac-arm64/ZSense.app/Contents/Resources/app.asar`、`unzip -p release/ZSense-<版本>-mac-arm64.zip ZSense.app/Contents/Resources/app.asar`、以及 dmg 挂载后同名文件的 SHA-256，三者必须相同。
4. **Windows 端**：`npm run test:windows-installer` 应返回 `{"ok":true,...}`，并用 `file release/ZSense-<版本>-win-x64.exe` 确认是 `PE32 ... Nullsoft Installer`。

校验 asar 内容请用 `scripts/verify-packaged-app.mjs` 的 Buffer 搜索方式，**不要用 `grep -a -o` 配中文关键词**：BSD grep 对多字节模式会漏匹配，会得出「安装包里没有新界面」的错误结论（asar 内的中文是原样 UTF-8，并非 `\uXXXX` 转义）。

`package.json` 的版本号变更会触发下次启动时重新解压 `bundled-tools`，因此只在正式出包时才升版本号。
