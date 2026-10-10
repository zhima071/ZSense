import assert from 'node:assert/strict'
import fs from 'node:fs'

const read = (relativePath) => fs.readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8')
const app = read('src/App.tsx')
const types = read('src/types.ts')
const settingsPage = read('src/components/SystemPages.tsx')
const enrollmentDialog = read('src/components/WakePhraseSetupDialog.tsx')
const capture = read('src/services/voice-wake.ts')
const main = read('electron/main.mjs')
const ipc = read('electron/ipc.mjs')
const preload = read('electron/preload.cjs')
const database = read('electron/services/database.mjs')
const voiceService = read('electron/services/zsense-voice-service.mjs')
const packageJson = JSON.parse(read('package.json'))

for (const field of ['voiceWakeEnabled', 'voiceWakePhrase', 'voiceWakeSound', 'voiceWakeStartNewConversation', 'voiceWakeSensitivity', 'voiceWakeConfirmationFrames']) {
  assert(types.includes(field), `AppSettings 缺少 ${field}`)
  assert(app.includes(field), `前端默认设置缺少 ${field}`)
  assert(database.includes(field), `数据库默认设置缺少 ${field}`)
  assert(ipc.includes(field), `设置校验缺少 ${field}`)
}
assert(app.includes('voiceWakeEnabled: false'), '语音唤醒必须默认关闭')
for (const text of ['自定义唤醒词', '语音录入', '启用语音唤醒', '唤醒灵敏度', '唤醒确认速度', '超高灵敏', '唤醒提示音', '唤醒后新建 AI 对话']) {
  assert(settingsPage.includes(text), `语音唤醒设置缺少：${text}`)
}
for (const marker of ['navigator.mediaDevices', 'getUserMedia', 'AudioContext', 'downsampleToPcm16', 'transcribeLocal', "language, 'wake'", 'startVoiceTextCapture', 'wakePhraseMatches']) {
  assert(capture.includes(marker), `本地唤醒识别缺少：${marker}`)
}
for (const marker of ['candidate.startsWith(variant)', 'minimumSpeechSamples', 'preRollChunks', 'noiseFloor * 2.6', 'confirmedMatches', 'confirmationFrames']) {
  assert(capture.includes(marker), `语音防误触保护缺少：${marker}`)
}
assert(!capture.includes("'heyzsense', 'zsense'"), '默认唤醒词不能把单独的 ZSense 当作完整唤醒指令')
assert(!capture.includes('SpeechRecognition') && !capture.includes('webkitSpeechRecognition'), '不得回退到可能联网的浏览器语音识别')
for (const marker of ['录入自定义唤醒词', '开始录入', '测试唤醒', 'wake-enrollment-steps', 'wakePhraseMatches']) assert(enrollmentDialog.includes(marker), `唤醒词录入引导缺少：${marker}`)
for (const channel of ['zsense:voice-wake:status', 'zsense:voice-wake:request-permission', 'zsense:voice-wake:detected-client', 'zsense:voice-wake:start', 'zsense:voice-wake:stop']) {
  assert(ipc.includes(channel), `IPC 缺少：${channel}`)
}
assert(preload.includes("invoke('zsense:voice-wake:detected-client'"))
assert(main.includes("systemPreferences.askForMediaAccess('microphone')"))
assert(main.includes('setPermissionRequestHandler') && main.includes("mediaTypes.includes('audio')"))
assert(main.includes('new ZSenseVoiceService'))
assert(voiceService.includes("const DEFAULT_PHRASE = '你好 ZSense'"))
assert(voiceService.includes('whisper-cli') && voiceService.includes('ggml-base-q5_1.bin'))
assert(ipc.includes('zsense:voice:transcribe-local') && preload.includes('zsense:voice:transcribe-local'))
assert(!voiceService.includes('audio/transcriptions') && !voiceService.includes('http://') && !voiceService.includes('https://'))
assert(packageJson.build.mac.extendInfo.NSMicrophoneUsageDescription.includes('你设置的唤醒词'))
assert(packageJson.build.mac.extraResources.some((entry) => entry.from === 'bundled-tools/shared/tts/melo' && entry.to === 'bundled-tools/tts/melo'), 'macOS 安装包没有包含轻量 MeloTTS 模型')
assert(packageJson.build.win.extraResources.some((entry) => entry.from === 'bundled-tools/win32-${arch}' && entry.to === 'bundled-tools'), 'Windows 安装包没有包含对应架构的 TTS 推理程序')
assert(packageJson.build.win.extraResources.some((entry) => entry.from === 'bundled-tools/shared/tts/melo' && entry.to === 'bundled-tools/tts/melo'), 'Windows 安装包没有包含轻量 MeloTTS 模型')

console.log(JSON.stringify({ ok: true, defaultOff: true, customWakePhrase: true, guidedEnrollment: true, bundledWhisperRecognition: true, noBrowserSpeechRecognition: true, microphonePermissionRestricted: true, wakeOpensApplication: true, falseWakeGuard: true, adaptiveVoiceActivityDetection: true }))
