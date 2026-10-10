# ZSense

## Computer Use

Computer Use 支持 macOS 与 Windows，默认关闭。开启位置为“设置 → 工具与 MCP”，开启后仍需操作系统的屏幕录制和输入控制权限。屏幕截图只作为当前 Agent Loop 的临时多模态输入，不写入数据库或运行日志；查看屏幕与控制鼠标键盘分别执行低频审批。

ZSense 是一个本地优先的多 Bot 桌面 Agent 工作台。应用内置自己的 Agent Core、消息网关、记忆、技能、定时任务、语音交互和文件工作区，不需要安装或启动外部 Agent Runtime。

## 已实现能力

- 多 Bot：每个 Bot 独立身份、模型、长期记忆、会话、工作区和机器人账号。
- AI 对话：不依附 Bot 的独立对话空间，同样支持长期记忆与工作区。
- 对话列表：会话支持拖拽排序（按住会话拖动，落点会出现蓝色指示线，也可以直接跨分组拖动），也支持分组折叠收纳——在「AI 对话」标题右侧点分组按钮新建分组，把会话拖到分组标题上就收进去，点标题折叠 / 展开；分组可改名、可删除（删除只解散分组，不会删会话）。顺序、分组与折叠状态都保存在本地数据库，重启后保持。
- 快捷指令：输入「/」打开斜杠指令。一级菜单只有内置操作和四个分类，具体名字收在二级：`/bot <Bot 名> <指令>`、`/skill <技能名>`、`/plugin <插件命令>`、`/prompt <模板名>`（总结、翻译、润色等 60 多个模板，旧的 `/翻译 内容` 写法仍然可用）。例如 `/bot Atlas 帮我统计昨天的会话数` 回车后，指令交给 Atlas 执行，消息和它的回复都显示在当前对话里（不切换对话），执行时用 Atlas 自己的模型、记忆和技能。
- 模型管理：OpenAI、OpenRouter、Anthropic、Gemini、DeepSeek、智谱 GLM、Kimi、Nous 和自定义 OpenAI 兼容接口；通过供应商官方 `/models` 接口同步可用模型。
- Agent 工具循环：完整工作区文件操作、终端与后台进程、网页提取、隔离浏览器、Office 文档工具、钉钉能力工具、技能按需加载和交互式澄清。
- 开发工作流：修改前自动 Checkpoint、可恢复 Rollback、历史 Session Search、项目上下文文件和 `@file` / `@dir` / `@url` / `@git-diff` 引用。
- 工具扩展：按 Toolset 管理工具，支持 stdio / Streamable HTTP MCP、本地可信插件、模型与工具 Hooks 以及 Tool Search。
- 自主运行：Todo、Goal、Loop 和 Heartbeat 持久化到独立数据空间，应用重启后自动恢复；后台危险操作不会绕过用户审批。
- 记忆：按当前问题相关性召回，成功回合后自动提取，按间隔后台复盘，支持相似记忆合并、容量限制、人工查看、编辑与删除。
- 技能：所有 Bot 共用同一安装目录；每项技能可以单独指定允许使用的 Bot。支持创建、编辑、导入、删除和从仓库检查更新。
- 消息网关：Telegram、Discord、Slack、钉钉、飞书、企业微信、微信 iLink 和 Webhook；一个机器人账号固定绑定一个 Bot，未知用户必须先授权。钉钉没有“正在输入”接口，收到消息后改为在你那条消息上贴 🤔Thinking、回复完成后撤回并换成 🥳Done（与 Hermes 的处理方式一致），不再发“已接收，正在思考”这类中间消息；另外配置 AI 卡片模板 ID 后会改用卡片流式展示处理过程。
- 网关守护：随 ZSense 启动和退出，每 30 秒检测健康状态，断线后自动重建。
- 设备互联：同一局域网内的 ZSense 自动发现、输入配对码后建立受信任连接；可以在设置里逐台开启“允许对方读取本机状态”和“允许对方在本机执行任务”，远程任务在本机 AI 对话空间中留痕，且不能代替本机用户批准敏感操作。
- 软件更新：默认检查官方 GitHub Release，在应用内下载新安装包、显示速度与进度；暂停保留缓存并支持断点续传，取消清理缓存，完成后核对 SHA-256；macOS 可替换并重启应用，Windows 在应用退出后启动安装向导。自定义更新源仍支持 `latest-mac.yml` / `latest.yml` / JSON，但无法验证官方安装包时须手动安装。
- 语音：可自定义唤醒词并通过录入向导测试；STT 使用内置 whisper.cpp Base Q5 多语言模型，TTS 使用轻量 MeloTTS 固定中文音色，均在本地执行且跨 macOS/Windows，无需额外下载语音组件。
- 定时任务：独立工作区、固定模型和技能，任务对话不进入普通会话列表，可在运行历史查看、复制和删除；AI 对话和 Bot 对话里直接说“每天/每周定时做某事”，Agent 会用 `scheduled_task` 工具创建和管理同一份定时任务数据（需逐次确认），不会去改系统的 launchd 或 cron。每个任务在卡片上都有一个眼睛按钮，可以单独开关「是否在总览页展示」；总览页只列打开开关的任务，全部关掉时整块不显示。
- 文件侧栏：HTML 可视化编辑，以及 Excel 本地共享会话、手动保存和 Agent 实时读取/修改。
- 本地安全：账号登录态、系统安全存储中的 API Key、敏感信息脱敏、重大操作逐次审批和本机 SQLite 数据库。Agent 固定为完全访问（可读写任意本机路径、访问本机与局域网地址），但删除、工作区外写入、安装发布和外部提交仍会逐次确认；可在“设置 → 工具与 MCP”开启“自动审批（模型判断）”，由模型先判断这类操作是否放行，判断为拒绝或不可用时仍然弹窗，并保留最近判断记录。

## 架构

```text
React UI
   │ IPC
Electron 主进程
   ├─ ZSense Agent Core 0.4
   ├─ Capability / MCP / Plugin Services
   ├─ Autonomy Runner
   ├─ ZSense Native Gateway
   ├─ ZSense Voice Service
   ├─ Memory Intelligence
   ├─ Shared Skill Registry
   ├─ Scheduled Task Runner
   ├─ Office Workspace Service
   └─ SQLite + Secrets Vault
```

应用内对话、外部渠道消息和定时任务最终都进入同一个 `ZSenseAgentCore.chatStream()`，因此模型、工具、记忆、技能、上下文压缩、脱敏和运行记录行为保持一致。

旧版数据库中的历史会话标识会在升级时复制到新的 `external_thread_id` / `external_message_id` 字段。旧字段只为读取既有数据而保留，不会触发任何外部 Runtime。

## 本地开发

要求 Node.js 24；最终用户安装桌面应用时不需要单独安装 Node.js。

```bash
npm install
npm run desktop:dev
```

仅启动浏览器预览：

```bash
npm run dev
```

浏览器预览没有 Electron 本地能力，完整功能请使用 `npm run desktop:dev`。

## 检查与构建

```bash
npm run typecheck
npm test            # 并行跑完全部 44 个测试（约 25 秒）
npm run bench:efficiency   # 任务执行效率基准：请求体量、数据库读取、启动耗时
npm run build
npm run desktop:verify     # 打包应用目录并自检包内内容
npm run desktop:build:mac
npm run tools:prepare:win
npm run tools:verify:win
npm run desktop:build:win
```

macOS 与 Windows 产物都位于 `release/`。Windows NSIS 安装包必须在原生 Windows x64 环境构建；在 macOS 上执行 `desktop:build:win` 会直接停止，避免产生归档完整却启动即崩溃的交叉构建包。Windows 安装包内置固定版本并经过 SHA-256 校验的 OfficeCLI、dws、kdocs-cli、Whisper Base Q5、MeloTTS、原生语音引擎及 VC++ 离线运行库；安装时不下载 Python、Node.js、Git 或单独 Runtime。GitHub Actions 构建后会在真正的 Windows x64 环境中安装产物，再上传供发布使用。

单项测试仍可单独运行，例如 `npm run test:agent-core`、`npm run test:gateway`；完整清单见 `package.json` 的 `test:*` 脚本。任务执行效率的度量方法与基线数字见 `docs/efficiency.md`。

## 本地数据

桌面数据保存在 Electron 的 `userData` 目录：

```text
<userData>/zsense.sqlite
<userData>/agent-core/
├─ skills/
├─ plugins/
├─ mcp/servers.json
├─ capabilities/
│  ├─ state.json
│  └─ checkpoints/
├─ toolchain/
└─ gateway/
   ├─ authorization.json
   └─ workspaces/
```

API Key 由操作系统安全存储保护，不写入普通数据库、日志、技能目录或安装包。卸载或更新应用不会主动删除用户数据库与工作区。
