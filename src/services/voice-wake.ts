import type { LocalVoiceTranscriptionResult } from '../types'
import { VOICE_LANGUAGE } from './voice-language'

const LOCAL_SAMPLE_RATE = 16_000 as const
const PCM_CHUNK_SIZE = 32_768

export interface VoiceWakeCaptureHandle {
  stop: () => void
  readonly active: boolean
}

export interface VoiceTextCaptureResult {
  transcript: string
  confidence: number
  provider: string
  offline: true
}

export interface VoiceTextCaptureHandle {
  stop: () => void
  cancel: () => void
  readonly active: boolean
  readonly result: Promise<VoiceTextCaptureResult>
}

export interface VoiceBargeInCaptureHandle {
  stop: () => void
  readonly active: boolean
}

interface VoiceWakeCaptureOptions {
  phrase?: string
  language?: typeof VOICE_LANGUAGE
  sensitivity?: number
  confirmationFrames?: number
  onDetected: (phrase: string, transcript: string) => void
  onError?: (error: Error) => void
}

interface VoiceTextCaptureOptions {
  language?: typeof VOICE_LANGUAGE
  timeoutMs?: number
  mode?: 'conversation' | 'enrollment'
  /** Composer dictation keeps pauses until the user explicitly finishes. */
  manualStop?: boolean
  onInterim?: (transcript: string) => void
  onTranscribing?: () => void
}

interface VoiceBargeInCaptureOptions {
  onDetected: () => void
  onError?: (error: Error) => void
  armDelayMs?: number
  echoResistant?: boolean
}

interface PcmRecorder {
  stop: () => void
  readonly active: boolean
}

function normalized(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('zh-CN').replace(/[\s,.，。!！?？_-]+/g, '')
}

function wakeVariants(phrase: string): string[] {
  const base = normalized(phrase || '你好 ZSense')
  // A bare product name is too easy for Whisper to hallucinate from room noise.
  // Keep only complete, intentional wake phrases for the built-in default.
  const defaultVariants = ['你好zsense', '嗨zsense'].map(normalized)
  return [...new Set(base === normalized('你好 ZSense') ? [base, ...defaultVariants] : [base])]
}

function localVoiceApi() {
  return window.zsenseDesktop?.voice
}

export function voiceTextRecognitionSupported(): boolean {
  const mediaDevices = (navigator as Navigator & { mediaDevices?: MediaDevices }).mediaDevices
  return typeof localVoiceApi()?.transcribeLocal === 'function'
    && typeof mediaDevices?.getUserMedia === 'function'
    && ('AudioContext' in window || 'webkitAudioContext' in window)
}

export function wakePhraseMatches(phrase: string, transcript: string): boolean {
  const candidate = normalized(transcript)
  // Wake words should begin the utterance. Matching anywhere in a long ambient
  // sentence made TV/audio in the room capable of opening a conversation.
  return Boolean(candidate) && wakeVariants(phrase).some((variant) => candidate === variant || candidate.startsWith(variant))
}

function errorFromUnknown(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function abortError(): Error {
  const error = new Error('语音交互已停止。')
  error.name = 'AbortError'
  return error
}

function downsampleToPcm16(input: Float32Array, inputRate: number): Int16Array {
  const ratio = inputRate / LOCAL_SAMPLE_RATE
  const outputLength = Math.max(1, Math.floor(input.length / ratio))
  const output = new Int16Array(outputLength)
  for (let index = 0; index < outputLength; index += 1) {
    const start = Math.floor(index * ratio)
    const end = Math.max(start + 1, Math.min(input.length, Math.floor((index + 1) * ratio)))
    let sum = 0
    for (let cursor = start; cursor < end; cursor += 1) sum += input[cursor]
    const sample = Math.max(-1, Math.min(1, sum / Math.max(1, end - start)))
    output[index] = sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff)
  }
  return output
}

function rootMeanSquare(input: Float32Array): number {
  let sum = 0
  for (let index = 0; index < input.length; index += 1) sum += input[index] * input[index]
  return Math.sqrt(sum / Math.max(1, input.length))
}

function concatenatePcm(chunks: Int16Array[], limitSamples = Number.POSITIVE_INFINITY): Int16Array {
  const total = Math.min(limitSamples, chunks.reduce((sum, chunk) => sum + chunk.length, 0))
  const result = new Int16Array(total)
  let offset = 0
  for (const chunk of chunks) {
    if (offset >= total) break
    const slice = chunk.subarray(0, Math.min(chunk.length, total - offset))
    result.set(slice, offset)
    offset += slice.length
  }
  return result
}

function pcmToBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += PCM_CHUNK_SIZE) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + PCM_CHUNK_SIZE))
  }
  return btoa(binary)
}

async function transcribeLocal(pcm: Int16Array, language: typeof VOICE_LANGUAGE, mode: 'conversation' | 'wake' | 'enrollment'): Promise<LocalVoiceTranscriptionResult> {
  const voice = localVoiceApi()
  if (!voice?.transcribeLocal) throw new Error('当前安装缺少 ZSense 本地 STT 接口。')
  const response = await voice.transcribeLocal({
    pcmBase64: pcmToBase64(pcm),
    sampleRate: LOCAL_SAMPLE_RATE,
    language,
    mode,
  })
  if (!response.ok || !response.data) throw new Error(response.error || '本地语音识别失败。')
  return response.data
}

async function openPcmRecorder(onChunk: (pcm: Int16Array, rms: number) => void, signal?: AbortSignal): Promise<PcmRecorder> {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('当前系统无法访问麦克风。')
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
    video: false,
  })
  let context: AudioContext | null = null
  let source: MediaStreamAudioSourceNode | null = null
  let processor: ScriptProcessorNode | null = null
  let silentOutput: GainNode | null = null
  let active = true
  const stop = () => {
    if (!active) return
    active = false
    signal?.removeEventListener('abort', stop)
    if (processor) processor.onaudioprocess = null
    try { source?.disconnect() } catch { /* already disconnected */ }
    try { processor?.disconnect() } catch { /* already disconnected */ }
    try { silentOutput?.disconnect() } catch { /* already disconnected */ }
    for (const track of stream.getTracks()) {
      try { track.stop() } catch { /* keep stopping the remaining tracks */ }
    }
    try { void context?.close().catch(() => undefined) } catch { /* failed initialization */ }
  }
  signal?.addEventListener('abort', stop, { once: true })
  try {
    if (signal?.aborted) throw abortError()
    const extendedWindow = window as Window & { webkitAudioContext?: typeof AudioContext }
    const AudioContextConstructor = window.AudioContext || extendedWindow.webkitAudioContext
    if (!AudioContextConstructor) throw new Error('当前系统不支持本地 PCM 录音。')
    context = new AudioContextConstructor({ latencyHint: 'interactive' })
    const sampleRate = context.sampleRate
    source = context.createMediaStreamSource(stream)
    processor = context.createScriptProcessor(2048, 1, 1)
    silentOutput = context.createGain()
    silentOutput.gain.value = 0
    processor.onaudioprocess = (event) => {
      if (!active) return
      const samples = event.inputBuffer.getChannelData(0)
      onChunk(downsampleToPcm16(samples, sampleRate), rootMeanSquare(samples))
    }
    source.connect(processor)
    processor.connect(silentOutput)
    silentOutput.connect(context.destination)
    if (context.state === 'suspended') await context.resume()
    if (!active || signal?.aborted) throw abortError()
  } catch (error) {
    stop()
    throw error
  }

  return {
    get active() { return active },
    stop,
  }
}

export function startVoiceTextCapture(options: VoiceTextCaptureOptions = {}): VoiceTextCaptureHandle {
  let active = true
  let cancelled = false
  let recorder: PcmRecorder | null = null
  let finishRecording: ((error?: Error) => void) | null = null
  const recorderAbort = new AbortController()
  const chunks: Int16Array[] = []
  const preRollChunks: Int16Array[] = []
  const candidateChunks: Int16Array[] = []
  let preRollSamples = 0
  let candidateSamples = 0
  let speechStartedAt = 0
  let candidateStartedAt = 0
  let lastSpeechAt = 0
  let lastStatusAt = 0
  let noiseFloor = 0.003
  const maximumPreRollSamples = Math.round(LOCAL_SAMPLE_RATE * 0.28)
  const minimumSpeechSamples = Math.round(LOCAL_SAMPLE_RATE * 0.18)

  const trimPreRoll = () => {
    while (preRollSamples > maximumPreRollSamples && preRollChunks.length > 1) {
      const removed = preRollChunks.shift()
      preRollSamples -= removed?.length || 0
    }
  }

  const result = (async (): Promise<VoiceTextCaptureResult> => {
    try {
      const pcm = await new Promise<Int16Array>((resolve, reject) => {
        let settled = false
        let maximumTimer = 0
        const finish = (error?: Error) => {
          if (settled) return
          settled = true
          window.clearTimeout(maximumTimer)
          recorderAbort.abort()
          recorder?.stop()
          recorder = null
          finishRecording = null
          if (error) reject(error)
          else if (!speechStartedAt) reject(new Error('没有检测到语音，请靠近麦克风后重试。'))
          else resolve(concatenatePcm(chunks, LOCAL_SAMPLE_RATE * 35))
        }
        finishRecording = finish
        maximumTimer = window.setTimeout(() => {
          if (speechStartedAt) finish()
          else finish(new Error('没有检测到语音，请靠近麦克风后重试。'))
        }, options.manualStop
          ? Math.min(35_000, Math.max(4_000, options.timeoutMs || 35_000))
          : Math.max(4_000, options.timeoutMs || 12_000))

        void openPcmRecorder((chunk, rms) => {
          if (settled || cancelled) return
          const now = Date.now()
          const speechThreshold = Math.max(0.009, Math.min(0.05, noiseFloor * 2.6))

          if (!speechStartedAt) {
            if (rms >= speechThreshold) {
              if (!candidateStartedAt) candidateStartedAt = now
              candidateChunks.push(chunk)
              candidateSamples += chunk.length
              if (candidateSamples >= minimumSpeechSamples) {
                speechStartedAt = candidateStartedAt
                lastSpeechAt = now
                chunks.push(...preRollChunks, ...candidateChunks)
                preRollChunks.length = 0
                candidateChunks.length = 0
                preRollSamples = 0
                candidateSamples = 0
              }
            } else {
              // A short click, keyboard tap or fan fluctuation must not count as
              // speech. Move it into the bounded pre-roll and keep calibrating.
              if (candidateChunks.length) {
                preRollChunks.push(...candidateChunks)
                preRollSamples += candidateSamples
                candidateChunks.length = 0
                candidateSamples = 0
                candidateStartedAt = 0
              }
              preRollChunks.push(chunk)
              preRollSamples += chunk.length
              trimPreRoll()
              if (rms < speechThreshold) noiseFloor = noiseFloor * 0.92 + rms * 0.08
            }
            return
          }

          chunks.push(chunk)
          if (rms >= speechThreshold * 0.78) lastSpeechAt = now
          if (speechStartedAt && now - lastStatusAt >= 900) {
            lastStatusAt = now
            options.onInterim?.(`本地录音 ${Math.max(1, Math.round((now - speechStartedAt) / 1000))} 秒`)
          }
          if (!options.manualStop && speechStartedAt && now - speechStartedAt >= 420 && now - lastSpeechAt >= 700) finish()
        }, recorderAbort.signal).then((openedRecorder) => {
          // Permission prompts and AudioContext.resume can outlive cancellation.
          if (settled || cancelled) openedRecorder.stop()
          else recorder = openedRecorder
        }).catch((error) => finish(errorFromUnknown(error)))
      })
      if (cancelled) throw abortError()
      options.onTranscribing?.()
      options.onInterim?.('录音完成，正在使用内置 Whisper 模型转写')
      const transcription = await transcribeLocal(pcm, options.language || VOICE_LANGUAGE, options.mode || 'conversation')
      if (cancelled) throw abortError()
      const transcript = transcription.transcript.trim()
      if (!transcript) throw new Error('本地模型没有识别到完整语音，请再说一次。')
      return { transcript, confidence: transcription.confidence, provider: transcription.provider, offline: true }
    } finally {
      const currentRecorder = recorder as PcmRecorder | null
      currentRecorder?.stop()
      recorder = null
      finishRecording = null
      recorderAbort.abort()
      active = false
    }
  })()

  return {
    get active() { return active },
    result,
    stop() {
      if (!active || cancelled) return
      finishRecording?.()
    },
    cancel() {
      if (!active || cancelled) return
      cancelled = true
      finishRecording?.(abortError())
      recorderAbort.abort()
      recorder?.stop()
      recorder = null
      finishRecording = null
      active = false
    },
  }
}

export async function startVoiceBargeInCapture(options: VoiceBargeInCaptureOptions): Promise<VoiceBargeInCaptureHandle> {
  if (!voiceTextRecognitionSupported()) throw new Error('当前安装缺少完全本地的语音识别组件。')
  const startedAt = Date.now()
  const echoResistant = Boolean(options.echoResistant)
  const armDelayMs = Math.max(echoResistant ? 850 : 250, options.armDelayMs ?? (echoResistant ? 850 : 450))
  let recorder: PcmRecorder | null = null
  let stopped = false
  let triggered = false
  let loudSince = 0
  let baselineTotal = 0
  let baselineFrames = 0
  let baselinePeak = 0
  let adaptiveBaseline = 0

  try {
    recorder = await openPcmRecorder((_chunk, rms) => {
      if (stopped || triggered) return
      const now = Date.now()
      if (now - startedAt < armDelayMs) {
        baselineTotal += rms
        baselineFrames += 1
        baselinePeak = Math.max(baselinePeak, rms)
        return
      }
      const capturedBaseline = baselineFrames ? baselineTotal / baselineFrames : 0
      if (!adaptiveBaseline) adaptiveBaseline = capturedBaseline
      const baseline = Math.max(capturedBaseline, adaptiveBaseline)
      const speechThreshold = echoResistant
        ? Math.max(0.032, Math.min(0.14, Math.max(baseline * 3.1, baselinePeak * 1.28)))
        : Math.max(0.018, Math.min(0.075, baseline * 2.2))
      if (rms >= speechThreshold) {
        if (!loudSince) loudSince = now
        if (now - loudSince >= (echoResistant ? 360 : 180)) {
          triggered = true
          stopped = true
          recorder?.stop()
          options.onDetected()
        }
      } else if (rms < speechThreshold * 0.72) {
        loudSince = 0
        // Follow changing speaker leakage slowly so louder TTS syllables do not
        // look like a new human utterance. A real nearby voice still rises well
        // above this rolling echo floor and can interrupt the reply.
        adaptiveBaseline = adaptiveBaseline * 0.94 + rms * 0.06
        baselinePeak = Math.max(baselinePeak * 0.997, rms)
      }
    })
  } catch (error) {
    options.onError?.(errorFromUnknown(error))
    throw error
  }

  return {
    get active() { return !stopped && Boolean(recorder?.active) },
    stop() {
      if (stopped) return
      stopped = true
      recorder?.stop()
      recorder = null
    },
  }
}

export async function startVoiceWakeCapture(options: VoiceWakeCaptureOptions): Promise<VoiceWakeCaptureHandle> {
  if (!voiceTextRecognitionSupported()) throw new Error('当前安装缺少完全本地的语音识别组件。')
  const phrase = options.phrase || '你好 ZSense'
  const language = options.language || VOICE_LANGUAGE
  const sensitivity = Math.max(0.2, Math.min(0.9, Number(options.sensitivity || 0.3)))
  const voiceThreshold = 0.004 + sensitivity * 0.01
  const windowSamples = Math.round(LOCAL_SAMPLE_RATE * 2.4)
  const inferenceStepSamples = Math.round(LOCAL_SAMPLE_RATE * 0.8)
  let chunks: Int16Array[] = []
  let samplesInWindow = 0
  let samplesSinceInference = 0
  let heardVoice = false
  let stopped = false
  let inferenceRunning = false
  let consecutiveFailures = 0
  let confirmedMatches = 0
  let lastMatchedAt = 0
  let lastDetectionAt = 0
  const confirmationFrames = Math.max(1, Math.min(8, Math.round(Number(options.confirmationFrames || 1))))

  const trimWindow = () => {
    while (samplesInWindow > windowSamples && chunks.length > 1) {
      const removed = chunks.shift()
      samplesInWindow -= removed?.length || 0
    }
  }

  const infer = async () => {
    if (stopped || inferenceRunning || !heardVoice) return
    inferenceRunning = true
    heardVoice = false
    samplesSinceInference = 0
    try {
      const transcription = await transcribeLocal(concatenatePcm(chunks, windowSamples), language, 'wake')
      consecutiveFailures = 0
      const now = Date.now()
      if (wakePhraseMatches(phrase, transcription.transcript)) {
        confirmedMatches = now - lastMatchedAt <= 1_800 ? confirmedMatches + 1 : 1
        lastMatchedAt = now
        if (confirmedMatches >= confirmationFrames && now - lastDetectionAt > 2_000) {
          lastDetectionAt = now
          confirmedMatches = 0
          options.onDetected(phrase, transcription.transcript)
        }
      } else if (now - lastMatchedAt > 1_800) {
        confirmedMatches = 0
      }
    } catch (error) {
      consecutiveFailures += 1
      if (consecutiveFailures >= 3) options.onError?.(errorFromUnknown(error))
    } finally {
      inferenceRunning = false
    }
  }

  const recorder = await openPcmRecorder((chunk, rms) => {
    if (stopped) return
    chunks.push(chunk)
    samplesInWindow += chunk.length
    samplesSinceInference += chunk.length
    if (rms >= voiceThreshold) heardVoice = true
    trimWindow()
    if (samplesSinceInference >= inferenceStepSamples) void infer()
  })

  return {
    get active() { return !stopped && recorder.active },
    stop() {
      if (stopped) return
      stopped = true
      chunks = []
      recorder.stop()
    },
  }
}
