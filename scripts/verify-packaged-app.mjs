#!/usr/bin/env node
// 校验打包后的 app.asar 内容是否包含当前源码的功能，用于每次出包后的自检。
//
// 用法：
//   node scripts/verify-packaged-app.mjs                       # 默认检查 release/mac-arm64/ZSense.app
//   node scripts/verify-packaged-app.mjs <app.asar 路径>        # 检查指定产物（zip / dmg 里解出来的也行）
//
// 注意：asar 里的中文是原样 UTF-8（不是 \uXXXX 转义），而且必须用 Buffer 搜索——
// 用 grep -a -o 配多字节中文会漏匹配，曾据此误判过「安装包里没有新界面」。
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { verifyVoiceBundle, voiceFileEntries } from './voice-assets.mjs'
import { requireMacSigningIdentity } from './mac-signing.mjs'

const defaultAsar = path.join('release', 'mac-arm64', 'ZSense.app', 'Contents', 'Resources', 'app.asar')
const asarPath = process.argv[2] ?? defaultAsar

if (!fs.existsSync(asarPath)) {
  console.error(`找不到打包产物：${asarPath}`)
  process.exit(1)
}

const buffer = fs.readFileSync(asarPath)

function countOccurrences(needle) {
  const target = Buffer.from(needle, 'utf8')
  let hits = 0
  let index = buffer.indexOf(target)
  while (index !== -1) {
    hits += 1
    index = buffer.indexOf(target, index + target.length)
  }
  return hits
}

function readAsarEntries() {
  const headerSize = buffer.readUInt32LE(12)
  const header = JSON.parse(buffer.subarray(16, 16 + headerSize).toString('utf8').replace(/\0+$/, ''))
  const walk = (node, prefix, out) => {
    for (const [name, entry] of Object.entries(node.files ?? {})) {
      const full = prefix ? `${prefix}/${name}` : name
      if (entry.files) walk(entry, full, out)
      else out.push(full)
    }
    return out
  }
  return walk(header, '', [])
}

const packedFiles = readAsarEntries()

const requiredRuntimePackages = [
  '@larksuiteoapi/node-sdk', '@slack/socket-mode', '@slack/web-api', '@wecom/aibot-node-sdk',
  'dingtalk-stream', 'discord.js', 'grammy', 'opencc-js', 'selfsigned', 'unpdf',
  '@xmldom/xmldom',
]
const rendererOnlyPackages = ['@univerjs/preset-sheets-core', '@univerjs/presets', 'react', 'react-dom', 'react-markdown']
const packageEntry = (name) => `node_modules/${name}/package.json`
const missingRuntimePackages = requiredRuntimePackages.filter((name) => !packedFiles.includes(packageEntry(name)))
const duplicatedRendererPackages = rendererOnlyPackages.filter((name) => packedFiles.includes(packageEntry(name)))

// 关键文件：新增能力对应的实现文件，缺一个就说明包是旧的
const requiredFiles = [
  'electron/services/web-bridge-service.mjs',
  'electron/services/device-data-service.mjs',
  'electron/web-bridge-client.js',
  'electron/services/update-service.mjs',
  'electron/services/update-install-service.mjs',
  'electron/services/update-install-mac.sh',
  'electron/services/update-install-win.ps1',
  'electron/services/zsense-agent-core.mjs',
  'electron/services/agent-loop-runtime.mjs',
  'electron/services/agent-task-scheduler.mjs',
  'electron/services/agent-write-locks.mjs',
  'electron/services/agent-clarification-queue.mjs',
  'electron/services/office-command-runner.mjs',
  'electron/services/office-word-edit.mjs',
  'electron/services/presentation-workspace.mjs',
  'electron/services/device-link-service.mjs',
  'electron/services/remote-trust-connect.mjs',
  'electron/services/scheduled-task-runner.mjs',
  'electron/services/local-memory-service.mjs',
  'electron/services/memory-scope.mjs',
  'electron/services/memory-intelligence.mjs',
  'electron/services/memory-upgrade-service.mjs',
  'electron/services/global-screenshot-service.mjs',
  'electron/services/zsense-voice-service.mjs',
  'electron/global-screenshot-preload.cjs',
  'electron/global-screenshot.html',
  'electron/global-screenshot-ui.js',
  'dist/index.html',
]

// 关键文案与代码标记：界面文案用中文原文，主进程标记用不会被压缩改名的大写常量或 IPC 通道
const requiredMarkers = [
  ['输入框中文听写按钮', 'chat-dictation-button'],
  ['听写快捷键持久化设置', 'chatDictationShortcut'],
  ['自定义聊天听写快捷键入口', '设置聊天听写快捷键，当前'],
  ['双栏图标导航', 'sidebar-rail-layout'],
  ['最左侧 Bot 快捷头像', 'sidebar-bot-rail-list'],
  ['可折叠会话侧栏', 'sidebar-panel'],
  ['侧栏顶部账号名称', 'sidebar-account-name'],
  ['可拖动会话列表分隔线', 'sidebar-resize-handle'],
  ['会话列表宽度记忆', 'zsense-sidebar-panel-width-v1'],
  ['回复分支到新聊天', '分支到新聊天'],
  ['回复分支保存通道', 'zsense:conversations:fork-message'],
  ['自动多 Agent 任务卡', 'agent-task-plan'],
  ['会话右键管理菜单', 'conversation-context-menu'],
  ['对话预览书签按钮', 'chat-jump-bookmark'],
  ['消息书签保存通道', 'zsense:conversations:bookmark-message'],
  ['定时任务界面', '定时任务'],
  ['模型精炼默认可选设置', 'memoryModelRefinement'],
  ['独立后台技能沉淀设置', 'autoDistillSkills'],
  ['记忆增量事件', 'zsense:workspace:memory-changed'],
  ['旧设备一次性本地记忆整理', 'local-memory-quality-v1'],
  ['启动期本地记忆升级接线', 'await new MemoryUpgradeService({ database }).run()'],
  ['记忆可信归属迁移', 'legacy-unattributed'],
  ['迟到回合记忆世代检查', 'captureRetentionGeneration'],
  ['局域网访问界面', '局域网访问'],
  ['设备互联界面', '设备互联'],
  ['技能管理设置', '技能管理'],
  ['本机地址文案', '本机地址'],
  ['自签证书文案', '自签证书'],
  ['局域网扫描按钮', '立即扫描局域网'],
  ['Web 访问默认端口', 'DEFAULT_WEB_BRIDGE_PORT'],
  ['Web 访问 IPC 通道', 'zsense:web-bridge'],
  ['设备数据服务', 'device-data-service'],
  ['远程快速签名入口', 'zsense-trust-v2'],
  ['并行执行规则', '并行执行规则'],
  ['五路子 Agent 并行上限', 'MAX_CONCURRENT_SUBAGENTS = 5'],
  ['无进展保护', '连续 3 轮执行了相同工具并得到相同结果'],
  ['Bot 快捷指令', 'Bot 指令'],
  ['Bot 快捷指令分类', '/bot <Bot 名> <指令>'],
  ['Bot 委派字段', 'delegateBotId'],
  ['Bot 委派标记', '/bot 指令'],
  ['钉钉表情已读', '/v1.0/robot/emotion/'],
  ['钉钉表情名称', '🤔Thinking'],
  ['设备数据工具', 'read_device_data'],
  ['全局截图入口', 'zsense:global-screenshot:start'],
  ['截图图标工具栏', 'class="editor-actions"'],
  ['截图悬停提示', 'id="button-tooltip"'],
  ['原生中文语音合成入口', 'zsense:voice:synthesize-local'],
  ['轻量中文播报', 'MeloTTS 中文'],
  ['量化语音识别模型', 'ggml-base-q5_1.bin'],
]

const missingFiles = requiredFiles.filter((file) => !packedFiles.includes(file))
const missingMarkers = requiredMarkers.filter(([, marker]) => countOccurrences(marker) === 0)
const obsoleteSpeechFiles = packedFiles.filter((file) => /(?:^|\/)moss-tts(?:\/|$)/.test(file))
const obsoleteSpeechMarkers = ['zsense:voice:tts-config', 'zsense-tts://'].filter((marker) => countOccurrences(marker) > 0)

for (const file of requiredFiles) {
  console.log(`${missingFiles.includes(file) ? '❌' : '✅'} 文件 ${file}`)
}
for (const [label, marker] of requiredMarkers) {
  const hits = countOccurrences(marker)
  console.log(`${hits === 0 ? '❌' : '✅'} ${label}（${marker}：${hits} 处）`)
}

for (const name of requiredRuntimePackages) console.log(`${missingRuntimePackages.includes(name) ? '❌' : '✅'} 运行时依赖 ${name}`)
for (const name of rendererOnlyPackages) console.log(`${duplicatedRendererPackages.includes(name) ? '❌' : '✅'} 前端依赖未重复打包 ${name}`)

let localeCheck = { checked: false, locales: [], missing: [], unexpected: [] }
let localMemoryCheck = { checked: false, noDownloader: true }
let voiceCheck = { checked: false, ok: true }
const resourcesDirectory = path.dirname(path.resolve(asarPath))
const macPackaged = path.resolve(asarPath).endsWith(`${path.sep}Contents${path.sep}Resources${path.sep}app.asar`)
const winPackaged = path.basename(resourcesDirectory).toLowerCase() === 'resources' && !macPackaged
if (macPackaged || winPackaged) {
  const toolsDirectory = path.join(resourcesDirectory, 'bundled-tools')
  const platformKey = macPackaged ? 'darwin-arm64' : 'win32-x64'
  try {
    if (macPackaged) {
      const permissionModulePath = path.join(toolsDirectory, 'screen-permission.node')
      if (!fs.existsSync(permissionModulePath) || !fs.lstatSync(permissionModulePath).isFile() || fs.lstatSync(permissionModulePath).isSymbolicLink()) throw new Error('Missing packaged macOS screen permission module')
    }
    const obsoleteResources = ['tts/moss', 'stt/ggml-base.bin'].filter((file) => fs.existsSync(path.join(toolsDirectory, file)))
    const signedMacAppPath = macPackaged ? path.dirname(path.dirname(resourcesDirectory)) : undefined
    const ttsManifest = JSON.parse(fs.readFileSync(path.join(toolsDirectory, 'tts', 'manifest.json'), 'utf8'))
    const signedMacVoice = macPackaged && ttsManifest.packaging !== undefined
    const verified = verifyVoiceBundle({ platformKey, rootPath: toolsDirectory, meloRootPath: path.join(toolsDirectory, 'tts', 'melo'), ...(signedMacVoice ? { macSigningIdentity: requireMacSigningIdentity(), macSignedAppPath: signedMacAppPath } : {}) })
    const speechBytes = ['stt', 'tts'].reduce((sum, directory) => sum + voiceFileEntries(path.join(toolsDirectory, directory)).reduce((total, file) => total + file.size, 0), 0)
    const sizeLimitBytes = 400 * 1024 * 1024
    voiceCheck = { checked: true, ok: obsoleteResources.length === 0 && speechBytes <= sizeLimitBytes, platformKey, ...verified, speechBytes, sizeLimitBytes, obsoleteResources }
    console.log(`${voiceCheck.ok ? '✅' : '❌'} 离线语音资源完整且无旧模型，体积 ${(speechBytes / 1024 / 1024).toFixed(1)} MB（上限 400 MB）`)
  } catch (error) {
    voiceCheck = { checked: true, ok: false, platformKey, error: error.message }
    console.log(`❌ 离线语音资源校验失败：${error.message}`)
  }
}
const macAppMarker = `${path.sep}Contents${path.sep}Resources${path.sep}app.asar`
if (path.resolve(asarPath).endsWith(macAppMarker)) {
  const appContents = path.dirname(path.dirname(path.resolve(asarPath)))
  const uvPath = path.join(appContents, 'Resources', 'bundled-tools', 'uv')
  localMemoryCheck = { checked: true, noDownloader: !fs.existsSync(uvPath) && !packedFiles.includes('node_modules/@vectorize-io/hindsight-client/package.json') }
  console.log(`${localMemoryCheck.noDownloader ? '✅' : '❌'} 本地记忆无需额外下载器`)
  const localeRoot = path.join(appContents, 'Frameworks', 'Electron Framework.framework', 'Versions', 'A', 'Resources')
  const locales = fs.existsSync(localeRoot)
    ? fs.readdirSync(localeRoot).filter((name) => name.endsWith('.lproj')).sort()
    : []
  const expected = ['en.lproj', 'zh_CN.lproj']
  const missing = expected.filter((name) => !locales.includes(name))
  const unexpected = locales.filter((name) => !expected.includes(name))
  localeCheck = { checked: true, locales, missing, unexpected }
  console.log(`${missing.length || unexpected.length ? '❌' : '✅'} Electron 语言资源 ${locales.join(', ') || '无'}`)
}

const sizeMb = Number((buffer.length / 1024 / 1024).toFixed(1))
const oversized = sizeMb > 120
console.log(`${oversized ? '❌' : '✅'} app.asar 体积 ${sizeMb} MB（上限 120 MB）`)
console.log(`${obsoleteSpeechFiles.length || obsoleteSpeechMarkers.length ? '❌' : '✅'} 未打包旧 MOSS/WASM 播报链路`)
const ok = missingFiles.length === 0
  && missingMarkers.length === 0
  && missingRuntimePackages.length === 0
  && duplicatedRendererPackages.length === 0
  && !oversized
  && obsoleteSpeechFiles.length === 0
  && obsoleteSpeechMarkers.length === 0
  && voiceCheck.ok
  && (!localMemoryCheck.checked || localMemoryCheck.noDownloader)
  && (!localeCheck.checked || (!localeCheck.missing.length && !localeCheck.unexpected.length))
console.log(JSON.stringify({ ok, asarPath, sizeMb, packedFileCount: packedFiles.length, missingFiles, missingMarkers: missingMarkers.map(([label]) => label), missingRuntimePackages, duplicatedRendererPackages, localeCheck, localMemoryCheck, voiceCheck, obsoleteSpeechFiles, obsoleteSpeechMarkers, oversized }))
process.exit(ok ? 0 : 1)
