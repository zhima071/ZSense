import assert from 'node:assert/strict'
import { inspectVoiceWave, ZSenseVoiceService } from '../electron/services/zsense-voice-service.mjs'

function waveFixture() {
  const audio = Buffer.alloc(48)
  audio.write('RIFF', 0)
  audio.writeUInt32LE(40, 4)
  audio.write('WAVEfmt ', 8)
  audio.writeUInt32LE(16, 16)
  audio.writeUInt16LE(1, 20)
  audio.writeUInt16LE(1, 22)
  audio.writeUInt32LE(24_000, 24)
  audio.writeUInt32LE(48_000, 28)
  audio.writeUInt16LE(2, 32)
  audio.writeUInt16LE(16, 34)
  audio.write('data', 36)
  audio.writeUInt32LE(4, 40)
  audio.writeInt16LE(1_000, 44)
  return audio
}

const validWave = waveFixture()
assert.equal(inspectVoiceWave(validWave).sampleRate, 24_000)
for (const mutate of [
  (buffer) => buffer.write('NOPE', 0),
  (buffer) => buffer.writeUInt32LE(4_000, 4),
  (buffer) => buffer.writeUInt32LE(4_000, 40),
  (buffer) => buffer.writeUInt16LE(3, 20),
  (buffer) => buffer.writeUInt16LE(4, 22),
  (buffer) => buffer.writeUInt32LE(0, 24),
  (buffer) => buffer.writeUInt32LE(1, 28),
  (buffer) => buffer.writeUInt16LE(32, 34),
  (buffer) => buffer.fill(0, 44),
]) {
  const malformed = Buffer.from(validWave)
  mutate(malformed)
  assert.throws(() => inspectVoiceWave(malformed))
}
assert.throws(() => inspectVoiceWave(validWave.subarray(0, 47)))
assert.throws(() => inspectVoiceWave(Buffer.alloc(32 * 1024 * 1024 + 1)))
const service = new ZSenseVoiceService({ database: { loadSettings: () => ({}) }, toolsDirectory: '/missing-bundled-tools' })
try {
  for (const request of [null, [], { text: 123 }, { text: '  ' }, { text: '\u0000' }, { text: '中'.repeat(2_001) }, { text: '中文', language: 'en-US' }, { text: '中文', speed: '1' }, { text: '中文', speed: Infinity }, { text: '中文', speed: 0.49 }, { text: '中文', speed: 2.01 }]) await assert.rejects(service.synthesize(request))
  const first = service.synthesize({ text: '第一条' })
  const second = service.synthesize({ text: '第二条' })
  service.stopSpeaking()
  const cancelled = await Promise.all([first, second])
  assert(cancelled.every((result) => result.cancelled && !result.played && result.audioBase64 === '' && result.audioMimeType === 'audio/wav' && result.voice === 'melo-zh' && result.offline))
  await service.synthesisQueue
  assert.equal(service.activeSpeech, null)
  assert.equal(service.synthesisJobs.size, 0)
  await assert.rejects(service.synthesize({ text: '缺少模型不能回退到系统命令或网络。' }), /组件不完整/u)
  const queuedTranscriptions = Promise.allSettled([
    service.transcribe({ pcmBase64: '' }),
    service.transcribe({ pcmBase64: '' }),
  ])
  await service.shutdown()
  assert((await queuedTranscriptions).every((result) => result.status === 'rejected' && /已关闭/u.test(result.reason.message)))
  await assert.rejects(service.synthesize({ text: '已关闭' }), /已关闭/u)
  await assert.rejects(service.transcribe({ pcmBase64: '' }), /已关闭/u)
  console.log(JSON.stringify({ ok: true, wavStructureValidated: true, invalidRequestsRejected: true, queuedCancellation: true, noRuntimeFallback: true, shutdownRejectsNewSpeech: true }))
} finally {
  await service.shutdown()
}
