import { DOMParser, XMLSerializer } from '@xmldom/xmldom'

const WORD_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const WORD_ID_NS = 'http://schemas.microsoft.com/office/word/2010/wordml'
const XML_NS = 'http://www.w3.org/XML/1998/namespace'

function children(element, localName) {
  return Array.from(element.childNodes || []).filter((node) => node.nodeType === 1 && node.namespaceURI === WORD_NS && node.localName === localName)
}

function resolveWordElement(document, path) {
  let element = document.documentElement
  for (const part of path.split('/').filter(Boolean)) {
    if (part === 'body') { element = children(element, 'body')[0]; continue }
    const match = /^(\w+)\[(?:(\d+)|@paraId=([A-Fa-f0-9]{8}))\]$/.exec(part)
    if (!match || !element) throw new Error('Word 编辑位置已失效，请重新选择正文。')
    const tag = { row: 'tr', cell: 'tc', picture: 'drawing' }[match[1]] || match[1]
    const candidates = tag === 'r' && element.localName === 'p'
      ? Array.from(element.getElementsByTagNameNS(WORD_NS, 'r')).filter((node) => {
        let parent = node.parentNode
        while (parent && parent !== element) { if (parent.localName === 'p') return false; parent = parent.parentNode }
        return parent === element
      })
      : children(element, tag)
    element = match[3] ? candidates.find((node) => node.getAttributeNS(WORD_ID_NS, 'paraId') === match[3]) : candidates[Number(match[2]) - 1]
  }
  if (!element) throw new Error('Word 编辑位置已失效，请重新选择正文。')
  return element
}

function textTokens(element) {
  const tokens = []
  const walk = (node) => {
    if (node.nodeType !== 1) return
    // Field instructions, tracked deletions, drawings and nested paragraphs are
    // not editable text in this paragraph. Leave those carriers untouched.
    if (node !== element && (['del', 'drawing', 'pict', 'instrText', 'p'].includes(node.localName))) return
    if (node.namespaceURI === WORD_NS && ['t', 'tab', 'br', 'cr'].includes(node.localName)) {
      tokens.push({ node, text: node.localName === 't' ? node.textContent || '' : node.localName === 'tab' ? '\t' : '\n' })
      return
    }
    for (const child of Array.from(node.childNodes || [])) walk(child)
  }
  walk(element)
  return tokens
}

function setTokenText(document, node, text) {
  const parent = node.parentNode
  if (!parent) return
  const pieces = text.split(/([\n\t])/)
  for (const piece of pieces) {
    if (!piece) continue
    const replacement = document.createElementNS(WORD_NS, piece === '\n' ? 'w:br' : piece === '\t' ? 'w:tab' : 'w:t')
    if (piece !== '\n' && piece !== '\t') {
      replacement.setAttributeNS(XML_NS, 'xml:space', 'preserve')
      replacement.appendChild(document.createTextNode(piece))
    }
    parent.insertBefore(replacement, node)
  }
  parent.removeChild(node)
}

function minimalChange(before, after) {
  let start = 0
  while (start < before.length && start < after.length && before[start] === after[start]) start += 1
  let end = before.length
  let replacementEnd = after.length
  while (end > start && replacementEnd > start && before[end - 1] === after[replacementEnd - 1]) { end -= 1; replacementEnd -= 1 }
  // Do not bisect surrogate pairs when calculating a minimal replacement.
  if (start > 0 && /[\uDC00-\uDFFF]/.test(before[start] || after[start] || '')) start -= 1
  if (end < before.length && /[\uDC00-\uDFFF]/.test(before[end])) { end += 1; replacementEnd += 1 }
  return { start, end, replacement: after.slice(start, replacementEnd) }
}

/** Only replace the changed characters; never flatten runs or hyperlink nodes. */
export function wordTextReplacementCommand(xml, operation) {
  if (typeof xml !== 'string' || !xml || /<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('Word 正文 XML 无效。')
  let parseFailed = false
  const document = new DOMParser({ errorHandler: { warning: () => undefined, error: () => { parseFailed = true }, fatalError: () => { parseFailed = true } } }).parseFromString(xml, 'application/xml')
  if (parseFailed) throw new Error('Word 正文 XML 解析失败，未修改文件。')
  const element = resolveWordElement(document, operation.path)
  const tokens = textTokens(element)
  const before = tokens.map((token) => token.text).join('')
  if (operation.baseText !== undefined && operation.baseText !== before) throw new Error('Word 选区对应的正文已变化，请刷新选区后重试；草稿仍保留。')
  const change = operation.range
    ? { ...operation.range, replacement: operation.text || '' }
    : minimalChange(before, operation.text || '')
  if (change.start < 0 || change.end < change.start || change.end > before.length) throw new Error('Word 字符范围已失效，请重新选择正文。')
  if (before.slice(change.start, change.end) === change.replacement) return null
  let offset = 0
  let inserted = false
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    const tokenStart = offset
    const tokenEnd = offset + token.text.length
    offset = tokenEnd
    const insertionHere = !inserted && change.start >= tokenStart && change.start <= tokenEnd
    const intersects = tokenStart < change.end && tokenEnd > change.start
    if (!insertionHere && !intersects) continue
    const prefix = token.text.slice(0, Math.max(0, change.start - tokenStart))
    const suffix = token.text.slice(Math.max(0, change.end - tokenStart))
    const insertedText = insertionHere ? change.replacement : ''
    if (insertionHere) inserted = true
    setTokenText(document, token.node, prefix + insertedText + suffix)
  }
  if (!inserted) {
    const run = document.createElementNS(WORD_NS, 'w:r')
    const text = document.createElementNS(WORD_NS, 'w:t')
    run.appendChild(text)
    element.appendChild(run)
    setTokenText(document, text, change.replacement)
  }
  // The CLI exposes paragraph runs as a flattened list (hyperlink runs count
  // too). Resolve first, then derive the true carrier XPath from the XML DOM.
  const segments = []
  let current = element
  while (current?.nodeType === 1) {
    const id = current.localName === 'p' && current.getAttributeNS(WORD_ID_NS, 'paraId')
    const siblings = current.parentNode?.nodeType === 1 ? children(current.parentNode, current.localName) : [current]
    segments.unshift(id && /^[A-Fa-f0-9]{8}$/.test(id) ? `w:p[@w14:paraId='${id}']` : `w:${current.localName}[${siblings.indexOf(current) + 1}]`)
    current = current.parentNode
  }
  const xpath = '/' + segments.join('/')
  return { command: 'raw-set', part: '/document', xpath, action: 'replace', xml: new XMLSerializer().serializeToString(element) }
}
