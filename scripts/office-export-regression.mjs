import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { OfficeWorkspaceService } from '../electron/services/office-workspace-service.mjs'
import { normalizeOfficeCommandArgs, officeCommandFile, officeCommandOutputFiles } from '../electron/services/office-command-runner.mjs'
import { validateOfficeCliArguments } from '../electron/services/zsense-agent-core.mjs'

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zsense-office-export-'))
let calls = 0
const service = new OfficeWorkspaceService({ userDataDirectory: temporaryRoot, toolPaths: [process.execPath], commandRunner: async (_executable, args, { cwd } = {}) => {
  calls += 1
  for (const filePath of officeCommandOutputFiles(args, cwd)) fs.writeFileSync(filePath, path.extname(filePath) === '.pdf' ? '%PDF-1.4\n%%EOF\n' : '<!doctype html><html><body>Export fixture</body></html>')
  return { stdout: JSON.stringify({ success: true }), stderr: '' }
} })

try {
  const source = path.join(temporaryRoot, 'source.xlsx')
  const target = path.join(temporaryRoot, 'dirty.csv')
  const dirtyHtml = path.join(temporaryRoot, 'dirty.html')
  fs.writeFileSync(source, 'Isolated Office source fixture')
  fs.writeFileSync(target, 'value\n1\n')
  fs.writeFileSync(dirtyHtml, '<html><body>baseline</body></html>')
  const canonicalSource = fs.realpathSync.native(source)
  const baseline = fs.readFileSync(source)
  assert.deepEqual(normalizeOfficeCommandArgs(['--json', 'view', 'source.xlsx', 'html']), ['view', 'source.xlsx', 'html', '--json'])
  assert.equal(officeCommandFile(['--json', 'get', target]), fs.realpathSync.native(target), 'CSV shared sessions need canonical per-file queue keys')
  assert.deepEqual(officeCommandOutputFiles(['view', 'source.xlsx', 'html', '--out=ok.html'], temporaryRoot), [path.join(fs.realpathSync.native(temporaryRoot), 'ok.html')])
  for (const flag of ['-o', '--out', '--output']) {
    for (const separator of ['=', ':', ...(flag === '-o' ? [''] : [])]) {
      assert.throws(() => validateOfficeCliArguments(['view', 'source.xlsx', 'html', `${flag}${separator}/tmp/out.html`]), /相对路径/)
      assert.throws(() => validateOfficeCliArguments(['view', 'source.xlsx', 'html', `${flag}${separator}../out.html`]), /相对路径/)
    }
  }

  const workspace = path.join(temporaryRoot, 'workspace')
  const external = path.join(temporaryRoot, 'outside')
  fs.mkdirSync(workspace)
  fs.mkdirSync(external)
  fs.copyFileSync(source, path.join(workspace, 'source.xlsx'))
  fs.copyFileSync(source, path.join(external, 'source.xlsx'))
  fs.writeFileSync(path.join(external, 'source.csv'), 'value\n1\n')
  fs.symlinkSync(external, path.join(workspace, 'linked-outside'), 'dir')
  fs.symlinkSync(path.join(external, 'source.csv'), path.join(workspace, 'linked-source.csv'))
  assert.deepEqual(validateOfficeCliArguments(['view', 'source.xlsx', 'html', '--out=new/nested.html'], workspace), ['view', 'source.xlsx', 'html', '--out=new/nested.html'])
  assert.throws(() => validateOfficeCliArguments(['view', 'linked-outside/source.xlsx', 'text'], workspace), /工作区外部/)
  assert.throws(() => validateOfficeCliArguments(['view', 'source.xlsx', 'html', '--out=linked-outside/new.html'], workspace), /工作区外部/)
  assert.throws(() => validateOfficeCliArguments(['view', 'source.xlsx', 'html', '-o', 'linked-outside/not-created/new.html'], workspace), /工作区外部/)
  assert.throws(() => validateOfficeCliArguments(['merge', 'source.xlsx', 'linked-outside/new.xlsx'], workspace), /工作区外部/)
  assert.throws(() => validateOfficeCliArguments(['create', 'linked-outside/new.xlsx'], workspace), /工作区外部/)
  assert.throws(() => validateOfficeCliArguments(['import', 'source.xlsx', '/Sheet1', '--file', 'linked-outside/source.csv'], workspace), /工作区外部/)
  assert.throws(() => validateOfficeCliArguments(['import', 'source.xlsx', '/Sheet1', '--file=linked-source.csv'], workspace), /工作区外部/)
  assert.throws(() => validateOfficeCliArguments(['import', 'source.xlsx', '/Sheet1', '--file:linked-source.csv'], workspace), /工作区外部/)
  assert.deepEqual(validateOfficeCliArguments(['set', 'source.xlsx', '/Sheet1/A1', '--prop', 'value=测试'], workspace), ['set', 'source.xlsx', '/Sheet1/A1', '--prop', 'value=测试'])

  for (const flags of [['-o', source], ['--out', source], [`--out=${source}`], [`-o=${source}`], [`--output=${source}`], [`--out:${source}`], [`--output:${source}`], [`-o:${source}`], [`-o${source}`]]) {
    await assert.rejects(service.runOfficeCommand(['--json', 'view', source, 'html', ...flags]), /不能覆盖/)
  }
  for (const extension of ['docx', 'xlsx', 'pptx', 'doc', 'xls', 'ppt', 'XLSX']) {
    await assert.rejects(service.runOfficeCommand(['dump', source, '/', '--out', path.join(temporaryRoot, `other.${extension}`)]), /不能覆盖/)
  }
  const alias = path.join(temporaryRoot, 'source-alias.html')
  fs.symlinkSync(source, alias)
  await assert.rejects(service.runOfficeCommand(['view', source, 'html', '-o', alias]), /不能覆盖/, 'Symlink export aliases must not bypass source protection')
  const hardLink = path.join(temporaryRoot, 'source-hardlink.html')
  fs.linkSync(source, hardLink)
  await assert.rejects(service.runOfficeCommand(['view', source, 'html', '-o', hardLink]), /不能覆盖/, 'Hardlink export aliases must not bypass source protection')

  const csv = await service.getWorkbook({ filePath: target })
  await service.stageCells({ filePath: target, changes: [{ sheet: csv.sheets[0].sheet, cell: 'A1', value: 'draft' }] })
  await service.stageHtml({ filePath: dirtyHtml, source: '<html><body>draft</body></html>' })
  for (const output of [target, dirtyHtml]) await assert.rejects(service.runOfficeCommand(['view', source, 'html', '-o', output]), /尚未保存/)
  for (const output of [target, dirtyHtml]) for (const flag of [`--out:${output}`, `-o:${output}`, `-o${output}`]) await assert.rejects(service.runOfficeCommand(['view', source, 'html', flag]), /尚未保存/)
  for (const output of [alias, hardLink]) for (const flag of [`--out:${output}`, `-o:${output}`, `-o${output}`]) await assert.rejects(service.runOfficeCommand(['view', source, 'html', flag]), /不能覆盖/)
  assert.equal(calls, 0, 'Unsafe export must reject before starting any subprocess')
  assert.deepEqual(fs.readFileSync(source), baseline)
  assert.equal(fs.readFileSync(target, 'utf8'), 'value\n1\n')
  assert.equal(fs.readFileSync(dirtyHtml, 'utf8'), '<html><body>baseline</body></html>')

  const allowedHtml = path.join(temporaryRoot, 'safe.html')
  const allowedPdf = path.join(temporaryRoot, 'safe.pdf')
  const allowedCsv = path.join(temporaryRoot, 'safe.csv')
  for (const output of [allowedHtml, allowedPdf, allowedCsv]) await service.runOfficeCommand(['view', source, path.extname(output).slice(1), `--out=${output}`])
  assert.equal(calls, 3, 'Distinct clean HTML/PDF/CSV exports remain permitted (guard fixture, not format fidelity testing)')
  assert.ok(fs.existsSync(allowedHtml) && fs.existsSync(allowedPdf) && fs.existsSync(allowedCsv))
  const spaced = path.join(temporaryRoot, 'new exported file with spaces.html')
  const quoted = path.join(temporaryRoot, 'new "quoted" exported file.html')
  const namedOutputs = process.platform === 'win32' ? [spaced] : [spaced, quoted]
  for (const [index, output] of namedOutputs.entries()) await service.runOfficeCommand(['view', source, 'html', index ? `-o${output}` : `--out:${output}`])
  assert.ok(namedOutputs.every((output) => fs.existsSync(output)), 'Argument arrays must preserve spaces and platform-valid literal quotes without shell parsing')
  assert.deepEqual(fs.readFileSync(canonicalSource), baseline)
  assert.equal(service.saveQueues.size, 0, 'Export queues must be released after success or rejection')
  console.log('Office export regression passed: output option/path-boundary validation, symlink-directory escape prevention, source/symlink/hardlink protection, dirty/Office-file overwrite guards, permitted distinct exports and queue cleanup')
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true })
}
