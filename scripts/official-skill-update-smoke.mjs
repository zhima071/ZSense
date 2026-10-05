import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { OfficialSkillUpdater } from '../electron/services/official-skill-updater.mjs'

if (process.platform === 'win32') {
  console.log(JSON.stringify({ ok: true, skipped: 'POSIX fake CLI fixture' }))
  process.exit(0)
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zsense-official-skill-update-'))
const bin = path.join(root, 'toolchain', 'bin')
fs.mkdirSync(bin, { recursive: true })

const fixture = `#!/bin/sh
name="$(basename "$0")"
case "$name:$1" in
  dws:version) printf 'Version: v1.0.61\\n' ;;
  dws:upgrade) printf '{"current_version":"v1.0.61","latest_version":"v1.0.62","release_url":"https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli/releases/tag/v1.0.62"}\\n' ;;
  kdocs-cli:version) printf '2.5.7\\n' ;;
  kdocs-cli:upgrade) printf 'Current version: 2.5.7\\nLatest version: 2.6.16\\n' ;;
  lark-cli:--version) printf 'lark-cli version 1.0.95\\n' ;;
  lark-cli:update) printf '{"current_version":"1.0.95","latest_version":"1.0.96","url":"https://github.com/larksuite/cli/releases/tag/v1.0.96"}\\n' ;;
  officecli:--version) printf '1.0.151\\n' ;;
  bsk:--version) printf 'bsk 0.3.0\\n' ;;
  bsk:update) printf '{"current_version":"0.3.0","latest_version":"0.3.0","release_url":"https://github.com/Tencent/BrowserSkill/releases/tag/cli-v0.3.0"}\\n' ;;
  *) printf 'unsupported fake CLI call: %s %s\\n' "$name" "$*" >&2; exit 2 ;;
esac
`

for (const name of ['dws', 'kdocs-cli', 'lark-cli', 'officecli', 'bsk']) {
  const target = path.join(bin, name)
  fs.writeFileSync(target, fixture, { mode: 0o755 })
}

const kdocsArchiveRoot = path.join(root, 'archive-fixtures')
const kdocsRepositoryRoot = path.join(kdocsArchiveRoot, 'kdocs-skill-master')
fs.mkdirSync(kdocsRepositoryRoot, { recursive: true })
fs.writeFileSync(path.join(kdocsRepositoryRoot, 'SKILL.md'), '---\nname: kdocs\nversion: 2.5.29\n---\n')
const kdocsArchivePath = path.join(root, 'kdocs-skill-master.tar.gz')
execFileSync('tar', ['-czf', kdocsArchivePath, '-C', kdocsArchiveRoot, 'kdocs-skill-master'])
const kdocsArchive = fs.readFileSync(kdocsArchivePath)

const requestedUrls = []
const json = (value) => Buffer.from(JSON.stringify(value))
const requestBuffer = async (url) => {
  requestedUrls.push(url)
  assert(
    /^https:\/\/api\.github\.com\//.test(url)
      || /^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\.atom$/.test(url)
      || url === 'https://github.com/kdocs-app/kdocs-skill/archive/refs/heads/master.tar.gz',
    `检查阶段访问了非官方元数据地址：${url}`,
  )
  if (url === 'https://github.com/kdocs-app/kdocs-skill/archive/refs/heads/master.tar.gz') return kdocsArchive
  if (url === 'https://github.com/iOfficeAI/OfficeCLI/releases.atom') return Buffer.from('<feed><entry><link href="https://github.com/iOfficeAI/OfficeCLI/releases/tag/v1.0.151" /></entry></feed>')
  throw new Error(`unexpected request: ${url}`)
}

try {
  const updater = new OfficialSkillUpdater({ agentHomePath: root, requestBuffer })
  const inputs = [
    { id: 'dws', name: 'dws', version: '1.0.0' },
    { id: 'kdocs', name: 'kdocs', version: '2.5.7' },
    { id: 'lark', name: 'lark', version: '1.0.0' },
    { id: 'officecli', name: 'officecli', version: '1.0.0' },
    { id: 'browser-skill', name: 'browser-skill', version: '0.3.0' },
  ]
  const results = Object.fromEntries(await Promise.all(inputs.map(async (skill) => [skill.name, await updater.check(skill)])))

  assert.equal(results.dws.currentVersion, '1.0.61')
  assert.equal(results.dws.latestVersion, '1.0.62')
  assert.equal(results.dws.updateAvailable, true)
  assert.equal(results.kdocs.currentVersion, '2.5.7')
  assert.equal(results.kdocs.latestVersion, '2.5.29 · CLI 2.6.16')
  assert.equal(results.kdocs.updateAvailable, true)
  assert.equal(results.lark.currentVersion, '1.0.95')
  assert.equal(results.lark.latestVersion, '1.0.96')
  assert.equal(results.officecli.currentVersion, '1.0.151')
  assert.equal(results.officecli.updateAvailable, false)
  assert.equal(results['browser-skill'].currentVersion, '0.3.0')
  assert.equal(results['browser-skill'].updateAvailable, false)
  assert.equal(requestedUrls.some((url) => url.includes('raw.githubusercontent.com') || url.includes('codeload.github.com')), false)
  assert.equal(fs.existsSync(path.join(root, 'skills')), false, '只检查更新时不应写入技能目录')

  const updaterSource = fs.readFileSync(new URL('../electron/services/official-skill-updater.mjs', import.meta.url), 'utf8')
  const ipcSource = fs.readFileSync(new URL('../electron/ipc.mjs', import.meta.url), 'utf8')
  const mainSource = fs.readFileSync(new URL('../electron/main.mjs', import.meta.url), 'utf8')
  const skillsPageSource = fs.readFileSync(new URL('../src/components/SkillsPage.tsx', import.meta.url), 'utf8')
  assert.equal(updaterSource.includes('raw.githubusercontent.com'), false, '官方更新器仍依赖 raw.githubusercontent.com')
  assert(updaterSource.includes("archiveAccept = archiveUrl.startsWith('https://api.github.com/')"), 'GitHub tarball 请求没有使用兼容的 Accept 类型')
  assert.equal(updaterSource.includes('HOME: this.agentHomePath'), false, 'CLI 更新仍会覆盖 HOME 并导致登录凭据丢失')
  assert(updaterSource.includes('fs.chmodSync(this.#toolPath(channel), 0o755)'), 'CLI 自更新后没有恢复 Unix 可执行权限')
  assert(ipcSource.includes('currentVersion: installedVersion, latestVersion: installedVersion'), '更新成功后没有同步刷新当前版本显示')
  assert(mainSource.includes('requestBuffer: fetchOfficialUpdateBuffer'), '桌面端没有注入遵循系统网络设置的下载器')
  assert(skillsPageSource.includes('不会后台自动联网'), '技能页面没有明确说明仅手动检查')

  console.log(JSON.stringify({ ok: true, channels: Object.keys(results), manualCheckOnly: true, officialMetadataOnlyDuringCheck: true }))
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
