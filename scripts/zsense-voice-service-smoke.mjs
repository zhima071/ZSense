import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ZSenseVoiceService } from '../electron/services/zsense-voice-service.mjs'

const workspace = { settings: { voiceWakePhrase: '你好 ZSense' } }
const toolsDirectory = fileURLToPath(new URL(`../bundled-tools/${process.platform}-${process.arch}`, import.meta.url))
const service = new ZSenseVoiceService({
  database: { loadWorkspace: () => workspace, loadSettings: () => workspace.settings },
  toolsDirectory,
})

try {
  const modelPath = path.join(toolsDirectory, 'stt', 'ggml-base.bin')
  const modelSha1 = crypto.createHash('sha1').update(fs.readFileSync(modelPath)).digest('hex')
  assert.equal(modelSha1, '465707469ff3a37a2b9b8d8f89f2f99de7299dac')
  const started = service.startWake({ phrase: '你好小智', sensitivity: 0.2, confirmationFrames: 1 })
  assert.equal(started.enabled, true)
  assert.equal(started.listening, true)
  assert.equal(started.phrase, '你好小智')
  const inspected = service.inspect()
  assert.equal(inspected.wakePhrase, '你好小智')
  assert(inspected.provider.includes('whisper.cpp'))
  assert(!inspected.provider.includes('OpenAI'))
  assert.equal(inspected.sttReady, true)
  assert.equal(inspected.ttsReady, true)
  assert.equal(inspected.ttsModel, 'MOSS-TTS-Nano 100M ONNX + MOSS Audio Tokenizer Nano')
  const voices = service.listVoices()
  assert.equal(voices.length, 6)
  assert.deepEqual(voices.map((voice) => voice.id), ['Junhao', 'Zhiming', 'Weiguo', 'Xiaoyu', 'Yuewen', 'Lingyu'])
  assert(voices.every((voice) => voice.engine === 'moss-tts-nano' && voice.local && voice.bundled))
  assert.deepEqual(voices.map((voice) => voice.gender), ['male', 'male', 'male', 'female', 'female', 'female'])
  const voiceManifestPath = fileURLToPath(new URL('../bundled-tools/shared/tts/moss/models/MOSS-TTS-Nano-100M-ONNX/browser_poc_manifest.json', import.meta.url))
  const voiceManifest = JSON.parse(fs.readFileSync(voiceManifestPath, 'utf8'))
  const builtinVoices = new Map(voiceManifest.builtin_voices.map((voice) => [voice.voice, voice]))
  const promptSignatures = voices.map((voice) => {
    const preset = builtinVoices.get(voice.id)
    assert(preset, `${voice.id} must exist in the official MOSS voice manifest`)
    assert.equal(preset.group, voice.gender === 'male' ? 'Chinese Male' : 'Chinese Female')
    assert(preset.prompt_audio_codes.length > 0, `${voice.id} must have reference audio codes`)
    return crypto.createHash('sha256').update(JSON.stringify(preset.prompt_audio_codes)).digest('hex')
  })
  assert.equal(new Set(promptSignatures).size, voices.length, 'all bundled voices must use distinct reference audio codes')
  assert.equal(inspected.networkRequiredAtRuntime, false)
  assert.equal(typeof service.transcribe, 'function')
  const transcription = await service.transcribe({
    pcmBase64: Buffer.alloc(32_000).toString('base64'),
    sampleRate: 16_000,
    language: 'zh-CN',
    mode: 'wake',
  })
  assert.equal(transcription.offline, true)
  assert(transcription.provider.includes('完全本地'))
  assert.equal(transcription.transcript, '', '纯静音不能被 Whisper 幻觉成一条可发送消息')
  assert.equal(transcription.confidence, 0)
  assert.equal(transcription.rejectedAsSilence, true)
  await assert.rejects(service.transcribe({ pcmBase64: Buffer.alloc(32_000).toString('base64'), sampleRate: 16_000, language: 'en-US' }), /仅支持简体中文/)
  service.shutdown()
  assert.equal(service.getWakeStatus().enabled, false)
  console.log(JSON.stringify({ ok: true, wakeLifecycle: true, customWakePhrase: true, bundledOfflineStt: true, modelChecksumVerified: true, silenceHallucinationBlocked: true, bundledMossTts: true, mossModelFilesVerified: true, distinctVoicePromptsVerified: promptSignatures.length, bundledVoices: voices.length }))
} finally {
  service.shutdown()
}
