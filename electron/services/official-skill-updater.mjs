import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import dns from 'node:dns'
import fs from 'node:fs'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const REQUEST_TIMEOUT_MS = 20_000
const UPDATE_TIMEOUT_MS = 180_000
const MAX_DOWNLOAD_BYTES = 220 * 1024 * 1024
const OFFICIAL_SKILL_MARKER = '.zsense-official-update.json'
export const OFFICIAL_TOOL_MARKER = '.zsense-official-tools.json'

dns.setDefaultResultOrder('ipv4first')

const CHANNELS = Object.freeze({
  dws: Object.freeze({
    name: '钉钉 DWS', tool: 'dws', versionArgs: ['version'], repository: 'DingTalk-Real-AI/dingtalk-workspace-cli',
    skillPath: 'skills/mono', skillAsset: 'dws-skills.zip', skillAssetPath: 'mono', checksumAssetName: 'checksums.txt',
    selfUpdateArgs: ['upgrade', '--yes', '--format', 'json'], releaseFromTool: true, directAsset: true,
    releaseCheckArgs: ['upgrade', '--check', '--format', 'json'],
  }),
  kdocs: Object.freeze({
    name: '金山文档', tool: 'kdocs-cli', versionArgs: ['version'], repository: 'kdocs-app/kdocs-skill',
    skillPath: '', branchBased: true, branchRef: 'master', selfUpdateArgs: ['upgrade', '--yes'], checkToolArgs: ['upgrade', '--check'],
  }),
  lark: Object.freeze({
    name: '飞书 CLI', tool: 'lark-cli', versionArgs: ['--version'], repository: 'larksuite/cli',
    versionOnlySkill: true, directAsset: true, releaseFromTool: true, checksumAssetName: 'checksums.txt',
    releaseCheckArgs: ['update', '--check', '--json'],
  }),
  officecli: Object.freeze({
    name: 'OfficeCLI', tool: 'officecli', versionArgs: ['--version'], repository: 'iOfficeAI/OfficeCLI',
    singleSkillFile: 'SKILL.md', directAsset: true, releaseFromFeed: true, checksumAssetName: 'SHA256SUMS',
  }),
  'browser-skill': Object.freeze({
    name: 'BrowserSkill', tool: 'bsk', versionArgs: ['--version'], repository: 'Tencent/BrowserSkill',
    singleSkillFile: 'skill/SKILL.md', selfUpdateArgs: ['update', '--yes', '--json', '--no-restart-daemon'],
    releaseFromTool: true, releaseCheckArgs: ['update', '--check', '--json'],
  }),
})

function executableName(tool) {
  return process.platform === 'win32' ? `${tool}.exe` : tool
}

function normalizedVersion(value) {
  const match = String(value || '').match(/(?:^|[^\d])(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/)
  return match?.[1] || ''
}

function versionParts(value) {
  const normalized = normalizedVersion(value)
  if (!normalized) return null
  const [core, prerelease = ''] = normalized.split('-', 2)
  return { numbers: core.split('.').map((item) => Number.parseInt(item, 10)), prerelease }
}

export function isNewerOfficialVersion(latest, current) {
  const left = versionParts(latest)
  const right = versionParts(current)
  if (!left || !right) return Boolean(left && !right)
  for (let index = 0; index < 3; index += 1) {
    if (left.numbers[index] !== right.numbers[index]) return left.numbers[index] > right.numbers[index]
  }
  if (!left.prerelease && right.prerelease) return true
  if (left.prerelease && !right.prerelease) return false
  return left.prerelease.localeCompare(right.prerelease, 'en', { numeric: true }) > 0
}

function parseFrontmatterVersion(content) {
  const match = String(content || '').match(/^---\n[\s\S]*?^version:\s*["']?([^"'\s]+)["']?\s*$[\s\S]*?^---/m)
  return normalizedVersion(match?.[1] || '')
}

function readJson(filePath, fallback = {}) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')) } catch { return fallback }
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
  const temporary = `${filePath}.${process.pid}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  fs.renameSync(temporary, filePath)
}

async function command(filePath, args, options = {}) {
  const result = await execFileAsync(filePath, args, {
    cwd: options.cwd || path.dirname(filePath),
    env: options.env || process.env,
    timeout: options.timeout || REQUEST_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  })
  return `${result.stdout || ''}${result.stderr ? `\n${result.stderr}` : ''}`.trim()
}

async function responseBuffer(url, accept = 'application/octet-stream') {
  const request = (target, redirects = 0) => new Promise((resolve, reject) => {
    const operation = https.get(target, {
      family: 4,
      headers: { Accept: accept, 'User-Agent': 'ZSense-Agent-Core/0.24.0' },
      timeout: REQUEST_TIMEOUT_MS,
    }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume()
        if (redirects >= 6) return reject(new Error('官方更新源重定向次数过多。'))
        return resolve(request(new URL(response.headers.location, target).href, redirects + 1))
      }
      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.resume()
        return reject(new Error(`官方更新源返回 HTTP ${response.statusCode}。`))
      }
      const declared = Number.parseInt(response.headers['content-length'] || '0', 10)
      if (declared > MAX_DOWNLOAD_BYTES) {
        response.destroy()
        return reject(new Error('官方更新包超过 220 MB，已停止下载。'))
      }
      const chunks = []
      let size = 0
      response.on('data', (chunk) => {
        size += chunk.length
        if (size > MAX_DOWNLOAD_BYTES) response.destroy(new Error('官方更新包超过 220 MB，已停止下载。'))
        else chunks.push(chunk)
      })
      response.on('end', () => {
        const buffer = Buffer.concat(chunks)
        if (!buffer.length) reject(new Error('官方更新包为空。'))
        else resolve(buffer)
      })
      response.on('error', reject)
    })
    operation.on('timeout', () => operation.destroy(new Error('连接官方更新源超时。')))
    operation.on('error', reject)
  })
  return request(url)
}

function assetName(channel, version) {
  const arch = process.arch === 'x64' ? 'amd64' : process.arch
  if (channel.tool === 'dws') {
    const platform = process.platform === 'win32' ? 'windows' : process.platform
    const extension = process.platform === 'win32' ? 'zip' : 'tar.gz'
    return `dws-${platform}-${arch}.${extension}`
  }
  if (channel.tool === 'officecli') {
    if (process.platform === 'darwin') return `officecli-mac-${process.arch === 'x64' ? 'x64' : 'arm64'}`
    if (process.platform === 'win32') return `officecli-win-${process.arch === 'x64' ? 'x64' : 'arm64'}.exe`
    if (process.platform === 'linux') return `officecli-linux-${process.arch === 'x64' ? 'x64' : 'arm64'}`
  }
  if (channel.tool === 'lark-cli') {
    const platform = process.platform === 'win32' ? 'windows' : process.platform
    const extension = process.platform === 'win32' ? 'zip' : 'tar.gz'
    return `lark-cli-${version}-${platform}-${arch}.${extension}`
  }
  return ''
}

function checksumForAsset(content, name) {
  for (const line of String(content || '').split(/\r?\n/)) {
    const match = line.trim().match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/)
    if (match && path.basename(match[2].trim()) === name) return match[1].toLowerCase()
  }
  return ''
}

function findFile(directory, names) {
  const wanted = new Set(names)
  const queue = [directory]
  while (queue.length) {
    const current = queue.shift()
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name)
      if (entry.isFile() && wanted.has(entry.name)) return target
      if (entry.isDirectory() && !entry.name.startsWith('.')) queue.push(target)
    }
  }
  return ''
}

function copyDirectorySecure(source, destination) {
  let files = 0
  let bytes = 0
  const walk = (from, to, depth) => {
    if (depth > 12) throw new Error('官方技能目录层级异常。')
    fs.mkdirSync(to, { recursive: true, mode: 0o700 })
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '__pycache__' || entry.name === OFFICIAL_SKILL_MARKER) continue
      const fromPath = path.join(from, entry.name)
      const toPath = path.join(to, entry.name)
      const stat = fs.lstatSync(fromPath)
      if (stat.isSymbolicLink()) throw new Error(`官方技能包包含符号链接：${entry.name}`)
      if (stat.isDirectory()) walk(fromPath, toPath, depth + 1)
      else if (stat.isFile()) {
        files += 1; bytes += stat.size
        if (files > 2_500 || bytes > 120 * 1024 * 1024) throw new Error('官方技能包文件过多或超过 120 MB。')
        fs.copyFileSync(fromPath, toPath)
      }
    }
  }
  walk(source, destination, 0)
}

function replaceSkillDirectory(source, destination, marker) {
  if (!fs.existsSync(path.join(source, 'SKILL.md'))) throw new Error('官方技能包缺少 SKILL.md。')
  const staging = `${destination}.official-${process.pid}`
  const backup = `${destination}.backup-${process.pid}`
  fs.rmSync(staging, { recursive: true, force: true })
  fs.rmSync(backup, { recursive: true, force: true })
  copyDirectorySecure(source, staging)
  for (const preserved of ['.zsense-history', '.zsense-bundle.json']) {
    const current = path.join(destination, preserved)
    if (fs.existsSync(current)) fs.cpSync(current, path.join(staging, preserved), { recursive: true, force: true })
  }
  writeJsonAtomic(path.join(staging, OFFICIAL_SKILL_MARKER), marker)
  try {
    if (fs.existsSync(destination)) fs.renameSync(destination, backup)
    fs.renameSync(staging, destination)
    fs.rmSync(backup, { recursive: true, force: true })
  } catch (error) {
    if (!fs.existsSync(destination) && fs.existsSync(backup)) fs.renameSync(backup, destination)
    fs.rmSync(staging, { recursive: true, force: true })
    throw error
  }
}

export class OfficialSkillUpdater {
  constructor({ agentHomePath, requestBuffer = null }) {
    this.agentHomePath = agentHomePath
    this.toolRoot = path.join(agentHomePath, 'toolchain', 'bin')
    this.requestBuffer = requestBuffer || responseBuffer
  }

  hasChannel(skillName) { return Boolean(CHANNELS[skillName]) }

  homepage(skillName) {
    const channel = CHANNELS[skillName]
    return channel ? `https://github.com/${channel.repository}` : ''
  }

  installedSkillVersion(skillName, directory, fallback) {
    if (!this.hasChannel(skillName)) return fallback
    return normalizedVersion(readJson(path.join(directory, OFFICIAL_SKILL_MARKER), {}).skillVersion) || fallback
  }

  #toolPath(channel) {
    const candidate = path.join(this.toolRoot, executableName(channel.tool))
    if (!fs.existsSync(candidate)) throw new Error(`${channel.name} 的本地 CLI 不可用。`)
    return candidate
  }

  async #currentToolVersion(channel) {
    return normalizedVersion(await command(this.#toolPath(channel), channel.versionArgs))
  }

  async #responseText(url, accept = 'text/plain') {
    const value = await this.requestBuffer(url, accept)
    const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value)
    if (!buffer.length || buffer.length > MAX_DOWNLOAD_BYTES) throw new Error('官方更新响应为空或超过 220 MB。')
    return buffer.toString('utf8')
  }

  async #githubJson(endpoint) {
    return JSON.parse(await this.#responseText(`https://api.github.com${endpoint}`, 'application/vnd.github+json'))
  }

  async #githubContent(repository, ref, filePath) {
    const encodedPath = String(filePath || '').split('/').filter(Boolean).map(encodeURIComponent).join('/')
    const endpoint = `/repos/${repository}/contents/${encodedPath}${ref ? `?ref=${encodeURIComponent(ref)}` : ''}`
    const payload = await this.#githubJson(endpoint)
    if (payload?.type !== 'file' || payload.encoding !== 'base64' || typeof payload.content !== 'string') {
      throw new Error('官方仓库没有返回可读取的技能文件。')
    }
    const buffer = Buffer.from(payload.content.replace(/\s+/g, ''), 'base64')
    if (!buffer.length || buffer.length > MAX_DOWNLOAD_BYTES) throw new Error('官方技能文件为空或超过 220 MB。')
    return buffer.toString('utf8')
  }

  async #latestRelease(repository) {
    const release = await this.#githubJson(`/repos/${repository}/releases/latest`)
    if (!release?.tag_name) throw new Error('官方仓库没有可用的正式版本。')
    return release
  }

  async #latestReleaseFromFeed(channel) {
    const feed = await this.#responseText(`https://github.com/${channel.repository}/releases.atom`, 'application/atom+xml')
    const match = feed.match(/href=["'](https:\/\/github\.com\/[^"']+\/releases\/tag\/([^"']+))["']/i)
    const ref = match?.[2] ? decodeURIComponent(match[2]) : ''
    const version = normalizedVersion(ref)
    if (!ref || !version) throw new Error(`${channel.name} 官方发布订阅没有返回最新版本。`)
    return { ref, tag: ref, version, url: match[1], release: null, skillContent: '' }
  }

  async #branchInfo(channel) {
    const ref = channel.branchRef || 'main'
    const archiveUrl = `https://github.com/${channel.repository}/archive/refs/heads/${encodeURIComponent(ref)}.tar.gz`
    const archiveValue = await this.requestBuffer(archiveUrl, 'application/octet-stream')
    const archive = Buffer.isBuffer(archiveValue) ? archiveValue : Buffer.from(archiveValue)
    if (!archive.length || archive.length > MAX_DOWNLOAD_BYTES) throw new Error(`${channel.name} 官方技能包为空或超过 220 MB。`)
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), `zsense-${channel.tool}-check-`))
    try {
      const archivePath = path.join(temporaryRoot, 'source.tar.gz')
      const extracted = path.join(temporaryRoot, 'extracted')
      fs.writeFileSync(archivePath, archive)
      fs.mkdirSync(extracted, { recursive: true })
      await command('tar', ['-xzf', archivePath, '-C', extracted], { cwd: temporaryRoot, timeout: UPDATE_TIMEOUT_MS })
      const root = fs.readdirSync(extracted, { withFileTypes: true }).find((entry) => entry.isDirectory())
      if (!root) throw new Error(`${channel.name} 官方技能仓库结构无效。`)
      const skillPath = path.join(extracted, root.name, channel.skillPath || '', 'SKILL.md')
      const skillContent = fs.readFileSync(skillPath, 'utf8')
      return {
        ref, tag: ref, version: parseFrontmatterVersion(skillContent),
        url: `https://github.com/${channel.repository}/tree/${encodeURIComponent(ref)}`,
        archiveUrl, release: null, skillContent,
      }
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true })
    }
  }

  async #releaseInfo(channel) {
    if (channel.releaseFromTool) {
      try {
        const payload = JSON.parse(await command(this.#toolPath(channel), channel.releaseCheckArgs))
        const version = normalizedVersion(payload.latest_version)
        if (!version) throw new Error(payload?.error?.message || `${channel.name} 官方渠道没有返回最新版本。`)
        const url = payload.release_url || payload.url || `https://github.com/${channel.repository}/releases/tag/${payload.latest_version}`
        let ref = payload.latest_version
        try { ref = new URL(url).pathname.split('/').filter(Boolean).at(-1) || ref } catch { /* Keep the reported version as the ref. */ }
        return { ref, tag: ref, version, url, release: null, skillContent: '' }
      } catch (error) {
        if (channel.tool !== 'dws') throw error
        return await this.#latestReleaseFromFeed(channel)
      }
    }
    if (channel.releaseFromFeed) return await this.#latestReleaseFromFeed(channel)
    if (channel.branchBased) return await this.#branchInfo(channel)
    const release = await this.#latestRelease(channel.repository)
    const version = normalizedVersion(release.tag_name)
    return { ref: release.tag_name, tag: release.tag_name, version, url: release.html_url || `https://github.com/${channel.repository}/releases/tag/${release.tag_name}`, release, skillContent: '' }
  }

  async check(skill) {
    const channel = CHANNELS[skill.name]
    if (!channel) throw new Error(`${skill.name} 没有官方更新渠道。`)
    const [currentToolVersion, source] = await Promise.all([this.#currentToolVersion(channel), this.#releaseInfo(channel)])
    let latestToolVersion = source.version
    if (channel.checkToolArgs) {
      const output = await command(this.#toolPath(channel), channel.checkToolArgs)
      latestToolVersion = normalizedVersion(output.match(/Latest version:\s*v?([^\s]+)/i)?.[1] || output) || latestToolVersion
    }
    // Release-backed skills follow their official release version. Reading the
    // remote SKILL.md is deferred to update(), so a manual check only needs the
    // CLI update endpoint and GitHub API metadata and never depends on the raw
    // content host.
    const latestSkillVersion = parseFrontmatterVersion(source.skillContent) || source.version || latestToolVersion
    const currentSkillVersion = ['dws', 'lark', 'officecli'].includes(skill.name)
      ? currentToolVersion
      : normalizedVersion(skill.version) || currentToolVersion
    const updateAvailable = isNewerOfficialVersion(latestSkillVersion, currentSkillVersion) || isNewerOfficialVersion(latestToolVersion, currentToolVersion)
    const decorate = (skillVersion, toolVersion) => skillVersion && toolVersion && skillVersion !== toolVersion ? `${skillVersion} · CLI ${toolVersion}` : skillVersion || toolVersion || '未知'
    return {
      id: skill.id,
      name: skill.name,
      currentVersion: decorate(currentSkillVersion, currentToolVersion),
      latestVersion: decorate(latestSkillVersion, latestToolVersion),
      updateAvailable,
      updateMode: 'registry',
      official: true,
      releaseUrl: source.url,
      source,
      currentToolVersion,
      latestToolVersion,
      latestSkillVersion,
    }
  }

  async #downloadDirectTool(channel, source) {
    const release = source.release
    const version = source.version || normalizedVersion(release?.tag_name)
    const name = assetName(channel, version)
    const assetUrl = release?.assets?.find((item) => item.name === name)?.browser_download_url
      || `https://github.com/${channel.repository}/releases/download/${encodeURIComponent(source.ref)}/${encodeURIComponent(name)}`
    const checksumName = release?.assets?.find((item) => /(?:checksums|sha256sums)/i.test(item.name))?.name || channel.checksumAssetName
    if (!name || !checksumName) throw new Error(`${channel.name} 没有当前平台的官方安装包或校验文件。`)
    const checksumUrl = `https://github.com/${channel.repository}/releases/download/${encodeURIComponent(source.ref)}/${encodeURIComponent(checksumName)}`
    const [payloadValue, checksums] = await Promise.all([this.requestBuffer(assetUrl, 'application/octet-stream'), this.#responseText(checksumUrl)])
    const payload = Buffer.isBuffer(payloadValue) ? payloadValue : Buffer.from(payloadValue)
    if (!payload.length || payload.length > MAX_DOWNLOAD_BYTES) throw new Error(`${channel.name} 安装包为空或超过 220 MB。`)
    const expected = checksumForAsset(checksums, name)
    if (!expected) throw new Error(`${channel.name} 校验文件中没有当前平台安装包。`)
    const actual = crypto.createHash('sha256').update(payload).digest('hex')
    if (actual !== expected) throw new Error(`${channel.name} 安装包 SHA256 校验失败。`)
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), `zsense-${channel.tool}-`))
    const archivePath = path.join(temporaryRoot, name)
    fs.writeFileSync(archivePath, payload, { mode: 0o700 })
    let sourceTool = archivePath
    if (/\.(?:zip|tar\.gz)$/i.test(name)) {
      const extracted = path.join(temporaryRoot, 'extracted')
      fs.mkdirSync(extracted, { recursive: true })
      await command('tar', ['-xf', archivePath, '-C', extracted], { cwd: temporaryRoot, timeout: UPDATE_TIMEOUT_MS })
      sourceTool = findFile(extracted, [channel.tool, executableName(channel.tool)])
    }
    if (!sourceTool || !fs.existsSync(sourceTool)) throw new Error(`${channel.name} 安装包中没有找到可执行文件。`)
    const destination = this.#toolPath(channel)
    const temporary = `${destination}.official-${process.pid}`
    fs.copyFileSync(sourceTool, temporary)
    if (process.platform !== 'win32') fs.chmodSync(temporary, 0o755)
    fs.renameSync(temporary, destination)
  }

  async #updateTool(channel, source, latestToolVersion) {
    const current = await this.#currentToolVersion(channel)
    if (!isNewerOfficialVersion(latestToolVersion, current)) return current
    if (channel.directAsset) await this.#downloadDirectTool(channel, source)
    else await command(this.#toolPath(channel), channel.selfUpdateArgs, { timeout: UPDATE_TIMEOUT_MS })
    if (process.platform !== 'win32') fs.chmodSync(this.#toolPath(channel), 0o755)
    const installed = await this.#currentToolVersion(channel)
    if (isNewerOfficialVersion(latestToolVersion, installed)) throw new Error(`${channel.name} 更新后版本仍低于 ${latestToolVersion}。`)
    const markerPath = path.join(this.toolRoot, OFFICIAL_TOOL_MARKER)
    const marker = readJson(markerPath, {})
    marker[channel.tool] = { version: installed, source: this.homepage(Object.keys(CHANNELS).find((key) => CHANNELS[key] === channel) || ''), updatedAt: new Date().toISOString() }
    writeJsonAtomic(markerPath, marker)
    return installed
  }

  async #skillSource(channel, source) {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), `zsense-${channel.tool}-skill-`))
    if (channel.skillAsset) {
      const release = source.release
      const assetUrl = release?.assets?.find((item) => item.name === channel.skillAsset)?.browser_download_url
        || `https://github.com/${channel.repository}/releases/download/${encodeURIComponent(source.ref)}/${encodeURIComponent(channel.skillAsset)}`
      const checksumName = release?.assets?.find((item) => /(?:checksums|sha256sums)/i.test(item.name))?.name || channel.checksumAssetName
      if (!checksumName) throw new Error(`${channel.name} 官方版本缺少技能包校验文件。`)
      const checksumUrl = `https://github.com/${channel.repository}/releases/download/${encodeURIComponent(source.ref)}/${encodeURIComponent(checksumName)}`
      const [archiveValue, checksums] = await Promise.all([
        this.requestBuffer(assetUrl, 'application/octet-stream'),
        this.#responseText(checksumUrl),
      ])
      const archive = Buffer.isBuffer(archiveValue) ? archiveValue : Buffer.from(archiveValue)
      const expected = checksumForAsset(checksums, channel.skillAsset)
      const actual = crypto.createHash('sha256').update(archive).digest('hex')
      if (!expected || actual !== expected) throw new Error(`${channel.name} 技能包 SHA256 校验失败。`)
      const archivePath = path.join(temporaryRoot, channel.skillAsset)
      const extracted = path.join(temporaryRoot, 'extracted')
      fs.writeFileSync(archivePath, archive)
      fs.mkdirSync(extracted, { recursive: true })
      await command('tar', ['-xf', archivePath, '-C', extracted], { cwd: temporaryRoot, timeout: UPDATE_TIMEOUT_MS })
      return channel.skillAssetPath ? path.join(extracted, channel.skillAssetPath) : extracted
    }
    if (channel.singleSkillFile) {
      const content = source.skillContent || await this.#githubContent(channel.repository, source.ref, channel.singleSkillFile)
      fs.writeFileSync(path.join(temporaryRoot, 'SKILL.md'), content, 'utf8')
      return temporaryRoot
    }
    const archiveUrl = source.archiveUrl || source.release?.tarball_url || `https://api.github.com/repos/${channel.repository}/tarball/${encodeURIComponent(source.ref)}`
    const archiveAccept = archiveUrl.startsWith('https://api.github.com/') ? 'application/vnd.github+json' : 'application/octet-stream'
    const archiveValue = await this.requestBuffer(archiveUrl, archiveAccept)
    const archive = Buffer.isBuffer(archiveValue) ? archiveValue : Buffer.from(archiveValue)
    if (!archive.length || archive.length > MAX_DOWNLOAD_BYTES) throw new Error(`${channel.name} 官方技能包为空或超过 220 MB。`)
    const archivePath = path.join(temporaryRoot, 'source.tar.gz')
    const extracted = path.join(temporaryRoot, 'extracted')
    fs.writeFileSync(archivePath, archive)
    fs.mkdirSync(extracted, { recursive: true })
    await command('tar', ['-xzf', archivePath, '-C', extracted], { cwd: temporaryRoot, timeout: UPDATE_TIMEOUT_MS })
    const root = fs.readdirSync(extracted, { withFileTypes: true }).find((entry) => entry.isDirectory())
    if (!root) throw new Error(`${channel.name} 官方技能仓库结构无效。`)
    return channel.skillPath ? path.join(extracted, root.name, channel.skillPath) : path.join(extracted, root.name)
  }

  async update(skill) {
    const channel = CHANNELS[skill.name]
    if (!channel) throw new Error(`${skill.name} 没有官方更新渠道。`)
    const checked = await this.check(skill)
    if (!checked.updateAvailable) return { version: skill.version, toolVersion: checked.currentToolVersion, updated: false }
    const skillSource = channel.versionOnlySkill ? '' : await this.#skillSource(channel, checked.source)
    const toolVersion = await this.#updateTool(channel, checked.source, checked.latestToolVersion)
    const marker = {
      channel: 'official', repository: channel.repository, ref: checked.source.ref,
      skillVersion: checked.latestSkillVersion || toolVersion, toolVersion,
      releaseUrl: checked.source.url, updatedAt: new Date().toISOString(),
    }
    if (channel.versionOnlySkill) writeJsonAtomic(path.join(skill.installPath, OFFICIAL_SKILL_MARKER), marker)
    else replaceSkillDirectory(skillSource, skill.installPath, marker)
    return { version: marker.skillVersion, toolVersion, updated: true }
  }
}
