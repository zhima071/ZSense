import fs from 'node:fs'
import path from 'node:path'
import { OfficialSkillUpdater, OFFICIAL_TOOL_MARKER } from './official-skill-updater.mjs'

const SKILL_FILE = 'SKILL.md'
const CUSTOM_CATEGORY = 'zsense-custom'
const IMPORT_CATEGORY = 'local-imports'
const BUILTIN_CATEGORY = 'zsense-builtin'
const PLUGIN_PACKAGES_CATEGORY = 'plugin-packages'
const MAX_SKILL_DOCUMENT_BYTES = 500_000
const MAX_IMPORT_BYTES = 25 * 1024 * 1024
const MAX_IMPORT_FILES = 500
const ESSENTIAL_SKILLS = new Set()
const IGNORED_IMPORT_NAMES = new Set(['.git', '.hg', '.svn', '.DS_Store', 'node_modules', '__pycache__', '.env'])
const LARK_SKILL_DIRECTORIES = Object.freeze([
  'lark-approval', 'lark-apps', 'lark-attendance', 'lark-base', 'lark-calendar', 'lark-contact', 'lark-doc',
  'lark-drive', 'lark-event', 'lark-im', 'lark-mail', 'lark-markdown', 'lark-meeting', 'lark-minutes', 'lark-note',
  'lark-okr', 'lark-openapi-explorer', 'lark-shared', 'lark-sheets', 'lark-skill-maker', 'lark-slides', 'lark-task',
  'lark-vc', 'lark-vc-agent', 'lark-whiteboard', 'lark-wiki', 'lark-workflow-meeting-summary', 'lark-workflow-standup-report',
])
const BUNDLED_SKILL_DIRECTORIES = Object.freeze(['dws', 'officecli', 'ui-ux-pro-max', 'skill-creator', 'kdocs', 'find-skills', 'lark', 'browser-skill', 'one-mail'])
const BUNDLED_TOOL_NAMES = Object.freeze(['dws', 'officecli', 'kdocs-cli', 'lark-cli', 'bsk'])
const HISTORY_DIRECTORY = '.zsense-history'
const USER_MANAGED_MARKER = '.zsense-user-managed.json'
const OFFICIAL_UPDATE_MARKER = '.zsense-official-update.json'
const BUNDLED_DELETIONS_FILE = '.zsense-managed-deletions.json'
const UPDATE_CHECK_TIMEOUT_MS = 12_000

function normalizeLineEndings(value) {
  return String(value || '').replace(/\r\n?/g, '\n').trim() + '\n'
}

function unquote(value) {
  const trimmed = String(value || '').trim()
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    try { return trimmed.startsWith('"') ? JSON.parse(trimmed) : trimmed.slice(1, -1).replace(/''/g, "'") } catch { return trimmed.slice(1, -1) }
  }
  return trimmed
}

function parseFrontmatter(content) {
  const normalized = String(content || '').replace(/\r\n?/g, '\n')
  const match = normalized.match(/^---\n([\s\S]*?)\n---(?:\n|$)/)
  if (!match) return { fields: {}, extraLines: [], body: normalized.trim() }
  const fields = {}
  const extraLines = []
  const known = new Set(['name', 'description', 'version', 'repository', 'repository_url'])
  for (const line of match[1].split('\n')) {
    const field = line.match(/^([a-zA-Z][\w-]*):\s*(.*)$/)
    if (field && known.has(field[1])) fields[field[1]] = unquote(field[2])
    else extraLines.push(line)
  }
  return { fields, extraLines, body: normalized.slice(match[0].length).trim() }
}

function yamlString(value) {
  return JSON.stringify(String(value || '').trim())
}

function serializeSkillDocument(skill, existingContent = '') {
  const parsed = parseFrontmatter(existingContent)
  const extras = parsed.extraLines.filter((line, index, lines) => {
    if (!line.trim()) return index > 0 && lines[index - 1]?.trim()
    return !/^(name|description|version|repository|repository_url):\s*/.test(line)
  })
  const hasExtraField = (name) => extras.some((line) => new RegExp(`^${name}:\\s*`).test(line))
  const frontmatter = [
    '---',
    `name: ${yamlString(skill.name)}`,
    `description: ${yamlString(skill.description)}`,
    `version: ${yamlString(skill.version || '1.0.0')}`,
    ...(!hasExtraField('author') ? ['author: ZSense User'] : []),
    ...(!hasExtraField('license') ? ['license: Proprietary'] : []),
    ...(!hasExtraField('platforms') ? ['platforms: [macos, linux, windows]'] : []),
    ...(skill.repositoryUrl ? [`repository: ${yamlString(skill.repositoryUrl)}`] : []),
    ...extras,
    '---',
    '',
  ]
  const fallbackBody = [
    `# ${skill.name}`,
    '',
    skill.description,
    '',
    '## When to Use',
    '',
    '- 当用户的任务符合此技能用途时加载本技能。',
    '',
    '## Instructions',
    '',
    '- 在这里写下 Agent 应遵循的具体步骤、边界和检查方法。',
    '',
    '## Verification',
    '',
    '- 完成任务后说明结果，并验证关键输出。',
  ].join('\n')
  return normalizeLineEndings([...frontmatter, parsed.body || fallbackBody].join('\n'))
}

function safeId(value) {
  const normalized = String(value || '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
  return normalized || `skill-${Date.now()}`
}

function isInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative)
}

function readTextFile(filePath) {
  const stat = fs.statSync(filePath)
  if (!stat.isFile()) throw new Error('没有找到可读取的 SKILL.md。')
  if (stat.size > MAX_SKILL_DOCUMENT_BYTES) throw new Error('SKILL.md 超过 500 KB，请精简后再导入。')
  return fs.readFileSync(filePath, 'utf8')
}

function readJson(filePath, fallback = {}) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')) } catch { return fallback }
}

function repositorySkillUrl(value) {
  const source = String(value || '').trim()
  if (!source) return ''
  let url
  try { url = new URL(source) } catch { return '' }
  if (url.hostname === 'raw.githubusercontent.com') return url.href
  if (url.hostname !== 'github.com') return /\/SKILL\.md(?:$|\?)/i.test(url.pathname) ? url.href : ''
  const parts = url.pathname.split('/').filter(Boolean)
  if (parts.length < 2) return ''
  const [owner, repository] = parts
  if (parts[2] === 'blob' && parts.length >= 5) return `https://raw.githubusercontent.com/${owner}/${repository}/${parts[3]}/${parts.slice(4).join('/')}`
  if (parts[2] === 'tree' && parts.length >= 4) return `https://raw.githubusercontent.com/${owner}/${repository}/${parts[3]}/${parts.slice(4).concat(SKILL_FILE).join('/')}`
  return `https://raw.githubusercontent.com/${owner}/${repository}/HEAD/${SKILL_FILE}`
}

async function fetchRemoteSkill(skill) {
  const url = repositorySkillUrl(skill.repositoryUrl)
  if (!url) throw new Error(`${skill.name} 没有可读取的 SKILL.md 仓库地址。`)
  const response = await fetch(url, { headers: { Accept: 'text/plain', 'User-Agent': 'ZSense-Agent-Core/0.2' }, signal: AbortSignal.timeout(UPDATE_CHECK_TIMEOUT_MS) })
  if (!response.ok) throw new Error(`${skill.name} 更新源返回 HTTP ${response.status}。`)
  const content = await response.text()
  if (!content.trim() || Buffer.byteLength(content, 'utf8') > MAX_SKILL_DOCUMENT_BYTES) throw new Error(`${skill.name} 的远程 SKILL.md 为空或超过 500 KB。`)
  const parsed = parseFrontmatter(content)
  return { content, version: parsed.fields.version || skill.version || '1.0.0' }
}

function countFiles(directory) {
  let count = 0
  const walk = (current, depth) => {
    if (depth > 8) return
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === '__pycache__') continue
      const target = path.join(current, entry.name)
      if (entry.isFile()) count += 1
      else if (entry.isDirectory()) walk(target, depth + 1)
    }
  }
  walk(directory, 0)
  return count
}

function sensitiveSkillContent(value) {
  return /(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|passwd|密码|口令|密钥|secret|私钥|验证码)[\s:=：]+[^\s<>{}\[\]]{6,}/i.test(String(value || ''))
    || /\b(?:sk|pk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{12,}\b/i.test(String(value || ''))
}

function skillVersionHistory(directory) {
  const historyRoot = path.join(directory, HISTORY_DIRECTORY)
  if (!fs.existsSync(historyRoot)) return []
  return fs.readdirSync(historyRoot, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith('.md')).flatMap((entry) => {
    const match = entry.name.match(/^(\d+)-(.+)\.md$/)
    if (!match) return []
    const stat = fs.statSync(path.join(historyRoot, entry.name))
    return [{ id: entry.name.slice(0, -3), version: decodeURIComponent(match[2]), createdAt: stat.mtime.toISOString() }]
  }).sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, 30)
}

function evaluateSkillDraft(input = {}) {
  const content = normalizeLineEndings(input.content || '')
  const parsed = parseFrontmatter(content)
  const issues = []
  const warnings = []
  if (!parsed.fields.name || !parsed.fields.description || !parsed.fields.version) issues.push('SKILL.md 需要完整的 name、description 和 version 元数据。')
  if (!/^##\s+When to Use\b/im.test(content)) issues.push('缺少 “When to Use” 使用条件。')
  if (!/^##\s+Instructions\b/im.test(content)) issues.push('缺少 “Instructions” 执行步骤。')
  if (!/^##\s+Verification\b/im.test(content)) issues.push('缺少 “Verification” 验证方法。')
  if (sensitiveSkillContent(content)) issues.push('检测到可能的密码、API Key 或 Token，不能保存为技能。')
  if (Buffer.byteLength(content, 'utf8') > MAX_SKILL_DOCUMENT_BYTES) issues.push('SKILL.md 超过 500 KB。')
  if (/\/(?:Users|home)\/[^\s]+|[A-Za-z]:\\Users\\[^\s]+/.test(content)) warnings.push('包含特定电脑的绝对路径，建议改为工作区相对路径。')
  if (!/(?:失败|error|fallback|重试|retry|停止|边界)/i.test(content)) warnings.push('建议补充失败处理或安全边界。')
  if (content.split('\n').length < 18) warnings.push('技能步骤较短，确认它能被其他相似任务复用。')
  const score = Math.max(0, 100 - issues.length * 28 - warnings.length * 7)
  return { valid: issues.length === 0 && score >= 70, score, issues, warnings }
}

function copyDirectorySecure(source, destination) {
  let files = 0
  let bytes = 0
  const walk = (from, to, depth) => {
    if (depth > 10) throw new Error('技能文件夹层级过深，已停止导入。')
    fs.mkdirSync(to, { recursive: true })
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      if (IGNORED_IMPORT_NAMES.has(entry.name)) continue
      const sourcePath = path.join(from, entry.name)
      const targetPath = path.join(to, entry.name)
      const stat = fs.lstatSync(sourcePath)
      if (stat.isSymbolicLink()) throw new Error(`技能包含不安全的符号链接：${entry.name}`)
      if (stat.isDirectory()) walk(sourcePath, targetPath, depth + 1)
      else if (stat.isFile()) {
        files += 1
        bytes += stat.size
        if (files > MAX_IMPORT_FILES || bytes > MAX_IMPORT_BYTES) throw new Error('技能文件夹过大（最多 500 个文件、25 MB）。')
        fs.copyFileSync(sourcePath, targetPath, fs.constants.COPYFILE_EXCL)
      }
    }
  }
  walk(source, destination, 0)
}

export class SkillManager {
  constructor(agentHomePath, options = {}) {
    this.agentHomePath = agentHomePath
    this.rootPath = path.join(agentHomePath, 'skills')
    this.customRootPath = path.join(this.rootPath, CUSTOM_CATEGORY)
    this.importRootPath = path.join(this.rootPath, IMPORT_CATEGORY)
    this.builtinRootPath = path.join(this.rootPath, BUILTIN_CATEGORY)
    this.officialUpdater = options.officialUpdater || new OfficialSkillUpdater({ agentHomePath, requestBuffer: options.requestBuffer })
  }

  #deletedBundledSkills() {
    try {
      const value = JSON.parse(fs.readFileSync(path.join(this.builtinRootPath, BUNDLED_DELETIONS_FILE), 'utf8'))
      return new Set(Array.isArray(value?.skills) ? value.skills.filter((name) => typeof name === 'string') : [])
    } catch { return new Set() }
  }

  #saveDeletedBundledSkills(names) {
    fs.mkdirSync(this.builtinRootPath, { recursive: true })
    const target = path.join(this.builtinRootPath, BUNDLED_DELETIONS_FILE)
    const temporary = `${target}.${process.pid}.tmp`
    fs.writeFileSync(temporary, `${JSON.stringify({ skills: [...names].sort(), updatedAt: new Date().toISOString() }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    fs.renameSync(temporary, target)
  }

  #markUserManaged(skill, reason) {
    if ((!skill?.builtIn && !skill?.pluginId) || !isInside(this.rootPath, skill.installPath)) return
    fs.writeFileSync(path.join(skill.installPath, USER_MANAGED_MARKER), `${JSON.stringify({ reason, updatedAt: new Date().toISOString() }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  }

  ensureBundledSkills(sourceRoot, bundleVersion = 'development') {
    const installed = []
    fs.mkdirSync(this.builtinRootPath, { recursive: true })
    const deletedSkills = this.#deletedBundledSkills()
    for (const legacyDirectoryName of LARK_SKILL_DIRECTORIES) {
      const legacyDestination = path.join(this.builtinRootPath, legacyDirectoryName)
      if (!fs.existsSync(path.join(legacyDestination, '.zsense-bundle.json')) || fs.existsSync(path.join(legacyDestination, USER_MANAGED_MARKER))) continue
      fs.rmSync(legacyDestination, { recursive: true, force: true })
    }
    for (const directoryName of BUNDLED_SKILL_DIRECTORIES) {
      const source = path.join(sourceRoot, directoryName)
      const sourceSkillFile = path.join(source, SKILL_FILE)
      if (!fs.existsSync(sourceSkillFile)) {
        // 单个内置技能缺失（打包裁剪/安装不完整）不再中断整体部署，跳过它并留下可诊断的记录
        console.warn(`内置技能缺失，已跳过：${directoryName}（期待位置 ${sourceSkillFile}）`)
        continue
      }
      const destination = path.join(this.builtinRootPath, directoryName)
      if (deletedSkills.has(directoryName)) continue
      const bundleManifestPath = path.join(destination, '.zsense-bundle.json')
      const userManagedMarkerPath = path.join(destination, USER_MANAGED_MARKER)
      const officialUpdateMarkerPath = path.join(destination, OFFICIAL_UPDATE_MARKER)
      if ((fs.existsSync(userManagedMarkerPath) || fs.existsSync(officialUpdateMarkerPath)) && fs.existsSync(path.join(destination, SKILL_FILE))) {
        installed.push(directoryName)
        continue
      }
      let currentVersion = ''
      try { currentVersion = JSON.parse(fs.readFileSync(bundleManifestPath, 'utf8')).version || '' } catch { /* first install */ }
      if (currentVersion === bundleVersion && fs.existsSync(path.join(destination, SKILL_FILE))) {
        installed.push(directoryName)
        continue
      }
      const temporary = path.join(this.builtinRootPath, `.install-${directoryName}-${process.pid}`)
      if (fs.existsSync(temporary)) fs.rmSync(temporary, { recursive: true, force: true })
      copyDirectorySecure(source, temporary)
      fs.writeFileSync(path.join(temporary, '.zsense-bundle.json'), `${JSON.stringify({ version: bundleVersion, installedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8')
      if (fs.existsSync(destination)) fs.rmSync(destination, { recursive: true, force: true })
      fs.renameSync(temporary, destination)
      installed.push(directoryName)
    }
    return installed
  }

  ensureBundledTools(sourceRoot, runtimeRoot, bundleVersion = 'development') {
    const destinationRoot = path.join(runtimeRoot, 'toolchain', 'bin')
    const manifestPath = path.join(destinationRoot, '.zsense-bundled-tools.json')
    fs.mkdirSync(destinationRoot, { recursive: true, mode: 0o700 })
    let manifest = null
    try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) } catch { /* first install */ }
    const officialUpdates = readJson(path.join(destinationRoot, OFFICIAL_TOOL_MARKER), {})
    const current = manifest?.version === bundleVersion && BUNDLED_TOOL_NAMES.every((name) => {
      try { return fs.statSync(path.join(destinationRoot, process.platform === 'win32' ? `${name}.exe` : name)).isFile() } catch { return false }
    })
    if (current) return BUNDLED_TOOL_NAMES.map((name) => path.join(destinationRoot, process.platform === 'win32' ? `${name}.exe` : name))

    const installed = []
    for (const name of BUNDLED_TOOL_NAMES) {
      const fileName = process.platform === 'win32' ? `${name}.exe` : name
      const source = path.join(sourceRoot, fileName)
      if (!fs.existsSync(source)) throw new Error(`安装包缺少内置工具：${fileName}`)
      const destination = path.join(destinationRoot, fileName)
      if (officialUpdates?.[name]?.updatedAt && fs.existsSync(destination)) {
        installed.push(destination)
        continue
      }
      const temporary = `${destination}.install-${process.pid}`
      fs.copyFileSync(source, temporary)
      if (process.platform !== 'win32') fs.chmodSync(temporary, 0o755)
      fs.renameSync(temporary, destination)
      installed.push(destination)
    }
    fs.writeFileSync(manifestPath, `${JSON.stringify({ version: bundleVersion, tools: BUNDLED_TOOL_NAMES, installedAt: new Date().toISOString() }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    return installed
  }

  #manifestNames() {
    try {
      const content = fs.readFileSync(path.join(this.rootPath, '.bundled_manifest'), 'utf8')
      return new Set(content.split('\n').map((line) => line.split(':')[0]?.trim()).filter(Boolean))
    } catch { return new Set() }
  }

  #hubEntries() {
    try {
      const payload = JSON.parse(fs.readFileSync(path.join(this.rootPath, '.hub', 'lock.json'), 'utf8'))
      return payload?.installed && typeof payload.installed === 'object' ? payload.installed : {}
    } catch { return {} }
  }

  #skillDocuments() {
    if (!fs.existsSync(this.rootPath)) return []
    const documents = []
    const walk = (directory, depth) => {
      if (depth > 6) return
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === '__pycache__') continue
        const target = path.join(directory, entry.name)
        if (entry.isSymbolicLink()) continue
        if (entry.isFile() && entry.name.toLowerCase() === 'skill.md') documents.push(target)
        else if (entry.isDirectory()) walk(target, depth + 1)
      }
    }
    walk(this.rootPath, 0)
    return documents
  }

  #describe(filePath, manifestNames = this.#manifestNames(), hubEntries = this.#hubEntries()) {
    const content = readTextFile(filePath)
    const parsed = parseFrontmatter(content)
    const directory = path.dirname(filePath)
    const relativeDirectory = path.relative(this.rootPath, directory)
    const parts = relativeDirectory.split(path.sep)
    const fallbackName = parts.at(-1) || 'unnamed-skill'
    const name = parsed.fields.name || fallbackName
    const isZSenseBuiltin = parts[0] === BUILTIN_CATEGORY
    const pluginId = parts[0] === PLUGIN_PACKAGES_CATEGORY ? parts[1] || '' : ''
    const userSkill = parts[0] === CUSTOM_CATEGORY || parts[0] === IMPORT_CATEGORY
    const builtIn = isZSenseBuiltin || !pluginId && !userSkill && manifestNames.has(name)
    const hubEntry = pluginId || userSkill ? undefined : hubEntries[name]
    const isZSense = parts[0] === CUSTOM_CATEGORY
    const source = isZSenseBuiltin || builtIn ? 'ZSense' : hubEntry ? 'Skills Hub' : isZSense ? 'ZSense' : '本地导入'
    const repositoryUrl = parsed.fields.repository || parsed.fields.repository_url || (typeof hubEntry?.identifier === 'string' && /^https?:\/\//.test(hubEntry.identifier) ? hubEntry.identifier : '')
    const stat = fs.statSync(filePath)
    const userManaged = (builtIn || Boolean(pluginId)) && fs.existsSync(path.join(directory, USER_MANAGED_MARKER))
    const officialUpdate = builtIn && this.officialUpdater.hasChannel(name) && !userManaged
    const version = this.officialUpdater.installedSkillVersion(name, directory, parsed.fields.version || '1.0.0')
    return {
      id: pluginId ? `${safeId(pluginId)}--${safeId(fallbackName)}` : safeId(fallbackName),
      name,
      description: parsed.fields.description || '这个技能尚未填写描述。',
      category: isZSenseBuiltin ? 'ZSense 内置' : pluginId ? '本地导入' : parts.length > 1 && ![CUSTOM_CATEGORY, IMPORT_CATEGORY].includes(parts[0]) ? parts[0] : isZSense ? '我的技能' : '本地导入',
      version,
      enabled: true,
      source,
      updatedAt: stat.mtime.toISOString(),
      fileCount: countFiles(directory),
      content,
      installPath: directory,
      editable: true,
      builtIn,
      essential: ESSENTIAL_SKILLS.has(name),
      defaultEnabled: isZSenseBuiltin,
      updateMode: !userManaged && (hubEntry || officialUpdate || repositoryUrl) ? 'registry' : builtIn && !userManaged ? 'runtime' : 'manual',
      repositoryUrl: repositoryUrl || (officialUpdate ? this.officialUpdater.homepage(name) : ''),
      officialUpdate,
      pluginId,
      versions: skillVersionHistory(directory),
    }
  }

  #snapshotVersion(skill, reason = 'manual') {
    const historyRoot = path.join(skill.installPath, HISTORY_DIRECTORY)
    fs.mkdirSync(historyRoot, { recursive: true, mode: 0o700 })
    const version = encodeURIComponent(String(skill.version || 'unknown').replace(/\//g, '-'))
    let timestamp = Date.now()
    while (fs.existsSync(path.join(historyRoot, `${timestamp}-${version}.md`))) timestamp += 1
    const snapshotId = `${timestamp}-${version}`
    fs.writeFileSync(path.join(historyRoot, `${snapshotId}.md`), normalizeLineEndings(skill.content), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    fs.writeFileSync(path.join(historyRoot, `${snapshotId}.json`), `${JSON.stringify({ version: skill.version, reason, createdAt: new Date().toISOString() }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    return snapshotId
  }

  listSkills() {
    const manifestNames = this.#manifestNames()
    const hubEntries = this.#hubEntries()
    const byId = new Map()
    for (const filePath of this.#skillDocuments()) {
      try {
        const skill = this.#describe(filePath, manifestNames, hubEntries)
        // 保留历史导入目录中的同名技能，避免按显示名称去重时丢失用户数据。
        if (!byId.has(skill.id) || skill.builtIn && !byId.get(skill.id).builtIn) byId.set(skill.id, skill)
      } catch { /* A malformed or oversized document should not block the whole workspace. */ }
    }
    return [...byId.values()].sort((left, right) => {
      if (left.builtIn !== right.builtIn) return left.builtIn ? -1 : 1
      return left.name.localeCompare(right.name, 'zh-CN')
    })
  }

  async checkUpdates(id = '') {
    const startedAt = Date.now()
    const scopedSkills = this.listSkills().filter((skill) => !id || skill.id === id)
    const candidates = scopedSkills.filter((skill) => skill.updateMode === 'registry' && (skill.repositoryUrl || skill.officialUpdate))
    if (id && !candidates.length) throw new Error('这个技能没有配置可在线检查的仓库地址。')
    const checkedResults = await Promise.all(candidates.map(async (skill) => {
      try {
        if (skill.officialUpdate) return await this.officialUpdater.check(skill)
        const remote = await fetchRemoteSkill(skill)
        return { id: skill.id, name: skill.name, currentVersion: skill.version, latestVersion: remote.version, updateAvailable: remote.version !== skill.version, updateMode: skill.updateMode }
      } catch (error) {
        return { id: skill.id, name: skill.name, currentVersion: skill.version, updateMode: skill.updateMode, error: error instanceof Error ? error.message : '检查失败' }
      }
    }))
    const checkedById = new Map(checkedResults.map((result) => [result.id, result]))
    const results = scopedSkills.map((skill) => checkedById.get(skill.id) || {
      id: skill.id,
      name: skill.name,
      currentVersion: skill.version,
      updateAvailable: false,
      skipped: true,
      updateMode: skill.updateMode,
    })
    const updates = results.filter((item) => item.updateAvailable)
    const failures = results.filter((item) => item.error)
    const runtimeManagedCount = scopedSkills.filter((skill) => !skill.repositoryUrl && skill.updateMode === 'runtime').length
    const manualCount = scopedSkills.filter((skill) => !skill.repositoryUrl && skill.updateMode !== 'runtime').length
    const summary = {
      totalSkills: scopedSkills.length,
      checkedCount: candidates.length,
      skippedCount: scopedSkills.length - candidates.length,
      runtimeManagedCount,
      manualCount,
      availableCount: updates.length,
      failureCount: failures.length,
      completedAt: new Date().toISOString(),
    }
    const maintenanceDetail = [
      runtimeManagedCount ? `${runtimeManagedCount} 个随 ZSense 版本更新` : '',
      manualCount ? `${manualCount} 个由你手动维护` : '',
    ].filter(Boolean).join('，')
    return {
      ok: failures.length === 0,
      output: !candidates.length
        ? `检查完成：当前没有可单独联网检查的技能${maintenanceDetail ? `；${maintenanceDetail}` : ''}。`
        : [`已检查 ${candidates.length} 个技能仓库，发现 ${updates.length} 个可用更新${maintenanceDetail ? `；${maintenanceDetail}` : ''}。`, ...updates.map((item) => `${item.name}: ${item.currentVersion} → ${item.latestVersion}`), ...failures.map((item) => item.error)].join('\n'),
      exitCode: failures.length ? 1 : 0,
      durationMs: Date.now() - startedAt,
      results,
      summary,
    }
  }

  async updateFromRepository(id) {
    const current = this.getSkill(id)
    if (!current) throw new Error('技能不存在或已经被删除。')
    if (current.officialUpdate) {
      this.#snapshotVersion(current, 'official-update')
      await this.officialUpdater.update(current)
      return this.#describe(path.join(current.installPath, SKILL_FILE))
    }
    const remote = await fetchRemoteSkill(current)
    this.#snapshotVersion(current, 'registry-update')
    const filePath = path.join(current.installPath, SKILL_FILE)
    const temporary = `${filePath}.zsense-update-${process.pid}.tmp`
    fs.writeFileSync(temporary, normalizeLineEndings(remote.content), 'utf8')
    fs.renameSync(temporary, filePath)
    this.#markUserManaged(current, 'registry-update')
    return this.#describe(filePath)
  }

  getSkill(id) {
    return this.listSkills().find((skill) => skill.id === id) || null
  }

  createSkill(input) {
    fs.mkdirSync(this.customRootPath, { recursive: true })
    const existing = new Set(this.listSkills().map((skill) => skill.id))
    const baseId = safeId(input.name)
    let id = baseId
    let suffix = 2
    while (existing.has(id) || fs.existsSync(path.join(this.customRootPath, id))) id = `${baseId}-${suffix++}`
    const directory = path.join(this.customRootPath, id)
    fs.mkdirSync(directory, { recursive: false })
    const content = serializeSkillDocument({ ...input, name: input.name.trim() }, input.content)
    fs.writeFileSync(path.join(directory, SKILL_FILE), content, { encoding: 'utf8', flag: 'wx' })
    return this.#describe(path.join(directory, SKILL_FILE))
  }

  updateSkill(id, input) {
    const current = this.getSkill(id)
    if (!current) throw new Error('技能不存在或文件已被移动。')
    if (!isInside(this.rootPath, current.installPath)) throw new Error('技能路径不在 ZSense 专属空间中。')
    this.#snapshotVersion(current, 'manual-edit')
    const filePath = path.join(current.installPath, SKILL_FILE)
    const content = serializeSkillDocument({ ...input, name: input.name.trim() }, input.content || current.content)
    const temporary = `${filePath}.zsense-${process.pid}.tmp`
    fs.writeFileSync(temporary, content, 'utf8')
    fs.renameSync(temporary, filePath)
    this.#markUserManaged(current, 'manual-edit')
    return this.#describe(filePath)
  }

  restoreVersion(id, snapshotId) {
    const current = this.getSkill(id)
    if (!current) throw new Error('技能不存在或文件已被移动。')
    const safeSnapshotId = String(snapshotId || '')
    if (!/^\d+-[^/\\]{1,160}$/.test(safeSnapshotId)) throw new Error('技能历史版本 ID 无效。')
    const source = path.join(current.installPath, HISTORY_DIRECTORY, `${safeSnapshotId}.md`)
    if (!isInside(current.installPath, source) || !fs.existsSync(source)) throw new Error('技能历史版本不存在。')
    const restoredContent = readTextFile(source)
    const evaluation = evaluateSkillDraft({ content: restoredContent })
    if (!evaluation.valid) throw new Error(`历史版本未通过安全校验：${evaluation.issues.join('；')}`)
    this.#snapshotVersion(current, 'before-restore')
    const filePath = path.join(current.installPath, SKILL_FILE)
    const temporary = `${filePath}.zsense-restore-${process.pid}.tmp`
    fs.writeFileSync(temporary, normalizeLineEndings(restoredContent), 'utf8')
    fs.renameSync(temporary, filePath)
    this.#markUserManaged(current, 'version-restore')
    return this.#describe(filePath)
  }

  importSkill(sourcePath) {
    const sourceStat = fs.statSync(sourcePath)
    const sourceDirectory = sourceStat.isDirectory() ? sourcePath : path.dirname(sourcePath)
    const skillFile = sourceStat.isDirectory() ? path.join(sourcePath, SKILL_FILE) : sourcePath
    if (path.basename(skillFile).toLowerCase() !== 'skill.md') throw new Error('请选择名为 SKILL.md 的文件。')
    const originalContent = readTextFile(skillFile)
    const parsed = parseFrontmatter(originalContent)
    const name = parsed.fields.name || path.basename(sourceDirectory)
    fs.mkdirSync(this.importRootPath, { recursive: true })
    const existing = new Set(this.listSkills().map((skill) => skill.id))
    const baseId = safeId(name)
    let id = baseId
    let suffix = 2
    while (existing.has(id) || fs.existsSync(path.join(this.importRootPath, id))) id = `${baseId}-${suffix++}`
    const destination = path.join(this.importRootPath, id)
    try {
      if (sourceStat.isDirectory()) copyDirectorySecure(sourceDirectory, destination)
      else {
        fs.mkdirSync(destination, { recursive: false })
        fs.copyFileSync(skillFile, path.join(destination, SKILL_FILE), fs.constants.COPYFILE_EXCL)
      }
      const normalized = serializeSkillDocument({
        name,
        description: parsed.fields.description || '从本地导入的共享技能。',
        version: parsed.fields.version || '1.0.0',
        repositoryUrl: parsed.fields.repository || parsed.fields.repository_url || '',
      }, originalContent)
      fs.writeFileSync(path.join(destination, SKILL_FILE), normalized, 'utf8')
      return this.#describe(path.join(destination, SKILL_FILE))
    } catch (error) {
      if (fs.existsSync(destination) && isInside(this.importRootPath, destination)) fs.rmSync(destination, { recursive: true, force: true })
      throw error
    }
  }

  deleteSkill(id) {
    const current = this.getSkill(id)
    if (!current) throw new Error('技能不存在或已经被删除。')
    if (!isInside(this.rootPath, current.installPath)) throw new Error('技能路径不在 ZSense 专属空间中。')
    if (current.builtIn && isInside(this.builtinRootPath, current.installPath)) {
      const deletedSkills = this.#deletedBundledSkills()
      deletedSkills.add(path.basename(current.installPath))
      this.#saveDeletedBundledSkills(deletedSkills)
    }
    fs.rmSync(current.installPath, { recursive: true, force: false })
  }

  getOpenPath(id) {
    if (!id) {
      fs.mkdirSync(this.rootPath, { recursive: true })
      return this.rootPath
    }
    const skill = this.getSkill(id)
    if (!skill) throw new Error('技能不存在或文件已被移动。')
    return skill.installPath
  }

  getOpenTarget(id) {
    const directory = this.getOpenPath(id)
    if (!id) return { targetPath: directory, reveal: false }
    const skillFilePath = path.join(directory, SKILL_FILE)
    if (!fs.existsSync(skillFilePath)) throw new Error('该技能的 SKILL.md 不存在或已被移动。')
    return { targetPath: skillFilePath, reveal: true }
  }
}
