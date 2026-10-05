const DEFAULT_CONTEXT_WINDOW = 128_000

function positiveInteger(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.min(100_000_000, Math.round(number)) : 0
}

function nestedValue(source, path) {
  let current = source
  for (const key of path) {
    if (!current || typeof current !== 'object') return undefined
    current = current[key]
  }
  return current
}

export function inferredContextWindow(provider, model) {
  const id = String(model || '').trim().toLowerCase()
  if (!id) return DEFAULT_CONTEXT_WINDOW
  if (provider === 'deepseek' || /(?:^|[/_-])deepseek(?:[/_-]|$)/.test(id)) {
    if (/deepseek-(?:v?4|flash)|(?:v?4|flash).*deepseek/.test(id)) return 1_000_000
    return 128_000
  }
  if (provider === 'google' || /gemini/.test(id)) {
    if (/gemini-(?:2|3)/.test(id)) return 1_000_000
  }
  if (provider === 'anthropic' || /claude/.test(id)) return 200_000
  if (provider === 'openai' || /(?:^|[/_-])gpt-(?:4\.1|5)/.test(id)) return 400_000
  return DEFAULT_CONTEXT_WINDOW
}

export function contextWindowFromModelEntry(entry, provider, model) {
  if (!entry || typeof entry !== 'object') return inferredContextWindow(provider, model)
  const candidates = [
    ['context_window'],
    ['contextWindow'],
    ['context_length'],
    ['contextLength'],
    ['inputTokenLimit'],
    ['input_token_limit'],
    ['max_input_tokens'],
    ['maxInputTokens'],
    ['max_context_length'],
    ['top_provider', 'context_length'],
    ['capabilities', 'context_window'],
    ['capabilities', 'context_length'],
    ['limits', 'context_window'],
    ['limits', 'input_tokens'],
  ]
  for (const path of candidates) {
    const value = positiveInteger(nestedValue(entry, path))
    if (value) return value
  }
  return inferredContextWindow(provider, model)
}

export function resolvedContextWindow(provider, model, synchronizedValue = 0) {
  return positiveInteger(synchronizedValue) || inferredContextWindow(provider, model)
}
