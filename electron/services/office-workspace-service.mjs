import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const MODERN_EXTENSIONS = new Map([
  ['.docx', 'word'],
  ['.xlsx', 'excel'],
  ['.csv', 'excel'],
  ['.tsv', 'excel'],
  ['.pptx', 'powerpoint'],
  ['.html', 'html'],
  ['.htm', 'html'],
  ['.xhtml', 'html'],
  ['.pdf', 'pdf'],
])
const LEGACY_EXTENSIONS = new Set(['.doc', '.xls', '.ppt'])
const HTML_EXTENSIONS = new Set(['.html', '.htm', '.xhtml'])
const DELIMITED_EXTENSIONS = new Set(['.csv', '.tsv'])
const IMAGE_EXTENSIONS = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.bmp', 'image/bmp'],
  ['.tif', 'image/tiff'],
  ['.tiff', 'image/tiff'],
  ['.svg', 'image/svg+xml'],
  ['.ico', 'image/x-icon'],
])
const ALL_EXTENSIONS = new Set([...MODERN_EXTENSIONS.keys(), ...LEGACY_EXTENSIONS, ...IMAGE_EXTENSIONS.keys()])
const MAX_FILE_BYTES = 500 * 1024 * 1024
const MAX_IMAGE_BYTES = 100 * 1024 * 1024
const MAX_TEXT_BYTES = 50_000
const MAX_HTML_BYTES = 8 * 1024 * 1024
const WORD_MAX_OPERATIONS = 500
const MAX_DISCOVERY_FILES = 5_000
const EXCEL_MIN_ROWS = 1_000
const EXCEL_MIN_COLUMNS = 26
const EXCEL_ROW_BUFFER = 100
const EXCEL_COLUMN_BUFFER = 5
const EXCEL_MAX_CHANGES = 20_000
const EXCEL_MAX_OPERATIONS = 500
const EXCEL_BATCH_SIZE = 200
const DISCOVERY_IGNORED_DIRECTORIES = new Set(['.git', '.hg', '.svn', 'node_modules', '__pycache__', '.venv', 'venv'])
const OFFICE_THEME_COLORS = new Set(['DK1', 'LT1', 'DK2', 'LT2', 'ACCENT1', 'ACCENT2', 'ACCENT3', 'ACCENT4', 'ACCENT5', 'ACCENT6', 'HLINK', 'FOLHLINK', 'HYPERLINK', 'FOLLOWEDHYPERLINK'])

function compactError(error) {
  return [error?.stdout, error?.stderr, error?.message]
    .filter(Boolean)
    .join('\n')
    .replace(/\u001b\[[0-9;]*m/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line, index, lines) => lines.indexOf(line) === index)
    .join('\n')
    .slice(0, 3_000)
}

function officeKind(extension) {
  if (IMAGE_EXTENSIONS.has(extension)) return 'image'
  return MODERN_EXTENSIONS.get(extension) || 'legacy'
}

function parseJson(value) {
  try { return JSON.parse(value) } catch { return null }
}

function safeText(value, label, { allowEmpty = false, maximum = MAX_TEXT_BYTES } = {}) {
  if (typeof value !== 'string') throw new Error(`${label}必须是文本。`)
  if (!allowEmpty && !value.trim()) throw new Error(`请填写${label}。`)
  if (Buffer.byteLength(value, 'utf8') > maximum) throw new Error(`${label}内容过长。`)
  return value
}

function safeSheetName(value) {
  const sheetName = safeText(value, '工作表名称', { maximum: 128 }).trim()
  if (/[\\/?*:[\]\x00-\x1f]/.test(sheetName)) throw new Error('工作表名称包含无效字符。')
  return sheetName
}

function safeCellAddress(value) {
  const cellAddress = safeText(value, '单元格地址', { maximum: 16 }).trim().toUpperCase()
  if (!/^[A-Z]{1,3}[1-9]\d{0,6}$/.test(cellAddress)) throw new Error('单元格地址格式无效，例如 A1、B12。')
  return cellAddress
}

function safeCellRange(value, label = '单元格范围') {
  const range = safeText(value, label, { maximum: 40 }).trim().toUpperCase()
  if (!/^[A-Z]{1,3}[1-9]\d{0,6}(?::[A-Z]{1,3}[1-9]\d{0,6})?$/.test(range)) throw new Error(`${label}格式无效，例如 A1:D20。`)
  return range
}

function safeIdentifier(value, label, fallback = '') {
  const normalized = typeof value === 'string' ? value.trim() : ''
  const candidate = normalized || fallback
  if (!/^[A-Za-z_\\][A-Za-z0-9_.\\]{0,126}$/.test(candidate) || /^[A-Za-z]{1,3}[1-9]\d*$/.test(candidate)) throw new Error(`${label}格式无效，请使用字母开头并仅包含字母、数字、下划线或点。`)
  return candidate
}

function safeInteger(value, label, minimum, maximum) {
  const number = Number(value)
  if (!Number.isInteger(number) || number < minimum || number > maximum) throw new Error(`${label}必须是 ${minimum} 到 ${maximum} 之间的整数。`)
  return number
}

function safeNumber(value, label, minimum, maximum) {
  const number = Number(value)
  if (!Number.isFinite(number) || number < minimum || number > maximum) throw new Error(`${label}必须在 ${minimum} 到 ${maximum} 之间。`)
  return number
}

function columnNameFromIndex(index) {
  let current = safeInteger(index, '列序号', 0, 16_383) + 1
  let name = ''
  while (current > 0) {
    const remainder = (current - 1) % 26
    name = String.fromCharCode(65 + remainder) + name
    current = Math.floor((current - 1) / 26)
  }
  return name
}

function rangeBounds(range) {
  const [start, end = start] = safeCellRange(range).split(':')
  return {
    start,
    end,
    startRow: rowIndexFromAddress(start),
    endRow: rowIndexFromAddress(end),
    startColumn: columnIndexFromAddress(start),
    endColumn: columnIndexFromAddress(end),
  }
}

function compactProps(value, allowedKeys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => allowedKeys.has(key) && ['string', 'number', 'boolean'].includes(typeof item) ? [[key, item]] : []))
}

function normalizeWorkbookOperation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Excel 功能操作格式无效。')
  const action = safeText(value.action, 'Excel 功能名称', { maximum: 80 }).trim()
  const sheet = value.sheet === undefined ? '' : safeSheetName(value.sheet)
  const range = value.range === undefined ? '' : safeCellRange(value.range)
  const options = value.options && typeof value.options === 'object' && !Array.isArray(value.options) ? value.options : {}
  const atSheet = sheet ? `/${sheet}` : ''
  const named = (prefix) => safeIdentifier(value.name, `${prefix}名称`, `${prefix}_${Date.now().toString(36)}`)
  const addObject = (type, props) => [{ command: 'add', parent: atSheet, type, props }]
  let commands
  let key = `${action}:${sheet}:${range}:${Date.now()}:${Math.random()}`

  switch (action) {
    case 'insertRows': {
      const index = safeInteger(value.index, '插入行位置', 0, 1_048_575)
      const count = safeInteger(value.count ?? 1, '插入行数', 1, 1_000)
      commands = Array.from({ length: count }, () => ({ command: 'add', parent: atSheet, type: 'row', before: `${atSheet}/row[${index + 1}]` }))
      break
    }
    case 'insertColumns': {
      const index = safeInteger(value.index, '插入列位置', 0, 16_383)
      const count = safeInteger(value.count ?? 1, '插入列数', 1, 200)
      commands = Array.from({ length: count }, () => ({ command: 'add', parent: atSheet, type: 'column', before: `${atSheet}/col[${columnNameFromIndex(index)}]` }))
      break
    }
    case 'mergeCells':
    case 'unmergeCells':
      commands = [{ command: 'set', path: `${atSheet}/${range}`, props: { merge: action === 'mergeCells' } }]
      key = `merge:${sheet}:${range}`
      break
    case 'addFilter':
      commands = addObject('autofilter', { range })
      key = `filter:${sheet}`
      break
    case 'sortRange': {
      const bounds = rangeBounds(range)
      const index = safeInteger(value.index ?? 0, '排序列', 0, bounds.endColumn - bounds.startColumn)
      const direction = value.direction === 'desc' ? 'desc' : 'asc'
      commands = [{ command: 'set', path: atSheet, props: { sort: `${columnNameFromIndex(bounds.startColumn + index)} ${direction}` } }]
      break
    }
    case 'addConditionalFormatting': {
      const type = ['cellIs', 'colorScale', 'dataBar', 'containsText', 'topN', 'duplicateValues', 'uniqueValues'].includes(value.mode) ? value.mode : 'cellIs'
      const props = { type, ref: range, ...compactProps(options, new Set(['operator', 'value', 'value2', 'text', 'rank', 'fill', 'color', 'minColor', 'midColor', 'maxColor'])) }
      commands = addObject('conditionalformatting', props)
      break
    }
    case 'addValidation': {
      const type = ['list', 'whole', 'decimal', 'date', 'time', 'textlength', 'custom'].includes(value.mode) ? value.mode : 'list'
      const props = { type, ref: range, allowBlank: options.allowBlank !== false, ...compactProps(options, new Set(['operator', 'formula1', 'formula2', 'errorTitle', 'error', 'inCellDropdown'])) }
      commands = addObject('validation', props)
      break
    }
    case 'addTable':
      commands = addObject('table', { ref: range, name: named('Table'), style: ['medium1', 'medium2', 'medium3', 'medium4', 'light1', 'light2', 'light3', 'dark1', 'dark2', 'none'].includes(value.mode) ? value.mode : 'medium2', headerRow: true })
      break
    case 'addHyperlink': {
      const target = safeText(value.value, '链接地址', { maximum: 4_000 }).trim()
      const cell = rangeBounds(range).start
      commands = [{ command: 'set', path: `${atSheet}/${cell}`, props: { link: target, display: typeof value.secondaryValue === 'string' && value.secondaryValue.trim() ? value.secondaryValue.trim().slice(0, 500) : target } }]
      key = `hyperlink:${sheet}:${cell}`
      break
    }
    case 'addPicture': {
      const imagePath = path.resolve(safeText(value.value, '图片路径', { maximum: 4_000 }).trim())
      if (!fs.existsSync(imagePath) || !fs.statSync(imagePath).isFile() || !/^\.(png|jpe?g|webp|gif|bmp|tiff?)$/i.test(path.extname(imagePath))) throw new Error('选择的图片不存在或格式不受支持。')
      commands = addObject('picture', { src: imagePath, anchor: range, name: named('Picture') })
      break
    }
    case 'addChart': {
      const chartType = ['bar', 'column', 'line', 'pie', 'doughnut', 'area', 'scatter', 'radar', 'waterfall', 'funnel', 'treemap', 'sunburst', 'histogram', 'pareto'].includes(value.mode) ? value.mode : 'column'
      commands = addObject('chart', { chartType, dataRange: `${sheet}!${range}`, title: String(value.value || '数据图表').slice(0, 300), x: '1cm', y: '1cm', width: '14cm', height: '8cm' })
      break
    }
    case 'addSparkline':
      commands = addObject('sparkline', { type: ['line', 'column', 'winloss'].includes(value.mode) ? value.mode : 'line', dataRange: range, location: safeCellAddress(value.target), color: normalizeColor(options.color) || '#2563EB' })
      break
    case 'addShape':
      commands = addObject('shape', { geometry: ['rect', 'roundRect', 'ellipse', 'triangle', 'diamond', 'rightArrow'].includes(value.mode) ? value.mode : 'roundRect', text: String(value.value || '文本').slice(0, 1_000), x: safeNumber(options.x ?? 1, '水平位置', 0, 16_383), y: safeNumber(options.y ?? 1, '垂直位置', 0, 1_048_575), width: safeNumber(options.width ?? 4, '形状宽度', 1, 100), height: safeNumber(options.height ?? 3, '形状高度', 1, 100), fill: normalizeColor(options.fill) || '#DBEAFE' })
      break
    case 'addPivotTable': {
      const props = { source: `${sheet}!${range}`, position: safeCellAddress(value.target), name: named('Pivot'), style: 'PivotStyleMedium9', rows: safeText(options.rows, '行字段', { maximum: 1_000 }), values: safeText(options.values, '值字段', { maximum: 1_000 }) }
      if (typeof options.cols === 'string' && options.cols.trim()) props.cols = options.cols.trim().slice(0, 1_000)
      if (typeof options.filters === 'string' && options.filters.trim()) props.filters = options.filters.trim().slice(0, 1_000)
      commands = addObject('pivottable', props)
      break
    }
    case 'addNamedRange':
      commands = [{ command: 'add', parent: '/', type: 'namedrange', props: { name: named('Range'), ref: `${sheet}!${range}`, scope: 'workbook', comment: String(value.value || '').slice(0, 500) } }]
      key = `namedrange:${value.name}`
      break
    case 'groupRows': {
      const bounds = rangeBounds(range)
      commands = Array.from({ length: bounds.endRow - bounds.startRow + 1 }, (_, offset) => ({ command: 'set', path: `${atSheet}/row[${bounds.startRow + offset + 1}]`, props: { outline: safeInteger(value.count ?? 1, '分组级别', 1, 7) } }))
      key = `groupRows:${sheet}:${range}`
      break
    }
    case 'groupColumns': {
      const bounds = rangeBounds(range)
      commands = Array.from({ length: bounds.endColumn - bounds.startColumn + 1 }, (_, offset) => ({ command: 'set', path: `${atSheet}/col[${columnNameFromIndex(bounds.startColumn + offset)}]`, props: { outline: safeInteger(value.count ?? 1, '分组级别', 1, 7) } }))
      key = `groupColumns:${sheet}:${range}`
      break
    }
    case 'setRowHeight': {
      const bounds = rangeBounds(range)
      const height = safeNumber(value.size, '行高', 2, 409)
      commands = Array.from({ length: bounds.endRow - bounds.startRow + 1 }, (_, offset) => ({ command: 'set', path: `${atSheet}/row[${bounds.startRow + offset + 1}]`, props: { height } }))
      key = `rowHeight:${sheet}:${range}`
      break
    }
    case 'setColumnWidth': {
      const bounds = rangeBounds(range)
      const width = safeNumber(value.size, '列宽', 1, 255)
      commands = Array.from({ length: bounds.endColumn - bounds.startColumn + 1 }, (_, offset) => ({ command: 'set', path: `${atSheet}/col[${columnNameFromIndex(bounds.startColumn + offset)}]`, props: { width } }))
      key = `columnWidth:${sheet}:${range}`
      break
    }
    case 'setFreeze':
      commands = [{ command: 'set', path: atSheet, props: { freeze: value.target ? safeCellAddress(value.target) : 'none' } }]
      key = `freeze:${sheet}`
      break
    case 'setZoom':
      commands = [{ command: 'set', path: atSheet, props: { zoom: safeInteger(value.size, '显示比例', 10, 400) } }]
      key = `zoom:${sheet}`
      break
    case 'setCalculationMode':
      commands = [{ command: 'set', path: '/', props: { 'calc.mode': ['auto', 'manual', 'autoExceptTables'].includes(value.mode) ? value.mode : 'auto' } }]
      key = 'calculationMode'
      break
    default:
      throw new Error(`暂不支持 Excel 功能“${action}”。`)
  }
  if (!commands?.length || commands.length > EXCEL_MAX_OPERATIONS) throw new Error('Excel 功能操作数量超出安全限制。')
  return {
    key,
    operation: {
      action,
      ...(sheet ? { sheet } : {}),
      ...(range ? { range } : {}),
      ...(value.target ? { target: String(value.target) } : {}),
      ...(value.name ? { name: String(value.name) } : {}),
      ...(value.value !== undefined ? { value: String(value.value) } : {}),
      ...(value.mode ? { mode: String(value.mode) } : {}),
    },
    commands,
  }
}

function safeWordPath(value, { allowBody = false } = {}) {
  const wordPath = safeText(value, 'Word 内容路径', { maximum: 320 }).trim()
  if (allowBody && wordPath === '/body') return wordPath
  if (!/^\/body\/(?:p|tbl)\[[1-9]\d*\](?:\/(?:p|r|hyperlink|picture|tbl|row|cell)\[[1-9]\d*\])*$/.test(wordPath)) {
    throw new Error('Word 内容路径无效，请重新选择正文内容。')
  }
  return wordPath
}

function normalizeWordOperation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Word 编辑操作格式无效。')
  const action = safeText(value.action, 'Word 操作名称', { maximum: 80 }).trim()
  const options = value.options && typeof value.options === 'object' && !Array.isArray(value.options) ? value.options : {}
  const pathValue = value.path === undefined ? '' : safeWordPath(value.path)
  const textValue = typeof value.text === 'string' ? value.text.slice(0, MAX_TEXT_BYTES) : ''
  let command

  if (action === 'setText') {
    if (!pathValue) throw new Error('请先选择要编辑的 Word 段落。')
    command = { command: 'set', path: pathValue, props: { text: textValue } }
  } else if (action === 'formatText') {
    if (!pathValue) throw new Error('请先选择要设置格式的 Word 段落。')
    const props = {}
    if (typeof options.font === 'string' && options.font.trim()) props.font = options.font.trim().slice(0, 160)
    if (typeof options.size === 'string' && /^(?:[6-9]|[1-8]\d|9[0-6])(?:\.\d+)?pt$/.test(options.size)) props.size = options.size
    if (typeof options.bold === 'boolean') props.bold = options.bold
    if (typeof options.italic === 'boolean') props.italic = options.italic
    if (typeof options.underline === 'boolean') props.underline = options.underline
    if (typeof options.strike === 'boolean') props.strike = options.strike
    const color = normalizeColor(options.color)
    if (color) props.color = color
    const highlight = normalizeColor(options.highlight)
    if (highlight) props.highlight = highlight
    if (!Object.keys(props).length) throw new Error('没有可应用的文字格式。')
    command = { command: 'set', path: pathValue, props }
  } else if (action === 'formatParagraph') {
    if (!pathValue) throw new Error('请先选择要设置格式的 Word 段落。')
    const props = {}
    if (['left', 'center', 'right', 'justify'].includes(options.align)) props.align = options.align
    if (['Normal', 'Title', 'Subtitle', 'Heading 1', 'Heading 2', 'Heading 3', 'Quote'].includes(options.style)) props.style = options.style
    if (['none', 'bullet', 'number'].includes(options.listStyle)) props.listStyle = options.listStyle
    for (const key of ['indent', 'firstLineIndent', 'lineSpacing', 'spaceBefore', 'spaceAfter']) {
      if (typeof options[key] === 'string' && /^-?\d+(?:\.\d+)?(?:pt|cm|in|%)?$/.test(options[key])) props[key] = options[key]
    }
    if (!Object.keys(props).length) throw new Error('没有可应用的段落格式。')
    command = { command: 'set', path: pathValue, props }
  } else if (action === 'insertParagraph') {
    command = { command: 'add', parent: '/body', type: 'paragraph', props: { text: textValue || '新段落' } }
    if (pathValue) command.after = pathValue
  } else if (action === 'insertTable') {
    const rows = safeInteger(options.rows ?? 3, '表格行数', 1, 50)
    const cols = safeInteger(options.cols ?? 3, '表格列数', 1, 20)
    command = { command: 'add', parent: '/body', type: 'table', props: { rows, cols } }
    if (pathValue) command.after = pathValue
  } else if (action === 'insertImage') {
    const imagePath = path.resolve(safeText(value.filePath, '图片路径', { maximum: 4_000 }).trim())
    if (!fs.existsSync(imagePath) || !fs.statSync(imagePath).isFile() || !/^\.(png|jpe?g|webp|gif|bmp|tiff?)$/i.test(path.extname(imagePath))) throw new Error('选择的图片不存在或格式不受支持。')
    command = { command: 'add', parent: '/body', type: 'picture', props: { src: imagePath, width: typeof options.width === 'string' ? options.width.slice(0, 24) : '12cm', alt: textValue.slice(0, 500) } }
    if (pathValue) command.after = pathValue
  } else if (action === 'insertLink') {
    if (!pathValue) throw new Error('请先选择用于插入链接的段落。')
    const url = safeText(value.url, '链接地址', { maximum: 4_000 }).trim()
    if (!/^(?:https?:\/\/|mailto:)/i.test(url)) throw new Error('链接地址必须以 http://、https:// 或 mailto: 开头。')
    command = { command: 'add', parent: pathValue, type: 'hyperlink', props: { url, text: textValue || url } }
  } else if (action === 'insertPageBreak') {
    command = { command: 'add', parent: pathValue || '/body', type: 'pagebreak', props: { type: 'page' } }
  } else if (action === 'setHeader' || action === 'setFooter') {
    command = { command: 'add', parent: '/', type: action === 'setHeader' ? 'header' : 'footer', props: { text: textValue } }
  } else if (action === 'insertToc') {
    command = { command: 'add', parent: '/body', type: 'toc', props: { title: textValue || '目录' } }
    if (pathValue) command.after = pathValue
  } else if (action === 'addComment') {
    if (!pathValue) throw new Error('请先选择要添加批注的段落。')
    command = { command: 'add', parent: pathValue, type: 'comment', props: { text: textValue, author: 'ZSense' } }
  } else if (action === 'removeBlock') {
    if (!pathValue) throw new Error('请先选择要删除的内容。')
    command = { command: 'remove', path: pathValue }
  } else {
    throw new Error(`暂不支持 Word 操作“${action}”。`)
  }
  return {
    action,
    ...(pathValue ? { path: pathValue } : {}),
    ...(textValue ? { text: textValue } : {}),
    ...(typeof value.filePath === 'string' ? { filePath: value.filePath } : {}),
    ...(typeof value.url === 'string' ? { url: value.url } : {}),
    ...(Object.keys(options).length ? { options } : {}),
    command,
  }
}

function columnIndexFromAddress(address) {
  const columnName = String(address || '').match(/^[A-Z]+/)?.[0] || 'A'
  let index = 0
  for (const character of columnName) index = index * 26 + character.charCodeAt(0) - 64
  return Math.max(0, index - 1)
}

function rowIndexFromAddress(address) {
  return Math.max(0, Number(String(address || '').match(/[1-9]\d*$/)?.[0] || 1) - 1)
}

function normalizeColor(value) {
  const color = typeof value === 'string' ? value.trim() : ''
  if (!color || color.toLowerCase() === 'none') return ''
  const themeColor = color.replace(/^#/, '').toUpperCase()
  if (OFFICE_THEME_COLORS.has(themeColor)) return themeColor
  const hex = color.replace(/^#/, '')
  if (/^(?:[0-9A-F]{3}|[0-9A-F]{4}|[0-9A-F]{6}|[0-9A-F]{8})$/i.test(hex)) return `#${hex.toUpperCase()}`
  if (/^(?:rgb|rgba|hsl|hsla)\([^\r\n]{1,120}\)$/i.test(color) || /^[a-z]+$/i.test(color)) return color.toLowerCase()
  return ''
}

function officeStyleFromFormat(format) {
  if (!format || typeof format !== 'object') return undefined
  const fontSize = Number.parseFloat(String(format['font.size'] || ''))
  const style = {
    fontName: typeof format['font.name'] === 'string' ? format['font.name'] : '',
    fontSize: Number.isFinite(fontSize) ? fontSize : undefined,
    bold: typeof format['font.bold'] === 'boolean' ? format['font.bold'] : undefined,
    italic: typeof format['font.italic'] === 'boolean' ? format['font.italic'] : undefined,
    underline: typeof format.underline === 'string' ? format.underline : '',
    strike: typeof format.strike === 'boolean' ? format.strike : undefined,
    fontColor: normalizeColor(format['font.color']),
    fill: normalizeColor(format.fill),
    numberFormat: typeof format.numberformat === 'string' ? format.numberformat : '',
    horizontalAlignment: typeof format['alignment.horizontal'] === 'string' ? format['alignment.horizontal'] : '',
    verticalAlignment: typeof format['alignment.vertical'] === 'string' ? format['alignment.vertical'] : '',
    wrapText: typeof format['alignment.wrapText'] === 'boolean' ? format['alignment.wrapText'] : undefined,
  }
  return Object.values(style).some((value) => value !== '' && value !== undefined) ? style : undefined
}

function sheetCellFromNode(node) {
  if (!node || node.type !== 'cell' || typeof node.path !== 'string') return null
  const address = node.path.split('/').pop()?.toUpperCase() || ''
  if (!/^[A-Z]{1,3}[1-9]\d{0,6}$/.test(address)) return null
  const format = node.format && typeof node.format === 'object' ? node.format : {}
  const formulaBody = typeof format.formula === 'string' && format.formula.trim() ? format.formula.trim() : ''
  const display = format.empty ? '' : String(node.text ?? '')
  return {
    address,
    value: formulaBody ? `=${formulaBody}` : display,
    display,
    formula: formulaBody ? `=${formulaBody}` : '',
    dataType: typeof format.type === 'string' ? format.type : '',
    style: officeStyleFromFormat(format),
  }
}

function collectSheetCells(node, cells = {}) {
  const cell = sheetCellFromNode(node)
  if (cell) cells[cell.address] = cell
  for (const child of node?.children || []) collectSheetCells(child, cells)
  return cells
}

function normalizeCellStyle(value) {
  if (!value || typeof value !== 'object') return undefined
  const style = {}
  if (typeof value.fontName === 'string' && value.fontName.trim()) style.fontName = value.fontName.slice(0, 160)
  if (Number.isFinite(value.fontSize)) style.fontSize = Math.max(1, Math.min(409, Number(value.fontSize)))
  if (typeof value.bold === 'boolean') style.bold = value.bold
  if (typeof value.italic === 'boolean') style.italic = value.italic
  if (['single', 'double', 'none'].includes(value.underline)) style.underline = value.underline
  if (typeof value.strike === 'boolean') style.strike = value.strike
  const fontColor = normalizeColor(value.fontColor)
  if (fontColor) style.fontColor = fontColor
  const fill = normalizeColor(value.fill)
  if (fill) style.fill = fill
  if (typeof value.numberFormat === 'string' && value.numberFormat) style.numberFormat = value.numberFormat.slice(0, 256)
  if (['left', 'center', 'right', 'justify', 'distributed'].includes(value.horizontalAlignment)) style.horizontalAlignment = value.horizontalAlignment
  if (['top', 'center', 'bottom'].includes(value.verticalAlignment)) style.verticalAlignment = value.verticalAlignment
  if (typeof value.wrapText === 'boolean') style.wrapText = value.wrapText
  return Object.keys(style).length ? style : undefined
}

function cellChangeToBatchCommand(change) {
  const sheetName = safeSheetName(change.sheet)
  const cellAddress = safeCellAddress(change.cell)
  const props = {}
  if (change.contentChanged !== false) {
    props.clear = true
    if (typeof change.formula === 'string' && change.formula.trim()) {
      props.formula = change.formula.trim().replace(/^=/, '')
    } else if (change.value !== null && change.value !== undefined && change.value !== '') {
      props.value = String(change.value)
      if (typeof change.value === 'number') props.type = 'number'
      else if (typeof change.value === 'boolean') props.type = 'boolean'
      else props.type = 'string'
    }
  }
  const style = normalizeCellStyle(change.style)
  if (style) {
    if (style.fontName) props['font.name'] = style.fontName
    if (style.fontSize !== undefined) props['font.size'] = `${style.fontSize}pt`
    if (style.bold !== undefined) props['font.bold'] = style.bold
    if (style.italic !== undefined) props['font.italic'] = style.italic
    if (style.underline) props.underline = style.underline
    if (style.strike !== undefined) props.strike = style.strike
    if (style.fontColor) props['font.color'] = style.fontColor
    if (style.fill) props.fill = style.fill
    if (style.numberFormat) props.numberformat = style.numberFormat
    if (style.horizontalAlignment) props['alignment.horizontal'] = style.horizontalAlignment
    if (style.verticalAlignment) props['alignment.vertical'] = style.verticalAlignment
    if (style.wrapText !== undefined) props['alignment.wrapText'] = style.wrapText
  }
  return Object.keys(props).length ? { command: 'set', path: `/${sheetName}/${cellAddress}`, props } : null
}

function normalizeCellChange(change) {
  if (!change || typeof change !== 'object' || Array.isArray(change)) throw new Error('单元格修改格式无效。')
  const sheet = safeSheetName(change.sheet)
  const cell = safeCellAddress(change.cell)
  const formula = typeof change.formula === 'string' ? change.formula.trim().slice(0, MAX_TEXT_BYTES) : ''
  const rawValue = change.value
  const value = rawValue === null || rawValue === undefined || typeof rawValue === 'string' || typeof rawValue === 'number' || typeof rawValue === 'boolean'
    ? rawValue ?? ''
    : String(rawValue).slice(0, MAX_TEXT_BYTES)
  const normalized = {
    sheet,
    cell,
    value,
    formula,
    contentChanged: change.contentChanged !== false,
    style: normalizeCellStyle(change.style),
  }
  if (!cellChangeToBatchCommand(normalized)) throw new Error(`${sheet}!${cell} 没有可应用的修改。`)
  return normalized
}

function sessionCellFromChange(existing, change) {
  const next = existing ? { ...existing, style: existing.style ? { ...existing.style } : undefined } : {
    address: change.cell,
    value: '',
    display: '',
    formula: '',
    dataType: '',
  }
  if (change.contentChanged !== false) {
    const formula = change.formula ? (change.formula.startsWith('=') ? change.formula : `=${change.formula}`) : ''
    const value = formula ? formula : change.value ?? ''
    next.value = String(value)
    next.display = formula ? formula : String(value)
    next.formula = formula
    next.dataType = formula ? 'formula' : typeof change.value
  }
  if (change.style) next.style = { ...(next.style || {}), ...change.style }
  return next
}

function sessionMetadata(session) {
  const htmlDirty = typeof session.source === 'string' && typeof session.savedSource === 'string' && session.source !== session.savedSource
  const wordPending = Array.isArray(session.operations) ? session.operations.length : 0
  return {
    sessionId: session.sessionId,
    sessionRevision: session.revision,
    dirty: htmlDirty || wordPending > 0 || session.pendingChanges?.size > 0 || session.pendingOperations?.size > 0,
    pendingCount: htmlDirty ? 1 : wordPending || (session.pendingChanges?.size || 0) + (session.pendingOperations?.size || 0),
  }
}

function decodeDelimitedFile(filePath) {
  const buffer = fs.readFileSync(filePath)
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return { source: new TextDecoder('utf-16le').decode(buffer.subarray(2)), encoding: 'utf16le', bom: true }
  if (buffer[0] === 0xfe && buffer[1] === 0xff) {
    const swapped = Buffer.from(buffer.subarray(2))
    for (let index = 0; index + 1 < swapped.length; index += 2) [swapped[index], swapped[index + 1]] = [swapped[index + 1], swapped[index]]
    return { source: new TextDecoder('utf-16le').decode(swapped), encoding: 'utf16be', bom: true }
  }
  const bom = buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf
  const body = bom ? buffer.subarray(3) : buffer
  const utf8 = new TextDecoder('utf-8', { fatal: true })
  try { return { source: utf8.decode(body), encoding: 'utf8', bom } } catch {
    return { source: new TextDecoder('gb18030').decode(body), encoding: 'gb18030', bom: false }
  }
}

function parseDelimited(source, delimiter) {
  const rows = [[]]
  let field = ''
  let quoted = false
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]
    if (quoted) {
      if (character === '"' && source[index + 1] === '"') { field += '"'; index += 1 }
      else if (character === '"') quoted = false
      else field += character
      continue
    }
    if (character === '"' && !field) quoted = true
    else if (character === delimiter) { rows.at(-1).push(field); field = '' }
    else if (character === '\n') { rows.at(-1).push(field.replace(/\r$/, '')); field = ''; rows.push([]) }
    else field += character
  }
  rows.at(-1).push(field.replace(/\r$/, ''))
  if (rows.length > 1 && rows.at(-1).length === 1 && rows.at(-1)[0] === '') rows.pop()
  return rows
}

function detectDelimiter(source, extension) {
  if (extension === '.tsv') return '\t'
  const sample = source.split(/\r?\n/, 12).join('\n')
  const candidates = [',', '\t', ';']
  return candidates.map((delimiter) => ({ delimiter, columns: parseDelimited(sample, delimiter).reduce((sum, row) => sum + row.length, 0) })).sort((left, right) => right.columns - left.columns)[0].delimiter
}

function delimitedCell(address, raw) {
  const value = String(raw ?? '')
  if (/^-?(?:\d+\.?\d*|\.\d+)$/.test(value) && value.length < 20) return { address, value: Number(value), display: value, formula: '', dataType: 'number' }
  if (/^(?:true|false)$/i.test(value)) return { address, value: /^true$/i.test(value), display: value, formula: '', dataType: 'boolean' }
  return { address, value, display: value, formula: '', dataType: 'string' }
}

function encodeDelimitedValue(value, delimiter) {
  const source = String(value ?? '')
  return /["\r\n]/.test(source) || source.includes(delimiter) ? `"${source.replace(/"/g, '""')}"` : source
}

function encodeDelimitedFile(source, metadata) {
  if (metadata.encoding === 'utf16le') return Buffer.concat([metadata.bom ? Buffer.from([0xff, 0xfe]) : Buffer.alloc(0), Buffer.from(source, 'utf16le')])
  if (metadata.encoding === 'utf16be') {
    const body = Buffer.from(source, 'utf16le')
    for (let index = 0; index + 1 < body.length; index += 2) [body[index], body[index + 1]] = [body[index + 1], body[index]]
    return Buffer.concat([metadata.bom ? Buffer.from([0xfe, 0xff]) : Buffer.alloc(0), body])
  }
  const prefix = metadata.bom || metadata.encoding === 'gb18030' ? Buffer.from([0xef, 0xbb, 0xbf]) : Buffer.alloc(0)
  return Buffer.concat([prefix, Buffer.from(source, 'utf8')])
}

function htmlContentType(extension) {
  return ({
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.mp3': 'audio/mpeg',
    '.mp4': 'video/mp4',
  })[extension] || 'application/octet-stream'
}

function injectHtmlEditorRuntime(source, token) {
  const baseTag = `<base data-zsense-editor-runtime href="zsense-office://asset/${token}/">`
  const runtime = `<style data-zsense-editor-runtime>
html.zsense-html-editing * { cursor: crosshair !important; }
html.zsense-html-editing [data-zsense-selected] { outline: 2px solid #2563eb !important; outline-offset: 2px !important; }
#zsense-html-toolbar { position: fixed; z-index: 2147483647; display: none; align-items: center; gap: 3px; padding: 4px; border: 1px solid #cbd5e1; border-radius: 8px; background: rgba(255,255,255,.98); box-shadow: 0 10px 28px rgba(15,23,42,.2); color: #172033; font: 12px/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
#zsense-html-toolbar[data-visible="true"] { display: flex; }
#zsense-html-toolbar button { min-width: 28px; height: 28px; padding: 0 7px; border: 0; border-radius: 6px; background: transparent; color: #334155; font: inherit; font-weight: 650; cursor: pointer !important; }
#zsense-html-toolbar button:hover, #zsense-html-toolbar button:focus-visible { background: #eaf3ff; color: #1d4ed8; outline: none; }
#zsense-html-toolbar button[data-action="ai"] { background: #2563eb; color: #fff; }
#zsense-html-toolbar[data-manual-enabled="false"] button[data-manual] { display: none; }
</style>
<div id="zsense-html-toolbar" data-zsense-editor-runtime role="toolbar" aria-label="HTML 元素编辑工具">
  <button type="button" data-action="text" data-manual title="编辑文字">文本</button>
  <button type="button" data-action="bold" data-manual title="加粗">B</button>
  <button type="button" data-action="italic" data-manual title="斜体"><i>I</i></button>
  <button type="button" data-action="underline" data-manual title="下划线"><u>U</u></button>
  <button type="button" data-action="ai" title="让 AI 编辑当前元素">AI 编辑</button>
</div>
<script data-zsense-editor-runtime>
(() => {
  const CHANNEL = 'zsense-html-editor-v1';
  const toolbar = document.getElementById('zsense-html-toolbar');
  const initialElements = new WeakSet([...document.querySelectorAll('*')]);
  const textStyleProperties = new Set(['color', 'backgroundColor', 'fontSize', 'fontWeight', 'fontStyle', 'textDecoration', 'textAlign']);
  const imageStyleProperties = new Set(['objectFit', 'objectPosition', 'borderRadius', 'borderWidth', 'borderColor']);
  const overrideBootstrap = function(items) {
    window.__ZSENSE_HTML_OVERRIDES__ = Array.isArray(items) ? items : [];
    const apply = () => {
      for (const item of (Array.isArray(window.__ZSENSE_HTML_OVERRIDES__) ? window.__ZSENSE_HTML_OVERRIDES__ : [])) {
        if (!item || typeof item.selector !== 'string') continue;
        let element = null;
        try { element = document.querySelector(item.selector); } catch { continue; }
        if (!(element instanceof Element)) continue;
        if (Object.prototype.hasOwnProperty.call(item, 'text')) {
          const text = String(item.text == null ? '' : item.text);
          if (element.textContent !== text) element.textContent = text;
        }
        if (item.styles && typeof item.styles === 'object') {
          for (const [property, value] of Object.entries(item.styles)) {
            if (typeof value === 'string' && element.style[property] !== value) element.style[property] = value;
          }
        }
        if (item.attributes && typeof item.attributes === 'object') {
          for (const [name, value] of Object.entries(item.attributes)) {
            if (value == null) { if (element.hasAttribute(name)) element.removeAttribute(name); }
            else if (element.getAttribute(name) !== String(value)) element.setAttribute(name, String(value));
          }
        }
      }
    };
    apply();
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', apply, { once: true });
    addEventListener('load', apply, { once: true });
    let scheduled = false;
    const observer = new MutationObserver(() => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => { scheduled = false; apply(); });
    });
    if (document.documentElement) observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
  };
  const persistedOverrides = new Map(
    (Array.isArray(window.__ZSENSE_HTML_OVERRIDES__) ? window.__ZSENSE_HTML_OVERRIDES__ : [])
      .filter((item) => item && typeof item.selector === 'string')
      .map((item) => [item.selector, item])
  );
  let editing = false;
  let selected = null;
  let inputTimer = 0;
  const send = (type, detail = {}) => parent.postMessage({ channel: CHANNEL, type, ...detail }, '*');
  const isDynamic = (element) => Boolean(element && (
    !initialElements.has(element)
    || element.matches('canvas')
    || element.closest('[_echarts_instance_], [data-reactroot], [data-v-app], [data-svelte-h]')
  ));
  const isImage = (element) => element instanceof HTMLImageElement;
  const cleanSource = () => {
    const root = document.documentElement.cloneNode(true);
    root.querySelectorAll('[data-zsense-editor-runtime]').forEach((node) => node.remove());
    root.querySelectorAll('[data-zsense-html-overrides]').forEach((node) => node.remove());
    root.querySelectorAll('[data-zsense-selected]').forEach((node) => node.removeAttribute('data-zsense-selected'));
    root.querySelectorAll('[contenteditable]').forEach((node) => node.removeAttribute('contenteditable'));
    if (persistedOverrides.size) {
      const overrideScript = document.createElement('script');
      overrideScript.setAttribute('data-zsense-html-overrides', 'true');
      const serialized = JSON.stringify([...persistedOverrides.values()])
        .replace(/</g, String.fromCharCode(92) + 'u003c')
        .split(String.fromCharCode(0x2028)).join(String.fromCharCode(92) + 'u2028')
        .split(String.fromCharCode(0x2029)).join(String.fromCharCode(92) + 'u2029');
      overrideScript.textContent = '(' + overrideBootstrap.toString() + ')(' + serialized + ');';
      (root.querySelector('body') || root).appendChild(overrideScript);
    }
    const doctype = document.doctype ? '<!DOCTYPE ' + document.doctype.name + '>\\n' : '<!DOCTYPE html>\\n';
    return doctype + root.outerHTML;
  };
  const selectorFor = (element) => {
    if (element.id) return '#' + CSS.escape(element.id);
    if (element.hasAttribute('data-page-node-id')) return '[data-page-node-id="' + CSS.escape(element.getAttribute('data-page-node-id')) + '"]';
    const parts = [];
    let current = element;
    while (current && current !== document.body && parts.length < 16) {
      let part = current.tagName.toLowerCase();
      const siblings = current.parentElement ? [...current.parentElement.children].filter((item) => item.tagName === current.tagName) : [];
      if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')';
      parts.unshift(part);
      current = current.parentElement;
    }
    return 'body > ' + parts.join(' > ');
  };
  const updateOverride = (patch) => {
    if (!selected) return;
    const selector = selectorFor(selected);
    const current = persistedOverrides.get(selector) || { selector };
    const next = { ...current, ...patch, selector };
    if (current.styles || patch.styles) next.styles = { ...(current.styles || {}), ...(patch.styles || {}) };
    if (current.attributes || patch.attributes) next.attributes = { ...(current.attributes || {}), ...(patch.attributes || {}) };
    persistedOverrides.set(selector, next);
    window.__ZSENSE_HTML_OVERRIDES__ = [...persistedOverrides.values()];
  };
  const recordTextOverride = () => updateOverride({ text: selected ? selected.textContent || '' : '' });
  const recordStyleOverride = (property) => {
    if (selected && property) updateOverride({ styles: { [property]: selected.style[property] || '' } });
  };
  const recordAttributeOverride = (name) => {
    if (selected && name) updateOverride({ attributes: { [name]: selected.getAttribute(name) } });
  };
  const reposition = () => {
    if (!selected || !editing) return;
    const rect = selected.getBoundingClientRect();
    const width = toolbar.offsetWidth || 220;
    toolbar.style.left = Math.max(8, Math.min(innerWidth - width - 8, rect.left)) + 'px';
    toolbar.style.top = Math.max(8, rect.top - 42) + 'px';
  };
  const selectionDetail = () => {
    if (!selected) return {};
    const style = getComputedStyle(selected);
    const detail = {
      selector: selectorFor(selected), tag: selected.tagName.toLowerCase(),
      text: (selected.textContent || '').slice(0, 4000),
      dynamic: isDynamic(selected),
      style: { color: style.color, backgroundColor: style.backgroundColor, fontSize: style.fontSize, fontWeight: style.fontWeight, fontStyle: style.fontStyle, textDecorationLine: style.textDecorationLine, textAlign: style.textAlign }
    };
    if (isImage(selected)) detail.image = {
      src: (selected.getAttribute('src') || '').slice(0, 800),
      alt: selected.getAttribute('alt') || '',
      objectFit: style.objectFit || 'fill',
      objectPosition: style.objectPosition || '50% 50%',
      borderRadius: style.borderRadius || '0px',
      borderWidth: style.borderWidth || '0px',
      borderColor: style.borderColor || 'rgb(37, 99, 235)'
    };
    return detail;
  };
  const reportSelection = () => {
    if (!selected) return;
    send('selection', selectionDetail());
  };
  const select = (element) => {
    if (!editing || !(element instanceof Element) || element === toolbar || toolbar.contains(element)) return;
    if (['HTML', 'BODY', 'SCRIPT', 'STYLE', 'LINK', 'META'].includes(element.tagName)) return;
    selected?.removeAttribute('data-zsense-selected');
    selected = element;
    selected.setAttribute('data-zsense-selected', 'true');
    toolbar.dataset.manualEnabled = String(!isDynamic(selected) && !isImage(selected));
    toolbar.dataset.visible = 'true';
    reposition();
    reportSelection();
  };
  const changed = (summary) => {
    clearTimeout(inputTimer);
    inputTimer = setTimeout(() => send('changed', { source: cleanSource(), summary }), 80);
    reportSelection();
  };
  toolbar.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button || !selected) return;
    event.preventDefault(); event.stopPropagation();
    const action = button.dataset.action;
    if (action === 'ai') { send('ask-ai', selectionDetail()); return; }
    if (isDynamic(selected) || isImage(selected)) return;
    if (action === 'text') { selected.contentEditable = 'true'; selected.focus(); return; }
    if (action === 'bold') { selected.style.fontWeight = getComputedStyle(selected).fontWeight === '700' ? '400' : '700'; recordStyleOverride('fontWeight'); }
    if (action === 'italic') { selected.style.fontStyle = getComputedStyle(selected).fontStyle === 'italic' ? 'normal' : 'italic'; recordStyleOverride('fontStyle'); }
    if (action === 'underline') { selected.style.textDecoration = getComputedStyle(selected).textDecorationLine.includes('underline') ? 'none' : 'underline'; recordStyleOverride('textDecoration'); }
    changed('修改 ' + selectorFor(selected) + ' 的样式');
  });
  document.addEventListener('pointerdown', (event) => {
    if (!editing || !(event.target instanceof Element) || toolbar.contains(event.target)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    select(event.target);
  }, true);
  document.addEventListener('click', (event) => {
    if (!editing || !(event.target instanceof Element) || toolbar.contains(event.target)) return;
    if (event.target.closest('a')) event.preventDefault();
    event.stopImmediatePropagation();
    select(event.target);
  }, true);
  document.addEventListener('dblclick', (event) => {
    if (!editing || !(event.target instanceof Element) || toolbar.contains(event.target)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    select(event.target);
    if (isDynamic(selected) || isImage(selected)) return;
    selected.contentEditable = 'true';
    selected.focus();
  }, true);
  document.addEventListener('input', (event) => {
    if (editing && event.target === selected) { recordTextOverride(); changed('编辑 ' + selectorFor(selected) + ' 的文字'); }
  }, true);
  document.addEventListener('focusout', (event) => {
    if (event.target === selected && selected?.isContentEditable) { selected.removeAttribute('contenteditable'); recordTextOverride(); changed('编辑 ' + selectorFor(selected) + ' 的文字'); }
  }, true);
  addEventListener('scroll', reposition, true);
  addEventListener('resize', reposition);
  addEventListener('message', (event) => {
    const data = event.data || {};
    if (data.channel !== CHANNEL) return;
    if (data.type === 'set-editing') {
      editing = Boolean(data.enabled);
      document.documentElement.classList.toggle('zsense-html-editing', editing);
      if (!editing) { selected?.removeAttribute('data-zsense-selected'); selected = null; toolbar.dataset.visible = 'false'; }
      send('editing', { enabled: editing });
      return;
    }
    if (data.type === 'request-source') {
      send('source', { requestId: String(data.requestId || ''), source: cleanSource() });
      return;
    }
    if (!selected) return;
    if (data.type === 'set-text' && !isDynamic(selected) && !isImage(selected)) { selected.textContent = String(data.value || ''); recordTextOverride(); changed('编辑 ' + selectorFor(selected) + ' 的文字'); }
    if (data.type === 'apply-style' && !isDynamic(selected) && !isImage(selected) && textStyleProperties.has(data.property)) { selected.style[data.property] = String(data.value || ''); recordStyleOverride(data.property); changed('修改 ' + selectorFor(selected) + ' 的样式'); }
    if (data.type === 'set-image-source' && !isDynamic(selected) && isImage(selected) && typeof data.dataUrl === 'string' && data.dataUrl.startsWith('data:image/')) { selected.setAttribute('src', data.dataUrl); recordAttributeOverride('src'); changed('替换 ' + selectorFor(selected) + ' 的图片'); }
    if (data.type === 'set-image-alt' && !isDynamic(selected) && isImage(selected)) { selected.setAttribute('alt', String(data.value || '')); recordAttributeOverride('alt'); changed('修改 ' + selectorFor(selected) + ' 的图片说明'); }
    if (data.type === 'apply-image-style' && !isDynamic(selected) && isImage(selected) && imageStyleProperties.has(data.property)) {
      selected.style[data.property] = String(data.value || '');
      recordStyleOverride(data.property);
      if (data.property === 'borderWidth') { selected.style.borderStyle = String(data.value || '') === '0px' ? 'none' : 'solid'; recordStyleOverride('borderStyle'); }
      changed('修改 ' + selectorFor(selected) + ' 的图片样式');
    }
  });
  send('ready', { version: 2, editing });
})();
</script>`
  let output = String(source || '').replace(/<meta\s+[^>]*http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/gi, '')
  output = output.replace(/<[^>]+data-zsense-editor-runtime[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<[^>]+data-zsense-editor-runtime[^>]*>[\s\S]*?<\/style>/gi, '')
  if (/<head(?:\s[^>]*)?>/i.test(output)) output = output.replace(/<head(?:\s[^>]*)?>/i, (match) => `${match}${baseTag}`)
  else output = `${baseTag}${output}`
  // Bundled libraries can contain literal HTML snippets such as
  // `'<body>...</body>'` inside a script. Replacing the first closing tag
  // injects our runtime into that JavaScript string and exposes the remaining
  // minified source as page text. The document's closing body tag is the last
  // one in a valid HTML file, so insert immediately before that occurrence.
  const bodyCloseIndex = output.toLowerCase().lastIndexOf('</body>')
  if (bodyCloseIndex >= 0) return `${output.slice(0, bodyCloseIndex)}${runtime}${output.slice(bodyCloseIndex)}`
  return `${output}${runtime}`
}

function injectWordEditorRuntime(source) {
  const runtime = `<style data-zsense-word-editor-runtime>
html.zsense-word-editing [data-path] { cursor: text !important; user-select: text !important; -webkit-user-select: text !important; }
html.zsense-word-editing [data-path]:hover { outline: 1px dashed #93c5fd; outline-offset: 3px; }
[data-zsense-word-selected="true"] { outline: 2px solid #2563eb !important; outline-offset: 3px !important; border-radius: 2px; }
[data-path][contenteditable="true"] { caret-color: #1d4ed8; }
[data-path][contenteditable="true"]:focus { background: #f8fbff !important; }
html { --zsense-word-zoom: 1; }
.page-wrapper { zoom: var(--zsense-word-zoom); }
::selection { background: #bfdbfe; color: inherit; }
</style><script data-zsense-word-editor-runtime>
(() => {
  const CHANNEL = 'zsense-word-editor-v1';
  let editing = false;
  let selected = null;
  let dirtyEditor = null;
  let selectionFrame = 0;
  const send = (type, detail = {}) => parent.postMessage({ channel: CHANNEL, type, ...detail }, '*');
  const reportDocumentStats = () => {
    const text = [...document.querySelectorAll('.page-body')].map((node) => node.innerText || node.textContent || '').join('\\n').trim();
    const compact = text.replace(/\\s+/g, '');
    const latinWords = text.match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g) || [];
    const cjkCharacters = text.match(/[\u3400-\u9fff\uf900-\ufaff]/g) || [];
    send('document-stats', { pageCount: Math.max(1, document.querySelectorAll('.page').length), wordCount: latinWords.length + cjkCharacters.length, characterCount: [...compact].length });
  };
  const pathNode = (node) => {
    const element = node instanceof Element ? node : node?.parentElement;
    return element?.closest?.('[data-path]') || null;
  };
  const editableNode = (node) => {
    const target = pathNode(node);
    return target && /^(P|H[1-6]|LI|TD|TH)$/.test(target.tagName) ? target : null;
  };
  const setEditable = (enabled) => {
    document.querySelectorAll('[data-path]').forEach((node) => {
      if (/^(P|H[1-6]|LI|TD|TH)$/.test(node.tagName)) {
        if (enabled) node.setAttribute('contenteditable', 'true');
        else node.removeAttribute('contenteditable');
      }
    });
  };
  const selectionDetail = () => {
    const nativeSelection = getSelection();
    if (!nativeSelection || nativeSelection.rangeCount < 1) return { text: '', rangeSelected: false, characterCount: 0, rect: null, popupPlacement: 'bottom' };
    const text = nativeSelection.isCollapsed ? '' : nativeSelection.toString();
    const rangeRect = nativeSelection.getRangeAt(0).getBoundingClientRect();
    const fallbackRect = selected?.getBoundingClientRect?.();
    const sourceRect = text && rangeRect.width ? rangeRect : fallbackRect;
    const rect = sourceRect ? { left: sourceRect.left, top: sourceRect.top, right: sourceRect.right, bottom: sourceRect.bottom, width: sourceRect.width, height: sourceRect.height } : null;
    return { text, rangeSelected: Boolean(text), characterCount: [...text].length, rect, popupPlacement: rect && rect.bottom > innerHeight - 84 ? 'top' : 'bottom' };
  };
  const report = () => {
    if (!selected) return;
    const style = getComputedStyle(selected);
    const range = selectionDetail();
    send('selection', {
      path: selected.getAttribute('data-path') || '',
      text: range.text || selected.innerText || selected.textContent || '',
      blockText: selected.innerText || selected.textContent || '',
      rangeSelected: range.rangeSelected,
      characterCount: range.characterCount,
      rect: range.rect,
      popupPlacement: range.popupPlacement,
      tag: selected.tagName.toLowerCase(),
      style: {
        fontFamily: style.fontFamily,
        fontSize: style.fontSize,
        fontWeight: style.fontWeight,
        fontStyle: style.fontStyle,
        textDecorationLine: style.textDecorationLine,
        color: style.color,
        backgroundColor: style.backgroundColor,
        textAlign: style.textAlign,
        lineHeight: style.lineHeight
      }
    });
  };
  const select = (element) => {
    const target = pathNode(element);
    if (!editing || !target) return;
    selected?.removeAttribute('data-zsense-word-selected');
    selected = target;
    selected.setAttribute('data-zsense-word-selected', 'true');
    report();
  };
  const commitEditor = (target) => {
    if (!target || target !== dirtyEditor) return;
    dirtyEditor = null;
    send('text-change', { path: target.getAttribute('data-path') || '', text: target.innerText || target.textContent || '' });
  };
  document.addEventListener('pointerdown', (event) => {
    if (!editing) return;
    const target = pathNode(event.target);
    if (target) select(target);
  }, true);
  document.addEventListener('selectionchange', () => {
    if (!editing) return;
    cancelAnimationFrame(selectionFrame);
    selectionFrame = requestAnimationFrame(() => {
      const nativeSelection = getSelection();
      const target = pathNode(nativeSelection?.anchorNode) || pathNode(nativeSelection?.focusNode);
      if (target) select(target);
    });
  });
  document.addEventListener('input', (event) => {
    if (!editing) return;
    const target = editableNode(event.target);
    if (!target) return;
    dirtyEditor = target;
    select(target);
    send('text-draft', { path: target.getAttribute('data-path') || '', text: target.innerText || target.textContent || '' });
    reportDocumentStats();
  }, true);
  document.addEventListener('focusout', (event) => commitEditor(editableNode(event.target)), true);
  addEventListener('scroll', () => { if (editing && selected) report(); }, true);
  document.addEventListener('keydown', (event) => {
    if (!editing || event.key !== 'Escape') return;
    const target = editableNode(event.target);
    if (target) { commitEditor(target); target.blur(); }
  }, true);
  addEventListener('message', (event) => {
    const data = event.data || {};
    if (data.channel !== CHANNEL) return;
    if (data.type === 'set-editing') {
      editing = Boolean(data.editing);
      document.documentElement.classList.toggle('zsense-word-editing', editing);
      setEditable(editing);
      if (!editing) {
        commitEditor(dirtyEditor);
        selected?.removeAttribute('data-zsense-word-selected');
        selected = null;
      }
      reportDocumentStats();
    } else if (data.type === 'set-zoom') {
      const next = Math.max(50, Math.min(200, Number(data.zoom) || 100));
      document.documentElement.style.setProperty('--zsense-word-zoom', String(next / 100));
    } else if (data.type === 'focus-path' && typeof data.path === 'string') {
      const target = [...document.querySelectorAll('[data-path]')].find((node) => node.getAttribute('data-path') === data.path);
      if (target) { select(target); target.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
    } else if (data.type === 'commit-draft') {
      commitEditor(dirtyEditor);
    }
  });
  send('ready');
  requestAnimationFrame(reportDocumentStats);
})();
</script>`
  const output = String(source || '')
  const bodyCloseIndex = output.toLowerCase().lastIndexOf('</body>')
  if (bodyCloseIndex >= 0) return `${output.slice(0, bodyCloseIndex)}${runtime}${output.slice(bodyCloseIndex)}`
  return `${output}${runtime}`
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function isInsideOrEqual(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  return !relative || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

export class OfficeWorkspaceService {
  constructor({ userDataDirectory, toolPaths = [] }) {
    this.userDataDirectory = userDataDirectory
    this.toolPaths = toolPaths
    this.previewRoot = path.join(userDataDirectory, 'office-previews')
    this.wordSessionRoot = path.join(userDataDirectory, 'office-word-sessions')
    this.recentFilePath = path.join(userDataDirectory, 'office-recent.json')
    this.previewTokens = new Map()
    this.inlinePreviewSecret = randomBytes(32)
    this.workbookSessions = new Map()
    this.htmlSessions = new Map()
    this.wordSessions = new Map()
    this.saveQueues = new Map()
    this.sessionListeners = new Set()
    fs.mkdirSync(this.previewRoot, { recursive: true, mode: 0o700 })
    fs.mkdirSync(this.wordSessionRoot, { recursive: true, mode: 0o700 })
  }

  onSessionEvent(listener) {
    if (typeof listener !== 'function') return () => undefined
    this.sessionListeners.add(listener)
    return () => this.sessionListeners.delete(listener)
  }

  #publishSession(session, { kind, source = 'system', sourceClientId = '', changes = [], operations = [] } = {}) {
    const metadata = sessionMetadata(session)
    const event = {
      filePath: session.filePath,
      sessionId: session.sessionId,
      revision: session.revision,
      kind,
      source,
      sourceClientId,
      dirty: metadata.dirty,
      pendingCount: metadata.pendingCount,
      changes,
      operations,
    }
    for (const listener of this.sessionListeners) {
      try { listener(event) } catch { /* one renderer listener cannot stop the session */ }
    }
    return event
  }

  #resolveTool() {
    return this.toolPaths.find((candidate) => {
      try { return fs.statSync(candidate).isFile() } catch { return false }
    }) || null
  }

  async #run(args, timeout = 90_000) {
    const executable = this.#resolveTool()
    if (!executable) throw new Error('ZSense 安装包中的 Office 编辑引擎不可用，请重新安装应用。')
    try {
      const result = await execFileAsync(executable, args, {
        timeout,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, OFFICECLI_NO_AUTO_RESIDENT: '1' },
      })
      return String(result.stdout || '').trim()
    } catch (error) {
      throw new Error(compactError(error) || 'Office 文件处理失败。')
    }
  }

  async #runJson(args, timeout) {
    const output = await this.#run([...args, '--json'], timeout)
    const result = parseJson(output)
    if (!result || result.success === false) throw new Error(result?.message || 'Office 编辑引擎返回了无法识别的结果。')
    return result
  }

  async #runJsonWithLockRetry(args, timeout = 120_000) {
    const waits = [0, 180, 550, 1_200]
    let lastError
    for (const wait of waits) {
      if (wait) await delay(wait)
      try { return await this.#runJson(args, timeout) }
      catch (error) {
        lastError = error
        if (!/(locked|in use|being used|sharing violation|占用|锁定)/i.test(error?.message || '')) throw error
      }
    }
    throw lastError
  }

  #queueFileSave(filePath, operation) {
    const previous = this.saveQueues.get(filePath) || Promise.resolve()
    const next = previous.catch(() => undefined).then(operation)
    this.saveQueues.set(filePath, next)
    return next.finally(() => {
      if (this.saveQueues.get(filePath) === next) this.saveQueues.delete(filePath)
    })
  }

  #resolveDocument(filePath) {
    if (typeof filePath !== 'string' || !filePath.trim()) throw new Error('请选择要打开的文件。')
    const requestedPath = path.resolve(filePath.trim())
    let resolvedPath
    let stats
    try {
      resolvedPath = fs.realpathSync(requestedPath)
      stats = fs.statSync(resolvedPath)
    } catch {
      throw new Error('文件不存在、已移动或无法读取。')
    }
    if (!stats.isFile()) throw new Error('请选择文件，而不是文件夹。')
    if (stats.size <= 0) throw new Error('文件内容为空。')
    if (stats.size > MAX_FILE_BYTES) throw new Error('文件超过 500 MB，无法在应用内安全打开。')
    const extension = path.extname(resolvedPath).toLowerCase()
    if (!ALL_EXTENSIONS.has(extension)) throw new Error('支持图片、PDF、HTML、Word、Excel、CSV/TSV 和 PowerPoint 文件。')
    if (IMAGE_EXTENSIONS.has(extension) && stats.size > MAX_IMAGE_BYTES) throw new Error('图片超过 100 MB，无法在应用内安全打开。')
    if (HTML_EXTENSIONS.has(extension) && stats.size > MAX_HTML_BYTES) throw new Error('HTML 文件超过 8 MB，无法在应用内安全编辑。')
    return { filePath: resolvedPath, stats, extension, kind: officeKind(extension) }
  }

  #readRecentRecords() {
    try {
      const records = JSON.parse(fs.readFileSync(this.recentFilePath, 'utf8'))
      if (!Array.isArray(records)) return []
      return records.filter((item) => {
        if (!item || typeof item.filePath !== 'string') return false
        try { return fs.statSync(item.filePath).isFile() && ALL_EXTENSIONS.has(path.extname(item.filePath).toLowerCase()) } catch { return false }
      }).slice(0, 12)
    } catch { return [] }
  }

  #remember(document) {
    const next = [{
      filePath: document.filePath,
      name: document.name,
      extension: document.extension,
      kind: document.kind,
      accessedAt: new Date().toISOString(),
    }, ...this.#readRecentRecords().filter((item) => item.filePath !== document.filePath)].slice(0, 12)
    const temporary = `${this.recentFilePath}.tmp-${process.pid}`
    fs.writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    fs.renameSync(temporary, this.recentFilePath)
  }

  async status() {
    const executable = this.#resolveTool()
    if (!executable) return {
      available: false,
      version: '',
      message: 'Office 编辑引擎缺失，请重新安装 ZSense。',
      supportedExtensions: [...MODERN_EXTENSIONS.keys(), ...IMAGE_EXTENSIONS.keys()],
      legacyExtensions: [...LEGACY_EXTENSIONS],
    }
    let version = ''
    try { version = (await this.#run(['--version'], 15_000)).split('\n')[0] || '' } catch { /* surfaced when opening a file */ }
    return {
      available: true,
      version,
      message: '图片、PDF、HTML、Word、Excel、CSV/TSV、PowerPoint 文件均在本机处理，不会上传到远程服务。',
      supportedExtensions: [...MODERN_EXTENSIONS.keys(), ...IMAGE_EXTENSIONS.keys()],
      legacyExtensions: [...LEGACY_EXTENSIONS],
    }
  }

  listRecent() {
    return this.#readRecentRecords()
  }

  async #excelSheets(filePath) {
    try {
      const result = await this.#runJson(['get', filePath, '/', '--depth', '1'])
      const root = result?.data?.results?.[0]
      return (root?.children || [])
        .filter((child) => child?.type === 'sheet' && typeof child.path === 'string')
        .map((child) => child.preview || child.path.replace(/^\//, ''))
        .filter(Boolean)
    } catch { return [] }
  }

  async #excelCell(filePath, sheetName, cellAddress) {
    const result = await this.#runJson(['get', filePath, `/${sheetName}/${cellAddress}`])
    return sheetCellFromNode(result?.data?.results?.[0]) || {
      address: cellAddress,
      value: '',
      display: '',
      formula: '',
      dataType: '',
    }
  }

  async #excelSheet(filePath, sheetName) {
    const result = await this.#runJson(['get', filePath, `/${sheetName}`, '--depth', '1'], 120_000)
    const root = result?.data?.results?.find((item) => item?.type === 'sheet')
    const cells = collectSheetCells(root)
    const addresses = Object.keys(cells)
    const lastRow = addresses.reduce((maximum, address) => Math.max(maximum, rowIndexFromAddress(address)), 0)
    const lastColumn = addresses.reduce((maximum, address) => Math.max(maximum, columnIndexFromAddress(address)), 0)
    return {
      id: createHash('sha256').update(`${filePath}\0${sheetName}`).digest('hex').slice(0, 24),
      sheet: sheetName,
      rowCount: Math.max(EXCEL_MIN_ROWS, lastRow + 1 + EXCEL_ROW_BUFFER),
      columnCount: Math.max(EXCEL_MIN_COLUMNS, lastColumn + 1 + EXCEL_COLUMN_BUFFER),
      usedRowCount: addresses.length ? lastRow + 1 : 0,
      usedColumnCount: addresses.length ? lastColumn + 1 : 0,
      cells,
    }
  }

  #delimitedWorkbook(resolved) {
    const decoded = decodeDelimitedFile(resolved.filePath)
    const delimiter = detectDelimiter(decoded.source, resolved.extension)
    const rows = parseDelimited(decoded.source, delimiter)
    const cells = {}
    let usedColumnCount = 0
    rows.forEach((row, rowIndex) => {
      usedColumnCount = Math.max(usedColumnCount, row.length)
      row.forEach((value, columnIndex) => {
        if (value === '') return
        const address = `${columnNameFromIndex(columnIndex)}${rowIndex + 1}`
        cells[address] = delimitedCell(address, value)
      })
    })
    const sheetName = path.basename(resolved.filePath, resolved.extension).replace(/[\\/?*:[\]]/g, '_').slice(0, 31) || 'CSV'
    return {
      metadata: { delimiter, lineEnding: /\r\n/.test(decoded.source) ? '\r\n' : '\n', encoding: decoded.encoding, bom: decoded.bom },
      workbook: {
        filePath: resolved.filePath,
        revision: `${resolved.stats.mtimeMs}-${resolved.stats.size}`,
        sheets: [{ id: createHash('sha256').update(`${resolved.filePath}\0${sheetName}`).digest('hex').slice(0, 24), sheet: sheetName, rowCount: Math.max(EXCEL_MIN_ROWS, rows.length + EXCEL_ROW_BUFFER), columnCount: Math.max(EXCEL_MIN_COLUMNS, usedColumnCount + EXCEL_COLUMN_BUFFER), usedRowCount: rows.length, usedColumnCount, cells }],
      },
    }
  }

  async #renderWordSession(session, resolved = this.#resolveDocument(session.filePath)) {
    const token = createHash('sha256').update(`word\0${session.filePath}\0${session.sessionId}`).digest('hex').slice(0, 32)
    const previewPath = path.join(this.previewRoot, `${token}.html`)
    await this.#run(['view', session.workingFilePath, 'html', '-o', previewPath], 120_000)
    this.previewTokens.set(token, { kind: 'word-generated', filePath: previewPath })
    const preview = new URL(`zsense-office://preview/${token}`)
    preview.searchParams.set('v', String(session.revision))
    return {
      filePath: resolved.filePath,
      name: path.basename(resolved.filePath),
      extension: resolved.extension,
      kind: 'word',
      accessedAt: new Date().toISOString(),
      editable: true,
      previewUrl: preview.toString(),
      modifiedAt: resolved.stats.mtime.toISOString(),
      size: resolved.stats.size,
      sheets: [],
      message: 'Word 由 ZSense 本地编辑器打开；修改先保存在工作副本中，只有点击保存才会写回原文件。',
    }
  }

  async #render(resolved) {
    const updatedStats = fs.statSync(resolved.filePath)
    let previewUrl = ''
    if (resolved.kind === 'image') {
      const token = createHash('sha256').update(`image\0${resolved.filePath}`).digest('hex').slice(0, 32)
      this.previewTokens.set(token, {
        kind: 'image',
        filePath: resolved.filePath,
        mimeType: IMAGE_EXTENSIONS.get(resolved.extension) || 'application/octet-stream',
      })
      const preview = new URL(`zsense-office://preview/${token}`)
      preview.searchParams.set('v', String(updatedStats.mtimeMs))
      previewUrl = preview.toString()
    } else if (resolved.kind === 'pdf') {
      const handle = fs.openSync(resolved.filePath, 'r')
      try {
        const signature = Buffer.alloc(5)
        fs.readSync(handle, signature, 0, 5, 0)
        if (signature.toString('ascii') !== '%PDF-') throw new Error('文件内容不是有效的 PDF。')
      } finally { fs.closeSync(handle) }
      const token = createHash('sha256').update(`pdf\0${resolved.filePath}`).digest('hex').slice(0, 32)
      this.previewTokens.set(token, { kind: 'pdf', filePath: resolved.filePath, mimeType: 'application/pdf' })
      const preview = new URL(`zsense-office://preview/${token}`)
      preview.searchParams.set('v', String(updatedStats.mtimeMs))
      previewUrl = preview.toString()
    } else if (resolved.kind === 'html') {
      const token = createHash('sha256').update(`html\0${resolved.filePath}`).digest('hex').slice(0, 32)
      this.previewTokens.set(token, { kind: 'html', filePath: resolved.filePath })
      const preview = new URL(`zsense-office://preview/${token}`)
      preview.searchParams.set('v', String(this.htmlSessions.get(resolved.filePath)?.revision || updatedStats.mtimeMs))
      previewUrl = preview.toString()
    } else if (resolved.kind !== 'excel') {
      const token = createHash('sha256').update(resolved.filePath).digest('hex').slice(0, 32)
      const previewPath = path.join(this.previewRoot, `${token}.html`)
      await this.#run(['view', resolved.filePath, 'html', '-o', previewPath], 120_000)
      this.previewTokens.set(token, { kind: 'generated', filePath: previewPath })
      const preview = new URL(`zsense-office://preview/${token}`)
      preview.searchParams.set('v', String(updatedStats.mtimeMs))
      previewUrl = preview.toString()
    }
    return {
      filePath: resolved.filePath,
      name: path.basename(resolved.filePath),
      extension: resolved.extension,
      kind: resolved.kind,
      accessedAt: new Date().toISOString(),
      editable: resolved.kind !== 'image',
      previewUrl,
      modifiedAt: updatedStats.mtime.toISOString(),
      size: updatedStats.size,
      sheets: resolved.kind === 'excel' ? DELIMITED_EXTENSIONS.has(resolved.extension) ? this.#delimitedWorkbook(resolved).workbook.sheets.map((item) => item.sheet) : await this.#excelSheets(resolved.filePath) : [],
      message: resolved.kind === 'image'
        ? '图片正在 ZSense 本地查看器中打开，不会上传到网络。'
        : resolved.kind === 'excel'
          ? DELIMITED_EXTENSIONS.has(resolved.extension)
            ? 'CSV/TSV 由 ZSense 本地表格编辑器打开；只保存单元格内容，不支持样式、图片或多工作表。修改后由你手动保存回原文件。'
            : '电子表格由 ZSense 在对话内打开，修改后由你手动保存回原文件。'
          : resolved.kind === 'pdf'
            ? 'PDF 在本地侧栏打开，可选文字、划区问 AI，并添加文字或标注；点击保存后写回原文件。'
          : resolved.kind === 'html'
            ? 'HTML 在隔离预览中真实运行；进入编辑模式后可选择元素，修改由你手动保存回原文件。'
            : '预览已从原文件生成；只有点击编辑操作的保存按钮后才会写回文件。',
    }
  }

  async open(filePath) {
    const resolved = this.#resolveDocument(filePath)
    const document = resolved.kind === 'word'
      ? (await this.getWord({ filePath: resolved.filePath })).document
      : MODERN_EXTENSIONS.has(resolved.extension) || IMAGE_EXTENSIONS.has(resolved.extension)
        ? await this.#render(resolved)
      : {
          filePath: resolved.filePath,
          name: path.basename(resolved.filePath),
          extension: resolved.extension,
          kind: resolved.kind,
          accessedAt: new Date().toISOString(),
          editable: false,
          previewUrl: '',
          modifiedAt: resolved.stats.mtime.toISOString(),
          size: resolved.stats.size,
          sheets: [],
          message: '这是旧版 Office 二进制格式。为避免损坏，请使用 Microsoft Office 或 WPS 打开并另存为新版格式后再在 ZSense 内编辑。',
        }
    this.#remember(document)
    return document
  }

  async refresh(filePath) {
    try {
      const resolved = this.#resolveDocument(filePath)
      this.workbookSessions.delete(resolved.filePath)
      this.htmlSessions.delete(resolved.filePath)
      const wordSession = this.wordSessions.get(resolved.filePath)
      this.wordSessions.delete(resolved.filePath)
      try { if (wordSession?.workingFilePath) fs.unlinkSync(wordSession.workingFilePath) } catch { /* best effort */ }
    } catch { /* open surfaces the error */ }
    return this.open(filePath)
  }

  async getWord({ filePath }) {
    const resolved = this.#resolveDocument(filePath)
    if (resolved.kind !== 'word') throw new Error('Word 编辑会话只适用于 .docx 文件。')
    let session = this.wordSessions.get(resolved.filePath)
    if (session && session.diskModifiedAt === resolved.stats.mtimeMs && session.diskSize === resolved.stats.size) {
      const document = await this.#renderWordSession(session, resolved)
      return { ...sessionMetadata(session), filePath: session.filePath, modifiedAt: new Date(session.diskModifiedAt).toISOString(), operations: session.operations, document }
    }
    if (session?.workingFilePath) {
      try { fs.unlinkSync(session.workingFilePath) } catch { /* best effort */ }
    }
    const sessionId = session?.sessionId || randomUUID()
    const workingFilePath = path.join(this.wordSessionRoot, `${createHash('sha256').update(`${resolved.filePath}\0${sessionId}`).digest('hex').slice(0, 32)}.docx`)
    fs.copyFileSync(resolved.filePath, workingFilePath)
    session = {
      filePath: resolved.filePath,
      workingFilePath,
      sessionId,
      revision: (session?.revision || 0) + 1,
      diskModifiedAt: resolved.stats.mtimeMs,
      diskSize: resolved.stats.size,
      operations: [],
    }
    this.wordSessions.set(resolved.filePath, session)
    const document = await this.#renderWordSession(session, resolved)
    return { ...sessionMetadata(session), filePath: session.filePath, modifiedAt: resolved.stats.mtime.toISOString(), operations: [], document }
  }

  async stageWordOperations({ filePath, operations, source = 'editor', sourceClientId = '' }) {
    const resolved = this.#resolveDocument(filePath)
    if (resolved.kind !== 'word') throw new Error('Word 编辑只适用于 .docx 文件。')
    if (!Array.isArray(operations)) throw new Error('Word 编辑操作格式无效。')
    if (operations.length > WORD_MAX_OPERATIONS) throw new Error(`单个 Word 编辑会话最多保留 ${WORD_MAX_OPERATIONS} 项操作。`)
    await this.getWord({ filePath: resolved.filePath })
    const session = this.wordSessions.get(resolved.filePath)
    if (!session) throw new Error('Word 本地编辑会话创建失败。')
    const normalized = operations.map(normalizeWordOperation)
    const temporaryWorking = `${session.workingFilePath}.${randomUUID()}.tmp.docx`
    try {
      fs.copyFileSync(resolved.filePath, temporaryWorking)
      const commands = normalized.map((item) => item.command)
      for (let index = 0; index < commands.length; index += EXCEL_BATCH_SIZE) {
        await this.#runJsonWithLockRetry(['batch', temporaryWorking, '--commands', JSON.stringify(commands.slice(index, index + EXCEL_BATCH_SIZE))], 180_000)
      }
      fs.renameSync(temporaryWorking, session.workingFilePath)
    } finally {
      try { if (fs.existsSync(temporaryWorking)) fs.unlinkSync(temporaryWorking) } catch { /* best effort */ }
    }
    session.operations = normalized.map(({ command: _command, ...operation }) => operation)
    session.revision += 1
    const document = await this.#renderWordSession(session, resolved)
    this.#publishSession(session, { kind: 'changed', source, sourceClientId, operations: session.operations })
    return {
      filePath: session.filePath,
      sessionId: session.sessionId,
      revision: session.revision,
      dirty: session.operations.length > 0,
      pendingCount: session.operations.length,
      changed: session.operations.length,
      document,
      message: session.operations.length ? `已暂存 ${session.operations.length} 项 Word 修改，尚未写入原文件。` : '未保存的 Word 修改已撤销。',
    }
  }

  async saveWord({ filePath, source = 'editor', sourceClientId = '' }) {
    const resolved = this.#resolveDocument(filePath)
    if (resolved.kind !== 'word') throw new Error('Word 保存只适用于 .docx 文件。')
    await this.getWord({ filePath: resolved.filePath })
    return this.#queueFileSave(resolved.filePath, async () => {
      const session = this.wordSessions.get(resolved.filePath)
      if (!session) throw new Error('Word 本地编辑会话不存在。')
      if (!session.operations.length) {
        const document = await this.#renderWordSession(session, resolved)
        return { filePath: session.filePath, sessionId: session.sessionId, revision: session.revision, dirty: false, pendingCount: 0, saved: 0, document, message: '没有检测到需要保存的 Word 修改。' }
      }
      const expectedBytes = fs.readFileSync(session.workingFilePath)
      const expectedHash = createHash('sha256').update(expectedBytes).digest('hex')
      const temporary = `${resolved.filePath}.zsense-${process.pid}-${randomUUID()}.tmp`
      try {
        fs.copyFileSync(session.workingFilePath, temporary)
        fs.chmodSync(temporary, resolved.stats.mode)
        fs.renameSync(temporary, resolved.filePath)
      } finally {
        try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary) } catch { /* best effort */ }
      }
      const persistedBytes = fs.readFileSync(resolved.filePath)
      const persistedHash = createHash('sha256').update(persistedBytes).digest('hex')
      if (!persistedBytes.equals(expectedBytes) || persistedHash !== expectedHash) throw new Error('Word 写入后校验失败，磁盘内容与编辑内容不一致。')
      const updated = this.#resolveDocument(resolved.filePath)
      const savedCount = session.operations.length
      session.operations = []
      session.diskModifiedAt = updated.stats.mtimeMs
      session.diskSize = updated.stats.size
      session.revision += 1
      const document = await this.#renderWordSession(session, updated)
      this.#remember(document)
      this.#publishSession(session, { kind: 'saved', source, sourceClientId })
      return { filePath: session.filePath, sessionId: session.sessionId, revision: session.revision, dirty: false, pendingCount: 0, saved: savedCount, savedAt: updated.stats.mtime.toISOString(), bytesWritten: persistedBytes.byteLength, contentHash: persistedHash, document, message: `已将 ${savedCount} 项 Word 修改保存并校验。` }
    })
  }

  async discardWord({ filePath, sourceClientId = '' }) {
    const resolved = this.#resolveDocument(filePath)
    if (resolved.kind !== 'word') throw new Error('Word 放弃修改只适用于 .docx 文件。')
    const previous = this.wordSessions.get(resolved.filePath)
    this.wordSessions.delete(resolved.filePath)
    try { if (previous?.workingFilePath) fs.unlinkSync(previous.workingFilePath) } catch { /* best effort */ }
    const session = await this.getWord({ filePath: resolved.filePath })
    const active = this.wordSessions.get(resolved.filePath)
    if (previous && active) {
      active.sessionId = previous.sessionId
      active.revision = previous.revision + 1
      this.#publishSession(active, { kind: 'discarded', source: 'editor', sourceClientId })
      session.sessionId = active.sessionId
      session.sessionRevision = active.revision
    }
    return session
  }

  async getHtml({ filePath }) {
    const resolved = this.#resolveDocument(filePath)
    if (resolved.kind !== 'html') throw new Error('HTML 编辑会话只适用于 .html、.htm 或 .xhtml 文件。')
    let session = this.htmlSessions.get(resolved.filePath)
    if (!session) {
      const source = fs.readFileSync(resolved.filePath, 'utf8')
      session = {
        filePath: resolved.filePath,
        sessionId: randomUUID(),
        revision: 1,
        source,
        savedSource: source,
        modifiedAt: resolved.stats.mtime.toISOString(),
      }
      this.htmlSessions.set(resolved.filePath, session)
    }
    return { ...sessionMetadata(session), filePath: session.filePath, revision: session.revision, source: session.source, modifiedAt: session.modifiedAt }
  }

  readTextForAgent(filePath) {
    let resolved
    try { resolved = this.#resolveDocument(filePath) } catch { return null }
    if (resolved.kind !== 'html') return null
    return this.htmlSessions.get(resolved.filePath)?.source ?? fs.readFileSync(resolved.filePath, 'utf8')
  }

  synchronizeTextWrite(filePath, writtenSource, source = 'agent') {
    let resolved
    try { resolved = this.#resolveDocument(filePath) } catch { return false }
    if (resolved.kind !== 'html' || typeof writtenSource !== 'string') return false
    let session = this.htmlSessions.get(resolved.filePath)
    if (!session) {
      session = {
        filePath: resolved.filePath,
        sessionId: randomUUID(),
        revision: 1,
        source: writtenSource,
        savedSource: writtenSource,
        modifiedAt: resolved.stats.mtime.toISOString(),
      }
      this.htmlSessions.set(resolved.filePath, session)
    } else {
      session.source = writtenSource
      session.savedSource = writtenSource
      session.modifiedAt = resolved.stats.mtime.toISOString()
      session.revision += 1
    }
    this.#publishSession(session, { kind: 'saved', source })
    return true
  }

  async stageHtml({ filePath, source, sourceClientId = '' }) {
    const resolved = this.#resolveDocument(filePath)
    if (resolved.kind !== 'html') throw new Error('HTML 编辑只适用于 .html、.htm 或 .xhtml 文件。')
    if (typeof source !== 'string' || !source.trim()) throw new Error('HTML 内容不能为空。')
    if (Buffer.byteLength(source, 'utf8') > MAX_HTML_BYTES) throw new Error('HTML 内容超过 8 MB，无法暂存。')
    await this.getHtml({ filePath: resolved.filePath })
    const session = this.htmlSessions.get(resolved.filePath)
    session.source = source
    session.revision += 1
    this.#publishSession(session, { kind: 'changed', source: 'editor', sourceClientId })
    const metadata = sessionMetadata(session)
    return {
      filePath: session.filePath,
      sessionId: session.sessionId,
      revision: session.revision,
      dirty: metadata.dirty,
      pendingCount: metadata.pendingCount,
      changed: 1,
      message: 'HTML 修改已进入本地编辑会话，尚未写入磁盘。',
    }
  }

  async saveHtml({ filePath, source, expectedRevision, sourceClientId = '' }) {
    const resolved = this.#resolveDocument(filePath)
    if (resolved.kind !== 'html') throw new Error('HTML 保存只适用于 .html、.htm 或 .xhtml 文件。')
    if (typeof source !== 'string' || !source.trim()) throw new Error('HTML 保存内容不能为空。')
    if (Buffer.byteLength(source, 'utf8') > MAX_HTML_BYTES) throw new Error('HTML 内容超过 8 MB，无法保存。')
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new Error('HTML 保存版本无效，请重新打开文件后再试。')
    await this.getHtml({ filePath: resolved.filePath })
    const session = this.htmlSessions.get(resolved.filePath)
    return this.#queueFileSave(resolved.filePath, async () => {
      if (session.revision !== expectedRevision || session.source !== source) {
        throw new Error('HTML 内容已在其他位置更新。为避免覆盖新内容，请重新同步后再保存。')
      }
      const expectedBytes = Buffer.from(source, 'utf8')
      const expectedHash = createHash('sha256').update(expectedBytes).digest('hex')
      const temporary = `${resolved.filePath}.zsense-${process.pid}-${randomUUID()}.tmp`
      try {
        fs.writeFileSync(temporary, expectedBytes, { mode: resolved.stats.mode })
        fs.renameSync(temporary, resolved.filePath)
      } finally {
        try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary) } catch { /* best effort */ }
      }
      const persistedBytes = fs.readFileSync(resolved.filePath)
      const persistedHash = createHash('sha256').update(persistedBytes).digest('hex')
      if (!persistedBytes.equals(expectedBytes) || persistedHash !== expectedHash) {
        throw new Error('HTML 写入后校验失败，磁盘内容与编辑内容不一致。')
      }
      session.source = source
      session.savedSource = source
      session.modifiedAt = fs.statSync(resolved.filePath).mtime.toISOString()
      session.revision += 1
      this.#publishSession(session, { kind: 'saved', source: 'editor', sourceClientId })
      const document = await this.#render(this.#resolveDocument(resolved.filePath))
      this.#remember(document)
      return {
        filePath: session.filePath,
        sessionId: session.sessionId,
        revision: session.revision,
        dirty: false,
        pendingCount: 0,
        saved: 1,
        savedAt: session.modifiedAt,
        bytesWritten: persistedBytes.byteLength,
        contentHash: persistedHash,
        document,
        message: `HTML 已保存并校验（${persistedBytes.byteLength.toLocaleString('zh-CN')} 字节）。`,
      }
    })
  }

  async discardHtml({ filePath, sourceClientId = '' }) {
    const resolved = this.#resolveDocument(filePath)
    if (resolved.kind !== 'html') throw new Error('HTML 放弃修改只适用于 .html、.htm 或 .xhtml 文件。')
    const previous = this.htmlSessions.get(resolved.filePath)
    this.htmlSessions.delete(resolved.filePath)
    const session = await this.getHtml({ filePath: resolved.filePath })
    const active = this.htmlSessions.get(resolved.filePath)
    if (previous && active) {
      active.sessionId = previous.sessionId
      active.revision = previous.revision + 1
      this.#publishSession(active, { kind: 'discarded', source: 'editor', sourceClientId })
    }
    return session
  }

  async getSheet({ filePath, sheet }) {
    const resolved = this.#resolveDocument(filePath)
    if (resolved.extension !== '.xlsx' && !DELIMITED_EXTENSIONS.has(resolved.extension)) throw new Error('单元格编辑只适用于 .xlsx、.csv 或 .tsv 文件。')
    const sheetName = safeSheetName(sheet)
    const workbook = await this.getWorkbook({ filePath: resolved.filePath })
    const currentSheet = workbook.sheets.find((item) => item.sheet === sheetName)
    if (!currentSheet) throw new Error(`工作表“${sheetName}”不存在。`)
    return currentSheet
  }

  async getWorkbook({ filePath }) {
    const resolved = this.#resolveDocument(filePath)
    if (resolved.extension !== '.xlsx' && !DELIMITED_EXTENSIONS.has(resolved.extension)) throw new Error('工作簿编辑只适用于 .xlsx、.csv 或 .tsv 文件。')
    const current = this.workbookSessions.get(resolved.filePath)
    if (current && (current.pendingChanges.size || current.pendingOperations.size || current.modifiedAt === resolved.stats.mtimeMs)) {
      return { ...current.workbook, ...sessionMetadata(current) }
    }
    const delimited = DELIMITED_EXTENSIONS.has(resolved.extension) ? this.#delimitedWorkbook(resolved) : null
    const sheetNames = delimited ? [] : await this.#excelSheets(resolved.filePath)
    const sheets = delimited ? delimited.workbook.sheets : await Promise.all((sheetNames.length ? sheetNames : ['Sheet1']).map((sheetName) => this.#excelSheet(resolved.filePath, sheetName)))
    const sessionId = current?.sessionId || `office-${randomUUID()}`
    const revision = (current?.revision || 0) + 1
    const workbook = {
      filePath: resolved.filePath,
      revision: `${resolved.stats.mtimeMs}-${resolved.stats.size}`,
      sheets,
    }
    const session = {
      sessionId,
      filePath: resolved.filePath,
      modifiedAt: resolved.stats.mtimeMs,
      revision,
      workbook,
      pendingChanges: new Map(),
      pendingOperations: new Map(),
      delimitedMetadata: delimited?.metadata || null,
    }
    this.workbookSessions.set(resolved.filePath, session)
    return { ...workbook, ...sessionMetadata(session) }
  }

  async stageCells({ filePath, changes, source = 'editor', sourceClientId = '' }) {
    const resolved = this.#resolveDocument(filePath)
    if (resolved.extension !== '.xlsx' && !DELIMITED_EXTENSIONS.has(resolved.extension)) throw new Error('实时单元格编辑只适用于 .xlsx、.csv 或 .tsv 文件。')
    if (!Array.isArray(changes) || !changes.length) throw new Error('没有需要暂存的单元格修改。')
    if (changes.length > EXCEL_MAX_CHANGES) throw new Error(`单次最多暂存 ${EXCEL_MAX_CHANGES} 个单元格，请缩小操作范围。`)
    await this.getWorkbook({ filePath: resolved.filePath })
    const session = this.workbookSessions.get(resolved.filePath)
    if (!session) throw new Error('Excel 本地编辑会话创建失败。')
    const normalizedChanges = changes.map(normalizeCellChange).map((change) => DELIMITED_EXTENSIONS.has(resolved.extension) ? { ...change, style: undefined, formula: '', value: change.formula ? `=${change.formula.replace(/^=/, '')}` : change.value } : change)
    for (const change of normalizedChanges) {
      const sheet = session.workbook.sheets.find((item) => item.sheet === change.sheet)
      if (!sheet) throw new Error(`工作表“${change.sheet}”不存在。`)
      const key = `${change.sheet}!${change.cell}`
      session.pendingChanges.set(key, change)
      sheet.cells[change.cell] = sessionCellFromChange(sheet.cells[change.cell], change)
      const rowIndex = rowIndexFromAddress(change.cell)
      const columnIndex = columnIndexFromAddress(change.cell)
      sheet.usedRowCount = Math.max(sheet.usedRowCount, rowIndex + 1)
      sheet.usedColumnCount = Math.max(sheet.usedColumnCount, columnIndex + 1)
      sheet.rowCount = Math.max(sheet.rowCount, rowIndex + 1 + EXCEL_ROW_BUFFER)
      sheet.columnCount = Math.max(sheet.columnCount, columnIndex + 1 + EXCEL_COLUMN_BUFFER)
    }
    session.revision += 1
    this.#publishSession(session, { kind: 'changed', source, sourceClientId, changes: normalizedChanges })
    return {
      filePath: session.filePath,
      sessionId: session.sessionId,
      revision: session.revision,
      dirty: true,
      pendingCount: session.pendingChanges.size + session.pendingOperations.size,
      changed: normalizedChanges.length,
      message: `已在本地会话中暂存 ${normalizedChanges.length} 个单元格，尚未写入磁盘。`,
    }
  }

  async stageOperations({ filePath, operations, source = 'editor', sourceClientId = '' }) {
    const resolved = this.#resolveDocument(filePath)
    if (DELIMITED_EXTENSIONS.has(resolved.extension)) throw new Error('CSV/TSV 只保存单元格内容，不支持样式、冻结、图片、图表或多工作表功能。')
    if (resolved.extension !== '.xlsx') throw new Error('Excel 功能编辑只适用于 .xlsx 文件。')
    if (!Array.isArray(operations) || !operations.length) throw new Error('没有需要暂存的 Excel 功能操作。')
    if (operations.length > 100) throw new Error('单次最多暂存 100 项 Excel 功能操作。')
    await this.getWorkbook({ filePath: resolved.filePath })
    const session = this.workbookSessions.get(resolved.filePath)
    if (!session) throw new Error('Excel 本地编辑会话创建失败。')
    const normalized = operations.map(normalizeWorkbookOperation)
    for (const item of normalized) session.pendingOperations.set(item.key, item)
    session.revision += 1
    this.#publishSession(session, { kind: 'changed', source, sourceClientId, operations: normalized.map((item) => item.operation) })
    return {
      filePath: session.filePath,
      sessionId: session.sessionId,
      revision: session.revision,
      dirty: true,
      pendingCount: session.pendingChanges.size + session.pendingOperations.size,
      changed: normalized.length,
      message: `已暂存 ${normalized.length} 项 Excel 功能修改，点击保存后写入原文件。`,
    }
  }

  async replaceText({ filePath, find, replace }) {
    const resolved = this.#resolveDocument(filePath)
    if (resolved.kind === 'image') throw new Error('图片只支持在 ZSense 中查看，不支持文字替换。')
    if (!MODERN_EXTENSIONS.has(resolved.extension)) throw new Error('旧版 Office 文件需要先另存为 .docx、.xlsx 或 .pptx。')
    const findText = safeText(find, '要查找的文字')
    const replaceText = safeText(replace, '替换后的文字', { allowEmpty: true })
    const result = await this.#runJson(['set', resolved.filePath, '/', '--find', findText, '--replace', replaceText], 120_000)
    const matched = Number(result?.data?.matched ?? result?.matched ?? 0)
    const document = await this.#render(this.#resolveDocument(resolved.filePath))
    this.#remember(document)
    return { document, matched, message: matched > 0 ? `已替换 ${matched} 处内容并保存。` : '操作已完成；如果没有变化，请检查查找文字是否完全一致。' }
  }

  async setCell({ filePath, sheet, cell, value }) {
    const sheetName = safeSheetName(sheet)
    const cellAddress = safeCellAddress(cell)
    const cellValue = safeText(value, '单元格内容', { allowEmpty: true })
    const change = cellValue.startsWith('=')
      ? { sheet: sheetName, cell: cellAddress, value: null, formula: cellValue }
      : { sheet: sheetName, cell: cellAddress, value: cellValue }
    await this.stageCells({ filePath, changes: [change], source: 'system' })
    const result = await this.saveWorkbook({ filePath, source: 'system' })
    const savedCell = await this.#excelCell(this.#resolveDocument(filePath).filePath, sheetName, cellAddress)
    return { document: result.document, cell: savedCell, message: `${sheetName}!${cellAddress} 已写入并保存。` }
  }

  async setCells({ filePath, changes }) {
    await this.stageCells({ filePath, changes, source: 'system' })
    const result = await this.saveWorkbook({ filePath, source: 'system' })
    return { document: result.document, saved: result.saved, message: result.message }
  }

  async saveWorkbook({ filePath, source = 'editor', sourceClientId = '' }) {
    const resolved = this.#resolveDocument(filePath)
    if (resolved.extension !== '.xlsx' && !DELIMITED_EXTENSIONS.has(resolved.extension)) throw new Error('工作簿保存只适用于 .xlsx、.csv 或 .tsv 文件。')
    await this.getWorkbook({ filePath: resolved.filePath })
    return this.#queueFileSave(resolved.filePath, async () => {
      const session = this.workbookSessions.get(resolved.filePath)
      if (!session) throw new Error('Excel 本地编辑会话不存在。')
      const pendingSnapshot = new Map(session.pendingChanges)
      const operationSnapshot = new Map(session.pendingOperations)
      const changes = [...pendingSnapshot.values()]
      if (DELIMITED_EXTENSIONS.has(resolved.extension)) {
        if (!changes.length) {
          const document = await this.#render(this.#resolveDocument(resolved.filePath))
          return { filePath: session.filePath, sessionId: session.sessionId, revision: session.revision, dirty: false, pendingCount: 0, saved: 0, document, message: '没有检测到需要写回的单元格变化。' }
        }
        const sheet = session.workbook.sheets[0]
        const metadata = session.delimitedMetadata || { delimiter: resolved.extension === '.tsv' ? '\t' : ',', lineEnding: '\n', encoding: 'utf8', bom: false }
        let lastRow = Math.max(0, sheet.usedRowCount - 1)
        let lastColumn = Math.max(0, sheet.usedColumnCount - 1)
        for (const address of Object.keys(sheet.cells)) {
          lastRow = Math.max(lastRow, rowIndexFromAddress(address))
          lastColumn = Math.max(lastColumn, columnIndexFromAddress(address))
        }
        const rows = []
        for (let row = 0; row <= lastRow; row += 1) {
          const values = []
          for (let column = 0; column <= lastColumn; column += 1) {
            const cell = sheet.cells[`${columnNameFromIndex(column)}${row + 1}`]
            values.push(encodeDelimitedValue((cell?.formula || cell?.value) ?? '', metadata.delimiter))
          }
          rows.push(values.join(metadata.delimiter))
        }
        const temporary = `${resolved.filePath}.zsense-${process.pid}-${randomUUID()}.tmp`
        fs.writeFileSync(temporary, encodeDelimitedFile(`${rows.join(metadata.lineEnding)}${metadata.lineEnding}`, metadata), { mode: resolved.stats.mode })
        fs.renameSync(temporary, resolved.filePath)
        const updated = this.#resolveDocument(resolved.filePath)
        session.modifiedAt = updated.stats.mtimeMs
        for (const [key, change] of pendingSnapshot) if (JSON.stringify(session.pendingChanges.get(key)) === JSON.stringify(change)) session.pendingChanges.delete(key)
        session.revision += 1
        session.workbook.revision = `${updated.stats.mtimeMs}-${updated.stats.size}-session-${session.revision}`
        const document = await this.#render(updated)
        this.#remember(document)
        this.#publishSession(session, { kind: 'saved', source, sourceClientId })
        return { filePath: session.filePath, sessionId: session.sessionId, revision: session.revision, dirty: session.pendingChanges.size > 0, pendingCount: session.pendingChanges.size, document, saved: changes.length, message: `已将 ${changes.length} 个单元格保存回原 ${resolved.extension.slice(1).toUpperCase()} 文件。${metadata.encoding === 'gb18030' ? '原文件编码无法无损回写，已转换为 UTF-8 BOM。' : ''}` }
      }
      const commands = [
        ...[...operationSnapshot.values()].flatMap((item) => item.commands),
        ...changes.map(cellChangeToBatchCommand).filter(Boolean),
      ]
      if (!commands.length) {
        const document = await this.#render(this.#resolveDocument(resolved.filePath))
        return {
          filePath: session.filePath,
          sessionId: session.sessionId,
          revision: session.revision,
          dirty: false,
          pendingCount: 0,
          saved: 0,
          document,
          message: '没有检测到需要写回的单元格变化。',
        }
      }
      for (let index = 0; index < commands.length; index += EXCEL_BATCH_SIZE) {
        const batch = commands.slice(index, index + EXCEL_BATCH_SIZE)
        await this.#runJsonWithLockRetry(['batch', resolved.filePath, '--commands', JSON.stringify(batch)], 180_000)
      }
      const updated = this.#resolveDocument(resolved.filePath)
      session.modifiedAt = updated.stats.mtimeMs
      for (const [key, change] of pendingSnapshot) {
        if (JSON.stringify(session.pendingChanges.get(key)) === JSON.stringify(change)) session.pendingChanges.delete(key)
      }
      for (const [key, operation] of operationSnapshot) {
        if (JSON.stringify(session.pendingOperations.get(key)) === JSON.stringify(operation)) session.pendingOperations.delete(key)
      }
      session.revision += 1
      session.workbook.revision = `${updated.stats.mtimeMs}-${updated.stats.size}-session-${session.revision}`
      const document = await this.#render(updated)
      this.#remember(document)
      this.#publishSession(session, { kind: 'saved', source, sourceClientId })
      return {
        filePath: session.filePath,
        sessionId: session.sessionId,
        revision: session.revision,
        dirty: session.pendingChanges.size > 0 || session.pendingOperations.size > 0,
        pendingCount: session.pendingChanges.size + session.pendingOperations.size,
        document,
        saved: changes.length + operationSnapshot.size,
        message: `已保存 ${changes.length} 个单元格和 ${operationSnapshot.size} 项功能修改到原文件。`,
      }
    })
  }

  async discardWorkbook({ filePath, sourceClientId = '' }) {
    const resolved = this.#resolveDocument(filePath)
    const previous = this.workbookSessions.get(resolved.filePath)
    this.workbookSessions.delete(resolved.filePath)
    const workbook = await this.getWorkbook({ filePath: resolved.filePath })
    const session = this.workbookSessions.get(resolved.filePath)
    if (session) {
      if (previous) {
        session.sessionId = previous.sessionId
        session.revision = previous.revision + 1
      }
      this.#publishSession(session, { kind: 'discarded', source: 'editor', sourceClientId })
      return { ...session.workbook, ...sessionMetadata(session) }
    }
    return workbook
  }

  discoverArtifacts({ workspacePath, content = '', toolEvents = [], since = 0 }) {
    let workspaceRoot
    try {
      workspaceRoot = fs.realpathSync.native(path.resolve(String(workspacePath || '')))
      if (!fs.statSync(workspaceRoot).isDirectory()) return []
    } catch { return [] }

    const documents = new Map()
    const startedAt = Math.max(0, Number(since) || 0)
    const remember = (candidate) => {
      if (documents.size >= 8 || !candidate) return
      let resolvedPath
      try {
        const normalized = /^file:\/\//i.test(candidate)
          ? fileURLToPath(new URL(candidate))
          : path.isAbsolute(candidate)
            ? candidate
            : path.resolve(workspaceRoot, candidate.replace(/^\.\/?/, ''))
        resolvedPath = fs.realpathSync.native(path.resolve(normalized))
        if (!isInsideOrEqual(workspaceRoot, resolvedPath)) return
        const stats = fs.statSync(resolvedPath)
        const extension = path.extname(resolvedPath).toLowerCase()
        if (!stats.isFile() || !ALL_EXTENSIONS.has(extension) || stats.size <= 0 || stats.size > MAX_FILE_BYTES) return
        // 旧图片可能再次出现在回复或工具结果里；只有本轮新建或修改的图片才挂到本条消息下。
        if (IMAGE_EXTENSIONS.has(extension) && stats.mtimeMs < startedAt) return
        documents.set(resolvedPath, { resolvedPath, stats, extension })
      } catch { /* output may mention a file that no longer exists */ }
    }

    const sourceText = [
      String(content || ''),
      ...toolEvents.flatMap((event) => [event?.output, event?.detail]).filter((value) => typeof value === 'string'),
    ].join('\n')
    const patterns = [
      /\]\((?:<)?([^)>\n]+\.(?:docx|xlsx|csv|tsv|pptx|doc|xls|ppt))(?:>)?\)/gi,
      /(?:^|[\s"'`])((?:file:\/\/\/|\/|[A-Za-z]:[\\/])[^<>\n"'`|]+?\.(?:docx|xlsx|csv|tsv|pptx|doc|xls|ppt))/gi,
    ]
    patterns.push(/\]\((?:<)?([^)>\n]+\.(?:html?|xhtml))(?:>)?\)/gi)
    patterns.push(/(?:^|[\s"'])((?:file:\/\/\/|\/|[A-Za-z]:[\\/])[^<>\n"'|]+?\.(?:html?|xhtml))/gi)
    patterns.push(/\]\((?:<)?([^)>\n]+\.(?:png|jpe?g|gif|webp|bmp|tiff?|svg|ico))(?:>)?\)/gi)
    patterns.push(/(?:^|[\s"'])((?:file:\/\/\/|\/|[A-Za-z]:[\\/])[^<>\n"'|]+?\.(?:png|jpe?g|gif|webp|bmp|tiff?|svg|ico))/gi)
    for (const pattern of patterns) {
      for (const match of sourceText.matchAll(pattern)) remember(String(match[1] || '').trim())
    }

    let visited = 0
    const walk = (directory, depth) => {
      if (depth > 8 || visited >= MAX_DISCOVERY_FILES || documents.size >= 8) return
      let entries
      try { entries = fs.readdirSync(directory, { withFileTypes: true }) } catch { return }
      for (const entry of entries) {
        if (visited >= MAX_DISCOVERY_FILES || documents.size >= 8) return
        if (entry.isSymbolicLink()) continue
        const target = path.join(directory, entry.name)
        if (entry.isDirectory()) {
          if (!DISCOVERY_IGNORED_DIRECTORIES.has(entry.name) && !entry.name.startsWith('.')) walk(target, depth + 1)
          continue
        }
        if (!entry.isFile() || !ALL_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue
        visited += 1
        try {
          if (fs.statSync(target).mtimeMs >= startedAt) remember(target)
        } catch { /* file may disappear while an editor operation is finishing */ }
      }
    }
    walk(workspaceRoot, 0)

    return [...documents.values()].map(({ resolvedPath, stats, extension }) => ({
      id: `artifact-${createHash('sha256').update(`${resolvedPath}\0${stats.mtimeMs}`).digest('hex').slice(0, 24)}`,
      name: path.basename(resolvedPath),
      path: resolvedPath,
      size: stats.size,
      mimeType: extension === '.docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        : extension === '.xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
          : extension === '.csv' ? 'text/csv'
            : extension === '.tsv' ? 'text/tab-separated-values'
          : extension === '.pptx' ? 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
            : HTML_EXTENSIONS.has(extension) ? 'text/html'
              : IMAGE_EXTENSIONS.get(extension) || 'application/octet-stream',
      kind: IMAGE_EXTENSIONS.has(extension) ? 'image' : 'file',
    }))
  }

  resolveExternalPath(filePath) {
    return this.#resolveDocument(filePath).filePath
  }

  resolveImagePath(filePath) {
    const resolved = this.#resolveDocument(filePath)
    if (resolved.kind !== 'image') throw new Error('该文件不是 ZSense 支持的图片格式。')
    return resolved.filePath
  }

  inlineImage({ workspacePath, filePath }) {
    let workspaceRoot
    try {
      workspaceRoot = fs.realpathSync.native(path.resolve(String(workspacePath || '')))
      if (!fs.statSync(workspaceRoot).isDirectory()) throw new Error('不是文件夹')
    } catch { throw new Error('会话工作区不存在或无法访问。') }
    const requested = path.isAbsolute(filePath) ? filePath : path.resolve(workspaceRoot, filePath)
    const resolved = this.#resolveDocument(requested)
    if (resolved.kind !== 'image' || !isInsideOrEqual(workspaceRoot, resolved.filePath)) {
      throw new Error('只允许预览当前会话工作区内的图片。')
    }
    // URL 只包含不可猜测的会话内令牌，不暴露本机绝对路径；同一文件复用令牌。
    const token = createHmac('sha256', this.inlinePreviewSecret).update(resolved.filePath).digest('hex').slice(0, 32)
    this.previewTokens.set(token, { kind: 'image', filePath: resolved.filePath, mimeType: IMAGE_EXTENSIONS.get(resolved.extension), workspaceRoot })
    const preview = new URL(`zsense-office://preview/${token}`)
    preview.searchParams.set('v', String(resolved.stats.mtimeMs))
    return { previewUrl: preview.toString() }
  }

  previewResponse(requestUrl) {
    let token = ''
    let hostname = ''
    let assetPath = ''
    try {
      const url = new URL(requestUrl)
      hostname = url.hostname
      const parts = url.pathname.replace(/^\/+/, '').split('/')
      token = parts.shift() || ''
      assetPath = decodeURIComponent(parts.join('/'))
    } catch { return new Response('Bad request', { status: 400 }) }
    const record = this.previewTokens.get(token)
    if (!record) return new Response('Preview expired', { status: 404 })
    if (record.workspaceRoot) {
      try {
        if (!isInsideOrEqual(record.workspaceRoot, fs.realpathSync.native(record.filePath))) return new Response('Forbidden', { status: 403 })
      } catch { return new Response('Not found', { status: 404 }) }
    }
    if (hostname === 'asset' && record.kind === 'html') {
      let resolvedAsset
      try {
        const root = path.dirname(record.filePath)
        const requested = path.resolve(root, assetPath || path.basename(record.filePath))
        resolvedAsset = fs.realpathSync(requested)
        if (!isInsideOrEqual(root, resolvedAsset) || !fs.statSync(resolvedAsset).isFile()) return new Response('Not found', { status: 404 })
      } catch { return new Response('Not found', { status: 404 }) }
      return new Response(fs.readFileSync(resolvedAsset), {
        status: 200,
        headers: { 'content-type': htmlContentType(path.extname(resolvedAsset).toLowerCase()), 'cache-control': 'no-store' },
      })
    }
    if (hostname !== 'preview') return new Response('Not found', { status: 404 })
    let body
    let contentType = 'text/html; charset=utf-8'
    if (record.kind === 'html') {
      if (!fs.existsSync(record.filePath)) return new Response('Preview expired', { status: 404 })
      const source = this.htmlSessions.get(record.filePath)?.source ?? fs.readFileSync(record.filePath, 'utf8')
      body = injectHtmlEditorRuntime(source, token)
    } else {
      if (!fs.existsSync(record.filePath)) return new Response('Preview expired', { status: 404 })
      body = record.kind === 'word-generated'
        ? injectWordEditorRuntime(fs.readFileSync(record.filePath, 'utf8'))
        : fs.readFileSync(record.filePath)
      if (record.kind === 'image' || record.kind === 'pdf') contentType = record.mimeType || 'application/octet-stream'
    }
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': contentType,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        ...(['image', 'pdf'].includes(record.kind) ? { 'content-disposition': 'inline; filename="' + path.basename(record.filePath).replace(/["\\\r\n]/g, '_') + '"' } : {}),
        'content-security-policy': record.kind === 'html'
          ? "default-src zsense-office: data: blob:; script-src 'unsafe-inline' 'unsafe-eval' zsense-office: data: blob:; style-src 'unsafe-inline' zsense-office: data: blob:; img-src zsense-office: data: blob:; font-src zsense-office: data:; media-src zsense-office: data: blob:; connect-src zsense-office:; frame-src 'none'; object-src 'none';"
          : "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none';",
      },
    })
  }
}
