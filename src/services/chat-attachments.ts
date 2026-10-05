import type { ClipboardEvent, DragEvent } from 'react'
import { useRef, useState } from 'react'
import type { ChatAttachment } from '../types'
import { unwrapDesktop } from './desktop'

const ATTACHMENT_LIMIT = 8

export function mergeChatAttachments(current: ChatAttachment[], additions: ChatAttachment[]) {
  const merged = [...current]
  for (const attachment of additions) {
    if (!merged.some((item) => (item.path && item.path === attachment.path) || item.id === attachment.id)) merged.push(attachment)
  }
  if (merged.length > ATTACHMENT_LIMIT) throw new Error(`每次最多添加 ${ATTACHMENT_LIMIT} 个附件。`)
  return merged
}

interface ChatAttachmentDropOptions {
  disabled: boolean
  attachments: ChatAttachment[]
  onAttachmentsChange: (attachments: ChatAttachment[]) => void
  onError: (message: string) => void
}

export function useChatAttachmentDrop({ disabled, attachments, onAttachmentsChange, onError }: ChatAttachmentDropOptions) {
  const [draggingFiles, setDraggingFiles] = useState(false)
  const dragDepthRef = useRef(0)

  const containsFiles = (event: DragEvent<HTMLElement>) => Array.from(event.dataTransfer.types || []).includes('Files')
  const onDragEnter = (event: DragEvent<HTMLElement>) => {
    if (!containsFiles(event)) return
    event.preventDefault()
    dragDepthRef.current += 1
    if (!disabled) setDraggingFiles(true)
  }
  const onDragOver = (event: DragEvent<HTMLElement>) => {
    if (!containsFiles(event)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = disabled ? 'none' : 'copy'
  }
  const onDragLeave = (event: DragEvent<HTMLElement>) => {
    if (!containsFiles(event)) return
    event.preventDefault()
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
    if (dragDepthRef.current === 0) setDraggingFiles(false)
  }
  const onDrop = async (event: DragEvent<HTMLElement>) => {
    if (!containsFiles(event)) return
    event.preventDefault()
    dragDepthRef.current = 0
    setDraggingFiles(false)
    if (disabled) return
    const files = Array.from(event.dataTransfer.files || [])
    if (!files.length) return
    if (!window.zsenseDesktop?.chat.resolveDroppedAttachments) {
      onError('拖入文件只在 ZSense 桌面应用中可用。')
      return
    }
    try {
      const dropped = await unwrapDesktop(window.zsenseDesktop.chat.resolveDroppedAttachments(files))
      onAttachmentsChange(mergeChatAttachments(attachments, dropped))
    } catch (error) {
      onError(error instanceof Error ? error.message : '添加拖入文件失败。')
    }
  }

  return { draggingFiles, dropHandlers: { onDragEnter, onDragOver, onDragLeave, onDrop } }
}

interface ChatAttachmentPasteOptions extends ChatAttachmentDropOptions {
  workspacePath: string
}

export function useChatAttachmentPaste({ disabled, attachments, workspacePath, onAttachmentsChange, onError }: ChatAttachmentPasteOptions) {
  const onPaste = async (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const itemImages = Array.from(event.clipboardData.items || [])
      .filter((item) => item.kind === 'file' && item.type.toLowerCase().startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file))
    const images = itemImages.length
      ? itemImages
      : Array.from(event.clipboardData.files || []).filter((file) => file.type.toLowerCase().startsWith('image/'))
    if (!images.length) return

    event.preventDefault()
    if (disabled) {
      onError('当前状态暂时不能添加图片，请等待本轮回复结束后重试。')
      return
    }
    if (!workspacePath) {
      onError('请先为这个对话选择工作区文件夹，再粘贴图片。')
      return
    }
    if (attachments.length + images.length > ATTACHMENT_LIMIT) {
      onError(`每次最多添加 ${ATTACHMENT_LIMIT} 个附件。`)
      return
    }
    if (!window.zsenseDesktop?.chat.resolvePastedAttachments) {
      onError('粘贴图片只在 ZSense 桌面应用中可用。')
      return
    }

    try {
      onError('')
      const pasted = await unwrapDesktop(window.zsenseDesktop.chat.resolvePastedAttachments(images, workspacePath))
      onAttachmentsChange(mergeChatAttachments(attachments, pasted))
    } catch (error) {
      onError(error instanceof Error ? error.message : '粘贴图片失败。')
    }
  }

  return { onPaste }
}
