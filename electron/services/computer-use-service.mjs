import { clipboard, desktopCapturer, screen, systemPreferences } from 'electron'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const MAX_SCREENSHOT_EDGE = 2048
const MAX_TYPED_CHARACTERS = 20_000

const MAC_KEY_CODES = Object.freeze({
  ENTER: 36, TAB: 48, SPACE: 49, BACKSPACE: 51, ESCAPE: 53,
  META: 55, SHIFT: 56, ALT: 58, CTRL: 59,
  F1: 122, F2: 120, F3: 99, F4: 118, F5: 96, F6: 97,
  F7: 98, F8: 100, F9: 101, F10: 109, F11: 103, F12: 111,
  HOME: 115, PAGEUP: 116, DELETE: 117, END: 119, PAGEDOWN: 121,
  ARROWLEFT: 123, ARROWRIGHT: 124, ARROWDOWN: 125, ARROWUP: 126,
})

const WINDOWS_KEYS = Object.freeze({
  ENTER: '{ENTER}', TAB: '{TAB}', SPACE: ' ', BACKSPACE: '{BACKSPACE}', ESCAPE: '{ESC}', DELETE: '{DELETE}',
  HOME: '{HOME}', END: '{END}', PAGEUP: '{PGUP}', PAGEDOWN: '{PGDN}',
  ARROWLEFT: '{LEFT}', ARROWRIGHT: '{RIGHT}', ARROWDOWN: '{DOWN}', ARROWUP: '{UP}',
  F1: '{F1}', F2: '{F2}', F3: '{F3}', F4: '{F4}', F5: '{F5}', F6: '{F6}',
  F7: '{F7}', F8: '{F8}', F9: '{F9}', F10: '{F10}', F11: '{F11}', F12: '{F12}',
})

function integer(value, label) {
  const result = Math.round(Number(value))
  if (!Number.isFinite(result)) throw new Error(`${label}必须是有效数字。`)
  return result
}

function normalizedChord(value) {
  const parts = String(value || '').trim().toUpperCase().split('+').map((item) => item.trim()).filter(Boolean)
  if (!parts.length || parts.length > 5) throw new Error('按键组合无效。')
  const key = parts.at(-1)
  const modifiers = [...new Set(parts.slice(0, -1).map((item) => ({ CONTROL: 'CTRL', COMMAND: 'META', CMD: 'META', OPTION: 'ALT' })[item] || item))]
  if (modifiers.some((item) => !['CTRL', 'SHIFT', 'ALT', 'META'].includes(item))) throw new Error('按键组合包含不支持的修饰键。')
  if (!MAC_KEY_CODES[key] && !/^[A-Z0-9]$/.test(key)) throw new Error('按键组合包含不支持的按键。')
  return { key, modifiers }
}

function macModifierList(modifiers) {
  const labels = { CTRL: 'control down', SHIFT: 'shift down', ALT: 'option down', META: 'command down' }
  return modifiers.length ? ` using {${modifiers.map((item) => labels[item]).join(', ')}}` : ''
}

function windowsSendKeys({ key, modifiers }) {
  const prefixes = { CTRL: '^', SHIFT: '+', ALT: '%', META: '^' }
  const value = WINDOWS_KEYS[key] || key.toLowerCase()
  return `${modifiers.map((item) => prefixes[item]).join('')}${value}`
}

function scaledThumbnailSize(display) {
  const pixelWidth = Math.max(1, Math.round(display.size.width * (display.scaleFactor || 1)))
  const pixelHeight = Math.max(1, Math.round(display.size.height * (display.scaleFactor || 1)))
  const ratio = Math.min(1, MAX_SCREENSHOT_EDGE / Math.max(pixelWidth, pixelHeight))
  return { width: Math.max(1, Math.round(pixelWidth * ratio)), height: Math.max(1, Math.round(pixelHeight * ratio)) }
}

export class ComputerUseService {
  constructor({ dryRun = false } = {}) {
    this.dryRun = Boolean(dryRun)
  }

  supported() { return ['darwin', 'win32'].includes(process.platform) }

  inspect(enabled = false) {
    const mac = process.platform === 'darwin'
    return {
      supported: this.supported(),
      enabled: Boolean(enabled),
      platform: process.platform,
      screenCapturePermission: mac ? systemPreferences.getMediaAccessStatus('screen') : this.supported() ? 'granted' : 'unsupported',
      accessibilityPermission: mac ? (systemPreferences.isTrustedAccessibilityClient(false) ? 'granted' : 'denied') : this.supported() ? 'granted' : 'unsupported',
      dryRun: this.dryRun,
      checkedAt: new Date().toISOString(),
    }
  }

  async requestPermissions(enabled = false) {
    if (!this.supported()) return this.inspect(enabled)
    if (process.platform === 'darwin') {
      systemPreferences.isTrustedAccessibilityClient(true)
      try { await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 2, height: 2 } }) }
      catch { /* The returned status below explains denied screen recording access. */ }
    }
    return this.inspect(enabled)
  }

  screenInfo() {
    if (!this.supported()) throw new Error('Computer Use 目前只支持 macOS 和 Windows。')
    const primaryId = screen.getPrimaryDisplay().id
    const cursor = screen.getCursorScreenPoint()
    return {
      coordinateSpace: 'global-dip',
      cursor: { x: cursor.x, y: cursor.y },
      displays: screen.getAllDisplays().map((display) => ({
        id: String(display.id),
        primary: display.id === primaryId,
        bounds: { ...display.bounds },
        workArea: { ...display.workArea },
        scaleFactor: display.scaleFactor,
        rotation: display.rotation,
      })),
    }
  }

  #display(value) {
    const displays = screen.getAllDisplays()
    const requested = String(value || '')
    const display = requested ? displays.find((item) => String(item.id) === requested) : screen.getPrimaryDisplay()
    if (!display) throw new Error('没有找到指定显示器，请先调用 computer_screen_info。')
    return display
  }

  #assertPoint(xValue, yValue) {
    const x = integer(xValue, '横坐标')
    const y = integer(yValue, '纵坐标')
    const display = screen.getDisplayNearestPoint({ x, y })
    const { bounds } = display
    if (x < bounds.x || y < bounds.y || x >= bounds.x + bounds.width || y >= bounds.y + bounds.height) throw new Error('点击坐标不在任何可用显示器内。')
    return { x, y, displayId: String(display.id) }
  }

  async screenshot(displayId = '') {
    if (!this.supported()) throw new Error('Computer Use 目前只支持 macOS 和 Windows。')
    const display = this.#display(displayId)
    const thumbnailSize = scaledThumbnailSize(display)
    if (this.dryRun) return {
      summary: `Dry-run：已截取显示器 ${display.id}，桌面坐标 ${display.bounds.x},${display.bounds.y}，大小 ${display.bounds.width}×${display.bounds.height}。`,
      displayId: String(display.id), bounds: { ...display.bounds }, imageSize: thumbnailSize,
      __zsenseImage: { url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', name: 'computer-screen.png' },
    }
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize, fetchWindowIcons: false })
    const source = sources.find((item) => String(item.display_id) === String(display.id)) || sources[screen.getAllDisplays().findIndex((item) => item.id === display.id)]
    if (!source || source.thumbnail.isEmpty()) throw new Error('没有取得屏幕画面。请在系统设置中允许 ZSense 录制屏幕后重试。')
    const imageSize = source.thumbnail.getSize()
    return {
      summary: `已截取显示器 ${display.id}。图像 ${imageSize.width}×${imageSize.height}；对应全局桌面坐标 x=${display.bounds.x}..${display.bounds.x + display.bounds.width - 1}，y=${display.bounds.y}..${display.bounds.y + display.bounds.height - 1}。后续点击请使用全局桌面坐标。`,
      displayId: String(display.id), bounds: { ...display.bounds }, imageSize,
      __zsenseImage: { url: source.thumbnail.toDataURL(), name: `computer-screen-${display.id}.png` },
    }
  }

  async #runMacAppleScript(script) {
    await execFileAsync('/usr/bin/osascript', ['-e', script], { timeout: 15_000, windowsHide: true, maxBuffer: 256 * 1024 })
  }

  async #runMacJxa(script, args = []) {
    await execFileAsync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script, '--', ...args.map(String)], { timeout: 15_000, windowsHide: true, maxBuffer: 256 * 1024 })
  }

  async #runPowerShell(script) {
    await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 15_000, windowsHide: true, maxBuffer: 256 * 1024 })
  }

  #assertControlPermission() {
    if (!this.supported()) throw new Error('Computer Use 目前只支持 macOS 和 Windows。')
    if (this.dryRun) return
    if (process.platform === 'darwin' && !systemPreferences.isTrustedAccessibilityClient(false)) throw new Error('ZSense 尚未获得辅助功能权限。请到“系统设置 → 隐私与安全性 → 辅助功能”中允许 ZSense。')
  }

  async click(xValue, yValue, button = 'left', count = 1) {
    this.#assertControlPermission()
    const point = this.#assertPoint(xValue, yValue)
    const normalizedButton = button === 'right' ? 'right' : 'left'
    const normalizedCount = Math.max(1, Math.min(2, integer(count || 1, '点击次数')))
    if (!this.dryRun) {
      if (process.platform === 'darwin') {
        const clickCommand = normalizedButton === 'right' ? 'perform action "AXShowMenu" of process 1' : `click at {${point.x}, ${point.y}}`
        if (normalizedButton === 'right') {
          const script = `ObjC.import('CoreGraphics'); function run(argv){ const x=Number(argv[0]), y=Number(argv[1]); const p=$.CGPointMake(x,y); const d=$.CGEventCreateMouseEvent(null,$.kCGEventRightMouseDown,p,$.kCGMouseButtonRight); const u=$.CGEventCreateMouseEvent(null,$.kCGEventRightMouseUp,p,$.kCGMouseButtonRight); $.CGEventPost($.kCGHIDEventTap,d); $.CGEventPost($.kCGHIDEventTap,u); }`
          for (let index = 0; index < normalizedCount; index += 1) await this.#runMacJxa(script, [point.x, point.y])
        } else {
          for (let index = 0; index < normalizedCount; index += 1) await this.#runMacAppleScript(`tell application "System Events" to ${clickCommand}`)
        }
      } else {
        const downFlag = normalizedButton === 'right' ? '0x0008' : '0x0002'
        const upFlag = normalizedButton === 'right' ? '0x0010' : '0x0004'
        await this.#runPowerShell(`Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class ZSenseMouse { [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y); [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, int data, UIntPtr extra); }'; [ZSenseMouse]::SetCursorPos(${point.x},${point.y}) | Out-Null; 1..${normalizedCount} | ForEach-Object { [ZSenseMouse]::mouse_event(${downFlag},0,0,0,[UIntPtr]::Zero); [ZSenseMouse]::mouse_event(${upFlag},0,0,0,[UIntPtr]::Zero) }`)
      }
    }
    return { clicked: true, ...point, button: normalizedButton, count: normalizedCount, dryRun: this.dryRun }
  }

  async scroll(direction = 'down', amountValue = 640) {
    this.#assertControlPermission()
    const amount = Math.max(80, Math.min(2400, integer(amountValue || 640, '滚动距离')))
    const delta = direction === 'up' ? amount : -amount
    if (!this.dryRun) {
      if (process.platform === 'darwin') {
        const script = `ObjC.import('CoreGraphics'); function run(argv){ const delta=Number(argv[0]); const e=$.CGEventCreateScrollWheelEvent(null,$.kCGScrollEventUnitPixel,1,delta); $.CGEventPost($.kCGHIDEventTap,e); }`
        await this.#runMacJxa(script, [delta])
      } else {
        await this.#runPowerShell(`Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class ZSenseWheel { [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, int data, UIntPtr extra); }'; [ZSenseWheel]::mouse_event(0x0800,0,0,${delta},[UIntPtr]::Zero)`)
      }
    }
    return { scrolled: true, direction: direction === 'up' ? 'up' : 'down', amount, dryRun: this.dryRun }
  }

  async key(chordValue) {
    this.#assertControlPermission()
    const chord = normalizedChord(chordValue)
    if (!this.dryRun) {
      if (process.platform === 'darwin') {
        const modifiers = macModifierList(chord.modifiers)
        if (MAC_KEY_CODES[chord.key]) await this.#runMacAppleScript(`tell application "System Events" to key code ${MAC_KEY_CODES[chord.key]}${modifiers}`)
        else await this.#runMacAppleScript(`tell application "System Events" to keystroke "${chord.key.toLowerCase()}"${modifiers}`)
      } else {
        const encoded = Buffer.from(windowsSendKeys(chord), 'utf8').toString('base64')
        await this.#runPowerShell(`Add-Type -AssemblyName System.Windows.Forms; $v=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')); [System.Windows.Forms.SendKeys]::SendWait($v)`)
      }
    }
    return { pressed: true, chord: [...chord.modifiers, chord.key].join('+'), dryRun: this.dryRun }
  }

  async type(value) {
    this.#assertControlPermission()
    const text = String(value ?? '')
    if (!text || text.length > MAX_TYPED_CHARACTERS) throw new Error(`单次输入必须为 1–${MAX_TYPED_CHARACTERS.toLocaleString()} 个字符。`)
    if (!this.dryRun) {
      const previous = clipboard.readText()
      clipboard.writeText(text)
      try {
        await this.key(process.platform === 'darwin' ? 'META+V' : 'CTRL+V')
        await new Promise((resolve) => setTimeout(resolve, 120))
      } finally {
        clipboard.writeText(previous)
      }
    }
    return { typed: true, characters: text.length, dryRun: this.dryRun }
  }

  shutdown() {}
}

export { normalizedChord, scaledThumbnailSize, windowsSendKeys }
