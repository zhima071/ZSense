# ZSense 开发交接

本文件给“换账号 / 换会话”后的继任者看：不需要历史对话，读完这一份就能继续开发。更新日期：2026-09-19（当前版本 0.25.4，`release/` 里已有 0.25.4 的 dmg / zip / exe）。

## 1. 仓库现状

- 目录：`/Volumes/out1/ZSense`，分支 `main`，版本 `0.25.4`，`package.json` 里的 `productName` 是 `ZSense`，`appId` 是 `ai.zsense.studio`。标签：`0.24.0`、`0.25.0`、`0.25.1`、`0.25.2`、`0.25.3`、`0.25.4`。
- 本地 `release/mac-arm64/ZSense.app` 是**可以直接双击运行**的完整应用包（`npm run desktop:pack` 生成），每次改完代码都要重新生成；`release/ZSense-0.25.3-mac-arm64.{dmg,zip}` 与 `release/ZSense-0.25.3-win-x64.exe` 是 0.25.3 的安装包，出包与自检流程见 `docs/desktop.md` 的「打包与校验」。⚠️ 安装包只对应打标签时的代码：0.25.4 已包含「/Bot 名」快捷指令、钉钉表情已读、总览卡片改动、对话分组拖拽，以及「总览无定时任务时隐藏整块区块」「定时任务逐个的总览展示开关」（用户要求沿用同一版本号多次重新出包，标签 `0.25.4` 已指向最后一次打包的提交 `c41b6a5`；`release/` 里的三份 0.25.4 安装包都是覆盖更新的）；之后再改代码只更新应用目录，**不出安装包**，要出包先升版本号（用户要求时才做）。
- **代码只在本机**：GitHub 上的 `zhima071/ZSense`（私有）与 `zhima071/ChuanhuChatGPT`（旧 fork）已按用户要求删除，`git remote -v` 里的 `origin` 指向已失效地址（推送只会 404、不会误传）。删除前的完整备份在 `/Users/hank/Desktop/ZSense-完整备份-20260919-1810.bundle`（`git bundle create --all`，629 MB，可完整恢复）。
- `release/`、`dist/`、`node_modules/` 已被 `.gitignore` 忽略；`bundled-tools/`（约 1.3 GB 的 officecli / dws / kdocs-cli / whisper / MOSS-TTS / VC++ 运行库）**故意没有进版本库**，由 `npm run tools:prepare:win` 或安装包构建流程准备。
- 用户明确要求：**不要 reset、不要 clean、不要覆盖未提交改动**；每次改完代码都要重新生成 `release/mac-arm64/ZSense.app`；**安装包只在用户明确要求时打**（0.25.3 是用户点名要的）。改动按功能分批提交并打标签，界面文案 / 注释 / 文档一律中文。

## 2. 常用命令

```bash
npm install            # 依赖（已安装）
npm run desktop:dev    # 开发运行（Electron，完整能力）
npm run typecheck      # TypeScript 检查
npm run build          # tsc -b + vite build → dist/
npm run desktop:pack        # 重新生成 release/mac-arm64/ZSense.app（不产出安装包）
npm run verify:packaged     # 自检包内关键实现文件与界面文案是否齐全
npm run desktop:verify      # 上面两步连着跑
npm test                    # 并行跑完全部 44 个测试（约 25 秒；串行用 test:serial）
npm run bench:efficiency    # 任务执行效率基准（加 --quick 是快速模式）
npm run desktop:build:mac   # 产出 .dmg + .zip（仅在用户明确要求时）
npm run desktop:build:win   # 产出 .exe（NSIS，含 Windows 离线工具链）
```

测试按 `package.json` 里的 `test:*` 脚本执行；纯 Node 冒烟测试可以直接跑，`test:canvas`、`test:computer-use`、`test:configuration-transfer` 会通过 `scripts/run-electron.mjs` 启动真实 Electron。

## 3. 环境坑（踩过的）

1. **`ELECTRON_RUN_AS_NODE=1`**：如果父进程自己跑在 Electron 里（例如从桌面应用内启动命令），子进程会继承这个变量，Electron 退化成纯 Node，GUI 冒烟测试会报 `The requested module 'electron' does not provide an export named 'clipboard'`。`scripts/run-electron.mjs` 已经主动删除该变量；自己写启动脚本时也要注意。
2. **`test:computer-use` 需要权限**：未授予 macOS 屏幕录制 / 辅助功能权限时会卡在等待授权；这是环境问题，不是测试失败。
3. **GUI 冒烟测试必须自己退出**：Electron 应用不会自动结束，脚本末尾要调用 `app.quit()`（`zsense-canvas-smoke.mjs` 已补上），否则批量跑测试会卡住。
4. **macOS 没有 `timeout` 命令**（除非装了 coreutils 的 `gtimeout`），写脚本时别用。
5. **并发跑测试会抢同一个 userData 目录**：多个测试同时启动 Electron 时可能互相干扰，串行执行更稳。
6. **偶发空输出失败**：连续快速用 `npm run --silent test:xxx` 跑同一个纯 Node 冒烟测试时，偶发出现“无任何输出、退出码 1”（npm 自身启动异常的表现）。直接用 `node scripts/xxx-smoke.mjs` 连跑 5 次全部通过，遇到空输出失败先重跑一次再判断。

## 4. 测试现状

- `npm test` 并行跑完全部 **45 个测试**（约 26 秒，串行约 70 秒）；其中 `test:chat-cards`（对话卡片三态）、`test:bot-slash`（「/Bot 名」快捷指令：目录生成、命令名去重、`/Bot名 指令` 解析、两个输入框接线）、`test:web-bridge`（局域网 Web 访问：HTTPS、http 308 跳转、Secure Cookie、剪贴板通道）、`test:efficiency`（效率回归）、`test:device-link`（按 IP 直连 + 主动扫描）、`test:scheduled-display`（卡片网格 + 浮动详情面板）是这一轮新增的重点回归。
- 纯 Node 冒烟测试覆盖技能管理、官方技能更新、Agent Core、MCP、自治任务等；旧插件测试已随插件运行时移除。
- 真实 Electron：`test:configuration-transfer`、`test:canvas` 已实测通过；`test:computer-use` 需要系统授权。

## 5. 本次开发完成的内容（2026-09-18）

| 项 | 内容 | 关键文件 |
| --- | --- | --- | 
| 修复 | **对话卡片三处问题**：审批弹窗说明“自动审批为什么没放行”且自动审批改为默认开启（审批员提示词新增“用户自己点名要做的对外发送/定时动作判 allow”）；选择卡把草稿与已提交状态放到组件外按请求 ID 保存，切换会话不再丢内容，运行结束/取消时主进程补发 `clarify-expired`，卡片改为“已失效”提示；计划卡新增服务端按轮次推动（第 3 轮无卡提醒、连续 4 轮未更新提醒）并要求第 1 轮就建卡。回归见 `test:chat-cards` 与 agent-core/agent-capabilities 新用例。 | `src/components/ChatClarificationCard.tsx`、`electron/services/zsense-agent-core.mjs`、`electron/services/agent-capability-service.mjs`、`electron/services/database.mjs`、`scripts/chat-cards-smoke.mjs` |
| 功能 | **Web 访问的 HTTPS 与剪贴板**：默认 HTTPS（自签证书自动生成/按局域网地址变化重签，http 端口 308 跳转）；复制统一走 `src/services/clipboard.ts`（桌面 → 应用剪贴板通道，网页 → 访问者自己的剪贴板；Electron 的权限处理器只放行 `media`，直接调 `navigator.clipboard` 会被拒——“Write permission denied”就是这么来的）。 | `electron/services/web-bridge-service.mjs`、`src/services/clipboard.ts`、`src/components/WebAccessPanel.tsx` |
| 功能 | **局域网 Web 访问**：浏览器打开 `http://<局域网地址>:39073` 即可使用完整界面（口令登录、SSE 事件、与桌面同一批 IPC 处理器）。`electron/services/web-bridge-service.mjs` + `electron/web-bridge-client.js`；设置入口在「设备互联 → 浏览器访问」；回归见 `test:web-bridge`。注意：桥接的 `window.zsenseDesktop` 不能用 `inspect`/`then` 之类的名字占用真实接口名（曾因此让 `runtime.inspect` 被顶掉，界面停在首启向导）。 | `electron/services/web-bridge-service.mjs`、`electron/web-bridge-client.js`、`electron/main.mjs`、`electron/ipc.mjs`、`src/components/WebAccessPanel.tsx` |
| 功能 | **总览页展示定时任务**：与「我的 Bots」同款卡片（复用 `overview-bot-card` 版面 + 悬停浮层），显示名称/频率/状态/下次运行与累计运行、成功次数、模型、工作区；展示口径与定时任务页共用 `src/services/scheduled-task-format.ts`。 | `src/components/Overview.tsx`、`src/services/scheduled-task-format.ts` |
| 功能 | **自动发现的触发条件**：只有三种——用户开启设备互联时（`start({ scan: true })`）、打开设备互联界面时（面板挂载调 `refresh()`）、手动（图标按钮或 `list_devices { scan: true }`）。没有后台轮询；应用启动恢复已启用状态时不扫描。 | `electron/services/device-link-service.mjs`、`scripts/device-link-smoke.mjs` |
| 功能 | **主动扫描发现设备**：`scan()`（组播/广播 probe + 对局域网 /24 逐台 `GET /v1/status` 单播探测，并发 48、900ms 超时、3 秒冷却），对端收到 probe 后单播回公告；界面「扫描局域网」按钮与 `list_devices { scan: true }` 都走这条路径。解决“路由器隔离组播导致一直搜不到设备”的问题（实测在组播完全收不到广告的网络里 5.7 秒找到对端 Windows 设备）。 | `electron/services/device-link-service.mjs`、`electron/services/agent-capability-service.mjs`、`src/components/DeviceLinkSettingsPanel.tsx`、`scripts/device-link-smoke.mjs` |
| 功能 | **配对即可读对端内容**：新增 `POST /v1/data`（scope：overview/bots/conversations/conversation/skills/memories/scheduledTasks/settings/directory/file），用共享密钥认证、只接受局域网来源；凭据类字段通过 `redactDeviceSecrets` 隐藏；文件读取上限 2MB。读取不再需要对方开开关（`allowStatus` 只保留字段兼容），写操作（`run_task_on_device`）仍按设备授权 + 本机确认。提供者抽到 `electron/services/device-data-service.mjs`，Agent 工具为 `read_device_data`。 | `electron/services/device-link-service.mjs`、`electron/services/device-data-service.mjs`、`electron/services/agent-capability-service.mjs`、`scripts/device-link-smoke.mjs` |
| 功能 | **设备接入对话**：设备互联快照注入系统提示词（本机地址端口、已配对设备与授权、未配对的发现设备），新增 `devices` 工具集四个工具：`list_devices` / `read_device_status` / `run_task_on_device`（需审批）/ `pair_device`（需审批）；工具集对老安装的已保存清单也默认启用。已验证：真实会话里 Agent 读出对方 Windows 设备的版本、运行时长与各项数量统计。 | `electron/services/agent-capability-service.mjs`、`electron/services/zsense-agent-core.mjs`、`electron/main.mjs`、`electron/ipc.mjs`、`scripts/agent-capabilities-smoke.mjs`、`scripts/zsense-agent-core-smoke.mjs` |
| 功能 | **设备互联按 IP 直连**：组播被路由器隔离（访客网络 / AP 隔离 / 跨网段）时，可按「对方地址 + 端口 + 配对码」直接配对，走单播 HTTP；HTTP 端口默认固定 `39072` 并持久化，占用时回退随机端口。面板新增「搜不到对方？按 IP 直连」区块并显示本机地址与端口；`test:device-link` 新增直连配对、错误配对码/非法地址拒绝、端口稳定与重启保持一致等断言。 | `electron/services/device-link-service.mjs`、`electron/ipc.mjs`、`electron/preload.cjs`、`src/components/DeviceLinkSettingsPanel.tsx`、`scripts/device-link-smoke.mjs` |
| 文档 | **效率方法论与基线**：`docs/efficiency.md`（怎么量、四个杠杆、已落地/已否决清单、回归保护）；可重复测量脚本 `npm run bench:efficiency` | `docs/efficiency.md`、`scripts/efficiency-bench.mjs` |
| 优化 | **执行效率体检**：热点查询加表达式索引（messages(conversation_id, datetime(created_at)) 等）、`loadSettings()/loadGatewayConnections()/loadBotIds()` 轻量读取替代整库快照（实测 0.1ms vs 28.8ms）、流式增量按 60ms 合并 + 跳过无变化的会话进度更新、收尾轮空内容自动重试一次、已结束运行只保留末尾 8 步游标；新增 `npm test` 并行测试入口（42 个测试 24s，串行 36s）与 `test:efficiency` 回归。 | `electron/services/database.mjs`、`src/utils/stream-delta-buffer.ts`、`scripts/run-all-tests.mjs`、`scripts/efficiency-smoke.mjs` |
| 优化 | **并行执行**：并行机制本来就在（同轮多个只读工具并发执行、子 Agent 默认 3 并发），但模型不会用。现在系统提示词新增「并行执行规则」（先规划→互不依赖的同轮一起发/一次发多个 delegate_task；写同一文件或有依赖的必须串行；派发后用一次 delegate_status 等待），`delegate_task` 描述也说明了可以一轮并发派发。`test:subagents` 新增计时断言：3 条支线并行总耗时 < 700ms（串行会是 ~900ms） | `electron/services/zsense-agent-core.mjs`、`electron/services/agent-capability-service.mjs`、`scripts/subagent-service-smoke.mjs` |
| UI | **定时任务改成紧凑卡片网格 + 浮动详情面板**：整行大卡换成 `repeat(auto-fill, minmax(268px, 1fr))` 的矩形小卡（约 273×132，一行两张），只显示图标、状态、名称、频率、下次运行与「立即运行」；点卡片用 `createPortal` 挂到 `document.body` 开 760×496 浮动面板（任务内容 / 运行配置 / 最近一次运行 + 立即运行、编辑、暂停、打开工作区、删除、查看完整对话），✕ / 遮罩 / Esc 关闭；同时删掉列表底部 330px 的空白占位。 | `src/components/ScheduledTasksPage.tsx`、`src/styles.css`、`scripts/scheduled-task-display-smoke.mjs` |
| UI | **设置导航**：「技能管理」「工具与 MCP」「浏览器」分别独立显示。技能页只保留 SKILL.md 的创建、导入、分配、编辑与更新。 | `src/components/SystemPages.tsx`、`src/components/SkillsPage.tsx`、`src/styles.css` |
| 修复 | **Web 访问地址优先显示局域网地址**：服务端 `urls` 不再返回 `127.0.0.1`（本机地址单独用 `localUrl` 返回），面板把局域网 https 地址放首位、复制按钮复制的就是它——之前复制到的是 `127.0.0.1`，在别的设备上打不开。 | `electron/services/web-bridge-service.mjs`、`src/components/WebAccessPanel.tsx` |
| 功能 | **斜杠指令分类 + 「/bot 名字 指令」在当前对话里执行**：一级菜单保留内置操作与 `/bot`、`/skill`、`/prompt` 三个分类；`/bot Atlas 指令` 在当前会话委派给 Atlas，使用被委派 Bot 的模型、记忆和技能；旧写法 `/Atlas 指令`、`/翻译 文本` 仍可用。回归：`test:bot-slash`。 | `src/components/slash-command-catalog.ts`、`src/components/ChatDialog.tsx`、`src/components/NativeChatPage.tsx`、`scripts/bot-slash-command-smoke.mjs` |
| 修复 | **钉钉不再发“已接收，正在思考”，改成 Hermes 那样的表情已读**：钉钉没有“正在输入”接口（Hermes 的适配器原话是 DingTalk does not support typing indicators），Hermes 的做法是给用户那条消息贴表情——开始 🤔Thinking、完成撤回 🤔 再贴 🥳Done。新增 `createDingTalkEmotionController`（`POST /v1.0/robot/emotion/reply|recall`，`emotionType: 2`、内置表情 `emotionId 2659900`、`backgroundId im_bg_1`，与 Hermes 同参数），收消息时立刻贴 🤔，`reply()` 完成后换 🥳、`fail()` 只撤回；`status()` 在没有 AI 卡片时不再发消息（有卡片则继续写卡片）。表情失败（未开权限等）只打警告，不影响对话。回归：`test:gateway` 新增 `dingTalkEmotion` 用例。 | `electron/services/zsense-gateway-service.mjs`、`scripts/zsense-gateway-smoke.mjs` |
| UI | **总览定时任务卡片：内容行换成「工作区 + 模型」，并加启用/暂停按钮**：卡片不再显示任务内容（一行 prompt 截断、信息量低），改显示工作区（`folderLabel`）与模型（`task.model`，未指定时显示「默认模型」，title 里带供应商）；「下次运行」行右侧新增图标按钮（已启用显示 ⏸ 暂停、已暂停显示 ▶ 启用，`aria-label` 说明具体任务），点按钮走 `event.stopPropagation()` 不跳转，因此卡片外层从 `<button>` 改成 `role="button"` 的 `div`（按钮不能嵌套）并保留 Enter/Space 键位与焦点样式；回调 `onToggleTask` 接 App 的 `toggleScheduledTask`（`zsense:tasks:toggle`，成功后提示「定时任务已暂停 / 已继续」）。展开区底部蓝条的「工作区」文字原来沿用卡片正文的深灰 `--muted`，在蓝底上看不清，已改成白色（`.overview-bot-footer .overview-task-workspace { color: #fff }`）。回归：`test:scheduled-display` 新增卡片内容、按钮行为与白色文字断言。 | `src/components/Overview.tsx`、`src/styles.css`、`src/App.tsx`、`scripts/scheduled-task-display-smoke.mjs` |
| 优化 | **总览卡片点击直接开该任务的详情浮层**：把定时任务页里的悬浮详情面板抽成共用组件 `src/components/ScheduledTaskDetailPanel.tsx`（定时任务页与总览页同一份实现，内容/状态/按钮完全一致；Esc 关闭也放进组件里，两处都生效），总览卡片点击不再跳到定时任务页，而是就地打开这个任务的详情浮层（立即运行 / 编辑任务 / 暂停任务 / 打开工作区 / 删除任务 / 查看完整对话都在里面）；「编辑任务」因为要开表单，走 `pendingEditTaskId` 跳到定时任务页并自动打开该任务的编辑窗口（`editingTaskId` + `onEditingTaskHandled`）。回归：`test:scheduled-display` 增加“两处复用同一组件 / 总览卡片开面板不跳页 / Esc 与遮罩关闭”断言。 | `src/components/ScheduledTaskDetailPanel.tsx`、`src/components/ScheduledTasksPage.tsx`、`src/components/Overview.tsx`、`src/App.tsx`、`scripts/scheduled-task-display-smoke.mjs` |
| 功能 | **对话列表：拖拽排序 + 分组折叠收纳**：会话新增 `sort_order`（0 = 未手动排过，仍按最近更新排前）与 `group_id` 两列，新增 `conversation_groups` 表（id/bot_id/name/sort_order/collapsed），schema 版本 40 → 41；数据库方法 `createConversationGroup/renameConversationGroup/deleteConversationGroup/setConversationGroupCollapsed/moveConversationToGroup/reorderConversations`（删除分组只解散、跨对话空间移动会被拒），快照新增 `conversationGroups`；IPC `zsense:conversations:move-group|reorder` 与 `zsense:conversation-groups:create|rename|delete|set-collapsed`，preload 与 `electron.d.ts` 同步。侧边栏用原生 HTML5 拖拽（state 记录被拖项，不依赖 dataTransfer）：拖到会话上按上/下半区插入前后、拖到分组标题收进分组、拖到未分组区移出；分组标题可折叠（aria-expanded）并带改名/删除按钮。回归：`test:conversation-groups`（排序持久化、分组增删改折叠、重启保持、跨空间守卫、接线断言）。 | `electron/services/database.mjs`、`electron/ipc.mjs`、`electron/preload.cjs`、`src/types.ts`、`src/electron.d.ts`、`src/components/Sidebar.tsx`、`src/App.tsx`、`src/styles.css`、`scripts/conversation-groups-smoke.mjs` |
| 功能 | **对话列表：拖拽排序 + 分组折叠收纳**：会话新增 `sort_order`（0 = 未手动排过，仍按最近更新排前）与 `group_id` 两列，新增 `conversation_groups` 表（id/bot_id/name/sort_order/collapsed），schema 版本 40 → 41；数据库方法 `createConversationGroup/renameConversationGroup/deleteConversationGroup/setConversationGroupCollapsed/moveConversationToGroup/reorderConversations`（删除分组只解散、跨对话空间移动会被拒），快照新增 `conversationGroups`；IPC `zsense:conversations:move-group|reorder` 与 `zsense:conversation-groups:create|rename|delete|set-collapsed`，preload 与 `electron.d.ts` 同步。侧边栏用原生 HTML5 拖拽（state 记录被拖项，不依赖 dataTransfer）：拖到会话上按上/下半区插入前后、拖到分组标题收进分组、拖到未分组区移出；分组标题可折叠（aria-expanded）并带改名/删除按钮。回归：`test:conversation-groups`（排序持久化、分组增删改折叠、重启保持、跨空间守卫、接线断言）。 | `electron/services/database.mjs`、`electron/ipc.mjs`、`electron/preload.cjs`、`src/types.ts`、`src/electron.d.ts`、`src/components/Sidebar.tsx`、`src/App.tsx`、`src/styles.css`、`scripts/conversation-groups-smoke.mjs` |
| 功能 | **定时任务「是否在总览展示」开关**：`scheduled_tasks` 新增 `show_on_overview`（`INTEGER NOT NULL DEFAULT 1`，schema 41 内追加列，老任务默认展示），`scheduledTaskFromRow` 输出 `showOnOverview`，新增 `setScheduledTaskOverviewVisibility(id, visible)`（不改 `enabled`，任务照常运行）；IPC `zsense:tasks:set-overview-visibility` + preload `tasks.setOverviewVisibility` + `electron.d.ts`。定时任务页每张卡片右侧新增眼睛快捷按钮（Eye / EyeOff、`aria-pressed`、忙碌态），共用详情浮层也加了「在总览页显示 / 不在总览页显示」按钮；App 侧 `setScheduledTaskOverviewVisibility` 统一处理并提示。总览页改用 `overviewTasks = scheduledTasks.filter(task => task.showOnOverview !== false)`，区块与计数都按可见任务渲染（全部关掉时整块不显示）。回归：`test:scheduled-display` 增加默认值、持久化、不影响 enabled、过滤与按钮接线断言。 | `electron/services/database.mjs`、`electron/ipc.mjs`、`electron/preload.cjs`、`src/types.ts`、`src/electron.d.ts`、`src/components/ScheduledTasksPage.tsx`、`src/components/ScheduledTaskDetailPanel.tsx`、`src/components/Overview.tsx`、`src/App.tsx`、`scripts/scheduled-task-display-smoke.mjs` |
| 修复 | **主进程 `write EPIPE` 未捕获异常（会弹「A JavaScript error occurred in the main process」）**：从终端启动应用时，启动它的父进程/会话结束后 stdout 管道就断了，之后任何 `console.*` 都会抛 `write EPIPE`；`dingtalk-stream` 的心跳定时器正好在里面 `console.error('TERMINATE SOCKET…')`，于是变成主进程未捕获异常并弹崩溃对话框（本次用户遇到的就是它）。新增 `electron/services/safe-console.mjs`（`installSafeConsole()`：给 stdout/stderr 挂 `error` 监听 + 包一层 console，管道类错误静默忽略、其它错误照常抛出），在 `electron/main.mjs` 的 import 之后立刻安装；回归 `test:safe-console`（EPIPE 被吞、其它错误仍抛、error 监听已装、真实 process 上 emit error 不抛）。⚠️ 排障经验：用 Hermes/终端后台启动应用时要重定向日志（`>> /tmp/zsense-app.log 2>&1`），文件句柄不会随会话结束而断，否则就会造出这个 EPIPE 场景。 | `electron/services/safe-console.mjs`、`electron/main.mjs`、`scripts/safe-console-smoke.mjs`、`package.json` |
| 发布 | **0.25.3 出包并对产物自检**：版本号 0.25.2 → 0.25.3（`package.json` / `package-lock.json` 同步），产出 `release/ZSense-0.25.3-mac-arm64.{dmg,zip}` 与 `release/ZSense-0.25.3-win-x64.exe`；新增 `scripts/verify-packaged-app.mjs`（`npm run verify:packaged`）核对包内关键文件与界面文案，dmg 校验和 VALID、挂载后版本 0.25.3、三份产物 `app.asar` 的 SHA-256 完全一致、`test:windows-installer` 返回 `{"ok":true}`。校验 asar 中文文案必须用 Buffer 搜索，`grep -a -o` 会漏匹配（见 `docs/desktop.md`「打包与校验」）。 | `scripts/verify-packaged-app.mjs`、`package.json`、`docs/desktop.md` |
| --- | --- | --- |
| 功能 | **模型自动审批**：设置 → 工具与 MCP → 审批与自动放行里新增开关（默认关闭）。开启后 `requestApproval` 会先调用 `ZsensAgentCore.decideAutoApproval()`（用当前对话的模型，严格 JSON、20s 超时），`allow: true` 才跳过弹窗并写入审计；拒绝/超时/格式错误/无 Key 一律回退人工确认。始终禁止的操作无法被绕过。开关状态走 `settings.autoApprovalEnabled`（IPC 校验 + 默认关闭），审计在 `capabilities/state.json` 的 `autoApprovals`，设置页可查看最近 10 条 | `electron/services/zsense-agent-core.mjs`、`electron/services/agent-capability-service.mjs`、`src/components/SystemPages.tsx`、`scripts/{agent-capabilities,zsense-agent-core}-smoke.mjs` |
| --- | --- | --- |
| 变更 | **取消“完全访问 / 受限访问”开关，只保留完全访问**：Agent 始终可以读写本机任意路径（含桌面等），终端命令不再因为“工作区之外”被拒绝；`read_spreadsheet` / `edit_spreadsheet_cells` / `save_spreadsheet` / `read_text_file` / `read_pdf` 也接受工作区之外的绝对路径，因此工作区外的 Excel 能直接用共享表格会话处理。安全网保留：工作区外的写入与删除、安装发布、外部提交仍逐次审批（`filesystem:external-write`、`terminal:external-path-write` 等），`sudo`/磁盘根目录/用户主目录等仍被硬拒绝，后台入口无审批界面时一律拒绝工作区外写入。设置页与输入栏的访问范围开关、`unrestrictedAgentAccess` 设置字段已删除 | `electron/services/agent-capability-service.mjs`、`electron/services/zsense-agent-core.mjs`、`electron/services/browser-automation-service.mjs`、`src/components/{ChatComposerToolbar,SystemPages,ChatDialog,NativeChatPage}.tsx`、`src/{App,types}.ts(x)`、`electron/ipc.mjs`、`electron/services/database.mjs` |
| 历史记录 | 曾用第 12/24/36 轮提醒和 80 轮硬上限防止简单任务跑过长；当前实现已移除固定硬上限，改为进展检测和非终止性提醒，详情见 `docs/architecture.md`。 | `electron/services/zsense-agent-core.mjs`、`scripts/zsense-agent-core-smoke.mjs` |
| 修复 | **弹窗打开时侧栏仍露出会话“…”按钮**：`.conversation-actions` 自带 `z-index:6 + isolation:isolate`，确认弹窗原来渲染在它内部，遮罩被关在这个小层叠上下文里，后面几行的按钮同层且 DOM 更靠后 → 画在遮罩之上。改成用 React Portal 把弹窗挂到 `document.body`（会话重命名/删除、消息删除、Bot 删除三处），弹窗回到根层叠上下文后遮罩正常覆盖全部按钮 | `src/components/ConversationActions.tsx`、`ChatMessageMeta.tsx`、`BotActionsMenu.tsx`、`scripts/dialog-overlay-smoke.mjs` |
| 修复 | **“让 Agent 创建定时任务，面板里看不到”**：Agent 以前没有定时任务工具，只能自己写 launchd / 工作区脚本（所以应用里什么都没有）。现在新增 `scheduled_task` 工具（autonomy 工具集），创建/修改/启停/立即运行/删除都写同一份 `scheduled_tasks` 数据并推送工作区快照，面板立即出现；参数先校验再审批，模型与工作区默认沿用当前会话；后台入口无审批界面时直接拒绝 | `electron/services/agent-capability-service.mjs`、`electron/main.mjs`、`scripts/scheduled-task-tool-smoke.mjs` |
| UI | 左侧栏“执行中”的会话：整行圆角边框做成紫→蓝→青的**流动炫光**（`@property` 注册角度变量 + conic-gradient 边框 + 遮罩后的模糊外发光层），Bot 工作区“最近对话”里的执行中行同样处理；此前版本在行内左侧加的白色圆圈已删除 | `src/styles.css`（`@property --zsense-run-border-angle`、`zsense-run-border-spin`、`.is-running`）、`src/components/Sidebar.tsx` |
| B2 | `run-electron.mjs` 清理 `ELECTRON_RUN_AS_NODE`，恢复 GUI 测试；canvas 冒烟测试补 `app.quit()` | `scripts/run-electron.mjs`、`scripts/zsense-canvas-smoke.mjs` |
| A1 | 删除“SSE（预留兼容）”假开关：设置里改成只读的“事件接收方式”，同时移除 `eventProtocol` 字段（类型 / 默认值 / 校验 / UI） | `src/components/SystemPages.tsx`、`src/types.ts`、`src/App.tsx`、`electron/ipc.mjs`、`electron/services/database.mjs` |
| A3 | 删除死通道 `zsense:channels:update` 及其校验函数、`database.updateChannel`；`preload` 与 `ipc` 通道数现在都是 156 且完全一致 | `electron/ipc.mjs`、`electron/services/database.mjs` |
| C1 | 应用内更新：`UpdateService` 检查官方 Release 和自定义清单；官方包在应用内显示速度与进度，暂停保留缓存并支持重启后 Range 续传，取消清理缓存，完成后校验 SHA-256；macOS 自动替换并重启，Windows 启动安装向导；自定义源若不满足官方校验条件则手动安装 | `electron/services/update-service.mjs`、`electron/services/update-install-service.mjs`、`electron/ipc.mjs`、`electron/preload.cjs`、`src/components/SystemPages.tsx`、`src/types.ts`、`src/electron.d.ts` |
| A4 | 补 5 个零覆盖模块的冒烟测试 | `scripts/memory-intelligence-smoke.mjs`、`scripts/pdf-parser-smoke.mjs`、`scripts/secrets-vault-smoke.mjs`、`scripts/update-service-smoke.mjs`、`scripts/device-task-runner-smoke.mjs` |
| A2 | 设备互联从“只能连上”变成“能用”：互相读取状态 + 通过对方执行任务 | `electron/services/device-link-service.mjs`、`electron/services/device-task-runner.mjs`、`electron/main.mjs`、`src/components/DeviceLinkSettingsPanel.tsx`、`scripts/device-link-smoke.mjs` |

### 设备互联协议（新增部分）

- `POST /v1/inspect`：需要接收方对请求设备开启“允许对方读取本机状态”。返回本机 `device`（由服务自己填）、`app`（版本 / 启动时间 / 运行时长）、`activity`（Bot、会话、记忆、定时任务、技能数量）、`capabilities`，以及请求方在对方设备上的 `access` 权限。
- `POST /v1/run`：需要接收方开启“允许对方在本机执行任务”。`DeviceTaskRunner` 在本机 AI 对话空间创建 `channel_id='device-link'` 的会话，用本机默认模型、默认工作区、共享技能调用 `ZSenseAgentCore.chatStream()`；请求与回复都写进该会话，方便留痕。
- 安全边界：仅私网地址、配对共享密钥鉴权、同一设备同时只允许一条远程任务、默认权限全关；传给 Core 的 `approvalHandler` 直接拒绝一切需要审批/澄清的操作并计入 `refusedOperations`，所以终端写操作、删除、工作区外访问都不会因为“来自已配对设备”被放行。
- 权限开关状态存在 `<userData>/agent-core/device-link/state.json` 的 `trustedPeers[].access`。

## 6. 数据库与数据目录

- 数据库：`<userData>/zsense.sqlite`，schema 版本 31（旧字段保留只读兼容）。
- Agent 数据：`<userData>/agent-core/`（`skills/`、`mcp/servers.json`、`capabilities/`、`toolchain/`、`gateway/`、`device-link/`）。历史 `plugins/` 数据不会主动删除，也不会被执行。
- 新增 `channels` 记录 `device-link`（名称“设备互联”），远程任务会话使用它；`GatewayPage` 已把它从平台连接器下拉里排除。
- Web 访问（局域网浏览器访问）：状态在 `<userData>/agent-core/web-bridge/state.json`（`enabled` / `port`，默认 39073，另有 39074 负责 http → https 跳转），自签证书在 `<userData>/agent-core/web-bridge/tls/{cert,key}.pem` 与 `meta.json`（局域网地址变化时自动重签）。
- 密钥：`<userData>/zsense-secrets.json`，由系统安全存储加密（macOS 钥匙串 / Windows DPAPI），文件权限 0600，界面与 SQLite 只保存“是否已配置”。

## 7. 还没做 / 建议下一步

1. **远程任务的进阶用法**：目前只走本机默认模型与 AI 对话空间；如果要“让对方的某个 Bot 执行”，需要给 `/v1/run` 增加目标 Bot 与工作区参数，并在接收端做 Bot 级授权。
2. **设备间文件传输**：现在只有状态与任务，没有文件/会话互传。
3. **自动下载安装**：`UpdateService` 只提示版本并打开下载页；macOS 侧目前是 adhoc 签名（没有 Developer ID），做静默自动更新前需要先解决签名与公证。
4. **SSE 真实现**：如果以后真的需要 SSE 事件流（当前各渠道都用官方长连接 SDK），要先设计协议再开放设置项，别再出现“能选但不生效”的假开关。
5. **`bundled-tools` 的版本管理**：1.3 GB 二进制不在版本库里，靠 `tools:prepare:win` 拉取；如果希望可复现，建议记录版本清单文件而不是提交二进制。
6. **提交历史**：0.24.0 的整体改动按“核心服务 / 桌面 UI / 资源 / 测试脚本 / 文档”分批提交；0.25.x 起每个功能点一次提交并打标签，继续按同一粒度提交，避免再次积累上百个未提交文件。
7. **重新配对 Windows 设备**：`<userData>/agent-core/device-link/state.json` 里的 `trustedPeers` 目前为空，需要在「设置 → 设备互联」用「扫描局域网」找到对端（李焕芝，`192.168.3.5:39072`）后输入 6 位配对码；配对后即可读对端内容（读取不需要对方开开关，写操作仍要授权 + 本机确认）。
8. **仓库只在本机**：两个 GitHub 仓库都已删除，`origin` 已失效。以后要上传：新建仓库 → `git remote set-url origin <新地址>` → `git push`（标签另行 `git push --tags`）；也可以先 `git remote remove origin` 清掉死地址，不影响本地使用。
9. **自签证书的可信化**：局域网 Web 访问用的是本机自签证书，浏览器首次会提示“不是私密连接”（点“高级 → 继续前往”即可）。如果要免提示，需要导入系统信任或换正式证书。

## 8. 交接检查清单

- [x] `npm run typecheck` 通过
- [x] `npm test` 44 个测试全部通过（并行约 25 秒）
- [x] `release/mac-arm64/ZSense.app` 已重新生成到 0.25.3，且 `npm run verify:packaged` 返回 `{"ok":true}`
- [x] 0.25.3 安装包已产出（dmg / zip / exe）：dmg 校验和 VALID、挂载后版本号 0.25.3、三份产物 `app.asar` SHA-256 一致、`test:windows-installer` 通过
- [x] README、`docs/architecture.md`、`docs/desktop.md`、`docs/efficiency.md` 已同步新能力


## 远程连接与设备号（独立签名交换中心）

- **域名**：`hub.zsense.space` 是独立中心；设备地址为 `https://<中心分配设备号>.zsense.space`。
- **交换中心**：独立仓库 `/Volumes/out1/zsense-hub`。首次注册由中心分配设备号并绑定 Ed25519 公钥；注册、25 秒心跳、更新上游、下线和撤销都签署 60 秒一次性挑战。
- **设备端自动化**：`device-link-service` 建立出站 Tunnel；隧道退出立即签名下线并退避重连。中心机只提交 `local://web-bridge` 标记，真实 `127.0.0.1:39073` 必须由中心受控配置指定。
- **安全边界**：首次公网配对使用临时配对码，后续免密进入优先用已配对设备私钥签署短时随机数、时间和路由，一次请求换取单次入场票据；旧版设备回退到公钥挑战双请求。远程通道不依赖本机安全锁；网页登录在安全锁关闭时必须使用另设的远程访问密码，未设置则拒绝。关闭安全锁只撤销旧网页会话；关闭远程连接或互联总开关才会下线设备。
- **加密边界**：Cloudflare 与交换中心可以看到解密后的代理内容，因此不是端到端加密。
