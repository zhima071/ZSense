import { app, BrowserWindow, clipboard, ipcMain, Menu, Notification, Tray, nativeImage, net, powerMonitor, powerSaveBlocker, protocol, safeStorage, session, shell, systemPreferences } from 'electron'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { registerIpcHandlers } from './ipc.mjs'
import { installSafeConsole } from './services/safe-console.mjs'
import { createLazyService } from './services/lazy-service.mjs'
import { cloneForRenderer, ZSenseDatabase } from './services/database.mjs'
import { LocalMemoryService } from './services/local-memory-service.mjs'
import { MemoryUpgradeService } from './services/memory-upgrade-service.mjs'
import { OfficeTaskService } from './services/office-task-service.mjs'
import { AuthService } from './services/auth-service.mjs'
import { GATEWAY_HEALTH_CHECK_INTERVAL_MS, ZSenseGatewayService } from './services/zsense-gateway-service.mjs'
import { ZSenseVoiceService } from './services/zsense-voice-service.mjs'
import { SecretsVault } from './services/secrets-vault.mjs'
import { SkillManager } from './services/skill-manager.mjs'

// 从终端启动时管道可能随时断开（父进程先退出）：先装上日志安全垫，
// 避免第三方库（例如 dingtalk-stream 心跳）写日志抛 write EPIPE 弹「主进程 JavaScript 错误」。
installSafeConsole()
import { ScheduledTaskRunner } from './services/scheduled-task-runner.mjs'
import { createDeviceDataProvider } from './services/device-data-service.mjs'
import { DEFAULT_WEB_BRIDGE_PORT, WebBridgeService } from './services/web-bridge-service.mjs'
import { OfficeWorkspaceService } from './services/office-workspace-service.mjs'
import { composeAgentRuntimeStatus, ZSenseAgentCore } from './services/zsense-agent-core.mjs'
import { BrowserAutomationService } from './services/browser-automation-service.mjs'
import { McpService } from './services/mcp-service.mjs'
import { AgentCapabilityService } from './services/agent-capability-service.mjs'
import { AutonomyRunner } from './services/autonomy-runner.mjs'
import { ComputerUseService } from './services/computer-use-service.mjs'
import { ZSenseCanvasService } from './services/zsense-canvas-service.mjs'
import { DeviceLinkService } from './services/device-link-service.mjs'
import { DeviceTaskRunner } from './services/device-task-runner.mjs'
import { UpdateService } from './services/update-service.mjs'
import { editContextMenuTemplate } from './services/edit-context-menu.mjs'
import { GlobalScreenshotService } from './services/global-screenshot-service.mjs'

// 启动期崩溃兜底：主进程若抛出未捕获异常，Electron 只会弹一个模态对话框，
// 界面卡住、日志空白、什么线索都没有。这里先把堆栈落盘，保证任何启动失败都能查。
process.on('uncaughtException', (error) => {
  try { fs.appendFileSync(path.join(os.tmpdir(), 'zsense-crash.log'), `[${new Date().toISOString()}] ${error?.stack || error}\n`) } catch { /* 忽略 */ }
  console.error('[ZSense] 主进程未捕获异常：', error)
  app.exit(1)
})
process.on('unhandledRejection', (reason) => {
  try { fs.appendFileSync(path.join(os.tmpdir(), 'zsense-crash.log'), `[${new Date().toISOString()}] 未处理的 Promise 拒绝：${reason?.stack || reason}\n`) } catch { /* 忽略 */ }
  console.error('[ZSense] 主进程未处理的 Promise 拒绝：', reason)
})


const currentDirectory = path.dirname(fileURLToPath(import.meta.url))
const projectDirectory = path.resolve(currentDirectory, '..')
// 测试隔离：允许用 ZSENSE_USER_DATA 指定另一个数据目录来跑。
// 验证功能时改成「用户真实数据的副本」启动，就不必再去改用户正在用的设置、
// 安全锁和数据库 —— 之前因为没有这个入口，测试只能动真实设置，出过事故。
const userDataOverride = process.env.ZSENSE_USER_DATA
if (userDataOverride) {
  try {
    fs.mkdirSync(userDataOverride, { recursive: true })
    app.setPath('userData', userDataOverride)
  } catch (error) {
    console.warn('ZSENSE_USER_DATA 目录不可用，继续使用默认数据目录：', error?.message || error)
  }
}

const developmentUrl = process.env.ZSENSE_DEV_SERVER_URL
const isDevelopment = Boolean(developmentUrl)

async function fetchOfficialUpdateBuffer(url, accept = 'application/octet-stream') {
  const response = await net.fetch(url, {
    headers: { Accept: accept, 'User-Agent': 'ZSense-Agent-Core/0.24.0' },
    redirect: 'follow',
    signal: AbortSignal.timeout(45_000),
  })
  if (!response.ok) throw new Error(`官方更新源返回 HTTP ${response.status}。`)
  const declared = Number.parseInt(response.headers.get('content-length') || '0', 10)
  if (declared > 220 * 1024 * 1024) throw new Error('官方更新包超过 220 MB，已停止下载。')
  const buffer = Buffer.from(await response.arrayBuffer())
  if (!buffer.length || buffer.length > 220 * 1024 * 1024) throw new Error('官方更新响应为空或超过 220 MB。')
  return buffer
}

function applyMacDockIcon() {
  if (process.platform !== 'darwin' || !app.dock) return

  const iconPath = path.join(projectDirectory, 'build', 'icon.png')
  try {
    const icon = nativeImage.createFromBuffer(fs.readFileSync(iconPath))
    if (!icon.isEmpty()) app.dock.setIcon(icon)
  } catch (error) {
    console.warn('ZSense Dock 图标加载失败：', error)
  }
}

protocol.registerSchemesAsPrivileged([{
  scheme: 'zsense-office',
  privileges: { standard: true, secure: true, supportFetchAPI: false, corsEnabled: false, stream: true },
}, {
  scheme: 'zsense-canvas',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
}])

let mainWindow = null
let globalScreenshotService = null
let tray = null
let isQuitting = false
let database = null
let memoryService = null
let officeTaskService = null
let auth = null
let agentCore = null
let gatewayService = null
let voiceService = null
let skillManager = null
let secrets = null
let scheduledTaskRunner = null
let officeWorkspace = null
let browserAutomation = null
let mcpService = null
let capabilityService = null
let autonomyRunner = null
let computerUseService = null
let canvasService = null
let deviceLinkService = null
let webBridgeService = null
let ipcHandlers = new Map()
let deviceTaskRunner = null
let updateService = null
let agentDataRoot = null
let quitCleanupPromise = null
let quitCleanupComplete = false
let gatewayHealthTimer = null
let gatewayHealthCheckPromise = null
let appSuspensionBlockerId = null
const activeNotifications = new Set()
// 内存治理（对话任务执行期间最容易堆起来的地方）：
//   1) 给渲染进程一个明确的 V8 堆上限，避免长时间任务把堆一路涨上去；
//   2) 关掉用不到的特性，少几个后台服务与缓存。
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=1024')
app.commandLine.appendSwitch('disable-features', 'Translate,MediaRouter,OptimizationHints,CalculateNativeWinOcclusion,BackForwardCache')

const hasSingleInstanceLock = app.requestSingleInstanceLock()

function bundledSkillsDirectory() {
  return path.join(app.isPackaged ? process.resourcesPath : projectDirectory, 'bundled-skills')
}

function bundledToolsDirectory() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'bundled-tools')
    : path.join(projectDirectory, 'bundled-tools', `${process.platform}-${process.arch}`)
}

async function inspectApplicationRuntime() {
  const coreStatus = agentCore ? await agentCore.inspect() : { runnable: false, message: 'ZSense Agent Core 尚未初始化。' }
  return composeAgentRuntimeStatus(coreStatus, gatewayService?.inspect(), voiceService?.inspect(), agentDataRoot)
}

function deployBundledAgentResources() {
  if (!skillManager || !agentDataRoot) return
  skillManager.ensureBundledSkills(bundledSkillsDirectory(), app.getVersion())
  skillManager.ensureBundledTools(bundledToolsDirectory(), agentDataRoot, app.getVersion())
}

function migrateLegacySkillWorkspace(legacyHomePath, nextHomePath) {
  const legacySkills = path.join(legacyHomePath || '', 'skills')
  const nextSkills = path.join(nextHomePath, 'skills')
  if (!legacyHomePath || legacySkills === nextSkills || !fs.existsSync(legacySkills)) return
  fs.mkdirSync(nextSkills, { recursive: true })
  fs.cpSync(legacySkills, nextSkills, {
    recursive: true,
    force: false,
    errorOnExist: false,
    filter: (source) => !['.env', '__pycache__', 'node_modules'].includes(path.basename(source)),
  })
}

// Voice conversations can begin from the background wake word, where Chromium has
// no click gesture to inherit. ZSense only plays audio generated by its own voice
// service, so allow that reply to start reliably.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

function publishWorkspace(workspace = database?.loadWorkspace()) {
  if (!workspace || !mainWindow || mainWindow.webContents.isDestroyed()) return
  const senderId = mainWindow.webContents.id
  if (auth?.status(senderId).authenticated) mainWindow.webContents.send('zsense:data:changed', workspace)
}

function publishMemoryChange(botId, result = {}) {
  if (!database) return
  // 保护、遗忘与世代失效是预期跳过，不把后台状态当错误反复打扰用户。
  const quietReasons = new Set(['manual-protected','previously-forgotten','stale-version','stale-generation'])
  const reasonMessage = result.reason === 'maintenance-failed'
    ? '后台记忆整理未完成，已有记忆和原回复不受影响。'
    : quietReasons.has(result.reason) ? '' : /^[\p{Script=Han}]/u.test(String(result.reason || '')) ? String(result.reason).slice(0,200) : ''
  const status = result.capacityReached
    ? { capacityReached:true,message:'自动记忆已达容量上限，请整理记忆或调整容量；人工记忆不会被自动删除。' }
    : reasonMessage ? { message:reasonMessage } : undefined
  const payload = cloneForRenderer(database.memorySnapshot(botId,status))
  if (mainWindow && !mainWindow.webContents.isDestroyed() && auth?.status(mainWindow.webContents.id).authenticated) mainWindow.webContents.send('zsense:workspace:memory-changed',payload)
  webBridgeService?.publishMemoryChanged(payload)
}

function applyRunWhileLocked(enabled) {
  const shouldKeepRunning = Boolean(enabled)
  if (shouldKeepRunning) {
    if (appSuspensionBlockerId === null || !powerSaveBlocker.isStarted(appSuspensionBlockerId)) {
      appSuspensionBlockerId = powerSaveBlocker.start('prevent-app-suspension')
    }
  } else if (appSuspensionBlockerId !== null) {
    if (powerSaveBlocker.isStarted(appSuspensionBlockerId)) powerSaveBlocker.stop(appSuspensionBlockerId)
    appSuspensionBlockerId = null
  }
  if (mainWindow && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.setBackgroundThrottling(!shouldKeepRunning)
  }
}

function emitUserFeedback(kind, title, body, { forceSound = false, forceDesktop = false } = {}) {
  const settings = database?.loadSettings() || {}
  const soundEnabled = forceSound || (kind === 'approval' ? settings.approvalSound : settings.completionSound)
  const desktopEnabled = forceDesktop || (kind === 'approval' ? settings.approvalDesktopNotification : settings.completionDesktopNotification)
  if (soundEnabled) shell.beep()
  const supported = Notification.isSupported()
  let notificationShown = false
  let failureReason = ''
  if (desktopEnabled && supported) {
    try {
      const notification = new Notification({ title, body: String(body || '').slice(0, 240), silent: true })
      activeNotifications.add(notification)
      const release = () => activeNotifications.delete(notification)
      notification.once('close', release)
      notification.once('click', release)
      notification.once('failed', (error) => { failureReason = error instanceof Error ? error.message : String(error || '系统通知发送失败。'); release() })
      notification.show()
      notificationShown = true
    } catch (error) {
      failureReason = error instanceof Error ? error.message : '系统通知发送失败。'
    }
  }
  return { supported, soundPlayed: Boolean(soundEnabled), notificationShown, failureReason }
}

function microphoneAccessStatus() {
  if (!['darwin', 'win32'].includes(process.platform)) return 'unknown'
  try { return systemPreferences.getMediaAccessStatus('microphone') }
  catch { return 'unknown' }
}

async function requestMicrophoneAccess() {
  if (process.platform !== 'darwin') return microphoneAccessStatus() === 'denied' ? 'denied' : 'granted'
  try { return await systemPreferences.askForMediaAccess('microphone') ? 'granted' : microphoneAccessStatus() }
  catch { return microphoneAccessStatus() }
}

function handleVoiceWakeDetected(event = {}) {
  if (mainWindow && !mainWindow.webContents.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  }
  if (database?.loadSettings().voiceWakeSound) shell.beep()
  return { phrase: String(event.phrase || database?.loadSettings().voiceWakePhrase || '你好 ZSense'), detectedAt: new Date().toISOString() }
}

function configureMediaPermissions() {
  const isOwnWindow = (webContents) => Boolean(mainWindow && webContents?.id === mainWindow.webContents.id)
  session.defaultSession.setPermissionCheckHandler((webContents, permission, _origin, details) => (
    permission === 'media' && isOwnWindow(webContents) && details?.mediaType === 'audio'
  ))
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const mediaTypes = Array.isArray(details?.mediaTypes) ? details.mediaTypes : []
    callback(permission === 'media' && isOwnWindow(webContents) && mediaTypes.includes('audio') && !mediaTypes.includes('video'))
  })
}

async function startWorkspaceGateways() {
  const result = await gatewayService.reconcile()
  if (!result.ok) console.error('ZSense Gateway 启动失败：', result.errors.join('\n'))
  const currentStatus = await inspectApplicationRuntime()
  mainWindow?.webContents.send('zsense:runtime:status-changed', currentStatus)
}

const applicationStartedAt = Date.now()

async function collectLocalDeviceStatus() {
  const workspace = database?.loadWorkspace()
  const runtime = agentCore ? await agentCore.inspect().catch(() => ({ runnable: false })) : { runnable: false }
  const voice = voiceService?.inspect?.() || null
  const gateway = gatewayService?.inspect?.() || null
  const bots = workspace?.bots || []
  const runs = workspace?.scheduledTaskRuns || []
  return {
    app: {
      version: app.getVersion(),
      platform: process.platform,
      startedAt: new Date(applicationStartedAt).toISOString(),
      uptimeMs: Math.max(0, Date.now() - applicationStartedAt),
    },
    activity: {
      bots: bots.length,
      onlineBots: bots.filter((bot) => bot.status === 'online').length,
      conversations: (workspace?.conversations || []).length,
      scheduledTasks: (workspace?.scheduledTasks || []).length,
      runningTasks: runs.filter((run) => run.status === 'running').length,
      skills: (workspace?.skills || []).length,
      memories: bots.reduce((total, bot) => total + Number(bot.memoryCount || 0), 0) + Number(workspace?.nativeBot?.memoryCount || 0),
    },
    capabilities: {
      agentCore: Boolean(runtime?.runnable),
      remoteTasks: Boolean(deviceTaskRunner),
      voiceWake: Boolean(voice?.supported),
      gateway: Boolean(gateway?.managedByApp),
    },
  }
}

function checkWorkspaceGateways() {
  if (gatewayHealthCheckPromise || !gatewayService || !database || quitCleanupPromise) return gatewayHealthCheckPromise
  gatewayHealthCheckPromise = (async () => {
    const result = await gatewayService.healthCheck()
    if (!result.ok) console.error('ZSense Gateway 健康检测异常：', result.errors.join('\n'))
    mainWindow?.webContents.send('zsense:runtime:status-changed', await inspectApplicationRuntime())
  })().catch((error) => {
    console.error('ZSense Gateway 定时检测失败：', error)
  }).finally(() => {
    gatewayHealthCheckPromise = null
  })
  return gatewayHealthCheckPromise
}

function startGatewayHealthMonitor() {
  if (gatewayHealthTimer || !gatewayService) return
  gatewayService.setMonitorEnabled(true)
  gatewayHealthTimer = setInterval(() => { void checkWorkspaceGateways() }, GATEWAY_HEALTH_CHECK_INTERVAL_MS)
}

async function initializeWorkspaceRuntime() {
  try { deployBundledAgentResources() }
  catch (error) { console.error('ZSense 内置技能工具部署失败：', error) }
  await startWorkspaceGateways()
  await checkWorkspaceGateways()
}

function stopGatewayHealthMonitor() {
  if (gatewayHealthTimer) clearInterval(gatewayHealthTimer)
  gatewayHealthTimer = null
  gatewayService?.setMonitorEnabled(false)
}

function createApplicationMenu() {
  const template = [
    ...(process.platform === 'darwin' ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    }] : []),
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'pasteAndMatchStyle', label: '粘贴并匹配样式' },
        { role: 'delete', label: '删除' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '显示',
      submenu: [
        ...(isDevelopment ? [
          { role: 'reload', label: '重新加载' },
          { role: 'toggleDevTools', label: '开发者工具' },
          { type: 'separator' },
        ] : []),
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '切换全屏' },
      ],
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'close', label: '关闭窗口' },
      ],
    },
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function registerEditingContextMenu(webContents) {
  webContents.on('context-menu', (_event, params) => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    const template = editContextMenuTemplate(params, { copyLink: (url) => clipboard.writeText(url) })
    if (template.length) Menu.buildFromTemplate(template).popup({ window: mainWindow })
  })
}

function showMainWindow() {
  if (!mainWindow || mainWindow.webContents.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function createWindowsTray() {
  if (process.platform !== 'win32' || tray) return
  const trayPath = path.join(projectDirectory, 'build', fs.existsSync(path.join(projectDirectory, 'build', 'icon-win.png')) ? 'icon-win.png' : 'icon.png')
  const trayImage = nativeImage.createFromPath(trayPath).resize({ width: 20, height: 20 })
  tray = new Tray(trayImage)
  tray.setToolTip('ZSense')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开 ZSense', click: showMainWindow },
    { type: 'separator' },
    { label: '退出 ZSense', click: () => { isQuitting = true; app.quit() } },
  ]))
  tray.on('double-click', showMainWindow)
}

function isTrustedExternalUrl(targetUrl) {
  try {
    const parsed = new URL(targetUrl)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:'
  } catch {
    return false
  }
}

function isLocalBrowserUrl(targetUrl) {
  try {
    const hostname = new URL(targetUrl).hostname.toLowerCase()
    return hostname === 'localhost' || hostname === 'localhost.localdomain' || hostname === '127.0.0.1' || hostname === '::1'
  } catch { return false }
}

function isInternalNavigation(targetUrl, currentUrl) {
  try {
    const target = new URL(targetUrl)
    const current = new URL(currentUrl)
    if (current.protocol === 'file:') {
      return target.protocol === 'file:' && target.pathname === current.pathname
    }
    return target.origin === current.origin
  } catch {
    return false
  }
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    title: 'ZSense',
    backgroundColor: '#ffffff',
    autoHideMenuBar: process.platform !== 'darwin',
    show: false,
    icon: path.join(projectDirectory, 'build', process.platform === 'win32' ? 'icon-win.png' : 'icon.png'),
    webPreferences: {
      preload: path.join(currentDirectory, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
      backgroundThrottling: true,
      webviewTag: true,
    },
  })

  registerEditingContextMenu(mainWindow.webContents)

  mainWindow.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    let target
    try { target = new URL(params.src || '') } catch { event.preventDefault(); return }
    if (!['http:', 'https:'].includes(target.protocol) && target.href !== 'about:blank') { event.preventDefault(); return }
    delete webPreferences.preload
    webPreferences.nodeIntegration = false
    webPreferences.contextIsolation = true
    webPreferences.sandbox = true
    webPreferences.webSecurity = true
    webPreferences.partition = 'persist:zsense-browser'
    params.partition = 'persist:zsense-browser'
  })

  mainWindow.webContents.on('did-attach-webview', (_event, guest) => {
    registerEditingContextMenu(guest)
    guest.setWindowOpenHandler(({ url }) => {
      try {
        const target = new URL(url)
        if (['http:', 'https:'].includes(target.protocol)) {
          const settings = database?.loadSettings() || {}
          const destination = isLocalBrowserUrl(target.href) ? settings.browserLocalUrlTarget : settings.browserWebLinkTarget
          if (destination === 'system') void shell.openExternal(target.href)
          else void guest.loadURL(target.href)
        }
      } catch { /* Ignore malformed popup targets. */ }
      return { action: 'deny' }
    })
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isTrustedExternalUrl(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  mainWindow.webContents.on('will-navigate', (event, url) => {
    const currentUrl = mainWindow?.webContents.getURL()
    if (!currentUrl || !isInternalNavigation(url, currentUrl)) {
      event.preventDefault()
      if (isTrustedExternalUrl(url)) void shell.openExternal(url)
    }
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.on('close', (event) => {
    if (process.platform === 'win32' && !isQuitting) {
      event.preventDefault()
      mainWindow?.hide()
    }
  })
  mainWindow.on('closed', () => { mainWindow = null })

  if (developmentUrl) {
    await mainWindow.loadURL(developmentUrl)
  } else {
    await mainWindow.loadFile(path.join(projectDirectory, 'dist', 'index.html'))
  }
  applyRunWhileLocked(database?.loadSettings().runWhileLocked)
}

if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })

// 空闲期定期建议一次 GC：长任务跑完后把大对象及时还回去（未开启 expose-gc 时是空操作）
setInterval(() => { try { global.gc?.() } catch { /* 忽略 */ } }, 5 * 60_000).unref?.()

app.whenReady().then(async () => {
  applyMacDockIcon()
  const userDataDirectory = app.getPath('userData')
  agentDataRoot = path.join(userDataDirectory, 'agent-core')
  try { migrateLegacySkillWorkspace(path.join(userDataDirectory, 'hermes-runtime', 'home'), agentDataRoot) }
  catch (error) { console.warn('旧版技能迁移到 ZSense Agent Core 目录失败：', error) }
  skillManager = new SkillManager(agentDataRoot, { requestBuffer: fetchOfficialUpdateBuffer })
  try { deployBundledAgentResources() }
  catch (error) { console.error('ZSense 内置技能初始化失败：', error) }
  database = new ZSenseDatabase(userDataDirectory, skillManager)
  // 旧设备先做一次纯本地召回整理；事务失败留待下次启动，不阻断应用或触发额外授权。
  try { await new MemoryUpgradeService({ database }).run() }
  catch { console.warn('旧记忆本地整理未完成，将在下次启动重试。') }
  memoryService = new LocalMemoryService({ database, onChanged:publishMemoryChange })
  database.memoryService = memoryService
  secrets = new SecretsVault(userDataDirectory, safeStorage)
  const deviceDataProvider = createDeviceDataProvider({ database, localStatusProvider: () => collectLocalDeviceStatus() })
  deviceLinkService = new DeviceLinkService({
    rootPath: agentDataRoot,
    secrets,
    remoteStatusProvider: (peer) => collectLocalDeviceStatus(peer),
    remoteDataProvider: (request) => deviceDataProvider(request),
    remoteTaskRunner: {
      run: (request) => {
        if (!deviceTaskRunner) throw new Error('本机远程任务执行器尚未就绪。')
        return deviceTaskRunner.run(request)
      },
      cancelPeer: (deviceId) => deviceTaskRunner?.cancelPeer(deviceId),
      cancelAll: () => deviceTaskRunner?.cancelAll(),
    },
    onChanged: (status) => {
      if (!mainWindow || mainWindow.webContents.isDestroyed()) return
      mainWindow.webContents.send('zsense:device-link:changed', status)
    },
  })
  deviceLinkService.appLockProvider = () => {
    try { return Boolean(database.getSetting('appLockEnabled')) } catch { return false }
  }
  try {
      await deviceLinkService.initialize()
    } catch { /* 设备互联 / 交换中心启动失败不影响主流程 */ }
  updateService = new UpdateService({
    currentVersion: app.getVersion(),
    fetchImpl: (url, options) => net.fetch(url, options),
    downloadDirectory: path.join(userDataDirectory, 'updates'),
    isPackaged: app.isPackaged,
    onProgress: (status) => {
      if (mainWindow && !mainWindow.webContents.isDestroyed()) mainWindow.webContents.send('zsense:update:progress', status)
    },
    quitApp: () => app.quit(),
  })
  auth = new AuthService(database)
  const officeToolName = process.platform === 'win32' ? 'officecli.exe' : 'officecli'
  const dwsToolName = process.platform === 'win32' ? 'dws.exe' : 'dws'
  const kdocsToolName = process.platform === 'win32' ? 'kdocs-cli.exe' : 'kdocs-cli'
  const larkToolName = process.platform === 'win32' ? 'lark-cli.exe' : 'lark-cli'
  officeWorkspace = createLazyService(() => new OfficeWorkspaceService({
    userDataDirectory,
    toolPaths: [
      path.join(agentDataRoot, 'toolchain', 'bin', officeToolName),
      path.join(bundledToolsDirectory(), officeToolName),
    ],
  }))
  officeWorkspace.onSessionEvent((event) => {
    if (!mainWindow || mainWindow.webContents.isDestroyed()) return
    mainWindow.webContents.send('zsense:office:session-changed', event)
  })
  officeTaskService = new OfficeTaskService({ database, officeWorkspace, onChanged: () => {
    if (!mainWindow || mainWindow.webContents.isDestroyed()) return
    if (auth?.status(mainWindow.webContents.id).authenticated) mainWindow.webContents.send('zsense:office-tasks:changed')
  } })
  browserAutomation = createLazyService(() => new BrowserAutomationService({
    screenshotsRoot: path.join(agentDataRoot, 'capabilities', 'screenshots'),
    downloadsDirectory: app.getPath('downloads'),
    getSettings: () => database.loadSettings(),
    onActivity: (event) => {
      if (!mainWindow || mainWindow.webContents.isDestroyed()) return
      mainWindow.webContents.send('zsense:browser:activity', event)
    },
  }))
  mcpService = createLazyService(() => new McpService({ rootPath: agentDataRoot, secrets, builtInServers: [] }))
  computerUseService = createLazyService(() => new ComputerUseService())
  capabilityService = new AgentCapabilityService({ rootPath: agentDataRoot, database, officeTaskService, browserService: browserAutomation, computerUseService, mcpService })
  // 让对话里的 Agent 能看到、读取并驱动已配对的其他设备（设备互联面板里的同一份数据）
  capabilityService.setDeviceLinkProvider({
    inspect: () => deviceLinkService.inspect(),
    remoteStatus: (deviceId) => deviceLinkService.remoteStatus(deviceId),
    readRemoteData: (deviceId, scope, query) => deviceLinkService.readRemoteData(deviceId, scope, query),
    runRemoteTask: (deviceId, prompt, timeoutMs) => deviceLinkService.runRemoteTask(deviceId, prompt, timeoutMs),
    pairByAddress: (request) => deviceLinkService.pairByAddress(request),
  })
  const dwsToolPaths = [
    path.join(agentDataRoot, 'toolchain', 'bin', dwsToolName),
    path.join(bundledToolsDirectory(), dwsToolName),
  ]
  canvasService = createLazyService(() => new ZSenseCanvasService({
    onChanged: (event) => {
      if (!mainWindow || mainWindow.webContents.isDestroyed()) return
      mainWindow.webContents.send('zsense:canvas:changed', event)
    },
  }))
  agentCore = new ZSenseAgentCore({
    officeWorkspace,
    officeToolPaths: [
      path.join(agentDataRoot, 'toolchain', 'bin', officeToolName),
      path.join(bundledToolsDirectory(), officeToolName),
    ],
    dwsToolPaths,
    kdocsToolPaths: [
      path.join(agentDataRoot, 'toolchain', 'bin', kdocsToolName),
      path.join(bundledToolsDirectory(), kdocsToolName),
    ],
    larkToolPaths: [
      path.join(agentDataRoot, 'toolchain', 'bin', larkToolName),
      path.join(bundledToolsDirectory(), larkToolName),
    ],
    secrets,
    capabilityService,
    canvasService,
    runtimeRootPath: agentDataRoot,
  })
  memoryService.setModelRefiner((options) => agentCore.extractMemories(options))
  voiceService = createLazyService(() => new ZSenseVoiceService({ database, secrets, toolsDirectory: bundledToolsDirectory() }))
  gatewayService = new ZSenseGatewayService({
    database,
    officeTaskService,
    officeWorkspace,
    agentCore,
    browserService: browserAutomation,
    dwsToolPaths,
    secrets,
    userDataDirectory,
    onChanged: publishWorkspace,
    notify: emitUserFeedback,
  })
  protocol.handle('zsense-office', (request) => officeWorkspace.previewResponse(request.url))
  protocol.handle('zsense-canvas', (request) => canvasService.assetResponse(request.url))
  scheduledTaskRunner = new ScheduledTaskRunner({
    database,
    agentCore,
    secrets,
    userDataDirectory,
    onChanged: publishWorkspace,
    notify: emitUserFeedback,
  })
  capabilityService.setScheduledTaskRunner(scheduledTaskRunner)
  autonomyRunner = new AutonomyRunner({
    database,
    capabilityService,
    agentCore,
    secrets,
    onChanged: publishWorkspace,
    notify: emitUserFeedback,
  })
  deviceTaskRunner = new DeviceTaskRunner({
    rootPath: agentDataRoot,
    database,
    agentCore,
    secrets,
    notify: emitUserFeedback,
  })
  // 局域网 Web 访问需要与桌面端完全一致的调用面：注册 IPC 时把处理器登记一份，
  // 网页端的调用会走同一批处理器（参数校验与错误信封完全一致）。
  ipcHandlers = new Map()
  // 先建服务、再注册 IPC：服务持有的是这张处理器表的引用，注册过程会把处理器填进去。
  webBridgeService = new WebBridgeService({
    rootPath: agentDataRoot,
    staticDirectory: path.join(projectDirectory, 'dist'),
    preloadPath: path.join(currentDirectory, 'preload.cjs'),
    handlers: ipcHandlers,
    appVersion: app.getVersion(),
    port: DEFAULT_WEB_BRIDGE_PORT,
    hostname: os.hostname(),
    enabled: database.loadSettings().webAccessEnabled === true,
    onChanged: (status) => {
      if (!mainWindow || mainWindow.webContents.isDestroyed()) return
      mainWindow.webContents.send('zsense:web-bridge:changed', status)
    },
  })
  const recordingIpcMain = new Proxy(ipcMain, {
    get(target, property) {
      if (property === 'handle') {
        return (channel, handler) => {
          ipcHandlers.set(channel, handler)
          return target.handle(channel, handler)
        }
      }
      const value = Reflect.get(target, property)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  registerIpcHandlers({
    ipcMain: recordingIpcMain,
    database,
    agentCore,
    browserService: browserAutomation,
    capabilityService,
    computerUseService,
    mcpService,
    gatewayService,
    officeTaskService,
    voiceService,
    inspectApplicationRuntime,
    secrets,
    skillManager,
    auth,
    officeWorkspace,
    canvasService,
    deviceLinkService,
    webBridgeService,
    updateService,
    deployBundledAgentResources,
    scheduledTaskRunner,
    notify: emitUserFeedback,
    onWorkspaceChanged: publishWorkspace,
    onMemoryChanged: publishMemoryChange,
    microphoneAccessStatus,
    requestMicrophoneAccess,
    onVoiceWakeDetected: handleVoiceWakeDetected,
    onRunWhileLockedChanged: applyRunWhileLocked,
    appVersion: app.getVersion(),
  })
  try { await webBridgeService.initialize() }
  catch (error) { console.warn('ZSense 局域网 Web 访问启动失败：', error instanceof Error ? error.message : error) }
  createApplicationMenu()
  configureMediaPermissions()
  await createWindow()
  globalScreenshotService = new GlobalScreenshotService({ app, getMainWindow: () => mainWindow })
  globalScreenshotService.initialize()
  createWindowsTray()
  powerMonitor.on('lock-screen', () => {
    if (!mainWindow || mainWindow.webContents.isDestroyed() || !database?.loadSettings().appLockEnabled) return
    try {
      voiceService?.stopWake()
      const status = auth?.lock(mainWindow.webContents.id)
      if (status) mainWindow.webContents.send('zsense:auth:locked', status)
    } catch { /* Ignore lock-screen events before a user has signed in. */ }
  })
  startGatewayHealthMonitor()
  void initializeWorkspaceRuntime()
    .catch((error) => console.error('ZSense Gateway 生命周期初始化失败：', error))
    .finally(() => {
      scheduledTaskRunner?.start()
      autonomyRunner?.start()
    })

  app.on('activate', async () => {
    if (!mainWindow || mainWindow.isDestroyed()) await createWindow()
    else showMainWindow()
  })
})

app.on('before-quit', (event) => {
  isQuitting = true
  if (quitCleanupComplete) return
  event.preventDefault()
  if (quitCleanupPromise) return
  quitCleanupPromise = (async () => {
    try {
      globalScreenshotService?.dispose()
      globalScreenshotService = null
      applyRunWhileLocked(false)
      stopGatewayHealthMonitor()
      await gatewayHealthCheckPromise
      await scheduledTaskRunner?.shutdown()
      await autonomyRunner?.shutdown()
      await gatewayService?.shutdown()
      await deviceLinkService?.shutdown()
      await webBridgeService?.shutdown()
      await voiceService?.shutdown()
      capabilityService?.shutdown()
      await memoryService?.stop()
    } catch (error) {
      console.error('关闭 ZSense Gateway 时出错：', error)
    } finally {
      auth?.clear()
      auth = null
      try { database?.close() } catch (error) { console.error('关闭 ZSense 数据库时出错：', error) }
      database = null
      memoryService = null
      officeTaskService = null
      agentCore = null
      gatewayService = null
      voiceService = null
      agentDataRoot = null
      secrets = null
      scheduledTaskRunner = null
      officeWorkspace = null
      capabilityService = null
      mcpService = null
      browserAutomation = null
      autonomyRunner = null
      deviceLinkService = null
      tray?.destroy()
      tray = null
      quitCleanupComplete = true
      app.quit()
    }
  })()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
}
