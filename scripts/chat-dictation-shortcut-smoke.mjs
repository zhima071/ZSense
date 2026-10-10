// Pure key events and a disposable SQLite database; no microphone or user data.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'
import { ZSenseDatabase } from '../electron/services/database.mjs'
import {
  DEFAULT_CHAT_DICTATION_SHORTCUT,
  eventToChatDictationShortcut,
  matchesChatDictationShortcut,
  normalizeChatDictationShortcut,
  readableChatDictationShortcut,
} from '../src/services/chat-dictation-shortcut.ts'

const windowsKey = (changes = {}) => ({ key: 'M', code: 'KeyM', ctrlKey: true, metaKey: false, shiftKey: true, altKey: false, ...changes })
const macKey = (changes = {}) => windowsKey({ ctrlKey: false, metaKey: true, ...changes })
const validValues = [
  ['', ''],
  ['  ', ''],
  ['Ctrl+Shift+m', DEFAULT_CHAT_DICTATION_SHORTCUT],
  [' Shift + Cmd + Alt + F12 ', 'CommandOrControl+Alt+Shift+F12'],
  ['CommandOrControl+Shift+4', 'CommandOrControl+Shift+4'],
  ['CommandOrControl+Alt+Shift+8', 'CommandOrControl+Alt+Shift+8'],
]
const invalidValues = [
  null, false, 12, {}, 'M', 'Shift+M', 'Ctrl+M', 'Ctrl+Alt+M',
  'Ctrl+Meta+Shift+M', 'Ctrl+Shift+Shift+M', 'Ctrl+Shift+M+M',
  'Ctrl+Shift+F13', 'Ctrl+Shift+ArrowUp', 'Ctrl+Shift+Numpad4',
  'Ctrl+Shift+8', 'Cmd+Shift+W', 'Cmd+Shift+Q', 'Cmd+Alt+Shift+Q', 'Ctrl+Alt+Shift+W',
]

assert.equal(DEFAULT_CHAT_DICTATION_SHORTCUT, 'CommandOrControl+Shift+M')
assert.equal(normalizeChatDictationShortcut(undefined), DEFAULT_CHAT_DICTATION_SHORTCUT)
for (const [value, expected] of validValues) assert.equal(normalizeChatDictationShortcut(value), expected)
for (const value of invalidValues) assert.equal(normalizeChatDictationShortcut(value), DEFAULT_CHAT_DICTATION_SHORTCUT)

for (const platform of ['win32', 'linux']) {
  assert.equal(matchesChatDictationShortcut(windowsKey(), DEFAULT_CHAT_DICTATION_SHORTCUT, platform), true)
  assert.equal(matchesChatDictationShortcut(macKey(), DEFAULT_CHAT_DICTATION_SHORTCUT, platform), false)
  assert.equal(eventToChatDictationShortcut(windowsKey({ code: 'Digit4', key: '$' }), platform), 'CommandOrControl+Shift+4')
}
assert.equal(matchesChatDictationShortcut(macKey(), DEFAULT_CHAT_DICTATION_SHORTCUT, 'darwin'), true)
assert.equal(matchesChatDictationShortcut(macKey(), DEFAULT_CHAT_DICTATION_SHORTCUT, 'MacIntel'), true)
assert.equal(matchesChatDictationShortcut(windowsKey(), DEFAULT_CHAT_DICTATION_SHORTCUT, 'darwin'), false)
assert.equal(matchesChatDictationShortcut(macKey({ altKey: true }), 'CommandOrControl+Alt+Shift+M', 'darwin'), true)
assert.equal(matchesChatDictationShortcut(macKey({ altKey: true }), DEFAULT_CHAT_DICTATION_SHORTCUT, 'darwin'), false)
assert.equal(matchesChatDictationShortcut(macKey(), 'CommandOrControl+Alt+Shift+M', 'darwin'), false)
assert.equal(matchesChatDictationShortcut(windowsKey(), '', 'win32'), false)
assert.equal(matchesChatDictationShortcut(windowsKey(), undefined, 'win32'), true, 'legacy missing value uses default')

for (const changes of [
  { ctrlKey: false }, { shiftKey: false }, { metaKey: true }, { altKey: true },
  { repeat: true }, { isComposing: true }, { keyCode: 229 }, { defaultPrevented: true },
  { code: 'Numpad4', key: '4' }, { code: 'F13', key: 'F13' },
]) assert.equal(matchesChatDictationShortcut(windowsKey(changes), DEFAULT_CHAT_DICTATION_SHORTCUT, 'win32'), false)
assert.equal(eventToChatDictationShortcut(windowsKey({ code: '', key: 'm' }), 'win32'), DEFAULT_CHAT_DICTATION_SHORTCUT)
assert.equal(eventToChatDictationShortcut(windowsKey({ code: 'KeyQ', key: 'Q', altKey: true }), 'win32'), '')
assert.equal(eventToChatDictationShortcut(macKey({ ctrlKey: true }), 'darwin'), '')
assert.equal(eventToChatDictationShortcut(macKey({ code: 'F12', key: 'F12' }), 'darwin'), 'CommandOrControl+Shift+F12')
assert.equal(readableChatDictationShortcut(undefined, 'darwin'), '⌘⇧M')
assert.equal(readableChatDictationShortcut(undefined, 'win32'), 'Ctrl + Shift + M')
assert.equal(readableChatDictationShortcut('CommandOrControl+Alt+Shift+F12', 'darwin'), '⌘⌥⇧F12')
assert.equal(readableChatDictationShortcut('', 'win32'), '已关闭')

// Render the setting with deterministic hooks so recording handlers run without a DOM.
const hookValues = []
let hookIndex = 0
let selected = DEFAULT_CHAT_DICTATION_SHORTCUT
const jsx = (type, props) => ({ type, props })
const componentModule = { exports: {} }
const compiled = ts.transpileModule(fs.readFileSync(new URL('../src/components/ChatDictationShortcutSetting.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText
vm.runInNewContext(compiled, {
  module: componentModule,
  exports: componentModule.exports,
  window: { zsenseDesktop: { platform: 'darwin' } },
  require(name) {
    if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx }
    if (name === 'lucide-react') return { Keyboard: 'Keyboard' }
    if (name === 'react') return { useState(initial) {
      const index = hookIndex++
      if (!(index in hookValues)) hookValues[index] = initial
      return [hookValues[index], (value) => { hookValues[index] = typeof value === 'function' ? value(hookValues[index]) : value }]
    } }
    if (name === '../services/chat-dictation-shortcut') return { DEFAULT_CHAT_DICTATION_SHORTCUT, eventToChatDictationShortcut, normalizeChatDictationShortcut, readableChatDictationShortcut }
    throw new Error(`Unexpected UI dependency: ${name}`)
  },
})
const renderSetting = () => {
  hookIndex = 0
  return componentModule.exports.ChatDictationShortcutSetting({ value: selected, onChange(value) { selected = value } })
}
const nodes = (node) => {
  if (Array.isArray(node)) return node.flatMap(nodes)
  if (!node || typeof node !== 'object') return []
  return [node, ...nodes(node.props?.children)]
}
const settingControl = (predicate) => nodes(renderSetting()).find(predicate)
const startRecording = () => settingControl((node) => node.props?.className === 'global-screenshot-key').props.onClick()
const recordingInput = () => settingControl((node) => node.props?.['data-chat-dictation-shortcut-recording'] === 'true')
const recordedKey = (changes = {}) => {
  const nativeEvent = macKey({ repeat: false, ...changes })
  const event = { ...nativeEvent, nativeEvent, prevented: false, stopped: false,
    preventDefault() { this.prevented = true; nativeEvent.defaultPrevented = true },
    stopPropagation() { this.stopped = true },
  }
  recordingInput().props.onKeyDown(event)
  return event
}
startRecording()
const plainKey = recordedKey({ key: 'a', code: 'KeyA', metaKey: false, shiftKey: false })
assert.equal(plainKey.prevented, false, 'recording must not swallow ordinary typing')
assert.equal(plainKey.stopped, false)
assert.equal(Boolean(recordingInput()), true)
for (const changes of [{ repeat: true }, { isComposing: true }, { keyCode: 229 }]) {
  const ignored = recordedKey(changes)
  assert.equal(ignored.prevented, false)
  assert.equal(Boolean(recordingInput()), true, 'IME and repeats must not complete recording')
  assert.equal(selected, DEFAULT_CHAT_DICTATION_SHORTCUT)
}
const escape = recordedKey({ key: 'Escape', code: 'Escape', metaKey: false, shiftKey: false })
assert.equal(escape.prevented && escape.stopped, true)
assert.equal(recordingInput(), undefined, 'Escape exits recording')
startRecording()
const reserved = recordedKey({ key: '8', code: 'Digit8' })
assert.equal(reserved.prevented && reserved.stopped, true)
assert.equal(selected, DEFAULT_CHAT_DICTATION_SHORTCUT)
assert.equal(Boolean(recordingInput()), true, 'reserved screenshot shortcut is not recorded')
const recorded = recordedKey({ key: 'F12', code: 'F12', altKey: true })
assert.equal(recorded.prevented && recorded.stopped, true)
assert.equal(selected, 'CommandOrControl+Alt+Shift+F12')
assert.equal(recordingInput(), undefined)
settingControl((node) => node.props?.children === '关闭快捷键').props.onClick()
assert.equal(selected, '')
settingControl((node) => node.props?.children === '恢复默认').props.onClick()
assert.equal(selected, DEFAULT_CHAT_DICTATION_SHORTCUT)

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zsense-dictation-shortcut-'))
let database = new ZSenseDatabase(directory)
try {
  assert.equal(database.loadWorkspace().settings.chatDictationShortcut, DEFAULT_CHAT_DICTATION_SHORTCUT)
  for (const [value, expected] of validValues) {
    assert.equal(database.updateSettings({ chatDictationShortcut: value }).settings.chatDictationShortcut, expected)
    assert.equal(database.getSetting('chatDictationShortcut'), expected)
  }
  for (const value of invalidValues) assert.throws(() => database.updateSettings({ chatDictationShortcut: value }), /听写快捷键/)

  database.updateSettings({ chatDictationShortcut: 'Ctrl+Alt+Shift+F12' })
  assert.equal(database.updateSettings({ chatDictationShortcut: undefined, showUsage: false }).settings.chatDictationShortcut, 'CommandOrControl+Alt+Shift+F12')
  const before = database.loadWorkspace().settings.showUsage
  assert.throws(() => database.updateSettings({ showUsage: !before, chatDictationShortcut: 'Ctrl+M' }), /听写快捷键/)
  assert.equal(database.loadWorkspace().settings.showUsage, before, 'invalid shortcut rolls back the whole settings save')

  database.updateSettings({ chatDictationShortcut: '' })
  database.close()
  database = new ZSenseDatabase(directory)
  assert.equal(database.loadWorkspace().settings.chatDictationShortcut, '', 'disabled shortcut survives restart')

  for (const value of invalidValues) {
    database.db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('chatDictationShortcut', JSON.stringify(value))
    assert.equal(database.loadWorkspace().settings.chatDictationShortcut, DEFAULT_CHAT_DICTATION_SHORTCUT, 'corrupt stored shortcut uses safe default')
  }
  database.db.prepare("DELETE FROM settings WHERE key='chatDictationShortcut'").run()
  assert.equal(database.loadWorkspace().settings.chatDictationShortcut, DEFAULT_CHAT_DICTATION_SHORTCUT, 'older database requires no migration')
  assert.equal(database.updateSettings({ showUsage: true }).settings.chatDictationShortcut, DEFAULT_CHAT_DICTATION_SHORTCUT)
} finally {
  database.close()
  fs.rmSync(directory, { recursive: true, force: true })
}

console.log(JSON.stringify({ ok: true, normalization: true, exactModifiers: true, macWindows: true, imeAndRepeat: true, recordingControls: true, disabledPersistence: true, legacySettings: true }))
