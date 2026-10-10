#!/usr/bin/env node
// Isolated sample decks + actual bundled CLI + real component/browser interactions.
import assert from 'node:assert/strict'
import { execFileSync, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { PresentationWorkspace } from '../electron/services/presentation-workspace.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'zsense-ppt-regression-'))
const tool = path.join(root, 'bundled-tools', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'officecli.exe' : 'officecli')
const environment = { ...process.env, OFFICECLI_NO_AUTO_RESIDENT: '1' }
const cli = (args) => execFileSync(tool, args, { env: environment, encoding: 'utf8' })
const run = promisify(execFile)
const files = [path.join(temporary, 'deck-a.pptx'), path.join(temporary, 'deck-b.pptx')]
let server, browser, page, port, delayedRefresh = false, failed = false
const previews = new Map(), events = [], errors = [], results = []
const service = new PresentationWorkspace({ userDataDirectory: temporary,
  run: (args) => run(tool, args, { env: environment, encoding: 'utf8', timeout: 120_000 }),
  registerPreview: ({ filePath, previewPath, revision }) => {
    const key = path.basename(path.dirname(previewPath)) + '-' + revision
    previews.set(key, previewPath)
    const stat = fs.statSync(filePath)
    return { filePath, name: path.basename(filePath), extension: '.pptx', kind: 'powerpoint', accessedAt: new Date().toISOString(), editable: true,
      previewUrl: `http://127.0.0.1:${port}/__ppt/preview/${key}`, modifiedAt: stat.mtime.toISOString(), size: stat.size, sheets: [], message: '' }
  }, publish: (event) => events.push(event) })
try {
  for (const [index, file] of files.entries()) {
    cli(['create', file, '--json'])
    cli(['add', file, '/', '--type', 'slide', '--prop', `title=Deck ${index ? 'B' : 'A'} first`, '--json'])
    cli(['add', file, '/slide[1]', '--type', 'shape', '--prop', 'text=Editable sample', '--prop', 'x=2cm', '--prop', 'y=4cm', '--prop', 'width=6cm', '--prop', 'height=2cm', '--json'])
    cli(['add', file, '/slide[1]', '--type', 'picture', '--prop', `src=${path.join(root, 'build/icon.png')}`, '--prop', 'x=20cm', '--prop', 'y=4cm', '--prop', 'width=3cm', '--prop', 'height=3cm', '--json'])
    cli(['add', file, '/', '--type', 'slide', '--prop', `title=Deck ${index ? 'B' : 'A'} second`, '--json'])
  }
  server = await createServer({ root, configFile: false, publicDir: false, plugins: [react(), { name: 'ppt-fixture', configureServer(vite) {
    vite.middlewares.use(async (request, response, next) => {
      if (request.url === '/__ppt/') {
        response.setHeader('Content-Type', 'text/html; charset=utf-8')
        response.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script>window.__pptFixture={files:${JSON.stringify(files)},prompts:[],calls:[]}</script><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script><script type="module" src="/scripts/fixtures/office-ppt-fixture.tsx"></script></body></html>`); return
      }
      if (request.url?.startsWith('/__ppt/preview/')) {
        const preview = previews.get(request.url.split('/').pop())
        response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.setHeader('Cache-Control', 'no-store')
        response.end(preview && fs.existsSync(preview) ? fs.readFileSync(preview, 'utf8') : ''); return
      }
      if (request.url !== '/__ppt/api') return next()
      response.setHeader('Content-Type', 'application/json')
      try {
        let body = ''; for await (const chunk of request) body += chunk
        const { method, request: payload } = JSON.parse(body)
        assert(files.some((file) => fs.realpathSync.native(file) === fs.realpathSync.native(payload.filePath)))
        let data
        if (method === 'open' || method === 'refresh') {
          data = (await service.getPresentation(payload)).document
          if (method === 'refresh' && delayedRefresh) await new Promise((resolve) => setTimeout(resolve, 800))
        } else {
          assert(['getPresentation', 'stagePresentation', 'savePresentation', 'discardPresentation'].includes(method))
          data = await service[method]({ ...payload, sourceClientId: payload.clientId })
        }
        response.end(JSON.stringify({ ok: true, data }))
      } catch (error) { response.end(JSON.stringify({ ok: false, error: error.message })) }
    })
  } }], logLevel: 'error', server: { host: '127.0.0.1', port: 0, hmr: false } })
  await server.listen(); port = server.httpServer.address().port
  const first = await service.getPresentation({ filePath: files[0] })
  assert.equal(await service.invalidate(path.join(temporary, 'not-a-presentation.xlsx')), null, 'shared Office invalidation must not treat other formats as PPTX')
  assert.equal(await service.invalidate(files[1]), null, 'raw CLI edits must not generate previews for never-opened decks')
  const element = first.slides[0].elements.find((item) => item.text === 'Editable sample')
  const picture = first.slides[0].elements.find((item) => ['picture', 'image'].includes(item.type))
  assert(element, 'sample shape must have stable ID and text')
  assert(picture && !picture.textEditable, 'image must support selection/geometry without plain-text replacement')
  assert.match(element.path, /@id=/)
  let session = await service.stagePresentation({ filePath: files[0], expectedContentHash: first.baseContentHash, expectedRevision: first.sessionRevision,
    operations: [{ path: element.path, properties: { text: 'Staged only', x: '3cm', width: '7cm' } }] })
  assert.equal(session.dirty, true)
  assert.doesNotMatch(cli(['view', files[0], 'text']), /Staged only/)
  const saved = await service.savePresentation({ filePath: files[0], expectedContentHash: session.baseContentHash, expectedRevision: session.sessionRevision })
  assert.equal(saved.dirty, false); assert.match(cli(['view', files[0], 'text']), /Staged only/)
  const geometry = JSON.parse(cli(['get', files[0], element.path, '--json'])).data.results[0].format
  assert.equal(geometry.x, '3cm'); assert.equal(geometry.width, '7cm')
  session = await service.stagePresentation({ filePath: files[0], operations: [{ path: element.path, properties: { text: 'Unsaved draft' } }] })
  cli(['set', files[0], element.path, '--prop', 'text=External update', '--json'])
  await assert.rejects(() => service.savePresentation({ filePath: files[0], expectedContentHash: session.baseContentHash }), /其他程序修改/)
  assert.match(cli(['view', files[0], 'text']), /External update/)
  assert.equal((await service.getPresentation({ filePath: files[0] })).dirty, true)
  await service.discardPresentation({ filePath: files[0] })
  await assert.rejects(() => service.stagePresentation({ filePath: files[0], operations: [{ path: '/slide[1]/shape[@id=99999999]', properties: { text: 'forged' } }] }), /已不存在/)
  results.push('CLI save/stage geometry, conflict, invalid paths')
  let playwright
  try { playwright = await import('playwright/test') } catch { playwright = await import(pathToFileURL(path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/test.mjs')).href) }
  const { chromium, expect } = playwright
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  let dialogAccepted = false
  page.on('dialog', (dialog) => dialogAccepted ? dialog.accept() : dialog.dismiss())
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(`http://127.0.0.1:${port}/__ppt/`, { waitUntil: 'networkidle' })
  await expect(page.getByRole('region', { name: 'PowerPoint 编辑器' })).toBeVisible()
  await page.getByRole('button', { name: '打开编辑工具' }).click()
  const frame = page.frameLocator('iframe[title="deck-a.pptx 幻灯片预览"]')
  await expect(frame.locator('.sidebar')).toBeVisible()
  await expect(frame.locator('.thumb')).toHaveCount(2)
  assert(await frame.locator('.thumb-slide').first().evaluate((element) => new DOMMatrixReadOnly(getComputedStyle(element).transform).a < .2), 'actual slide thumbnails must be scaled into the compact rail')
  await page.getByLabel('当前幻灯片').selectOption('2'); await expect(page.getByLabel('当前幻灯片')).toHaveValue('2')
  await page.getByRole('button', { name: '上一张幻灯片' }).click()
  await frame.locator(`.main [data-path='${picture.path}']`).click()
  await expect(page.getByLabel('选择幻灯片元素')).toHaveValue(picture.path)
  await expect(page.getByText('替换元素全文', { exact: true })).toHaveCount(0)
  await page.getByLabel('元素宽度').fill('3.5cm'); await page.getByRole('button', { name: '应用', exact: true }).click()
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.getByText('所有修改已保存', { exact: false })).toBeVisible()
  await frame.locator(`.main [data-path='${element.path}']`).click()
  await expect(page.getByLabel('选择幻灯片元素')).toHaveValue(element.path)
  await page.getByText('替换元素全文', { exact: true }).locator('..').locator('textarea').fill('Saved from UI')
  await page.getByLabel('元素左侧位置').fill('4cm')
  await page.getByRole('button', { name: '应用', exact: true }).click()
  await expect(page.getByText('1 处修改尚未保存', { exact: false })).toBeVisible()
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.getByText('所有修改已保存', { exact: false })).toBeVisible()
  assert.match(cli(['view', files[0], 'text']), /Saved from UI/)
  await page.getByLabel('PowerPoint AI 编辑要求').fill('把这个元素的文字改为蓝色')
  await page.getByRole('button', { name: 'AI 编辑', exact: true }).click()
  const prompt = await page.evaluate(() => window.__pptFixture.prompts[0])
  assert(prompt.includes(element.path) && prompt.includes('仅选中的元素') && prompt.includes('不要覆盖其他幻灯片'))
  if (process.argv.includes('--keep-artifacts')) await page.screenshot({ path: path.join(temporary, 'ppt-editor.png') })
  await page.getByRole('button', { name: '放大幻灯片' }).click(); await expect(page.getByRole('button', { name: '恢复默认缩放' })).toHaveText('110%')
  await page.getByRole('button', { name: '恢复默认缩放' }).click()
  const box = await frame.locator(`.main [data-path='${element.path}']`).boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 + 20, box.y + box.height / 2 + 12, { steps: 5 }); await page.mouse.up()
  await expect(page.getByText('1 处修改尚未保存', { exact: false })).toBeVisible()
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.getByText('所有修改已保存', { exact: false })).toBeVisible()
  await frame.locator(`.main [data-path='${element.path}']`).click()
  const resizeBox = await frame.locator('.main .zsense-ppt-resize').boundingBox()
  await page.mouse.move(resizeBox.x + resizeBox.width / 2, resizeBox.y + resizeBox.height / 2); await page.mouse.down()
  await page.mouse.move(resizeBox.x + resizeBox.width / 2 + 16, resizeBox.y + resizeBox.height / 2 + 10, { steps: 4 }); await page.mouse.up()
  await expect(page.getByText('1 处修改尚未保存', { exact: false })).toBeVisible()
  await frame.locator(`.main [data-path='${element.path}']`).click()
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s')
  await expect(page.getByText('所有修改已保存', { exact: false })).toBeVisible()
  await frame.locator('.main').hover(); await page.keyboard.down('Control'); await page.mouse.wheel(0, -120); await page.keyboard.up('Control')
  await expect(page.getByRole('button', { name: '恢复默认缩放' })).toHaveText('110%')
  await page.getByRole('button', { name: '恢复默认缩放' }).click()
  const textField = page.getByText('替换元素全文', { exact: true }).locator('..').locator('textarea')
  const applyButton = page.getByRole('button', { name: '应用', exact: true })
  const saveButton = page.getByRole('button', { name: '保存', exact: true })
  const hold = (method) => page.evaluate((method) => window.__pptFixture.holdNext(method), method)
  const waiting = (gate) => expect.poll(() => page.evaluate((id) => window.__pptFixture.gate(id).waiting, gate)).toBe(true)
  const release = (gate) => page.evaluate((id) => window.__pptFixture.release(id), gate)
  const count = (method) => page.evaluate((method) => window.__pptFixture.calls.filter((value) => value === method).length, method)
  const emit = (event) => page.evaluate((event) => window.__pptFixture.emit(event), event)

  // Hold delivery of an actual backend stage response, then type a newer draft.
  // Releasing the old response must not clear dirty or replace those fields.
  await page.getByLabel('选择幻灯片元素').selectOption(element.path)
  const delayedStage = await hold('stagePresentation')
  await textField.fill('Submitted snapshot'); await applyButton.click(); await waiting(delayedStage)
  await textField.fill('Newer text during stage'); await page.getByLabel('元素左侧位置').fill('5.5cm')
  await release(delayedStage)
  await expect(applyButton).toBeEnabled()
  await expect(textField).toHaveValue('Newer text during stage')
  await expect(page.getByLabel('元素左侧位置')).toHaveValue('5.5cm')
  await expect(page.getByText('有未应用的修改', { exact: false })).toBeVisible()
  assert.doesNotMatch(cli(['view', files[0], 'text']), /Submitted snapshot|Newer text during stage/)
  await saveButton.click(); await expect(page.getByText('所有修改已保存', { exact: false })).toBeVisible()
  assert.match(cli(['view', files[0], 'text']), /Newer text during stage/)
  assert.equal(JSON.parse(cli(['get', files[0], element.path, '--json'])).data.results[0].format.x, '5.5cm')

  // Saving an earlier applied revision also keeps input entered while its
  // response is delayed, and only a subsequent explicit save persists it.
  await textField.fill('Saved snapshot'); await applyButton.click()
  await expect(page.getByText('1 处修改尚未保存', { exact: false })).toBeVisible()
  const delayedSave = await hold('savePresentation')
  await saveButton.click(); await waiting(delayedSave)
  await textField.fill('Newer text during save'); await release(delayedSave)
  await expect(applyButton).toBeEnabled(); await expect(textField).toHaveValue('Newer text during save')
  assert.match(cli(['view', files[0], 'text']), /Saved snapshot/)
  assert.doesNotMatch(cli(['view', files[0], 'text']), /Newer text during save/)
  await saveButton.click(); await expect(page.getByText('所有修改已保存', { exact: false })).toBeVisible()
  assert.match(cli(['view', files[0], 'text']), /Newer text during save/)

  // Acknowledging shape A must not clear a newer dirty form on picture B.
  const switchedStage = await hold('stagePresentation')
  await textField.fill('Shape submitted before selection change'); await applyButton.click(); await waiting(switchedStage)
  dialogAccepted = true
  await page.getByLabel('选择幻灯片元素').selectOption(picture.path)
  await page.getByLabel('元素宽度').fill('4.25cm'); await release(switchedStage)
  await expect(applyButton).toBeEnabled(); await expect(page.getByLabel('元素宽度')).toHaveValue('4.25cm')
  await expect(page.getByLabel('选择幻灯片元素')).toHaveValue(picture.path)
  await saveButton.click(); await expect(page.getByText('所有修改已保存', { exact: false })).toBeVisible()
  assert.equal(JSON.parse(cli(['get', files[0], picture.path, '--json'])).data.results[0].format.width, '4.25cm')
  await page.getByLabel('选择幻灯片元素').selectOption(element.path)

  // Two external reads are queued, not raced. A known newer event invalidates
  // the first captured response even before the latest response is delivered.
  const originalText = await textField.inputValue()
  const oldRead = await hold('getPresentation'), latestRead = await hold('getPresentation')
  const readsBefore = await count('getPresentation')
  cli(['set', files[0], element.path, '--prop', 'text=External first version', '--json'])
  await service.invalidate(files[0], 'external-test', 'agent'); await emit(events.at(-1)); await waiting(oldRead)
  cli(['set', files[0], element.path, '--prop', 'text=External latest version', '--json'])
  await service.invalidate(files[0], 'external-test', 'agent'); await emit(events.at(-1))
  assert.equal(await count('getPresentation'), readsBefore + 1, 'later external read must wait in the same local queue')
  assert.equal(await page.evaluate((id) => window.__pptFixture.gate(id).waiting, latestRead), false)
  await release(oldRead); await waiting(latestRead)
  await expect(textField).toHaveValue(originalText)
  await release(latestRead); await expect(textField).toHaveValue('External latest version')
  await expect(page.getByRole('alert')).toHaveCount(0)

  // Input begins after the external response was captured but before it is
  // delivered. Keep the old base and draft; never diff its old geometry against
  // the external x/y and silently write those old values back.
  const stalePreview = (await service.getPresentation({ filePath: files[0] })).previewRevision
  const oldX = await page.getByLabel('元素左侧位置').inputValue()
  const draftRead = await hold('getPresentation')
  cli(['set', files[0], element.path, '--prop', 'text=External text and geometry', '--prop', 'x=9cm', '--json'])
  await service.invalidate(files[0], 'external-test', 'agent'); await emit(events.at(-1)); await waiting(draftRead)
  const stagesBeforeConflict = await count('stagePresentation')
  await textField.fill('Local draft must stay visible'); await release(draftRead)
  await expect(page.getByRole('alert')).toContainText('当前草稿仍保留')
  await expect(textField).toHaveValue('Local draft must stay visible')
  await expect(page.getByLabel('元素左侧位置')).toHaveValue(oldX)
  await expect(saveButton).toBeDisabled(); await expect(applyButton).toBeDisabled()
  await textField.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s')
  assert.equal(await count('stagePresentation'), stagesBeforeConflict, 'stale draft cannot issue a stage even via keyboard save')
  assert.equal(JSON.parse(cli(['get', files[0], element.path, '--json'])).data.results[0].format.x, '9cm')
  assert.match(cli(['view', files[0], 'text']), /External text and geometry/)
  await page.getByRole('button', { name: '放弃 PowerPoint 修改' }).click()
  await expect(textField).toHaveValue('External text and geometry')
  await expect(page.getByLabel('元素左侧位置')).toHaveValue('9cm'); await expect(page.getByRole('alert')).toHaveCount(0)
  // A late message from the previous preview must remain inert after recovery.
  await frame.locator('.main').evaluate((_, data) => { parent.postMessage(data, '*') }, { channel: 'zsense-presentation-editor-v1', type: 'geometry', previewRevision: stalePreview, path: element.path, properties: { x: '1cm' } })
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  assert.equal(await count('stagePresentation'), stagesBeforeConflict, 'old iframe geometry messages must be rejected by preview revision')
  assert.equal(JSON.parse(cli(['get', files[0], element.path, '--json'])).data.results[0].format.x, '9cm')
  // A newer external stage can arrive while a local stage result is withheld.
  // Even an unchanged form must not be cleared by that superseded response.
  const supersededStage = await hold('stagePresentation')
  await textField.fill('Unacknowledged local snapshot'); await applyButton.click(); await waiting(supersededStage)
  await service.stagePresentation({ filePath: files[0], operations: [{ path: element.path, properties: { text: 'New external staged snapshot', x: '10cm' } }], sourceClientId: 'external-stage', source: 'agent' })
  await emit(events.at(-1)); await release(supersededStage)
  await expect(page.getByRole('alert')).toContainText('当前草稿仍保留')
  await expect(page.getByRole('button', { name: '放弃 PowerPoint 修改' })).toBeEnabled()
  await expect(textField).toHaveValue('Unacknowledged local snapshot')
  await expect(page.getByLabel('元素左侧位置')).toHaveValue('9cm')
  await expect(saveButton).toBeDisabled(); await expect(applyButton).toBeDisabled()
  assert.equal(JSON.parse(cli(['get', files[0], element.path, '--json'])).data.results[0].format.x, '9cm')
  assert.match(cli(['view', files[0], 'text']), /External text and geometry/)
  await page.getByRole('button', { name: '放弃 PowerPoint 修改' }).click()
  await expect(textField).toHaveValue('External text and geometry'); await expect(page.getByRole('alert')).toHaveCount(0)
  results.push('Deterministic delayed stage/save/new-selection drafts, serialized external reads, stale response and geometry/conflict guards')
  dialogAccepted = false
  const agentStage = await service.stagePresentation({ filePath: files[0], operations: [{ path: element.path, properties: { text: 'Agent scoped update' } }], source: 'agent', sourceClientId: 'test-agent' })
  assert.equal(events.at(-1).source, 'agent')
  await page.evaluate((event) => window.__pptFixture.emit(event), events.at(-1))
  await expect(page.getByText('1 处修改尚未保存', { exact: false })).toBeVisible()
  await expect(page.getByText('替换元素全文', { exact: true }).locator('..').locator('textarea')).toHaveValue('Agent scoped update')
  assert.equal(agentStage.dirty, true)
  results.push('PPT thumbnail/navigation/select/apply/save/AI/zoom/drag')
  await page.getByRole('button', { name: '文稿 B', exact: true }).click()
  await expect(page.locator('iframe[title="deck-a.pptx 幻灯片预览"]')).toBeVisible()
  dialogAccepted = true
  await page.getByRole('button', { name: '文稿 B', exact: true }).click()
  await expect(page.locator('iframe[title="deck-b.pptx 幻灯片预览"]')).toBeVisible()
  assert.equal((await service.getPresentation({ filePath: files[0] })).dirty, false)
  await page.getByRole('button', { name: '文稿 A', exact: true }).click()
  await expect(page.locator('iframe[title="deck-a.pptx 幻灯片预览"]')).toBeVisible()
  delayedRefresh = true
  await page.getByRole('button', { name: '刷新文件' }).click()
  await page.evaluate((file) => window.__pptFixture.forceFile(file), files[1])
  await expect(page.locator('iframe[title="deck-b.pptx 幻灯片预览"]')).toBeVisible()
  await page.waitForTimeout(1000)
  await expect(page.locator('iframe[title="deck-b.pptx 幻灯片预览"]')).toBeVisible()
  assert.equal(await page.locator('iframe[title="deck-a.pptx 幻灯片预览"]').count(), 0)
  results.push('Dirty navigation decline/accept and stale refresh suppression')
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ ok: true, scenarios: results, events: events.length }))
} catch (error) { failed = true; console.error(error.stack); if (page) { console.error(await page.locator('body').innerText().catch(() => '')); console.error(await page.evaluate(() => window.__pptFixture.calls).catch(() => [])); await page.screenshot({ path: path.join(temporary, 'failure.png') }).catch(() => {}) }; process.exitCode = 1 }
finally { await browser?.close(); await server?.close(); if (!failed && !process.argv.includes('--keep-artifacts')) fs.rmSync(temporary, { recursive: true, force: true }); else console.log(`QA artifacts: ${temporary}`) }
