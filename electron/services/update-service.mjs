import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { scheduleUpdateInstall } from './update-install-service.mjs'

const REQUEST_TIMEOUT_MS = 8_000
const MAX_FEED_BYTES = 256 * 1024
const MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024
const GITHUB_RELEASE_API = 'https://api.github.com/repos/zhima071/ZSense/releases/latest'

export function defaultUpdateFeedUrl() {
  return GITHUB_RELEASE_API
}

export function normalizeVersion(value) {
  const matched = String(value || '').trim().match(/\d+(?:\.\d+){0,3}/)
  return matched ? matched[0] : ''
}

export function compareVersions(left, right) {
  const a = normalizeVersion(left).split('.').map((part) => Number(part) || 0)
  const b = normalizeVersion(right).split('.').map((part) => Number(part) || 0)
  const length = Math.max(a.length, b.length)
  for (let index = 0; index < length; index += 1) {
    const difference = (a[index] || 0) - (b[index] || 0)
    if (difference !== 0) return difference > 0 ? 1 : -1
  }
  return 0
}

function artifactSuffixes(platform, arch) {
  if (platform === 'darwin') return [`-mac-${arch}.dmg`]
  if (platform === 'win32' && arch === 'x64') return ['-win-x64.exe']
  return []
}

function absoluteUrl(value, feedUrl) {
  const candidate = String(value || '').trim()
  if (!candidate) return ''
  try {
    const url = new URL(candidate, feedUrl)
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : ''
  } catch {
    return ''
  }
}

function pickArtifact(candidates, platform, arch, feedUrl) {
  const urls = candidates.map((item) => absoluteUrl(item, feedUrl)).filter(Boolean)
  for (const suffix of artifactSuffixes(platform, arch)) {
    const matched = urls.find((item) => {
      try { return decodeURIComponent(new URL(item).pathname).toLowerCase().endsWith(suffix) } catch { return false }
    })
    if (matched) return matched
  }
  return ''
}

function releaseChecksum(body, assetName) {
  if (!assetName) return ''
  for (const line of String(body || '').split(/\r?\n/)) {
    const match = line.match(/^\s*-\s*(ZSense-[\w.-]+):\s*([a-f\d]{64})\s*$/i)
    if (match?.[1] === assetName) return match[2].toLowerCase()
  }
  return ''
}

function officialAsset(url, version, platform, arch) {
  const suffix = artifactSuffixes(platform, arch)[0]
  if (!suffix || !url) return false
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' && parsed.hostname === 'github.com'
      && parsed.pathname === `/zhima071/ZSense/releases/download/v${version}/ZSense-${version}${suffix}`
      && !parsed.search && !parsed.hash
  } catch { return false }
}

async function partialSize(filePath) {
  try {
    const stats = await fs.promises.lstat(filePath)
    if (!stats.isFile()) throw new Error('更新缓存不是普通文件，请检查更新目录。')
    return stats.size
  } catch (error) {
    if (error?.code === 'ENOENT') return 0
    throw error
  }
}

async function readFeedLimited(response) {
  const announced = Number(response.headers?.get?.('content-length')) || 0
  if (announced > MAX_FEED_BYTES) throw new Error('更新清单过大。')
  if (!response.body?.getReader) {
    const text = await response.text()
    if (Buffer.byteLength(text) > MAX_FEED_BYTES) throw new Error('更新清单过大。')
    return text
  }
  const reader = response.body.getReader()
  const chunks = []
  let bytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > MAX_FEED_BYTES) throw new Error('更新清单过大。')
      chunks.push(value)
    }
    return Buffer.concat(chunks, bytes).toString('utf8')
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}

async function matchingPartialSize(partialPath, sha256) {
  const size = await partialSize(partialPath)
  if (!size) return 0
  const recorded = await fs.promises.readFile(`${partialPath}.sha256`, 'utf8').catch(() => '')
  if (recorded.trim() === sha256) return size
  await Promise.all([
    fs.promises.rm(partialPath, { force: true }),
    fs.promises.rm(`${partialPath}.sha256`, { force: true }),
  ])
  return 0
}

function validContentRange(value, offset, expectedTotal) {
  const match = String(value || '').match(/^bytes (\d+)-(\d+)\/(\d+)$/i)
  if (!match) return false
  const start = Number(match[1])
  const end = Number(match[2])
  const total = Number(match[3])
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && Number.isSafeInteger(total)
    && start === offset && end >= start && total > end && total <= MAX_DOWNLOAD_BYTES
    && (!expectedTotal || total === expectedTotal)
}

function unquote(value) {
  return String(value || '').trim().replace(/^['"]|['"]$/g, '').trim()
}

function parseJsonFeed(text) {
  let value
  try { value = JSON.parse(text) } catch { return null }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const version = normalizeVersion(value.version || value.latestVersion || value.latest || value.tag_name || '')
  if (!version) return null
  const direct = value.downloadUrl || value.download || value.dmg || value.win || value.exe || (value.tag_name ? '' : value.url) || ''
  const files = Array.isArray(value.files) ? value.files.map((item) => (typeof item === 'string' ? item : item?.url)).filter(Boolean) : []
  const assets = Array.isArray(value.assets) ? value.assets.filter((item) => item?.browser_download_url) : []
  return {
    version,
    candidates: [direct, ...files, ...assets.map((item) => item.browser_download_url)].filter(Boolean),
    assets,
    checksum: String(value.sha256 || '').trim().toLowerCase(),
    checksumBody: String(value.body || ''),
    notes: String(value.notes || value.releaseNotes || value.changelog || value.body || '').slice(0, 4_000),
    publishedAt: String(value.publishedAt || value.releaseDate || value.published_at || '').slice(0, 60),
  }
}

function parseBuilderFeed(text) {
  const lines = String(text || '').split(/\r?\n/)
  let version = ''
  let path_ = ''
  let publishedAt = ''
  const candidates = []
  for (const line of lines) {
    const versionMatch = line.match(/^version:\s*(.+)$/)
    if (versionMatch && !version) version = normalizeVersion(unquote(versionMatch[1]))
    const pathMatch = line.match(/^path:\s*(.+)$/)
    if (pathMatch && !path_) path_ = unquote(pathMatch[1])
    const urlMatch = line.match(/^\s*-\s*url:\s*(.+)$/) || line.match(/^\s*url:\s*(.+)$/)
    if (urlMatch) candidates.push(unquote(urlMatch[1]))
    const dateMatch = line.match(/^releaseDate:\s*(.+)$/)
    if (dateMatch) publishedAt = unquote(dateMatch[1])
  }
  if (!version) return null
  return { version, candidates: [...candidates, path_].filter(Boolean), notes: '', publishedAt }
}

export function parseUpdateFeed(text, { feedUrl, platform = process.platform, arch = process.arch } = {}) {
  const parsed = parseJsonFeed(text) || parseBuilderFeed(text)
  if (!parsed) return null
  const downloadUrl = pickArtifact(parsed.candidates, platform, arch, feedUrl)
  const assetName = downloadUrl ? decodeURIComponent(new URL(downloadUrl).pathname.split('/').pop() || '') : ''
  const asset = parsed.assets?.find((item) => item.browser_download_url === downloadUrl)
  const checksum = releaseChecksum(parsed.checksumBody, assetName) || (/^[a-f\d]{64}$/.test(parsed.checksum || '') ? parsed.checksum : '')
  return {
    version: parsed.version,
    downloadUrl,
    sha256: checksum,
    size: Number.isSafeInteger(asset?.size) && asset.size > 0 ? asset.size : 0,
    notes: parsed.notes,
    publishedAt: parsed.publishedAt,
  }
}

export class UpdateService {
  constructor({ currentVersion = '0.0.0', platform = process.platform, arch = process.arch, fetchImpl = null,
    timeoutMs = REQUEST_TIMEOUT_MS, downloadDirectory = '', onProgress = () => undefined,
    installImpl = scheduleUpdateInstall, quitApp = () => undefined, execPath = process.execPath,
    isPackaged = true } = {}) {
    this.currentVersion = currentVersion
    this.platform = platform
    this.arch = arch
    this.fetchImpl = fetchImpl || ((...args) => fetch(...args))
    this.timeoutMs = timeoutMs
    this.downloadDirectory = downloadDirectory
    this.onProgress = onProgress
    this.installImpl = installImpl
    this.quitApp = quitApp
    this.execPath = execPath
    this.isPackaged = isPackaged
    this.available = null
    this.downloaded = null
    this.controller = null
    this.downloadCompletion = null
    this.stopIntent = ''
    this.partialPath = ''
    this.downloadState = { phase: 'idle', version: '', receivedBytes: 0, totalBytes: 0, bytesPerSecond: 0, error: '' }
  }

  inspect() {
    return { currentVersion: this.currentVersion, platform: this.platform, download: { ...this.downloadState } }
  }

  setDownloadState(patch) {
    this.downloadState = { ...this.downloadState, ...patch }
    this.onProgress({ ...this.downloadState })
    return { ...this.downloadState }
  }

  async check(feedUrl) {
    if (this.controller) return { ok: false, error: '正在下载更新，请先等待或取消。', currentVersion: this.currentVersion }
    this.available = null
    const target = String(feedUrl || '').trim()
    if (!target) return { ok: false, error: '请先填写更新检查地址（指向 latest-mac.yml / latest.yml 或更新清单 JSON）。' }
    let url
    try { url = new URL(target) } catch { return { ok: false, error: '更新检查地址不是有效网址。' } }
    if (!['http:', 'https:'].includes(url.protocol)) return { ok: false, error: '更新检查地址仅支持 HTTP 或 HTTPS。' }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await this.fetchImpl(url.toString(), {
        headers: { Accept: 'application/json, text/yaml, text/plain, */*', 'Cache-Control': 'no-cache' },
        signal: controller.signal,
      })
      if (!response.ok) throw new Error(`更新源返回 HTTP ${response.status}`)
      const text = await readFeedLimited(response)
      const feed = parseUpdateFeed(text, { feedUrl: url.toString(), platform: this.platform, arch: this.arch })
      if (!feed) throw new Error('更新清单格式无法识别；请指向 electron-builder 生成的 latest*.yml 或包含 version 字段的 JSON。')
      const comparison = compareVersions(feed.version, this.currentVersion)
      const installSupported = url.toString() === GITHUB_RELEASE_API
        && officialAsset(feed.downloadUrl, feed.version, this.platform, this.arch)
        && /^[a-f\d]{64}$/.test(feed.sha256)
        && this.isPackaged
      const result = {
        ok: true,
        feedUrl: url.toString(),
        currentVersion: this.currentVersion,
        latestVersion: feed.version,
        updateAvailable: comparison > 0,
        upToDate: comparison <= 0,
        downloadUrl: feed.downloadUrl,
        installSupported,
        installHint: !feed.downloadUrl ? '此平台没有匹配的安装包。'
          : !this.isPackaged ? '开发环境不支持直接安装，请使用已打包的应用。'
            : !installSupported ? '此更新源未提供可验证的官方安装包，请使用浏览器手动安装。' : '',
        notes: feed.notes,
        publishedAt: feed.publishedAt,
        checkedAt: new Date().toISOString(),
        error: '',
      }
      if (comparison > 0 && installSupported) this.available = { ...feed, version: feed.version }
      if (this.downloaded?.version !== feed.version || this.downloaded?.sha256 !== feed.sha256 || this.downloadState.phase !== 'ready') {
        this.downloaded = null
        const name = feed.downloadUrl ? decodeURIComponent(new URL(feed.downloadUrl).pathname.split('/').pop() || '') : ''
        this.partialPath = comparison > 0 && installSupported && name && this.downloadDirectory
          ? path.join(this.downloadDirectory, `${name}.part`) : ''
        const cachedBytes = this.partialPath ? await matchingPartialSize(this.partialPath, feed.sha256) : 0
        this.setDownloadState({ phase: cachedBytes > 0 ? 'paused' : 'idle', version: feed.version,
          receivedBytes: cachedBytes, totalBytes: feed.size, bytesPerSecond: 0, error: '' })
      }
      return result
    } catch (error) {
      const message = error?.name === 'AbortError' ? '检查更新超时，请确认网络或更新源地址。' : (error instanceof Error ? error.message : '检查更新失败。')
      return { ok: false, error: message, feedUrl: url.toString(), currentVersion: this.currentVersion, checkedAt: new Date().toISOString() }
    } finally {
      clearTimeout(timer)
    }
  }

  async download() {
    const update = this.available
    if (!update) throw new Error('请先检查并确认有可验证的官方新版本。')
    if (!this.downloadDirectory) throw new Error('当前运行环境没有可用的更新下载目录。')
    if (this.controller) throw new Error('更新正在下载中。')
    const name = decodeURIComponent(new URL(update.downloadUrl).pathname.split('/').pop() || '')
    if (!/^ZSense-\d+(?:\.\d+){2}-(?:mac-(?:arm64|x64)\.dmg|win-x64\.exe)$/.test(name)) throw new Error('安装包名称不符合预期。')
    await fs.promises.mkdir(this.downloadDirectory, { recursive: true, mode: 0o700 })
    const finalPath = path.join(this.downloadDirectory, name)
    const partialPath = `${finalPath}.part`
    const checksumPath = `${partialPath}.sha256`
    this.partialPath = partialPath
    if (fs.existsSync(finalPath) && await this.verifyFile(finalPath, update.sha256)) {
      await Promise.all([partialPath, checksumPath].map((target) => fs.promises.rm(target, { force: true })))
      this.downloaded = { path: finalPath, version: update.version, sha256: update.sha256 }
      const size = fs.statSync(finalPath).size
      return this.setDownloadState({ phase: 'ready', version: update.version, receivedBytes: size,
        totalBytes: update.size || size, bytesPerSecond: 0, error: '' })
    }
    await fs.promises.rm(finalPath, { force: true })
    let offset = await matchingPartialSize(partialPath, update.sha256)
    if (offset > MAX_DOWNLOAD_BYTES || (update.size && offset > update.size)) {
      await fs.promises.rm(partialPath, { force: true })
      await fs.promises.rm(checksumPath, { force: true })
      offset = 0
    }
    if (offset && update.size && offset === update.size) {
      if (await this.verifyFile(partialPath, update.sha256)) {
        await fs.promises.rename(partialPath, finalPath)
        await fs.promises.rm(checksumPath, { force: true })
        this.downloaded = { path: finalPath, version: update.version, sha256: update.sha256 }
        return this.setDownloadState({ phase: 'ready', version: update.version, receivedBytes: offset,
          totalBytes: offset, bytesPerSecond: 0, error: '' })
      }
      await fs.promises.rm(partialPath, { force: true })
      await fs.promises.rm(checksumPath, { force: true })
      offset = 0
    }

    await fs.promises.writeFile(checksumPath, update.sha256, { mode: 0o600 })

    const controller = new AbortController()
    this.controller = controller
    this.stopIntent = ''
    let finishDownload
    this.downloadCompletion = new Promise((resolve) => { finishDownload = resolve })
    this.setDownloadState({ phase: 'downloading', version: update.version, receivedBytes: offset,
      totalBytes: update.size || 0, bytesPerSecond: 0, error: '' })
    let lastEmission = 0
    let received = offset
    let speedTimer
    try {
      const headers = { Accept: 'application/octet-stream', 'Accept-Encoding': 'identity' }
      if (offset) headers.Range = `bytes=${offset}-`
      const response = await this.fetchImpl(update.downloadUrl, { signal: controller.signal, headers })
      if (!response.ok || !response.body) throw new Error(`下载失败：HTTP ${response.status}`)
      if (offset && response.status === 206) {
        if (!validContentRange(response.headers?.get?.('content-range'), offset, update.size)) {
          throw new Error('服务器返回的续传范围不正确，已保留缓存；请重试或取消下载。')
        }
      } else if (response.status === 200) {
        // 不支持 Range 的服务器会返回完整文件；安全地从头下载，绝不把完整文件接在旧缓存后面。
        if (offset) {
          offset = 0
          received = 0
          this.setDownloadState({ receivedBytes: 0, bytesPerSecond: 0 })
        }
      } else {
        throw new Error('服务器未返回可验证的续传范围，已保留缓存；请重试或取消下载。')
      }
      const announcedSize = Number(response.headers?.get?.('content-length')) || 0
      const expectedTotal = update.size || (response.status === 206 ? offset + announcedSize : announcedSize)
      if (expectedTotal > MAX_DOWNLOAD_BYTES || offset + announcedSize > MAX_DOWNLOAD_BYTES) {
        throw new Error('安装包超过 2 GiB 安全上限。')
      }
      this.setDownloadState({ totalBytes: expectedTotal })
      const hash = createHash('sha256')
      if (offset) {
        for await (const chunk of fs.createReadStream(partialPath)) hash.update(chunk)
      }
      let measuredAt = Date.now()
      let measuredBytes = received
      speedTimer = setInterval(() => {
        const now = Date.now()
        const elapsedSeconds = (now - measuredAt) / 1000
        const bytesPerSecond = elapsedSeconds > 0 ? Math.round((received - measuredBytes) / elapsedSeconds) : 0
        measuredAt = now
        measuredBytes = received
        this.setDownloadState({ receivedBytes: received, bytesPerSecond })
      }, 1_000)
      const meter = new Transform({ transform: (chunk, _encoding, callback) => {
        received += chunk.length
        if (received > MAX_DOWNLOAD_BYTES) return callback(new Error('安装包超过 2 GiB 安全上限。'))
        hash.update(chunk)
        if (Date.now() - lastEmission > 150) {
          lastEmission = Date.now()
          this.setDownloadState({ receivedBytes: received })
        }
        callback(null, chunk)
      } })
      await pipeline(Readable.fromWeb(response.body), meter,
        fs.createWriteStream(partialPath, { flags: offset ? 'a' : 'w', mode: 0o600 }), { signal: controller.signal })
      if (controller.signal.aborted) throw new Error('下载已中止。')
      if (update.size && received !== update.size) throw new Error('安装包大小与发布记录不一致。')
      if (hash.digest('hex') !== update.sha256) {
        await fs.promises.rm(partialPath, { force: true })
        await fs.promises.rm(checksumPath, { force: true })
        throw new Error('安装包 SHA-256 校验失败，已丢弃下载缓存。')
      }
      if (controller.signal.aborted) throw new Error('下载已中止。')
      await fs.promises.rename(partialPath, finalPath)
      await fs.promises.rm(checksumPath, { force: true })
      this.downloaded = { path: finalPath, version: update.version, sha256: update.sha256 }
      return this.setDownloadState({ phase: 'ready', receivedBytes: received, totalBytes: received,
        bytesPerSecond: 0, error: '' })
    } catch (error) {
      const intent = this.stopIntent
      if (intent === 'cancel') {
        await Promise.all([partialPath, checksumPath].map((target) => fs.promises.rm(target, { force: true }).catch(() => undefined)))
        return this.setDownloadState({ phase: 'canceled', receivedBytes: 0, bytesPerSecond: 0, error: '' })
      }
      const cachedBytes = await partialSize(partialPath).catch(() => 0)
      if (intent === 'pause') {
        return this.setDownloadState({ phase: 'paused', receivedBytes: cachedBytes, bytesPerSecond: 0, error: '' })
      }
      const message = error instanceof Error ? error.message : '下载失败。'
      this.setDownloadState({ phase: 'error', receivedBytes: cachedBytes, bytesPerSecond: 0, error: message })
      throw new Error(message)
    } finally {
      if (speedTimer) clearInterval(speedTimer)
      this.controller = null
      this.stopIntent = ''
      finishDownload()
      this.downloadCompletion = null
    }
  }

  async pauseDownload() {
    if (this.controller) {
      if (this.stopIntent !== 'cancel') this.stopIntent = 'pause'
      this.controller.abort()
      await this.downloadCompletion
    }
    return { ...this.downloadState }
  }

  async cancelDownload() {
    if (this.controller) {
      this.stopIntent = 'cancel'
      this.controller.abort()
      await this.downloadCompletion
    }
    if (this.downloadState.phase === 'ready') return { ...this.downloadState }
    if (this.partialPath) await Promise.all([this.partialPath, `${this.partialPath}.sha256`]
      .map((target) => fs.promises.rm(target, { force: true })))
    return this.setDownloadState({ phase: 'canceled', receivedBytes: 0, bytesPerSecond: 0, error: '' })
  }

  async verifyFile(filePath, expectedSha256) {
    const hash = createHash('sha256')
    for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk)
    return hash.digest('hex') === expectedSha256
  }

  async install() {
    const update = this.available
    const downloaded = this.downloaded
    if (!update || !downloaded || update.version !== downloaded.version || this.downloadState.phase !== 'ready') {
      throw new Error('请先在应用内下载并校验安装包。')
    }
    if (!await this.verifyFile(downloaded.path, update.sha256)) {
      this.downloaded = null
      this.setDownloadState({ phase: 'error', error: '本地安装包校验失败，请重新下载。' })
      throw new Error('本地安装包校验失败，请重新下载。')
    }
    await this.installImpl({ platform: this.platform, filePath: downloaded.path, version: update.version,
      execPath: this.execPath, parentPid: process.pid, downloadDirectory: this.downloadDirectory })
    this.setDownloadState({ phase: 'installing', error: '' })
    setTimeout(() => this.quitApp(), 250)
    return { scheduled: true, version: update.version }
  }
}
