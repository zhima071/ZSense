import { unwrapDesktop } from './desktop'

const MAX_CLIPBOARD_TEXT_LENGTH = 2_000_000

function writeWithSelectionFallback(content: string) {
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
  const textarea = document.createElement('textarea')
  textarea.value = content
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.inset = '-9999px auto auto -9999px'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.select()
  const copied = document.execCommand('copy')
  textarea.remove()
  previousFocus?.focus()
  if (!copied) throw new Error('系统剪贴板不可用')
}

export async function writeTextToClipboard(content: string) {
  if (!content || content.length > MAX_CLIPBOARD_TEXT_LENGTH) throw new Error('复制内容为空或超过 2,000,000 个字符。')

  // 局域网网页访问（浏览器）里要复制到“用户自己这台设备”的剪贴板，
  // 不能用桌面通道（那会写到运行 ZSense 的那台机器的剪贴板）。
  if ((window.zsenseDesktop as { transport?: string } | undefined)?.transport === 'web-bridge') {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard API unavailable')
      await navigator.clipboard.writeText(content)
      return
    } catch {
      writeWithSelectionFallback(content)
      return
    }
  }

  if (window.zsenseDesktop?.clipboard) {
    await unwrapDesktop(window.zsenseDesktop.clipboard.writeText(content))
    return
  }

  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard API unavailable')
    await navigator.clipboard.writeText(content)
  } catch {
    writeWithSelectionFallback(content)
  }
}

