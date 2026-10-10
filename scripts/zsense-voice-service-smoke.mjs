import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

const workspace = { settings: { voiceWakePhrase: '你好 ZSense' } }
const packagedArgument = process.argv.find((argument) => argument === '--packaged' || argument.startsWith('--packaged='))
let toolsDirectory = fileURLToPath(new URL(`../bundled-tools/${process.platform}-${process.arch}`, import.meta.url))
let backendUrl = new URL('../electron/services/zsense-voice-service.mjs', import.meta.url)
let service = null
let inspectVoiceWave = null
let electronApp = null
let temporaryUserData = null

async function verifyFiles(root, manifest) {
  assert(Array.isArray(manifest.files) && manifest.files.length > 0, '资源清单必须包含固定文件与校验和')
  for (const entry of manifest.files) {
    const filePath = path.resolve(root, entry.file)
    assert(filePath.startsWith(`${path.resolve(root)}${path.sep}`))
    assert.equal(fs.statSync(filePath).size, entry.size, `${entry.file} 大小不匹配`)
    assert.match(entry.sha256, /^[a-f0-9]{64}$/u)
    const hash = crypto.createHash('sha256')
    await pipeline(fs.createReadStream(filePath), hash)
    assert.equal(hash.digest('hex'), entry.sha256, `${entry.file} SHA-256 不匹配`)
  }
}

function resampleWaveToPcm16(wave) {
  const sourceFrames = wave.pcm.length / (wave.channels * 2)
  const targetFrames = Math.round(sourceFrames * 16_000 / wave.sampleRate)
  const output = Buffer.alloc(targetFrames * 2)
  const sample = (frame) => {
    let total = 0
    for (let channel = 0; channel < wave.channels; channel += 1) total += wave.pcm.readInt16LE((frame * wave.channels + channel) * 2)
    return total / wave.channels
  }
  for (let frame = 0; frame < targetFrames; frame += 1) {
    const sourcePosition = Math.min(sourceFrames - 1, frame * wave.sampleRate / 16_000)
    const before = Math.floor(sourcePosition)
    const after = Math.min(sourceFrames - 1, before + 1)
    const value = sample(before) + (sample(after) - sample(before)) * (sourcePosition - before)
    output.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(value))), frame * 2)
  }
  return output
}

try {
  if (packagedArgument) {
    if (!process.versions.electron || process.env.ELECTRON_RUN_AS_NODE) throw new Error('打包后验收必须使用 node scripts/run-electron.mjs scripts/zsense-voice-service-smoke.mjs --packaged 启动。')
    const { app } = await import('electron')
    electronApp = app
    temporaryUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'zsense-packaged-voice-'))
    const sessionData = path.join(temporaryUserData, 'session')
    fs.mkdirSync(sessionData)
    app.setName('ZSense Packaged Voice Smoke')
    app.setPath('userData', temporaryUserData)
    app.setPath('sessionData', sessionData)
    const explicitPath = packagedArgument.startsWith('--packaged=') ? packagedArgument.slice('--packaged='.length) : ''
    const defaultArchive = process.platform === 'darwin'
      ? new URL(`../release/mac-${process.arch}/ZSense.app/Contents/Resources/app.asar`, import.meta.url)
      : new URL('../release/win-unpacked/resources/app.asar', import.meta.url)
    const archivePath = explicitPath ? path.resolve(explicitPath) : fileURLToPath(defaultArchive)
    // Electron exposes an ASAR archive as a virtual directory through node:fs.
    assert(archivePath.endsWith(`${path.sep}app.asar`) && fs.existsSync(archivePath), '打包后验收需要 app.asar')
    toolsDirectory = path.join(path.dirname(archivePath), 'bundled-tools')
    backendUrl = pathToFileURL(path.join(archivePath, 'electron', 'services', 'zsense-voice-service.mjs'))
  }
  const backend = await import(backendUrl.href)
  inspectVoiceWave = backend.inspectVoiceWave
  service = new backend.ZSenseVoiceService({ database: { loadSettings: () => workspace.settings }, toolsDirectory })
  const stt = service.inspectLocalStt()
  assert.equal(stt.ready, true, stt.missing.join('、'))
  const sttManifest = JSON.parse(fs.readFileSync(path.join(toolsDirectory, 'stt', 'manifest.json'), 'utf8'))
  assert.equal(sttManifest.model.file, 'ggml-base-q5_1.bin')
  const sttHash = crypto.createHash('sha256')
  await pipeline(fs.createReadStream(stt.modelPath), sttHash)
  assert.equal(sttHash.digest('hex'), sttManifest.model.sha256)
  const tts = service.inspectBundledTts()
  assert.equal(tts.ready, true, tts.missing.join('、'))
  const modelManifest = JSON.parse(fs.readFileSync(path.join(tts.modelRoot, 'manifest.json'), 'utf8'))
  await verifyFiles(tts.modelRoot, modelManifest)
  await verifyFiles(path.join(toolsDirectory, 'tts'), JSON.parse(fs.readFileSync(path.join(toolsDirectory, 'tts', 'manifest.json'), 'utf8')))

  const started = service.startWake({ phrase: '你好小智', sensitivity: 0.2, confirmationFrames: 1 })
  assert.equal(started.enabled, true)
  assert.equal(started.listening, true)
  assert.equal(started.phrase, '你好小智')
  const inspected = service.inspect()
  assert.equal(inspected.wakePhrase, '你好小智')
  assert(inspected.provider.includes('whisper.cpp') && inspected.provider.includes('Q5_1'))
  assert.equal(inspected.sttReady, true)
  assert.equal(inspected.ttsReady, true)
  assert.equal(inspected.networkRequiredAtRuntime, false)
  assert(inspected.ttsModel.includes('MeloTTS') && inspected.ttsModel.includes('native'))
  const voices = service.listVoices()
  assert.equal(voices.length, 1)
  assert.equal(voices[0].id, 'melo-zh')
  assert.equal(voices[0].engine, 'melo-tts')
  assert.equal(voices[0].local, true)
  assert.equal(voices[0].bundled, true)

  for (const request of [
    { text: '中文', language: 'en-US' }, { text: '' }, { text: '字'.repeat(2_001) },
    { text: '中文', speed: 0.49 }, { text: '中文', speed: 2.01 }, { text: '中文', speed: Number.NaN },
  ]) await assert.rejects(service.synthesize(request))

  const synthesis = await service.synthesize({ text: '这是完全本地的中文语音测试，不需要网络连接。', language: 'zh-CN', voice: 'Xiaoyu', speed: 1 })
  assert.equal(synthesis.cancelled, false)
  assert.equal(synthesis.played, false)
  assert.equal(synthesis.offline, true)
  assert.equal(synthesis.voice, 'melo-zh', '旧音色 ID 必须迁移到固定 Melo 中文音色')
  assert.equal(synthesis.audioMimeType, 'audio/wav')
  const wave = inspectVoiceWave(Buffer.from(synthesis.audioBase64, 'base64'))
  assert(wave.durationSeconds > 1 && wave.durationSeconds < 35)
  const generatedPcmBase64 = resampleWaveToPcm16(wave).toString('base64')
  const recognized = await service.transcribe({ pcmBase64: generatedPcmBase64, sampleRate: 16_000, language: 'zh-CN' })
  assert.equal(recognized.offline, true)
  const matchedWords = ['本地', '中文', '语音', '测试'].filter((word) => recognized.transcript.includes(word))
  assert(matchedWords.length >= 3, `Whisper Q5_1 没有正确识别生成的中文：${recognized.transcript}`)

  const silence = await service.transcribe({ pcmBase64: Buffer.alloc(32_000).toString('base64'), sampleRate: 16_000, language: 'zh-CN', mode: 'wake' })
  assert.equal(silence.transcript, '')
  assert.equal(silence.confidence, 0)
  assert.equal(silence.rejectedAsSilence, true)
  assert.equal(silence.offline, true)
  await assert.rejects(service.transcribe({ pcmBase64: Buffer.alloc(32_000).toString('base64'), sampleRate: 16_000, language: 'en-US' }), /仅支持简体中文/u)

  const active = service.synthesize({ text: '这是一段应该被立即取消的本地中文播报。'.repeat(20) })
  const queued = service.synthesize({ text: '这条排队播报也必须取消。' })
  const deadline = Date.now() + 5_000
  while (!service.activeSpeech && Date.now() < deadline) await delay(10)
  assert(service.activeSpeech, '取消测试未启动原生进程')
  const child = service.activeSpeech.child
  const outputArgument = child.spawnargs.find((argument) => argument.startsWith('--output-filename='))
  const temporaryDirectory = path.dirname(outputArgument.slice('--output-filename='.length))
  const stoppedAt = Date.now()
  assert.equal(service.stopSpeaking().stopped, true)
  const cancelled = await Promise.all([active, queued])
  assert(Date.now() - stoppedAt < 1_000, '停止必须立即返回，不能等待排队模型运行')
  assert(cancelled.every((result) => result.cancelled && result.audioBase64 === '' && result.offline))
  await service.synthesisQueue
  assert.equal(service.activeSpeech, null)
  assert.equal(fs.existsSync(temporaryDirectory), false, '取消后必须清理 WAV 临时目录')
  assert.notEqual(child.exitCode === null && child.signalCode === null, true, '取消后原生进程必须已退出')

  const shutdownSpeech = service.synthesize({ text: '这段播报必须随应用退出而取消。'.repeat(20) })
  const shutdownQueuedSpeech = service.synthesize({ text: '退出时不能再启动这段排队播报。' })
  const shutdownTranscriptions = Promise.allSettled([
    service.transcribe({ pcmBase64: generatedPcmBase64, sampleRate: 16_000, language: 'zh-CN' }),
    service.transcribe({ pcmBase64: generatedPcmBase64, sampleRate: 16_000, language: 'zh-CN' }),
  ])
  const shutdownDeadline = Date.now() + 5_000
  while ((!service.activeSpeech || !service.activeTranscription) && Date.now() < shutdownDeadline) await delay(10)
  assert(service.activeSpeech && service.activeTranscription, '退出验收需要同时启动 TTS 与 STT 原生进程')
  const shutdownChildren = [service.activeSpeech.child, service.activeTranscription.child]
  const shutdownTemporaryDirectories = shutdownChildren.map((child) => {
    const output = child.spawnargs.find((argument) => argument.startsWith('--output-filename='))
    return path.dirname(output ? output.slice('--output-filename='.length) : child.spawnargs[child.spawnargs.indexOf('-f') + 1])
  })
  await service.shutdown()
  assert((await Promise.all([shutdownSpeech, shutdownQueuedSpeech])).every((result) => result.cancelled))
  assert((await shutdownTranscriptions).every((result) => result.status === 'rejected' && /已关闭/u.test(result.reason.message)))
  assert.equal(service.activeSpeech, null)
  assert.equal(service.activeTranscription, null)
  assert(shutdownChildren.every((process) => process.exitCode !== null || process.signalCode !== null), '退出后 TTS/STT 子进程必须结束')
  assert(shutdownTemporaryDirectories.every((directory) => !fs.existsSync(directory)), '退出后必须清理 TTS/STT 临时音频')
  assert.equal(service.getWakeStatus().enabled, false)
  await assert.rejects(service.synthesize({ text: '关闭后不能播报。' }), /已关闭/u)
  await assert.rejects(service.transcribe({ pcmBase64: generatedPcmBase64 }), /已关闭/u)
  console.log(JSON.stringify({ ok: true, packagedBackend: Boolean(packagedArgument), backendModule: backendUrl.pathname, bundledMeloNative: true, bundledWhisperQ5: true, resourceChecksumsVerified: true, offlineRuntime: true, synthesisDurationMs: synthesis.durationMs, generatedAudioSeconds: Number(wave.durationSeconds.toFixed(2)), chineseRoundTripTranscript: recognized.transcript, activeAndQueuedCancellation: true, shutdownCancelsSttAndTts: true, nativeProcessExited: true, temporaryAudioCleaned: true, silenceHallucinationBlocked: true, invalidInputRejected: true, legacyVoiceMigrated: true }))
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  await service?.shutdown()
  if (temporaryUserData) fs.rmSync(temporaryUserData, { recursive: true, force: true })
  electronApp?.exit(process.exitCode || 0)
}
