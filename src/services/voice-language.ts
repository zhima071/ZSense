// Voice language support is separate from the language of typed conversations.
// Add a language here only after both local STT and TTS support it.
export const VOICE_LANGUAGE = 'zh-CN' as const

export const VOICE_LANGUAGE_OPTIONS = [
  { id: VOICE_LANGUAGE, label: '简体中文', available: true },
] as const
