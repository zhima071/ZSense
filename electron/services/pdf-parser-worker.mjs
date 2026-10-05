import fs from 'node:fs/promises'
import { parentPort, workerData } from 'node:worker_threads'
import { getDocumentProxy } from 'unpdf'

function normalizedPageText(items = []) {
  let output = ''
  for (const item of items) {
    if (!item || typeof item.str !== 'string' || !item.str) continue
    output += item.str
    output += item.hasEOL ? '\n' : ' '
  }
  return output
    .replace(/[ \t]+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

async function parse() {
  const bytes = await fs.readFile(workerData.filePath)
  const document = await getDocumentProxy(new Uint8Array(bytes), {
    isEvalSupported: false,
    maxImageSize: 16_777_216,
    useSystemFonts: true,
  })
  const totalPages = document.numPages
  const startPage = Math.max(1, Math.min(totalPages, Number(workerData.startPage) || 1))
  const requestedEnd = Number(workerData.endPage) || totalPages
  const endPage = Math.max(startPage, Math.min(totalPages, requestedEnd))
  const maximumCharacters = Math.max(1_000, Math.min(500_000, Number(workerData.maxCharacters) || 80_000))
  const pages = []
  let characters = 0
  let truncated = false

  try {
    for (let pageNumber = startPage; pageNumber <= endPage; pageNumber += 1) {
      const page = await document.getPage(pageNumber)
      const content = await page.getTextContent({ includeMarkedContent: false })
      const pageText = normalizedPageText(content.items)
      const remaining = maximumCharacters - characters
      const clipped = pageText.slice(0, Math.max(0, remaining))
      pages.push({ page: pageNumber, text: clipped })
      characters += clipped.length
      page.cleanup?.()
      if (clipped.length < pageText.length || characters >= maximumCharacters) {
        truncated = pageNumber < endPage || clipped.length < pageText.length
        break
      }
    }

    let metadata = {}
    try {
      const result = await document.getMetadata()
      metadata = {
        title: String(result?.info?.Title || '').slice(0, 500),
        author: String(result?.info?.Author || '').slice(0, 500),
        subject: String(result?.info?.Subject || '').slice(0, 1_000),
      }
    } catch { /* Metadata is optional. */ }

    return { totalPages, startPage, endPage: pages.at(-1)?.page || startPage, pages, metadata, truncated }
  } finally {
    await document.destroy?.()
  }
}

parse()
  .then((result) => parentPort?.postMessage({ ok: true, result }))
  .catch((error) => parentPort?.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) }))
