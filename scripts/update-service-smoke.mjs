import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { UpdateService, compareVersions, defaultUpdateFeedUrl, normalizeVersion, parseUpdateFeed } from '../electron/services/update-service.mjs'
import { scheduleUpdateInstall } from '../electron/services/update-install-service.mjs'

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

const parsedWin = parseUpdateFeed(macFeed, { feedUrl: 'https://download.example.com/zsense/latest.yml', platform: 'win32', arch: 'x64' })
assert.equal(parsedWin.downloadUrl, '', 'Windows 不应该错误地选择 macOS 安装包')

const releasePageFeed = parseUpdateFeed('version: 0.25.0\npath: https://cdn.example.com/releases/ZSense-0.25.0-win-x64.exe\n', { feedUrl: 'https://download.example.com/zsense/latest.yml', platform: 'win32', arch: 'x64' })
assert.equal(releasePageFeed.downloadUrl, 'https://cdn.example.com/releases/ZSense-0.25.0-win-x64.exe', '应该保留绝对地址')

// 自定义 JSON 更新清单。
const jsonFeed = parseUpdateFeed(JSON.stringify({ version: '0.26.0', downloadUrl: 'https://cdn.example.com/ZSense-0.26.0-mac-arm64.dmg', notes: '修复桌面通知', publishedAt: '2026-09-19T00:00:00.000Z' }), { feedUrl: 'https://download.example.com/zsense/latest.json', platform: 'darwin' })
assert.equal(jsonFeed.version, '0.26.0', '应该解析 JSON 清单版本号')
assert.equal(jsonFeed.notes, '修复桌面通知', '应该解析发布说明')
assert.equal(parseUpdateFeed('这不是更新清单'), null, '无法识别的清单应该返回 null')
assert.equal(parseUpdateFeed(JSON.stringify({ channel: 'stable' })), null, '缺少版本字段的 JSON 应该被拒绝')

const githubRelease = JSON.stringify({
  tag_name: 'v0.26.5',
  body: '正式发布',
  published_at: '2026-10-05T06:30:00Z',
  url: 'https://api.github.com/repos/zhima071/ZSense/releases/1',
  assets: [
    { browser_download_url: 'https://github.com/zhima071/ZSense/releases/download/v0.26.5/ZSense-0.26.5-mac-arm64.dmg' },
    { browser_download_url: 'https://github.com/zhima071/ZSense/releases/download/v0.26.5/ZSense-0.26.5-win-x64.exe' },
  ],
})
assert.equal(defaultUpdateFeedUrl(), 'https://api.github.com/repos/zhima071/ZSense/releases/latest')
assert.equal(parseUpdateFeed(githubRelease, { feedUrl: defaultUpdateFeedUrl(), platform: 'darwin' }).downloadUrl, 'https://github.com/zhima071/ZSense/releases/download/v0.26.5/ZSense-0.26.5-mac-arm64.dmg')
assert.equal(parseUpdateFeed(githubRelease, { feedUrl: defaultUpdateFeedUrl(), platform: 'win32', arch: 'x64' }).downloadUrl, 'https://github.com/zhima071/ZSense/releases/download/v0.26.5/ZSense-0.26.5-win-x64.exe')

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

const oversizedFeed = await new UpdateService({ currentVersion: '0.24.0', fetchImpl: async () => new Response('x'.repeat(300 * 1024)) })
  .check('https://download.example.com/zsense/latest-mac.yml')
assert.equal(oversizedFeed.ok, false, '超大清单应在读取阶段拒绝')
assert.match(oversizedFeed.error, /过大/)

const networkFailure = await new UpdateService({ currentVersion: '0.24.0', fetchImpl: async () => { throw new Error('getaddrinfo ENOTFOUND') } }).check('https://download.example.com/zsense/latest-mac.yml')
assert.equal(networkFailure.ok, false, '网络异常应该返回失败而不是抛出')
assert.match(networkFailure.error, /ENOTFOUND/, '应该保留底层错误信息')

const emptyUrl = await new UpdateService({ currentVersion: '0.24.0' }).check('   ')
assert.equal(emptyUrl.ok, false, '空地址应该返回失败')
assert.match(emptyUrl.error, /请先填写更新检查地址/, '空地址应该给出配置提示')

const badProtocol = await new UpdateService({ currentVersion: '0.24.0' }).check('ftp://download.example.com/latest.yml')
assert.equal(badProtocol.ok, false, '非 HTTP 协议应该被拒绝')
assert.match(badProtocol.error, /HTTP 或 HTTPS/, '非 HTTP 协议应该给出协议提示')

assert.deepEqual(new UpdateService({ currentVersion: '0.24.0', platform: 'darwin' }).inspect(), {
  currentVersion: '0.24.0', platform: 'darwin',
  download: { phase: 'idle', version: '', receivedBytes: 0, totalBytes: 0, bytesPerSecond: 0, error: '' },
}, '状态应该返回当前版本与下载状态')

const payload = Buffer.from('test installer bytes for update verification')
const checksum = createHash('sha256').update(payload).digest('hex')
const releaseUrl = 'https://github.com/zhima071/ZSense/releases/download/v0.26.9/ZSense-0.26.9-mac-arm64.dmg'
const releaseFeed = JSON.stringify({
  tag_name: 'v0.26.9', body: `新版说明\n\nSHA-256 校验值：\n- ZSense-0.26.9-mac-arm64.dmg: ${checksum}`,
  assets: [{ browser_download_url: releaseUrl, size: payload.length }],
})
const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'zsense-updater-test-'))
let downloadCalls = 0
let installCalls = 0
let quitCalls = 0
try {
  const updater = new UpdateService({ currentVersion: '0.26.8', platform: 'darwin', arch: 'arm64',
    downloadDirectory: tempDirectory,
    fetchImpl: async (url) => {
      if (url === defaultUpdateFeedUrl()) return new Response(releaseFeed, { headers: { 'Content-Type': 'application/json' } })
      assert.equal(url, releaseUrl)
      downloadCalls += 1
      return new Response(payload, { headers: { 'Content-Length': String(payload.length) } })
    },
    installImpl: async () => { installCalls += 1 }, quitApp: () => { quitCalls += 1 },
  })
  const result = await updater.check(defaultUpdateFeedUrl())
  assert.equal(result.installSupported, true, '官方发布且校验值存在时应允许应用内安装')
  assert.equal((await updater.download()).phase, 'ready', '下载与 SHA-256 校验后应进入待安装状态')
  assert.equal(downloadCalls, 1)
  assert.equal((await updater.download()).phase, 'ready', '重复点击应复用已校验的安装包')
  assert.equal(downloadCalls, 1)
  assert.equal((await updater.install()).scheduled, true, '已校验包可以交给平台安装器')
  assert.equal(installCalls, 1)
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(quitCalls, 1, '安装器已启动后才退出当前应用')

  const speedPayload = Buffer.alloc(64 * 1024, 7)
  const speedChecksum = createHash('sha256').update(speedPayload).digest('hex')
  const speedFeed = JSON.stringify({ tag_name: 'v0.26.9', body: `- ZSense-0.26.9-mac-arm64.dmg: ${speedChecksum}`,
    assets: [{ browser_download_url: releaseUrl, size: speedPayload.length }] })
  let currentFeed = releaseFeed
  const changedReleaseUpdater = new UpdateService({ currentVersion: '0.26.8', platform: 'darwin', arch: 'arm64',
    downloadDirectory: path.join(tempDirectory, 'same-version-change'),
    fetchImpl: async (url) => new Response(url === defaultUpdateFeedUrl() ? currentFeed : payload),
  })
  await changedReleaseUpdater.check(defaultUpdateFeedUrl())
  assert.equal((await changedReleaseUpdater.download()).phase, 'ready')
  currentFeed = speedFeed
  await changedReleaseUpdater.check(defaultUpdateFeedUrl())
  assert.equal(changedReleaseUpdater.inspect().download.phase, 'idle', '同一版本的发布包校验值变化后，旧包不可继续显示为可安装')
  await assert.rejects(changedReleaseUpdater.install(), /先在应用内下载并校验/, '旧校验值的安装包不能直接安装')
  const speedSnapshots = []
  const speedUpdater = new UpdateService({ currentVersion: '0.26.8', platform: 'darwin', arch: 'arm64',
    downloadDirectory: path.join(tempDirectory, 'speed'),
    onProgress: (status) => speedSnapshots.push(status),
    fetchImpl: async (url) => url === defaultUpdateFeedUrl() ? new Response(speedFeed) : new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(speedPayload.subarray(0, speedPayload.length / 2))
        setTimeout(() => { controller.enqueue(speedPayload.subarray(speedPayload.length / 2)); controller.close() }, 1_100)
      },
    }), { headers: { 'Content-Length': String(speedPayload.length) } }),
  })
  await speedUpdater.check(defaultUpdateFeedUrl())
  await speedUpdater.download()
  assert(speedSnapshots.some((status) => status.phase === 'downloading' && status.bytesPerSecond > 0), '下载中应该定时报告实时速度')
  assert.equal(speedUpdater.inspect().download.bytesPerSecond, 0, '下载完成后应清零速度')

  const badUpdater = new UpdateService({ currentVersion: '0.26.8', platform: 'darwin', arch: 'arm64',
    downloadDirectory: path.join(tempDirectory, 'bad'),
    fetchImpl: async (url) => url === defaultUpdateFeedUrl() ? new Response(releaseFeed) : new Response('tampered bytes'),
  })
  await badUpdater.check(defaultUpdateFeedUrl())
  await assert.rejects(badUpdater.download(), /大小与发布记录不一致|SHA-256 校验失败/, '损坏的安装包应拒绝')
  assert.equal(fs.existsSync(path.join(tempDirectory, 'bad', 'ZSense-0.26.9-mac-arm64.dmg')), false, '损坏的文件不应保留')
  const custom = await new UpdateService({ currentVersion: '0.26.8', platform: 'darwin', arch: 'arm64',
    fetchImpl: async () => new Response(JSON.stringify({ version: '0.26.9', downloadUrl: releaseUrl, sha256: checksum })),
  }).check('https://example.com/latest.json')
  assert.equal(custom.installSupported, false, '自定义更新清单不可借用官方 URL 静默执行安装')

  let started
  const downloading = new Promise((resolve) => { started = resolve })
  const cancelUpdater = new UpdateService({ currentVersion: '0.26.8', platform: 'darwin', arch: 'arm64',
    downloadDirectory: path.join(tempDirectory, 'cancel'),
    onProgress: (status) => { if (status.phase === 'downloading') started() },
    fetchImpl: (url, options) => url === defaultUpdateFeedUrl() ? Promise.resolve(new Response(releaseFeed))
      : new Promise((_resolve, reject) => {
        if (options.signal.aborted) return reject(new DOMException('Aborted', 'AbortError'))
        options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
      }),
  })
  await cancelUpdater.check(defaultUpdateFeedUrl())
  const pending = cancelUpdater.download()
  await downloading
  await cancelUpdater.cancelDownload()
  assert.equal((await pending).phase, 'canceled', '取消下载不应当作为错误返回')
  assert.equal(cancelUpdater.inspect().download.phase, 'canceled')

  const activeCancelDirectory = path.join(tempDirectory, 'active-cancel')
  let activeChunk
  const activeChunkReceived = new Promise((resolve) => { activeChunk = resolve })
  const activeCancelUpdater = new UpdateService({ currentVersion: '0.26.8', platform: 'darwin', arch: 'arm64',
    downloadDirectory: activeCancelDirectory,
    onProgress: (status) => { if (status.phase === 'downloading' && status.receivedBytes > 0) activeChunk() },
    fetchImpl: (url, options) => url === defaultUpdateFeedUrl() ? Promise.resolve(new Response(speedFeed))
      : Promise.resolve(new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(speedPayload.subarray(0, speedPayload.length / 2))
          options.signal.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')))
        },
      }))),
  })
  await activeCancelUpdater.check(defaultUpdateFeedUrl())
  const activePending = activeCancelUpdater.download()
  await activeChunkReceived
  assert.equal((await activeCancelUpdater.cancelDownload()).phase, 'canceled')
  assert.equal((await activePending).phase, 'canceled')
  assert.equal(fs.existsSync(path.join(activeCancelDirectory, 'ZSense-0.26.9-mac-arm64.dmg.part')), false,
    '进行中的下载被取消后必须删除缓存')

  const resumeDirectory = path.join(tempDirectory, 'resume')
  const half = Math.floor(speedPayload.length / 2)
  const resumePartialPath = path.join(resumeDirectory, 'ZSense-0.26.9-mac-arm64.dmg.part')
  let firstChunk
  const firstChunkWritten = new Promise((resolve) => { firstChunk = resolve })
  const pauseUpdater = new UpdateService({ currentVersion: '0.26.8', platform: 'darwin', arch: 'arm64',
    downloadDirectory: resumeDirectory,
    onProgress: (status) => { if (status.phase === 'downloading' && status.receivedBytes >= half) firstChunk() },
    fetchImpl: (url, options) => url === defaultUpdateFeedUrl() ? Promise.resolve(new Response(speedFeed))
      : Promise.resolve(new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(speedPayload.subarray(0, half))
          options.signal.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')))
        },
      }), { headers: { 'Content-Length': String(speedPayload.length) } })),
  })
  await pauseUpdater.check(defaultUpdateFeedUrl())
  const pausedDownload = pauseUpdater.download()
  await firstChunkWritten
  for (let attempt = 0; attempt < 100 && (!fs.existsSync(resumePartialPath) || fs.statSync(resumePartialPath).size < half); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.equal((await pauseUpdater.pauseDownload()).phase, 'paused', '暂停应保留未完成下载')
  assert.equal((await pausedDownload).phase, 'paused')
  assert.equal(fs.statSync(resumePartialPath).size, half, '暂停应保留已下载字节')
  assert.equal(fs.readFileSync(`${resumePartialPath}.sha256`, 'utf8'), speedChecksum, '暂停缓存应记录目标安装包校验值')

  let requestedRange = ''
  const resumedUpdater = new UpdateService({ currentVersion: '0.26.8', platform: 'darwin', arch: 'arm64',
    downloadDirectory: resumeDirectory,
    fetchImpl: async (url, options) => {
      if (url === defaultUpdateFeedUrl()) return new Response(speedFeed)
      requestedRange = options.headers.Range
      return new Response(speedPayload.subarray(half), { status: 206, headers: {
        'Content-Range': `bytes ${half}-${speedPayload.length - 1}/${speedPayload.length}`,
        'Content-Length': String(speedPayload.length - half),
      } })
    },
  })
  await resumedUpdater.check(defaultUpdateFeedUrl())
  assert.equal(resumedUpdater.inspect().download.phase, 'paused', '重启后应识别未完成下载')
  assert.equal(resumedUpdater.inspect().download.receivedBytes, half)
  assert.equal((await resumedUpdater.download()).phase, 'ready', '206 响应应从断点续传并校验完整文件')
  assert.equal(requestedRange, `bytes=${half}-`)
  assert.deepEqual(fs.readFileSync(path.join(resumeDirectory, 'ZSense-0.26.9-mac-arm64.dmg')), speedPayload)

  const fallbackDirectory = path.join(tempDirectory, 'range-ignored')
  fs.mkdirSync(fallbackDirectory)
  const fallbackPartial = path.join(fallbackDirectory, 'ZSense-0.26.9-mac-arm64.dmg.part')
  fs.writeFileSync(fallbackPartial, speedPayload.subarray(0, half))
  fs.writeFileSync(`${fallbackPartial}.sha256`, speedChecksum)
  const fallbackUpdater = new UpdateService({ currentVersion: '0.26.8', platform: 'darwin', arch: 'arm64',
    downloadDirectory: fallbackDirectory,
    fetchImpl: async (url, options) => {
      if (url === defaultUpdateFeedUrl()) return new Response(speedFeed)
      assert.equal(options.headers.Range, `bytes=${half}-`)
      return new Response(speedPayload)
    },
  })
  await fallbackUpdater.check(defaultUpdateFeedUrl())
  assert.equal((await fallbackUpdater.download()).phase, 'ready', '服务器不支持 Range 时应安全地从头下载')
  assert.deepEqual(fs.readFileSync(path.join(fallbackDirectory, 'ZSense-0.26.9-mac-arm64.dmg')), speedPayload)

  const invalidRangeDirectory = path.join(tempDirectory, 'invalid-range')
  fs.mkdirSync(invalidRangeDirectory)
  const invalidRangePartial = path.join(invalidRangeDirectory, 'ZSense-0.26.9-mac-arm64.dmg.part')
  fs.writeFileSync(invalidRangePartial, speedPayload.subarray(0, half))
  fs.writeFileSync(`${invalidRangePartial}.sha256`, speedChecksum)
  const invalidRangeUpdater = new UpdateService({ currentVersion: '0.26.8', platform: 'darwin', arch: 'arm64',
    downloadDirectory: invalidRangeDirectory,
    fetchImpl: async (url) => url === defaultUpdateFeedUrl() ? new Response(speedFeed)
      : new Response(speedPayload.subarray(half), { status: 206, headers: {
        'Content-Range': `bytes 0-${half - 1}/${speedPayload.length}`,
      } }),
  })
  await invalidRangeUpdater.check(defaultUpdateFeedUrl())
  await assert.rejects(invalidRangeUpdater.download(), /续传范围不正确/, '错误的 Content-Range 必须拒绝')
  assert.equal(fs.statSync(invalidRangePartial).size, half, '无效续传响应不得污染已有缓存')

  const clearedDirectory = path.join(tempDirectory, 'cleared')
  fs.mkdirSync(clearedDirectory)
  const clearedPartialPath = path.join(clearedDirectory, 'ZSense-0.26.9-mac-arm64.dmg.part')
  fs.writeFileSync(clearedPartialPath, speedPayload.subarray(0, half))
  fs.writeFileSync(`${clearedPartialPath}.sha256`, speedChecksum)
  const clearedUpdater = new UpdateService({ currentVersion: '0.26.8', platform: 'darwin', arch: 'arm64',
    downloadDirectory: clearedDirectory, fetchImpl: async () => new Response(speedFeed) })
  await clearedUpdater.check(defaultUpdateFeedUrl())
  assert.equal((await clearedUpdater.cancelDownload()).phase, 'canceled', '取消暂停中的下载应清理缓存')
  assert.equal(fs.existsSync(clearedPartialPath), false)
  assert.equal(fs.existsSync(`${clearedPartialPath}.sha256`), false)

  const replacedDirectory = path.join(tempDirectory, 'replaced-release')
  fs.mkdirSync(replacedDirectory)
  const replacedPartial = path.join(replacedDirectory, 'ZSense-0.26.9-mac-arm64.dmg.part')
  fs.writeFileSync(replacedPartial, payload.subarray(0, 8))
  fs.writeFileSync(`${replacedPartial}.sha256`, checksum)
  const replacedUpdater = new UpdateService({ currentVersion: '0.26.8', platform: 'darwin', arch: 'arm64',
    downloadDirectory: replacedDirectory, fetchImpl: async () => new Response(speedFeed) })
  await replacedUpdater.check(defaultUpdateFeedUrl())
  assert.equal(replacedUpdater.inspect().download.phase, 'idle', '同名发布文件换了校验值时不得续传旧缓存')
  assert.equal(fs.existsSync(replacedPartial), false, '失效缓存应及时清理以免占用磁盘')
  assert.equal(fs.existsSync(`${replacedPartial}.sha256`), false)

  await assert.rejects(scheduleUpdateInstall({ platform: 'darwin', filePath: path.join(tempDirectory, 'wrong.dmg'),
    version: '0.26.9', execPath: '/Applications/ZSense.app/Contents/MacOS/ZSense',
    parentPid: process.pid, downloadDirectory: tempDirectory }), /不匹配|ENOENT/, '安装入口不能执行任意文件')
} finally {
  fs.rmSync(tempDirectory, { recursive: true, force: true })
}

console.log(JSON.stringify({
  ok: true,
  engine: 'update-service',
  builderFeedParsed: true,
  jsonFeedParsed: true,
  downloadSelection: true,
  versionComparison: true,
  failureHandling: true,
}))
