import fs from 'node:fs'
import path from 'node:path'
import { Worker } from 'node:worker_threads'

const workerUrl = new URL('./pdf-parser-worker.mjs', import.meta.url)

export async function extractPdfText(filePath, { startPage = 1, endPage = 80, maxCharacters = 80_000, timeoutMs = 90_000 } = {}) {
  const resolvedPath = fs.realpathSync.native(path.resolve(String(filePath || '')))
  const stats = fs.statSync(resolvedPath)
  if (!stats.isFile()) throw new Error('PDF 路径不是文件。')
  if (stats.size <= 0) throw new Error('PDF 文件内容为空。')
  if (path.extname(resolvedPath).toLowerCase() !== '.pdf') throw new Error('只能使用 PDF 解析器读取 .pdf 文件。')

  return new Promise((resolve, reject) => {
    const worker = new Worker(workerUrl, {
      workerData: {
        filePath: resolvedPath,
        startPage: Math.max(1, Math.floor(Number(startPage) || 1)),
        endPage: Math.max(1, Math.floor(Number(endPage) || 80)),
        maxCharacters: Math.max(1_000, Math.floor(Number(maxCharacters) || 80_000)),
      },
    })
    let settled = false
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      worker.removeAllListeners()
      void worker.terminate()
      if (error) reject(error)
      else resolve(value)
    }
    const timer = setTimeout(() => finish(new Error('PDF 本地解析超时，请缩小页码范围后重试。')), Math.max(5_000, Number(timeoutMs) || 90_000))
    timer.unref?.()
    worker.once('message', (message) => {
      if (!message?.ok) finish(new Error(`PDF 本地解析失败：${String(message?.error || '未知错误')}`))
      else finish(null, message.result)
    })
    worker.once('error', (error) => finish(error))
    worker.once('exit', (code) => { if (!settled && code !== 0) finish(new Error(`PDF 解析进程异常退出（${code}）。`)) })
  })
}

export function formatPdfExtraction(result, { includePageLabels = true } = {}) {
  const pages = Array.isArray(result?.pages) ? result.pages : []
  const body = pages.map((page) => includePageLabels ? `--- 第 ${page.page} 页 ---\n${page.text || '（本页没有可提取文本）'}` : page.text || '').join('\n\n')
  return {
    totalPages: Number(result?.totalPages || 0),
    startPage: Number(result?.startPage || 1),
    endPage: Number(result?.endPage || result?.startPage || 1),
    metadata: result?.metadata || {},
    truncated: Boolean(result?.truncated),
    text: body,
  }
}
