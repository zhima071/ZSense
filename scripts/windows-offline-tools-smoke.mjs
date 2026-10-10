import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { verifyWindowsOfflineBundle, windowsBundleRoot } from './windows-offline-assets.mjs'
import { meloBundleRoot } from './voice-assets.mjs'

const verified = verifyWindowsOfflineBundle()
assert(verified.files >= 20, 'Windows 完整离线包登记文件过少')
assert(verified.bytes > 200 * 1024 * 1024, 'Windows 完整离线包没有包含 STT 模型与运行组件')
assert.equal(verified.meloFiles, 8, 'Windows 完整离线包没有包含精简 FP32 MeloTTS 模型')
assert(verified.ttsFiles >= 12, 'Windows 完整离线包没有包含原生 TTS 引擎与许可')
assert.equal(verified.whisperBytes, 59707625, 'Windows STT 没有使用已固定的 Whisper base Q5_1')

if (process.platform === 'win32' && process.arch === 'x64') {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'zsense-windows-office-'))
  try {
    for (const name of ['officecli.exe', 'dws.exe', 'kdocs-cli.exe', 'lark-cli.exe', 'bsk.exe']) {
      fs.copyFileSync(path.join(windowsBundleRoot, name), path.join(temporaryDirectory, name))
    }
    const command = (file, args) => execFileSync(/^(?:stt|tts)\//.test(file) ? path.join(windowsBundleRoot, file) : path.join(temporaryDirectory, file), args, { encoding: 'utf8', windowsHide: true, timeout: 120_000 }).trim()
    assert.match(command('officecli.exe', ['--version']), /^1\.0\.149(?:\b|$)/)
    assert.match(command('dws.exe', ['version']), /v1\.0\.61(?:\b|$)/)
    assert.match(command('kdocs-cli.exe', ['version']), /^2\.5\.7(?:\b|$)/)
    assert.match(command('lark-cli.exe', ['--version']), /1\.0\.95(?:\b|$)/)
    assert.match(command('bsk.exe', ['--version']), /0\.3\.0(?:\b|$)/)
    assert.match(command('stt/whisper-cli.exe', ['--version']), /whisper/i)
    const speech = path.join(temporaryDirectory, 'fixed-chinese.wav')
    command('tts/sherpa-onnx-offline-tts.exe', [
      `--vits-model=${path.join(meloBundleRoot, 'model.onnx')}`,
      `--vits-lexicon=${path.join(meloBundleRoot, 'lexicon.txt')}`,
      `--vits-tokens=${path.join(meloBundleRoot, 'tokens.txt')}`,
      `--tts-rule-fsts=${['date.fst', 'number.fst', 'phone.fst', 'new_heteronym.fst'].map((file) => path.join(meloBundleRoot, file)).join(',')}`,
      `--output-filename=${speech}`, '--print-args=false', '--', '你好，这是完全离线的中文语音测试。',
    ])
    assert(fs.existsSync(speech) && fs.statSync(speech).size > 44, 'Windows 原生 MeloTTS 没有生成音频')
    const workbook = path.join(temporaryDirectory, 'offline.xlsx')
    command('officecli.exe', ['create', workbook, '--json'])
    assert(fs.existsSync(workbook), 'Windows OfficeCLI 没有创建测试工作簿')
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true })
  }
}

console.log(JSON.stringify({ ok: true, platform: process.platform, arch: process.arch, actualWindowsExecution: process.platform === 'win32' && process.arch === 'x64', ...verified }))
