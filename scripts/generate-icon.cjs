const { app, BrowserWindow, nativeImage } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

app.whenReady().then(async () => {
  const projectDirectory = path.resolve(__dirname, '..')
  const sourcePath = path.join(projectDirectory, 'build', 'icon-source.png')
  const outputPath = path.join(projectDirectory, 'build', 'icon.png')
  const windowsOutputPath = path.join(projectDirectory, 'build', 'icon-win.png')
  const interfaceOutputPath = path.join(projectDirectory, 'src', 'assets', 'zsense-brand.png')
  const source = nativeImage.createFromPath(sourcePath)
  if (source.isEmpty()) throw new Error('无法读取 build/icon-source.png')
  const sourceDataUrl = source.resize({ width: 2048, height: 2048, quality: 'best' }).toDataURL()
  const cornerRadius = 360
  // 源图留白较多：适度放大主体，使 Dock / Windows 任务栏的小图标也清楚。
  const contentCrop = 300
  const renderer = new BrowserWindow({ show: false, width: 64, height: 64, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
  await renderer.loadURL('data:text/html;charset=utf-8,<canvas id="icon" width="2048" height="2048"></canvas>')
  const roundedDataUrl = await renderer.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const canvas = document.getElementById('icon'); const context = canvas.getContext('2d');
      context.clearRect(0, 0, 2048, 2048); context.beginPath(); context.roundRect(0, 0, 2048, 2048, ${cornerRadius}); context.clip();
      context.drawImage(image, ${contentCrop}, ${contentCrop}, ${2048 - contentCrop * 2}, ${2048 - contentCrop * 2}, 0, 0, 2048, 2048); resolve(canvas.toDataURL('image/png'));
    };
    image.onerror = () => reject(new Error('图标源图片载入失败'));
    image.src = ${JSON.stringify(sourceDataUrl)};
  })`)
  renderer.destroy()
  const icon = nativeImage.createFromDataURL(roundedDataUrl)
  if (icon.isEmpty()) throw new Error('无法生成应用图标')
  const output = icon.toPNG()
  fs.writeFileSync(outputPath, output)
  fs.writeFileSync(windowsOutputPath, output)
  fs.writeFileSync(interfaceOutputPath, icon.resize({ width: 512, height: 512, quality: 'best' }).toPNG())
  console.log(`已生成 ${outputPath}、${windowsOutputPath} 和 ${interfaceOutputPath}`)
  app.quit()
}).catch((error) => {
  console.error(error)
  app.exit(1)
})
