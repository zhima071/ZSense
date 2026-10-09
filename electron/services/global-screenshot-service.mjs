import { BrowserWindow, ClipboardItem, clipboard, desktopCapturer, dialog, globalShortcut, ipcMain, nativeImage, screen } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_SHORTCUT = 'CommandOrControl+Shift+8'
const MAX_IMAGE_BYTES = 60 * 1024 * 1024
const pagePath = fileURLToPath(new URL('../global-screenshot.html', import.meta.url))
const preloadPath = fileURLToPath(new URL('../global-screenshot-preload.cjs', import.meta.url))

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
  constructor({ app, getMainWindow }) {
    this.app = app
    this.getMainWindow = getMainWindow
    this.configPath = path.join(app.getPath('userData'), 'global-screenshot.json')
    this.shortcut = DEFAULT_SHORTCUT
    this.registered = false
    this.lastError = ''
    this.selectionWindow = null
    this.editorWindow = null
    this.pinnedWindows = new Set()
    this.sourceImage = null
    this.display = null
    try {
      const stored = JSON.parse(fs.readFileSync(this.configPath, 'utf8'))
      if (validShortcut(stored.shortcut)) this.shortcut = stored.shortcut
    } catch { /* First launch keeps the default shortcut. */ }
  }

  initialize() {
    if (this.shortcut) {
      this.registered = globalShortcut.register(this.shortcut, () => { void this.start().catch((error) => this.#reportError(error)) })
      if (!this.registered) this.lastError = '快捷键已被系统或其他应用占用；请在设置中更换。'
    }
    ipcMain.handle('zsense:global-screenshot:status', (event) => { this.#requireMain(event); return this.status() })
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

  status() { return { shortcut: this.shortcut, registered: this.registered, error: this.lastError } }

  setShortcut(value) {
    const next = String(value ?? '')
    if (!validShortcut(next)) throw new Error('请使用 Ctrl/⌘ + Shift + 字母、数字或功能键；系统截图快捷键不可覆盖。')
    if (next === this.shortcut) return this.status()
    if (next && !globalShortcut.register(next, () => { void this.start().catch((error) => this.#reportError(error)) })) {
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

  async start() {
    if (this.selectionWindow && !this.selectionWindow.isDestroyed()) { this.selectionWindow.focus(); return }
    if (this.editorWindow && !this.editorWindow.isDestroyed()) { this.editorWindow.focus(); return }
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    const bounds = display.bounds
    const scale = Math.max(1, display.scaleFactor || 1)
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: Math.min(8192, Math.round(bounds.width * scale)), height: Math.min(8192, Math.round(bounds.height * scale)) },
      fetchWindowIcons: false,
    })
    const source = sources.find((item) => String(item.display_id) === String(display.id)) || sources[screen.getAllDisplays().findIndex((item) => item.id === display.id)]
    if (!source || source.thumbnail.isEmpty()) throw new Error('无法读取屏幕。请在系统隐私设置中允许 ZSense 录制屏幕。')
    this.sourceImage = source.thumbnail
    this.display = display
    const window = this.#window({ ...bounds, fullscreenable: false, resizable: false, backgroundColor: '#171411' })
    this.selectionWindow = window
    window.on('closed', () => { if (this.selectionWindow === window) { this.selectionWindow = null; this.sourceImage = null; this.display = null } })
    try {
      await window.loadFile(pagePath, { query: { mode: 'select' } })
      window.webContents.send('zsense:global-screenshot:init', { mode: 'select', image: source.thumbnail.toDataURL(), width: bounds.width, height: bounds.height })
      window.show()
      window.focus()
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
    if (this.registered && this.shortcut) globalShortcut.unregister(this.shortcut)
    this.selectionWindow?.destroy()
    this.editorWindow?.destroy()
    for (const window of this.pinnedWindows) window.destroy()
    this.pinnedWindows.clear()
  }
}

export { validShortcut }
