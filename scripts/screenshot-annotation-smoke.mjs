import assert from 'node:assert/strict'
import fs from 'node:fs'

const read = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
const annotation = read('src/components/ScreenshotAnnotationDialog.tsx')
const browser = read('src/components/BrowserWorkspacePane.tsx')
const canvas = read('src/components/ZSenseCanvasPane.tsx')
const nativeChat = read('src/components/NativeChatPage.tsx')
const botChat = read('src/components/ChatDialog.tsx')
const preload = read('electron/preload.cjs')
const ipc = read('electron/ipc.mjs')

for (const label of ['画笔', '箭头', '矩形', '文字', '撤销批注', '清空批注', '给 Agent 的要求', '添加到输入框', '发送到当前对话']) {
  assert.ok(annotation.includes(label), `截图批注器缺少 ${label}`)
}
for (const label of ['缩小截图', '放大截图', '适应窗口', 'Ctrl/⌘ + 滚轮']) {
  assert.ok(annotation.includes(label), `截图批注器缺少缩放能力：${label}`)
}
assert.ok(annotation.includes("stage.addEventListener('wheel', onWheel, { passive: false })"), '截图批注器必须支持 Ctrl/⌘ + 鼠标滚轮缩放')
assert.ok(annotation.includes('maximumZoom') && annotation.includes('minimumZoom'), '截图批注器必须限制安全缩放范围')
assert.ok(annotation.includes('resolvePastedAttachments'), '批注结果必须通过会话附件安全落盘')
assert.ok(annotation.includes('workspacePath'), '批注结果必须绑定当前工作区')
assert.ok(browser.includes('Scissors') && browser.includes('captureScreenshot'), '浏览器必须提供剪刀截图入口')
assert.ok(browser.includes('window.zsenseDesktop.browser.capture(sessionId)'), '浏览器必须截取当前会话网页')
assert.ok(canvas.includes('Scissors') && canvas.includes('captureCanvas'), '画布必须提供剪刀截图入口')
assert.ok(canvas.includes('window.zsenseDesktop.screenshot.captureRegion'), '画布必须截取当前可见画布区域')
assert.ok(preload.includes('zsense:browser:capture') && preload.includes('zsense:screenshot:capture-region'), 'preload 必须暴露两类截图通道')
assert.ok(ipc.includes("safeHandle(ipcMain, 'zsense:browser:capture'") && ipc.includes("safeHandle(ipcMain, 'zsense:screenshot:capture-region'"), '主进程必须安全处理截图')
for (const chat of [nativeChat, botChat]) {
  assert.ok(chat.includes('handleAnnotatedScreenshot'), '两类对话都必须接入批注截图回调')
  assert.ok(chat.includes('mergeChatAttachments'), '添加到输入框必须复用现有附件合并逻辑')
  assert.ok(chat.includes('onAnnotatedScreenshot={handleAnnotatedScreenshot}'), '浏览器和画布必须发送到当前对话')
}

console.log('Screenshot annotation smoke checks passed.')
