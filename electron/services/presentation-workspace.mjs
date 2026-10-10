import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'

const MAX_OPERATIONS = 500
const GEOMETRY = new Set(['x', 'y', 'width', 'height'])
const PATH_PATTERN = /^\/slide\[\d+\]\/(?:shape|picture|image|table|group|connector)\[(?:\d+|@id=\d+)\]$/
async function hashFile(file) {
  const hash = createHash('sha256')
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}
const fileStamp = (file) => { const stat = fs.statSync(file); return `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}` }

function presentationBridge(previewRevision) {
  const channel = 'zsense-presentation-editor-v1'
  let editing = false, selected = null, drag = null, zoomValue = 100
  const main = document.querySelector('.main')
  const send = (type, detail = {}) => parent.postMessage({ channel, type, previewRevision, ...detail }, '*')
  const containers = () => [...document.querySelectorAll('.main > .slide-container')]
  const markSlide = (index) => document.querySelectorAll('.sidebar .thumb[data-slide]').forEach((thumb) => thumb.toggleAttribute('data-zsense-ppt-active', Number(thumb.getAttribute('data-slide')) === index))
  const find = (path) => [...document.querySelectorAll('.main [data-path]')].find((node) => node.getAttribute('data-path') === path)
  function select(node) {
    selected?.removeAttribute('data-zsense-ppt-selected')
    selected?.querySelector(':scope > .zsense-ppt-resize')?.remove()
    selected = node
    if (!node) return
    node.setAttribute('data-zsense-ppt-selected', 'true')
    node.setAttribute('tabindex', '-1')
    node.focus({ preventScroll: true })
    markSlide(Number(node.closest('[data-slide]')?.getAttribute('data-slide')) || 1)
    if (editing) {
      const grip = document.createElement('span')
      grip.className = 'zsense-ppt-resize'; grip.setAttribute('aria-hidden', 'true'); node.appendChild(grip)
    }
    send('selection', { path: node.getAttribute('data-path'), slideIndex: Number(node.closest('[data-slide]')?.getAttribute('data-slide')) || 1 })
  }
  document.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return
    const node = event.target.closest('.main [data-path]')
    if (!node) return
    const resizing = event.target.classList.contains('zsense-ppt-resize')
    select(node)
    if (!editing) return
    event.preventDefault(); event.stopPropagation()
    const slide = node.closest('.slide')
    const scale = slide ? slide.getBoundingClientRect().width / slide.offsetWidth : 1
    drag = { node, resizing, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, scale,
      x: node.offsetLeft, y: node.offsetTop, width: node.offsetWidth, height: node.offsetHeight }
    node.setPointerCapture?.(event.pointerId)
  }, true)
  document.addEventListener('pointermove', (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return
    const dx = (event.clientX - drag.startX) / drag.scale, dy = (event.clientY - drag.startY) / drag.scale
    if (drag.resizing) {
      drag.node.style.width = Math.max(2, drag.width + dx) + 'px'; drag.node.style.height = Math.max(2, drag.height + dy) + 'px'
    } else { drag.node.style.left = drag.x + dx + 'px'; drag.node.style.top = drag.y + dy + 'px' }
  }, true)
  function finish(event, cancelled = false) {
    if (!drag || event.pointerId !== drag.pointerId) return
    const item = drag; drag = null
    item.node.releasePointerCapture?.(item.pointerId)
    if (cancelled) { Object.assign(item.node.style, { left: item.x + 'px', top: item.y + 'px', width: item.width + 'px', height: item.height + 'px' }); return }
    if (Math.abs(event.clientX - item.startX) + Math.abs(event.clientY - item.startY) < 3) return
    const properties = item.resizing ? { width: item.node.offsetWidth * .75 + 'pt', height: item.node.offsetHeight * .75 + 'pt' }
      : { x: item.node.offsetLeft * .75 + 'pt', y: item.node.offsetTop * .75 + 'pt' }
    send('geometry', { path: item.node.getAttribute('data-path'), properties })
  }
  document.addEventListener('pointerup', (event) => finish(event), true)
  document.addEventListener('pointercancel', (event) => finish(event, true), true)
  document.addEventListener('click', (event) => {
    const thumb = event.target.closest('.thumb[data-slide]')
    if (thumb) send('slide', { slideIndex: Number(thumb.getAttribute('data-slide')), cause: 'navigate' })
    if (event.target.closest('.main [data-path]') && editing) event.preventDefault()
  }, true)
  const observer = main && new IntersectionObserver((entries) => {
    const entry = entries.filter((item) => item.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0]
    if (entry) { if (!selected) markSlide(Number(entry.target.getAttribute('data-slide'))); send('slide', { slideIndex: Number(entry.target.getAttribute('data-slide')), cause: 'scroll' }) }
  }, { root: main, threshold: [.3, .6, .9] })
  containers().forEach((node) => observer?.observe(node))
  window.addEventListener('message', (event) => {
    if (event.source !== parent || event.data?.channel !== channel) return
    const data = event.data
    if (data.type === 'configure') {
      editing = data.editing === true
      document.documentElement.classList.toggle('zsense-ppt-editing', editing)
      if (typeof data.path === 'string') select(data.path ? find(data.path) : null)
      else if (selected) select(selected)
    } else if (data.type === 'navigate' && Number.isInteger(data.slideIndex)) {
      markSlide(data.slideIndex)
      containers().find((node) => Number(node.getAttribute('data-slide')) === data.slideIndex)?.scrollIntoView({ block: 'start', behavior: 'smooth' })
      if (data.path) { const node = find(data.path); if (node) select(node) }
    } else if (data.type === 'zoom') {
      const zoom = Math.max(50, Math.min(200, Number(data.value) || 100))
      zoomValue = zoom
      if (main) { main.style.zoom = String(zoom / 100); window.scaleSlides?.() }
    }
  })
  requestAnimationFrame(() => { window.scaleThumbs?.(); window.scaleSlides?.() })
  document.addEventListener('wheel', (event) => {
    if (!event.ctrlKey && !event.metaKey) return
    event.preventDefault(); zoomValue = Math.max(50, Math.min(200, zoomValue + (event.deltaY < 0 ? 10 : -10)))
    send('zoom', { value: zoomValue })
  }, { passive: false })
  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); send('save') }
  })
  send('ready')
}

export function injectPresentationBridge(html, previewRevision = 1) {
  const runtime = `<style data-zsense-ppt-runtime>
body{background:#f3f5f9;color:#253248} .sidebar,html.headless .sidebar{display:flex!important;position:static!important;width:100px!important;min-width:100px!important;background:#eef1f6;border-color:#dce2eb;padding:8px 6px}.slide-notes-label{color:#637083}.sidebar-title,.sidebar-toggle,.toggle-zone,.page-counter{display:none!important}.main{padding:12px;gap:20px}.slide{box-shadow:0 2px 10px #0002}.thumb.active{border-color:transparent}.thumb:hover{border-color:#a3b8d1}.thumb[data-zsense-ppt-active]{border-color:#4b80c9}.slide-notes{background:white;color:#334155}.main [data-path][data-zsense-ppt-selected]{outline:2px solid #568be6;outline-offset:1px}.zsense-ppt-editing .main [data-path]{cursor:move}.zsense-ppt-resize{position:absolute;right:-4px;bottom:-4px;width:9px;height:9px;background:white;border:2px solid #568be6;cursor:nwse-resize;z-index:1000}
</style><script data-zsense-ppt-runtime>(${presentationBridge.toString()})(${JSON.stringify(previewRevision)});</script>`
  const index = String(html).toLowerCase().lastIndexOf('</body>')
  return index >= 0 ? html.slice(0, index) + runtime + html.slice(index) : html + runtime
}

function normalizeOperations(operations, slides) {
  if (!Array.isArray(operations) || operations.length > MAX_OPERATIONS) throw new Error('PowerPoint 修改数量无效。')
  const elements = new Map(slides.flatMap((slide) => slide.elements.map((element) => [element.path, element])))
  return operations.map((operation) => {
    if (!operation || typeof operation.path !== 'string' || !PATH_PATTERN.test(operation.path) || !elements.has(operation.path)) throw new Error('PowerPoint 元素已不存在，请重新选择。')
    const properties = {}
    if (!operation.properties || typeof operation.properties !== 'object' || Array.isArray(operation.properties)) throw new Error('PowerPoint 元素属性无效。')
    for (const [key, value] of Object.entries(operation.properties)) {
      if (key === 'text') {
        if (!elements.get(operation.path).textEditable || typeof value !== 'string' || value.length > 200_000) throw new Error('这个 PowerPoint 元素不支持文字替换。')
        properties.text = value
      } else if (GEOMETRY.has(key)) {
        const length = String(value)
        if (!/^-?\d+(?:\.\d+)?(?:pt|cm|mm|in|px)$/.test(length) || !Number.isFinite(parseFloat(length)) || Math.abs(parseFloat(length)) > 100_000 || ((key === 'width' || key === 'height') && parseFloat(length) <= 0)) throw new Error('PowerPoint 位置或尺寸无效，请使用带单位的长度。')
        properties[key] = length
      } else throw new Error(`暂不支持 PowerPoint 属性：${key}`)
    }
    if (!Object.keys(properties).length) throw new Error('没有要应用的 PowerPoint 属性。')
    return { path: operation.path, properties }
  })
}

export class PresentationWorkspace {
  constructor({ userDataDirectory, run, registerPreview, publish = () => {}, isVisible = () => false, assertActive = () => {}, finishCommitted = (operation) => operation() }) {
    this.root = path.join(userDataDirectory, 'office-presentation-sessions')
    this.run = run; this.registerPreview = registerPreview; this.publish = publish
    this.isVisible = isVisible
    this.assertActive = assertActive; this.finishCommitted = finishCommitted
    this.sessions = new Map(); this.queues = new Map()
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 })
  }
  #queue(filePath, action) {
    const previous = this.queues.get(filePath) || Promise.resolve()
    const next = previous.catch(() => {}).then(() => { this.assertActive(); return action() })
    this.queues.set(filePath, next)
    void next.finally(() => { if (this.queues.get(filePath) === next) this.queues.delete(filePath) }).catch(() => {})
    return next
  }
  #resolve(filePath) {
    const resolved = fs.realpathSync.native(filePath)
    if (path.extname(resolved).toLowerCase() !== '.pptx' || !fs.statSync(resolved).isFile()) throw new Error('请选择有效的 PPTX 文件。')
    return resolved
  }
  async #command(args) {
    const result = await this.run(args, { timeout: 120_000, internal: true })
    const output = typeof result === 'string' ? result : result.stdout
    const parsed = JSON.parse(output)
    if (parsed.success === false) throw new Error(parsed.error?.message || 'PowerPoint 命令执行失败。')
    return parsed.data || parsed
  }
  async #refresh(session) {
    const output = await this.#command(['get', session.workingPath, '/', '--depth', '2', '--json'])
    const root = output.results?.[0] || output.Results?.[0] || {}
    session.slides = (root.children || []).filter((node) => node.type === 'slide').map((slide, index) => ({
      index: index + 1, path: slide.path, title: slide.preview || `幻灯片 ${index + 1}`,
      elements: (slide.children || []).map((element) => ({
        path: element.path, type: element.type, name: element.format?.name || element.type,
        text: element.text || '', textEditable: ['shape', 'textbox', 'title', 'body', 'subtitle', 'text'].includes(element.type),
        x: element.format?.x || '', y: element.format?.y || '', width: element.format?.width || '', height: element.format?.height || '',
      })),
    }))
    const previewPath = path.join(session.directory, 'preview.html')
    await this.run(['view', session.workingPath, 'html', '-o', previewPath], { timeout: 120_000, internal: true })
    fs.writeFileSync(previewPath, injectPresentationBridge(fs.readFileSync(previewPath, 'utf8'), session.revision), { mode: 0o600 })
    session.document = await this.registerPreview({ filePath: session.filePath, previewPath, revision: session.revision })
    session.previewPath = previewPath
    session.previewRevision = session.revision
    session.previewWorkingStamp = fileStamp(session.workingPath)
  }
  #snapshot(session) {
    return { filePath: session.filePath, sessionId: session.sessionId, sessionRevision: session.revision, previewRevision: session.previewRevision,
      baseContentHash: session.baseContentHash, conflict: session.conflict || '', dirty: session.operations.length > 0,
      pendingCount: session.operations.length, operations: session.operations, slides: session.slides, document: session.document }
  }
  #event(session, kind, sourceClientId = '', source = 'editor') {
    this.publish({ filePath: session.filePath, sessionId: session.sessionId, revision: session.revision, kind, source, sourceClientId,
      dirty: session.operations.length > 0, pendingCount: session.operations.length, operations: [], changes: [] })
  }
  async #get(filePath) {
    let session = this.sessions.get(filePath)
    const stamp = fileStamp(filePath)
    const currentHash = session?.baseStamp === stamp ? session.baseContentHash : await hashFile(filePath)
    if (session && session.baseContentHash !== currentHash) {
      if (session.operations.length) { session.conflict = '原文件已被其他程序修改，草稿仍保留。确认后可放弃修改并重新读取，未覆盖原文件。'; return session }
      fs.copyFileSync(filePath, session.workingPath, fs.constants.COPYFILE_FICLONE); session.baseContentHash = currentHash; session.baseStamp = stamp; session.revision += 1; session.conflict = ''
      await this.#refresh(session)
    }
    if (!session) {
      const directory = fs.mkdtempSync(path.join(this.root, 'ppt-'))
      session = { filePath, directory, workingPath: path.join(directory, 'working.pptx'), sessionId: `office-ppt-${randomUUID()}`,
        revision: 1, baseContentHash: currentHash, baseStamp: stamp, operations: [], slides: [], document: null, lastAccess: Date.now() }
      try { fs.copyFileSync(filePath, session.workingPath, fs.constants.COPYFILE_FICLONE); await this.#refresh(session); this.sessions.set(filePath, session) }
      catch (error) { fs.rmSync(directory, { recursive: true, force: true }); throw error }
    }
    session.lastAccess = Date.now()
    // Dirty sessions are intentionally retained. Evict only clean, idle previews.
    for (const [key, candidate] of this.sessions) {
      if (candidate !== session && !candidate.operations.length && !this.queues.has(key) && !this.isVisible(key) && (this.sessions.size > 8 || Date.now() - candidate.lastAccess > 15 * 60_000)) {
        this.sessions.delete(key); fs.rmSync(candidate.directory, { recursive: true, force: true })
      }
    }
    return session
  }
  getPresentation({ filePath }) { const file = this.#resolve(filePath); return this.#queue(file, async () => this.#snapshot(await this.#get(file))) }
  invalidate(filePath, sourceClientId = '', source = 'agent') {
    if (path.extname(String(filePath)).toLowerCase() !== '.pptx') return Promise.resolve(null)
    const file = this.#resolve(filePath)
    if (!this.sessions.has(file)) return Promise.resolve(null)
    return this.#queue(file, async () => {
      const session = await this.#get(file)
      this.#event(session, 'saved', sourceClientId, source)
      return this.#snapshot(session)
    })
  }
  stagePresentation({ filePath, operations, expectedContentHash, expectedRevision, sourceClientId = '', source = 'editor' }) {
    const file = this.#resolve(filePath)
    return this.#queue(file, async () => {
      const session = await this.#get(file)
      if (session.conflict || (expectedContentHash && expectedContentHash !== session.baseContentHash) || (expectedRevision != null && expectedRevision !== session.revision)) throw new Error(session.conflict || 'PowerPoint 编辑版本已变化，请重新读取后再修改。')
      const normalized = normalizeOperations(operations, session.slides)
      const staging = path.join(session.directory, `stage-${randomUUID()}.pptx`)
      try {
        fs.copyFileSync(file, staging, fs.constants.COPYFILE_FICLONE)
        if (normalized.length) await this.#command(['batch', staging, '--commands', JSON.stringify(normalized.map((operation) => ({ command: 'set', path: operation.path, props: operation.properties }))), '--json'])
        if (await hashFile(file) !== session.baseContentHash) throw new Error('原文件在应用修改时发生变化，未覆盖原文件。')
        this.assertActive()
        fs.renameSync(staging, session.workingPath); session.operations = normalized; session.revision += 1
        return await this.finishCommitted(async () => {
          await this.#refresh(session); this.#event(session, 'changed', sourceClientId, source)
          return this.#snapshot(session)
        })
      } finally { if (fs.existsSync(staging)) fs.unlinkSync(staging) }
    })
  }
  savePresentation({ filePath, expectedContentHash, expectedRevision, sourceClientId = '', source = 'editor' }) {
    const file = this.#resolve(filePath)
    return this.#queue(file, async () => {
      const session = await this.#get(file)
      if (session.conflict || (expectedContentHash && expectedContentHash !== session.baseContentHash) || (expectedRevision != null && expectedRevision !== session.revision)) throw new Error(session.conflict || 'PowerPoint 编辑版本已变化，未覆盖原文件。')
      const saved = session.operations.length
      if (saved) {
        const temporary = path.join(path.dirname(file), `.${path.basename(file)}.zsense-${randomUUID()}.pptx`)
        try {
          fs.copyFileSync(session.workingPath, temporary, fs.constants.COPYFILE_FICLONE); fs.chmodSync(temporary, fs.statSync(file).mode)
          await this.#command(['get', temporary, '/', '--depth', '0', '--json'])
          const handle = fs.openSync(temporary, 'r+')
          try { fs.fsyncSync(handle) } finally { fs.closeSync(handle) }
          if (await hashFile(file) !== session.baseContentHash) throw new Error('原文件在保存过程中发生变化，未覆盖原文件。')
          this.assertActive()
          fs.renameSync(temporary, file)
        } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary) }
        return this.finishCommitted(async () => {
        session.baseContentHash = await hashFile(file); session.baseStamp = fileStamp(file); session.operations = []; session.revision += 1; session.conflict = ''
        if (session.document && session.previewWorkingStamp === fileStamp(session.workingPath) && fs.existsSync(session.previewPath)) {
          // Persisting the already-rendered working copy changes only disk metadata,
          // not slide content. Keep its preview revision/URL so the iframe also stays put.
          session.document = await this.registerPreview({ filePath: session.filePath, previewPath: session.previewPath, revision: session.previewRevision })
        } else await this.#refresh(session)
        this.#event(session, 'saved', sourceClientId, source)
        return { ...this.#snapshot(session), saved, message: `已保存 ${saved} 处 PowerPoint 修改。` }
        })
      }
      return { ...this.#snapshot(session), saved, message: saved ? `已保存 ${saved} 处 PowerPoint 修改。` : '没有需要保存的修改。' }
    })
  }
  discardPresentation({ filePath, sourceClientId = '' }) {
    const file = this.#resolve(filePath)
    return this.#queue(file, async () => {
      const session = this.sessions.get(file)
      if (!session) return this.#snapshot(await this.#get(file))
      fs.copyFileSync(file, session.workingPath, fs.constants.COPYFILE_FICLONE); session.baseContentHash = await hashFile(file); session.baseStamp = fileStamp(file); session.operations = []; session.revision += 1; session.conflict = ''
      await this.#refresh(session); this.#event(session, 'discarded', sourceClientId)
      return this.#snapshot(session)
    })
  }
}
