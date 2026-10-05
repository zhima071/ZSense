import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const STAGING_DIRECTORY = path.join('.zsense', 'attachments')
const PASTED_IMAGE_EXTENSIONS = new Map([
  ['image/png', '.png'],
  ['image/jpeg', '.jpg'],
  ['image/gif', '.gif'],
  ['image/webp', '.webp'],
  ['image/bmp', '.bmp'],
  ['image/tiff', '.tiff'],
])

function isInside(root, target) {
  const relative = path.relative(root, target)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function safeAttachmentName(value) {
  const original = path.basename(String(value || 'attachment')).normalize('NFKC')
  const sanitized = original
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_')
    .replace(/^\.+/, '')
    .trim()
  return (sanitized || 'attachment').slice(-160)
}

function ensureStagingRoot(workspacePath) {
  const workspaceRoot = fs.realpathSync.native(path.resolve(workspacePath))
  if (!fs.statSync(workspaceRoot).isDirectory()) throw new Error('会话工作区不是文件夹。')

  const privateRoot = path.join(workspaceRoot, '.zsense')
  if (fs.existsSync(privateRoot)) {
    const privateInfo = fs.lstatSync(privateRoot)
    if (privateInfo.isSymbolicLink() || !privateInfo.isDirectory()) throw new Error('工作区中的 .zsense 必须是真实文件夹，不能是文件或符号链接。')
  } else {
    fs.mkdirSync(privateRoot, { mode: 0o700 })
  }
  const requestedStagingRoot = path.join(workspaceRoot, STAGING_DIRECTORY)
  if (fs.existsSync(requestedStagingRoot)) {
    const stagingInfo = fs.lstatSync(requestedStagingRoot)
    if (stagingInfo.isSymbolicLink() || !stagingInfo.isDirectory()) throw new Error('工作区附件目录必须是真实文件夹，不能是文件或符号链接。')
  } else {
    fs.mkdirSync(requestedStagingRoot, { mode: 0o700 })
  }
  const stagingRoot = fs.realpathSync.native(requestedStagingRoot)
  if (!isInside(workspaceRoot, stagingRoot)) throw new Error('附件目录通过链接指向了工作区外部，请移除工作区中的 .zsense 链接后重试。')
  return { workspaceRoot, stagingRoot }
}

function pastedImageExtension(image) {
  const mimeType = String(image?.mimeType || '').toLowerCase().split(';', 1)[0].trim()
  const extension = PASTED_IMAGE_EXTENSIONS.get(mimeType)
  if (!extension) throw new Error('剪贴板中包含不支持的图片格式，请使用 PNG、JPEG、GIF、WebP、BMP 或 TIFF。')
  return extension
}

function hasExpectedImageSignature(bytes, extension) {
  if (extension === '.png') return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  if (extension === '.jpg') return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  if (extension === '.gif') return bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))
  if (extension === '.webp') return bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  if (extension === '.bmp') return bytes.length >= 2 && bytes.subarray(0, 2).toString('ascii') === 'BM'
  if (extension === '.tiff') return bytes.length >= 4 && (bytes.subarray(0, 4).equals(Buffer.from([0x49, 0x49, 0x2a, 0x00])) || bytes.subarray(0, 4).equals(Buffer.from([0x4d, 0x4d, 0x00, 0x2a])))
  return false
}

export function stagePastedImageAttachments(images, workspacePath) {
  if (!images?.length) return []
  const { stagingRoot } = ensureStagingRoot(workspacePath)
  const createdFiles = []
  try {
    return images.map((image, index) => {
      const extension = pastedImageExtension(image)
      const bytes = Buffer.isBuffer(image?.bytes) ? image.bytes : Buffer.from(image?.bytes || [])
      if (!hasExpectedImageSignature(bytes, extension)) throw new Error('剪贴板图片内容无效或格式与文件类型不一致。')
      const originalName = safeAttachmentName(image?.name || `粘贴的图片-${index + 1}${extension}`)
      const fileName = path.extname(originalName).toLowerCase() === extension ? originalName : `${path.parse(originalName).name || `粘贴的图片-${index + 1}`}${extension}`
      const destination = path.join(stagingRoot, `${Date.now()}-${randomUUID()}-${fileName}`)
      fs.writeFileSync(destination, bytes, { flag: 'wx', mode: 0o600 })
      createdFiles.push(destination)
      return destination
    })
  } catch (error) {
    for (const createdFile of createdFiles) {
      try { fs.rmSync(createdFile, { force: true }) } catch { /* best-effort rollback of files created by this call */ }
    }
    throw error
  }
}

/**
 * Copies user-selected files into the conversation workspace so every agent
 * tool can access them through a stable, workspace-relative path.
 */
export function stageChatAttachments(attachments, workspacePath) {
  if (!attachments?.length) return []
  const { workspaceRoot, stagingRoot } = ensureStagingRoot(workspacePath)

  const createdFiles = []
  try {
    return attachments.map((attachment) => {
      const requestedSource = path.resolve(String(attachment?.path || ''))
      const sourceInfo = fs.lstatSync(requestedSource)
      if (sourceInfo.isSymbolicLink()) throw new Error(`附件不支持符号链接：${path.basename(requestedSource)}`)
      const source = fs.realpathSync.native(requestedSource)
      const sourceStats = fs.statSync(source)
      if (!sourceStats.isFile()) throw new Error(`附件不是文件：${path.basename(source)}`)

      if (isInside(stagingRoot, source)) {
        return {
          ...attachment,
          path: source,
          workspaceRelativePath: path.relative(workspaceRoot, source),
        }
      }

      const destination = path.join(stagingRoot, `${Date.now()}-${randomUUID()}-${safeAttachmentName(attachment.name || source)}`)
      fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL)
      createdFiles.push(destination)
      return {
        ...attachment,
        path: destination,
        workspaceRelativePath: path.relative(workspaceRoot, destination),
      }
    })
  } catch (error) {
    for (const createdFile of createdFiles) {
      try { fs.rmSync(createdFile, { force: true }) } catch { /* best-effort rollback of files created by this call */ }
    }
    throw error
  }
}
