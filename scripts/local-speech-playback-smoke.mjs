import assert from 'node:assert/strict'
import vm from 'node:vm'
import { build } from 'esbuild'

// Exercise the real playback/IPC queue without a microphone, user data, model
// download, or audible output. Unlike source-marker smoke tests, these checks
// cover the cancellation and `ended` timing contract used by continuous voice.
const compiled = await build({
  entryPoints: [new URL('../src/services/local-speech.ts', import.meta.url).pathname],
  bundle: true, write: false, platform: 'browser', format: 'iife', globalName: 'VoiceUnderTest',
})
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const success = (data) => ({ ok: true, data })
const audio = (cancelled = false) => ({
  played: false, cancelled, provider: 'test local', language: 'zh-CN', voice: 'melo-zh',
  durationMs: 1, offline: true, audioBase64: cancelled ? '' : Buffer.from('test-wave').toString('base64'), audioMimeType: 'audio/wav',
})

function harness({ endDelayMs = 0, stopDelayMs = 0, generate } = {}) {
  const events = []
  const contexts = []
  const active = new Set()
  let stopCalls = 0
  let calls = 0
  class AudioContext {
    constructor() {
      this.state = 'running'
      this.createdAt = performance.now()
      this.destination = {}
      this.nodes = new Set()
      contexts.push(this)
    }
    get currentTime() { return (performance.now() - this.createdAt) / 1000 }
    async resume() { this.state = 'running' }
    async close() { this.state = 'closed'; events.push({ type: 'close', at: performance.now() }) }
    async decodeAudioData() { return { length: 640, duration: 0.04 } }
    createBufferSource() {
      const node = {
        buffer: null, handlers: [], timer: null, ended: false,
        connect() {}, disconnect() {},
        addEventListener(type, callback) { if (type === 'ended') this.handlers.push(callback) },
        start: (when) => {
          assert.equal(this.state, 'running', 'cannot schedule into a closed context')
          events.push({ type: 'start', at: performance.now() })
          node.timer = setTimeout(() => {
            node.ended = true
            events.push({ type: 'ended', at: performance.now() })
            node.handlers.forEach((callback) => callback())
          }, Math.max(0, (when + node.buffer.duration - this.currentTime) * 1000) + endDelayMs)
        },
        stop() { clearTimeout(this.timer); this.ended = true; events.push({ type: 'stop', at: performance.now() }) },
      }
      this.nodes.add(node)
      return node
    }
  }
  const voice = {
    listVoices: async () => success([{ id: 'melo-zh', name: 'Melo · 中文', language: 'zh-CN', gender: 'neutral', engine: 'melo-tts', local: true, bundled: true }]),
    stopSpeaking: async () => {
      stopCalls += 1
      events.push({ type: 'cancel-request', at: performance.now() })
      if (stopDelayMs) await delay(stopDelayMs)
      for (const job of active) job.resolve(success(audio(true)))
      active.clear()
      events.push({ type: 'cancel-ack', at: performance.now() })
      return success({ stopped: true })
    },
    synthesizeLocal: (request) => {
      calls += 1
      events.push({ type: 'synthesize', request, at: performance.now() })
      if (generate) return generate(request, calls, active)
      return Promise.resolve(success(audio()))
    },
  }
  const context = vm.createContext({
    window: { AudioContext, atob: (value) => Buffer.from(value, 'base64').toString('binary'), setTimeout, zsenseDesktop: { isDesktop: true, voice } },
    performance, Date, console, setTimeout, clearTimeout, Uint8Array,
  })
  vm.runInContext(compiled.outputFiles[0].text, context)
  return { api: context.VoiceUnderTest, events, contexts, active, get calls() { return calls }, get stopCalls() { return stopCalls } }
}

const playback = harness({ endDelayMs: 140 })
let started = 0
const stream = playback.api.createLocalSpeechStream({ language: 'zh-CN', voice: 'Xiaoyu', speed: 1 }, () => {
  assert(playback.events.some((event) => event.type === 'start'), 'speaking status must follow audio scheduling')
  started += 1
})
stream.push('你好。')
stream.push('这是第二句。')
const played = await stream.finish()
assert.equal(played.played, true)
assert.equal(played.voice, 'melo-zh', 'legacy voice selection must use the new fixed voice')
assert.equal(started, 1)
assert.equal(playback.calls, 2, 'sentences should be synthesized independently')
assert(playback.contexts.every((context) => context.state === 'closed'))
const lastEnd = playback.events.filter((event) => event.type === 'ended').at(-1).at
const closedAt = playback.events.find((event) => event.type === 'close').at
assert(closedAt - lastEnd >= 110, 'continuous listening must wait for actual ended and the speaker tail')
assert(playback.events.filter((event) => event.type === 'synthesize').every((event) => event.request.voice === 'melo-zh' && event.request.language === 'zh-CN'))

const supersede = harness({ stopDelayMs: 40, generate: (request, _calls, active) => {
  if (request.text === '旧回答。') return new Promise((resolve) => active.add({ resolve }))
  return Promise.resolve(success(audio()))
} })
const old = supersede.api.createLocalSpeechStream({ language: 'zh-CN' })
old.push('旧回答。')
const oldDone = old.finish()
for (let attempt = 0; !supersede.active.size && attempt < 100; attempt += 1) await delay(5)
assert.equal(supersede.active.size, 1, 'first native synthesis should be pending')
const next = supersede.api.createLocalSpeechStream({ language: 'zh-CN' })
next.push('新的回答。')
const stopCallsBeforeStaleCancel = supersede.stopCalls
old.cancel()
assert.equal(supersede.stopCalls, stopCallsBeforeStaleCancel, 'cancelling an old stream must not stop the new stream')
assert.equal((await next.finish()).played, true, 'a delayed cancellation must not kill the next request')
assert.equal((await oldDone).cancelled, true)
assert.equal(supersede.active.size, 0)
assert(supersede.contexts.every((context) => context.state === 'closed'))

const staleFinish = harness()
const bufferedOld = staleFinish.api.createLocalSpeechStream({ language: 'zh-CN' })
bufferedOld.push('尚未形成完整句子的旧内容')
const replacement = staleFinish.api.createLocalSpeechStream({ language: 'zh-CN' })
replacement.push('新的完整回答。')
assert.equal((await bufferedOld.finish()).cancelled, true, 'finishing a stale buffered stream must not steal the current AudioContext')
assert.equal((await replacement.finish()).played, true)
assert.equal(staleFinish.calls, 1, 'stale buffered text must never reach native synthesis')
assert(staleFinish.contexts.every((context) => context.state === 'closed'))

const recovery = harness({ generate: (_request, calls) => calls === 1 ? Promise.resolve({ ok: false, error: 'test synthesis failed' }) : Promise.resolve(success(audio())) })
await assert.rejects(recovery.api.speakLocalAudio({ text: '错误测试。', language: 'zh-CN' }), /test synthesis failed/)
assert(recovery.contexts.every((context) => context.state === 'closed'), 'failed synthesis must close playback')
assert.equal((await recovery.api.speakLocalAudio({ text: '恢复测试。', language: 'zh-CN' })).played, true)
assert.throws(() => recovery.api.createLocalSpeechStream({ language: 'en-US' }), /仅支持简体中文/)
await assert.rejects(recovery.api.speakLocalAudio({ text: '   ', language: 'zh-CN' }), /没有可播报/)
const empty = recovery.api.createLocalSpeechStream({ language: 'zh-CN' })
assert.equal((await empty.finish()).cancelled, true)
await recovery.api.stopLocalSpeech()

console.log(JSON.stringify({ ok: true, sentenceStreaming: true, playbackEndedBeforeClose: true, cancellationIsolation: true, delayedStopOrdered: true, errorRecovery: true, legacyVoiceMigration: true, noAudioOrUserDataUsed: true }))
