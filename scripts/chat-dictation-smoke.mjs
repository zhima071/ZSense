import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

// Run the real capture and component code against isolated WebAudio/IPC mocks.
// This test never requests a real microphone or invokes the bundled model.
const source = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const compile = (path) => ts.transpileModule(source(path), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText
const flush = async () => { for (let index = 0; index < 12; index += 1) await Promise.resolve() }
const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function environment() {
  const timers = new Map()
  const contexts = []
  const tracks = []
  const requests = []
  let now = 100_000
  let timerId = 0
  const window = new EventTarget()
  const document = new EventTarget()
  const listeners = new Map()
  for (const [surface, label] of [[window, 'window'], [document, 'document']]) {
    const add = surface.addEventListener.bind(surface)
    const remove = surface.removeEventListener.bind(surface)
    surface.addEventListener = (type, callback, options) => {
      const key = `${label}:${type}`
      if (!listeners.has(key)) listeners.set(key, new Set())
      listeners.get(key).add(callback)
      add(type, callback, options)
    }
    surface.removeEventListener = (type, callback, options) => {
      listeners.get(`${label}:${type}`)?.delete(callback)
      remove(type, callback, options)
    }
  }
  document.hidden = false
  const elements = []
  class Element {
    constructor(tag, className = '', parent = null, attributes = {}) {
      this.tagName = tag.toUpperCase()
      this.className = className
      this.parentElement = parent
      this.attributes = attributes
      this.isConnected = true
      this.hidden = false
      this.disabled = false
      this.style = { visibility: 'visible', display: 'block' }
      elements.push(this)
    }
    matches(selector) {
      return selector.split(',').some((item) => {
        const part = item.trim()
        if (part === 'form.chat-composer') return this.tagName === 'FORM' && this.className.split(' ').includes('chat-composer')
        if (part === '.chat-dictation-button') return this.className.split(' ').includes('chat-dictation-button')
        if (part === '[hidden]') return this.hidden
        if (part === '[inert]') return 'inert' in this.attributes
        if (part === 'dialog[open]') return this.tagName === 'DIALOG' && 'open' in this.attributes
        if (part === '[role="dialog"]:not([aria-modal="false"])') return this.attributes.role === 'dialog' && this.attributes['aria-modal'] !== 'false'
        const attribute = part.match(/^\[([^=]+)="([^"]+)"\]$/)
        if (attribute) return this.attributes[attribute[1]] === attribute[2]
        return this.tagName === part.toUpperCase()
      })
    }
    closest(selector) { for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node; return null }
    contains(element) { for (let node = element; node; node = node.parentElement) if (node === this) return true; return false }
    getClientRects() {
      for (let node = this; node; node = node.parentElement) if (node.hidden || node.style.display === 'none') return []
      return this.isConnected ? [{}] : []
    }
  }
  document.activeElement = new Element('body')
  document.querySelectorAll = (selector) => elements.filter((element) => element.matches(selector))
  window.getComputedStyle = (element) => element.style
  const env = { window, document, timers, contexts, tracks, requests, Element, listeners, failure: '', permission: null, resume: null, transcribe: null }
  const makeStream = () => {
    const track = { stopped: false, stop() { this.stopped = true } }
    tracks.push(track)
    return { getTracks: () => [track] }
  }
  env.makeStream = makeStream
  class AudioContext {
    constructor() {
      if (env.failure === 'constructor') throw new Error('模拟 AudioContext 初始化失败')
      this.sampleRate = 48_000
      this.state = env.resume || env.failure === 'resume' ? 'suspended' : 'running'
      this.destination = {}
      this.nodes = []
      this.closed = false
      contexts.push(this)
    }
    node(kind) {
      if (env.failure === kind) throw new Error(`模拟 ${kind} 初始化失败`)
      const node = {
        disconnected: false,
        gain: { value: 1 },
        connect() { if (env.failure === 'connect') throw new Error('模拟连接失败') },
        disconnect() { this.disconnected = true },
      }
      this.nodes.push(node)
      return node
    }
    createMediaStreamSource() { return this.node('source') }
    createScriptProcessor() { this.processor = this.node('processor'); return this.processor }
    createGain() { return this.node('gain') }
    async resume() {
      if (env.failure === 'resume') throw new Error('模拟恢复失败')
      if (env.resume) await env.resume
      this.state = 'running'
    }
    async close() { this.closed = true }
  }
  window.AudioContext = AudioContext
  window.setTimeout = (callback, delay) => { timers.set(++timerId, { callback, delay }); return timerId }
  window.clearTimeout = (id) => timers.delete(id)
  window.zsenseDesktop = {
    voice: {
      async transcribeLocal(request) {
        requests.push(request)
        if (env.transcribe) return env.transcribe(request)
        return { ok: true, data: { transcript: '这是一段中文听写', confidence: 0.9, provider: 'bundled-whisper', offline: true } }
      },
    },
  }
  const navigator = {
    platform: 'Win32',
    mediaDevices: {
      async getUserMedia() {
        if (env.permission instanceof Error) throw env.permission
        if (env.permission) return env.permission
        return makeStream()
      },
    },
  }
  class CustomEvent extends Event {
    constructor(type, options) { super(type); this.detail = options.detail }
  }
  class Clock extends Date { static now() { return now } }
  const globals = { window, document, navigator, Element, AbortController, Error, Date: Clock, CustomEvent, btoa: (value) => Buffer.from(value, 'latin1').toString('base64') }
  const load = (code, require) => {
    const module = { exports: {} }
    vm.runInNewContext(code, { ...globals, module, exports: module.exports, require })
    return module.exports
  }
  const voice = load(compile('src/services/voice-wake.ts'), (name) => {
    assert.equal(name, './voice-language')
    return { VOICE_LANGUAGE: 'zh-CN' }
  })
  env.voice = voice
  env.load = load
  env.shortcut = load(compile('src/services/chat-dictation-shortcut.ts'), (name) => { throw new Error(`Unexpected shortcut import: ${name}`) })
  env.keydown = (target = document.activeElement, options = {}) => {
    const event = new Event('keydown', { cancelable: true })
    Object.assign(event, { key: 'M', code: 'KeyM', ctrlKey: true, metaKey: false, shiftKey: true, altKey: false, repeat: false, isComposing: false, ...options })
    Object.defineProperty(event, 'target', { value: target })
    if (options.prevented) event.preventDefault()
    window.dispatchEvent(event)
    return event
  }
  env.emit = (amplitude = 0.2, durationMs = 100) => {
    now += durationMs
    const samples = new Float32Array(Math.round(48_000 * durationMs / 1000)).fill(amplitude)
    for (const context of contexts) context.processor?.onaudioprocess?.({ inputBuffer: { getChannelData: () => samples } })
  }
  env.speech = () => { env.emit(); env.emit() }
  env.expire = () => {
    const [id, timer] = timers.entries().next().value
    timers.delete(id)
    now += timer.delay
    timer.callback()
  }
  env.assertClean = () => {
    assert(tracks.every((track) => track.stopped), '所有麦克风轨道均应停止')
    assert(contexts.every((context) => context.closed), '所有 AudioContext 均应关闭')
    assert(contexts.every((context) => context.nodes.every((node) => node.disconnected)), '所有已创建音频节点均应断开')
    assert.equal(timers.size, 0, '录音定时器均应清理')
  }
  return env
}

// Hook runner: effects, cleanup, refs and state exercise component lifecycle
// without mounting a browser or opening any native application.
function components(env) {
  let rendering
  const hooks = {
    useState(value) {
      const renderer = rendering
      const index = renderer.cursor++
      renderer.hooks[index] ||= { kind: 'state', value: typeof value === 'function' ? value() : value }
      const hook = renderer.hooks[index]
      return [hook.value, (next) => { hook.value = typeof next === 'function' ? next(hook.value) : next }]
    },
    useRef(value) {
      const index = rendering.cursor++
      rendering.hooks[index] ||= { kind: 'ref', value: { current: value } }
      return rendering.hooks[index].value
    },
    useCallback(callback, deps) {
      const index = rendering.cursor++
      const previous = rendering.hooks[index]
      if (!previous || deps.some((dep, offset) => dep !== previous.deps[offset])) rendering.hooks[index] = { kind: 'callback', callback, deps }
      return rendering.hooks[index].callback
    },
    effect(callback, deps) {
      const renderer = rendering
      const index = renderer.cursor++
      const previous = renderer.hooks[index]
      if (!previous || deps.some((dep, offset) => dep !== previous.deps[offset])) {
        renderer.pending.push(() => {
          previous?.cleanup?.()
          renderer.hooks[index] = { kind: 'effect', deps, cleanup: callback() }
        })
      }
    },
  }
  hooks.useEffect = hooks.effect
  hooks.useLayoutEffect = hooks.effect
  const component = env.load(compile('src/components/ChatDictationButton.tsx'), (name) => {
    if (name === 'react') return hooks
    if (name === 'react/jsx-runtime') return { jsx: (type, props) => ({ type, props }) }
    if (name === 'lucide-react') return { Mic: 'Mic', LoaderCircle: 'LoaderCircle' }
    if (name === '../services/voice-wake') return env.voice
    if (name === '../services/chat-dictation-shortcut') return env.shortcut
    if (name === '../services/voice-language') return { VOICE_LANGUAGE: 'zh-CN' }
    throw new Error(`Unexpected import: ${name}`)
  })
  const activity = []
  env.window.addEventListener(component.CHAT_DICTATION_ACTIVITY_EVENT, (event) => activity.push(event.detail.active))
  return {
    activity,
    renderer(initialProps = {}, parent = null) {
      const delivered = []
      const errors = []
      const form = new env.Element('form', 'chat-composer', parent)
      const textarea = new env.Element('textarea', '', form)
      const element = new env.Element('button', 'chat-dictation-button', form)
      const renderer = {
        cursor: 0, hooks: [], pending: [], delivered, errors, form, textarea, element,
        props: { contextKey: 'conversation-first', onTranscript: (text) => delivered.push(text), onError: (error) => errors.push(error), ...initialProps },
        render(overrides = {}) {
          this.props = { ...this.props, ...overrides }
          this.cursor = 0
          rendering = this
          this.button = component.ChatDictationButton(this.props)
          this.button.props.ref.current = element
          element.disabled = this.button.props.disabled
          rendering = null
          for (const effect of this.pending.splice(0)) effect()
          return this.button
        },
        click() { this.render().props.onClick(); return this.render() },
        unmount() { element.isConnected = false; for (const hook of this.hooks) if (hook.kind === 'effect') hook.cleanup?.() },
      }
      renderer.render()
      return renderer
    },
  }
}

{
  const env = environment()
  const capture = env.voice.startVoiceTextCapture({ manualStop: true })
  await flush()
  env.speech()
  env.emit(0, 1_000)
  assert.equal(env.requests.length, 0, '听写停顿不能自动转写')
  assert.equal(capture.active, true)
  capture.stop()
  const result = await capture.result
  assert.equal(result.transcript, '这是一段中文听写')
  assert.equal(env.requests[0].language, 'zh-CN')
  assert.equal(env.requests[0].mode, 'conversation')
  assert.equal(env.requests[0].sampleRate, 16_000)
  assert.equal(capture.active, false)
  env.assertClean()
}
{
  const env = environment()
  const capture = env.voice.startVoiceTextCapture()
  await flush()
  env.speech()
  env.emit(0, 1_000)
  await capture.result
  assert.equal(env.requests.length, 1, '原语音会话仍应静音自动结束')
  env.assertClean()
}
{
  const env = environment()
  const capture = env.voice.startVoiceTextCapture({ manualStop: true, timeoutMs: 120_000 })
  const rejected = assert.rejects(capture.result, { name: 'AbortError' })
  assert.equal([...env.timers.values()][0].delay, 35_000, '听写上限应符合本地后端的35秒限制')
  await flush()
  env.speech()
  capture.cancel()
  await rejected
  assert.equal(env.requests.length, 0, '取消不得提交音频')
  env.assertClean()
}
{
  const env = environment()
  const permission = deferred()
  env.permission = permission.promise
  const capture = env.voice.startVoiceTextCapture({ manualStop: true })
  const rejected = assert.rejects(capture.result, { name: 'AbortError' })
  capture.cancel()
  await rejected
  permission.resolve(env.makeStream())
  await flush()
  assert.equal(env.contexts.length, 0, '权限迟到时应直接停止轨道，不再创建AudioContext')
  env.assertClean()
}
{
  const env = environment()
  const permission = deferred()
  env.permission = permission.promise
  const capture = env.voice.startVoiceTextCapture({ manualStop: true })
  const rejected = assert.rejects(capture.result, /没有检测到语音/)
  capture.stop()
  await rejected
  permission.resolve(env.makeStream())
  await flush()
  assert.equal(env.requests.length, 0)
  env.assertClean()
}
{
  const env = environment()
  const resuming = deferred()
  env.resume = resuming.promise
  const capture = env.voice.startVoiceTextCapture({ manualStop: true })
  const rejected = assert.rejects(capture.result, { name: 'AbortError' })
  await flush()
  capture.cancel()
  await rejected
  env.assertClean()
  resuming.resolve()
  await flush()
  env.assertClean()
}
for (const failure of ['constructor', 'source', 'processor', 'gain', 'connect', 'resume']) {
  const env = environment()
  env.failure = failure
  await assert.rejects(env.voice.startVoiceTextCapture({ manualStop: true }).result, /模拟/)
  env.assertClean()
}
for (const speech of [false, true]) {
  const env = environment()
  const capture = env.voice.startVoiceTextCapture({ manualStop: true })
  const finished = speech ? capture.result : assert.rejects(capture.result, /没有检测到语音/)
  await flush()
  if (speech) env.speech()
  env.expire()
  await finished
  assert.equal(env.requests.length, speech ? 1 : 0)
  env.assertClean()
}
{
  const env = environment()
  env.transcribe = async () => ({ ok: true, data: { transcript: '  ', confidence: 0, provider: 'mock' } })
  const capture = env.voice.startVoiceTextCapture({ manualStop: true })
  const rejected = assert.rejects(capture.result, /没有识别到完整语音/)
  await flush()
  env.speech()
  capture.stop()
  await rejected
  env.assertClean()
}
{
  const env = environment()
  const ui = components(env)
  const button = ui.renderer()
  assert.equal(button.button.props.type, 'button', '听写按钮不能提交表单')
  assert.match(button.button.props.title, /中文听写.*本地 Whisper.*35 秒/)
  assert.equal(button.click().props['aria-pressed'], true)
  assert.deepEqual(ui.activity, [true], '录音开始应同步暂停唤醒')
  await flush()
  env.speech()
  assert.match(button.click().props.className, /is-transcribing/)
  assert.equal(button.button.props.disabled, true)
  await flush()
  assert.deepEqual(button.delivered, ['这是一段中文听写'])
  assert.deepEqual(button.errors, [])
  assert.deepEqual(ui.activity, [true, false])
  assert.equal(button.render().props['aria-pressed'], false)
  button.unmount()
  assert.deepEqual(ui.activity, [true, false], '卸载不得重复解除其他录音')
  env.assertClean()
}
for (const cancellation of ['context', 'disabled', 'blur', 'hidden', 'unmount']) {
  const env = environment()
  const ui = components(env)
  const button = ui.renderer()
  const transcription = deferred()
  env.transcribe = () => transcription.promise
  button.click()
  await flush()
  env.speech()
  button.click()
  await flush()
  if (cancellation === 'context') button.render({ contextKey: 'conversation-next' })
  if (cancellation === 'disabled') button.render({ disabled: true })
  if (cancellation === 'blur') env.window.dispatchEvent(new Event('blur'))
  if (cancellation === 'hidden') { env.document.hidden = true; env.document.dispatchEvent(new Event('visibilitychange')) }
  if (cancellation === 'unmount') button.unmount()
  transcription.resolve({ ok: true, data: { transcript: '迟到的旧会话文字', confidence: 1, provider: 'mock' } })
  await flush()
  assert.deepEqual(button.delivered, [], `${cancellation}取消后迟到的识别不能写入草稿`)
  assert.deepEqual(button.errors, [])
  assert.deepEqual(ui.activity, [true, false])
  button.unmount()
  env.assertClean()
}
{
  const env = environment()
  const ui = components(env)
  const first = ui.renderer()
  const second = ui.renderer({ contextKey: 'conversation-second' })
  const oldTranscription = deferred()
  env.transcribe = () => oldTranscription.promise
  first.click()
  await flush()
  env.speech()
  first.click()
  await flush()
  second.click()
  await flush()
  oldTranscription.resolve({ ok: true, data: { transcript: '旧听写', confidence: 1, provider: 'mock' } })
  await flush()
  assert.deepEqual(first.delivered, [])
  assert.deepEqual(ui.activity, [true, false, true], '旧转写结束不能恢复当前听写期间的唤醒')
  assert.equal(env.tracks.filter((track) => !track.stopped).length, 1, '同一renderer最多一组听写轨道')
  second.unmount()
  first.unmount()
  assert.deepEqual(ui.activity, [true, false, true, false])
  env.assertClean()
}
{
  const env = environment()
  const ui = components(env)
  const button = ui.renderer()
  env.permission = Object.assign(new Error('permission denied'), { name: 'NotAllowedError' })
  button.click()
  await flush()
  assert.match(button.errors[0], /麦克风权限未开启/)
  assert.deepEqual(ui.activity, [true, false])
  button.unmount()
  env.assertClean()
}
{
  const env = environment()
  const ui = components(env)
  const button = ui.renderer()
  env.transcribe = async () => ({ ok: false, error: '本地 Whisper 模型暂时不可用' })
  button.click()
  await flush()
  env.speech()
  button.click()
  await flush()
  assert.deepEqual(button.delivered, [])
  assert.match(button.errors[0], /本地 Whisper 模型暂时不可用/)
  assert.deepEqual(ui.activity, [true, false], '本地识别失败后应恢复唤醒')
  button.unmount()
  env.assertClean()
}
{
  const env = environment()
  const ui = components(env)
  const button = ui.renderer()
  delete env.window.zsenseDesktop.voice.transcribeLocal
  button.click()
  assert.match(button.errors[0], /缺少本地 Whisper/)
  assert.deepEqual(ui.activity, [], '缺少本地组件时不得开始录音')
  assert.equal(env.tracks.length, 0)
  button.unmount()
  env.assertClean()
}

{
  const env = environment()
  const ui = components(env)
  const button = ui.renderer()
  const transcription = deferred()
  env.transcribe = () => transcription.promise
  assert.match(button.button.props.title, /快捷键：Ctrl \+ Shift \+ M/)
  assert.equal(env.keydown(button.textarea).defaultPrevented, true, '快捷键应开始当前输入区听写')
  assert.equal(button.render().props['aria-pressed'], true)
  await flush()
  env.speech()
  assert.equal(env.keydown(button.textarea).defaultPrevented, true, '再次快捷键应停止录音并转写')
  assert.match(button.render().props.className, /is-transcribing/)
  assert.equal(env.keydown(button.textarea).defaultPrevented, false, '转写期间快捷键应忽略')
  transcription.resolve({ ok: true, data: { transcript: '快捷键听写内容', confidence: 1, provider: 'mock' } })
  await flush()
  assert.deepEqual(button.delivered, ['快捷键听写内容'])
  assert.deepEqual(ui.activity, [true, false])
  button.unmount()
  env.assertClean()
}
for (const ignored of [{ repeat: true }, { isComposing: true }, { keyCode: 229 }, { prevented: true }, { altKey: true }, { shiftKey: false }, { ctrlKey: false, metaKey: true }]) {
  const env = environment()
  const ui = components(env)
  const button = ui.renderer()
  const event = env.keydown(button.textarea, ignored)
  assert.equal(event.defaultPrevented, Boolean(ignored.prevented))
  assert.deepEqual(ui.activity, [], '重复、IME、已处理或不准确的快捷键不得开始听写')
  assert.equal(env.tracks.length, 0)
  button.unmount()
  env.assertClean()
}
{
  const env = environment()
  const ui = components(env)
  const button = ui.renderer({ shortcut: '' })
  assert.equal(env.keydown(button.textarea).defaultPrevented, false, '关闭快捷键后不应拦截默认组合')
  assert(!button.button.props.title.includes('快捷键：'))
  button.render({ shortcut: 'CommandOrControl+Shift+K' })
  assert.equal(env.keydown(button.textarea).defaultPrevented, false, '修改后旧快捷键解绑')
  assert.equal(env.keydown(button.textarea, { key: 'K', code: 'KeyK' }).defaultPrevented, true)
  assert.equal(env.listeners.get('window:keydown').size, 1, '修改快捷键不能叠加监听器')
  await flush()
  button.unmount()
  assert.equal(env.listeners.get('window:keydown').size, 0)
  assert.equal(env.listeners.get('window:blur').size, 0)
  assert.equal(env.listeners.get('document:visibilitychange').size, 0)
  assert.equal(env.keydown(button.textarea, { key: 'K', code: 'KeyK' }).defaultPrevented, false, '卸载后不能响应快捷键')
  await flush()
  env.assertClean()
}
for (const unavailable of ['disabled', 'hidden', 'inert', 'foreign-textarea', 'settings-recording', 'foreign-modal']) {
  const env = environment()
  const ui = components(env)
  const button = ui.renderer({ disabled: unavailable === 'disabled' })
  let target = button.textarea
  if (unavailable === 'hidden') button.element.hidden = true
  if (unavailable === 'inert') button.form.attributes.inert = ''
  if (unavailable === 'foreign-textarea') target = new env.Element('textarea')
  if (unavailable === 'settings-recording') target = new env.Element('input', '', null, { 'data-chat-dictation-shortcut-recording': 'true' })
  if (unavailable === 'foreign-modal') new env.Element('section', '', null, { role: 'dialog', 'aria-modal': 'true' })
  assert.equal(env.keydown(target).defaultPrevented, false, `${unavailable}状态不得拦截快捷键`)
  assert.deepEqual(ui.activity, [])
  button.unmount()
  env.assertClean()
}
{
  const env = environment()
  const ui = components(env)
  const native = ui.renderer()
  const dialog = new env.Element('section', '', null, { role: 'dialog', 'aria-modal': 'true' })
  const bot = ui.renderer({ contextKey: 'bot-dialog' }, dialog)
  assert.equal(env.keydown(native.textarea).defaultPrevented, false, 'Bot弹窗存在时不能响应底层Native输入区')
  assert.equal(env.keydown(bot.textarea).defaultPrevented, true)
  assert.deepEqual(ui.activity, [true], '同一快捷键只能触发顶层Bot弹窗')
  await flush()
  assert.equal(env.tracks.filter((track) => !track.stopped).length, 1)
  bot.unmount()
  native.unmount()
  await flush()
  env.assertClean()
}
{
  const env = environment()
  const ui = components(env)
  const first = ui.renderer()
  const second = ui.renderer({ contextKey: 'second-visible-chat' })
  assert.equal(env.keydown(first.textarea).defaultPrevented, true)
  assert.equal(first.render().props['aria-pressed'], true)
  assert.equal(second.render().props['aria-pressed'], false, '另一输入区不能抢当前textarea的快捷键')
  await flush()
  env.window.dispatchEvent(new Event('blur'))
  env.keydown()
  assert.equal(first.render().props['aria-pressed'], false)
  assert.equal(second.render().props['aria-pressed'], true, '没有输入焦点时只响应最上层可见输入区')
  await flush()
  first.unmount()
  second.unmount()
  await flush()
  env.assertClean()
}
for (const phase of ['recording', 'transcribing']) {
  const env = environment()
  const ui = components(env)
  const button = ui.renderer({ shortcut: '' })
  const transcription = deferred()
  env.transcribe = () => transcription.promise
  button.click()
  await flush()
  if (phase === 'transcribing') { env.speech(); button.click(); await flush() }
  assert.equal(env.keydown(button.textarea, { key: 'Escape', code: 'Escape', ctrlKey: false, shiftKey: false, repeat: true }).defaultPrevented, false)
  assert.equal(env.keydown(button.textarea, { key: 'Escape', code: 'Escape', ctrlKey: false, shiftKey: false }).defaultPrevented, true, 'Esc应取消录音或迟到转写，即使已关闭快捷键')
  assert.equal(button.render().props['aria-pressed'], false)
  transcription.resolve({ ok: true, data: { transcript: 'Esc取消后的迟到文字', confidence: 1, provider: 'mock' } })
  await flush()
  assert.deepEqual(button.delivered, [])
  assert.deepEqual(button.errors, [])
  assert.deepEqual(ui.activity, [true, false])
  button.unmount()
  env.assertClean()
}

console.log(JSON.stringify({ ok: true, localChineseDictation: true, manualFinishAndCancel: true, existingSilenceFinish: true, boundedDuration: true, emptyAudioRejected: true, permissionAndInitializationCleanup: true, contextAndVisibilityCancellation: true, lateTranscriptIsolation: true, singleRendererOwner: true, wakeActivityLifecycle: true, customizableShortcutStartAndStop: true, preciseShortcutAndImeGuards: true, activeComposerAndModalScope: true, shortcutListenerCleanup: true, escapeCancelsRecordingAndTranscription: true, noRealMicrophoneOrModel: true }))
