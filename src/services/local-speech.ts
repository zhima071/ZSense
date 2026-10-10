import { errorMessage, unwrapDesktop } from './desktop'
import type { LocalVoiceOption, LocalVoiceSpeechResult, VoiceSynthesisRequest } from '../types'

const LOCAL_VOICE_ID = 'melo-zh'
const LOCAL_VOICE_PROVIDER = 'ZSense MeloTTS 中文 · 原生完全本地'
const MAX_QUEUED_AUDIO_SECONDS = 12

interface ActivePlayback {
  context: AudioContext
  sources: Set<AudioBufferSourceNode>
  scheduledUntil: number
  generation: number
}

export interface LocalSpeechStream {
  push: (delta: string) => void
  finish: () => Promise<LocalVoiceSpeechResult>
  cancel: () => void
}

let synthesisQueue: Promise<unknown> = Promise.resolve()
let playbackGeneration = 0
let activePlayback: ActivePlayback | null = null

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

function isCurrentPlayback(playback: ActivePlayback, generation: number) {
  return generation === playbackGeneration && playback === activePlayback
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

function stopSynthesis() {
  const desktopVoice = window.zsenseDesktop?.voice
  const stopped = desktopVoice
    ? unwrapDesktop(desktopVoice.stopSpeaking())
    : Promise.resolve({ stopped: false })
  // Send cancellation immediately, but order subsequent synthesis after both the
  // old request and stop IPC settle so a delayed stop cannot kill the new voice.
  synthesisQueue = Promise.allSettled([synthesisQueue, stopped]).then(() => undefined)
  return stopped
}

function beginSpeech() {
  const generation = ++playbackGeneration
  stopPlayback()
  void stopSynthesis().catch(() => undefined)
  return generation
}

async function createPlayback(generation: number) {
  const AudioContextConstructor = window.AudioContext
  if (!AudioContextConstructor) throw new Error('当前系统不支持本地音频播放。')
  const context = new AudioContextConstructor({ latencyHint: 'interactive' })
  const playback: ActivePlayback = { context, sources: new Set(), scheduledUntil: context.currentTime + 0.04, generation }
  // Establish ownership before awaiting resume: cancellation during resume must
  // still close this AudioContext, not leave a stale playback behind.
  activePlayback = playback
  try {
    if (context.state === 'suspended') await context.resume()
    if (!isCurrentPlayback(playback, generation)) return playback
    if (context.state !== 'running') throw new Error('请先点击试听或播报按钮以允许播放声音。')
    return playback
  } catch (error) {
    if (playback === activePlayback) stopPlayback()
    throw error
  }
}

function queueAudioBuffer(playback: ActivePlayback, buffer: AudioBuffer) {
  if (!isCurrentPlayback(playback, playback.generation) || !buffer.length) return false
  const source = playback.context.createBufferSource()
  source.buffer = buffer
  source.connect(playback.context.destination)
  source.addEventListener('ended', () => {
    playback.sources.delete(source)
    source.buffer = null
    try { source.disconnect() } catch { /* already disconnected */ }
  }, { once: true })
  const startAt = Math.max(playback.context.currentTime + 0.025, playback.scheduledUntil)
  try { source.start(startAt) } catch (error) {
    source.disconnect()
    throw error
  }
  playback.scheduledUntil = startAt + buffer.duration
  playback.sources.add(source)
  return true
}

async function synthesizeIntoPlayback(request: VoiceSynthesisRequest, playback: ActivePlayback, generation: number) {
  const desktopVoice = window.zsenseDesktop?.voice
  if (!desktopVoice?.synthesizeLocal) throw new Error('MeloTTS 本地播报只在 ZSense 桌面端中可用。')
  // Bound decoded audio rather than synthesizing an entire long reply up front.
  while (isCurrentPlayback(playback, generation) && playback.scheduledUntil - playback.context.currentTime > MAX_QUEUED_AUDIO_SECONDS) {
    await new Promise((resolve) => window.setTimeout(resolve, 80))
  }
  if (!isCurrentPlayback(playback, generation)) return false
  const result = await unwrapDesktop(desktopVoice.synthesizeLocal({ ...request, language: 'zh-CN', voice: LOCAL_VOICE_ID }))
  if (!isCurrentPlayback(playback, generation) || result.cancelled) return false
  if (result.audioMimeType !== 'audio/wav' || !result.audioBase64) throw new Error('本地语音引擎没有返回有效的 WAV 音频。')
  const encoded = window.atob(result.audioBase64)
  const bytes = Uint8Array.from(encoded, (character) => character.charCodeAt(0))
  const buffer = await playback.context.decodeAudioData(bytes.buffer)
  if (!isCurrentPlayback(playback, generation)) return false
  return queueAudioBuffer(playback, buffer)
}

async function waitForPlayback(playback: ActivePlayback, generation: number) {
  if (!isCurrentPlayback(playback, generation)) return false
  if (playback.context.state === 'suspended') {
    try { await playback.context.resume() } catch { return false }
  }
  // Wait for the final AudioBufferSourceNode's actual `ended` event, not just
  // currentTime. Closing early cuts the final word and can feed it into the mic.
  const estimatedRemainingMs = Math.max(0, (playback.scheduledUntil - playback.context.currentTime) * 1_000)
  const deadline = performance.now() + Math.max(2_500, estimatedRemainingMs + 4_000)
  while (isCurrentPlayback(playback, generation)) {
    if (playback.context.currentTime + 0.005 >= playback.scheduledUntil && playback.sources.size === 0) {
      await new Promise((resolve) => window.setTimeout(resolve, 120))
      return isCurrentPlayback(playback, generation) && playback.sources.size === 0 && playback.context.currentTime + 0.005 >= playback.scheduledUntil
    }
    if (performance.now() >= deadline) return false
    await new Promise((resolve) => window.setTimeout(resolve, 24))
  }
  return false
}

function speechResult(startedAt: number, played = false): LocalVoiceSpeechResult {
  return { played, cancelled: !played, provider: LOCAL_VOICE_PROVIDER, language: 'zh-CN', voice: LOCAL_VOICE_ID, durationMs: Date.now() - startedAt, offline: true }
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
  if (flush && remaining.trim()) { segments.push(remaining); remaining = '' }
  return { segments, remaining }
}

export function createLocalSpeechStream(request: Omit<VoiceSynthesisRequest, 'text'>, onPlaybackStart?: () => void): LocalSpeechStream {
  if (request.language && request.language !== 'zh-CN') throw new Error('当前语音播报仅支持简体中文。')
  const generation = beginSpeech()
  const startedAt = Date.now()
  let buffer = ''
  let sealed = false
  let completed = false
  let cancelled = false
  let playbackStarted = false
  let streamError: unknown
  let playbackPromise: Promise<ActivePlayback> | null = null
  let pending: Promise<unknown> = synthesisQueue

  const enqueue = (value: string) => {
    const speechText = cleanSpeechText(value)
    if (!speechText || sealed || cancelled || streamError || generation !== playbackGeneration) return
    if (!playbackPromise) {
      playbackPromise = createPlayback(generation)
      // A resume error can happen before the synthesis queue reaches this item.
      void playbackPromise.catch(() => undefined)
    }
    const run = async () => {
      if (generation !== playbackGeneration || cancelled || streamError) return
      const playback = await playbackPromise!
      if (!isCurrentPlayback(playback, generation) || cancelled) return
      const queued = await synthesizeIntoPlayback({ ...request, text: speechText }, playback, generation)
      if (queued && !playbackStarted) {
        playbackStarted = true
        onPlaybackStart?.()
      }
    }
    pending = pending.then(run, run).catch((error) => {
      if (generation === playbackGeneration && !cancelled) {
        streamError = error
        stopPlayback()
      }
    })
    synthesisQueue = pending
  }

  const drain = (flush = false) => {
    const pulled = pullSpeechSegments(buffer, flush)
    buffer = pulled.remaining
    pulled.segments.forEach(enqueue)
  }

  return {
    push(delta) {
      if (sealed || cancelled || generation !== playbackGeneration || streamError) return
      buffer += String(delta || '')
      drain()
    },
    async finish() {
      if (sealed || cancelled || generation !== playbackGeneration) return speechResult(startedAt)
      drain(true)
      sealed = true
      await pending
      if (streamError) throw streamError
      if (!playbackPromise || generation !== playbackGeneration) return speechResult(startedAt)
      const playback = await playbackPromise
      const played = playbackStarted && await waitForPlayback(playback, generation)
      if (playback === activePlayback) stopPlayback()
      completed = true
      return speechResult(startedAt, played)
    },
    cancel() {
      if (completed || cancelled) return
      cancelled = true
      buffer = ''
      // Cancelling a previous stream must not interrupt a newer playback.
      if (generation !== playbackGeneration) return
      playbackGeneration += 1
      stopPlayback()
      void stopSynthesis().catch(() => undefined)
    },
  }
}

export async function listLocalVoiceOptions(): Promise<LocalVoiceOption[]> {
  return window.zsenseDesktop?.voice ? unwrapDesktop(window.zsenseDesktop.voice.listVoices()) : []
}

export async function speakLocalAudio(request: VoiceSynthesisRequest) {
  const speechText = cleanSpeechText(request.text)
  if (!speechText) throw new Error('没有可播报的文字。')
  const stream = createLocalSpeechStream(request)
  stream.push(speechText)
  return stream.finish()
}

export async function stopLocalSpeech() {
  playbackGeneration += 1
  const rendererStopped = stopPlayback()
  const mainStopped = await stopSynthesis()
  return { stopped: rendererStopped || mainStopped.stopped }
}

export function describeLocalSpeechError(error: unknown) {
  return `MeloTTS 播报失败：${errorMessage(error)}`
}
