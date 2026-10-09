import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { app, BrowserWindow, ClipboardItem, clipboard } from 'electron'
import { GlobalScreenshotService, validShortcut } from '../electron/services/global-screenshot-service.mjs'

const read = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')

assert.equal(validShortcut('CommandOrControl+Shift+8'), true)
assert.equal(validShortcut('CommandOrControl+Alt+Shift+F12'), true)
assert.equal(validShortcut('A'), false)
assert.equal(validShortcut('CommandOrControl+Shift+8+8'), false)
assert.ok(new ClipboardItem({ 'image/png': new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' }) }).types.includes('image/png'))

const serviceCode = read('electron/services/global-screenshot-service.mjs')
const overlayCode = read('electron/global-screenshot-ui.js')
const overlayHtml = read('electron/global-screenshot.html')
const preloadCode = read('electron/preload.cjs')
const settingsCode = read('src/components/GlobalScreenshotSettings.tsx')
for (const marker of ['desktopCapturer.getSources', "request?.action === 'copy'", "request?.action === 'download'", "request?.action === 'pin'", 'clipboard.write([new ClipboardItem', 'globalShortcut.register', 'will-navigate']) {
  assert.ok(serviceCode.includes(marker), `主进程缺少 ${marker}`)
}
for (const marker of ['data-tool="ellipse"', 'data-tool="text"', 'id="pin"', 'id="copy"', 'id="download"', 'id="select-close"']) {
  assert.ok(overlayHtml.includes(marker), `截图窗口缺少 ${marker}`)
}
assert.ok(overlayCode.includes('canvas.toDataURL') && overlayCode.includes('setPointerCapture'), '批注必须基于实际画布输出')
assert.ok(preloadCode.includes('zsense:global-screenshot:start') && settingsCode.includes('录制全局截图快捷键'), '设置页必须可启动截图并自定义快捷键')
console.log('Global screenshot module, shortcut validation and UI wiring checks passed.')

// Run with --interactive on a logged-in desktop session to exercise real screen capture.
if (process.argv.includes('--interactive')) {
  const temporaryData = fs.mkdtempSync(path.join(os.tmpdir(), 'zsense-global-shot-'))
  app.setPath('userData', temporaryData)
  await Promise.race([
    app.whenReady(),
    new Promise((_resolve, reject) => setTimeout(() => reject(new Error('图形会话在 20 秒内未就绪。')), 20_000)),
  ])
  const main = new BrowserWindow({ show: false })
  const service = new GlobalScreenshotService({ app, getMainWindow: () => main })
  try {
    service.initialize()
    service.setShortcut('')
    assert.equal(JSON.parse(fs.readFileSync(path.join(temporaryData, 'global-screenshot.json'), 'utf8')).shortcut, '')
    assert.throws(() => service.setShortcut('Shift+A'), /Ctrl|Shift/)
    await Promise.race([
      service.start(),
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error('屏幕录制授权或画面捕获在 20 秒内未完成。')), 20_000)),
    ])
    assert.ok(service.selectionWindow?.isVisible(), '框选窗口应显示在桌面上')
    try {
      await service.selectionWindow.webContents.executeJavaScript('window.zsenseShot.select({ x: 12, y: 12, width: 320, height: 220 })')
    } catch (error) {
      if (!service.editorWindow) throw error
    }
    assert.ok(service.editorWindow?.isVisible(), '框选后应打开批注编辑器')
    const editor = service.editorWindow
    const dataUrl = await editor.webContents.executeJavaScript('document.querySelector("#editor-canvas").toDataURL("image/png")')
    const copy = await editor.webContents.executeJavaScript(`window.zsenseShot.output('copy', ${JSON.stringify(dataUrl)})`)
    assert.equal(copy.copied, true)
    assert.equal(await clipboard.has('image/png'), true, '✅ 应复制 PNG 到系统剪贴板')
    console.log('Interactive crop, editor and clipboard checks passed.')
  } finally {
    service.dispose()
    if (!main.isDestroyed()) main.destroy()
    app.quit()
  }
}
else app.quit()
