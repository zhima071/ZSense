import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { OfficeWorkspaceService } from '../electron/services/office-workspace-service.mjs'

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tool = path.join(project, 'bundled-tools', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'officecli.exe' : 'officecli')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zsense-office-word-regression-'))
const filePath = path.join(root, 'rich-text.docx')
const env = { ...process.env, OFFICECLI_NO_AUTO_RESIDENT: '1' }
const cli = (...args) => execFileSync(tool, [...args, '--json'], { env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
const raw = () => JSON.parse(cli('raw', filePath, '/document')).data
const node = () => JSON.parse(cli('get', filePath, '/body/p[1]', '--depth', '2')).data.results[0]
const hash = () => createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')

try {
  cli('create', filePath)
  cli('add', filePath, '/body', '--type', 'paragraph', '--prop', 'text=Alpha ')
  cli('add', filePath, '/body/p[1]', '--type', 'run', '--prop', 'text=Beta', '--prop', 'bold=true')
  cli('add', filePath, '/body/p[1]', '--type', 'hyperlink', '--prop', 'text= Link', '--prop', 'url=https://example.com')
  const service = new OfficeWorkspaceService({ userDataDirectory: path.join(root, 'user-data'), toolPaths: [tool] })
  const initial = await service.getWord({ filePath })
  const previewFile = [...service.previewTokens.values()].find((entry) => entry.kind === 'word-generated').filePath
  const previewMtime = fs.statSync(previewFile).mtimeMs
  const cached = await service.getWord({ filePath })
  assert.equal(cached.document.previewUrl, initial.document.previewUrl)
  assert.equal(fs.statSync(previewFile).mtimeMs, previewMtime, 'unchanged Word reads must not run the renderer again')

  const unchangedDisk = hash()
  const originalXml = raw()
  const linkId = /<w:hyperlink r:id="([^"]+)"/.exec(originalXml)[1]
  const operations = [{ action: 'setText', path: node().path, text: 'Alpha Beta! Link', baseText: 'Alpha Beta Link' }]
  const staged = await service.stageWordOperations({ filePath, operations, expectedContentHash: initial.baseContentHash, expectedRevision: initial.sessionRevision })
  assert.equal(hash(), unchangedDisk, 'staging must leave the source file byte-identical')
  assert.ok(staged.previewHtml, 'stage response supports in-frame preview patches')
  const stagedPreviewMtime = fs.statSync(previewFile).mtimeMs
  const identical = await service.stageWordOperations({ filePath, operations, expectedRevision: staged.revision })
  assert.equal(identical.revision, staged.revision, 'identical snapshots must not regenerate or bump revision')
  assert.equal(fs.statSync(previewFile).mtimeMs, stagedPreviewMtime)
  await service.saveWord({ filePath, expectedContentHash: initial.baseContentHash, expectedRevision: staged.revision })
  const saved = node()
  assert.equal(saved.text, 'Alpha Beta! Link', 'editing must not duplicate hyperlink text')
  assert.equal(saved.children.find((child) => child.text === 'Beta!')?.format.bold, true, 'bold run must survive adjacent insertion')
  assert.equal(saved.children.find((child) => child.text === ' Link')?.format.url, 'https://example.com')
  assert.match(raw(), new RegExp(`<w:hyperlink\\b[^>]*r:id="${linkId}"`), 'hyperlink carrier relationship remains unchanged')

  const rangeSession = await service.getWord({ filePath })
  await service.stageWordOperations({ filePath, operations: [{ action: 'formatText', path: saved.path, range: { start: 1, end: 4 }, options: { italic: true } }], expectedContentHash: rangeSession.baseContentHash })
  await service.saveWord({ filePath })
  const ranged = node()
  assert.equal(ranged.children.find((child) => child.text === 'lph')?.format.italic, true, 'formatting applies only to exact range')
  assert.notEqual(ranged.children.find((child) => child.text === 'A')?.format.italic, true)
  assert.equal(ranged.children.find((child) => child.text === 'Beta!')?.format.bold, true)
  assert.equal(ranged.children.find((child) => child.text === ' Link')?.format.url, 'https://example.com')

  const editSession = await service.getWord({ filePath })
  const rangeEdit = await service.stageWordOperations({ filePath, operations: [{ action: 'setText', path: ranged.path, range: { start: 6, end: 10 }, text: 'Gamma', baseText: 'Alpha Beta! Link' }], expectedRevision: editSession.sessionRevision })
  await service.saveWord({ filePath, expectedRevision: rangeEdit.revision })
  assert.equal(node().text, 'Alpha Gamma! Link')
  assert.equal(node().children.find((child) => child.text === ' Link')?.format.url, 'https://example.com')

  const conflictSession = await service.getWord({ filePath })
  const draftOps = [{ action: 'setText', path: '/body/p[1]', text: 'Editor draft' }]
  await service.stageWordOperations({ filePath, operations: draftOps, expectedContentHash: conflictSession.baseContentHash })
  cli('set', filePath, '/body/p[1]', '--prop', 'text=External update')
  const externalHash = hash()
  const conflicted = await service.getWord({ filePath })
  assert.equal(conflicted.dirty, true, 'external changes must not delete the draft')
  assert.equal(conflicted.operations[0].text, 'Editor draft')
  assert.equal(conflicted.conflict.code, 'OFFICE_EXTERNAL_CONFLICT')
  await service.stageWordOperations({ filePath, operations: [{ action: 'setText', path: '/body/p[1]', text: 'Editor draft revised' }], expectedContentHash: conflictSession.baseContentHash })
  await assert.rejects(() => service.saveWord({ filePath, expectedContentHash: conflictSession.baseContentHash }), /其他程序修改|外部修改/)
  assert.equal(hash(), externalHash, 'failed conflicted save must preserve external file bytes')
  assert.equal((await service.getWord({ filePath })).operations[0].text, 'Editor draft revised')
  await assert.rejects(() => service.stageWordOperations({ filePath, operations: [], expectedContentHash: 'obsolete' }), /版本已变化/)
  const reloaded = await service.discardWord({ filePath })
  assert.equal(reloaded.dirty, false)
  assert.equal(reloaded.conflict, undefined)
  assert.equal(reloaded.baseContentHash, externalHash)

  const baseline = await service.getWord({ filePath })
  const changed = await service.stageWordOperations({ filePath, operations: [{ action: 'setText', path: '/body/p[1]', text: 'Only newest editor' }], expectedRevision: baseline.sessionRevision })
  await assert.rejects(() => service.stageWordOperations({ filePath, operations: [{ action: 'setText', path: '/body/p[1]', text: 'Stale editor' }], expectedRevision: baseline.sessionRevision }), /其他编辑器/)
  await assert.rejects(() => service.saveWord({ filePath, expectedRevision: baseline.sessionRevision }), /草稿版本/)
  assert.equal((await service.getWord({ filePath })).sessionRevision, changed.revision)
  const runtime = (await service.previewResponse(changed.document.previewUrl).text()).match(/<script data-zsense-word-editor-runtime>([\s\S]*?)<\/script>/)?.[1]
  assert.ok(runtime)
  assert.doesNotThrow(() => new Function(runtime))
  assert.match(runtime, /update-preview/)
  assert.match(runtime, /restoreRange/)
  console.log('Word regression passed: rich text, links, exact range, conflict preservation, revision guard, unchanged-preview cache.')
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
