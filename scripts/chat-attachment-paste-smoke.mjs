import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { stagePastedImageAttachments } from '../electron/services/chat-attachment-service.mjs'

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'zsense-paste-test-'))
const realWorkspace = fs.realpathSync.native(workspace)
const ipcSource = fs.readFileSync(new URL('../electron/ipc.mjs', import.meta.url), 'utf8')
const attachmentUiSource = fs.readFileSync(new URL('../src/services/chat-attachments.ts', import.meta.url), 'utf8')

try {
  const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01])
  const [filePath] = stagePastedImageAttachments([{
    name: '../屏幕截图',
    mimeType: 'image/png',
    bytes: pngBytes,
  }], workspace)

  assert(filePath.startsWith(path.join(realWorkspace, '.zsense', 'attachments')), '粘贴图片没有写入当前会话工作区')
  assert.equal(path.extname(filePath), '.png', '粘贴图片没有使用与 MIME 匹配的扩展名')
  assert.deepEqual(fs.readFileSync(filePath), pngBytes, '粘贴图片写入后内容发生变化')
  assert(!path.basename(filePath).includes('..'), '粘贴图片名称没有清理路径穿越字符')
  assert(!ipcSource.includes('attachmentFileSizeLimit') && !ipcSource.includes('attachmentTotalSizeLimit'), '主进程仍保留对话附件大小限制')
  assert(!attachmentUiSource.includes('ATTACHMENT_TOTAL_SIZE_LIMIT'), '前端仍保留对话附件总大小限制')

  assert.throws(() => stagePastedImageAttachments([{
    name: '伪装图片.png',
    mimeType: 'image/png',
    bytes: Buffer.from('not-an-image'),
  }], workspace), /内容无效|格式与文件类型不一致/, '伪装成图片的无效内容未被拒绝')

  console.log(JSON.stringify({ ok: true, savedInsideWorkspace: true, signatureValidation: true, crossPlatformPathSafety: true }))
} finally {
  fs.rmSync(workspace, { recursive: true, force: true })
}
