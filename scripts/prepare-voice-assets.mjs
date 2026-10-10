import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { pathToFileURL } from 'node:url'
import {
  meloBundleRoot, meloFiles, meloRepository, meloRevision, verifyVoiceBundle,
  voiceFileEntries, voiceLicenseAssets, voicePlatformRoot, voiceRuntimeAssets,
  voiceSha256, whisperModel, whisperRevision,
} from './voice-assets.mjs'

const defaultCache = path.join(os.tmpdir(), 'zsense-voice-assets')

async function download(asset, cacheRoot, urls) {
  fs.mkdirSync(cacheRoot, { recursive: true })
  const destination = path.join(cacheRoot, asset.cacheName || asset.file || asset.archiveName)
  if (fs.existsSync(destination) && voiceSha256(destination) === asset.sha256) return destination
  const failures = []
  for (const url of urls) {
    const temporary = `${destination}.part-${process.pid}`
    try {
      console.log(`Prepare speech asset: ${asset.file || asset.id} (${new URL(url).hostname})`)
      const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(15 * 60_000), headers: { 'User-Agent': 'ZSense-Offline-Voice-Builder/1.0' } })
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
      await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(temporary, { flags: 'w' }))
      if (voiceSha256(temporary) !== asset.sha256 || (asset.size && fs.statSync(temporary).size !== asset.size)) throw new Error('SHA-256 or size mismatch')
      if (fs.existsSync(destination)) fs.unlinkSync(destination)
      fs.renameSync(temporary, destination)
      return destination
    } catch (error) {
      failures.push(`${new URL(url).hostname}: ${error.message}`)
      try { fs.unlinkSync(temporary) } catch { /* incomplete download */ }
    }
  }
  throw new Error(`Unable to prepare ${asset.file || asset.id}: ${failures.join('; ')}`)
}

function copy(source, destination, executable = false) {
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  fs.copyFileSync(source, destination)
  if (executable && process.platform !== 'win32') fs.chmodSync(destination, 0o755)
}

function writeManifest(destination, value) {
  fs.writeFileSync(destination, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function hfUrls(repository, revision, file) {
  const suffix = `${repository}/resolve/${revision}/${file}`
  return [`https://huggingface.co/${suffix}`, `https://hf-mirror.com/${suffix}`]
}

function archiveNotices(rootPath, prefix = '') {
  return fs.readdirSync(path.join(rootPath, prefix), { withFileTypes: true }).flatMap((entry) => {
    const file = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) return archiveNotices(rootPath, file)
    // The official archives contain dylib symlinks. Do not hash or copy those
    // while finding notices; only regular license files are relevant here.
    return entry.isFile() && /(?:^|\/)(?:LICENSE|COPYING|NOTICE)(?:[._-].*)?$/i.test(file) ? [file] : []
  })
}

function notices() {
  return [
    'ZSense local speech: original FP32 MeloTTS, fixed Chinese voice.',
    'MeloTTS voice/model: MIT; LICENSE is in the shared tts/melo directory.',
    `Model snapshot: https://huggingface.co/${meloRepository}/tree/${meloRevision}`,
    'Native CLI: sherpa-onnx 1.13.8 (Apache-2.0), executed as an independent child process.',
    'CLI source: https://github.com/k2-fsa/sherpa-onnx/tree/v1.13.8',
    'Build scripts: https://github.com/k2-fsa/sherpa-onnx/tree/v1.13.8/cmake',
    'ONNX Runtime 1.28.2: MIT and third-party notices in licenses/.',
    'ONNX Runtime source: https://github.com/microsoft/onnxruntime/tree/v1.28.2',
    '',
    'The upstream general-purpose TTS executable also statically includes eSpeak NG (GPL-3.0).',
    'eSpeak NG source: https://github.com/csukuangfj/espeak-ng/tree/ed530aa113046142eb5115cf2fc9157854d0ffe1',
    'eSpeak build integration: https://github.com/k2-fsa/sherpa-onnx/blob/v1.13.8/cmake/espeak-ng-for-piper.cmake',
    'Piper phonemize source: https://github.com/csukuangfj/piper-phonemize/tree/f3ff95afc03640bc1399e113e83361192a2fafb4',
    'Piper build integration: https://github.com/k2-fsa/sherpa-onnx/blob/v1.13.8/cmake/piper-phonemize.cmake',
    'A public redistribution must provide the corresponding source under the applicable GPL terms; a general project homepage alone is insufficient.',
    'This preparation script does not publish installers or corresponding-source distributions.',
    '',
    ...voiceLicenseAssets.map((entry) => `${entry.file}: ${entry.url}`),
    '',
  ].join('\n')
}

export async function prepareVoiceAssets({ platforms = [`${process.platform}-${process.arch}`], cacheRoot = path.resolve(process.env.ZSENSE_VOICE_ASSET_CACHE || defaultCache) } = {}) {
  for (const platformKey of platforms) voicePlatformRoot(platformKey)
  fs.mkdirSync(meloBundleRoot, { recursive: true })
  for (const asset of meloFiles) {
    const source = await download({ ...asset, cacheName: asset.file === 'model.onnx' ? 'model.onnx' : `melo-${asset.file}` }, cacheRoot, hfUrls(meloRepository, meloRevision, asset.file))
    copy(source, path.join(meloBundleRoot, asset.file))
  }
  writeManifest(path.join(meloBundleRoot, 'manifest.json'), { schemaVersion: 1, engine: 'sherpa-onnx', model: 'MeloTTS-Chinese', precision: 'fp32', offline: true, networkRequiredAtRuntime: false, repository: meloRepository, revision: meloRevision, license: 'MIT', languages: ['zh', 'en'], supportedLanguages: ['zh'], speakers: 1, voiceCloning: false, sampleRate: 44100, files: meloFiles })
  const whisper = await download(whisperModel, cacheRoot, hfUrls('ggerganov/whisper.cpp', whisperRevision, whisperModel.file))
  const licenses = new Map()
  for (const asset of voiceLicenseAssets) licenses.set(asset.file, await download({ ...asset, cacheName: `voice-${asset.file}` }, cacheRoot, [asset.url]))
  for (const platformKey of platforms) {
    const asset = voiceRuntimeAssets[platformKey]
    const archive = await download(asset, cacheRoot, [asset.url, ...(process.env.ZSENSE_VOICE_ASSET_MIRROR ? [`${process.env.ZSENSE_VOICE_ASSET_MIRROR.replace(/\/+$/, '')}/${asset.id}/${asset.version}/${asset.archiveName}`] : [])])
    const rootPath = voicePlatformRoot(platformKey)
    const ttsRoot = path.join(rootPath, 'tts')
    const extracted = fs.mkdtempSync(path.join(os.tmpdir(), 'zsense-voice-native-'))
    try {
      const result = spawnSync('tar', ['-xjf', archive, '-C', extracted], { encoding: 'utf8', windowsHide: true })
      if (result.status !== 0) throw new Error(`Native TTS extraction failed: ${result.stderr || result.stdout}`)
      const sourceRoot = path.join(extracted, asset.archiveDirectory)
      copy(path.join(sourceRoot, 'bin', asset.binary), path.join(ttsRoot, asset.binary), true)
      // Adjacent libraries preserve the official executable's @loader_path
      // rpath and Windows loader lookup, without copying unrelated C API libs.
      for (const file of asset.libraryFiles) copy(path.join(sourceRoot, 'lib', file), path.join(ttsRoot, file))
      for (const [file, source] of licenses) copy(source, path.join(ttsRoot, 'licenses', file))
      // Preserve any upstream archive notices in addition to pinned licenses.
      for (const file of archiveNotices(sourceRoot)) copy(path.join(sourceRoot, file), path.join(ttsRoot, 'licenses', 'archive', file))
      fs.writeFileSync(path.join(ttsRoot, 'THIRD_PARTY_NOTICES.txt'), notices(), 'utf8')
      const files = voiceFileEntries(ttsRoot).filter((entry) => entry.file !== 'manifest.json' && !entry.file.startsWith('melo/'))
      writeManifest(path.join(ttsRoot, 'manifest.json'), { schemaVersion: 1, engine: 'sherpa-onnx', engineVersion: asset.version, platform: platformKey, binary: asset.binary, networkRequiredAtRuntime: false, source: { id: asset.id, version: asset.version, url: asset.url, sha256: asset.sha256 }, files })
    } finally { fs.rmSync(extracted, { recursive: true, force: true }) }
    copy(whisper, path.join(rootPath, 'stt', whisperModel.file))
    const sttManifestPath = path.join(rootPath, 'stt', 'manifest.json')
    const previous = fs.existsSync(sttManifestPath) ? JSON.parse(fs.readFileSync(sttManifestPath, 'utf8')) : {}
    writeManifest(sttManifestPath, { ...previous, engine: 'whisper.cpp', architecture: platformKey, networkRequiredAtRuntime: false, model: { name: 'Whisper base multilingual Q5_1', precision: 'q5_1', file: whisperModel.file, source: 'ggerganov/whisper.cpp', revision: whisperRevision, size: whisperModel.size, sha256: whisperModel.sha256 } })
    console.log(JSON.stringify({ ok: true, platformKey, ...verifyVoiceBundle({ platformKey }) }))
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const platforms = process.argv.slice(2).filter((arg) => arg.startsWith('--platform=')).map((arg) => arg.slice('--platform='.length))
  await prepareVoiceAssets({ ...(platforms.length ? { platforms } : {}) })
}
