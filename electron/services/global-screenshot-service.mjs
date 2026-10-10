import { BrowserWindow, ClipboardItem, clipboard, desktopCapturer, dialog, globalShortcut, ipcMain, nativeImage, screen, systemPreferences } from 'electron'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_SHORTCUT = 'CommandOrControl+Shift+8'
const MAX_IMAGE_BYTES = 60 * 1024 * 1024
const pagePath = fileURLToPath(new URL('../global-screenshot.html', import.meta.url))
const preloadPath = fileURLToPath(new URL('../global-screenshot-preload.cjs', import.meta.url))
const require = createRequire(import.meta.url)

function requestNativeScreenPermission(app) {
  // Never search PATH, userData, environment variables, or arbitrary modules.
  // The signed application ships this module outside ASAR in Resources.
  const base = app.isPackaged ? path.resolve(process.resourcesPath) : fileURLToPath(new URL('../../', import.meta.url))
  const segments = app.isPackaged ? ['bundled-tools'] : ['bundled-tools', `darwin-${process.arch}`]
  const modulePath = path.join(base, ...segments, 'screen-permission.node')
  try {
    const entry = fs.lstatSync(modulePath)
    const expectedRealPath = path.join(fs.realpathSync(base), ...segments, 'screen-permission.node')
    if (!entry.isFile() || entry.isSymbolicLink() || fs.realpathSync(modulePath) !== expectedRealPath) throw new Error('授权组件不是应用内的正常文件。')
    const bridge = require(modulePath)
    if (typeof bridge.requestScreenCapturePermission !== 'function') throw new Error('授权组件接口不匹配。')
    return bridge.requestScreenCapturePermission()
  } catch (error) {
    throw new Error('无法加载当前安装的 macOS 录屏授权组件，请更新或重新打开 ZSense。没有读取屏幕，也不会使用截图方式代替申请权限。', { cause: error })
  }
}

function validShortcut(value) {
  if (value === '') return true
  if (!/^(?:(?:CommandOrControl|Control|Alt|Shift|Meta)\+){1,3}(?:[A-Z0-9]|F(?:[1-9]|1[0-9]|2[0-4]))$/.test(value)) return false
  const parts = value.split('+')
  if (new Set(parts).size !== parts.length) return false
  if (!parts.includes('Shift') || !parts.some((part) => ['CommandOrControl', 'Control', 'Alt', 'Meta'].includes(part))) return false
  if (process.platform === 'darwin' && /^CommandOrControl\+Shift\+[345]$/.test(value)) return false
  return true
}

function pngFromDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string' || !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(dataUrl) || dataUrl.length > MAX_IMAGE_BYTES * 1.4) {
    throw new Error('截图图片格式无效或体积过大。')
  }
  const image = nativeImage.createFromDataURL(dataUrl)
  if (image.isEmpty()) throw new Error('截图图片为空。')
  const size = image.getSize()
  if (size.width * size.height > 40_000_000) throw new Error('截图超出 4000 万像素限制。')
  return image
}

function screenshotName() {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, '').replace('T', '-')
  return `ZSense-截图-${stamp}.png`
}

export class GlobalScreenshotService {
  constructor({ app, getMainWindow, platform = process.platform, runtime = {} }) {
    this.app = app
    this.getMainWindow = getMainWindow
    this.platform = platform
    this.runtime = { BrowserWindow, desktopCapturer, globalShortcut, ipcMain, screen, systemPreferences, requestScreenCapturePermission: () => requestNativeScreenPermission(app), ...runtime }
    this.configPath = path.join(app.getPath('userData'), 'global-screenshot.json')
    this.shortcut = DEFAULT_SHORTCUT
    this.registered = false
    this.lastError = ''
    this.selectionWindow = null
    this.editorWindow = null
    this.pinnedWindows = new Set()
    this.sourceImage = null
    this.display = null
    this.startPromise = null
    this.captureGeneration = 0
    this.disposed = false
    this.permissionRequestAttempted = false
    this.lastObservedPermission = null
    this.captureFailure = ''
    try {
      const stored = JSON.parse(fs.readFileSync(this.configPath, 'utf8'))
      if (validShortcut(stored.shortcut)) this.shortcut = stored.shortcut
    } catch { /* First launch keeps the default shortcut. */ }
  }

  initialize() {
    const { BrowserWindow, globalShortcut, ipcMain } = this.runtime
    if (this.shortcut) {
      this.registered = globalShortcut.register(this.shortcut, () => { void this.start().catch(() => {}) })
      if (!this.registered) this.lastError = '快捷键已被系统或其他应用占用；请在设置中更换。'
    }
    ipcMain.handle('zsense:global-screenshot:status', (event) => { this.#requireMain(event); return this.status() })
    ipcMain.handle('zsense:global-screenshot:recheck-permissions', (event) => { this.#requireMain(event); return this.recheckPermissions() })
    ipcMain.handle('zsense:global-screenshot:request-permissions', (event) => { this.#requireMain(event); return this.requestPermissions() })
    ipcMain.handle('zsense:global-screenshot:set-shortcut', (event, value) => { this.#requireMain(event); return this.setShortcut(value) })
    ipcMain.handle('zsense:global-screenshot:start', async (event) => { this.#requireMain(event); await this.start(); return this.status() })
    ipcMain.handle('zsense:global-screenshot:select', async (event, rectangle) => {
      this.#requireWindow(event, this.selectionWindow)
      return this.#select(rectangle)
    })
    ipcMain.handle('zsense:global-screenshot:output', async (event, request) => {
      this.#requireWindow(event, this.editorWindow)
      return this.#output(request)
    })
    ipcMain.handle('zsense:global-screenshot:close', (event) => {
      const caller = BrowserWindow.fromWebContents(event.sender)
      if (!caller || (caller !== this.selectionWindow && caller !== this.editorWindow && !this.pinnedWindows.has(caller))) throw new Error('截图窗口无权关闭其他窗口。')
      caller.close()
      return true
    })
  }

  status() {
    const screenCapturePermission = this.#screenPermission()
    return {
      shortcut: this.shortcut, registered: this.registered, error: this.lastError,
      screenCapturePermission,
      screenCaptureNeedsRestart: Boolean(this.captureFailure),
      screenCaptureRequestAttempted: this.permissionRequestAttempted,
      captureInProgress: Boolean(this.startPromise),
    }
  }

  recheckPermissions() {
    // A deliberate recheck lets the user retry after fixing System Settings.
    // It never requests permission or captures the desktop on its own.
    if (this.#screenPermission() === 'granted') {
      this.captureFailure = ''
      this.lastError = ''
    }
    return this.status()
  }

  requestPermissions() {
    if (this.disposed) throw new Error('截图服务已关闭。')
    const permission = this.#screenPermission()
    if (this.platform !== 'darwin' || permission === 'granted') return this.status()
    if (permission === 'restricted' || permission === 'unknown') throw this.#permissionError(permission)
    if (this.permissionRequestAttempted) return this.status()
    // Only this deliberate settings action invokes CGRequestScreenCaptureAccess.
    // A failed request or load also consumes this run's attempt; there is no
    // desktopCapturer fallback and no native permission request from checks or
    // capture. The separate first-time screenshot path retains its own guard.
    this.permissionRequestAttempted = true
    try {
      this.runtime.requestScreenCapturePermission()
      this.lastError = ''
      return this.status()
    } catch (error) {
      this.#reportError(error)
      throw error
    }
  }

  #screenPermission() {
    if (this.platform !== 'darwin') return 'granted'
    let status = 'unknown'
    try { status = this.runtime.systemPreferences.getMediaAccessStatus('screen') }
    catch { /* Fail closed if the OS cannot report permission. */ }
    if (!['not-determined', 'granted', 'denied', 'restricted'].includes(status)) status = 'unknown'
    if (this.lastObservedPermission !== null && status !== this.lastObservedPermission) {
      if (this.lastError === this.captureFailure) this.lastError = ''
      this.captureFailure = ''
    }
    this.lastObservedPermission = status
    return status
  }

  #permissionError(status) {
    if (status === 'restricted') return new Error('系统限制了 ZSense 的录屏权限；请检查设备管理策略或联系管理员。未读取屏幕。')
    if (status === 'unknown') return new Error('无法确认 macOS 录屏权限；为保护隐私，未读取屏幕。请完整退出 ZSense 后重开。')
    return new Error('ZSense 尚未获得当前应用的录屏权限。请在“系统设置 → 隐私与安全性 → 录屏与系统录音”中允许 ZSense，然后完整退出并重开应用；开关已开启时也可能需要重开才能生效。未读取屏幕。')
  }

  #captureError(error) {
    if (this.platform !== 'darwin') return error
    const permission = this.#screenPermission()
    if (permission !== 'granted') return this.#permissionError(permission)
    // A granted TCC entry can refer to a previous app identity, and a screen
    // service failure can also produce no image. Do not repeatedly invoke the
    // capture API (and its system prompt) until a deliberate recheck/restart.
    this.captureFailure = '截图失败：macOS 显示已授权，但当前应用未能取得屏幕画面。可能是权限尚未生效或系统录屏服务异常；为避免反复弹出系统提示，已暂停重试。请完整退出并重开 ZSense；若仍失败，在系统设置中重新允许 ZSense 录屏后再重开。'
    return new Error(this.captureFailure, { cause: error })
  }

  setShortcut(value) {
    const { globalShortcut } = this.runtime
    const next = String(value ?? '')
    if (!validShortcut(next)) throw new Error('请使用 Ctrl/⌘ + Shift + 字母、数字或功能键；系统截图快捷键不可覆盖。')
    if (next === this.shortcut) return this.status()
    if (next && !globalShortcut.register(next, () => { void this.start().catch(() => {}) })) {
      throw new Error('这个快捷键已被系统或其他应用占用，请换一个组合。')
    }
    const temporary = `${this.configPath}.tmp`
    try {
      fs.writeFileSync(temporary, JSON.stringify({ shortcut: next }), { mode: 0o600 })
      fs.renameSync(temporary, this.configPath)
    } catch (error) {
      if (next) globalShortcut.unregister(next)
      try { fs.unlinkSync(temporary) } catch { /* The temporary file may not exist. */ }
      throw error
    }
    if (this.registered && this.shortcut) globalShortcut.unregister(this.shortcut)
    this.shortcut = next
    this.registered = Boolean(next)
    this.lastError = ''
    return this.status()
  }

  start() {
    if (this.disposed) return Promise.reject(new Error('截图服务已关闭。'))
    if (this.startPromise) return this.startPromise
    if (this.selectionWindow && !this.selectionWindow.isDestroyed()) { this.selectionWindow.focus(); return Promise.resolve() }
    if (this.editorWindow && !this.editorWindow.isDestroyed()) { this.editorWindow.focus(); return Promise.resolve() }
    const generation = this.captureGeneration
    const pending = this.#startCapture(generation).catch((error) => {
      if (!this.disposed && generation === this.captureGeneration) this.#reportError(error)
      throw error
    })
    this.startPromise = pending
    const clear = () => { if (this.startPromise === pending) this.startPromise = null }
    void pending.then(clear, clear)
    return pending
  }

  async #startCapture(generation) {
    const { desktopCapturer, screen } = this.runtime
    if (this.platform === 'darwin') {
      const permission = this.#screenPermission()
      if (permission === 'not-determined' && !this.permissionRequestAttempted) {
        // start() is only reached by an explicit screenshot command/shortcut.
        // macOS has no askForMediaAccess('screen'); this one capture request
        // triggers the initial system consent, never at app initialization.
        this.permissionRequestAttempted = true
      } else if (permission !== 'granted') throw this.#permissionError(permission)
      if (this.captureFailure) throw new Error(this.captureFailure)
    }
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    const bounds = display.bounds
    const scale = Math.max(1, display.scaleFactor || 1)
    let sources
    try {
      sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: Math.min(8192, Math.round(bounds.width * scale)), height: Math.min(8192, Math.round(bounds.height * scale)) },
        fetchWindowIcons: false,
      })
    } catch (error) {
      if (this.disposed || generation !== this.captureGeneration) return
      throw this.#captureError(error)
    }
    if (this.disposed || generation !== this.captureGeneration) return
    if (this.platform === 'darwin' && this.#screenPermission() !== 'granted') throw this.#permissionError(this.lastObservedPermission)
    const source = sources.find((item) => String(item.display_id) === String(display.id)) || sources[screen.getAllDisplays().findIndex((item) => item.id === display.id)]
    if (!source || source.thumbnail.isEmpty()) throw this.#captureError(new Error('无法读取屏幕。请在系统隐私设置中允许 ZSense 录制屏幕。'))
    this.sourceImage = source.thumbnail
    this.display = display
    const window = this.#window({ ...bounds, fullscreenable: false, resizable: false, backgroundColor: '#171411' })
    this.selectionWindow = window
    window.on('closed', () => { if (this.selectionWindow === window) { this.selectionWindow = null; this.sourceImage = null; this.display = null } })
    try {
      await window.loadFile(pagePath, { query: { mode: 'select' } })
      if (this.disposed || generation !== this.captureGeneration) { if (!window.isDestroyed()) window.destroy(); return }
      window.webContents.send('zsense:global-screenshot:init', { mode: 'select', image: source.thumbnail.toDataURL(), width: bounds.width, height: bounds.height })
      window.show()
      window.focus()
      this.lastError = ''
    } catch (error) {
      window.destroy()
      throw error
    }
  }

  async #select(rectangle) {
    if (!this.sourceImage || !this.display) throw new Error('截图源已失效，请重新截图。')
    const bounds = this.display.bounds
    const x = Math.round(Number(rectangle?.x))
    const y = Math.round(Number(rectangle?.y))
    const width = Math.round(Number(rectangle?.width))
    const height = Math.round(Number(rectangle?.height))
    if (![x, y, width, height].every(Number.isSafeInteger) || x < 0 || y < 0 || width < 8 || height < 8 || x + width > bounds.width || y + height > bounds.height) {
      throw new Error('请选择至少 8×8 像素、且位于当前屏幕内的区域。')
    }
    const imageSize = this.sourceImage.getSize()
    const ratioX = imageSize.width / bounds.width
    const ratioY = imageSize.height / bounds.height
    const cropX = Math.min(imageSize.width - 1, Math.round(x * ratioX))
    const cropY = Math.min(imageSize.height - 1, Math.round(y * ratioY))
    const cropped = this.sourceImage.crop({
      x: cropX, y: cropY,
      width: Math.max(1, Math.min(imageSize.width - cropX, Math.round(width * ratioX))),
      height: Math.max(1, Math.min(imageSize.height - cropY, Math.round(height * ratioY))),
    })
    if (cropped.isEmpty()) throw new Error('截图区域没有内容。')
    const display = this.display
    this.selectionWindow?.close()
    const work = display.workArea
    const window = this.#window({
      width: Math.min(1120, Math.max(680, work.width - 60)),
      height: Math.min(790, Math.max(500, work.height - 60)),
      backgroundColor: '#f8f7f5', resizable: true,
    })
    window.center()
    this.editorWindow = window
    window.on('closed', () => { if (this.editorWindow === window) this.editorWindow = null })
    try {
      await window.loadFile(pagePath, { query: { mode: 'edit' } })
      window.webContents.send('zsense:global-screenshot:init', { mode: 'edit', image: cropped.toDataURL(), name: screenshotName() })
      window.show()
      window.focus()
    } catch (error) {
      window.destroy()
      throw error
    }
    return true
  }

  async #output(request) {
    const image = pngFromDataUrl(request?.image)
    if (request?.action === 'copy') {
      await clipboard.write([new ClipboardItem({ 'image/png': new Blob([image.toPNG()], { type: 'image/png' }) })])
      this.editorWindow?.close()
      return { copied: true }
    }
    if (request?.action === 'download') {
      const result = await dialog.showSaveDialog(this.editorWindow, {
        title: '下载截图', defaultPath: path.join(this.app.getPath('downloads'), screenshotName()),
        filters: [{ name: 'PNG 图片', extensions: ['png'] }],
      })
      if (result.canceled || !result.filePath) return { canceled: true }
      await fs.promises.writeFile(result.filePath, image.toPNG())
      return { saved: true, path: result.filePath }
    }
    if (request?.action === 'pin') {
      const size = image.getSize()
      const { screen } = this.runtime
      const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
      const work = display.workArea
      const fit = Math.min(1, (work.width * .55) / size.width, (work.height * .55) / size.height)
      const window = this.#window({
        width: Math.max(220, Math.round(size.width * fit)),
        height: Math.max(160, Math.round(size.height * fit) + 34),
        backgroundColor: '#ffffff', resizable: true,
      })
      this.pinnedWindows.add(window)
      window.on('closed', () => this.pinnedWindows.delete(window))
      window.setAlwaysOnTop(true, 'floating')
      try {
        await window.loadFile(pagePath, { query: { mode: 'pin' } })
        window.webContents.send('zsense:global-screenshot:init', { mode: 'pin', image: image.toDataURL() })
        window.show()
        this.editorWindow?.close()
      } catch (error) {
        window.destroy()
        throw error
      }
      return { pinned: true }
    }
    throw new Error('不支持的截图操作。')
  }

  #window(options) {
    const { BrowserWindow } = this.runtime
    const window = new BrowserWindow({
      ...options, frame: false, show: false, alwaysOnTop: true, skipTaskbar: true,
      autoHideMenuBar: true, webPreferences: { preload: preloadPath, contextIsolation: true, nodeIntegration: false, sandbox: true },
    })
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', (event) => event.preventDefault())
    return window
  }

  #requireMain(event) {
    const main = this.getMainWindow()
    if (!main || main.isDestroyed() || event.sender !== main.webContents) throw new Error('只有本机 ZSense 窗口可以启动全局截图。')
  }

  #requireWindow(event, window) {
    if (!window || window.isDestroyed() || event.sender !== window.webContents) throw new Error('截图窗口已失效。')
  }

  #reportError(error) {
    this.lastError = String(error?.message || error)
    const main = this.getMainWindow()
    if (main && !main.isDestroyed()) main.webContents.send('zsense:global-screenshot:error', this.lastError)
  }

  dispose() {
    const { globalShortcut, ipcMain } = this.runtime
    this.disposed = true
    this.captureGeneration += 1
    ipcMain.removeHandler('zsense:global-screenshot:recheck-permissions')
    ipcMain.removeHandler('zsense:global-screenshot:request-permissions')
    if (this.registered && this.shortcut) globalShortcut.unregister(this.shortcut)
    this.selectionWindow?.destroy()
    this.editorWindow?.destroy()
    for (const window of this.pinnedWindows) window.destroy()
    this.pinnedWindows.clear()
  }
}

export { validShortcut }
