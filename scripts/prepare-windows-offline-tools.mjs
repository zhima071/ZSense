import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  listFiles,
  mossBundleRoot,
  projectDirectory,
  sha256File,
  verifyWindowsOfflineBundle,
  windowsBundleRoot,
  windowsSourceAssets,
} from './windows-offline-assets.mjs'

const cacheRoot = path.resolve(process.env.ZSENSE_WINDOWS_ASSET_CACHE || path.join(os.tmpdir(), 'zsense-windows-offline-assets'))
const sourceById = new Map(windowsSourceAssets.map((entry) => [entry.id, entry]))

function safeCopy(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  const temporary = `${destination}.prepare-${process.pid}`
  fs.copyFileSync(source, temporary)
  if (fs.existsSync(destination)) fs.unlinkSync(destination)
  fs.renameSync(temporary, destination)
}

async function fetchTo(url, destination) {
  const response = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(15 * 60_000),
    headers: { 'User-Agent': 'ZSense-Windows-Offline-Builder/1.0' },
  })
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
  const temporary = `${destination}.part-${process.pid}`
  const file = fs.createWriteStream(temporary, { flags: 'wx' })
  try {
    for await (const chunk of response.body) {
      if (!file.write(chunk)) await new Promise((resolve) => file.once('drain', resolve))
    }
    await new Promise((resolve, reject) => file.end((error) => error ? reject(error) : resolve()))
    fs.renameSync(temporary, destination)
  } catch (error) {
    file.destroy()
    try { fs.unlinkSync(temporary) } catch { /* ignore incomplete download */ }
    throw error
  }
}

async function sourceArchive(asset) {
  fs.mkdirSync(cacheRoot, { recursive: true })
  const cached = path.join(cacheRoot, asset.archiveName)
  if (fs.existsSync(cached) && sha256File(cached) === asset.sha256) return cached
  if (fs.existsSync(cached)) fs.unlinkSync(cached)
  const failures = []
  for (const url of asset.urls) {
    try {
      console.log(`下载 ${asset.id} ${asset.version}：${new URL(url).hostname}`)
      await fetchTo(url, cached)
      const actual = sha256File(cached)
      if (actual !== asset.sha256) throw new Error(`SHA-256 不匹配（${actual}）`)
      return cached
    } catch (error) {
      failures.push(`${url}: ${error instanceof Error ? error.message : String(error)}`)
      try { fs.unlinkSync(cached) } catch { /* try next mirror */ }
    }
  }
  throw new Error(`无法获取 ${asset.id}：\n${failures.join('\n')}`)
}

function extractZip(archivePath, destination) {
  fs.mkdirSync(destination, { recursive: true })
  const result = spawnSync('tar', ['-xf', archivePath, '-C', destination], { encoding: 'utf8', windowsHide: true })
  if (result.status !== 0) throw new Error(`解压 ${path.basename(archivePath)} 失败：${result.stderr || result.stdout}`)
}

function sourceFile(root, relativePath) {
  const candidate = path.join(root, relativePath)
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) throw new Error(`官方压缩包缺少：${relativePath}`)
  return candidate
}

function createNotices() {
  const content = [
    'ZSense Windows Offline Components',
    '',
    'OfficeCLI 1.0.149',
    'Copyright 2026 OfficeCLI (https://OfficeCLI.AI)',
    'License: Apache-2.0',
    'Source: https://github.com/iOfficeAI/OfficeCLI',
    '',
    'DingTalk Workspace CLI (dws) 1.0.61',
    'Copyright 2026 Alibaba Group',
    'License: Apache-2.0',
    'Source: https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli',
    '',
    'whisper.cpp b5130 and Whisper base multilingual model',
    'License files are included in stt/LICENSE.whisper.cpp and stt/LICENSE.openai-whisper.',
    'Source: https://github.com/ggml-org/whisper.cpp',
    '',
    'kdocs-cli 2.5.7',
    'Official distribution: https://wpsai.wpscdn.cn/skillhub/pro',
    '',
    'Feishu/Lark CLI 1.0.95',
    'Copyright 2026 Lark Technologies Pte. Ltd.',
    'License: MIT',
    'Source: https://github.com/larksuite/cli',
    '',
    'Tencent BrowserSkill CLI 0.3.0',
    'Copyright 2026 Tencent',
    'License: MIT',
    'Source: https://github.com/Tencent/BrowserSkill',
    '',
    'Microsoft Visual C++ 2015-2022 Redistributable (x64)',
    'Installed offline by the ZSense installer only when required by the bundled speech engine.',
    'Source: https://aka.ms/vs/17/release/vc_redist.x64.exe',
    '',
    'MOSS-TTS-Nano and MOSS Audio Tokenizer Nano',
    `Model manifest: ${path.relative(projectDirectory, path.join(mossBundleRoot, 'manifest.json'))}`,
    'License: bundled-tools/shared/tts/moss/LICENSE',
    '',
  ].join('\n')
  fs.writeFileSync(path.join(windowsBundleRoot, 'THIRD_PARTY_NOTICES.txt'), content, 'utf8')
}

async function main() {
  fs.mkdirSync(windowsBundleRoot, { recursive: true })
  const archives = new Map()
  for (const asset of windowsSourceAssets) archives.set(asset.id, await sourceArchive(asset))

  safeCopy(archives.get('cloudflared'), path.join(windowsBundleRoot, 'cloudflared.exe'))
  safeCopy(archives.get('officecli'), path.join(windowsBundleRoot, 'officecli.exe'))
  safeCopy(archives.get('microsoft-vc-redist'), path.join(windowsBundleRoot, 'redist', 'VC_redist.x64.exe'))

  const extractionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zsense-windows-tools-'))
  try {
    const dwsRoot = path.join(extractionRoot, 'dws')
    extractZip(archives.get('dws'), dwsRoot)
    safeCopy(sourceFile(dwsRoot, 'dws.exe'), path.join(windowsBundleRoot, 'dws.exe'))
    safeCopy(sourceFile(dwsRoot, 'LICENSE'), path.join(windowsBundleRoot, 'licenses', 'LICENSE.dws'))
    safeCopy(sourceFile(dwsRoot, 'NOTICE'), path.join(windowsBundleRoot, 'licenses', 'NOTICE.dws'))

    const kdocsRoot = path.join(extractionRoot, 'kdocs')
    extractZip(archives.get('kdocs-cli'), kdocsRoot)
    safeCopy(sourceFile(kdocsRoot, 'kdocs-cli.exe'), path.join(windowsBundleRoot, 'kdocs-cli.exe'))

    const larkRoot = path.join(extractionRoot, 'lark-cli')
    extractZip(archives.get('lark-cli'), larkRoot)
    safeCopy(sourceFile(larkRoot, 'lark-cli.exe'), path.join(windowsBundleRoot, 'lark-cli.exe'))

    const browserSkillRoot = path.join(extractionRoot, 'browser-skill')
    extractZip(archives.get('browser-skill'), browserSkillRoot)
    safeCopy(sourceFile(browserSkillRoot, 'bsk.exe'), path.join(windowsBundleRoot, 'bsk.exe'))

    const whisperRoot = path.join(extractionRoot, 'whisper')
    extractZip(archives.get('whisper.cpp'), whisperRoot)
    const whisperRelease = path.join(whisperRoot, 'Release')
    for (const fileName of fs.readdirSync(whisperRelease).filter((name) => name === 'whisper-cli.exe' || name === 'whisper.dll' || name === 'ggml.dll' || name === 'ggml-base.dll' || /^ggml-cpu-.+\.dll$/i.test(name))) {
      safeCopy(sourceFile(whisperRelease, fileName), path.join(windowsBundleRoot, 'stt', fileName))
    }
  } finally {
    fs.rmSync(extractionRoot, { recursive: true, force: true })
  }

  safeCopy(path.join(projectDirectory, 'bundled-tools', 'darwin-arm64', 'stt', 'ggml-base.bin'), path.join(windowsBundleRoot, 'stt', 'ggml-base.bin'))
  safeCopy(path.join(projectDirectory, 'bundled-tools', 'darwin-arm64', 'stt', 'LICENSE.whisper.cpp'), path.join(windowsBundleRoot, 'stt', 'LICENSE.whisper.cpp'))
  safeCopy(path.join(projectDirectory, 'bundled-tools', 'darwin-arm64', 'stt', 'LICENSE.openai-whisper'), path.join(windowsBundleRoot, 'stt', 'LICENSE.openai-whisper'))
  safeCopy(path.join(projectDirectory, 'bundled-skills', 'dws', 'LICENSE'), path.join(windowsBundleRoot, 'licenses', 'LICENSE.officecli'))
  safeCopy(path.join(projectDirectory, 'bundled-tools', 'darwin-arm64', 'licenses', 'LICENSE.lark-cli'), path.join(windowsBundleRoot, 'licenses', 'LICENSE.lark-cli'))
  safeCopy(path.join(projectDirectory, 'bundled-skills', 'browser-skill', 'LICENSE'), path.join(windowsBundleRoot, 'licenses', 'LICENSE.bsk'))
  createNotices()

  const files = Object.fromEntries(listFiles(windowsBundleRoot).filter((file) => file !== 'manifest.json').map((relativePath) => {
    const filePath = path.join(windowsBundleRoot, relativePath)
    return [relativePath, { size: fs.statSync(filePath).size, sha256: sha256File(filePath) }]
  }))
  const manifest = {
    schemaVersion: 1,
    platform: 'win32',
    arch: 'x64',
    networkRequiredAtRuntime: false,
    sources: windowsSourceAssets.map(({ id, version, archiveName, sha256 }) => ({ id, version, archiveName, sha256 })),
    files,
  }
  fs.writeFileSync(path.join(windowsBundleRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  const result = verifyWindowsOfflineBundle()
  console.log(JSON.stringify({ ok: true, platform: 'win32-x64', ...result, cacheRoot }))
}

await main()
