import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import * as OpenCC from 'opencc-js'

const execFileAsync = promisify(execFile)
const DEFAULT_PHRASE = '你好 ZSense'
const LOCAL_STT_PROVIDER = 'whisper.cpp base Q5_1 多语言模型 · 完全本地'
const LOCAL_STT_SAMPLE_RATE = 16_000
const BUNDLED_TTS_PROVIDER = 'ZSense MeloTTS 中文 · 原生完全本地'
const MAX_TTS_TEXT_LENGTH = 2_000
const MAX_TTS_WAVE_BYTES = 32 * 1024 * 1024
const traditionalToSimplified = OpenCC.Converter({ from: 't', to: 'cn' })
const BUNDLED_TTS_VOICES = Object.freeze([
  { id: 'melo-zh', name: 'Melo · 中文', language: 'zh-CN', gender: 'neutral', engine: 'melo-tts', local: true, bundled: true },
])

const MELO_TTS_REQUIRED_FILES = Object.freeze([
  'model.onnx', 'lexicon.txt', 'tokens.txt', 'date.fst', 'number.fst', 'phone.fst', 'manifest.json',
])

export class ZSenseVoiceService {
  constructor({ database, toolsDirectory = '' }) {
    this.database = database
    this.toolsDirectory = toolsDirectory
    this.enabled = false
    this.listening = false
    this.transcriptionQueue = Promise.resolve()
    this.synthesisQueue = Promise.resolve()
    this.synthesisJobs = new Set()
    this.activeSpeech = null
    this.activeTranscription = null
    this.closed = false
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
    const binaryPath = path.resolve(this.toolsDirectory, 'stt', executable)
    const modelPath = path.resolve(this.toolsDirectory, 'stt', 'ggml-base-q5_1.bin')
    const missing = []
    if (!isNonEmptyFile(binaryPath)) missing.push('whisper.cpp 推理引擎')
    if (!isNonEmptyFile(modelPath)) missing.push('Whisper base Q5_1 多语言模型')
    return { ready: missing.length === 0, binaryPath, modelPath, missing }
  }

  inspectBundledTts() {
    const packagedModelRoot = path.join(this.toolsDirectory, 'tts', 'melo')
    const developmentModelRoot = path.join(path.dirname(this.toolsDirectory), 'shared', 'tts', 'melo')
    const modelRoot = fs.existsSync(packagedModelRoot) ? packagedModelRoot : developmentModelRoot
    const binaryPath = path.resolve(this.toolsDirectory, 'tts', process.platform === 'win32' ? 'sherpa-onnx-offline-tts.exe' : 'sherpa-onnx-offline-tts')
    const missing = MELO_TTS_REQUIRED_FILES.filter((relativePath) => !isNonEmptyFile(path.join(modelRoot, relativePath)))
    if (!isNonEmptyFile(binaryPath)) missing.push('sherpa-onnx 原生 TTS 推理程序')
    inspectResourceManifest(modelRoot, 'Melo 模型', missing)
    inspectResourceManifest(path.dirname(binaryPath), '原生 TTS 推理组件', missing)
    return { ready: missing.length === 0, modelRoot: path.resolve(modelRoot), binaryPath, missing: [...new Set(missing)] }
  }

  listVoices() {
    const tts = this.inspectBundledTts()
    if (!tts.ready) throw new Error(`内置 TTS 组件不完整：${tts.missing.join('、')}。`)
    return BUNDLED_TTS_VOICES.map((voice) => ({ ...voice }))
  }

  synthesize(request = {}) {
    let text
    let speed
    try {
      if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('本地语音播报请求无效。')
      if (request.language !== undefined && request.language !== 'zh-CN') throw new Error('当前语音播报仅支持简体中文。')
      if (typeof request.text !== 'string' || !(text = request.text.trim())) throw new Error('没有可播报的文字。')
      if (request.text.length > MAX_TTS_TEXT_LENGTH) throw new Error(`单次本地播报不能超过 ${MAX_TTS_TEXT_LENGTH} 字符。`)
      if (/\u0000/u.test(text)) throw new Error('播报文字包含无效字符。')
      speed = request.speed ?? 1
      if (typeof speed !== 'number' || !Number.isFinite(speed) || speed < 0.5 || speed > 2) throw new Error('本地播报语速必须在 0.5 到 2 之间。')
      if (this.closed) throw new Error('本地语音服务已关闭。')
    } catch (error) {
      return Promise.reject(error)
    }
    const job = { generation: this.speechGeneration, text, speed, startedAt: Date.now(), settled: false }
    const result = new Promise((resolve, reject) => { job.resolve = resolve; job.reject = reject })
    this.synthesisJobs.add(job)
    const run = async () => {
      if (job.settled || job.generation !== this.speechGeneration || this.closed) return
      try {
        const output = await this.#synthesizeNow(job)
        if (!job.settled) {
          job.settled = true
          job.resolve(output)
        }
      } catch (error) {
        if (!job.settled) {
          job.settled = true
          job.reject(error)
        }
      } finally {
        this.synthesisJobs.delete(job)
      }
    }
    this.synthesisQueue = this.synthesisQueue.then(run, run)
    return result
  }

  async #synthesizeNow(job) {
    const tts = this.inspectBundledTts()
    if (!tts.ready) throw new Error(`内置 TTS 组件不完整：${tts.missing.join('、')}。`)
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'zsense-local-tts-'))
    const outputPath = path.join(temporaryDirectory, 'output.wav')
    const controller = new AbortController()
    let closed = Promise.resolve()
    try {
      const args = [
        `--vits-model=${path.join(tts.modelRoot, 'model.onnx')}`,
        `--vits-lexicon=${path.join(tts.modelRoot, 'lexicon.txt')}`,
        `--vits-tokens=${path.join(tts.modelRoot, 'tokens.txt')}`,
        `--tts-rule-fsts=${['date.fst', 'number.fst', 'phone.fst', 'new_heteronym.fst'].filter((file) => isNonEmptyFile(path.join(tts.modelRoot, file))).map((file) => path.join(tts.modelRoot, file)).join(',')}`,
        '--sid=0', `--speed=${job.speed}`, '--num-threads=2', '--provider=cpu',
        // Keep text beginning with "--" from being interpreted as native CLI options.
        `--output-filename=${outputPath}`, '--', job.text,
      ]
      const execution = execFileAsync(tts.binaryPath, args, {
        cwd: temporaryDirectory,
        env: nativeVoiceEnvironment(tts.binaryPath),
        windowsHide: true,
        shell: false,
        timeout: 120_000,
        killSignal: 'SIGKILL',
        maxBuffer: 4 * 1024 * 1024,
        signal: controller.signal,
      })
      if (execution.child?.pid) closed = new Promise((resolve) => execution.child.once('close', resolve))
      this.activeSpeech = { job, controller, child: execution.child }
      await execution
      if (job.generation !== this.speechGeneration || this.closed) return cancelledSynthesisResult(job.startedAt)
      const stat = fs.statSync(outputPath)
      if (!stat.isFile() || stat.size > MAX_TTS_WAVE_BYTES) throw new Error('本地播报音频超过大小上限或格式无效。')
      const audio = fs.readFileSync(outputPath)
      inspectVoiceWave(audio)
      return {
        ...cancelledSynthesisResult(job.startedAt),
        cancelled: false,
        audioBase64: audio.toString('base64'),
      }
    } catch (error) {
      if (job.generation !== this.speechGeneration || this.closed || controller.signal.aborted) return cancelledSynthesisResult(job.startedAt)
      if (error?.killed) throw new Error('本地语音播报超时，请缩短文字后重试。')
      throw new Error(`本地语音播报失败：${String(error?.stderr || error?.message || error).trim().slice(0, 500)}`)
    } finally {
      await closed
      if (this.activeSpeech?.job === job) this.activeSpeech = null
      fs.rmSync(temporaryDirectory, { recursive: true, force: true })
    }
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
    if (this.closed) return Promise.reject(new Error('本地语音服务已关闭。'))
    const run = () => {
      if (this.closed) throw new Error('本地语音服务已关闭。')
      return this.#transcribeNow(request)
    }
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
    const controller = new AbortController()
    let closed = Promise.resolve()
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
      const execution = execFileAsync(stt.binaryPath, args, {
        timeout: fastMode ? 45_000 : 120_000,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
        shell: false,
        env: nativeVoiceEnvironment(stt.binaryPath),
        signal: controller.signal,
        killSignal: 'SIGKILL',
      })
      if (execution.child?.pid) closed = new Promise((resolve) => execution.child.once('close', resolve))
      this.activeTranscription = { controller, child: execution.child }
      const { stdout } = await execution
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
      if (controller.signal.aborted) throw new Error('本地语音服务已关闭，识别已取消。')
      if (error?.killed) throw new Error('本地语音识别超时，请缩短单次说话时间后重试。')
      throw new Error(`本地语音识别失败：${String(error?.stderr || error?.message || error).trim().slice(0, 500)}`)
    } finally {
      await closed
      if (this.activeTranscription?.controller === controller) this.activeTranscription = null
      fs.rmSync(temporaryDirectory, { recursive: true, force: true })
    }
  }

  stopSpeaking() {
    this.speechGeneration += 1
    const stopped = this.synthesisJobs.size > 0
    for (const job of this.synthesisJobs) {
      if (!job.settled) {
        job.settled = true
        job.resolve(cancelledSynthesisResult(job.startedAt))
      }
    }
    this.synthesisJobs.clear()
    this.activeSpeech?.controller.abort()
    return { stopped }
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
      sttModel: stt.ready ? 'Whisper base multilingual Q5_1' : null,
      ttsReady: tts.ready,
      ttsModel: tts.ready ? 'MeloTTS Chinese ONNX · sherpa-onnx native CPU' : null,
      networkRequiredAtRuntime: false,
    }
  }

  shutdown() {
    this.closed = true
    this.stopWake()
    this.stopSpeaking()
    this.activeTranscription?.controller.abort()
    return Promise.all([this.synthesisQueue, this.transcriptionQueue])
  }
}

function isNonEmptyFile(filePath) {
  try { const stat = fs.statSync(filePath); return stat.isFile() && stat.size > 0 } catch { return false }
}

function inspectResourceManifest(rootPath, label, missing) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(rootPath, 'manifest.json'), 'utf8'))
    if (!Array.isArray(manifest.files) || !manifest.files.length) throw new Error('Invalid resource manifest')
    for (const entry of manifest.files) {
      if (typeof entry?.file !== 'string' || !Number.isSafeInteger(entry.size) || entry.size <= 0) throw new Error('Invalid resource manifest entry')
      const resolvedPath = path.resolve(rootPath, entry.file)
      if (!resolvedPath.startsWith(`${path.resolve(rootPath)}${path.sep}`) || !isNonEmptyFile(resolvedPath)) {
        missing.push(`${label}/${entry.file}`)
      } else if (fs.statSync(resolvedPath).size !== entry.size) {
        missing.push(`${label}/${entry.file}（大小不匹配）`)
      }
    }
  } catch {
    missing.push(`${label}清单缺失或无效`)
  }
}

function nativeVoiceEnvironment(binaryPath) {
  const binaryDirectory = path.dirname(binaryPath)
  const env = { PATH: [binaryDirectory, path.join(binaryDirectory, 'libs')].join(path.delimiter), NO_PROXY: '*', no_proxy: '*', LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' }
  for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP']) {
    if (process.env[key]) env[key] = process.env[key]
  }
  return env
}

function cancelledSynthesisResult(startedAt) {
  return {
    played: false, cancelled: true, audioBase64: '', audioMimeType: 'audio/wav',
    provider: BUNDLED_TTS_PROVIDER, language: 'zh-CN', voice: 'melo-zh',
    offline: true, durationMs: Date.now() - startedAt,
  }
}

export function inspectVoiceWave(audio) {
  if (!Buffer.isBuffer(audio) || audio.length < 44 || audio.length > MAX_TTS_WAVE_BYTES || audio.toString('ascii', 0, 4) !== 'RIFF' || audio.toString('ascii', 8, 12) !== 'WAVE' || audio.readUInt32LE(4) + 8 !== audio.length) throw new Error('本地播报没有生成有效 WAV 音频。')
  let format = null
  let pcm = null
  for (let offset = 12; offset < audio.length;) {
    if (offset + 8 > audio.length) throw new Error('本地播报 WAV 数据截断。')
    const chunkName = audio.toString('ascii', offset, offset + 4)
    const length = audio.readUInt32LE(offset + 4)
    const start = offset + 8
    if (start + length > audio.length) throw new Error('本地播报 WAV 数据截断。')
    if (chunkName === 'fmt ') {
      if (format || length < 16) throw new Error('本地播报 WAV 格式无效。')
      format = { encoding: audio.readUInt16LE(start), channels: audio.readUInt16LE(start + 2), sampleRate: audio.readUInt32LE(start + 4), byteRate: audio.readUInt32LE(start + 8), blockAlign: audio.readUInt16LE(start + 12), bits: audio.readUInt16LE(start + 14) }
    } else if (chunkName === 'data') {
      if (pcm) throw new Error('本地播报 WAV 包含重复音频数据。')
      pcm = audio.subarray(start, start + length)
    }
    offset = start + length + (length % 2)
    if (offset > audio.length) throw new Error('本地播报 WAV 数据截断。')
  }
  if (!format || !pcm?.length || format.encoding !== 1 || format.bits !== 16 || ![1, 2].includes(format.channels) || format.sampleRate < 8_000 || format.sampleRate > 96_000 || format.blockAlign !== format.channels * 2 || format.byteRate !== format.sampleRate * format.blockAlign || pcm.length % format.blockAlign !== 0) throw new Error('本地播报 WAV 必须为有效 PCM16 音频。')
  if (!pcm.some((value) => value !== 0)) throw new Error('本地播报生成了空白音频。')
  return { pcm, sampleRate: format.sampleRate, channels: format.channels, durationSeconds: pcm.length / format.byteRate }
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
