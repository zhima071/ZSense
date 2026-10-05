import { errorMessage, unwrapDesktop } from './desktop'
import type { LocalVoiceOption, LocalVoiceSpeechResult, VoiceSynthesisRequest } from '../types'
import type { MossAudioChunk, MossTtsRuntime, MossVoicePreset } from '../vendor/moss-tts/browser_onnx_runtime.js'

const CUSTOM_VOICE_STORAGE_KEY = 'zsense-moss-custom-voices-v1'
const LEGACY_VOICE_ALIASES: Record<string, string> = {
  zf_xiaoxiao: 'Xiaoyu', zf_xiaobei: 'Yuewen', zf_xiaoni: 'Lingyu', zf_xiaoyi: 'Xiaoyu',
  zm_yunxi: 'Junhao', zm_yunjian: 'Zhiming', zm_yunxia: 'Weiguo', zm_yunyang: 'Junhao',
}

interface MossTtsConfiguration {
  engine: 'moss-tts-nano'
  modelUrl: string
  threadCount: number
  streaming: true
  offline: true
}

interface StoredMossVoice {
  id: string
  name: string
  createdAt: string
  promptAudioCodes: number[][]
}

interface ActivePlayback {
  context: AudioContext
  sources: Set<AudioBufferSourceNode>
  scheduledUntil: number
  generation: number
}

interface ResolvedMossVoice {
  requestedVoice: string
  promptAudioCodes: number[][]
  group: string
}

export interface LocalSpeechStream {
  push: (delta: string) => void
  finish: () => Promise<LocalVoiceSpeechResult>
  cancel: () => void
}

let runtimePromise: Promise<MossTtsRuntime> | null = null
let synthesisQueue: Promise<unknown> = Promise.resolve()
let playbackGeneration = 0
let activePlayback: ActivePlayback | null = null

function loadCustomVoices(): StoredMossVoice[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(CUSTOM_VOICE_STORAGE_KEY) || '[]')
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item) => item && typeof item.id === 'string' && typeof item.name === 'string' && Array.isArray(item.promptAudioCodes))
  } catch {
    return []
  }
}

function saveCustomVoices(voices: StoredMossVoice[]) {
  window.localStorage.setItem(CUSTOM_VOICE_STORAGE_KEY, JSON.stringify(voices))
}

function customVoicePresets(): MossVoicePreset[] {
  return loadCustomVoices().map((voice) => ({
    voice: voice.id,
    display_name: voice.name,
    group: 'ZSense Custom Voice',
    prompt_audio_codes: voice.promptAudioCodes,
  }))
}

function cleanSpeechText(value: string) {
  return String(value || '')
    .replace(/```[\s\S]*?```/gu, ' 代码内容已省略。 ')
    .replace(/`([^`]+)`/gu, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
    .replace(/https?:\/\/\S+/giu, ' 链接 ')
    .replace(/^\s{0,3}(?:#{1,6}|>|[-*+] |\d+[.)] )/gmu, '')
    .replace(/[|*_~]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
}

async function loadRuntime() {
  if (runtimePromise) return runtimePromise
  runtimePromise = (async () => {
    const desktop = window.zsenseDesktop
    if (!desktop?.voice) throw new Error('MOSS-TTS-Nano 只能在 ZSense 桌面端中使用。')
    const configuration = await unwrapDesktop(desktop.voice.ttsConfig()) as MossTtsConfiguration
    // ONNX runtime 体积很大；只有用户首次真正播报时才下载并解析这个分包，避免拖慢
    // 总览、文字对话等绝大多数启动路径。
    const { createBrowserOnnxTtsRuntime } = await import('../vendor/moss-tts/browser_onnx_runtime.js')
    const runtime = createBrowserOnnxTtsRuntime()
    await runtime.configure({ modelPath: configuration.modelUrl, threadCount: configuration.threadCount })
    return runtime
  })().catch((error) => {
    runtimePromise = null
    throw error
  })
  return runtimePromise
}

function stopPlayback() {
  const playback = activePlayback
  if (!playback) return false
  activePlayback = null
  for (const source of playback.sources) {
    try { source.stop() } catch { /* already ended */ }
    try { source.disconnect() } catch { /* already disconnected */ }
  }
  playback.sources.clear()
  void playback.context.close().catch(() => undefined)
  return true
}

async function createPlayback(generation: number) {
  const AudioContextConstructor = window.AudioContext
  if (!AudioContextConstructor) throw new Error('当前系统不支持本地流式音频播放。')
  const context = new AudioContextConstructor({ latencyHint: 'interactive' })
  if (context.state === 'suspended') await context.resume()
  const playback: ActivePlayback = {
    context,
    sources: new Set(),
    scheduledUntil: context.currentTime + 0.04,
    generation,
  }
  activePlayback = playback
  return playback
}

function queueAudioChunk(playback: ActivePlayback, chunk: MossAudioChunk) {
  if (playback !== activePlayback || playback.generation !== playbackGeneration) return
  const channels = Math.max(1, Math.min(chunk.channels || chunk.chunkData.length, chunk.chunkData.length))
  const sampleLength = chunk.chunkData[0]?.length || 0
  if (!sampleLength) return
  const buffer = playback.context.createBuffer(channels, sampleLength, chunk.sampleRate)
  for (let channel = 0; channel < channels; channel += 1) buffer.copyToChannel(new Float32Array(chunk.chunkData[channel]), channel)
  const source = playback.context.createBufferSource()
  source.buffer = buffer
  source.connect(playback.context.destination)
  source.addEventListener('ended', () => {
    playback.sources.delete(source)
    try { source.disconnect() } catch { /* already disconnected */ }
  }, { once: true })
  const startAt = Math.max(playback.context.currentTime + 0.025, playback.scheduledUntil)
  source.start(startAt)
  playback.scheduledUntil = startAt + buffer.duration
  playback.sources.add(source)
}

async function waitForPlayback(playback: ActivePlayback, generation: number) {
  if (generation !== playbackGeneration || playback !== activePlayback) return false
  if (playback.context.state === 'suspended') {
    try { await playback.context.resume() } catch { return false }
  }

  // WebAudio's currentTime is only an estimate of when the device has finished
  // rendering. Waiting once for that timestamp can close the AudioContext while
  // the final AudioBufferSourceNode is still audible. Keep the stream alive until
  // every scheduled node has emitted its real `ended` event, then preserve a
  // short device-output tail before continuous listening is allowed to resume.
  const estimatedRemainingMs = Math.max(0, (playback.scheduledUntil - playback.context.currentTime) * 1_000)
  const deadline = performance.now() + Math.max(2_500, estimatedRemainingMs + 4_000)
  while (generation === playbackGeneration && playback === activePlayback) {
    const timelineFinished = playback.context.currentTime + 0.005 >= playback.scheduledUntil
    if (timelineFinished && playback.sources.size === 0) {
      await new Promise((resolve) => window.setTimeout(resolve, 120))
      return generation === playbackGeneration
        && playback === activePlayback
        && playback.sources.size === 0
        && playback.context.currentTime + 0.005 >= playback.scheduledUntil
    }
    if (performance.now() >= deadline) return false
    await new Promise((resolve) => window.setTimeout(resolve, 24))
  }
  return false
}

function cancelledSpeechResult(request: VoiceSynthesisRequest, startedAt: number): LocalVoiceSpeechResult {
  return {
    played: false,
    cancelled: true,
    provider: 'ZSense MOSS-TTS-Nano ONNX · 完全本地',
    language: 'zh-CN',
    voice: request.voice || 'Xiaoyu',
    durationMs: Date.now() - startedAt,
    offline: true,
  }
}

async function resolveMossVoice(request: VoiceSynthesisRequest): Promise<ResolvedMossVoice> {
  const runtime = await loadRuntime()
  const requestedVoice = LEGACY_VOICE_ALIASES[request.voice || ''] || request.voice || 'Xiaoyu'
  const customVoice = loadCustomVoices().find((voice) => voice.id === requestedVoice)
  await runtime.ensureManifestLoaded()
  const builtinVoice = customVoice ? undefined : runtime.listBuiltinVoices().find((voice) => voice.voice === requestedVoice)
  if (!customVoice && !builtinVoice) throw new Error(`找不到 MOSS 音色：${requestedVoice}`)
  const selectedPromptAudioCodes = customVoice?.promptAudioCodes || builtinVoice?.prompt_audio_codes
  if (!selectedPromptAudioCodes?.length) throw new Error(`MOSS 音色 ${requestedVoice} 没有有效的参考音频编码。`)
  return { requestedVoice, promptAudioCodes: selectedPromptAudioCodes, group: builtinVoice?.group || 'ZSense Custom Voice' }
}

async function synthesizeIntoPlayback(request: VoiceSynthesisRequest, voice: ResolvedMossVoice, playback: ActivePlayback, generation: number) {
  const runtime = await loadRuntime()
  if (generation !== playbackGeneration) return false
  await runtime.synthesizeVoiceClone({
    text: request.text,
    voiceName: null,
    promptAudioCodes: voice.promptAudioCodes,
    extraVoices: customVoicePresets(),
    streaming: true,
    enableNormalizeTtsText: true,
    enableWeTextProcessing: false,
    voiceCloneMaxTextTokens: 75,
    isCancelled: () => generation !== playbackGeneration,
    onAudioChunk: (chunk) => queueAudioChunk(playback, chunk),
  })
  return generation === playbackGeneration
}

async function synthesizeAndPlay(request: VoiceSynthesisRequest, generation: number): Promise<LocalVoiceSpeechResult> {
  const startedAt = Date.now()
  const speechText = cleanSpeechText(request.text)
  if (!speechText) throw new Error('没有可播报的文字。')
  const voice = await resolveMossVoice(request)
  if (generation !== playbackGeneration) return cancelledSpeechResult(request, startedAt)
  const playback = await createPlayback(generation)
  await synthesizeIntoPlayback({ ...request, text: speechText }, voice, playback, generation)
  if (generation !== playbackGeneration) return cancelledSpeechResult(request, startedAt)
  const completed = await waitForPlayback(playback, generation)
  if (playback === activePlayback) {
    activePlayback = null
    void playback.context.close().catch(() => undefined)
  }
  return {
    played: completed,
    cancelled: !completed,
    provider: 'ZSense MOSS-TTS-Nano ONNX · 完全本地',
    language: 'zh-CN',
    voice: voice.requestedVoice,
    durationMs: Date.now() - startedAt,
    offline: true,
  }
}

function pullSpeechSegments(buffer: string, flush = false) {
  const segments: string[] = []
  let remaining = buffer
  while (remaining) {
    const terminal = /[。！？!?；;\n]/gu.exec(remaining)
    if (terminal && terminal.index + terminal[0].length <= 72) {
      const end = terminal.index + terminal[0].length
      segments.push(remaining.slice(0, end))
      remaining = remaining.slice(end)
      continue
    }
    if (remaining.length >= 52) {
      const preferred = Math.max(remaining.lastIndexOf('，', 52), remaining.lastIndexOf(',', 52), remaining.lastIndexOf(' ', 52))
      const end = preferred >= 28 ? preferred + 1 : 52
      segments.push(remaining.slice(0, end))
      remaining = remaining.slice(end)
      continue
    }
    break
  }
  if (flush && remaining.trim()) {
    segments.push(remaining)
    remaining = ''
  }
  return { segments, remaining }
}

export function createLocalSpeechStream(request: Omit<VoiceSynthesisRequest, 'text'>, onPlaybackStart?: () => void): LocalSpeechStream {
  if (request.language && request.language !== 'zh-CN') throw new Error('当前语音播报仅支持简体中文。')
  const generation = ++playbackGeneration
  const startedAt = Date.now()
  stopPlayback()
  let buffer = ''
  let sealed = false
  let completed = false
  let cancelled = false
  let playbackStarted = false
  let playbackPromise: Promise<ActivePlayback> | null = null
  let voicePromise: Promise<ResolvedMossVoice> | null = null
  let pending: Promise<unknown> = synthesisQueue

  const enqueue = (value: string) => {
    const speechText = cleanSpeechText(value)
    if (!speechText || sealed || cancelled) return
    if (!playbackPromise) playbackPromise = createPlayback(generation)
    if (!voicePromise) voicePromise = resolveMossVoice({ ...request, text: speechText })
    const run = async () => {
      if (generation !== playbackGeneration || cancelled) return
      const [playback, voice] = await Promise.all([playbackPromise!, voicePromise!])
      if (generation !== playbackGeneration || cancelled) return
      if (!playbackStarted) {
        playbackStarted = true
        onPlaybackStart?.()
      }
      await synthesizeIntoPlayback({ ...request, text: speechText }, voice, playback, generation)
    }
    pending = pending.then(run, run)
    synthesisQueue = pending.catch(() => undefined)
  }

  const drain = (flush = false) => {
    const pulled = pullSpeechSegments(buffer, flush)
    buffer = pulled.remaining
    pulled.segments.forEach(enqueue)
  }

  return {
    push(delta) {
      if (sealed || cancelled || generation !== playbackGeneration) return
      buffer += String(delta || '')
      drain(false)
    },
    async finish() {
      if (sealed || cancelled) return cancelledSpeechResult({ ...request, text: '' }, startedAt)
      drain(true)
      sealed = true
      await pending
      if (!playbackPromise || !voicePromise || generation !== playbackGeneration) return cancelledSpeechResult({ ...request, text: '' }, startedAt)
      const [playback, voice] = await Promise.all([playbackPromise, voicePromise])
      const playbackCompleted = await waitForPlayback(playback, generation)
      if (playback === activePlayback) {
        activePlayback = null
        void playback.context.close().catch(() => undefined)
      }
      const played = playbackCompleted
      completed = true
      return {
        played,
        cancelled: !played,
        provider: 'ZSense MOSS-TTS-Nano ONNX · 完全本地',
        language: 'zh-CN',
        voice: voice.requestedVoice,
        durationMs: Date.now() - startedAt,
        offline: true,
      }
    },
    cancel() {
      if (completed || cancelled) return
      cancelled = true
      buffer = ''
      if (generation === playbackGeneration) playbackGeneration += 1
      stopPlayback()
    },
  }
}

export async function prepareLocalSpeech() {
  const runtime = await loadRuntime()
  await runtime.warmup()
  return true
}

export async function listLocalVoiceOptions(): Promise<LocalVoiceOption[]> {
  const bundled = window.zsenseDesktop?.voice
    ? await unwrapDesktop(window.zsenseDesktop.voice.listVoices())
    : []
  const custom: LocalVoiceOption[] = loadCustomVoices().map((voice) => ({
    id: voice.id,
    name: `${voice.name} · 自定义克隆`,
    language: 'zh-CN',
    gender: 'custom',
    engine: 'moss-tts-nano',
    local: true,
    bundled: false,
  }))
  return [...bundled, ...custom]
}

export async function importMossVoice(file: File, name: string) {
  if (!file || file.size <= 0) throw new Error('请选择包含清晰人声的参考音频。')
  if (file.size > 25 * 1024 * 1024) throw new Error('参考音频不能超过 25MB。')
  const runtime = await loadRuntime()
  const promptAudioCodes = await runtime.encodeReferenceAudioFromFile(file)
  if (!promptAudioCodes.length) throw new Error('没有从参考音频中提取到有效音色。')
  const voice: StoredMossVoice = {
    id: `custom-${crypto.randomUUID()}`,
    name: name.trim() || file.name.replace(/\.[^.]+$/u, '') || '我的音色',
    createdAt: new Date().toISOString(),
    promptAudioCodes,
  }
  saveCustomVoices([...loadCustomVoices(), voice])
  return voice.id
}

export function deleteMossVoice(id: string) {
  const current = loadCustomVoices()
  const next = current.filter((voice) => voice.id !== id)
  if (next.length === current.length) return false
  saveCustomVoices(next)
  return true
}

export async function speakLocalAudio(request: VoiceSynthesisRequest) {
  if (request.language && request.language !== 'zh-CN') throw new Error('当前语音播报仅支持简体中文。')
  const generation = ++playbackGeneration
  stopPlayback()
  const run = () => synthesizeAndPlay(request, generation)
  const pending = synthesisQueue.then(run, run)
  synthesisQueue = pending.catch(() => undefined)
  return pending
}

export async function stopLocalSpeech() {
  playbackGeneration += 1
  const rendererStopped = stopPlayback()
  const mainStopped = window.zsenseDesktop?.voice ? await unwrapDesktop(window.zsenseDesktop.voice.stopSpeaking()) : { stopped: false }
  return { stopped: rendererStopped || mainStopped.stopped }
}

export function describeLocalSpeechError(error: unknown) {
  return `MOSS-TTS-Nano 播报失败：${errorMessage(error)}`
}
