import { useCallback, useSyncExternalStore, type Dispatch, type SetStateAction } from 'react'
import type { ChatAttachment } from '../types'

interface ComposerDraft {
  text: string
  attachments: ChatAttachment[]
}

const emptyDraft: ComposerDraft = { text: '', attachments: [] }
const drafts = new Map<string, ComposerDraft>()
const listeners = new Map<string, Set<() => void>>()
const maxRetainedDrafts = 200

/** 听写插入当前光标或选区，保留已有内容和换行。 */
export function insertChatDictation(text: string, transcript: string, selectionStart = text.length, selectionEnd = selectionStart) {
  const start = Math.max(0, Math.min(text.length, Number.isFinite(selectionStart) ? Math.trunc(selectionStart) : text.length))
  const end = Math.max(start, Math.min(text.length, Number.isFinite(selectionEnd) ? Math.trunc(selectionEnd) : start))
  const insertion = transcript.trim()
  if (!insertion) return { text, caret: start }
  return { text: text.slice(0, start) + insertion + text.slice(end), caret: start + insertion.length }
}

export function chatComposerDraftKey(kind: 'native' | 'bot', conversationId: string | undefined, botId = '', resetToken = 0) {
  return `${kind}:${botId}:${conversationId || `new:${resetToken}`}`
}

export function readChatComposerDraft(key: string): ComposerDraft {
  return drafts.get(key) || emptyDraft
}

function emit(key: string) {
  for (const listener of listeners.get(key) || []) listener()
}

export function updateChatComposerDraft(key: string, change: (current: ComposerDraft) => ComposerDraft) {
  const current = readChatComposerDraft(key)
  const next = change(current)
  if (next.text === current.text && next.attachments === current.attachments) return
  if (next.text || next.attachments.length) {
    drafts.delete(key)
    drafts.set(key, next)
    while (drafts.size > maxRetainedDrafts) drafts.delete(drafts.keys().next().value!)
  } else drafts.delete(key)
  emit(key)
}

/** The first message turns a temporary "new chat" into a real conversation. Keep any text typed while it runs. */
export function moveChatComposerDraft(from: string, to: string) {
  if (from === to) return
  const source = drafts.get(from)
  if (!source) return
  if (!drafts.has(to)) drafts.set(to, source)
  drafts.delete(from)
  emit(from)
  emit(to)
}

function subscribe(key: string, listener: () => void) {
  const group = listeners.get(key) || new Set<() => void>()
  group.add(listener)
  listeners.set(key, group)
  return () => {
    group.delete(listener)
    if (!group.size) listeners.delete(key)
  }
}

/** Unsaved messages stay in memory only; credentials and attachments are never written to browser storage. */
export function useChatComposerDraft(key: string): [string, Dispatch<SetStateAction<string>>, ChatAttachment[], Dispatch<SetStateAction<ChatAttachment[]>>] {
  const subscribeToKey = useCallback((listener: () => void) => subscribe(key, listener), [key])
  const snapshot = useCallback(() => readChatComposerDraft(key), [key])
  const current = useSyncExternalStore(subscribeToKey, snapshot, () => emptyDraft)
  const setText = useCallback<Dispatch<SetStateAction<string>>>((value) => {
    updateChatComposerDraft(key, (draft) => ({ ...draft, text: typeof value === 'function' ? value(draft.text) : value }))
  }, [key])
  const setAttachments = useCallback<Dispatch<SetStateAction<ChatAttachment[]>>>((value) => {
    updateChatComposerDraft(key, (draft) => ({ ...draft, attachments: typeof value === 'function' ? value(draft.attachments) : value }))
  }, [key])
  return [current.text, setText, current.attachments, setAttachments]
}
