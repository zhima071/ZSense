export const DEFAULT_CHAT_DICTATION_SHORTCUT = 'CommandOrControl+Shift+M'

/** A structural event type usable by both native and React keyboard events. */
export interface ChatDictationShortcutEvent {
  key: string
  code?: string
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  altKey: boolean
  repeat?: boolean
  isComposing?: boolean
  keyCode?: number
  defaultPrevented?: boolean
}

function canonicalShortcut(value: string): string | null {
  const tokens = value.trim().split('+').map((token) => token.trim().toLowerCase())
  const key = tokens.pop()?.toUpperCase() || ''
  if (!/^(?:[A-Z0-9]|F(?:[1-9]|1[0-2]))$/.test(key)) return null
  let primary = false
  let shift = false
  let alt = false
  for (const token of tokens) {
    if (['commandorcontrol', 'cmdorctrl', 'control', 'ctrl', 'command', 'cmd', 'meta'].includes(token)) {
      if (primary) return null
      primary = true
    } else if (token === 'shift') {
      if (shift) return null
      shift = true
    } else if (['alt', 'option'].includes(token)) {
      if (alt) return null
      alt = true
    } else return null
  }
  if (!primary || !shift) return null
  // Keep the global screenshot default and close/quit combinations available.
  if (['W', 'Q'].includes(key) || (!alt && key === '8')) return null
  return `CommandOrControl+${alt ? 'Alt+' : ''}Shift+${key}`
}

/** Missing or corrupt legacy values use the default; an empty value disables it. */
export function normalizeChatDictationShortcut(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_CHAT_DICTATION_SHORTCUT
  if (!value.trim()) return ''
  return canonicalShortcut(value) ?? DEFAULT_CHAT_DICTATION_SHORTCUT
}

function isMacPlatform(platform?: string) {
  const resolved = platform
    ?? (typeof window !== 'undefined' ? window.zsenseDesktop?.platform : undefined)
    ?? (typeof navigator !== 'undefined' ? navigator.platform : '')
  return /^(?:darwin|mac)/i.test(resolved)
}

function eventKey(event: ChatDictationShortcutEvent): string {
  if (event.code) {
    if (/^Key[A-Z]$/.test(event.code)) return event.code.slice(3)
    if (/^Digit[0-9]$/.test(event.code)) return event.code.slice(5)
    if (/^F(?:[1-9]|1[0-2])$/.test(event.code)) return event.code
    return ''
  }
  return /^(?:[a-z0-9]|F(?:[1-9]|1[0-2]))$/i.test(event.key) ? event.key.toUpperCase() : ''
}

export function eventToChatDictationShortcut(event: ChatDictationShortcutEvent, platform?: string): string {
  if (event.defaultPrevented || event.repeat || event.isComposing || event.keyCode === 229 || !event.shiftKey) return ''
  const mac = isMacPlatform(platform)
  if (mac ? !event.metaKey || event.ctrlKey : !event.ctrlKey || event.metaKey) return ''
  const key = eventKey(event)
  return key ? canonicalShortcut(`CommandOrControl+${event.altKey ? 'Alt+' : ''}Shift+${key}`) ?? '' : ''
}

export function matchesChatDictationShortcut(event: ChatDictationShortcutEvent, shortcut: unknown = DEFAULT_CHAT_DICTATION_SHORTCUT, platform?: string): boolean {
  const normalized = normalizeChatDictationShortcut(shortcut)
  return Boolean(normalized) && eventToChatDictationShortcut(event, platform) === normalized
}

export function readableChatDictationShortcut(value: unknown, platform?: string): string {
  const shortcut = normalizeChatDictationShortcut(value)
  if (!shortcut) return '已关闭'
  const mac = isMacPlatform(platform)
  return shortcut.replace('CommandOrControl', mac ? '⌘' : 'Ctrl')
    .replace('Alt', mac ? '⌥' : 'Alt').replace('Shift', mac ? '⇧' : 'Shift')
    .replaceAll('+', mac ? '' : ' + ')
}
