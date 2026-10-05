import { spawn } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'

const projectDirectory = process.cwd()
const viteEntry = path.join(projectDirectory, 'node_modules', 'vite', 'bin', 'vite.js')
const developmentUrl = 'http://127.0.0.1:4173'
process.env.ELECTRON_MIRROR ||= 'https://npmmirror.com/mirrors/electron/'

async function isZSenseReady() {
  try {
    const response = await fetch(developmentUrl)
    const html = await response.text()
    return response.ok && html.includes('ZSense')
  } catch {
    return false
  }
}

async function waitForVite() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (await isZSenseReady()) return
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`Vite 未能在 ${developmentUrl} 启动`)
}

function stopChild(child) {
  if (child && !child.killed) child.kill('SIGTERM')
}

let viteProcess = null

try {
  if (!(await isZSenseReady())) {
    viteProcess = spawn(process.execPath, [viteEntry], {
      cwd: projectDirectory,
      stdio: 'inherit',
    })
  }
  await waitForVite()
  const { default: electronPath } = await import('electron')
  const electronProcess = spawn(electronPath, ['.'], {
    cwd: projectDirectory,
    stdio: 'inherit',
    env: { ...process.env, ZSENSE_DEV_SERVER_URL: developmentUrl },
  })

  electronProcess.on('exit', (code) => {
    stopChild(viteProcess)
    process.exit(code ?? 0)
  })

  process.on('SIGINT', () => {
    stopChild(electronProcess)
    stopChild(viteProcess)
  })
  process.on('SIGTERM', () => {
    stopChild(electronProcess)
    stopChild(viteProcess)
  })
} catch (error) {
  stopChild(viteProcess)
  console.error(error)
  process.exit(1)
}
