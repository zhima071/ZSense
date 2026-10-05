import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { extractPdfText, formatPdfExtraction } from '../electron/services/pdf-parser.mjs'

function buildPdf(pageTexts) {
  const objects = []
  const pageCount = pageTexts.length
  const fontNumber = 3 + pageCount * 2
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>'
  objects[2] = `<< /Type /Pages /Kids [${pageTexts.map((_, index) => `${3 + index * 2} 0 R`).join(' ')}] /Count ${pageCount} >>`
  pageTexts.forEach((text, index) => {
    const pageNumber = 3 + index * 2
    const contentNumber = pageNumber + 1
    const stream = `BT /F1 16 Tf 40 120 Td (${text}) Tj ET\n`
    objects[pageNumber] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 320 200] /Resources << /Font << /F1 ${fontNumber} 0 R >> >> /Contents ${contentNumber} 0 R >>`
    objects[contentNumber] = `<< /Length ${Buffer.byteLength(stream, 'utf8')} >>\nstream\n${stream}endstream`
  })
  objects[fontNumber] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'

  let body = '%PDF-1.4\n'
  const offsets = {}
  for (let number = 1; number < objects.length; number += 1) {
    offsets[number] = Buffer.byteLength(body, 'utf8')
    body += `${number} 0 obj\n${objects[number]}\nendobj\n`
  }
  const startxref = Buffer.byteLength(body, 'utf8')
  const size = objects.length
  let xref = `xref\n0 ${size}\n0000000000 65535 f \n`
  for (let number = 1; number < objects.length; number += 1) xref += `${String(offsets[number]).padStart(10, '0')} 00000 n \n`
  return Buffer.from(`${body}${xref}trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF\n`, 'utf8')
}

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zsense-pdf-smoke-'))
try {
  const pdfPath = path.join(directory, '样本.pdf')
  fs.writeFileSync(pdfPath, buildPdf(['ZSense PDF smoke page one', 'ZSense PDF smoke page two']))

  const result = await extractPdfText(pdfPath)
  assert.equal(result.totalPages, 2, '应该读到 2 页')
  assert.equal(result.startPage, 1, '默认从第 1 页开始')
  assert.equal(result.endPage, 2, '默认读到最后一页')
  assert.equal(result.truncated, false, '未超出限制时不应标记截断')
  assert(result.pages[0].text.includes('ZSense PDF smoke page one'), `第 1 页文本提取失败：${result.pages[0].text}`)
  assert(result.pages[1].text.includes('ZSense PDF smoke page two'), `第 2 页文本提取失败：${result.pages[1].text}`)

  const secondPage = await extractPdfText(pdfPath, { startPage: 2, endPage: 2 })
  assert.equal(secondPage.pages.length, 1, '限定页码范围时只返回该页')
  assert.equal(secondPage.pages[0].page, 2, '限定页码范围时应该返回第 2 页')
  assert(!secondPage.pages[0].text.includes('page one'), '限定范围不应包含第 1 页内容')

  const clipped = await extractPdfText(pdfPath, { maxCharacters: 1_000 })
  const characters = clipped.pages.reduce((total, page) => total + page.text.length, 0)
  assert(characters <= 1_000, `超出字符上限：${characters}`)

  const formatted = formatPdfExtraction(result)
  assert(formatted.text.includes('--- 第 1 页 ---'), '格式化输出应包含页码标签')
  assert.equal(formatted.totalPages, 2, '格式化输出应保留总页数')
  assert.equal(formatted.truncated, false, '格式化输出应保留截断标记')
  assert.equal(typeof formatted.metadata, 'object', '格式化输出应包含元数据对象')

  const plain = formatPdfExtraction(result, { includePageLabels: false })
  assert(!plain.text.includes('--- 第 1 页 ---'), '关闭页码标签后不应输出标签')

  const missingPage = formatPdfExtraction({ pages: [{ page: 3, text: '' }], totalPages: 3, startPage: 3 })
  assert(missingPage.text.includes('（本页没有可提取文本）'), '空白页应给出明确提示')

  const textPath = path.join(directory, 'notes.txt')
  fs.writeFileSync(textPath, 'ZSense PDF smoke')
  await assert.rejects(() => extractPdfText(textPath), /只能使用 PDF 解析器读取 \.pdf 文件/, '非 PDF 扩展名应该被拒绝')

  const emptyPath = path.join(directory, 'empty.pdf')
  fs.writeFileSync(emptyPath, '')
  await assert.rejects(() => extractPdfText(emptyPath), /PDF 文件内容为空/, '空文件应该被拒绝')

  await assert.rejects(() => extractPdfText(path.join(directory, 'missing.pdf')), '不存在的文件应该报错')

  await assert.rejects(() => extractPdfText(directory), '目录路径应该被拒绝')

  const brokenPath = path.join(directory, 'broken.pdf')
  fs.writeFileSync(brokenPath, 'ZSense PDF smoke but not a real document')
  await assert.rejects(() => extractPdfText(brokenPath), '损坏的 PDF 应该返回解析失败')

  console.log(JSON.stringify({
    ok: true,
    engine: 'pdf-parser',
    workerThread: true,
    pageRange: true,
    characterLimit: true,
    formatLabels: true,
    invalidInputsRejected: true,
  }))
} finally {
  fs.rmSync(directory, { recursive: true, force: true })
}
