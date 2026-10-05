import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { OfficeWorkspaceService } from '../electron/services/office-workspace-service.mjs'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zsense-inline-image-'))
const workspace = path.join(root, 'workspace')
const outside = path.join(root, 'outside.png')
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')

try {
  fs.mkdirSync(workspace)
  fs.writeFileSync(path.join(workspace, 'lark-auth-qr.png'), png)
  fs.writeFileSync(outside, png)
  fs.writeFileSync(path.join(workspace, 'note.txt'), 'not an image')
  const service = new OfficeWorkspaceService({ userDataDirectory: root })
  const first = service.inlineImage({ workspacePath: workspace, filePath: 'lark-auth-qr.png' })
  const second = service.inlineImage({ workspacePath: workspace, filePath: path.join(workspace, 'lark-auth-qr.png') })
  assert.equal(first.previewUrl, second.previewUrl, '重复显示同一文件应复用预览令牌')
  assert.match(first.previewUrl, /^zsense-office:\/\/preview\/[a-f0-9]{32}\?v=/)
  assert(!first.previewUrl.includes(workspace), '预览 URL 不得暴露工作区绝对路径')
  const response = service.previewResponse(first.previewUrl)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'image/png')
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), png)
  assert.throws(() => service.inlineImage({ workspacePath: workspace, filePath: outside }), /只允许预览当前会话工作区内的图片/)
  assert.throws(() => service.inlineImage({ workspacePath: workspace, filePath: '../outside.png' }), /只允许预览当前会话工作区内的图片/)
  assert.throws(() => service.inlineImage({ workspacePath: workspace, filePath: 'note.txt' }), /支持图片|只允许预览当前会话工作区内的图片/)
  if (process.platform !== 'win32') {
    fs.symlinkSync(outside, path.join(workspace, 'linked.png'))
    assert.throws(() => service.inlineImage({ workspacePath: workspace, filePath: 'linked.png' }), /只允许预览当前会话工作区内的图片/)
    const original = path.join(workspace, 'lark-auth-qr.png')
    const backup = path.join(workspace, 'original.png')
    fs.renameSync(original, backup)
    fs.symlinkSync(outside, original)
    assert.equal(service.previewResponse(first.previewUrl).status, 403, '预览创建后替换成越界软链接也必须拒绝')
  }
  console.log('会话本地图片预览、路径隔离与响应检查通过。')
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
