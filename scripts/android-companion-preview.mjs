import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const project = process.cwd()
const toolchain = '/Volumes/out1/zsense-android-toolchain'
const sdk = process.env.ANDROID_HOME || path.join(toolchain, 'sdk')
const avdHome = process.env.ANDROID_AVD_HOME || path.join(toolchain, 'avd')
const adb = path.join(sdk, 'platform-tools', 'adb')
const emulator = path.join(sdk, 'emulator', 'emulator')
const apk = process.env.ZSENSE_ANDROID_PREVIEW_APK || path.join(project, '安装包', '当前', 'ZSense-0.1.5-android13-release.apk')

for (const item of [adb, emulator, apk]) if (!fs.existsSync(item)) throw new Error(`预览所需文件不存在：${item}`)

const run = (...args) => execFileSync(adb, args, { encoding: 'utf8', timeout: 60_000 }).trim()
const devices = () => run('devices').split('\n').map((line) => line.match(/^(emulator-\d+)\s+device$/)?.[1]).filter(Boolean)
let device = devices()[0]
let ready = false
if (!device) {
  const child = spawn(emulator, ['-avd', 'zsense-test', '-gpu', 'swiftshader_indirect'], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, ANDROID_HOME: sdk, ANDROID_AVD_HOME: avdHome },
  })
  child.unref()
  console.log('正在启动 Android 模拟器…')
  for (let attempt = 0; attempt < 90; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    device = devices()[0]
    try {
      if (device && run('-s', device, 'shell', 'getprop', 'sys.boot_completed') === '1') { ready = true; break }
    } catch { /* ADB can report the emulator before Android finishes booting. */ }
  }
}
if (device && !ready) {
  try { ready = run('-s', device, 'shell', 'getprop', 'sys.boot_completed') === '1' } catch { /* still booting */ }
}
if (!device || !ready) throw new Error('Android 模拟器未能完成启动。')

console.log(run('-s', device, 'install', '-r', apk))
console.log(run('-s', device, 'shell', 'am', 'start', '-n', 'com.zsense.companion/.MainActivity'))
console.log(`已在 ${device} 打开 ZSense Android。`)
