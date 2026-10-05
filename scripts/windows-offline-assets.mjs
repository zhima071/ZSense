import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
export const projectDirectory = path.resolve(scriptDirectory, '..')
export const windowsBundleRoot = path.join(projectDirectory, 'bundled-tools', 'win32-x64')
export const mossBundleRoot = path.join(projectDirectory, 'bundled-tools', 'shared', 'tts', 'moss')

const optionalMirror = String(process.env.ZSENSE_WINDOWS_TOOLS_MIRROR || '').replace(/\/+$/, '')
const mirrorUrl = (relativePath) => optionalMirror ? `${optionalMirror}/${relativePath.replace(/^\/+/, '')}` : ''

export const windowsSourceAssets = Object.freeze([
  {
    id: 'cloudflared',
    version: '2026.7.3',
    archiveName: 'cloudflared-windows-amd64.exe',
    sha256: '2837888cc0f5d58f15b6dc478376de90b4d3ba5241c7947455d1e0a0df429712',
    urls: [
      mirrorUrl('cloudflared/2026.7.3/cloudflared-windows-amd64.exe'),
      'https://github.com/cloudflare/cloudflared/releases/download/2026.7.3/cloudflared-windows-amd64.exe',
    ].filter(Boolean),
  },
  {
    id: 'officecli',
    version: '1.0.149',
    archiveName: 'officecli-win-x64.exe',
    sha256: 'abd82dae417b66aae62d1ec8edbf88ba9d5be7442b55be470b34b764f10731e2',
    urls: [
      mirrorUrl('officecli/v1.0.149/officecli-win-x64.exe'),
      'https://d.officecli.ai/releases/download/v1.0.149/officecli-win-x64.exe',
      'https://github.com/iOfficeAI/OfficeCLI/releases/download/v1.0.149/officecli-win-x64.exe',
    ].filter(Boolean),
  },
  {
    id: 'dws',
    version: '1.0.61',
    archiveName: 'dws-windows-amd64.zip',
    sha256: 'defdcf217bddfb74254c6eeaff408f8b23dddb44729cd997b6d85aa6ce7727a0',
    urls: [
      mirrorUrl('dws/v1.0.61/dws-windows-amd64.zip'),
      'https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli/releases/download/v1.0.61/dws-windows-amd64.zip',
    ].filter(Boolean),
  },
  {
    id: 'kdocs-cli',
    version: '2.5.7',
    archiveName: 'kdocs-cli-2.5.7-windows-amd64.zip',
    sha256: 'e9a7e152d38db9766a60cc207e9d79d8d9c449c4e38ec8c2b19ed10765780b81',
    urls: [
      mirrorUrl('kdocs/v2.5.7/kdocs-cli-2.5.7-windows-amd64.zip'),
      'https://wpsai.wpscdn.cn/skillhub/pro/v2.5.7/releases/kdocs-cli-2.5.7-windows-amd64.zip',
    ].filter(Boolean),
  },
  {
    id: 'lark-cli',
    version: '1.0.95',
    archiveName: 'lark-cli-1.0.95-windows-amd64.zip',
    sha256: 'f2d5c3d6316b19ceec0996871ca4cff89541b82ed0d90220b3643ee0e84890a8',
    urls: [
      mirrorUrl('lark-cli/v1.0.95/lark-cli-1.0.95-windows-amd64.zip'),
      'https://github.com/larksuite/cli/releases/download/v1.0.95/lark-cli-1.0.95-windows-amd64.zip',
      'https://registry.npmmirror.com/-/binary/lark-cli/v1.0.95/lark-cli-1.0.95-windows-amd64.zip',
    ].filter(Boolean),
  },
  {
    id: 'browser-skill',
    version: '0.3.0',
    archiveName: 'bsk-v0.3.0-x86_64-pc-windows-msvc.zip',
    sha256: 'cd31665559d0faae2cfb79ab1c3cb6854bce10b4fde510be015456e8370f629e',
    urls: [
      mirrorUrl('browser-skill/v0.3.0/bsk-v0.3.0-x86_64-pc-windows-msvc.zip'),
      'https://github.com/Tencent/BrowserSkill/releases/download/cli-v0.3.0/bsk-v0.3.0-x86_64-pc-windows-msvc.zip',
    ].filter(Boolean),
  },
  {
    id: 'whisper.cpp',
    version: 'b5130',
    archiveName: 'whisper-bin-x64.zip',
    sha256: 'f9ec6c52a2e949b62ab51fa21d0d497958f9e41c3010c157c4e42932d5316f3c',
    urls: [
      mirrorUrl('whisper.cpp/b5130/whisper-bin-x64.zip'),
      'https://github.com/ggml-org/whisper.cpp/releases/download/b5130/whisper-bin-x64.zip',
    ].filter(Boolean),
  },
  {
    id: 'microsoft-vc-redist',
    version: '14.50.35719',
    archiveName: 'VC_redist.x64.exe',
    sha256: 'cc0ff0eb1dc3f5188ae6300faef32bf5beeba4bdd6e8e445a9184072096b713b',
    urls: [
      mirrorUrl('microsoft/vc-redist/14.50.35719/VC_redist.x64.exe'),
      'https://aka.ms/vs/17/release/vc_redist.x64.exe',
    ].filter(Boolean),
  },
])

export const windowsRequiredFiles = Object.freeze([
  'cloudflared.exe',
  'officecli.exe',
  'dws.exe',
  'kdocs-cli.exe',
  'lark-cli.exe',
  'bsk.exe',
  'stt/whisper-cli.exe',
  'stt/whisper.dll',
  'stt/ggml.dll',
  'stt/ggml-base.dll',
  'stt/ggml-cpu-alderlake.dll',
  'stt/ggml-cpu-cannonlake.dll',
  'stt/ggml-cpu-cascadelake.dll',
  'stt/ggml-cpu-haswell.dll',
  'stt/ggml-cpu-icelake.dll',
  'stt/ggml-cpu-sandybridge.dll',
  'stt/ggml-cpu-skylakex.dll',
  'stt/ggml-cpu-sse42.dll',
  'stt/ggml-cpu-x64.dll',
  'stt/ggml-base.bin',
  'stt/LICENSE.whisper.cpp',
  'stt/LICENSE.openai-whisper',
  'redist/VC_redist.x64.exe',
  'licenses/LICENSE.officecli',
  'licenses/LICENSE.dws',
  'licenses/NOTICE.dws',
  'licenses/LICENSE.lark-cli',
  'licenses/LICENSE.bsk',
  'THIRD_PARTY_NOTICES.txt',
])

export const windowsX64PeFiles = Object.freeze(windowsRequiredFiles.filter((file) => /(?:\.exe|\.dll)$/i.test(file) && !file.includes('VC_redist')))

export function sha256File(filePath) {
  const hash = crypto.createHash('sha256')
  const descriptor = fs.openSync(filePath, 'r')
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  try {
    let read = 0
    while ((read = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, read))
  } finally {
    fs.closeSync(descriptor)
  }
  return hash.digest('hex')
}

export function listFiles(rootPath, relativePath = '') {
  const files = []
  for (const entry of fs.readdirSync(path.join(rootPath, relativePath), { withFileTypes: true })) {
    const next = path.join(relativePath, entry.name)
    if (entry.isDirectory()) files.push(...listFiles(rootPath, next))
    else if (entry.isFile()) files.push(next.split(path.sep).join('/'))
    else throw new Error(`Windows 离线资源不能包含符号链接或特殊文件：${next}`)
  }
  return files.sort()
}

export function assertWindowsX64Pe(filePath, label = filePath) {
  const data = fs.readFileSync(filePath)
  if (data.length < 128 || data[0] !== 0x4d || data[1] !== 0x5a) throw new Error(`${label} 不是有效的 Windows PE 文件。`)
  const header = data.readUInt32LE(0x3c)
  if (header + 6 > data.length || data.toString('ascii', header, header + 4) !== 'PE\u0000\u0000') throw new Error(`${label} 的 PE 头无效。`)
  if (data.readUInt16LE(header + 4) !== 0x8664) throw new Error(`${label} 不是 Windows x64 二进制。`)
}

function verifyMossBundle(rootPath = mossBundleRoot) {
  const manifestPath = path.join(rootPath, 'manifest.json')
  if (!fs.existsSync(manifestPath)) throw new Error('缺少 MOSS-TTS-Nano 离线模型清单。')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  if (!manifest.offline || !Array.isArray(manifest.files) || !manifest.files.length) throw new Error('MOSS-TTS-Nano 清单不是完整离线清单。')
  for (const entry of manifest.files) {
    const repositoryDirectory = String(entry.repository || '').includes('Audio-Tokenizer') ? 'MOSS-Audio-Tokenizer-Nano-ONNX' : 'MOSS-TTS-Nano-100M-ONNX'
    const filePath = path.join(rootPath, 'models', repositoryDirectory, String(entry.file || ''))
    if (!fs.existsSync(filePath)) throw new Error(`MOSS-TTS-Nano 缺少：${repositoryDirectory}/${entry.file}`)
    const stats = fs.statSync(filePath)
    if (stats.size !== Number(entry.size)) throw new Error(`MOSS-TTS-Nano 文件大小不匹配：${entry.file}`)
    if (sha256File(filePath) !== entry.sha256) throw new Error(`MOSS-TTS-Nano 文件校验失败：${entry.file}`)
  }
  return manifest.files.length
}

export function verifyWindowsOfflineBundle({ rootPath = windowsBundleRoot, mossRootPath = mossBundleRoot } = {}) {
  const manifestPath = path.join(rootPath, 'manifest.json')
  if (!fs.existsSync(manifestPath)) throw new Error('Windows 完整离线工具清单不存在，请先运行 npm run tools:prepare:win。')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  if (manifest.schemaVersion !== 1 || manifest.platform !== 'win32' || manifest.arch !== 'x64' || manifest.networkRequiredAtRuntime !== false) {
    throw new Error('Windows 离线工具清单的平台或离线标记无效。')
  }
  const expectedSources = new Map(windowsSourceAssets.map((entry) => [entry.id, entry]))
  for (const source of manifest.sources || []) {
    const expected = expectedSources.get(source.id)
    if (!expected || source.version !== expected.version || source.sha256 !== expected.sha256) throw new Error(`Windows 来源版本不受信任：${source.id}`)
    expectedSources.delete(source.id)
  }
  if (expectedSources.size) throw new Error(`Windows 清单缺少来源：${[...expectedSources.keys()].join('、')}`)

  const manifestFiles = manifest.files && typeof manifest.files === 'object' ? manifest.files : {}
  for (const relativePath of windowsRequiredFiles) {
    if (!manifestFiles[relativePath]) throw new Error(`Windows 清单缺少必需文件：${relativePath}`)
  }
  const actualFiles = listFiles(rootPath).filter((file) => file !== 'manifest.json' && !file.startsWith('tts/'))
  const declaredFiles = Object.keys(manifestFiles).sort()
  if (actualFiles.join('\n') !== declaredFiles.join('\n')) throw new Error('Windows 离线目录与清单不一致，存在缺失或未登记文件。')
  for (const relativePath of declaredFiles) {
    const filePath = path.join(rootPath, relativePath)
    const stats = fs.statSync(filePath)
    const expected = manifestFiles[relativePath]
    if (stats.size !== expected.size || sha256File(filePath) !== expected.sha256) throw new Error(`Windows 文件校验失败：${relativePath}`)
  }
  for (const relativePath of windowsX64PeFiles) assertWindowsX64Pe(path.join(rootPath, relativePath), relativePath)
  if (sha256File(path.join(rootPath, 'stt', 'ggml-base.bin')) !== '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe') {
    throw new Error('Windows Whisper 多语言模型校验失败。')
  }
  const mossFiles = verifyMossBundle(mossRootPath)
  return { files: declaredFiles.length, bytes: declaredFiles.reduce((sum, relativePath) => sum + manifestFiles[relativePath].size, 0), mossFiles }
}
