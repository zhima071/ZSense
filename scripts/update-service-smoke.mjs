import assert from 'node:assert/strict'
import { UpdateService, compareVersions, normalizeVersion, parseUpdateFeed } from '../electron/services/update-service.mjs'

// 版本比较与归一化。
assert.equal(normalizeVersion('v0.24.0'), '0.24.0', '应该去掉版本号前缀')
assert.equal(normalizeVersion('0.24.0-beta.1'), '0.24.0', '应该去掉预发布后缀')
assert.equal(normalizeVersion(''), '', '空文本应该返回空版本')
assert.equal(compareVersions('0.24.0', '0.23.74'), 1, '更高的补丁号应该更大')
assert.equal(compareVersions('0.24.0', '0.24.0'), 0, '相同版本应该相等')
assert.equal(compareVersions('0.24.1', '0.25.0'), -1, '更低的次版本号应该更小')
assert.equal(compareVersions('1.0', '1.0.0'), 0, '缺少补丁位时应该按 0 处理')

// electron-builder 生成的 latest-mac.yml。
const macFeed = [
  'version: 0.25.0',
  'files:',
  '  - url: ZSense-0.25.0-mac-arm64.zip',
  '    sha512: abc',
  '    size: 1',
  '  - url: ZSense-0.25.0-mac-arm64.dmg',
  '    sha512: def',
  '    size: 2',
  'path: ZSense-0.25.0-mac-arm64.zip',
  "releaseDate: '2026-09-18T11:52:00.000Z'",
  '',
].join('\n')
const parsedMac = parseUpdateFeed(macFeed, { feedUrl: 'https://download.example.com/zsense/latest-mac.yml', platform: 'darwin' })
assert.equal(parsedMac.version, '0.25.0', '应该解析出版本号')
assert.equal(parsedMac.downloadUrl, 'https://download.example.com/zsense/ZSense-0.25.0-mac-arm64.dmg', 'macOS 应该优先选择 dmg 产物')
assert.equal(parsedMac.publishedAt, '2026-09-18T11:52:00.000Z', '应该解析出发布时间')

const parsedWin = parseUpdateFeed(macFeed, { feedUrl: 'https://download.example.com/zsense/latest.yml', platform: 'win32' })
assert.equal(parsedWin.downloadUrl, 'https://download.example.com/zsense/ZSense-0.25.0-mac-arm64.zip', '没有匹配后缀时应该回退到 path 产物')

const releasePageFeed = parseUpdateFeed('version: 0.25.0\npath: https://cdn.example.com/releases/ZSense-0.25.0-win-x64.exe\n', { feedUrl: 'https://download.example.com/zsense/latest.yml', platform: 'win32' })
assert.equal(releasePageFeed.downloadUrl, 'https://cdn.example.com/releases/ZSense-0.25.0-win-x64.exe', '应该保留绝对地址')

// 自定义 JSON 更新清单。
const jsonFeed = parseUpdateFeed(JSON.stringify({ version: '0.26.0', downloadUrl: 'https://cdn.example.com/ZSense-0.26.0-mac-arm64.dmg', notes: '修复桌面通知', publishedAt: '2026-09-19T00:00:00.000Z' }), { feedUrl: 'https://download.example.com/zsense/latest.json', platform: 'darwin' })
assert.equal(jsonFeed.version, '0.26.0', '应该解析 JSON 清单版本号')
assert.equal(jsonFeed.notes, '修复桌面通知', '应该解析发布说明')
assert.equal(parseUpdateFeed('这不是更新清单'), null, '无法识别的清单应该返回 null')
assert.equal(parseUpdateFeed(JSON.stringify({ channel: 'stable' })), null, '缺少版本字段的 JSON 应该被拒绝')

function feedResponse(body, { status = 200 } = {}) {
  return { ok: status >= 200 && status < 300, status, text: async () => body }
}

const service = new UpdateService({ currentVersion: '0.24.0', platform: 'darwin', fetchImpl: async () => feedResponse(macFeed) })
const available = await service.check('https://download.example.com/zsense/latest-mac.yml')
assert.equal(available.ok, true, '检查应该成功')
assert.equal(available.updateAvailable, true, '0.25.0 相对 0.24.0 应该提示有新版本')
assert.equal(available.latestVersion, '0.25.0', '应该返回最新版本号')
assert.equal(available.upToDate, false, '有新版本时不应标记为最新')
assert(available.checkedAt, '应该记录检查时间')

const sameVersion = await new UpdateService({ currentVersion: '0.25.0', platform: 'darwin', fetchImpl: async () => feedResponse(macFeed) }).check('https://download.example.com/zsense/latest-mac.yml')
assert.equal(sameVersion.updateAvailable, false, '版本相同不应提示更新')
assert.equal(sameVersion.upToDate, true, '版本相同应该标记为最新')

const downgrade = await new UpdateService({ currentVersion: '0.26.0', platform: 'darwin', fetchImpl: async () => feedResponse(macFeed) }).check('https://download.example.com/zsense/latest-mac.yml')
assert.equal(downgrade.updateAvailable, false, '本地版本更高时不应提示更新')

const httpError = await new UpdateService({ currentVersion: '0.24.0', fetchImpl: async () => feedResponse('', { status: 404 }) }).check('https://download.example.com/zsense/latest-mac.yml')
assert.equal(httpError.ok, false, '更新源 404 应该返回失败')
assert.match(httpError.error, /404/, '失败信息应该包含状态码')

const badBody = await new UpdateService({ currentVersion: '0.24.0', fetchImpl: async () => feedResponse('hello') }).check('https://download.example.com/zsense/latest-mac.yml')
assert.equal(badBody.ok, false, '无法识别的清单应该返回失败')
assert.match(badBody.error, /无法识别/, '失败信息应该说明格式问题')

const networkFailure = await new UpdateService({ currentVersion: '0.24.0', fetchImpl: async () => { throw new Error('getaddrinfo ENOTFOUND') } }).check('https://download.example.com/zsense/latest-mac.yml')
assert.equal(networkFailure.ok, false, '网络异常应该返回失败而不是抛出')
assert.match(networkFailure.error, /ENOTFOUND/, '应该保留底层错误信息')

const emptyUrl = await new UpdateService({ currentVersion: '0.24.0' }).check('   ')
assert.equal(emptyUrl.ok, false, '空地址应该返回失败')
assert.match(emptyUrl.error, /请先填写更新检查地址/, '空地址应该给出配置提示')

const badProtocol = await new UpdateService({ currentVersion: '0.24.0' }).check('ftp://download.example.com/latest.yml')
assert.equal(badProtocol.ok, false, '非 HTTP 协议应该被拒绝')
assert.match(badProtocol.error, /HTTP 或 HTTPS/, '非 HTTP 协议应该给出协议提示')

assert.deepEqual(new UpdateService({ currentVersion: '0.24.0', platform: 'darwin' }).inspect(), { currentVersion: '0.24.0', platform: 'darwin' }, '状态应该返回当前版本与平台')

console.log(JSON.stringify({
  ok: true,
  engine: 'update-service',
  builderFeedParsed: true,
  jsonFeedParsed: true,
  downloadSelection: true,
  versionComparison: true,
  failureHandling: true,
}))
