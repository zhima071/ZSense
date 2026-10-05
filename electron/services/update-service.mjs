import process from 'node:process'

const REQUEST_TIMEOUT_MS = 8_000
const MAX_FEED_BYTES = 256 * 1024
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

function artifactSuffixes(platform) {
  if (platform === 'darwin') return ['.dmg', '.zip']
  if (platform === 'win32') return ['.exe', '.msi']
  return ['.AppImage', '.deb', '.rpm', '.tar.gz']
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

function pickArtifact(candidates, platform, feedUrl) {
  const urls = candidates.map((item) => absoluteUrl(item, feedUrl)).filter(Boolean)
  for (const suffix of artifactSuffixes(platform)) {
    const matched = urls.find((item) => item.toLowerCase().includes(suffix.toLowerCase()))
    if (matched) return matched
  }
  return urls[0] || ''
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
  const assets = Array.isArray(value.assets) ? value.assets.map((item) => item?.browser_download_url).filter(Boolean) : []
  return {
    version,
    candidates: [direct, ...files, ...assets].filter(Boolean),
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

export function parseUpdateFeed(text, { feedUrl, platform = process.platform } = {}) {
  const parsed = parseJsonFeed(text) || parseBuilderFeed(text)
  if (!parsed) return null
  return {
    version: parsed.version,
    downloadUrl: pickArtifact(parsed.candidates, platform, feedUrl),
    notes: parsed.notes,
    publishedAt: parsed.publishedAt,
  }
}

export class UpdateService {
  constructor({ currentVersion = '0.0.0', platform = process.platform, fetchImpl = null, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
    this.currentVersion = currentVersion
    this.platform = platform
    this.fetchImpl = fetchImpl || ((...args) => fetch(...args))
    this.timeoutMs = timeoutMs
  }

  inspect() {
    return { currentVersion: this.currentVersion, platform: this.platform }
  }

  async check(feedUrl) {
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
      const raw = await response.text()
      const text = raw.slice(0, MAX_FEED_BYTES)
      const feed = parseUpdateFeed(text, { feedUrl: url.toString(), platform: this.platform })
      if (!feed) throw new Error('更新清单格式无法识别；请指向 electron-builder 生成的 latest*.yml 或包含 version 字段的 JSON。')
      const comparison = compareVersions(feed.version, this.currentVersion)
      return {
        ok: true,
        feedUrl: url.toString(),
        currentVersion: this.currentVersion,
        latestVersion: feed.version,
        updateAvailable: comparison > 0,
        upToDate: comparison <= 0,
        downloadUrl: feed.downloadUrl,
        notes: feed.notes,
        publishedAt: feed.publishedAt,
        checkedAt: new Date().toISOString(),
        error: '',
      }
    } catch (error) {
      const message = error?.name === 'AbortError' ? '检查更新超时，请确认网络或更新源地址。' : (error instanceof Error ? error.message : '检查更新失败。')
      return { ok: false, error: message, feedUrl: url.toString(), currentVersion: this.currentVersion, checkedAt: new Date().toISOString() }
    } finally {
      clearTimeout(timer)
    }
  }
}
