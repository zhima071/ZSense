import { BrowserWindow, session } from 'electron'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { validatedPublicUrl } from './network-safety.mjs'

const PAGE_TIMEOUT_MS = 30_000
const MAX_SNAPSHOT_TEXT = 48_000
const MAX_HISTORY_ITEMS = 500
const MAX_DOWNLOAD_ITEMS = 200
const BROWSER_PARTITION = 'persist:zsense-browser'

function emptyBrowserData() {
  return { history: [], downloads: [], sitePermissions: [] }
}

function browserOrigin(value) {
  try {
    const target = new URL(String(value || ''))
    return ['http:', 'https:'].includes(target.protocol) ? target.origin : ''
  } catch { return '' }
}

function safeDownloadName(value) {
  return path.basename(String(value || 'download')).replace(/[<>:"/\\|?*\x00-\x1F]/g, '-').slice(0, 240) || 'download'
}

function sessionKey(value) {
  return String(value || 'default').replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 80) || 'default'
}

async function validatedBrowserUrl(value, { allowPrivate = false } = {}) {
  let target
  try { target = new URL(String(value || '').trim()) }
  catch { throw new Error('浏览器网址无效。') }
  if (!['http:', 'https:'].includes(target.protocol)) throw new Error('浏览器只允许打开 HTTP 或 HTTPS 页面。')
  const hostname = target.hostname.toLowerCase()
  const local = hostname === 'localhost' || hostname === 'localhost.localdomain' || hostname === '127.0.0.1' || hostname === '::1'
  return local || allowPrivate ? validatedPublicUrl(target.href, { allowPrivate: true }) : validatedPublicUrl(target.href)
}

function refSelector(value) {
  const ref = String(value || '').trim()
  if (!/^e\d{1,4}$/.test(ref)) throw new Error('元素引用无效，请先调用 browser_snapshot 获取 e1、e2 等引用。')
  return `[data-zsense-agent-ref="${ref}"]`
}

export class BrowserAutomationService {
  constructor({ screenshotsRoot, onActivity = () => undefined, getSettings = () => ({}), downloadsDirectory = '' }) {
    this.screenshotsRoot = screenshotsRoot
    this.onActivity = onActivity
    this.getSettings = getSettings
    this.downloadsDirectory = downloadsDirectory
    this.dataPath = path.join(path.dirname(screenshotsRoot), 'browser-data.json')
    this.windows = new Map()
    this.visible = new Map()
    this.visibleKeysByContentsId = new Map()
    this.boundVisibleContentsIds = new Set()
    this.trackedContentsIds = new Set()
    this.aliases = new Map()
    this.closedKeys = new Set()
    fs.mkdirSync(screenshotsRoot, { recursive: true })
    this.data = this.#loadData()
    this.profile = session.fromPartition(BROWSER_PARTITION)
    this.#configureProfile()
  }

  #settings() {
    try { return this.getSettings?.() || {} }
    catch { return {} }
  }

  #loadData() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.dataPath, 'utf8'))
      return {
        history: Array.isArray(parsed.history) ? parsed.history.slice(0, MAX_HISTORY_ITEMS) : [],
        downloads: Array.isArray(parsed.downloads) ? parsed.downloads.slice(0, MAX_DOWNLOAD_ITEMS) : [],
        sitePermissions: Array.isArray(parsed.sitePermissions) ? parsed.sitePermissions : [],
      }
    } catch { return emptyBrowserData() }
  }

  #saveData() {
    fs.mkdirSync(path.dirname(this.dataPath), { recursive: true })
    const temporary = `${this.dataPath}.${process.pid}.tmp`
    fs.writeFileSync(temporary, `${JSON.stringify(this.data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    fs.renameSync(temporary, this.dataPath)
  }

  #recordHistory(contents, value) {
    const url = String(value || '')
    if (!browserOrigin(url)) return
    const now = new Date().toISOString()
    const existing = this.data.history.find((entry) => entry.url === url)
    const entry = {
      id: existing?.id || randomUUID(),
      url,
      title: String(contents.getTitle?.() || existing?.title || new URL(url).hostname).slice(0, 500),
      visitedAt: now,
    }
    this.data.history = [entry, ...this.data.history.filter((item) => item.id !== entry.id)].slice(0, MAX_HISTORY_ITEMS)
    this.#saveData()
  }

  #trackContents(contents) {
    if (!contents || this.trackedContentsIds.has(contents.id)) return
    this.trackedContentsIds.add(contents.id)
    const record = (_event, url) => this.#recordHistory(contents, url || contents.getURL?.())
    const updateTitle = () => {
      const url = contents.getURL?.()
      const entry = this.data.history.find((item) => item.url === url)
      if (!entry) return
      entry.title = String(contents.getTitle?.() || entry.title).slice(0, 500)
      this.#saveData()
    }
    contents.on('did-navigate', record)
    contents.on('did-navigate-in-page', record)
    contents.on('page-title-updated', updateTitle)
    contents.once('destroyed', () => this.trackedContentsIds.delete(contents.id))
  }

  #sitePermission(origin, permission, details = {}) {
    const normalizedOrigin = browserOrigin(origin)
    const configured = this.data.sitePermissions.find((entry) => entry.origin === normalizedOrigin)
    if (!configured) return 'ask'
    if (permission === 'media') {
      const mediaTypes = Array.isArray(details.mediaTypes) ? details.mediaTypes : []
      if (mediaTypes.includes('video')) return configured.camera || 'ask'
      if (mediaTypes.includes('audio')) return configured.microphone || 'ask'
    }
    return 'block'
  }

  #configureProfile() {
    this.profile.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
      const origin = requestingOrigin || webContents?.getURL?.() || ''
      return this.#sitePermission(origin, permission, details) === 'allow'
    })
    this.profile.setPermissionRequestHandler((webContents, permission, callback, details) => {
      const origin = webContents?.getURL?.() || details?.requestingUrl || ''
      const decision = this.#sitePermission(origin, permission, details)
      if (decision === 'ask') this.#emitActivity('', 'permission-request', { origin: browserOrigin(origin), permission })
      callback(decision === 'allow')
    })
    this.profile.on('will-download', (_event, item) => {
      const settings = this.#settings()
      const fileName = safeDownloadName(item.getFilename())
      const directory = String(settings.browserDownloadPath || this.downloadsDirectory || '')
      if (directory) {
        fs.mkdirSync(directory, { recursive: true })
        const target = path.join(directory, fileName)
        if (settings.browserAskDownloadLocation) item.setSaveDialogOptions({ defaultPath: target })
        else item.setSavePath(target)
      }
      const entry = {
        id: randomUUID(),
        url: item.getURL(),
        fileName,
        savePath: item.getSavePath?.() || '',
        state: 'progressing',
        receivedBytes: 0,
        totalBytes: Math.max(0, Number(item.getTotalBytes()) || 0),
        startedAt: new Date().toISOString(),
        completedAt: '',
      }
      this.data.downloads = [entry, ...this.data.downloads].slice(0, MAX_DOWNLOAD_ITEMS)
      this.#saveData()
      item.on('updated', (_downloadEvent, state) => {
        entry.state = state === 'interrupted' ? 'interrupted' : 'progressing'
        entry.receivedBytes = Math.max(0, Number(item.getReceivedBytes()) || 0)
        entry.totalBytes = Math.max(0, Number(item.getTotalBytes()) || entry.totalBytes)
      })
      item.once('done', (_downloadEvent, state) => {
        entry.state = ['completed', 'cancelled', 'interrupted'].includes(state) ? state : 'interrupted'
        entry.savePath = item.getSavePath?.() || entry.savePath
        entry.receivedBytes = Math.max(0, Number(item.getReceivedBytes()) || 0)
        entry.totalBytes = Math.max(0, Number(item.getTotalBytes()) || entry.totalBytes)
        entry.completedAt = new Date().toISOString()
        this.#saveData()
      })
    })
  }

  #resolvedKey(keyValue) {
    const key = sessionKey(keyValue)
    return this.aliases.get(key) || key
  }

  #emitActivity(keyValue, action = 'open', detail = {}) {
    try { this.onActivity({ sessionId: keyValue ? this.#resolvedKey(keyValue) : '', action, ...detail }) }
    catch { /* Renderer lifecycle must never stop browser tools. */ }
  }

  linkSession(conversationId, browserSessionId) {
    const conversationKey = sessionKey(conversationId)
    const browserKey = this.#resolvedKey(browserSessionId)
    if (conversationKey !== browserKey) this.aliases.set(conversationKey, browserKey)
    return { conversationId: conversationKey, sessionId: browserKey }
  }

  activate(keyValue) {
    const key = this.#resolvedKey(keyValue)
    this.closedKeys.delete(key)
    return { active: true, sessionId: key }
  }

  attachVisible(keyValue, contents) {
    const key = this.#resolvedKey(keyValue)
    if (!contents || contents.isDestroyed?.()) throw new Error('浏览器页面已经关闭，请重新打开会话浏览器。')
    const contentsId = contents.id
    const oldKeys = this.visibleKeysByContentsId.get(contentsId) || new Set()
    oldKeys.add(key)
    this.visibleKeysByContentsId.set(contentsId, oldKeys)
    this.visible.set(key, contents)
    this.#trackContents(contents)
    if (!this.boundVisibleContentsIds.has(contentsId)) {
      this.boundVisibleContentsIds.add(contentsId)
      contents.once('destroyed', () => {
        this.boundVisibleContentsIds.delete(contentsId)
        this.detachVisible('', contentsId)
      })
    }
    const hidden = this.windows.get(key)
    if (hidden && !hidden.isDestroyed()) {
      const hiddenUrl = hidden.webContents.getURL()
      if (hiddenUrl && hiddenUrl !== 'about:blank') void contents.loadURL(hiddenUrl).catch(() => undefined)
      hidden.destroy()
      this.windows.delete(key)
    }
    return { attached: true, sessionId: key, webContentsId: contentsId }
  }

  detachVisible(keyValue, contentsId) {
    const requestedKey = keyValue ? this.#resolvedKey(keyValue) : ''
    const keys = this.visibleKeysByContentsId.get(contentsId) || new Set()
    for (const key of [...keys]) {
      if (requestedKey && key !== requestedKey) continue
      if (this.visible.get(key)?.id === contentsId) this.visible.delete(key)
      keys.delete(key)
    }
    if (keys.size) this.visibleKeysByContentsId.set(contentsId, keys)
    else this.visibleKeysByContentsId.delete(contentsId)
    return { detached: true }
  }

  async #contents(keyValue) {
    if (this.#settings().browserEnabled === false) throw new Error('内置浏览器已在设置中关闭。')
    const key = this.#resolvedKey(keyValue)
    if (this.closedKeys.has(key)) throw new Error('当前会话浏览器已关闭，请先调用 browser_navigate 打开新页面。')
    const visible = this.visible.get(key)
    if (visible && !visible.isDestroyed()) {
      this.#emitActivity(key, 'open')
      return visible
    }
    if (visible) this.visible.delete(key)
    return (await this.#window(key)).webContents
  }

  async #window(keyValue) {
    const key = this.#resolvedKey(keyValue)
    const existing = this.windows.get(key)
    if (existing && !existing.isDestroyed()) return existing
    const browser = new BrowserWindow({
      show: false,
      width: 1280,
      height: 900,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        partition: BROWSER_PARTITION,
      },
    })
    browser.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    browser.webContents.on('will-navigate', (event, target) => {
      try {
        const url = new URL(target)
        if (!['http:', 'https:'].includes(url.protocol)) event.preventDefault()
      } catch { event.preventDefault() }
    })
    browser.on('closed', () => this.windows.delete(key))
    this.#trackContents(browser.webContents)
    this.windows.set(key, browser)
    return browser
  }

  profileState() {
    return {
      history: this.data.history.map((entry) => ({ ...entry })),
      downloads: this.data.downloads.map((entry) => ({ ...entry })),
      sitePermissions: this.data.sitePermissions.map((entry) => ({ ...entry })),
    }
  }

  history(maximum = 100) {
    return this.data.history.slice(0, Math.max(1, Math.min(MAX_HISTORY_ITEMS, Number(maximum) || 100))).map((entry) => ({ ...entry }))
  }

  async clearBrowsingData() {
    await Promise.all([
      this.profile.clearCache(),
      this.profile.clearStorageData(),
    ])
    this.data = emptyBrowserData()
    this.#saveData()
    return this.profileState()
  }

  clearHistory(kind = 'history') {
    if (kind === 'history' || kind === 'all') this.data.history = []
    if (kind === 'downloads' || kind === 'all') this.data.downloads = []
    this.#saveData()
    return this.profileState()
  }

  setSitePermission(input = {}) {
    const origin = browserOrigin(input.origin)
    if (!origin) throw new Error('网站地址必须是有效的 HTTP 或 HTTPS 来源。')
    const allowed = new Set(['ask', 'allow', 'block'])
    const camera = allowed.has(input.camera) ? input.camera : 'ask'
    const microphone = allowed.has(input.microphone) ? input.microphone : 'ask'
    const entry = { origin, camera, microphone }
    this.data.sitePermissions = [entry, ...this.data.sitePermissions.filter((item) => item.origin !== origin)]
    this.#saveData()
    return this.profileState()
  }

  removeSitePermission(value) {
    const origin = browserOrigin(value)
    this.data.sitePermissions = this.data.sitePermissions.filter((entry) => entry.origin !== origin)
    this.#saveData()
    return this.profileState()
  }

  async navigate(key, target) {
    const url = await validatedBrowserUrl(target, { allowPrivate: true })
    this.closedKeys.delete(this.#resolvedKey(key))
    const contents = await this.#contents(key)
    this.#emitActivity(key, 'open')
    await contents.loadURL(url, { timeout: PAGE_TIMEOUT_MS })
    return this.snapshot(key)
  }

  async openTransient(key, target, title = 'ZSense 授权') {
    const url = await validatedBrowserUrl(target, { allowPrivate: true })
    const resolvedKey = this.#resolvedKey(key)
    this.closedKeys.delete(resolvedKey)
    const browser = await this.#window(resolvedKey)
    browser.setTitle(String(title || 'ZSense 授权').slice(0, 120))
    if (!browser.isDestroyed()) {
      browser.show()
      browser.focus()
      void browser.loadURL(url, { timeout: PAGE_TIMEOUT_MS }).catch((error) => {
        if (!browser.isDestroyed()) console.warn('ZSense 临时授权页加载失败：', error instanceof Error ? error.message : error)
      })
    }
    this.#emitActivity(resolvedKey, 'open', { transient: true, url })
    return { opened: true, sessionId: resolvedKey, url }
  }

  async snapshot(key) {
    const contents = await this.#contents(key)
    if (!contents.getURL()) throw new Error('浏览器还没有打开网页，请先调用 browser_navigate。')
    return contents.executeJavaScript(`(() => {
      document.querySelectorAll('[data-zsense-agent-ref]').forEach((node) => node.removeAttribute('data-zsense-agent-ref'));
      const selector = 'a[href],button,input,textarea,select,[role="button"],[contenteditable="true"]';
      const elements = Array.from(document.querySelectorAll(selector)).filter((node) => {
        const style = getComputedStyle(node); const rect = node.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
      }).slice(0, 180).map((node, index) => {
        const ref = 'e' + (index + 1); node.setAttribute('data-zsense-agent-ref', ref);
        return { ref, tag: node.tagName.toLowerCase(), text: (node.innerText || node.getAttribute('aria-label') || node.getAttribute('placeholder') || node.value || '').trim().replace(/\\s+/g, ' ').slice(0, 240), href: node.href || '', type: node.type || '', disabled: Boolean(node.disabled) };
      });
      return { title: document.title, url: location.href, text: (document.body?.innerText || '').replace(/\\n{3,}/g, '\\n\\n').slice(0, ${MAX_SNAPSHOT_TEXT}), elements };
    })()`, true)
  }

  async click(key, ref) {
    const contents = await this.#contents(key)
    const selector = refSelector(ref)
    const result = await contents.executeJavaScript(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (!node) return false; node.scrollIntoView({block:'center'}); node.click(); return true; })()`, true)
    if (!result) throw new Error('没有找到该元素，页面可能已经变化，请重新获取快照。')
    await new Promise((resolve) => setTimeout(resolve, 350))
    return this.snapshot(key)
  }

  async describeElement(key, ref) {
    const contents = await this.#contents(key)
    const selector = refSelector(ref)
    return contents.executeJavaScript(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!node) return null;
      return {
        tag: node.tagName.toLowerCase(),
        text: (node.innerText || node.getAttribute('aria-label') || node.getAttribute('title') || node.value || '').trim().replace(/\\s+/g, ' ').slice(0, 240),
        href: node.href || '',
        type: node.type || '',
        download: node.getAttribute('download') || '',
      };
    })()`, true)
  }

  async type(key, ref, value, submit = false) {
    const contents = await this.#contents(key)
    const selector = refSelector(ref)
    const result = await contents.executeJavaScript(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)}); if (!node) return false;
      node.focus(); const value = ${JSON.stringify(String(value ?? ''))};
      if ('value' in node) { const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(node), 'value')?.set; setter ? setter.call(node, value) : node.value = value; }
      else node.textContent = value;
      node.dispatchEvent(new Event('input', {bubbles:true})); node.dispatchEvent(new Event('change', {bubbles:true}));
      ${submit ? "node.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',bubbles:true})); node.form?.requestSubmit?.();" : ''}
      return true;
    })()`, true)
    if (!result) throw new Error('没有找到该输入元素，请重新获取页面快照。')
    await new Promise((resolve) => setTimeout(resolve, 250))
    return this.snapshot(key)
  }

  async scroll(key, direction = 'down', amount = 650) {
    const contents = await this.#contents(key)
    const delta = Math.max(100, Math.min(2400, Number(amount) || 650)) * (direction === 'up' ? -1 : 1)
    await contents.executeJavaScript(`window.scrollBy({top:${delta},behavior:'instant'}); true`, true)
    return this.snapshot(key)
  }

  async back(key) {
    const contents = await this.#contents(key)
    if (!contents.canGoBack()) return { message: '当前页面没有可返回的上一页。', ...(await this.snapshot(key)) }
    contents.goBack()
    await new Promise((resolve) => setTimeout(resolve, 450))
    return this.snapshot(key)
  }

  async forward(key) {
    const contents = await this.#contents(key)
    if (!contents.canGoForward()) return { message: '当前页面没有可前进的下一页。', ...(await this.snapshot(key)) }
    contents.goForward()
    await new Promise((resolve) => setTimeout(resolve, 450))
    return this.snapshot(key)
  }

  async reload(key) {
    const contents = await this.#contents(key)
    if (!contents.getURL()) throw new Error('浏览器还没有打开网页。')
    contents.reload()
    await new Promise((resolve) => setTimeout(resolve, 450))
    return this.snapshot(key)
  }

  async screenshot(key, workspaceRoot, fileName = '') {
    const contents = await this.#contents(key)
    const image = await contents.capturePage()
    const safeName = String(fileName || `browser-${Date.now()}.png`).replace(/[^\p{L}\p{N}._-]/gu, '-').replace(/\.png$/i, '') + '.png'
    const root = path.resolve(workspaceRoot)
    const target = path.join(root, safeName)
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error('截图路径必须位于当前工作区。')
    fs.writeFileSync(target, image.toPNG())
    return { path: path.relative(root, target), width: image.getSize().width, height: image.getSize().height }
  }

  async capture(key) {
    const contents = await this.#contents(key)
    const url = contents.getURL?.() || ''
    if (!url || url === 'about:blank') throw new Error('当前浏览器还是空白页，请先打开网页再截图。')
    const image = await contents.capturePage()
    if (image.isEmpty()) throw new Error('浏览器没有返回可用的截图内容。')
    const size = image.getSize()
    const title = safeDownloadName(contents.getTitle?.() || '网页截图').replace(/\.[^.]+$/, '').slice(0, 80) || '网页截图'
    return { dataUrl: image.toDataURL(), width: size.width, height: size.height, name: `${title}.png`, url }
  }

  async download(key, ref) {
    const before = this.data.downloads[0]?.id || ''
    await this.click(key, ref)
    await new Promise((resolve) => setTimeout(resolve, 500))
    const entry = this.data.downloads[0]
    return entry && entry.id !== before ? { started: true, download: { ...entry } } : { started: false, message: '点击已经完成，但页面没有发起浏览器下载。' }
  }

  async upload(key, ref, filePaths, workspaceRoot) {
    const root = fs.realpathSync.native(path.resolve(String(workspaceRoot || '')))
    const files = (Array.isArray(filePaths) ? filePaths : []).slice(0, 8).map((filePath) => {
      const requested = path.isAbsolute(String(filePath || '')) ? String(filePath) : path.join(root, String(filePath || ''))
      const resolved = fs.realpathSync.native(path.resolve(requested))
      if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new Error('只能上传当前会话工作区中的文件。')
      if (!fs.statSync(resolved).isFile()) throw new Error(`上传目标不是文件：${path.basename(resolved)}`)
      return resolved
    })
    if (!files.length) throw new Error('请选择至少一个要上传的工作区文件。')
    const contents = await this.#contents(key)
    const selector = refSelector(ref)
    const attachedHere = !contents.debugger.isAttached()
    if (attachedHere) contents.debugger.attach('1.3')
    try {
      const document = await contents.debugger.sendCommand('DOM.getDocument', { depth: 1, pierce: true })
      const result = await contents.debugger.sendCommand('DOM.querySelector', { nodeId: document.root.nodeId, selector })
      if (!result.nodeId) throw new Error('没有找到文件选择元素，请重新获取页面快照。')
      await contents.debugger.sendCommand('DOM.setFileInputFiles', { nodeId: result.nodeId, files })
      return { uploaded: files.map((filePath) => ({ name: path.basename(filePath), path: path.relative(root, filePath) })) }
    } finally { if (attachedHere && contents.debugger.isAttached()) contents.debugger.detach() }
  }

  async cdp(key, method, params = {}) {
    const contents = await this.#contents(key)
    const attachedHere = !contents.debugger.isAttached()
    if (attachedHere) contents.debugger.attach('1.3')
    try { return await contents.debugger.sendCommand(String(method || ''), params && typeof params === 'object' ? params : {}) }
    finally { if (attachedHere && contents.debugger.isAttached()) contents.debugger.detach() }
  }

  async close(key) {
    const resolvedKey = this.#resolvedKey(key)
    this.closedKeys.add(resolvedKey)
    const visible = this.visible.get(resolvedKey)
    if (visible && !visible.isDestroyed()) {
      try { visible.stop() } catch { /* page may already be stopped */ }
      try { if (visible.getURL() !== 'about:blank') await visible.loadURL('about:blank') } catch { /* closing must still complete */ }
    }
    const browser = this.windows.get(resolvedKey)
    if (browser && !browser.isDestroyed()) {
      browser.destroy()
      this.windows.delete(resolvedKey)
    }
    if (visible && !visible.isDestroyed()) {
      this.#emitActivity(resolvedKey, 'close')
      return { closed: true, visible: true }
    }
    this.#emitActivity(resolvedKey, 'close')
    return { closed: true, visible: false }
  }

  shutdown() {
    for (const browser of this.windows.values()) if (!browser.isDestroyed()) browser.destroy()
    this.windows.clear()
    this.visible.clear()
    this.visibleKeysByContentsId.clear()
    this.boundVisibleContentsIds.clear()
    this.trackedContentsIds.clear()
    this.aliases.clear()
    this.closedKeys.clear()
  }
}

export { validatedBrowserUrl, validatedPublicUrl }
