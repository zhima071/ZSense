import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import * as OpenCC from 'opencc-js'

const execFileAsync = promisify(execFile)
const DEFAULT_PHRASE = '你好 ZSense'
const LOCAL_STT_PROVIDER = 'whisper.cpp base 多语言模型 · 完全本地'
const LOCAL_STT_SAMPLE_RATE = 16_000
const BUNDLED_TTS_PROVIDER = 'ZSense MOSS-TTS-Nano ONNX · 完全本地'
const traditionalToSimplified = OpenCC.Converter({ from: 't', to: 'cn' })
const BUNDLED_TTS_VOICES = Object.freeze([
  { id: 'Junhao', name: 'Junhao · 中文男声', language: 'zh-CN', gender: 'male', engine: 'moss-tts-nano', local: true, bundled: true },
  { id: 'Zhiming', name: 'Zhiming · 京味男声', language: 'zh-CN', gender: 'male', engine: 'moss-tts-nano', local: true, bundled: true },
  { id: 'Weiguo', name: 'Weiguo · 说书男声', language: 'zh-CN', gender: 'male', engine: 'moss-tts-nano', local: true, bundled: true },
  { id: 'Xiaoyu', name: 'Xiaoyu · 中文女声', language: 'zh-CN', gender: 'female', engine: 'moss-tts-nano', local: true, bundled: true },
  { id: 'Yuewen', name: 'Yuewen · 机车女声', language: 'zh-CN', gender: 'female', engine: 'moss-tts-nano', local: true, bundled: true },
  { id: 'Lingyu', name: 'Lingyu · 电台女声', language: 'zh-CN', gender: 'female', engine: 'moss-tts-nano', local: true, bundled: true },
])

const MOSS_TTS_REQUIRED_FILES = Object.freeze([
  'MOSS-TTS-Nano-100M-ONNX/browser_poc_manifest.json',
  'MOSS-TTS-Nano-100M-ONNX/tts_browser_onnx_meta.json',
  'MOSS-TTS-Nano-100M-ONNX/tokenizer.model',
  'MOSS-TTS-Nano-100M-ONNX/moss_tts_prefill.onnx',
  'MOSS-TTS-Nano-100M-ONNX/moss_tts_decode_step.onnx',
  'MOSS-TTS-Nano-100M-ONNX/moss_tts_local_decoder.onnx',
  'MOSS-TTS-Nano-100M-ONNX/moss_tts_local_cached_step.onnx',
  'MOSS-TTS-Nano-100M-ONNX/moss_tts_local_fixed_sampled_frame.onnx',
  'MOSS-TTS-Nano-100M-ONNX/moss_tts_global_shared.data',
  'MOSS-TTS-Nano-100M-ONNX/moss_tts_local_shared.data',
  'MOSS-Audio-Tokenizer-Nano-ONNX/codec_browser_onnx_meta.json',
  'MOSS-Audio-Tokenizer-Nano-ONNX/moss_audio_tokenizer_encode.onnx',
  'MOSS-Audio-Tokenizer-Nano-ONNX/moss_audio_tokenizer_encode.data',
  'MOSS-Audio-Tokenizer-Nano-ONNX/moss_audio_tokenizer_decode_full.onnx',
  'MOSS-Audio-Tokenizer-Nano-ONNX/moss_audio_tokenizer_decode_step.onnx',
  'MOSS-Audio-Tokenizer-Nano-ONNX/moss_audio_tokenizer_decode_shared.data',
])

export class ZSenseVoiceService {
  constructor({ database, toolsDirectory = '' }) {
    this.database = database
    this.toolsDirectory = toolsDirectory
    this.enabled = false
    this.listening = false
    this.transcriptionQueue = Promise.resolve()
    this.speechGeneration = 0
    this.configuration = {
      phrase: String(database.loadSettings().voiceWakePhrase || DEFAULT_PHRASE).trim() || DEFAULT_PHRASE,
      sensitivity: 0.3,
      confirmationFrames: 1,
    }
  }

  getWakeStatus() {
    const stt = this.inspectLocalStt()
    return {
      supported: stt.ready,
      enabled: this.enabled,
      listening: this.listening && stt.ready,
      state: !stt.ready ? 'unavailable' : this.listening ? 'listening' : this.enabled ? 'starting' : 'disabled',
      phrase: this.configuration.phrase,
      provider: LOCAL_STT_PROVIDER,
      capture: 'local',
      sampleRate: LOCAL_STT_SAMPLE_RATE,
      frameLength: 0,
      sensitivity: this.configuration.sensitivity,
      confirmationFrames: this.configuration.confirmationFrames,
      permission: 'unknown',
      message: !stt.ready
        ? `本地 STT 组件不完整：${stt.missing.join('、')}`
        : this.listening
          ? `正在使用内置 Whisper 模型离线监听“${this.configuration.phrase}”。`
          : this.enabled
            ? '正在启动内置 Whisper 本地语音识别。'
            : '语音唤醒已关闭。',
      checkedAt: new Date().toISOString(),
    }
  }

  inspectLocalStt() {
    const executable = process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli'
    const binaryPath = path.join(this.toolsDirectory, 'stt', executable)
    const modelPath = path.join(this.toolsDirectory, 'stt', 'ggml-base.bin')
    const missing = []
    if (!fs.existsSync(binaryPath)) missing.push('whisper.cpp 推理引擎')
    if (!fs.existsSync(modelPath)) missing.push('Whisper base 多语言模型')
    return { ready: missing.length === 0, binaryPath, modelPath, missing }
  }

  inspectBundledTts() {
    const packagedModelRoot = path.join(this.toolsDirectory, 'tts', 'moss', 'models')
    const developmentModelRoot = path.join(path.dirname(this.toolsDirectory), 'shared', 'tts', 'moss', 'models')
    const modelRoot = fs.existsSync(packagedModelRoot) ? packagedModelRoot : developmentModelRoot
    const missing = MOSS_TTS_REQUIRED_FILES.filter((relativePath) => !fs.existsSync(path.join(modelRoot, relativePath)))
    return { ready: missing.length === 0, modelRoot, missing }
  }

  listVoices() {
    const tts = this.inspectBundledTts()
    if (!tts.ready) throw new Error(`内置 TTS 组件不完整：${tts.missing.join('、')}。`)
    return BUNDLED_TTS_VOICES.map((voice) => ({ ...voice }))
  }

  startWake(configuration = {}) {
    const stt = this.inspectLocalStt()
    if (!stt.ready) throw new Error(`无法启动完全本地语音识别：${stt.missing.join('、')}未随应用安装。`)
    this.configuration = {
      phrase: String(configuration.phrase || this.database.loadSettings().voiceWakePhrase || DEFAULT_PHRASE).trim() || DEFAULT_PHRASE,
      sensitivity: Number(configuration.sensitivity || 0.3),
      confirmationFrames: Number(configuration.confirmationFrames || 1),
    }
    this.enabled = true
    this.listening = true
    return this.getWakeStatus()
  }

  stopWake() {
    this.enabled = false
    this.listening = false
    return this.getWakeStatus()
  }

  feedWake() {
    return { accepted: false, localRecognition: true }
  }

  transcribe(request = {}) {
    const run = () => this.#transcribeNow(request)
    const pending = this.transcriptionQueue.then(run, run)
    this.transcriptionQueue = pending.catch(() => undefined)
    return pending
  }

  async #transcribeNow({ pcmBase64, sampleRate = LOCAL_STT_SAMPLE_RATE, language = 'zh-CN', mode = 'conversation' }) {
    if (language !== 'zh-CN') throw new Error('当前语音识别仅支持简体中文。')
    const stt = this.inspectLocalStt()
    if (!stt.ready) throw new Error(`本地 STT 不可用：${stt.missing.join('、')}未安装。`)
    if (Number(sampleRate) !== LOCAL_STT_SAMPLE_RATE) throw new Error(`本地 STT 只接受 ${LOCAL_STT_SAMPLE_RATE} Hz 单声道 PCM。`)
    if (typeof pcmBase64 !== 'string' || !pcmBase64) throw new Error('没有收到可转写的本地录音。')
    const pcm = Buffer.from(pcmBase64, 'base64')
    if (pcm.length < 1_600) throw new Error('录音时间太短，请再说一次。')
    if (pcm.length > LOCAL_STT_SAMPLE_RATE * 2 * 35) throw new Error('单次本地录音不能超过 35 秒。')

    const signal = pcm16SignalMetrics(pcm)
    const minimumRms = mode === 'wake' ? 0.0025 : 0.0018
    const minimumPeak = mode === 'wake' ? 0.012 : 0.008
    const minimumActiveRatio = mode === 'wake' ? 0.008 : 0.004
    if (signal.rms < minimumRms || signal.peak < minimumPeak || signal.activeRatio < minimumActiveRatio) {
      return {
        transcript: '',
        confidence: 0,
        provider: LOCAL_STT_PROVIDER,
        language: 'zh',
        durationMs: 0,
        offline: true,
        rejectedAsSilence: true,
      }
    }

    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'zsense-local-stt-'))
    const inputPath = path.join(temporaryDirectory, 'input.wav')
    const startedAt = Date.now()
    try {
      writePcm16Wave(inputPath, pcm, LOCAL_STT_SAMPLE_RATE)
      const languageCode = 'zh'
      const fastMode = mode === 'wake'
      const threads = Math.max(2, Math.min(8, os.cpus()?.length || 4))
      const args = [
        '-m', stt.modelPath,
        '-f', inputPath,
        '-l', languageCode,
        '-np', '-nt', '-nf', '-sns',
        '-t', String(threads),
        '-bo', fastMode ? '1' : '3',
        '-bs', fastMode ? '1' : '3',
        '-et', '2.0',
        '-lpt', fastMode ? '-0.55' : '-0.45',
        '-nth', fastMode ? '0.35' : '0.4',
      ]
      const { stdout } = await execFileAsync(stt.binaryPath, args, {
        timeout: fastMode ? 45_000 : 120_000,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, NO_PROXY: '*', no_proxy: '*' },
      })
      const rawTranscript = cleanTranscript(stdout)
      const transcript = traditionalToSimplified(rawTranscript)
      return {
        transcript,
        confidence: transcript ? 1 : 0,
        provider: LOCAL_STT_PROVIDER,
        language: languageCode,
        durationMs: Date.now() - startedAt,
        offline: true,
      }
    } catch (error) {
      if (error?.killed) throw new Error('本地语音识别超时，请缩短单次说话时间后重试。')
      throw new Error(`本地语音识别失败：${String(error?.stderr || error?.message || error).trim().slice(0, 500)}`)
    } finally {
      fs.rmSync(temporaryDirectory, { recursive: true, force: true })
    }
  }

  stopSpeaking() {
    this.speechGeneration += 1
    return { stopped: true }
  }

  inspect() {
    const stt = this.inspectLocalStt()
    const tts = this.inspectBundledTts()
    return {
      supported: stt.ready && ['darwin', 'win32'].includes(process.platform),
      provider: stt.ready
        ? `${LOCAL_STT_PROVIDER} + ${tts.ready ? BUNDLED_TTS_PROVIDER : '内置 TTS 组件缺失'}`
        : '本地 STT 组件缺失',
      wakePhrase: this.configuration.phrase,
      sttReady: stt.ready,
      sttModel: stt.ready ? 'Whisper base multilingual' : null,
      ttsReady: tts.ready,
      ttsModel: tts.ready ? 'MOSS-TTS-Nano 100M ONNX + MOSS Audio Tokenizer Nano' : null,
      networkRequiredAtRuntime: false,
    }
  }

  shutdown() {
    this.stopWake()
    this.stopSpeaking()
  }
}

function pcm16SignalMetrics(pcm) {
  const sampleCount = Math.floor(pcm.length / 2)
  if (!sampleCount) return { rms: 0, peak: 0, activeRatio: 0 }
  let sumSquares = 0
  let peak = 0
  let activeSamples = 0
  for (let offset = 0; offset + 1 < pcm.length; offset += 2) {
    const amplitude = Math.abs(pcm.readInt16LE(offset) / 0x8000)
    sumSquares += amplitude * amplitude
    if (amplitude > peak) peak = amplitude
    if (amplitude >= 0.006) activeSamples += 1
  }
  return {
    rms: Math.sqrt(sumSquares / sampleCount),
    peak,
    activeRatio: activeSamples / sampleCount,
  }
}

function writePcm16Wave(filePath, sourcePcm, sampleRate) {
  const minimumBytes = sampleRate * 2
  const pcm = sourcePcm.length >= minimumBytes
    ? sourcePcm.subarray(0, sourcePcm.length - (sourcePcm.length % 2))
    : Buffer.concat([sourcePcm, Buffer.alloc(minimumBytes - sourcePcm.length)])
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  fs.writeFileSync(filePath, Buffer.concat([header, pcm]))
}

function cleanTranscript(value) {
  return String(value || '')
    .replace(/\[(?:BLANK_AUDIO|SILENCE|MUSIC|NO SPEECH)[^\]]*\]/giu, '')
    .replace(/\s+/gu, ' ')
    .trim()
}
