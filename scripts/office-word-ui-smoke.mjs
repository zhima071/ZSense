import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { OfficeWorkspaceService } from '../electron/services/office-workspace-service.mjs'

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'zsense-word-ui-qa-'))
const tool = path.join(project, 'bundled-tools', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'officecli.exe' : 'officecli')
const filePath = path.join(temporary, 'word-ui.docx')
const env = { ...process.env, OFFICECLI_NO_AUTO_RESIDENT: '1' }
const cli = (...args) => execFileSync(tool, [...args, '--json'], { env, encoding: 'utf8' })
const service = new OfficeWorkspaceService({ userDataDirectory: temporary, toolPaths: [tool] })
const sessionEvents = []
service.onSessionEvent((event) => sessionEvents.push(event))
let server, browser, page
let holdNextRead = false, releaseRead
const errors = []
const bridgeCalls = []
try {
  cli('create', filePath)
  cli('add', filePath, '/body', '--type', 'paragraph', '--prop', 'text=Alpha ')
  cli('add', filePath, '/body/p[1]', '--type', 'run', '--prop', 'text=Beta', '--prop', 'bold=true')
  cli('add', filePath, '/body/p[1]', '--type', 'hyperlink', '--prop', 'text= Link', '--prop', 'url=https://example.com')
  const mapPreview = (data) => {
    if (data?.previewUrl) data.previewUrl = data.previewUrl.replace('zsense-office://preview/', '/__word-qa/preview/')
    if (data?.document) mapPreview(data.document)
    return data
  }
  const plugin = { name: 'office-word-isolated-qa', configureServer(vite) {
    vite.middlewares.use(async (request, response, next) => {
      const url = request.url || ''
      if (url.startsWith('/__word-qa/preview/')) {
        const preview = service.previewResponse(url.replace('/__word-qa/preview/', 'zsense-office://preview/'))
        response.setHeader('Content-Type', 'text/html; charset=utf-8')
        response.end(await preview.text()); return
      }
      if (url === '/__word-qa/') {
        response.setHeader('Content-Type', 'text/html; charset=utf-8')
        response.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script><script type="module" src="/scripts/fixtures/office-word-fixture.tsx"></script></body></html>'); return
      }
      if (!url.startsWith('/__word-qa/api/')) return next()
      response.setHeader('Content-Type', 'application/json')
      try {
        let body = ''; for await (const chunk of request) body += chunk
        const payload = body ? JSON.parse(body) : {}
        const action = url.split('/').at(-1)
        if (action === 'initial') { response.end(JSON.stringify({ ok: true, data: mapPreview(await service.open(filePath)) })); return }
        if (!['getWord', 'stageWordOperations', 'saveWord', 'discardWord'].includes(action)) throw new Error('Unexpected fixture action')
        const lifecycle = { action, startedAt: Date.now(), expectedRevision: payload.expectedRevision, operations: payload.operations?.map((operation) => ({ action: operation.action, text: operation.text })) }
        bridgeCalls.push(lifecycle)
        try {
          const data = mapPreview(await service[action]({ ...payload, filePath, sourceClientId: payload.clientId }))
          if (action === 'getWord' && holdNextRead) {
            holdNextRead = false
            await new Promise((resolve) => { releaseRead = resolve })
          }
          Object.assign(lifecycle, { completedAt: Date.now(), revision: data.revision ?? data.sessionRevision, dirty: data.dirty })
          response.end(JSON.stringify({ ok: true, data }))
        } catch (error) { Object.assign(lifecycle, { completedAt: Date.now(), error: error.message }); throw error }
      } catch (error) { response.end(JSON.stringify({ ok: false, error: error.message })) }
    })
  } }
  server = await createServer({ root: project, configFile: false, publicDir: false, cacheDir: path.join(temporary, 'vite'), plugins: [plugin, react()], logLevel: 'warn', server: { host: '127.0.0.1', port: 0, open: false, hmr: false } })
  await server.listen()
  let playwright
  try { playwright = await import('playwright/test') } catch {
    const entry = process.env.ZSENSE_PLAYWRIGHT_MODULE || path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs')
    playwright = await import(pathToFileURL(path.join(path.dirname(entry), 'test.mjs')).href)
  }
  const { chromium, expect } = playwright
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage({ viewport: { width: 1100, height: 900 } })
  page.on('pageerror', (error) => errors.push(error.message))
  page.setDefaultTimeout(15000)
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__word-qa/`, { waitUntil: 'networkidle' })
  const frame = page.frameLocator('iframe')
  const paragraph = frame.locator('.page-body [data-path]').first()
  await expect(paragraph).toHaveAttribute('contenteditable', 'true')
  await paragraph.evaluate((element) => {
    window.__wordFrameInstance = 'original-word-frame'
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    let node; while (walker.nextNode()) if (walker.currentNode.textContent === 'Beta') { node = walker.currentNode; break }
    const range = document.createRange(); range.setStart(node, 1); range.setEnd(node, 3)
    element.focus(); getSelection().removeAllRanges(); getSelection().addRange(range)
  })
  await expect(page.locator('.word-selection-status')).toContainText('已选 2 个字符')
  await page.getByRole('button', { name: '斜体', exact: true }).click()
  await expect(page.locator('.word-editor-save-state')).toContainText('1 项未保存修改')
  assert.equal(await paragraph.evaluate(() => window.__wordFrameInstance), 'original-word-frame', 'formatting must patch the existing iframe, not remount it')
  await expect(page.locator('.word-selection-status')).toContainText('已选 2 个字符')
  await paragraph.evaluate((element) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    let node; while (walker.nextNode()) if (walker.currentNode.textContent === ' Link') { node = walker.currentNode; break }
    const range = document.createRange(); range.setStart(node, 1); range.setEnd(node, 3)
    element.focus(); getSelection().removeAllRanges(); getSelection().addRange(range)
  })
  await expect.poll(async () => paragraph.evaluate(() => getSelection().toString())).toBe('Li')
  await page.getByRole('button', { name: '加粗', exact: true }).click()
  await expect(page.locator('.word-editor-save-state')).toContainText('2 项未保存修改')
  await page.getByTitle('手动保存（写回原文件）').click()
  await expect(page.getByTestId('word-feedback')).toContainText('保存并校验')
  const afterFormat = JSON.parse(cli('get', filePath, '/body/p[1]', '--depth', '2')).data.results[0]
  assert.equal(afterFormat.children.find((item) => item.text === 'et')?.format.italic, true)
  assert.notEqual(afterFormat.children.find((item) => item.text === 'B')?.format.italic, true)
  assert.equal(afterFormat.children.find((item) => item.text === 'Li')?.format.bold, true, 'separate range edits must not merge by paragraph path')
  assert.equal(afterFormat.children.find((item) => item.text === 'Li')?.format.url, 'https://example.com')

  const aiBase = await service.getWord({ filePath })
  const aiStage = await service.stageWordOperations({ filePath, operations: [{ action: 'setText', path: '/body/p[1]', text: 'Alpha Beta? Link', baseText: 'Alpha Beta Link' }], expectedRevision: aiBase.sessionRevision, source: 'agent', sourceClientId: 'word-ai-ui-test' })
  await page.evaluate((event) => window.__wordQa.emit(event), sessionEvents.at(-1))
  await expect(paragraph).toHaveText('Alpha Beta? Link')
  assert.equal(await paragraph.evaluate(() => window.__wordFrameInstance), 'original-word-frame', 'Agent staging must update the visible frame without remount')
  await service.saveWord({ filePath, expectedRevision: aiStage.revision, source: 'agent', sourceClientId: 'word-ai-ui-test' })
  await page.evaluate((event) => window.__wordQa.emit(event), sessionEvents.at(-1))
  await expect(page.getByTestId('word-dirty')).toHaveText('false')

  await paragraph.fill('Alpha Beta! Link')
  await expect(page.getByTestId('word-dirty')).toHaveText('true')
  await paragraph.press('Control+s')
  // The service and test share a Node loop. Synchronous CLI polling before the
  // save acknowledgement starves that very loop under a loaded full suite.
  // Wait for the actual dirty -> clean transition, then inspect persisted bytes once.
  await expect(page.getByTestId('word-dirty')).toHaveText('false')
  const persisted = JSON.parse(cli('get', filePath, '/body/p[1]', '--depth', '2')).data.results[0]
  assert.equal(persisted.text, 'Alpha Beta! Link')
  const hyperlinkRuns = persisted.children.filter((item) => item.format?.isHyperlink)
  assert.equal(hyperlinkRuns.map((item) => item.text).join(''), ' Link')
  assert(hyperlinkRuns.every((item) => item.format.url === 'https://example.com'))
  assert.equal(await paragraph.evaluate(() => window.__wordFrameInstance), 'original-word-frame', 'text save must retain the iframe instance')

  await paragraph.fill('My unsaved draft')
  await paragraph.press('Tab')
  await expect.poll(async () => (await service.getWord({ filePath })).operations.at(-1)?.text).toBe('My unsaved draft')
  cli('set', filePath, '/body/p[1]', '--prop', 'text=External edit')
  const externalBytes = fs.readFileSync(filePath)
  await page.getByTitle('手动保存（写回原文件）').click()
  await expect(page.getByTestId('word-feedback')).toContainText(/其他程序修改|原文件版本已变化/)
  await expect(page.getByTestId('word-dirty')).toHaveText('true')
  assert.equal(fs.readFileSync(filePath).equals(externalBytes), true, 'UI conflicted save must not overwrite an external edit')

  // An Agent update must never replace characters still being typed locally.
  await service.discardWord({ filePath })
  await page.reload({ waitUntil: 'networkidle' })
  await expect(paragraph).toHaveAttribute('contenteditable', 'true')
  await paragraph.fill('Local typing not committed')
  await expect(page.getByTestId('word-dirty')).toHaveText('true')
  const backgroundBase = await service.getWord({ filePath })
  const background = await service.stageWordOperations({ filePath, operations: [{ action: 'setText', path: '/body/p[1]', text: 'Agent background update' }], expectedRevision: backgroundBase.sessionRevision, source: 'agent', sourceClientId: 'word-ai-ui-test' })
  await page.evaluate((event) => window.__wordQa.emit(event), sessionEvents.at(-1))
  await expect(page.getByRole('alert')).toContainText('当前正在输入的草稿仍保留')
  await expect(paragraph).toHaveText('Local typing not committed')
  await service.saveWord({ filePath, expectedRevision: background.revision, source: 'agent', sourceClientId: 'word-ai-ui-test' })
  await page.evaluate((event) => window.__wordQa.emit(event), sessionEvents.at(-1))
  await expect(paragraph).toHaveText('Local typing not committed')
  await page.getByTitle('手动保存（写回原文件）').click()
  await expect(page.getByTestId('word-feedback')).toContainText('版本存在冲突')
  await expect(page.getByTestId('word-dirty')).toHaveText('true')
  assert.equal(JSON.parse(cli('get', filePath, '/body/p[1]', '--depth', '2')).data.results[0].text, 'Agent background update')

  // Deterministically hold a real Agent preview message, then deliver it after
  // native input. Parent refs cannot protect input whose postMessage is in flight.
  await service.discardWord({ filePath })
  await page.reload({ waitUntil: 'networkidle' })
  await expect(paragraph).toHaveAttribute('contenteditable', 'true')
  await paragraph.evaluate(() => {
    window.__heldWordPreview = null
    window.__holdWordPreview = true
    addEventListener('message', (event) => {
      if (event.source !== parent || event.data?.channel !== 'zsense-word-editor-v1' || event.data.type !== 'update-preview' || !window.__holdWordPreview) return
      event.stopImmediatePropagation()
      window.__heldWordPreview = event.data
      window.__holdWordPreview = false
    }, { capture: true })
  })
  const delayedBase = await service.getWord({ filePath })
  await service.stageWordOperations({ filePath, operations: [{ action: 'setText', path: '/body/p[1]', text: 'Older delayed Agent preview' }], expectedRevision: delayedBase.sessionRevision, source: 'agent', sourceClientId: 'word-delayed-preview-test' })
  await page.evaluate((event) => window.__wordQa.emit(event), sessionEvents.at(-1))
  await expect.poll(() => paragraph.evaluate(() => Boolean(window.__heldWordPreview))).toBe(true)
  await paragraph.fill('Newer native draft must survive')
  await expect(page.getByTestId('word-dirty')).toHaveText('true')
  await paragraph.evaluate(() => {
    const data = window.__heldWordPreview
    window.__heldWordPreview = null
    dispatchEvent(new MessageEvent('message', { data, source: parent }))
  })
  await expect(paragraph).toHaveText('Newer native draft must survive', { timeout: 2_000 })
  await expect(page.getByRole('alert')).toContainText('旧预览')
  const blockedCalls = bridgeCalls.length
  await paragraph.press('Control+s')
  await expect(page.getByTestId('word-feedback')).toContainText('版本存在冲突')
  await expect(page.getByTestId('word-dirty')).toHaveText('true')
  await expect(paragraph).toHaveText('Newer native draft must survive')
  assert.equal(bridgeCalls.length, blockedCalls, 'a rejected external preview must block stale stage/save instead of merely leaving visible text')
  assert.equal(JSON.parse(cli('get', filePath, '/body/p[1]', '--depth', '2')).data.results[0].text, 'Agent background update', 'a delayed preview must not write or discard local input')

  // Blur may have acknowledged a local stage, but that does not authorize an
  // Agent to replace it. Retain the original native baseline and operation list.
  await service.discardWord({ filePath })
  await page.reload({ waitUntil: 'networkidle' })
  await expect(paragraph).toHaveAttribute('contenteditable', 'true')
  await paragraph.fill('Local staged draft remains')
  await paragraph.press('Tab')
  await expect.poll(async () => (await service.getWord({ filePath })).operations.at(-1)?.text).toBe('Local staged draft remains')
  const stagedLocalBase = await service.getWord({ filePath })
  await service.stageWordOperations({ filePath, operations: [{ action: 'setText', path: '/body/p[1]', text: 'Agent replacing staged local draft' }], expectedRevision: stagedLocalBase.sessionRevision, source: 'agent', sourceClientId: 'word-staged-local-test' })
  await page.evaluate((event) => window.__wordQa.emit(event), sessionEvents.at(-1))
  await expect(page.getByRole('alert')).toContainText('草稿仍保留')
  await expect(paragraph).toHaveText('Local staged draft remains')
  const stagedConflictCalls = bridgeCalls.length
  await paragraph.press('Control+s')
  await expect(page.getByTestId('word-feedback')).toContainText('版本存在冲突')
  await expect(page.getByTestId('word-dirty')).toHaveText('true')
  assert.equal(bridgeCalls.length, stagedConflictCalls, 'acknowledged local staging remains a dirty draft, so an external replacement blocks stage/save')

  // A parent preview prop can race input without a session event. Hold the
  // actual read reply, then ensure adoption does not clear React's draft refs.
  await service.discardWord({ filePath })
  await page.reload({ waitUntil: 'networkidle' })
  await expect(paragraph).toHaveAttribute('contenteditable', 'true')
  const propsBase = await service.getWord({ filePath })
  const propsStage = await service.stageWordOperations({ filePath, operations: [{ action: 'setText', path: '/body/p[1]', text: 'Older props preview' }], expectedRevision: propsBase.sessionRevision, source: 'agent', sourceClientId: 'word-props-preview-test' })
  holdNextRead = true; releaseRead = undefined
  await page.evaluate((document) => window.__wordQa.setDocument(document), mapPreview(propsStage.document))
  await expect.poll(() => Boolean(releaseRead)).toBe(true)
  await paragraph.fill('Local props draft remains')
  await expect(page.getByTestId('word-dirty')).toHaveText('true')
  releaseRead()
  await expect(page.getByRole('alert')).toContainText('草稿仍保留')
  await expect(paragraph).toHaveText('Local props draft remains')
  const propsBlockedCalls = bridgeCalls.length
  await paragraph.press('Control+s')
  await expect(page.getByTestId('word-feedback')).toContainText('版本')
  await expect(page.getByTestId('word-dirty')).toHaveText('true')
  await expect(paragraph).toHaveText('Local props draft remains')
  assert.equal(bridgeCalls.length, propsBlockedCalls, 'a props conflict must preserve the local draft without submitting stale stage/save')
  assert.equal(JSON.parse(cli('get', filePath, '/body/p[1]', '--depth', '2')).data.results[0].text, 'Agent background update', 'conflicted props races must not overwrite disk')

  // Initial loading has no authoritative baseline yet: native editing must not
  // open until its real session read completes, rather than losing early input.
  await service.discardWord({ filePath })
  holdNextRead = true; releaseRead = undefined
  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect.poll(() => Boolean(releaseRead)).toBe(true)
  await expect(paragraph).not.toHaveAttribute('contenteditable', 'true')
  releaseRead()
  await expect(paragraph).toHaveAttribute('contenteditable', 'true')
  await expect(page.getByTestId('word-dirty')).toHaveText('false')
  assert.deepEqual(errors, [])
  await page.screenshot({ path: path.join(temporary, 'word-ui.png') })
  console.log('Word UI smoke passed: exact native selection, disjoint range formatting, Ctrl+S, rich text, iframe identity, Agent stage/save synchronization, local typing and external-conflict draft retention.')
} catch (error) {
  await page?.screenshot({ path: path.join(temporary, 'word-ui-failure.png') })
  console.error('Word fixture lifecycle:', JSON.stringify({ bridgeCalls, feedback: await page?.getByTestId('word-feedback').textContent().catch(() => ''), pageErrors: errors }))
  throw error
} finally {
  releaseRead?.()
  await browser?.close()
  await server?.close()
  if (process.argv.includes('--keep-artifacts')) console.log(`Word UI artifacts: ${temporary}`)
  else fs.rmSync(temporary, { recursive: true, force: true })
}
