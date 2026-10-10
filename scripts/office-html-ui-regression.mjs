#!/usr/bin/env node
// Actual OfficeArtifactPane + HTML bridge + local service; no user files or external apps.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { OfficeWorkspaceService } from '../electron/services/office-workspace-service.mjs'

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const temporary = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'zsense-html-panel-qa-')))
const files = [path.join(temporary, 'first.html'), path.join(temporary, 'second.html')]
const service = new OfficeWorkspaceService({ userDataDirectory: path.join(temporary, 'user-data'), toolPaths: [] })
const errors = []
const serverCalls = []
let server, browser, page, failNextStage = false, releaseStage, pendingStage
const mapPreview = (data) => {
  if (data?.previewUrl) data.previewUrl = data.previewUrl.replace('zsense-office://preview/', '/__html-qa/preview/')
  if (data?.document) mapPreview(data.document)
  return data
}
try {
  for (const [index, file] of files.entries()) fs.writeFileSync(file, `<!doctype html><html><head><meta charset="UTF-8"><style>body{padding:60px;font:18px Arial}h1{font-size:28px}</style></head><body><h1 id="target">${index ? 'Second original' : 'First original'}</h1><p id="other">Unchanged paragraph</p></body></html>`, { mode: 0o600 })
  const originalFirst = fs.readFileSync(files[0], 'utf8')
  const plugin = { name: 'isolated-html-panel-fixture', configureServer(vite) {
    vite.middlewares.use(async (request, response, next) => {
      const url = request.url || ''
      if (url.startsWith('/__html-qa/preview/')) {
        const result = service.previewResponse(url.replace('/__html-qa/preview/', 'zsense-office://preview/'))
        response.statusCode = result.status
        response.setHeader('Content-Type', 'text/html; charset=utf-8')
        response.setHeader('Cache-Control', 'no-store')
        response.end(await result.text()); return
      }
      if (url === '/__html-qa/') {
        response.setHeader('Content-Type', 'text/html; charset=utf-8')
        response.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script>window.__htmlQa={files:${JSON.stringify(files)}};</script><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script><script type="module" src="/scripts/fixtures/office-html-fixture.tsx"></script></body></html>`); return
      }
      if (!url.startsWith('/__html-qa/api/')) return next()
      response.setHeader('Content-Type', 'application/json')
      try {
        let body = ''; for await (const chunk of request) body += chunk
        const payload = body ? JSON.parse(body) : {}
        const action = url.split('/').at(-1)
        serverCalls.push({ action, payload })
        if (action === 'cancelOpen') { response.end(JSON.stringify({ ok: true, data: null })); return }
        assert.ok(files.includes(payload.filePath), 'fixture requests must stay on isolated HTML files')
        let data
        if (action === 'open') data = await service.open(payload.filePath, { requestId: payload.requestId })
        else if (action === 'refresh') data = await service.refresh(payload.filePath)
        else if (action === 'reveal' || action === 'openExternally') throw new Error('Synthetic parent feedback: no external application was opened.')
        else if (['getHtml', 'stageHtml', 'saveHtml', 'discardHtml'].includes(action)) {
          if (action === 'stageHtml' && failNextStage) {
            failNextStage = false
            pendingStage = payload
            await new Promise((resolve) => { releaseStage = resolve })
            throw new Error('Late old-file stage failure must not affect the new file.')
          }
          data = await service[action]({ ...payload, sourceClientId: payload.clientId })
        } else throw new Error(`Unexpected fixture action ${action}`)
        response.end(JSON.stringify({ ok: true, data: mapPreview(data) }))
      } catch (error) { response.end(JSON.stringify({ ok: false, error: error.message })) }
    })
  } }
  server = await createServer({ root: project, configFile: false, publicDir: false, cacheDir: path.join(temporary, 'vite'), plugins: [plugin, react()], logLevel: 'warn', server: { host: '127.0.0.1', port: 0, hmr: false } })
  await server.listen()
  let playwright
  try { playwright = await import('playwright/test') } catch { playwright = await import(pathToFileURL(path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/test.mjs')).href) }
  const { chromium, expect } = playwright
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
  page.setDefaultTimeout(15_000)
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__html-qa/`, { waitUntil: 'networkidle' })
  const getHtmlCount = (file) => page.evaluate((target) => window.__htmlQa.calls.filter((call) => call.action === 'getHtml' && call.payload.filePath === target).length, file)
  const frame = () => page.frameLocator('iframe[title="first.html HTML 隔离预览"]')
  const selectTarget = async (targetFrame) => {
    await targetFrame.locator('#target').click()
    // The iframe's selection arrives through postMessage, after the click action resolves.
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  }
  const selectedText = page.getByLabel('元素文字')
  const undo = page.getByRole('button', { name: '撤销 HTML 修改' })
  const redo = page.getByRole('button', { name: '重做 HTML 修改' })
  await expect(frame().locator('#target')).toHaveText('First original')
  await expect.poll(() => getHtmlCount(files[0])).toBe(1)
  await page.getByRole('button', { name: '进入可视化编辑' }).click()
  await expect(page.locator('.html-editor-commandbar')).toContainText('编辑桥接已连接')
  await selectTarget(frame())
  await expect(selectedText).toHaveValue('First original')
  await page.evaluate(() => window.__htmlQa.capture())
  await selectedText.fill('First revision')
  await page.getByRole('button', { name: '应用文字', exact: true }).click()
  await expect(frame().locator('#target')).toHaveText('First revision')
  await expect(undo).toBeEnabled()
  await expect.poll(async () => (await service.getHtml({ filePath: files[0] })).dirty).toBe(true)
  await expect(page.getByRole('button', { name: '关闭文件', exact: true })).toHaveAttribute('title', '关闭文件（有未保存修改）')
  await expect(selectedText).toHaveValue('First revision')
  assert.equal(await getHtmlCount(files[0]), 1, 'dirty callback must not rerun HTML initialization')
  assert.equal(await page.evaluate(() => window.__htmlQa.callbacksUnchanged()), true)
  assert.equal(fs.readFileSync(files[0], 'utf8'), originalFirst, 'UI editing only stages until explicit save')

  await page.getByRole('button', { name: '在文件夹中显示' }).click()
  await expect(page.locator('.office-artifact-feedback')).toContainText('Synthetic parent feedback')
  await expect(selectedText).toHaveValue('First revision')
  await expect(undo).toBeEnabled()
  assert.equal(await getHtmlCount(files[0]), 1, 'pane feedback rerender must retain the selected element and undo history')
  assert.equal(await page.evaluate(() => window.__htmlQa.callbacksUnchanged()), true)
  await page.getByRole('button', { name: '关闭提示' }).click()
  await page.getByRole('button', { name: '重绘父界面' }).click()
  await expect(page.getByTestId('parent-rerenders')).toHaveText('1')
  await expect(selectedText).toHaveValue('First revision')
  assert.equal(await getHtmlCount(files[0]), 1)
  assert.equal(await page.evaluate(() => window.__htmlQa.callbacksUnchanged()), true)

  await page.getByRole('button', { name: '退出可视化编辑，切换到预览' }).click()
  await expect(page.locator('.html-inspector')).toHaveCount(0)
  await page.getByRole('button', { name: '进入可视化编辑' }).click()
  await expect(selectedText).toHaveValue('First revision')
  await expect(undo).toBeEnabled()
  assert.equal(await getHtmlCount(files[0]), 1, 'editing mode transitions must not clear HTML editor history')
  assert.equal(await page.evaluate(() => window.__htmlQa.callbacksUnchanged()), true)

  await selectTarget(frame())
  await selectedText.fill('Second revision')
  await page.getByRole('button', { name: '应用文字', exact: true }).click()
  await expect(frame().locator('#target')).toHaveText('Second revision')
  await expect.poll(async () => (await service.getHtml({ filePath: files[0] })).source.includes('Second revision')).toBe(true)
  await page.getByRole('button', { name: '查看 HTML 变更' }).click()
  await expect(page.getByRole('complementary', { name: 'HTML 变更记录' })).toContainText('2 项')
  await undo.click()
  await expect(frame().locator('#target')).toHaveText('First revision')
  await expect(undo).toBeEnabled()
  await expect(redo).toBeEnabled()
  await redo.click()
  await expect(frame().locator('#target')).toHaveText('Second revision')
  await expect(redo).toBeDisabled()
  assert.equal(await getHtmlCount(files[0]), 1, 'undo/redo must reuse the current HTML editing session')

  await selectTarget(frame())
  await expect(selectedText).toHaveValue('Second revision')
  await page.getByTitle('保存到原文件').click()
  await expect(page.locator('.office-artifact-feedback')).toContainText('HTML 已保存并校验')
  await expect(page.getByRole('button', { name: '关闭文件', exact: true })).toHaveAttribute('title', '关闭文件')
  await expect(selectedText).toHaveValue('Second revision')
  await expect(undo).toBeEnabled()
  assert.equal(await getHtmlCount(files[0]), 1, 'save feedback and document updates must not reset HTML history')
  assert.match(fs.readFileSync(files[0], 'utf8'), /Second revision/)
  assert.equal(await page.evaluate(() => window.__htmlQa.callbacksUnchanged()), true)
  await page.screenshot({ path: path.join(temporary, 'html-panel-editing.png') })

  await page.getByRole('button', { name: '切换到第二个 HTML' }).click()
  const secondFrame = page.frameLocator('iframe[title="second.html HTML 隔离预览"]')
  await expect(secondFrame.locator('#target')).toHaveText('Second original')
  await expect.poll(() => getHtmlCount(files[1])).toBe(1)
  assert.equal(await page.evaluate(() => window.__htmlQa.callbacksUnchanged()), false, 'switching files establishes a new callback generation')
  await page.evaluate(() => window.__htmlQa.invokeCaptured())
  await expect(page.locator('.office-artifact-title strong')).toHaveText('second.html')
  await expect(page.locator('.office-artifact-feedback')).toHaveCount(0)
  await expect(page.getByRole('button', { name: '关闭文件', exact: true })).toHaveAttribute('title', '关闭文件')
  assert.equal(await getHtmlCount(files[1]), 1)

  // Delay an actual old-file stage failure until after the same pane switches files.
  failNextStage = true
  await page.getByRole('button', { name: '进入可视化编辑' }).click()
  await selectTarget(secondFrame)
  await selectedText.fill('Pending old-file revision')
  await page.getByRole('button', { name: '应用文字', exact: true }).click()
  await expect.poll(() => Boolean(releaseStage)).toBe(true)
  assert.equal(pendingStage.filePath, files[1])
  await page.evaluate(() => window.__htmlQa.forceFile(0))
  await expect(frame().locator('#target')).toHaveText('Second revision')
  await expect.poll(() => getHtmlCount(files[0])).toBe(2)
  releaseStage()
  await expect.poll(() => page.evaluate(() => window.__htmlQa.calls.filter((call) => call.action === 'cancelOpen').length)).toBe(2)
  await page.waitForLoadState('networkidle')
  await expect(page.locator('.office-artifact-title strong')).toHaveText('first.html')
  await expect(page.locator('.office-artifact-feedback')).toHaveCount(0)
  await expect(page.getByRole('button', { name: '关闭文件', exact: true })).toHaveAttribute('title', '关闭文件')
  assert.equal(await getHtmlCount(files[0]), 2, 'late old-file errors must not retrigger the new editor initialization')
  assert.equal((await service.getHtml({ filePath: files[1] })).dirty, false)
  assert.deepEqual(errors, [])
  await page.screenshot({ path: path.join(temporary, 'html-panel.png') })
  console.log(`HTML panel regression passed: stable callbacks, mode/dirty/feedback rerenders, selected element + undo history, explicit save, file-switch generation + late-error rejection (${serverCalls.length} isolated bridge requests).`)
} catch (error) {
  await page?.screenshot({ path: path.join(temporary, 'html-panel-failure.png') })
  console.error('HTML fixture diagnostics:', JSON.stringify({ bridgeCalls: serverCalls.map(({ action, payload }) => ({ action, filePath: payload.filePath, source: payload.source?.includes('Second revision') ? 'second-revision' : payload.source?.includes('First revision') ? 'first-revision' : '' })), pageErrors: errors }))
  throw error
} finally {
  releaseStage?.()
  await browser?.close()
  await server?.close()
  if (process.argv.includes('--keep-artifacts')) console.log(`HTML panel artifacts: ${temporary}`)
  else fs.rmSync(temporary, { recursive: true, force: true })
}
