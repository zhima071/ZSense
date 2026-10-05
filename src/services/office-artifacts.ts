const EDITABLE_ARTIFACT_EXTENSION = /\.(?:docx|xlsx|csv|tsv|pptx|doc|xls|ppt)$/i
const IMAGE_ARTIFACT_EXTENSION = /\.(?:png|jpe?g|gif|webp|bmp|tiff?|svg|ico)$/i
const PDF_ARTIFACT_EXTENSION = /\.pdf$/i
const HTML_ARTIFACT_EXTENSION = /\.(?:html?|xhtml)$/i

export function isOfficeDocumentPath(filePath: string | undefined): boolean {
  if (!filePath) return false
  return EDITABLE_ARTIFACT_EXTENSION.test(filePath.split(/[?#]/, 1)[0])
}

export function isImageDocumentPath(filePath: string | undefined): boolean {
  if (!filePath) return false
  return IMAGE_ARTIFACT_EXTENSION.test(filePath.split(/[?#]/, 1)[0])
}

export function isCanvasDocumentPath(filePath: string | undefined): boolean {
  if (!filePath) return false
  return IMAGE_ARTIFACT_EXTENSION.test(filePath.split(/[?#]/, 1)[0])
}

export function isPdfDocumentPath(filePath: string | undefined): boolean {
  if (!filePath) return false
  return PDF_ARTIFACT_EXTENSION.test(filePath.split(/[?#]/, 1)[0])
}

export function isHtmlDocumentPath(filePath: string | undefined): boolean {
  if (!filePath) return false
  return HTML_ARTIFACT_EXTENSION.test(filePath.split(/[?#]/, 1)[0])
}

export function isPreviewableDocumentPath(filePath: string | undefined): boolean {
  return isOfficeDocumentPath(filePath) || isCanvasDocumentPath(filePath) || isPdfDocumentPath(filePath) || isHtmlDocumentPath(filePath)
}

export function officeDocumentPathFromHref(href: string | undefined, workspacePath: string): string {
  return localDocumentPathFromHref(href, workspacePath, isOfficeDocumentPath)
}

export function previewableDocumentPathFromHref(href: string | undefined, workspacePath: string): string {
  return localDocumentPathFromHref(href, workspacePath, isPreviewableDocumentPath)
}

export function imageDocumentPathFromHref(href: string | undefined, workspacePath: string): string {
  return localDocumentPathFromHref(href, workspacePath, isImageDocumentPath)
}

function localDocumentPathFromHref(href: string | undefined, workspacePath: string, supported: (candidate: string) => boolean): string {
  if (!href) return ''
  let candidate = href.trim().replace(/^<|>$/g, '')
  if (!candidate || candidate.startsWith('#')) return ''
  try {
    if (/^file:\/\//i.test(candidate)) {
      const url = new URL(candidate)
      if (url.hostname && url.hostname !== 'localhost') return ''
      candidate = decodeURIComponent(url.pathname)
      if (/^\/[A-Za-z]:\//.test(candidate)) candidate = candidate.slice(1)
    } else {
      if (/^[a-z][a-z\d+.-]*:/i.test(candidate)) return ''
      candidate = decodeURIComponent(candidate.split(/[?#]/, 1)[0])
    }
  } catch {
    return ''
  }
  if (!supported(candidate)) return ''
  if (/^(?:\/|[A-Za-z]:[\\/])/.test(candidate)) return candidate
  if (!workspacePath) return ''
  const separator = workspacePath.includes('\\') ? '\\' : '/'
  return `${workspacePath.replace(/[\\/]+$/, '')}${separator}${candidate.replace(/^\.\.?[\\/]+/, '')}`
}
