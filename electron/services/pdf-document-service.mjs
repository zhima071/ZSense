import fs from 'node:fs/promises'
import path from 'node:path'
import { degrees, PDFDocument, rgb, StandardFonts } from 'pdf-lib'

const MAX_EDIT_BYTES = 80 * 1024 * 1024
const MAX_OPERATIONS = 500
const PAGE_ACTIONS = new Set(['rotateLeft', 'rotateRight', 'delete', 'duplicate', 'moveUp', 'moveDown', 'insertBlank', 'extract', 'merge'])

async function resolvePdf(filePath) {
  if (typeof filePath !== 'string' || !filePath.trim()) throw new Error('请选择 PDF 文件。')
  const resolved = await fs.realpath(path.resolve(filePath))
  if (path.extname(resolved).toLowerCase() !== '.pdf') throw new Error('只能编辑 PDF 文件。')
  const stats = await fs.stat(resolved)
  if (!stats.isFile() || !stats.size || stats.size > MAX_EDIT_BYTES) throw new Error('PDF 必须是非空文件且不超过 80 MB。')
  const file = await fs.open(resolved, 'r')
  try {
    const signature = Buffer.alloc(5)
    await file.read(signature, 0, 5, 0)
    if (signature.toString('ascii') !== '%PDF-') throw new Error('文件内容不是有效的 PDF。')
  } finally { await file.close() }
  return { filePath: resolved, stats }
}

function bounded(value, label, maximum = 100_000) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > maximum) throw new Error(`${label}超出范围。`)
  return value
}

function color(value) {
  if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value)) throw new Error('PDF 标注颜色无效。')
  return rgb(...[1, 3, 5].map((index) => Number.parseInt(value.slice(index, index + 2), 16) / 255))
}

function operationGeometry(operation, page) {
  const { width, height } = page.getSize()
  const x = bounded(operation.x, '横坐标', width)
  const y = bounded(operation.y, '纵坐标', height)
  const w = bounded(operation.width ?? 0, '宽度', width)
  const h = bounded(operation.height ?? 0, '高度', height)
  if (x + w > width + 1 || y + h > height + 1) throw new Error('编辑区域超出 PDF 页面。')
  return { x, y: height - y - h, width: w, height: h }
}

const BACKUP_KEEP = 20

// 保存前把原文件复制到应用数据目录留档；同名文件只保留最近 BACKUP_KEEP 份。
export async function writePdfBackup(filePath, directory) {
  if (!directory) return ''
  const resolved = await fs.realpath(path.resolve(filePath))
  const stats = await fs.stat(resolved)
  await fs.mkdir(directory, { recursive: true })
  const stamp = new Date(stats.mtimeMs).toISOString().replace(/[:.]/g, '-')
  const base = path.basename(resolved, path.extname(resolved))
  const target = path.join(directory, `${base}-${stamp}.pdf`)
  await fs.copyFile(resolved, target)
  const entries = (await fs.readdir(directory)).filter((name) => name.startsWith(`${base}-`) && name.endsWith('.pdf')).sort()
  for (const stale of entries.slice(0, Math.max(0, entries.length - BACKUP_KEEP))) {
    await fs.unlink(path.join(directory, stale)).catch(() => undefined)
  }
  return target
}

export async function readPdfDocument(filePath) {
  const resolved = await resolvePdf(filePath)
  return { modifiedAt: resolved.stats.mtimeMs, size: resolved.stats.size }
}

export async function readPdfDocumentChunk({ filePath, expectedModifiedAt, offset, length }) {
  const resolved = await resolvePdf(filePath)
  if (resolved.stats.mtimeMs !== expectedModifiedAt) throw new Error('PDF 已被其他程序修改。请刷新后重新打开。')
  if (!Number.isInteger(offset) || offset < 0 || offset >= resolved.stats.size) throw new Error('PDF 分块读取位置无效。')
  if (!Number.isInteger(length) || length < 1 || length > 2 * 1024 * 1024 || offset + length > resolved.stats.size) throw new Error('PDF 分块读取长度无效。')
  const buffer = Buffer.allocUnsafe(length)
  const file = await fs.open(resolved.filePath, 'r')
  try {
    let total = 0
    while (total < length) {
      const { bytesRead } = await file.read(buffer, total, length - total, offset + total)
      if (!bytesRead) throw new Error('PDF 读取中断，请重新打开。')
      total += bytesRead
    }
  } finally { await file.close() }
  return new Uint8Array(buffer)
}

export async function savePdfDocument({ filePath, expectedModifiedAt, operations, targetFilePath = '', backupDirectory = '' }) {
  const resolved = await resolvePdf(filePath)
  if (resolved.stats.mtimeMs !== expectedModifiedAt) throw new Error('PDF 已被其他程序修改。请先刷新，确认内容后再保存。')
  if (!Array.isArray(operations) || !operations.length || operations.length > MAX_OPERATIONS) throw new Error('本次 PDF 编辑操作数量无效。')
  const original = await fs.readFile(resolved.filePath)
  const document = await PDFDocument.load(original, { ignoreEncryption: false })
  const font = await document.embedFont(StandardFonts.Helvetica)
  for (const operation of operations) {
    if (!operation || typeof operation !== 'object') throw new Error('PDF 编辑操作无效。')
    const pageIndex = Number(operation.page) - 1
    if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= document.getPageCount()) throw new Error('PDF 页码无效。')
    const page = document.getPage(pageIndex)
    const geometry = operationGeometry(operation, page)
    if (operation.type === 'highlight') {
      page.drawRectangle({ ...geometry, color: color(operation.color || '#fff176'), opacity: .35 })
    } else if (operation.type === 'underline' || operation.type === 'strikeout') {
      const lineY = geometry.y + (operation.type === 'underline' ? Math.max(1, geometry.height * .08) : geometry.height * .5)
      page.drawLine({ start: { x: geometry.x, y: lineY }, end: { x: geometry.x + geometry.width, y: lineY }, color: color(operation.color || '#ef4444'), thickness: bounded(operation.strokeWidth ?? 2, '线宽', 20) })
    } else if (operation.type === 'rectangle') {
      page.drawRectangle({ ...geometry, borderColor: color(operation.color || '#2563eb'), borderWidth: bounded(operation.strokeWidth ?? 2, '线宽', 20) })
    } else if (operation.type === 'ellipse') {
      page.drawEllipse({ x: geometry.x + geometry.width / 2, y: geometry.y + geometry.height / 2, xScale: geometry.width / 2, yScale: geometry.height / 2, borderColor: color(operation.color || '#2563eb'), borderWidth: bounded(operation.strokeWidth ?? 2, '线宽', 20) })
    } else if (operation.type === 'line') {
      page.drawLine({ start: { x: geometry.x, y: geometry.y + geometry.height }, end: { x: geometry.x + geometry.width, y: geometry.y }, color: color(operation.color || '#2563eb'), thickness: bounded(operation.strokeWidth ?? 2, '线宽', 20) })
    } else if (operation.type === 'cover') {
      // This visually covers content, but does not remove underlying PDF text or images.
      page.drawRectangle({ ...geometry, color: rgb(1, 1, 1) })
    } else if (operation.type === 'text') {
      const size = bounded(operation.fontSize ?? 16, '字号', 100)
      const text = String(operation.text || '').slice(0, 2_000)
      if (!text.trim()) throw new Error('插入的文字不能为空。')
      if (operation.pngDataUrl) {
        if (typeof operation.pngDataUrl !== 'string' || !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(operation.pngDataUrl) || operation.pngDataUrl.length > 2_000_000) throw new Error('文字图像格式无效。')
        const image = await document.embedPng(operation.pngDataUrl)
        page.drawImage(image, { ...geometry })
      } else {
        if (!/^[\x20-\x7e\n]+$/.test(text)) throw new Error('非拉丁文字需要先转换为本地图像。')
        page.drawText(text, { x: geometry.x, y: geometry.y + geometry.height - size, size, font, color: color(operation.color || '#111827'), lineHeight: size * 1.3 })
      }
    } else throw new Error('不支持的 PDF 编辑操作。')
  }
  const output = await document.save()
  return writePdfOutput({ resolved, expectedModifiedAt, output, targetFilePath, backupDirectory })
}

async function writePdfOutput({ resolved, expectedModifiedAt, output, targetFilePath = '', backupDirectory = '' }) {
  const destination = targetFilePath ? path.resolve(targetFilePath) : resolved.filePath
  if (targetFilePath && (destination === resolved.filePath || await fs.realpath(destination).catch(() => '') === resolved.filePath)) throw new Error('另存目标不能覆盖当前 PDF。')
  if (output.length > MAX_EDIT_BYTES) throw new Error('编辑后的 PDF 超过 80 MB，未写入文件。请拆分后再编辑。')
  const backupPath = targetFilePath ? '' : await writePdfBackup(resolved.filePath, backupDirectory)
  const temporary = path.join(path.dirname(destination), `.${path.basename(destination)}.zsense-${process.pid}-${Date.now()}.tmp`)
  try {
    await fs.writeFile(temporary, output, { mode: resolved.stats.mode })
    if (!targetFilePath) {
      const latest = await fs.stat(resolved.filePath)
      if (latest.mtimeMs !== expectedModifiedAt || latest.size !== resolved.stats.size) throw new Error('PDF 保存前已被其他程序修改，未覆盖原文件。')
    }
    await fs.rename(temporary, destination)
  } finally { await fs.unlink(temporary).catch(() => undefined) }
  const saved = await fs.stat(destination)
  return { modifiedAt: saved.mtimeMs, size: saved.size, filePath: destination, backupPath }
}

export async function transformPdfPages({ filePath, expectedModifiedAt, action, page, insertFilePath = '', targetFilePath = '', backupDirectory = '' }) {
  if (!PAGE_ACTIONS.has(action)) throw new Error('不支持的 PDF 页面操作。')
  const resolved = await resolvePdf(filePath)
  if (resolved.stats.mtimeMs !== expectedModifiedAt) throw new Error('PDF 已被其他程序修改。请刷新后再操作页面。')
  const document = await PDFDocument.load(await fs.readFile(resolved.filePath), { ignoreEncryption: false })
  const index = Number(page) - 1
  if (!Number.isInteger(index) || index < 0 || index >= document.getPageCount()) throw new Error('PDF 页码无效。')
  if (action === 'rotateLeft' || action === 'rotateRight') {
    const target = document.getPage(index)
    target.setRotation(degrees((target.getRotation().angle + (action === 'rotateLeft' ? 270 : 90)) % 360))
  } else if (action === 'delete') {
    if (document.getPageCount() === 1) throw new Error('PDF 至少要保留一页。')
    document.removePage(index)
  } else if (action === 'duplicate') {
    const [copy] = await document.copyPages(document, [index])
    document.insertPage(index + 1, copy)
  } else if (action === 'moveUp' || action === 'moveDown') {
    const destination = index + (action === 'moveUp' ? -1 : 1)
    if (destination < 0 || destination >= document.getPageCount()) throw new Error('当前页已经在边界位置。')
    const target = document.getPage(index)
    document.removePage(index)
    document.insertPage(destination, target)
  } else if (action === 'insertBlank') {
    const source = document.getPage(index)
    const { width, height } = source.getSize()
    document.insertPage(index + 1, [width, height])
  } else if (action === 'extract') {
    if (!targetFilePath) throw new Error('请选择提取页的保存位置。')
    const extracted = await PDFDocument.create()
    const [copy] = await extracted.copyPages(document, [index])
    extracted.addPage(copy)
    return writePdfOutput({ resolved, expectedModifiedAt, output: await extracted.save(), targetFilePath })
  } else if (action === 'merge') {
    if (!insertFilePath) throw new Error('请选择要合并的 PDF。')
    const incoming = await resolvePdf(insertFilePath)
    if (incoming.filePath === resolved.filePath) throw new Error('不能把 PDF 与自身合并。')
    const external = await PDFDocument.load(await fs.readFile(incoming.filePath), { ignoreEncryption: false })
    const copied = await document.copyPages(external, external.getPageIndices())
    copied.forEach((copy, offset) => document.insertPage(index + 1 + offset, copy))
  }
  return writePdfOutput({ resolved, expectedModifiedAt, output: await document.save(), backupDirectory })
}
