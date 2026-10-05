export interface MossAudioChunk {
  channels: number
  sampleRate: number
  chunkData: Float32Array[]
  isPause?: boolean
}

export interface MossVoicePreset {
  voice: string
  display_name: string
  group: string
  prompt_audio_codes: number[][]
}

export interface MossTtsRuntime {
  configure(configuration: { modelPath: string; threadCount?: number }): Promise<void>
  warmup(): Promise<void>
  ensureManifestLoaded(): Promise<void>
  listBuiltinVoices(): MossVoicePreset[]
  encodeReferenceAudioFromFile(file: File): Promise<number[][]>
  synthesizeVoiceClone(configuration: {
    text: string
    voiceName?: string | null
    promptAudioCodes?: number[][] | null
    extraVoices?: MossVoicePreset[]
    streaming?: boolean
    enableNormalizeTtsText?: boolean
    enableWeTextProcessing?: boolean
    voiceCloneMaxTextTokens?: number
    isCancelled?: () => boolean
    onAudioChunk?: (chunk: MossAudioChunk) => Promise<void> | void
  }): Promise<{ textChunks: string[]; outputs: Array<{ frames: number; chunks: MossAudioChunk[] }> }>
}

export function createBrowserOnnxTtsRuntime(options?: {
  logger?: (message: string) => void
}): MossTtsRuntime
