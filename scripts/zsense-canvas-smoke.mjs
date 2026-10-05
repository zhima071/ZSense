import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { app } from 'electron'
import { ZSenseCanvasService } from '../electron/services/zsense-canvas-service.mjs'

const workspace = mkdtempSync(path.join(os.tmpdir(), 'zsense-canvas-smoke-'))
const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const events = []
const service = new ZSenseCanvasService({ onChanged: (event) => events.push(event) })

const loaded = service.load(workspace)
assert.equal(loaded.document.format, 'zsense-canvas')
assert.equal(loaded.savedAt, '')
loaded.document.pages[0].nodes.push({ id: 'note-1', type: 'note', x: 40, y: 40, width: 220, height: 120, text: '本地画布', fill: '#fef3c7' })
const firstSave = service.save(workspace, loaded.document, { sourceClientId: 'smoke' })
assert.ok(firstSave.savedAt)
assert.equal(service.load(workspace).savedAt, firstSave.savedAt)
assert.equal(service.readForAgent(workspace).nodeCount, 1)

const imagePath = path.join(workspace, 'sample.png')
writeFileSync(imagePath, Buffer.from('89504e470d0a1a0a', 'hex'))
const imported = service.importFile(workspace, imagePath, { sourceClientId: 'smoke', document: firstSave.document, conversationId: 'conversation-a' })
assert.equal(imported.kind, 'image')
assert.equal(imported.existing, false)
assert.equal(imported.document.pages[0].nodes.length, 2)
assert.equal(service.readForAgent(workspace).nodeCount, 1, '导入后必须等待手动保存')
imported.document.pages[0].nodes.push({ ...imported.node, id: 'legacy-duplicate-image' })
const duplicate = service.importFile(workspace, imagePath, { sourceClientId: 'smoke', document: imported.document, conversationId: 'conversation-a' })
assert.equal(duplicate.existing, true)
assert.equal(duplicate.deduplicated, 1)
assert.equal(duplicate.node.id, imported.node.id)
assert.equal(duplicate.document.pages[0].nodes.length, 2)
service.save(workspace, duplicate.document, { sourceClientId: 'smoke' })
assert.equal(service.readForAgent(workspace).nodeCount, 2)

const edited = service.applyOperations(workspace, [{ action: 'update', id: 'note-1', patch: { text: 'AI 已修改' } }])
assert.equal(edited.document.pages[0].nodes.find((node) => node.id === 'note-1')?.text, 'AI 已修改')

const htmlPath = path.join(workspace, 'sample.html')
writeFileSync(htmlPath, '<!doctype html><title>HTML 使用右侧预览</title>')
assert.throws(() => service.importFile(workspace, htmlPath), /HTML 请使用右侧 HTML 预览编辑器/)
const canvasSource = readFileSync(path.join(projectDirectory, 'src', 'components', 'ZSenseCanvasPane.tsx'), 'utf8')
const stylesSource = readFileSync(path.join(projectDirectory, 'src', 'styles.css'), 'utf8')
assert.match(canvasSource, /clamp\(selected\.width \* viewport\.zoom, 320, 420\)/, 'file inspector must adapt to the selected file width')
assert.match(stylesSource, /\.zsense-canvas-file-info dd[^}]*overflow-wrap:\s*anywhere/, 'long file names must wrap instead of being clipped')
assert.match(stylesSource, /\.zsense-canvas-inspector > header strong[^}]*overflow-wrap:\s*anywhere/, 'inspector title must show the complete file name')
assert.match(canvasSource, /feedback && feedbackIsError/, '画布不应继续显示成功导入或保存的右下角提示')
assert.doesNotMatch(canvasSource, /setFeedback\(result\.message\)|画布已手动保存/, '画布成功操作仍会生成不必要的右下角提示')
assert.ok(events.length >= 3)

console.log(JSON.stringify({ ok: true, engine: 'zsense-canvas', tldraw: false, supportedImports: ['image', 'pdf'], htmlRoute: 'right-sidebar-preview' }))
// 画布服务依赖 electron 的 net 模块，必须在 Electron 中运行；测试结束主动退出，避免进程常驻。
app.quit()
