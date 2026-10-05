import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PDFDocument } from 'pdf-lib'
import { readPdfDocument, readPdfDocumentChunk, savePdfDocument, transformPdfPages } from '../electron/services/pdf-document-service.mjs'
import { cloneForRenderer } from '../electron/services/database.mjs'

const read = (file) => fs.readFile(new URL(file, import.meta.url), 'utf8')
const nativeChat = await read('../src/components/NativeChatPage.tsx')
const botChat = await read('../src/components/ChatDialog.tsx')
const pane = await read('../src/components/OfficeArtifactPane.tsx')
const editor = await read('../src/components/PdfDocumentEditor.tsx')
const preload = await read('../electron/preload.cjs')

for (const [name, source] of [['AI 对话', nativeChat], ['Bot 对话', botChat]]) {
  assert(source.includes('setOfficeArtifactPath(filePath)'), `${name}没有在右侧打开 PDF`)
  assert(!source.includes('pdf.openExternally(filePath)'), `${name}仍强制使用系统应用打开 PDF`)
}
assert(pane.includes('<PdfDocumentEditor'), '右侧侧栏缺少 PDF 编辑器')
assert(editor.includes('ScreenshotAnnotationDialog'), 'PDF 划区问 AI 缺少截图批注入口')
assert(editor.includes('onAskAI('), 'PDF 文字选区缺少问 AI 入口')
assert(preload.includes("'zsense:pdf:read-chunk'") && preload.includes("'zsense:pdf:save'"), 'PDF 桌面分块读写接口缺失')
assert(preload.includes("'zsense:pdf:save-as'"), 'PDF 另存为接口缺失')
assert(preload.includes("'zsense:pdf:page-action'"), 'PDF 页面整理接口缺失')
assert(editor.includes('pdf-editor-tabs') && editor.includes("runPageAction('merge')"), 'PDF 功能区缺少页面整理')
assert(editor.includes("id: 'underline'") && editor.includes("id: 'ellipse'"), 'PDF 功能区缺少扩展批注')
assert(editor.includes('pdf-page-input') && editor.includes('pdf-thumb-list'), 'PDF 编辑器缺少跳页输入或缩略图栏')
assert(editor.includes('pdf-editor-find') && editor.includes('pdf-editor-text-hit'), 'PDF 编辑器缺少全文查找与命中高亮')
assert(editor.includes('pdf-editor-ops') && editor.includes('operationLabels'), 'PDF 编辑器缺少待保存修改清单')
assert(editor.includes("save('copy')") && editor.includes('pdf-stale'), 'PDF 编辑器缺少另存为或外部改动刷新入口')
assert(editor.includes("event.metaKey") && editor.includes("=== 'f'"), 'PDF 编辑器缺少查找/撤销/保存快捷键')
assert(editor.includes("addEventListener('wheel', onWheel, { passive: false })") && editor.includes('event.ctrlKey') && editor.includes('event.metaKey'), 'PDF 编辑器缺少 Ctrl/⌘ 加滚轮缩放')
assert(editor.includes('rootRef.current?.contains(target)') && editor.includes("event.key === 'PageDown'") && editor.includes("event.key === 'Home'"), 'PDF 快捷键未限制在 PDF 面板内或缺少基本翻页键')
assert(editor.includes("key === '0'") && editor.includes("event.code === 'NumpadAdd'"), 'PDF 缺少 100% 与数字键盘缩放快捷键')
assert(editor.includes('friendlyPdfError') && editor.includes('密码保护'), 'PDF 编辑器缺少友好错误提示')

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'zsense-pdf-smoke-'))
try {
  const filePath = path.join(directory, 'sample.pdf')
  const source = await PDFDocument.create()
  source.addPage([400, 500])
  await fs.writeFile(filePath, await source.save())
  const opened = await readPdfDocument(filePath)
  assert(opened.size > 0)
  const sourceChunk = await readPdfDocumentChunk({ filePath, expectedModifiedAt: opened.modifiedAt, offset: 0, length: opened.size })
  assert.equal(sourceChunk.byteLength, opened.size)
  assert(cloneForRenderer(sourceChunk) instanceof Uint8Array, 'PDF 数据被 JSON 序列化成巨大的文本对象')
  const saved = await savePdfDocument({ filePath, expectedModifiedAt: opened.modifiedAt, operations: [
    { type: 'highlight', page: 1, x: 20, y: 30, width: 120, height: 20, color: '#fff176' },
    { type: 'rectangle', page: 1, x: 20, y: 70, width: 120, height: 50, color: '#2563eb' },
    { type: 'text', page: 1, x: 22, y: 130, width: 100, height: 30, color: '#111827', fontSize: 16, text: 'Local PDF' },
  ] })
  assert(saved.size > opened.size, '保存未修改 PDF')
  const next = await readPdfDocument(filePath)
  const parsed = await PDFDocument.load(await readPdfDocumentChunk({ filePath, expectedModifiedAt: next.modifiedAt, offset: 0, length: next.size }))
  assert.equal(parsed.getPageCount(), 1)

  const beforeBackup = await fs.readFile(filePath)
  const current = await readPdfDocument(filePath)
  const withBackup = await savePdfDocument({ filePath, expectedModifiedAt: current.modifiedAt, backupDirectory: path.join(directory, 'backups'), operations: [
    { type: 'highlight', page: 1, x: 10, y: 10, width: 60, height: 14, color: '#fff176' },
  ] })
  assert(withBackup.backupPath.endsWith('.pdf'), '覆盖保存时没有生成备份文件')
  assert.deepEqual(await fs.readFile(withBackup.backupPath), beforeBackup, '备份内容不是保存前的原始文件')
  assert.equal(withBackup.filePath, await fs.realpath(filePath), '覆盖保存应写回原文件')

  const original = await fs.readFile(filePath)
  const copyPath = path.join(directory, 'copy.pdf')
  const copied = await savePdfDocument({ filePath, expectedModifiedAt: withBackup.modifiedAt, targetFilePath: copyPath, operations: [
    { type: 'rectangle', page: 1, x: 30, y: 40, width: 80, height: 30, color: '#2563eb' },
  ] })
  assert.equal(copied.filePath, path.resolve(copyPath), '另存为没有写到目标路径')
  assert.equal(copied.backupPath, '', '另存为不应该产生原文件备份')
  assert.deepEqual(await fs.readFile(filePath), original, '另存为不应该改动原文件')
  assert((await fs.stat(copyPath)).size > 0, '另存为产物为空')
  await assert.rejects(() => savePdfDocument({ filePath, expectedModifiedAt: opened.modifiedAt, operations: [{ type: 'cover', page: 1, x: 0, y: 0, width: 10, height: 10 }] }), /已被其他程序修改/)
  const pagesPath = path.join(directory, 'pages.pdf')
  const pages = await PDFDocument.create()
  pages.addPage([300, 400]); pages.addPage([400, 500]); pages.addPage([500, 600])
  await fs.writeFile(pagesPath, await pages.save())
  const pageSizes = async () => (await PDFDocument.load(await fs.readFile(pagesPath))).getPages().map((item) => item.getWidth())
  let version = (await readPdfDocument(pagesPath)).modifiedAt
  const run = async (action, page, extra = {}) => {
    const result = await transformPdfPages({ filePath: pagesPath, expectedModifiedAt: version, action, page, backupDirectory: path.join(directory, 'page-backups'), ...extra })
    if (!extra.targetFilePath) version = result.modifiedAt
    return result
  }
  await run('moveDown', 1)
  assert.deepEqual(await pageSizes(), [400, 300, 500], '页面后移未保持内容顺序')
  await run('moveUp', 2)
  assert.deepEqual(await pageSizes(), [300, 400, 500], '页面前移未保持内容顺序')
  await run('duplicate', 2)
  assert.deepEqual(await pageSizes(), [300, 400, 400, 500], '复制页没有插在当前页后')
  await run('rotateRight', 1)
  assert.equal((await PDFDocument.load(await fs.readFile(pagesPath))).getPage(0).getRotation().angle, 90, '旋转没有写入 PDF')
  await run('insertBlank', 1)
  assert.deepEqual(await pageSizes(), [300, 300, 400, 400, 500], '空白页尺寸或顺序错误')
  await run('delete', 2)
  assert.deepEqual(await pageSizes(), [300, 400, 400, 500], '删除页没有生效')
  const insertedPath = path.join(directory, 'inserted.pdf')
  const inserted = await PDFDocument.create(); inserted.addPage([700, 800]); await fs.writeFile(insertedPath, await inserted.save())
  await run('merge', 2, { insertFilePath: insertedPath })
  assert.deepEqual(await pageSizes(), [300, 400, 700, 400, 500], '合并 PDF 没有插在当前页后')
  const extractPath = path.join(directory, 'extracted.pdf')
  await run('extract', 3, { targetFilePath: extractPath })
  assert.equal((await PDFDocument.load(await fs.readFile(extractPath))).getPageCount(), 1, '提取页没有生成单页 PDF')
  assert.deepEqual(await pageSizes(), [300, 400, 700, 400, 500], '提取页不应改动原文件')
  await assert.rejects(() => run('extract', 1, { targetFilePath: pagesPath }), /不能覆盖当前 PDF/)
  await assert.rejects(() => run('delete', 999), /页码无效/)
  const annotated = await run('rotateLeft', 1)
  assert(annotated.backupPath.endsWith('.pdf'), '页面操作没有生成备份')
  version = annotated.modifiedAt
  await savePdfDocument({ filePath: pagesPath, expectedModifiedAt: version, operations: [
    { type: 'underline', page: 1, x: 20, y: 20, width: 80, height: 10, color: '#ef4444' },
    { type: 'strikeout', page: 1, x: 20, y: 35, width: 80, height: 10, color: '#ef4444' },
    { type: 'ellipse', page: 1, x: 20, y: 55, width: 80, height: 35, color: '#2563eb' },
    { type: 'line', page: 1, x: 20, y: 105, width: 80, height: 35, color: '#2563eb' },
  ] })
  console.log(JSON.stringify({ ok: true, engine: 'local-pdfjs-and-pdf-lib', sidePane: true, editable: true, askAI: true, pageJump: true, thumbnails: true, find: true, saveAs: true, backup: true, pageTools: true, extendedAnnotations: true, shortcuts: true, friendlyErrors: true }))
} finally { await fs.rm(directory, { recursive: true, force: true }) }
