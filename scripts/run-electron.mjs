import { spawn } from 'node:child_process'
import process from 'node:process'

process.env.ELECTRON_MIRROR ||= 'https://npmmirror.com/mirrors/electron/'
const { default: electronPath } = await import('electron')

// 父进程自己跑在 Electron 里时（例如从 Electron 应用内部启动脚本）会继承 ELECTRON_RUN_AS_NODE=1，
// 此时 Electron 会退化成纯 Node，测试读不到 electron 模块（报 does not provide an export named 'clipboard'）。
const environment = { ...process.env }
delete environment.ELECTRON_RUN_AS_NODE
const child = spawn(electronPath, process.argv.slice(2), {
  cwd: process.cwd(),
  stdio: 'inherit',
  env: environment,
})

child.on('exit', (code) => process.exit(code ?? 0))
