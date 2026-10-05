import fs from 'node:fs/promises'
import path from 'node:path'

export default async function afterPack(context) {
  const resourcesDirectory = context.electronPlatformName === 'darwin'
    ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : path.join(context.appOutDir, 'resources')

  await fs.rm(path.join(resourcesDirectory, 'default_app.asar'), { force: true })
  await fs.rm(path.join(context.appOutDir, 'version'), { force: true })
  if (context.electronPlatformName === 'win32') {
    // 安装包不再携带已停用的 Hindsight/uv 下载器；清单必须与实际离线工具一致。
    const manifestPath = path.join(resourcesDirectory, 'bundled-tools', 'manifest.json')
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
    for (const relativePath of Object.keys(manifest.files || {})) {
      try { await fs.access(path.join(resourcesDirectory, 'bundled-tools', relativePath)) }
      catch { delete manifest.files[relativePath] }
    }
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  }
}
