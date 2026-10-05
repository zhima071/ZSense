import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { net } from 'electron'

const MAX_DOCUMENT_BYTES = 12 * 1024 * 1024
const MAX_IMPORT_BYTES = 40 * 1024 * 1024
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tiff', '.tif', '.svg', '.ico'])
const PDF_EXTENSIONS = new Set(['.pdf'])
const NODE_TYPES = new Set(['rectangle', 'ellipse', 'text', 'note', 'arrow', 'image', 'pdf'])

function now() { return new Date().toISOString() }
function cleanText(value, maximum = 10_000) { return String(value ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').slice(0, maximum) }
function finite(value, fallback = 0, minimum = -1_000_000, maximum = 1_000_000) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.min(maximum, Math.max(minimum, number)) : fallback
}
function safeName(value, fallback = 'asset') {
  const name = path.basename(cleanText(value, 260)).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/^\.+/, '').trim()
  return (name || fallback).slice(0, 180)
}
function inside(root, candidate) { return candidate === root || candidate.startsWith(`${root}${path.sep}`) }
function fileFingerprint(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

function emptyDocument() {
  const createdAt = now()
  return {
    format: 'zsense-canvas', version: 1, id: randomUUID(), title: 'ZSense 画布', createdAt, updatedAt: createdAt,
    activePageId: 'page-1',
    pages: [{ id: 'page-1', name: '页面 1', nodes: [] }],
  }
}

function normalizeNode(value = {}) {
  const type = NODE_TYPES.has(value.type) ? value.type : 'rectangle'
  const node = {
    id: cleanText(value.id || randomUUID(), 180), type,
    x: finite(value.x, 80), y: finite(value.y, 80),
    width: finite(value.width, type === 'text' ? 240 : 260, 24, 20_000),
    height: finite(value.height, type === 'text' ? 72 : 180, 24, 20_000),
    rotation: finite(value.rotation, 0, -3600, 3600),
    text: cleanText(value.text, 40_000),
    fill: cleanText(value.fill || (type === 'note' ? '#fef3c7' : '#ffffff'), 40),
    stroke: cleanText(value.stroke || '#2563eb', 40),
    strokeWidth: finite(value.strokeWidth, 2, 0, 32),
    fontSize: finite(value.fontSize, 18, 8, 240),
    textColor: cleanText(value.textColor || '#172033', 40),
    opacity: finite(value.opacity, 1, 0.05, 1),
    assetPath: cleanText(value.assetPath, 4_000),
    assetName: safeName(value.assetName || value.text || type, type),
    sourceFingerprint: cleanText(value.sourceFingerprint, 128),
    sourcePath: cleanText(value.sourcePath, 4_000),
    sourceConversationId: cleanText(value.sourceConversationId, 240),
    fromX: finite(value.fromX, 0), fromY: finite(value.fromY, 0),
    toX: finite(value.toX, 180), toY: finite(value.toY, 100),
    locked: Boolean(value.locked),
  }
  return node
}

function normalizeDocument(value) {
  if (!value || typeof value !== 'object' || value.format !== 'zsense-canvas') return emptyDocument()
  const pages = (Array.isArray(value.pages) ? value.pages : []).slice(0, 100).map((page, index) => ({
    id: cleanText(page?.id || `page-${index + 1}`, 180),
    name: cleanText(page?.name || `页面 ${index + 1}`, 180),
    nodes: (Array.isArray(page?.nodes) ? page.nodes : []).slice(0, 5_000).map(normalizeNode),
  }))
  if (!pages.length) pages.push({ id: 'page-1', name: '页面 1', nodes: [] })
  const activePageId = pages.some((page) => page.id === value.activePageId) ? value.activePageId : pages[0].id
  return {
    format: 'zsense-canvas', version: 1,
    id: cleanText(value.id || randomUUID(), 180), title: cleanText(value.title || 'ZSense 画布', 240),
    createdAt: cleanText(value.createdAt || now(), 80), updatedAt: cleanText(value.updatedAt || value.createdAt || now(), 80), activePageId, pages,
  }
}

function contentType(extension) {
  return ({
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
    '.bmp': 'image/bmp', '.tiff': 'image/tiff', '.tif': 'image/tiff', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.pdf': 'application/pdf',
  })[extension] || 'application/octet-stream'
}

export class ZSenseCanvasService {
  constructor({ onChanged = () => undefined } = {}) { this.onChanged = onChanged }

  #paths(workspacePath) {
    const workspace = fs.realpathSync.native(path.resolve(workspacePath))
    if (!fs.statSync(workspace).isDirectory()) throw new Error('画布工作区不存在或无法访问。')
    const root = path.join(workspace, '.zsense', 'canvas')
    return { workspace, root, assets: path.join(root, 'assets'), document: path.join(root, 'document.json') }
  }

  load(workspacePath) {
    const paths = this.#paths(workspacePath)
    let document = emptyDocument()
    let savedAt = ''
    try {
      document = normalizeDocument(JSON.parse(fs.readFileSync(paths.document, 'utf8')))
      savedAt = document.updatedAt
    } catch { /* first open */ }
    return { document, storagePath: paths.document, savedAt }
  }

  save(workspacePath, input, { sourceClientId = '' } = {}) {
    const paths = this.#paths(workspacePath)
    const document = normalizeDocument(input)
    document.updatedAt = now()
    const serialized = `${JSON.stringify(document, null, 2)}\n`
    if (Buffer.byteLength(serialized, 'utf8') > MAX_DOCUMENT_BYTES) throw new Error('画布内容超过 12 MB 安全上限。')
    fs.mkdirSync(paths.root, { recursive: true })
    const temporary = `${paths.document}.${process.pid}.tmp`
    fs.writeFileSync(temporary, serialized, { encoding: 'utf8', mode: 0o600 })
    fs.renameSync(temporary, paths.document)
    this.onChanged({ workspacePath: paths.workspace, document, sourceClientId })
    return { document, storagePath: paths.document, savedAt: document.updatedAt }
  }

  importFile(workspacePath, filePath, { sourceClientId = '', document: currentDocument = null, conversationId = '' } = {}) {
    const paths = this.#paths(workspacePath)
    const source = fs.realpathSync.native(path.resolve(filePath))
    const stats = fs.statSync(source)
    if (!stats.isFile()) throw new Error('要加入画布的内容不是文件。')
    if (stats.size > MAX_IMPORT_BYTES) throw new Error('文件超过 40 MB，无法加入画布。')
    const extension = path.extname(source).toLowerCase()
    const type = IMAGE_EXTENSIONS.has(extension) ? 'image' : PDF_EXTENSIONS.has(extension) ? 'pdf' : ''
    if (!type) throw new Error('ZSense 画布目前支持图片和 PDF；HTML 请使用右侧 HTML 预览编辑器打开。')
    const fingerprint = fileFingerprint(source)
    const loaded = currentDocument?.format === 'zsense-canvas'
      ? { document: normalizeDocument(currentDocument) }
      : this.load(paths.workspace)
    const matches = []
    for (const page of loaded.document.pages) {
      for (const existingNode of page.nodes) {
        if (existingNode.type !== type) continue
        if (conversationId && existingNode.sourceConversationId && existingNode.sourceConversationId !== conversationId) continue
        let existingFingerprint = existingNode.sourceFingerprint
        if (!existingFingerprint && existingNode.assetPath) {
          try {
            const candidate = fs.realpathSync.native(path.resolve(paths.workspace, existingNode.assetPath))
            if (inside(paths.assets, candidate) && fs.statSync(candidate).isFile()) existingFingerprint = fileFingerprint(candidate)
          } catch { /* legacy or removed asset */ }
        }
        if (existingFingerprint === fingerprint) matches.push({ page, node: existingNode })
      }
    }
    if (matches.length) {
      const [{ page, node }] = matches
      node.sourceFingerprint = fingerprint
      if (!node.sourcePath) node.sourcePath = source
      if (!node.sourceConversationId && conversationId) node.sourceConversationId = conversationId
      const duplicateKeys = new Set(matches.slice(1).map((match) => `${match.page.id}:${match.node.id}`))
      if (duplicateKeys.size) {
        for (const candidatePage of loaded.document.pages) {
          candidatePage.nodes = candidatePage.nodes.filter((candidate) => !duplicateKeys.has(`${candidatePage.id}:${candidate.id}`))
        }
      }
      loaded.document.activePageId = page.id
      const existingAsset = path.resolve(paths.workspace, node.assetPath)
      return {
        kind: type, existing: true, deduplicated: duplicateKeys.size, node, pageId: page.id,
        document: loaded.document, filePath: existingAsset,
        message: duplicateKeys.size
          ? `已合并 ${duplicateKeys.size} 个重复图片节点，并定位到原位置。请点击保存确认更改。`
          : `${node.assetName || path.basename(source)} 已在画布中，已定位到原位置。`,
      }
    }
    fs.mkdirSync(paths.assets, { recursive: true })
    const name = safeName(path.basename(source), `${type}${extension}`)
    const target = inside(paths.assets, source) ? source : path.join(paths.assets, `${Date.now()}-${randomUUID().slice(0, 8)}-${name}`)
    if (target !== source) fs.copyFileSync(source, target)
    const page = loaded.document.pages.find((item) => item.id === loaded.document.activePageId) || loaded.document.pages[0]
    const index = page.nodes.length
    const node = normalizeNode({
      type, x: 80 + (index % 6) * 36, y: 80 + (index % 6) * 36,
      width: type === 'pdf' ? 560 : 480, height: type === 'pdf' ? 720 : 320,
      assetPath: path.relative(paths.workspace, target), assetName: name, text: name,
      sourceFingerprint: fingerprint, sourcePath: source, sourceConversationId: conversationId,
    })
    page.nodes.push(node)
    return {
      kind: type, existing: false, deduplicated: 0, node, pageId: page.id, document: loaded.document, filePath: target,
      message: `${name} 已加入 ZSense 画布，点击保存后写入画布文档。`,
    }
  }

  applyOperations(workspacePath, operations = []) {
    const loaded = this.load(workspacePath)
    const page = loaded.document.pages.find((item) => item.id === loaded.document.activePageId) || loaded.document.pages[0]
    for (const operation of operations.slice(0, 200)) {
      if (operation?.action === 'add') page.nodes.push(normalizeNode(operation.node || operation))
      else if (operation?.action === 'delete') page.nodes = page.nodes.filter((node) => node.id !== cleanText(operation.id, 180))
      else if (operation?.action === 'update') {
        const index = page.nodes.findIndex((node) => node.id === cleanText(operation.id, 180))
        if (index >= 0) page.nodes[index] = normalizeNode({ ...page.nodes[index], ...(operation.patch || {}) , id: page.nodes[index].id })
      }
    }
    return this.save(workspacePath, loaded.document, { sourceClientId: 'agent' })
  }

  readForAgent(workspacePath) {
    const { document } = this.load(workspacePath)
    const page = document.pages.find((item) => item.id === document.activePageId) || document.pages[0]
    return { title: document.title, activePageId: page.id, pageName: page.name, nodeCount: page.nodes.length, nodes: page.nodes.slice(0, 500) }
  }

  async assetResponse(requestUrl) {
    try {
      const url = new URL(requestUrl)
      if (url.hostname !== 'asset') return new Response('Not found', { status: 404 })
      const paths = this.#paths(url.searchParams.get('workspacePath') || '')
      const candidate = fs.realpathSync.native(path.resolve(paths.workspace, url.searchParams.get('assetPath') || ''))
      if (!inside(paths.assets, candidate) || !fs.statSync(candidate).isFile()) return new Response('Forbidden', { status: 403 })
      const extension = path.extname(candidate).toLowerCase()
      if (!IMAGE_EXTENSIONS.has(extension) && !PDF_EXTENSIONS.has(extension)) return new Response('Unsupported media type', { status: 415 })
      const source = await net.fetch(pathToFileURL(candidate).href)
      return new Response(source.body, { status: source.status, headers: { 'Content-Type': contentType(extension), 'Cache-Control': 'no-store' } })
    } catch (error) {
      return new Response(`ZSense canvas asset error: ${error instanceof Error ? error.message : String(error)}`, { status: 404 })
    }
  }
}
