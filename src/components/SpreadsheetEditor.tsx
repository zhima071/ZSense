import type { ICellData, IStyleData, IWorkbookData } from '@univerjs/presets'
import { createUniver, defaultTheme, LocaleType, mergeLocales } from '@univerjs/presets'
import { UniverSheetsConditionalFormattingPreset } from '@univerjs/preset-sheets-conditional-formatting'
import conditionalFormattingZhCN from '@univerjs/preset-sheets-conditional-formatting/locales/zh-CN'
import { UniverSheetsCorePreset } from '@univerjs/preset-sheets-core'
import coreZhCN from '@univerjs/preset-sheets-core/locales/zh-CN'
import { UniverSheetsDataValidationPreset } from '@univerjs/preset-sheets-data-validation'
import dataValidationZhCN from '@univerjs/preset-sheets-data-validation/locales/zh-CN'
import { UniverSheetsDrawingPreset } from '@univerjs/preset-sheets-drawing'
import drawingZhCN from '@univerjs/preset-sheets-drawing/locales/zh-CN'
import { UniverSheetsFilterPreset } from '@univerjs/preset-sheets-filter'
import filterZhCN from '@univerjs/preset-sheets-filter/locales/zh-CN'
import { UniverSheetsFindReplacePreset } from '@univerjs/preset-sheets-find-replace'
import findReplaceZhCN from '@univerjs/preset-sheets-find-replace/locales/zh-CN'
import { UniverSheetsHyperLinkPreset } from '@univerjs/preset-sheets-hyper-link'
import hyperLinkZhCN from '@univerjs/preset-sheets-hyper-link/locales/zh-CN'
import { UniverSheetsNotePreset } from '@univerjs/preset-sheets-note'
import noteZhCN from '@univerjs/preset-sheets-note/locales/zh-CN'
import { UniverSheetsSortPreset } from '@univerjs/preset-sheets-sort'
import sortZhCN from '@univerjs/preset-sheets-sort/locales/zh-CN'
import { UniverSheetsTablePreset } from '@univerjs/preset-sheets-table'
import tableZhCN from '@univerjs/preset-sheets-table/locales/zh-CN'
import '@univerjs/preset-sheets-core/lib/index.css'
import '@univerjs/preset-sheets-conditional-formatting/lib/index.css'
import '@univerjs/preset-sheets-data-validation/lib/index.css'
import '@univerjs/preset-sheets-drawing/lib/index.css'
import '@univerjs/preset-sheets-filter/lib/index.css'
import '@univerjs/preset-sheets-find-replace/lib/index.css'
import '@univerjs/preset-sheets-hyper-link/lib/index.css'
import '@univerjs/preset-sheets-note/lib/index.css'
import '@univerjs/preset-sheets-sort/lib/index.css'
import '@univerjs/preset-sheets-table/lib/index.css'
import {
  AlertTriangle, ArrowDownAZ, ArrowUpAZ, BarChart3, Calculator, Check, ChevronRight,
  Columns3, Database, Filter, Grid3X3, ImagePlus, Link2, ListChecks, ListPlus, LoaderCircle,
  Menu, Moon, PanelTop, RefreshCw, Rows3, Ruler, Save, Shapes, Sigma, Snowflake,
  SplitSquareVertical, Table2, Tags, WandSparkles, X, ZoomIn,
  type LucideIcon,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { errorMessage, unwrapDesktop } from '../services/desktop'
import type { OfficeDocumentState, OfficeSheetCell, OfficeSheetCellChange, OfficeSheetCellStyle, OfficeWorkbookGrid, OfficeWorkbookOperation } from '../types'
import UniverWorker from '../workers/univer.worker?worker'

interface SpreadsheetEditorProps {
  document: OfficeDocumentState
  workspacePath?: string
  onDocumentChange: (document: OfficeDocumentState) => void
  onFeedback: (feedback: { tone: 'success' | 'error'; message: string } | null) => void
  onDirtyChange?: (dirty: boolean) => void
  onAskAI?: (prompt: string, behavior: 'send' | 'insert') => void
}

type SaveState = 'loading' | 'ready' | 'dirty' | 'saving' | 'saved' | 'error'
type FeatureCategory = 'insert' | 'data' | 'formula' | 'view'
type FeatureId =
  | 'pivot' | 'insertRows' | 'insertColumns' | 'insertCellsDown' | 'insertCellsRight' | 'table'
  | 'chart' | 'sparkline' | 'shape' | 'hyperlink' | 'picture' | 'filter' | 'sortAsc' | 'sortDesc'
  | 'conditional' | 'splitText' | 'groupRows' | 'groupColumns' | 'validation' | 'dropdown'
  | 'functionCatalog' | 'namedRange' | 'quickName' | 'calculation' | 'freezeRow' | 'freezeColumn'
  | 'freezeSelection' | 'unfreeze' | 'rowHeight' | 'columnWidth' | 'zoom75' | 'zoom100'
  | 'zoom125' | 'darkMode' | 'gridlines'

interface SpreadsheetFeature {
  id: FeatureId
  label: string
  description: string
  icon: LucideIcon
  category: FeatureCategory
  configurable?: boolean
}

interface UniverRangeFacade {
  getA1Notation: () => string
  getRange: () => { startRow: number; startColumn: number; endRow: number; endColumn: number }
  insertCells: (dimension: unknown) => void
  merge: (options?: { isForceMerge?: boolean }) => unknown
  breakApart: () => unknown
  createFilter: () => unknown
  sort: (column: number | { column: number; ascending: boolean }) => unknown
  splitTextToColumns: (treatMultipleDelimitersAsOne?: boolean, delimiter?: unknown) => void
  setHyperLink: (url: string, label?: string) => Promise<boolean>
  setDataValidation: (rule: unknown) => unknown
  activate: () => unknown
  attachRangePopup: (popup: {
    componentKey: () => React.ReactNode
    direction?: 'bottom-center' | 'top-center'
    offset?: [number, number]
    hideOnInvisible?: boolean
    hiddenType?: 'hide' | 'destroy'
    zIndex?: number
  }) => { dispose: () => void } | null
}

interface UniverWorksheetFacade {
  activate: () => unknown
  getSheetName: () => string
  getActiveRange: () => UniverRangeFacade | null
  getRange: (notation: string) => UniverRangeFacade
  insertRowsBefore: (index: number, count: number) => unknown
  insertColumnsBefore: (index: number, count: number) => unknown
  addTable: (name: string, range: unknown, id?: string, options?: Record<string, unknown>) => Promise<boolean> | boolean
  setRowHeightsForced: (start: number, count: number, height: number) => unknown
  setColumnWidths: (start: number, count: number, width: number) => unknown
  setFrozenRows: (...args: number[]) => unknown
  setFrozenColumns: (...args: number[]) => unknown
  setFreeze: (freeze: { startRow: number; startColumn: number; xSplit: number; ySplit: number }) => unknown
  cancelFreeze: () => unknown
  setHiddenGridlines: (hidden: boolean) => unknown
  zoom: (ratio: number) => unknown
}

interface UniverWorkbookFacade {
  getId: () => string
  getActiveSheet: () => UniverWorksheetFacade
  getSheetByName: (name: string) => UniverWorksheetFacade | null
}

interface UniverFacade {
  getActiveWorkbook: () => UniverWorkbookFacade | null
  syncExecuteCommand: (id: string, params: Record<string, unknown>) => boolean
  newDataValidation: () => {
    requireValueInList: (values: string[]) => unknown
    requireNumberBetween: (minimum: number, maximum: number) => unknown
    setOptions: (options: Record<string, unknown>) => unknown
    build: () => unknown
  }
  Enum: { Dimension: { ROWS: unknown; COLUMNS: unknown }; SplitDelimiterType?: Record<string, unknown> }
}

const featureCategoryNames: Record<FeatureCategory, string> = { insert: '插入', data: '数据', formula: '公式', view: '视图' }

function initialFeatureFields(feature: FeatureId, selection: string): Record<string, string> {
  const suffix = Date.now().toString(36).slice(-5)
  switch (feature) {
    case 'pivot': return { range: selection, target: 'H1', name: `Pivot_${suffix}`, rows: '', values: '', cols: '', filters: '' }
    case 'table': return { range: selection, name: `Table_${suffix}`, mode: 'medium2' }
    case 'chart': return { range: selection, mode: 'column', value: '数据图表' }
    case 'sparkline': return { range: selection, target: 'G2', mode: 'line' }
    case 'shape': return { mode: 'roundRect', value: '文本', fill: '#DBEAFE' }
    case 'hyperlink': return { range: selection.split(':')[0], value: 'https://', secondaryValue: '' }
    case 'conditional': return { range: selection, mode: 'cellIs', operator: 'greaterThan', value: '0', value2: '', fill: '#DBEAFE', color: '#2563EB' }
    case 'validation': return { range: selection, mode: 'decimal', operator: 'between', formula1: '0', formula2: '100', error: '请输入有效数值' }
    case 'dropdown': return { range: selection, values: '选项一,选项二,选项三' }
    case 'namedRange':
    case 'quickName': return { range: selection, name: `Range_${suffix}`, value: '' }
    case 'calculation': return { mode: 'auto' }
    case 'rowHeight': return { range: selection, size: '24' }
    case 'columnWidth': return { range: selection, size: '12' }
    default: return { range: selection }
  }
}

const spreadsheetFeatures: SpreadsheetFeature[] = [
  { id: 'pivot', label: '数据透视表', description: '按字段汇总并生成透视结果', icon: Database, category: 'insert', configurable: true },
  { id: 'insertRows', label: '插入行', description: '在当前选择上方插入行', icon: Rows3, category: 'insert' },
  { id: 'insertColumns', label: '插入列', description: '在当前选择左侧插入列', icon: Columns3, category: 'insert' },
  { id: 'insertCellsDown', label: '单元格下移', description: '插入单元格并向下移动', icon: PanelTop, category: 'insert' },
  { id: 'insertCellsRight', label: '单元格右移', description: '插入单元格并向右移动', icon: ChevronRight, category: 'insert' },
  { id: 'table', label: '表格', description: '把所选区域转换为结构化表格', icon: Table2, category: 'insert', configurable: true },
  { id: 'chart', label: '图表', description: '柱状、折线、饼图等常用图表', icon: BarChart3, category: 'insert', configurable: true },
  { id: 'sparkline', label: '迷你图', description: '在单元格中展示微型趋势图', icon: Sigma, category: 'insert', configurable: true },
  { id: 'shape', label: '形状', description: '插入带文字的常用形状', icon: Shapes, category: 'insert', configurable: true },
  { id: 'hyperlink', label: '链接', description: '为当前单元格添加外部或工作表链接', icon: Link2, category: 'insert', configurable: true },
  { id: 'picture', label: '浮动图片', description: '从电脑选择图片并嵌入工作簿', icon: ImagePlus, category: 'insert' },
  { id: 'filter', label: '筛选', description: '为所选数据区域启用筛选', icon: Filter, category: 'data' },
  { id: 'sortAsc', label: '升序排序', description: '按所选区域第一列升序', icon: ArrowUpAZ, category: 'data' },
  { id: 'sortDesc', label: '降序排序', description: '按所选区域第一列降序', icon: ArrowDownAZ, category: 'data' },
  { id: 'conditional', label: '条件格式', description: '按数值或文本规则突出显示', icon: Grid3X3, category: 'data', configurable: true },
  { id: 'splitText', label: '分列', description: '按常用分隔符拆分当前列', icon: SplitSquareVertical, category: 'data' },
  { id: 'groupRows', label: '行分组', description: '将所选行设置为可折叠分组', icon: Rows3, category: 'data' },
  { id: 'groupColumns', label: '列分组', description: '将所选列设置为可折叠分组', icon: Columns3, category: 'data' },
  { id: 'validation', label: '数据验证', description: '限制数字输入范围并显示错误提示', icon: ListChecks, category: 'data', configurable: true },
  { id: 'dropdown', label: '下拉选项', description: '为所选单元格创建候选值列表', icon: ListPlus, category: 'data', configurable: true },
  { id: 'functionCatalog', label: '函数分类', description: '常用、财务、日期、数学、统计等完整分类', icon: Sigma, category: 'formula' },
  { id: 'namedRange', label: '名称管理', description: '为所选区域创建工作簿名称', icon: Tags, category: 'formula', configurable: true },
  { id: 'quickName', label: '快速创建', description: '根据当前选择快速创建名称', icon: ListPlus, category: 'formula', configurable: true },
  { id: 'calculation', label: '计算选项', description: '自动、手动或数据表除外', icon: Calculator, category: 'formula', configurable: true },
  { id: 'freezeRow', label: '冻结首行', description: '滚动时保留第一行', icon: Snowflake, category: 'view' },
  { id: 'freezeColumn', label: '冻结首列', description: '滚动时保留第一列', icon: Snowflake, category: 'view' },
  { id: 'freezeSelection', label: '冻结至当前位置', description: '冻结当前单元格上方和左侧', icon: Snowflake, category: 'view' },
  { id: 'unfreeze', label: '取消冻结', description: '恢复自由滚动', icon: X, category: 'view' },
  { id: 'rowHeight', label: '行高', description: '设置当前所选行的高度', icon: Ruler, category: 'view', configurable: true },
  { id: 'columnWidth', label: '列宽', description: '设置当前所选列的宽度', icon: Ruler, category: 'view', configurable: true },
  { id: 'zoom75', label: '75%', description: '缩小显示更多内容', icon: ZoomIn, category: 'view' },
  { id: 'zoom100', label: '100%', description: '恢复默认显示比例', icon: ZoomIn, category: 'view' },
  { id: 'zoom125', label: '125%', description: '放大单元格内容', icon: ZoomIn, category: 'view' },
  { id: 'darkMode', label: '深色模式', description: '切换当前编辑器明暗外观', icon: Moon, category: 'view' },
  { id: 'gridlines', label: '隐藏/显示网格线', description: '切换当前工作表网格线', icon: Grid3X3, category: 'view' },
]

const MAX_PENDING_CELLS = 20_000
const horizontalAlignment: Record<number, string> = { 1: 'left', 2: 'center', 3: 'right', 4: 'justify', 5: 'justify', 6: 'distributed' }
const verticalAlignment: Record<number, string> = { 1: 'top', 2: 'center', 3: 'bottom' }
const officeThemeToUniver: Record<string, number> = {
  DK1: 0, LT1: 1, DK2: 2, LT2: 3, ACCENT1: 4, ACCENT2: 5, ACCENT3: 6,
  ACCENT4: 7, ACCENT5: 8, ACCENT6: 9, HLINK: 10, HYPERLINK: 10,
  FOLHLINK: 11, FOLLOWEDHYPERLINK: 11,
}
const univerThemeToOffice = ['DK1', 'LT1', 'DK2', 'LT2', 'ACCENT1', 'ACCENT2', 'ACCENT3', 'ACCENT4', 'ACCENT5', 'ACCENT6', 'HLINK', 'FOLHLINK']
const styleKeys: Array<keyof OfficeSheetCellStyle> = ['fontName', 'fontSize', 'bold', 'italic', 'underline', 'strike', 'fontColor', 'fill', 'numberFormat', 'horizontalAlignment', 'verticalAlignment', 'wrapText']
const cellStyleDefaults: OfficeSheetCellStyle = { fontName: 'Calibri', fontSize: 11, bold: false, italic: false, underline: 'none', strike: false, fontColor: '#000000', fill: 'none', numberFormat: 'General', horizontalAlignment: 'left', verticalAlignment: 'bottom', wrapText: false }

function addressFromPosition(row: number, column: number) {
  let current = column + 1
  let name = ''
  while (current > 0) {
    const remainder = (current - 1) % 26
    name = String.fromCharCode(65 + remainder) + name
    current = Math.floor((current - 1) / 26)
  }
  return `${name}${row + 1}`
}

function positionFromAddress(address: string) {
  const match = /^([A-Z]+)([1-9]\d*)$/.exec(address)
  if (!match) return { row: 0, column: 0 }
  let column = 0
  for (const character of match[1]) column = column * 26 + character.charCodeAt(0) - 64
  return { row: Number(match[2]) - 1, column: column - 1 }
}

function numberValue(cell: OfficeSheetCell) {
  const number = Number(cell.display)
  return Number.isFinite(number) ? number : cell.display
}

function cellValue(cell: OfficeSheetCell) {
  const type = cell.dataType.toLowerCase()
  if (type === 'number') return numberValue(cell)
  if (type === 'boolean') return /^(true|1)$/i.test(cell.display)
  return cell.display
}

function univerStyle(style?: OfficeSheetCellStyle): IStyleData | undefined {
  if (!style) return undefined
  const result: IStyleData = {}
  if (style.fontName) result.ff = style.fontName
  if (style.fontSize) result.fs = style.fontSize
  if (style.bold !== undefined) result.bl = style.bold ? 1 : 0
  if (style.italic !== undefined) result.it = style.italic ? 1 : 0
  if (style.fontColor) {
    const theme = officeThemeToUniver[style.fontColor.replace(/^#/, '').toUpperCase()]
    result.cl = theme === undefined ? { rgb: style.fontColor } : { th: theme }
  }
  if (style.fill) {
    const theme = officeThemeToUniver[style.fill.replace(/^#/, '').toUpperCase()]
    result.bg = theme === undefined ? { rgb: style.fill } : { th: theme }
  }
  if (style.numberFormat) result.n = { pattern: style.numberFormat }
  if (style.horizontalAlignment) {
    const value = Object.entries(horizontalAlignment).find(([, label]) => label === style.horizontalAlignment)?.[0]
    if (value) result.ht = Number(value)
  }
  if (style.verticalAlignment) {
    const value = Object.entries(verticalAlignment).find(([, label]) => label === style.verticalAlignment)?.[0]
    if (value) result.vt = Number(value)
  }
  if (style.wrapText !== undefined) result.tb = style.wrapText ? 3 : 1
  if (style.underline) result.ul = { s: style.underline === 'none' ? 0 : 1, t: style.underline === 'double' ? 10 : 12 }
  if (style.strike !== undefined) result.st = { s: style.strike ? 1 : 0 }
  return result
}

function workbookSnapshot(workbook: OfficeWorkbookGrid, name: string): Partial<IWorkbookData> {
  const sheets: IWorkbookData['sheets'] = {}
  const sheetOrder: string[] = []
  for (const sheet of workbook.sheets) {
    const cellData: Record<number, Record<number, ICellData>> = {}
    for (const cell of Object.values(sheet.cells)) {
      const { row, column } = positionFromAddress(cell.address)
      cellData[row] ||= {}
      const data: ICellData = cell.formula ? { f: cell.formula } : { v: cellValue(cell) }
      const style = univerStyle(cell.style)
      if (style) data.s = style
      cellData[row][column] = data
    }
    sheets[sheet.id] = {
      id: sheet.id,
      name: sheet.sheet,
      rowCount: sheet.rowCount,
      columnCount: sheet.columnCount,
      defaultColumnWidth: 96,
      defaultRowHeight: 24,
      cellData,
    }
    sheetOrder.push(sheet.id)
  }
  return {
    id: `zsense-${workbook.revision.replace(/[^A-Za-z0-9_-]/g, '-')}`,
    name,
    locale: LocaleType.ZH_CN,
    sheetOrder,
    sheets,
  }
}

function cellStyle(style: IStyleData | null | undefined | void): OfficeSheetCellStyle | undefined {
  if (!style) return undefined
  const underline = style.ul?.s === 0 ? 'none' : style.ul?.s === 1 ? (style.ul.t === 10 ? 'double' : 'single') : ''
  return {
    fontName: style.ff || '',
    fontSize: style.fs || undefined,
    bold: style.bl === undefined || style.bl === null ? undefined : style.bl === 1,
    italic: style.it === undefined || style.it === null ? undefined : style.it === 1,
    underline,
    strike: style.st?.s === undefined ? undefined : style.st.s === 1,
    fontColor: style.cl?.rgb || (style.cl?.th !== undefined && style.cl?.th !== null ? univerThemeToOffice[Number(style.cl.th)] || '' : ''),
    fill: style.bg?.rgb || (style.bg?.th !== undefined && style.bg?.th !== null ? univerThemeToOffice[Number(style.bg.th)] || '' : ''),
    numberFormat: style.n?.pattern || '',
    horizontalAlignment: style.ht ? horizontalAlignment[style.ht] || '' : '',
    verticalAlignment: style.vt ? verticalAlignment[style.vt] || '' : '',
    wrapText: style.tb === undefined || style.tb === null ? undefined : style.tb === 3,
  }
}

function comparableStyle(style?: OfficeSheetCellStyle) {
  return cellStyle(univerStyle(style))
}

function editorCellState(sheet: string, address: string, cell?: OfficeSheetCell): OfficeSheetCellChange {
  return {
    sheet,
    cell: address,
    value: cell?.formula ? null : cell ? cellValue(cell) : '',
    formula: cell?.formula || '',
    style: comparableStyle(cell?.style),
  }
}

function sameValue(left: unknown, right: unknown) {
  return left === right || String(left ?? '') === String(right ?? '')
}

function comparableStyleValue(style: OfficeSheetCellStyle | undefined, key: keyof OfficeSheetCellStyle) {
  const value = style?.[key]
  return value === undefined || value === '' ? cellStyleDefaults[key] : value
}

function sameCellState(left?: OfficeSheetCellChange, right?: OfficeSheetCellChange) {
  if (!left || !right || !sameValue(left.value, right.value) || (left.formula || '') !== (right.formula || '')) return false
  return styleKeys.every((key) => comparableStyleValue(left.style, key) === comparableStyleValue(right.style, key))
}

function canApplyWorkbookIncrementally(previous: OfficeWorkbookGrid, next: OfficeWorkbookGrid, operations?: unknown[]) {
  // Structural/feature edits still use a full reload; ordinary Agent cell edits
  // must not recreate Univer, its formula worker, selection, or undo stack.
  return !operations?.length && previous.sheets.length === next.sheets.length && previous.sheets.every((sheet, index) => {
    const nextSheet = next.sheets[index]
    return sheet.id === nextSheet.id && sheet.sheet === nextSheet.sheet
      && sheet.rowCount === nextSheet.rowCount && sheet.columnCount === nextSheet.columnCount
  })
}

function incrementalCellData(state: OfficeSheetCellChange): ICellData {
  const style = univerStyle(state.style)
  return {
    v: state.formula ? null : state.value ?? '',
    f: state.formula || null,
    // Explicit nulls remove a previous formula/known style instead of merging
    // its stale fields. Leave unsupported metadata (e.g. cell notes) untouched.
    s: style ? { ff: null, fs: null, bl: null, it: null, ul: null, st: null, cl: null, bg: null, n: null, ht: null, vt: null, tb: null, ...style } as unknown as IStyleData : null,
  }
}

function changedCellState(baseline: OfficeSheetCellChange | undefined, current: OfficeSheetCellChange) {
  const original = baseline || { sheet: current.sheet, cell: current.cell, value: '', formula: '', style: undefined }
  const contentChanged = !sameValue(original.value, current.value) || (original.formula || '') !== (current.formula || '')
  const style = Object.fromEntries(styleKeys.flatMap((key) => comparableStyleValue(original.style, key) === comparableStyleValue(current.style, key) ? [] : [[key, comparableStyleValue(current.style, key)]])) as OfficeSheetCellStyle
  if (!contentChanged && !Object.keys(style).some((key) => style[key as keyof OfficeSheetCellStyle] !== undefined)) return null
  return { ...current, contentChanged, style: Object.keys(style).length ? style : undefined }
}

function hasMeaningfulStyle(style: OfficeSheetCellStyle | undefined) {
  if (!style) return false
  return Object.values(style).some((value) => value !== '' && value !== undefined && value !== false)
}

function isUsedCell(change: OfficeSheetCellChange) {
  return Boolean(change.formula || change.value !== '' && change.value !== null && change.value !== undefined || hasMeaningfulStyle(change.style))
}

function formatSavedAt(value: Date | null) {
  if (!value) return ''
  return value.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
}

function workspaceRelativePath(workspacePath: string | undefined, filePath: string) {
  const normalizedRoot = (workspacePath || '').replace(/\\/g, '/').replace(/\/+$/, '')
  const normalizedFile = filePath.replace(/\\/g, '/')
  if (normalizedRoot && normalizedFile.startsWith(`${normalizedRoot}/`)) return normalizedFile.slice(normalizedRoot.length + 1)
  return normalizedFile.split('/').pop() || normalizedFile
}

function SpreadsheetSelectionAI({ filePath, workspacePath, sheet, notation, onAskAI }: {
  filePath: string
  workspacePath?: string
  sheet: string
  notation: string
  onAskAI: (prompt: string, behavior: 'send' | 'insert') => void
}) {
  const [editing, setEditing] = useState(false)
  const [instruction, setInstruction] = useState('')
  const shortcutModifier = /Mac|iPhone|iPad/.test(navigator.userAgent) ? '⌘' : 'Ctrl'

  const run = (behavior: 'send' | 'insert') => {
    const requirement = instruction.trim()
    if (!requirement) return
    onAskAI([
      '请读取并编辑当前 Excel 文件。',
      `文件（相对于当前会话工作区）：${workspaceRelativePath(workspacePath, filePath)}`,
      `工作表：${sheet}`,
      `选区：${notation}`,
      '',
      `修改要求：${requirement}`,
      '仅修改以上选区；如果操作会影响选区之外的内容，请先说明并征得确认。',
    ].join('\n'), behavior)
    setInstruction('')
    setEditing(false)
  }

  if (!editing) return <button
    className="spreadsheet-ai-edit-button"
    type="button"
    onClick={() => setEditing(true)}
    onPointerDown={(event) => event.stopPropagation()}
    aria-label={`让 AI 编辑 ${sheet} 工作表的 ${notation} 选区`}
    title={`${sheet}!${notation}`}
  ><WandSparkles size={15} /><span>AI 编辑</span></button>

  return <form className="spreadsheet-ai-prompt" onPointerDown={(event) => event.stopPropagation()} onSubmit={(event) => { event.preventDefault(); run('send') }}>
    <input
      autoFocus
      value={instruction}
      onChange={(event) => setInstruction(event.target.value)}
      onKeyDown={(event) => {
        event.stopPropagation()
        if (event.key === 'Escape') { event.preventDefault(); setEditing(false); return }
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); run('insert') }
      }}
      aria-label={`描述如何修改 ${sheet}!${notation}`}
      placeholder="说说你想怎么修改"
    />
    <span className="spreadsheet-ai-submit-wrap">
      <button className="spreadsheet-ai-submit" type="submit" disabled={!instruction.trim()} aria-label="发送 AI 编辑要求"><Check size={17} /></button>
      <span className="spreadsheet-ai-shortcuts" role="tooltip">
        <span><strong>发送</strong><kbd>↵</kbd></span>
        <span><strong>添加</strong><kbd>{shortcutModifier} ↵</kbd></span>
      </span>
    </span>
  </form>
}

export function SpreadsheetEditor({ document, workspacePath, onDocumentChange, onFeedback, onDirtyChange, onAskAI }: SpreadsheetEditorProps) {
  const isDelimited = /\.(?:csv|tsv)$/i.test(document.extension)
  const containerRef = useRef<HTMLDivElement>(null)
  const featureMenuRef = useRef<HTMLDivElement>(null)
  const univerApiRef = useRef<UniverFacade | null>(null)
  const clientIdRef = useRef(`editor-${typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`}`)
  const pendingChangesRef = useRef(new Map<string, OfficeSheetCellChange>())
  const baselineCellsRef = useRef(new Map<string, OfficeSheetCellChange>())
  const renderedCellsRef = useRef(new Map<string, OfficeSheetCellChange>())
  const usedCellKeysRef = useRef(new Set<string>())
  const stageQueueRef = useRef<Promise<void>>(Promise.resolve())
  const stageErrorRef = useRef<unknown>(null)
  const failedStageChangesRef = useRef(new Map<string, OfficeSheetCellChange>())
  const sessionPendingCountRef = useRef(0)
  const sessionRevisionRef = useRef(0)
  const activeFileRef = useRef(document.filePath)
  const mountedRef = useRef(true)
  const generationRef = useRef(0)
  const queuedStageCountRef = useRef(0)
  const saveInFlightRef = useRef(false)
  const restoreSelectionRef = useRef<{ sheet: string; notation: string } | null>(null)
  const callbacksRef = useRef({ onDocumentChange, onFeedback, onDirtyChange, workspacePath })
  callbacksRef.current = { onDocumentChange, onFeedback, onDirtyChange, workspacePath }
  const aiPopupRef = useRef<{ dispose: () => void } | null>(null)
  const onAskAIRef = useRef(onAskAI)
  const [reloadKey, setReloadKey] = useState(0)
  const [saveState, setSaveState] = useState<SaveState>('loading')
  const [loadError, setLoadError] = useState('')
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null)
  const [pendingCount, setPendingCount] = useState(0)
  const [sessionRevision, setSessionRevision] = useState(0)
  const [workbookSummary, setWorkbookSummary] = useState({ sheets: 0, usedCells: 0 })
  const [featureMenuOpen, setFeatureMenuOpen] = useState(false)
  const [featureCategory, setFeatureCategory] = useState<FeatureCategory>('insert')
  const [featureDialog, setFeatureDialog] = useState<SpreadsheetFeature | null>(null)
  const [featureFields, setFeatureFields] = useState<Record<string, string>>({})
  const [featureBusy, setFeatureBusy] = useState(false)
  const [editorDark, setEditorDark] = useState(() => localStorage.getItem(`zsense:sheet-dark:${document.filePath}`) === '1')
  const [gridlinesHidden, setGridlinesHidden] = useState(() => localStorage.getItem(`zsense:sheet-gridlines:${document.filePath}`) === '1')

  useEffect(() => { onAskAIRef.current = onAskAI }, [onAskAI])

  const updateSessionState = useCallback((count: number, revision?: number) => {
    if (revision && revision < sessionRevisionRef.current) return
    const normalizedCount = Math.max(0, Number(count || 0))
    sessionPendingCountRef.current = normalizedCount
    const visibleCount = Math.max(normalizedCount, pendingChangesRef.current.size, failedStageChangesRef.current.size, queuedStageCountRef.current ? 1 : 0)
    setPendingCount(visibleCount)
    if (Number.isFinite(revision) && Number(revision) > 0) {
      sessionRevisionRef.current = Number(revision)
      setSessionRevision(Number(revision))
    }
    callbacksRef.current.onDirtyChange?.(visibleCount > 0)
  }, [])

  const stageChanges = useCallback((changes: OfficeSheetCellChange[]) => {
    if (!changes.length || !window.zsenseDesktop) return
    const filePath = activeFileRef.current
    const generation = generationRef.current
    const isCurrent = () => mountedRef.current && generation === generationRef.current && filePath === activeFileRef.current
    queuedStageCountRef.current += 1
    stageQueueRef.current = stageQueueRef.current.catch(() => undefined).then(async () => {
      const result = await unwrapDesktop(window.zsenseDesktop!.office.stageCells({
        filePath,
        changes,
        clientId: clientIdRef.current,
      }))
      if (!isCurrent()) return
      for (const change of changes) {
        const key = `${change.sheet}!${change.cell}`
        if (sameCellState(failedStageChangesRef.current.get(key), change)) failedStageChangesRef.current.delete(key)
      }
      if (!failedStageChangesRef.current.size) stageErrorRef.current = null
      queuedStageCountRef.current = Math.max(0, queuedStageCountRef.current - 1)
      updateSessionState(result.pendingCount, result.revision)
      if (!saveInFlightRef.current) setSaveState(failedStageChangesRef.current.size ? 'error' : result.dirty || pendingChangesRef.current.size || queuedStageCountRef.current ? 'dirty' : 'ready')
    }).catch((reason) => {
      if (!isCurrent()) return
      queuedStageCountRef.current = Math.max(0, queuedStageCountRef.current - 1)
      stageErrorRef.current = reason
      for (const change of changes) {
        const key = `${change.sheet}!${change.cell}`
        failedStageChangesRef.current.set(key, renderedCellsRef.current.get(key) || change)
      }
      setSaveState('error')
      callbacksRef.current.onDirtyChange?.(true)
      callbacksRef.current.onFeedback({ tone: 'error', message: `表格实时会话同步失败：${errorMessage(reason)}` })
    })
  }, [updateSessionState])

  const persistChanges = useCallback(async () => {
    if (!window.zsenseDesktop || saveInFlightRef.current) return
    const filePath = activeFileRef.current
    const generation = generationRef.current
    const isCurrent = () => mountedRef.current && generation === generationRef.current && filePath === activeFileRef.current
    saveInFlightRef.current = true
    setSaveState('saving')
    try {
      // Every user edit (including an undo back to baseline) is already staged.
      // Restaging here would both double IPC work and overwrite newer Agent edits.
      let queuedStage: Promise<void>
      do {
        queuedStage = stageQueueRef.current
        await queuedStage
        if (!isCurrent()) return
      } while (queuedStage !== stageQueueRef.current)
      if (!isCurrent()) return
      if (failedStageChangesRef.current.size) {
        stageChanges([...failedStageChangesRef.current.values()])
        await stageQueueRef.current
        if (!isCurrent()) return
      }
      if (stageErrorRef.current) throw stageErrorRef.current
      const pendingSnapshot = new Map(pendingChangesRef.current)
      const result = await unwrapDesktop(window.zsenseDesktop.office.saveWorkbook({ filePath, clientId: clientIdRef.current }))
      if (!isCurrent()) return
      if (result.document) callbacksRef.current.onDocumentChange(result.document)
      for (const [key, state] of pendingSnapshot) {
        baselineCellsRef.current.set(key, state)
        if (sameCellState(pendingChangesRef.current.get(key), state)) pendingChangesRef.current.delete(key)
      }
      setLastSavedAt(new Date())
      updateSessionState(result.pendingCount, result.revision)
      setSaveState(result.dirty || pendingChangesRef.current.size || queuedStageCountRef.current ? 'dirty' : 'saved')
      callbacksRef.current.onFeedback(null)
    } catch (reason) {
      if (!isCurrent()) return
      const message = errorMessage(reason)
      setSaveState('error')
      callbacksRef.current.onDirtyChange?.(true)
      callbacksRef.current.onFeedback({ tone: 'error', message: `表格保存失败：${message}` })
    } finally {
      if (isCurrent()) saveInFlightRef.current = false
    }
  }, [stageChanges, updateSessionState])

  const markDirty = useCallback(() => {
    const count = Math.max(sessionPendingCountRef.current, pendingChangesRef.current.size, queuedStageCountRef.current ? 1 : 0)
    setPendingCount(count)
    setSaveState('dirty')
    callbacksRef.current.onDirtyChange?.(true)
  }, [])

  const activeSheetContext = useCallback(() => {
    const api = univerApiRef.current
    const workbook = api?.getActiveWorkbook()
    const worksheet = workbook?.getActiveSheet()
    if (!api || !worksheet) throw new Error('表格编辑器还没有准备好。')
    const range = worksheet.getActiveRange() || worksheet.getRange('A1')
    return { api, workbook, worksheet, range, rangeInfo: range.getRange(), sheet: worksheet.getSheetName(), notation: range.getA1Notation() }
  }, [])

  const stageFeatureOperation = useCallback(async (operation: OfficeWorkbookOperation) => {
    if (!window.zsenseDesktop) throw new Error('Excel 功能只能在 ZSense 桌面应用中使用。')
    const stageOperations = window.zsenseDesktop.office.stageOperations
    if (typeof stageOperations !== 'function') throw new Error('Excel 功能桥接版本不一致。请完全退出 ZSense（包括仍在运行的旧版本）后重新打开新版应用。')
    const filePath = activeFileRef.current
    const generation = generationRef.current
    const result = await unwrapDesktop(stageOperations({
      filePath,
      operations: [operation],
      clientId: clientIdRef.current,
    }))
    if (mountedRef.current && generation === generationRef.current && filePath === activeFileRef.current) {
      updateSessionState(result.pendingCount, result.revision)
      setSaveState('dirty')
    }
    return result
  }, [updateSessionState])

  const showFeatureDialog = useCallback((feature: SpreadsheetFeature) => {
    const notation = (() => {
      try { return activeSheetContext().notation } catch { return 'A1' }
    })()
    setFeatureFields(initialFeatureFields(feature.id, notation))
    setFeatureDialog(feature)
    setFeatureMenuOpen(false)
  }, [activeSheetContext])

  const featureSuccess = useCallback((message: string) => {
    onFeedback({ tone: 'success', message })
    window.setTimeout(() => onFeedback(null), 3_000)
  }, [onFeedback])

  const runImmediateFeature = useCallback(async (feature: SpreadsheetFeature) => {
    if (feature.configurable) {
      showFeatureDialog(feature)
      return
    }
    setFeatureBusy(true)
    try {
      const { api, worksheet, range, rangeInfo, sheet, notation } = activeSheetContext()
      const operationBase = { sheet, range: notation }
      switch (feature.id) {
        case 'insertRows':
          worksheet.insertRowsBefore(rangeInfo.startRow, 1)
          await stageFeatureOperation({ action: 'insertRows', ...operationBase, index: rangeInfo.startRow, count: 1 })
          featureSuccess('已在当前选择上方插入 1 行；点击保存后写入原文件。')
          break
        case 'insertColumns':
          worksheet.insertColumnsBefore(rangeInfo.startColumn, 1)
          await stageFeatureOperation({ action: 'insertColumns', ...operationBase, index: rangeInfo.startColumn, count: 1 })
          featureSuccess('已在当前选择左侧插入 1 列；点击保存后写入原文件。')
          break
        case 'insertCellsDown':
          range.insertCells(api.Enum.Dimension.ROWS)
          markDirty()
          featureSuccess('已插入单元格并向下移动，变化已加入待保存列表。')
          break
        case 'insertCellsRight':
          range.insertCells(api.Enum.Dimension.COLUMNS)
          markDirty()
          featureSuccess('已插入单元格并向右移动，变化已加入待保存列表。')
          break
        case 'filter':
          range.createFilter()
          await stageFeatureOperation({ action: 'addFilter', ...operationBase })
          featureSuccess('已为所选区域启用筛选。')
          break
        case 'sortAsc':
        case 'sortDesc':
          range.sort({ column: 0, ascending: feature.id === 'sortAsc' })
          await stageFeatureOperation({ action: 'sortRange', ...operationBase, index: 0, direction: feature.id === 'sortAsc' ? 'asc' : 'desc' })
          featureSuccess(feature.id === 'sortAsc' ? '已按第一列升序排列。' : '已按第一列降序排列。')
          break
        case 'splitText': {
          const comma = api.Enum.SplitDelimiterType?.Comma
          range.splitTextToColumns(true, comma)
          markDirty()
          featureSuccess('已按逗号分列，新的单元格内容已加入待保存列表。')
          break
        }
        case 'groupRows':
          await stageFeatureOperation({ action: 'groupRows', ...operationBase, count: 1 })
          featureSuccess('已设置行分组；保存后重新载入即可看到折叠分组。')
          break
        case 'groupColumns':
          await stageFeatureOperation({ action: 'groupColumns', ...operationBase, count: 1 })
          featureSuccess('已设置列分组；保存后重新载入即可看到折叠分组。')
          break
        case 'picture': {
          if (!window.zsenseDesktop) break
          const imagePath = await unwrapDesktop(window.zsenseDesktop.office.pickSpreadsheetImage())
          if (!imagePath) break
          await stageFeatureOperation({ action: 'addPicture', ...operationBase, value: imagePath, name: `Picture_${Date.now().toString(36)}` })
          featureSuccess('图片已加入待保存列表；保存后会嵌入 Excel 文件。')
          break
        }
        case 'freezeRow':
          worksheet.setFrozenRows(1)
          await stageFeatureOperation({ action: 'setFreeze', sheet, target: 'A2' })
          featureSuccess('已冻结首行。')
          break
        case 'freezeColumn':
          worksheet.setFrozenColumns(1)
          await stageFeatureOperation({ action: 'setFreeze', sheet, target: 'B1' })
          featureSuccess('已冻结首列。')
          break
        case 'freezeSelection': {
          const target = addressFromPosition(rangeInfo.startRow, rangeInfo.startColumn)
          worksheet.setFreeze({ startRow: rangeInfo.startRow, startColumn: rangeInfo.startColumn, xSplit: rangeInfo.startColumn, ySplit: rangeInfo.startRow })
          await stageFeatureOperation({ action: 'setFreeze', sheet, target })
          featureSuccess('已冻结到当前选择位置。')
          break
        }
        case 'unfreeze':
          worksheet.cancelFreeze()
          await stageFeatureOperation({ action: 'setFreeze', sheet, target: '' })
          featureSuccess('已取消冻结窗格。')
          break
        case 'zoom75':
        case 'zoom100':
        case 'zoom125': {
          const percent = feature.id === 'zoom75' ? 75 : feature.id === 'zoom125' ? 125 : 100
          worksheet.zoom(percent / 100)
          await stageFeatureOperation({ action: 'setZoom', sheet, size: percent })
          featureSuccess(`显示比例已调整为 ${percent}%。`)
          break
        }
        case 'darkMode': {
          const next = !editorDark
          setEditorDark(next)
          localStorage.setItem(`zsense:sheet-dark:${activeFileRef.current}`, next ? '1' : '0')
          featureSuccess(next ? '已切换为深色表格外观。' : '已切换为浅色表格外观。')
          break
        }
        case 'gridlines': {
          const next = !gridlinesHidden
          worksheet.setHiddenGridlines(next)
          setGridlinesHidden(next)
          localStorage.setItem(`zsense:sheet-gridlines:${activeFileRef.current}`, next ? '1' : '0')
          featureSuccess(next ? '已隐藏当前工作表网格线。' : '已显示当前工作表网格线。')
          break
        }
        case 'functionCatalog':
          showFeatureDialog(feature)
          break
        default:
          showFeatureDialog(feature)
      }
    } catch (reason) {
      onFeedback({ tone: 'error', message: `Excel 功能执行失败：${errorMessage(reason)}` })
    } finally {
      setFeatureBusy(false)
      setFeatureMenuOpen(false)
    }
  }, [activeSheetContext, editorDark, featureSuccess, gridlinesHidden, markDirty, onFeedback, showFeatureDialog, stageFeatureOperation])

  const applyFeatureDialog = useCallback(async () => {
    if (!featureDialog) return
    setFeatureBusy(true)
    try {
      const { api, worksheet, range: activeRange, sheet } = activeSheetContext()
      const notation = featureFields.range?.trim().toUpperCase() || activeRange.getA1Notation()
      const range = worksheet.getRange(notation)
      const operationBase = { sheet, range: notation }
      switch (featureDialog.id) {
        case 'table': {
          const name = featureFields.name.trim()
          await worksheet.addTable(name, range.getRange(), `table-${Date.now().toString(36)}`, { tableStyleId: `table-default-${featureFields.mode === 'light1' ? 1 : 4}` })
          await stageFeatureOperation({ action: 'addTable', ...operationBase, name, mode: featureFields.mode })
          break
        }
        case 'hyperlink':
          await range.setHyperLink(featureFields.value.trim(), featureFields.secondaryValue.trim() || undefined)
          await stageFeatureOperation({ action: 'addHyperlink', ...operationBase, value: featureFields.value, secondaryValue: featureFields.secondaryValue })
          break
        case 'validation': {
          const builder = api.newDataValidation() as unknown as { requireNumberBetween: (minimum: number, maximum: number) => typeof builder; setOptions: (options: Record<string, unknown>) => typeof builder; build: () => unknown }
          const minimum = Number(featureFields.formula1)
          const maximum = Number(featureFields.formula2)
          range.setDataValidation(builder.requireNumberBetween(minimum, maximum).setOptions({ allowBlank: true, showErrorMessage: true, error: featureFields.error }).build())
          await stageFeatureOperation({ action: 'addValidation', ...operationBase, mode: featureFields.mode, options: { operator: featureFields.operator, formula1: featureFields.formula1, formula2: featureFields.formula2, error: featureFields.error } })
          break
        }
        case 'dropdown': {
          const values = featureFields.values.split(/[,，\n]/).map((item) => item.trim()).filter(Boolean)
          if (!values.length) throw new Error('请至少填写一个下拉选项。')
          const builder = api.newDataValidation() as unknown as { requireValueInList: (items: string[]) => typeof builder; setOptions: (options: Record<string, unknown>) => typeof builder; build: () => unknown }
          range.setDataValidation(builder.requireValueInList(values).setOptions({ allowBlank: true, showErrorMessage: true }).build())
          await stageFeatureOperation({ action: 'addValidation', ...operationBase, mode: 'list', options: { formula1: values.join(','), allowBlank: true, inCellDropdown: true } })
          break
        }
        case 'conditional':
          await stageFeatureOperation({ action: 'addConditionalFormatting', ...operationBase, mode: featureFields.mode, options: { operator: featureFields.operator, value: featureFields.value, value2: featureFields.value2, fill: featureFields.fill, color: featureFields.color, text: featureFields.value } })
          break
        case 'chart':
          await stageFeatureOperation({ action: 'addChart', ...operationBase, mode: featureFields.mode, value: featureFields.value })
          break
        case 'sparkline':
          await stageFeatureOperation({ action: 'addSparkline', ...operationBase, mode: featureFields.mode, target: featureFields.target, options: { color: '#2563EB' } })
          break
        case 'shape':
          await stageFeatureOperation({ action: 'addShape', sheet, mode: featureFields.mode, value: featureFields.value, options: { fill: featureFields.fill, x: 1, y: 1, width: 4, height: 3 } })
          break
        case 'pivot':
          await stageFeatureOperation({ action: 'addPivotTable', ...operationBase, target: featureFields.target, name: featureFields.name, options: { rows: featureFields.rows, values: featureFields.values, cols: featureFields.cols, filters: featureFields.filters } })
          break
        case 'namedRange':
        case 'quickName':
          await stageFeatureOperation({ action: 'addNamedRange', ...operationBase, name: featureFields.name, value: featureFields.value })
          break
        case 'calculation':
          await stageFeatureOperation({ action: 'setCalculationMode', mode: featureFields.mode })
          break
        case 'rowHeight': {
          const info = range.getRange()
          const size = Number(featureFields.size)
          worksheet.setRowHeightsForced(info.startRow, info.endRow - info.startRow + 1, size)
          await stageFeatureOperation({ action: 'setRowHeight', ...operationBase, size })
          break
        }
        case 'columnWidth': {
          const info = range.getRange()
          const size = Number(featureFields.size)
          worksheet.setColumnWidths(info.startColumn, info.endColumn - info.startColumn + 1, size * 8)
          await stageFeatureOperation({ action: 'setColumnWidth', ...operationBase, size })
          break
        }
        case 'functionCatalog':
          break
        default:
          throw new Error('这个功能不需要配置。')
      }
      setFeatureDialog(null)
      featureSuccess(featureDialog.id === 'functionCatalog' ? '完整函数分类已经位于上方“公式”标签中。' : '功能修改已应用；点击保存后会写回原 Excel 文件。')
    } catch (reason) {
      onFeedback({ tone: 'error', message: `Excel 功能执行失败：${errorMessage(reason)}` })
    } finally {
      setFeatureBusy(false)
    }
  }, [activeSheetContext, featureDialog, featureFields, featureSuccess, onFeedback, stageFeatureOperation])

  useEffect(() => {
    const closeMenu = (event: MouseEvent) => {
      if (!featureMenuRef.current?.contains(event.target as Node)) setFeatureMenuOpen(false)
    }
    globalThis.document.addEventListener('mousedown', closeMenu)
    return () => globalThis.document.removeEventListener('mousedown', closeMenu)
  }, [])

  useEffect(() => {
    mountedRef.current = true
    activeFileRef.current = document.filePath
    const generation = ++generationRef.current
    const container = containerRef.current
    // Univer owns a nested React root. Give every generation its own child so
    // deferred teardown cannot remove nodes belonging to the next workbook.
    const host = container ? globalThis.document.createElement('div') : null
    if (container && host) container.replaceChildren(host)
    let disposed = false
    let eventDisposable: { dispose: () => void } | null = null
    let selectionDisposable: { dispose: () => void } | null = null
    let unsubscribeSession: (() => void) | null = null
    let univerInstance: { dispose: () => void } | null = null
    let worker: Worker | null = null
    let applyingExternalCells = false
    let externalQueue = Promise.resolve()
    let loadedWorkbook: OfficeWorkbookGrid | null = null
    sessionRevisionRef.current = 0
    sessionPendingCountRef.current = 0
    queuedStageCountRef.current = 0
    stageQueueRef.current = Promise.resolve()
    stageErrorRef.current = null
    failedStageChangesRef.current.clear()
    saveInFlightRef.current = false
    setSaveState('loading')
    setLoadError('')
    setLastSavedAt(null)
    setEditorDark(localStorage.getItem(`zsense:sheet-dark:${document.filePath}`) === '1')
    setGridlinesHidden(localStorage.getItem(`zsense:sheet-gridlines:${document.filePath}`) === '1')
    setPendingCount(0)
    setSessionRevision(0)
    setWorkbookSummary({ sheets: 0, usedCells: 0 })
    pendingChangesRef.current.clear()
    baselineCellsRef.current.clear()
    renderedCellsRef.current.clear()
    usedCellKeysRef.current.clear()

    const initialize = async () => {
      if (!host || !window.zsenseDesktop) throw new Error('Excel 只能在 ZSense 桌面应用中编辑。')
      const workbookData = await unwrapDesktop(window.zsenseDesktop.office.getWorkbook({ filePath: document.filePath }))
      if (disposed) return
      const usedCellKeys = new Set<string>()
      for (const sheet of workbookData.sheets) {
        for (const address of Object.keys(sheet.cells)) usedCellKeys.add(`${sheet.sheet}!${address}`)
      }
      usedCellKeysRef.current = usedCellKeys
      const baselineCells = new Map<string, OfficeSheetCellChange>()
      for (const sheet of workbookData.sheets) {
        for (const [address, cell] of Object.entries(sheet.cells)) baselineCells.set(`${sheet.sheet}!${address}`, editorCellState(sheet.sheet, address, cell))
      }
      baselineCellsRef.current = baselineCells
      renderedCellsRef.current = new Map(baselineCells)
      loadedWorkbook = workbookData
      updateSessionState(workbookData.pendingCount || 0, workbookData.sessionRevision)
      setWorkbookSummary({ sheets: workbookData.sheets.length, usedCells: usedCellKeys.size })
      const formulaWorker = new UniverWorker()
      worker = formulaWorker
      const { univer, univerAPI } = createUniver({
        locale: LocaleType.ZH_CN,
        locales: {
          [LocaleType.ZH_CN]: mergeLocales(
            coreZhCN,
            conditionalFormattingZhCN,
            dataValidationZhCN,
            drawingZhCN,
            filterZhCN,
            findReplaceZhCN,
            hyperLinkZhCN,
            noteZhCN,
            sortZhCN,
            tableZhCN,
          ),
        },
        theme: defaultTheme,
        presets: [
          UniverSheetsCorePreset({
            container: host,
            workerURL: formulaWorker,
            header: true,
            toolbar: true,
            ribbonType: 'simple',
            formulaBar: true,
            contextMenu: true,
            disableAutoFocus: true,
            footer: {
              sheetBar: true,
              statisticBar: true,
              menus: true,
              zoomSlider: true,
              addSheetButtonConfig: { show: false },
            },
          }),
          UniverSheetsConditionalFormattingPreset(),
          UniverSheetsDataValidationPreset({ showEditOnDropdown: true, showSearchOnDropdown: true }),
          UniverSheetsDrawingPreset(),
          UniverSheetsFilterPreset(),
          UniverSheetsFindReplacePreset(),
          UniverSheetsHyperLinkPreset(),
          UniverSheetsNotePreset(),
          UniverSheetsSortPreset(),
          UniverSheetsTablePreset(),
        ],
      })
      univerInstance = univer
      univerApiRef.current = univerAPI as unknown as UniverFacade
      const workbook = univerAPI.createWorkbook(workbookSnapshot(workbookData, document.name))
      if (localStorage.getItem(`zsense:sheet-gridlines:${document.filePath}`) === '1') workbook.getActiveSheet().setHiddenGridlines(true)
      const restoreSelection = restoreSelectionRef.current
      restoreSelectionRef.current = null
      if (restoreSelection) {
        const worksheet = workbook.getSheetByName(restoreSelection.sheet)
        worksheet?.activate()
        worksheet?.getRange(restoreSelection.notation).activate()
      }
      if (onAskAIRef.current) {
        selectionDisposable = univerAPI.addEvent(univerAPI.Event.SelectionChanged, ({ worksheet, selections }) => {
          aiPopupRef.current?.dispose()
          aiPopupRef.current = null
          const selected = selections.at(-1)
          if (!selected) return
          const notation = `${addressFromPosition(selected.startRow, selected.startColumn)}:${addressFromPosition(selected.endRow, selected.endColumn)}`
            .replace(/^([A-Z]+\d+):\1$/, '$1')
          const sheet = worksheet.getSheetName()
          const popup = worksheet.getRange(notation).attachRangePopup({
            componentKey: () => <SpreadsheetSelectionAI
              filePath={activeFileRef.current}
              workspacePath={callbacksRef.current.workspacePath}
              sheet={sheet}
              notation={notation}
              onAskAI={(prompt, behavior) => onAskAIRef.current?.(prompt, behavior)}
            />,
            direction: 'bottom-center',
            offset: [0, 8],
            hideOnInvisible: true,
            hiddenType: 'hide',
            zIndex: 12,
          })
          aiPopupRef.current = popup || null
        })
      }
      unsubscribeSession = window.zsenseDesktop.office.onSessionChanged((sessionEvent) => {
        if (disposed || sessionEvent.filePath !== activeFileRef.current) return
        if (sessionEvent.sourceClientId === clientIdRef.current && sessionEvent.kind !== 'saved') return
        // Reconcile our own saves too: disk writeback can recompute formulas or
        // shift cells, so a saved revision is the new undo/diff baseline.
        if (sessionEvent.revision < sessionRevisionRef.current || sessionEvent.revision === sessionRevisionRef.current && sessionEvent.kind !== 'saved') return
        externalQueue = externalQueue.catch(() => undefined).then(async () => {
          await stageQueueRef.current
          if (disposed || generation !== generationRef.current) return
          const localAtRead = new Map(pendingChangesRef.current)
          const externallyTouched = new Set((sessionEvent.changes || []).map(change => `${change.sheet}!${change.cell}`))
          const next = await unwrapDesktop(window.zsenseDesktop!.office.getWorkbook({ filePath: document.filePath }))
          if (disposed || generation !== generationRef.current) return
          if (!loadedWorkbook || sessionEvent.kind === 'discarded' || !canApplyWorkbookIncrementally(loadedWorkbook, next, sessionEvent.operations)) {
            const worksheet = workbook.getActiveSheet()
            const range = worksheet.getActiveRange()
            restoreSelectionRef.current = range ? { sheet: worksheet.getSheetName(), notation: range.getA1Notation() } : null
            setReloadKey((value) => value + 1)
            return
          }
          // The backend session is authoritative, but a newer local edit made
          // while getWorkbook was in flight must not be erased by its response.
          applyingExternalCells = true
          try {
            for (const sheet of next.sheets) {
              const oldSheet = loadedWorkbook.sheets.find((item) => item.id === sheet.id)!
              const addresses = new Set([...Object.keys(oldSheet.cells), ...Object.keys(sheet.cells)])
              const patch: Record<number, Record<number, ICellData>> = {}
              for (const address of addresses) {
                const key = `${sheet.sheet}!${address}`
                const state = editorCellState(sheet.sheet, address, sheet.cells[address])
                const currentLocal = pendingChangesRef.current.get(key)
                const capturedLocal = localAtRead.get(key)
                const newerLocalEdit = Boolean(currentLocal && !sameCellState(currentLocal, capturedLocal))
                  || Boolean(capturedLocal && !currentLocal && !sameCellState(renderedCellsRef.current.get(key), state))
                if (sessionEvent.kind === 'saved' && !next.dirty) baselineCellsRef.current.set(key, state)
                // A failed local sync is still a recoverable draft. An Agent
                // update to another cell cannot silently discard that draft.
                if (newerLocalEdit || failedStageChangesRef.current.has(key) && !externallyTouched.has(key)) continue
                if (externallyTouched.has(key)) failedStageChangesRef.current.delete(key)
                if (!sameCellState(renderedCellsRef.current.get(key), state)) {
                  const { row, column } = positionFromAddress(address)
                  ;(patch[row] ||= {})[column] = incrementalCellData(state)
                  baselineCellsRef.current.set(key, state)
                  pendingChangesRef.current.delete(key)
                  renderedCellsRef.current.set(key, state)
                } else if (sessionEvent.kind === 'saved' && !next.dirty && sameCellState(currentLocal, state)) {
                  pendingChangesRef.current.delete(key)
                }
                if (isUsedCell(state)) usedCellKeysRef.current.add(key)
                else usedCellKeysRef.current.delete(key)
              }
              if (Object.keys(patch).length && !univerAPI.syncExecuteCommand('sheet.mutation.set-range-values', {
                unitId: workbook.getId(), subUnitId: sheet.id, cellValue: patch,
              })) throw new Error('表格增量更新未能应用，请重新读取工作簿。')
            }
          } finally {
            applyingExternalCells = false
          }
          loadedWorkbook = next
          if (!failedStageChangesRef.current.size) stageErrorRef.current = null
          setWorkbookSummary({ sheets: next.sheets.length, usedCells: usedCellKeysRef.current.size })
          updateSessionState(next.pendingCount || 0, next.sessionRevision)
          if (!saveInFlightRef.current) setSaveState(failedStageChangesRef.current.size ? 'error' : next.dirty || pendingChangesRef.current.size || queuedStageCountRef.current ? 'dirty' : 'saved')
          if (sessionEvent.kind === 'saved') setLastSavedAt(new Date())
        }).catch((reason) => {
          if (disposed) return
          callbacksRef.current.onFeedback({ tone: 'error', message: `表格同步更新失败：${errorMessage(reason)}` })
          setSaveState('error')
        })
      })
      eventDisposable = univerAPI.addEvent(univerAPI.Event.SheetValueChanged, ({ effectedRanges }) => {
        if (disposed || applyingExternalCells) return
        // Resolve style IDs only for the touched cells. Serializing the whole
        // workbook just to obtain its style table makes formatted sheets lag.
        const resolvedStyles = new Map<string, IStyleData | null>()
        let queued = 0
        const stagedChanges: OfficeSheetCellChange[] = []
        for (const effectedRange of effectedRanges) {
          const worksheet = workbook.getSheetBySheetId(effectedRange.getSheetId())
          if (!worksheet) continue
          const { startRow, startColumn, endRow, endColumn } = effectedRange.getRange()
          const dataGrid = effectedRange.getCellDataGrid()
          for (let row = startRow; row <= endRow; row += 1) {
            for (let column = startColumn; column <= endColumn; column += 1) {
              queued += 1
              if (queued > MAX_PENDING_CELLS) {
                setSaveState('error')
                callbacksRef.current.onDirtyChange?.(true)
                callbacksRef.current.onFeedback({ tone: 'error', message: `一次修改超过 ${MAX_PENDING_CELLS} 个单元格，无法完整加入待保存列表，请撤销后缩小选择范围再操作。` })
                return
              }
              const cellData = dataGrid[row - startRow]?.[column - startColumn] || null
              const rawStyle = cellData?.s
              let resolvedStyle = typeof rawStyle === 'string' ? resolvedStyles.get(rawStyle) : rawStyle
              if (typeof rawStyle === 'string' && !resolvedStyles.has(rawStyle)) {
                resolvedStyle = worksheet.getRange(addressFromPosition(row, column)).getCellStyleData('cell')
                resolvedStyles.set(rawStyle, resolvedStyle || null)
              }
              const formula = typeof cellData?.f === 'string' ? cellData.f : ''
              const value = formula ? null : cellData?.v ?? ''
              const change: OfficeSheetCellChange = {
                sheet: worksheet.getSheetName(),
                cell: addressFromPosition(row, column),
                value: typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? value : '',
                formula,
                style: cellStyle(resolvedStyle),
                styleSnapshot: true,
              }
              const changeKey = `${change.sheet}!${change.cell}`
              if (!sameCellState(renderedCellsRef.current.get(changeKey), change)) stagedChanges.push(change)
            }
          }
        }
        if (!stagedChanges.length) return
        for (const change of stagedChanges) {
          const key = `${change.sheet}!${change.cell}`
          renderedCellsRef.current.set(key, change)
          if (changedCellState(baselineCellsRef.current.get(key), change)) pendingChangesRef.current.set(key, change)
          else pendingChangesRef.current.delete(key)
          if (isUsedCell(change)) usedCellKeysRef.current.add(key)
          else usedCellKeysRef.current.delete(key)
        }
        setWorkbookSummary((current) => ({ ...current, usedCells: usedCellKeysRef.current.size }))
        stageChanges(stagedChanges)
        markDirty()
      })
      setSaveState(workbookData.dirty ? 'dirty' : 'ready')
    }

    void initialize().catch((reason) => {
      if (disposed) return
      setLoadError(errorMessage(reason))
      setSaveState('error')
    })

    return () => {
      disposed = true
      mountedRef.current = false
      eventDisposable?.dispose()
      selectionDisposable?.dispose()
      aiPopupRef.current?.dispose()
      aiPopupRef.current = null
      unsubscribeSession?.()
      pendingChangesRef.current.clear()
      renderedCellsRef.current.clear()
      univerApiRef.current = null
      // A nested React root must not synchronously unmount inside the parent
      // root's effect cleanup; that can race the new render and removeChild.
      const retiredUniver = univerInstance
      const retiredWorker = worker
      queueMicrotask(() => {
        retiredUniver?.dispose()
        retiredWorker?.terminate()
        host?.remove()
      })
    }
  }, [document.filePath, markDirty, reloadKey, stageChanges, updateSessionState])

  useEffect(() => () => { mountedRef.current = false }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 's') return
      event.preventDefault()
      if ((sessionPendingCountRef.current || pendingChangesRef.current.size || queuedStageCountRef.current) && saveState !== 'saving') void persistChanges()
    }
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!sessionPendingCountRef.current && !pendingChangesRef.current.size && !queuedStageCountRef.current && !failedStageChangesRef.current.size) return
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('beforeunload', onBeforeUnload)
    }
  }, [persistChanges, saveState])

  const refresh = async () => {
    if ((sessionPendingCountRef.current || pendingChangesRef.current.size) && !window.confirm('重新读取会放弃当前未保存的修改，确定继续吗？')) return
    if (!window.zsenseDesktop) return
    const filePath = activeFileRef.current
    const generation = generationRef.current
    const isCurrent = () => mountedRef.current && generation === generationRef.current && filePath === activeFileRef.current
    setSaveState('loading')
    try {
      await stageQueueRef.current
      if (!isCurrent()) return
      const workbook = await unwrapDesktop(window.zsenseDesktop.office.discardWorkbook({ filePath, clientId: clientIdRef.current }))
      if (!isCurrent()) return
      pendingChangesRef.current.clear()
      updateSessionState(0, workbook.sessionRevision)
      setReloadKey((value) => value + 1)
    } catch (reason) {
      if (!isCurrent()) return
      setSaveState('error')
      onFeedback({ tone: 'error', message: `重新读取 Excel 失败：${errorMessage(reason)}` })
    }
  }

  const status = saveState === 'loading' ? <><LoaderCircle className="spin" size={13} />正在读取工作簿</>
    : saveState === 'dirty' ? <><AlertTriangle size={13} />{pendingCount.toLocaleString('zh-CN')} 项修改尚未保存</>
      : saveState === 'saving' ? <><LoaderCircle className="spin" size={13} />正在写回原文件</>
        : saveState === 'error' ? <><AlertTriangle size={13} />保存需要处理</>
          : <><Check size={13} />{lastSavedAt ? `${formatSavedAt(lastSavedAt)} 已保存` : '已连接实时本地会话'}</>

  return (
    <section className={`spreadsheet-editor univer-spreadsheet-editor${editorDark ? ' is-dark' : ''}`} aria-label={`${document.name} 电子表格编辑器`}>
      <header className="spreadsheet-sessionbar">
        <span className={`spreadsheet-save-state ${saveState}`} role="status">{status}</span>
        <div className="spreadsheet-feature-menu" ref={featureMenuRef}>
          <button className="spreadsheet-feature-trigger" type="button" onClick={() => setFeatureMenuOpen((open) => !open)} disabled={isDelimited || saveState === 'loading' || featureBusy} aria-expanded={featureMenuOpen} aria-haspopup="menu" title={isDelimited ? 'CSV/TSV 只保存单元格内容，不支持 Excel 功能区' : '打开表格功能区'}><Menu size={14} /><span>菜单</span></button>
          {featureMenuOpen && <div className="spreadsheet-feature-popover" role="menu" aria-label="Excel 完整功能">
            <nav className="spreadsheet-feature-categories" aria-label="功能分类">
              {(Object.keys(featureCategoryNames) as FeatureCategory[]).map((category) => <button key={category} type="button" className={featureCategory === category ? 'active' : ''} onMouseEnter={() => setFeatureCategory(category)} onClick={() => setFeatureCategory(category)}><span>{featureCategoryNames[category]}</span><ChevronRight size={13} /></button>)}
            </nav>
            <div className="spreadsheet-feature-grid">
              <header><strong>{featureCategoryNames[featureCategory]}</strong><span>{featureCategory === 'formula' ? '函数分类已由本地公式引擎提供' : '作用于当前工作表或所选区域'}</span></header>
              {spreadsheetFeatures.filter((feature) => feature.category === featureCategory).map((feature) => {
                const Icon = feature.icon
                return <button key={feature.id} type="button" role="menuitem" onClick={() => void runImmediateFeature(feature)}><Icon size={16} /><span><strong>{feature.label}</strong><small>{feature.description}</small></span></button>
              })}
            </div>
          </div>}
        </div>
        <span className="spreadsheet-session-summary">{isDelimited ? 'CSV 内容编辑 · 样式与公式按文本保存' : `实时会话 r${sessionRevision || '—'} · ${workbookSummary.sheets || '—'} 个工作表`} · {workbookSummary.usedCells.toLocaleString('zh-CN')} 个已用单元格</span>
        <button className="spreadsheet-save-button" type="button" onClick={() => void persistChanges()} disabled={!pendingCount || saveState === 'loading' || saveState === 'saving'} aria-label="保存工作簿" title="保存（⌘/Ctrl + S）"><Save size={14} /><span>保存</span></button>
        <button type="button" onClick={() => void refresh()} disabled={saveState === 'loading' || saveState === 'saving'} aria-label="从磁盘重新读取工作簿" title={pendingCount ? '重新读取并放弃未保存修改' : '从磁盘重新读取'}><RefreshCw className={saveState === 'loading' ? 'spin' : ''} size={14} /></button>
      </header>
      <div className="univer-spreadsheet-host" ref={containerRef} aria-label={`${document.name} 可编辑工作簿`} />
      {loadError && <div className="spreadsheet-load-error" role="alert"><AlertTriangle size={23} /><strong>无法载入工作簿</strong><span>{loadError}</span><button type="button" onClick={() => setReloadKey((value) => value + 1)}>重试</button></div>}
      {saveState === 'loading' && !loadError && <div className="spreadsheet-loading" role="status"><LoaderCircle className="spin" size={22} /><span>正在读取全部工作表并启动公式引擎…</span></div>}
      {featureDialog && <div className="spreadsheet-feature-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !featureBusy) setFeatureDialog(null) }}>
        <section className="spreadsheet-feature-dialog" role="dialog" aria-modal="true" aria-labelledby="spreadsheet-feature-title">
          <header><span className="spreadsheet-feature-dialog-icon">{(() => { const Icon = featureDialog.icon; return <Icon size={18} /> })()}</span><span><strong id="spreadsheet-feature-title">{featureDialog.label}</strong><small>{featureDialog.description}</small></span><button type="button" onClick={() => setFeatureDialog(null)} disabled={featureBusy} aria-label="关闭"><X size={17} /></button></header>
          <div className="spreadsheet-feature-form">
            {featureDialog.id === 'functionCatalog' ? <div className="spreadsheet-function-catalog"><p>上方“公式”标签已经提供完整函数库，点击分类即可插入：</p><div>{['常用函数', '财务', '日期与时间', '数学与三角函数', '统计', '查找与引用', '文本', '逻辑', '信息', '工程', '数据库', '兼容性', '特色函数'].map((label) => <span key={label}>{label}</span>)}</div></div> : <>
              {Object.prototype.hasOwnProperty.call(featureFields, 'range') && <label><span>作用范围</span><input value={featureFields.range || ''} onChange={(event) => setFeatureFields((current) => ({ ...current, range: event.target.value }))} placeholder="例如 A1:D20" /></label>}
              {Object.prototype.hasOwnProperty.call(featureFields, 'name') && <label><span>名称</span><input value={featureFields.name || ''} onChange={(event) => setFeatureFields((current) => ({ ...current, name: event.target.value }))} /></label>}
              {featureDialog.id === 'pivot' && <><label><span>放置位置</span><input value={featureFields.target || ''} onChange={(event) => setFeatureFields((current) => ({ ...current, target: event.target.value }))} placeholder="H1" /></label><label><span>行字段</span><input value={featureFields.rows || ''} onChange={(event) => setFeatureFields((current) => ({ ...current, rows: event.target.value }))} placeholder="例如 类目" /></label><label><span>值字段</span><input value={featureFields.values || ''} onChange={(event) => setFeatureFields((current) => ({ ...current, values: event.target.value }))} placeholder="例如 现价:sum" /></label><label><span>列字段（可选）</span><input value={featureFields.cols || ''} onChange={(event) => setFeatureFields((current) => ({ ...current, cols: event.target.value }))} /></label></>}
              {featureDialog.id === 'table' && <label><span>表格样式</span><select value={featureFields.mode || 'medium2'} onChange={(event) => setFeatureFields((current) => ({ ...current, mode: event.target.value }))}><option value="medium2">蓝色中等</option><option value="light1">浅色</option><option value="dark1">深色</option><option value="none">无样式</option></select></label>}
              {featureDialog.id === 'chart' && <><label><span>图表类型</span><select value={featureFields.mode || 'column'} onChange={(event) => setFeatureFields((current) => ({ ...current, mode: event.target.value }))}>{[['column', '柱状图'], ['bar', '条形图'], ['line', '折线图'], ['pie', '饼图'], ['doughnut', '环形图'], ['area', '面积图'], ['scatter', '散点图'], ['waterfall', '瀑布图'], ['funnel', '漏斗图'], ['treemap', '矩形树图']].map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label><span>图表标题</span><input value={featureFields.value || ''} onChange={(event) => setFeatureFields((current) => ({ ...current, value: event.target.value }))} /></label></>}
              {featureDialog.id === 'sparkline' && <><label><span>目标单元格</span><input value={featureFields.target || ''} onChange={(event) => setFeatureFields((current) => ({ ...current, target: event.target.value }))} /></label><label><span>迷你图类型</span><select value={featureFields.mode || 'line'} onChange={(event) => setFeatureFields((current) => ({ ...current, mode: event.target.value }))}><option value="line">折线</option><option value="column">柱形</option><option value="winloss">盈亏</option></select></label></>}
              {featureDialog.id === 'shape' && <><label><span>形状</span><select value={featureFields.mode || 'roundRect'} onChange={(event) => setFeatureFields((current) => ({ ...current, mode: event.target.value }))}><option value="roundRect">圆角矩形</option><option value="rect">矩形</option><option value="ellipse">椭圆</option><option value="triangle">三角形</option><option value="diamond">菱形</option><option value="rightArrow">右箭头</option></select></label><label><span>文字</span><input value={featureFields.value || ''} onChange={(event) => setFeatureFields((current) => ({ ...current, value: event.target.value }))} /></label><label><span>填充色</span><input type="color" value={featureFields.fill || '#DBEAFE'} onChange={(event) => setFeatureFields((current) => ({ ...current, fill: event.target.value }))} /></label></>}
              {featureDialog.id === 'hyperlink' && <><label><span>链接地址</span><input value={featureFields.value || ''} onChange={(event) => setFeatureFields((current) => ({ ...current, value: event.target.value }))} placeholder="https://" /></label><label><span>显示文字（可选）</span><input value={featureFields.secondaryValue || ''} onChange={(event) => setFeatureFields((current) => ({ ...current, secondaryValue: event.target.value }))} /></label></>}
              {featureDialog.id === 'conditional' && <><label><span>规则</span><select value={featureFields.mode || 'cellIs'} onChange={(event) => setFeatureFields((current) => ({ ...current, mode: event.target.value }))}><option value="cellIs">数值比较</option><option value="containsText">包含文本</option><option value="colorScale">色阶</option><option value="dataBar">数据条</option><option value="topN">前 N 项</option><option value="duplicateValues">重复值</option><option value="uniqueValues">唯一值</option></select></label><label><span>比较值 / 文本</span><input value={featureFields.value || ''} onChange={(event) => setFeatureFields((current) => ({ ...current, value: event.target.value }))} /></label><label><span>高亮颜色</span><input type="color" value={featureFields.fill || '#DBEAFE'} onChange={(event) => setFeatureFields((current) => ({ ...current, fill: event.target.value }))} /></label></>}
              {featureDialog.id === 'validation' && <><label><span>最小值</span><input type="number" value={featureFields.formula1 || ''} onChange={(event) => setFeatureFields((current) => ({ ...current, formula1: event.target.value }))} /></label><label><span>最大值</span><input type="number" value={featureFields.formula2 || ''} onChange={(event) => setFeatureFields((current) => ({ ...current, formula2: event.target.value }))} /></label><label><span>错误提示</span><input value={featureFields.error || ''} onChange={(event) => setFeatureFields((current) => ({ ...current, error: event.target.value }))} /></label></>}
              {featureDialog.id === 'dropdown' && <label className="wide"><span>下拉选项</span><textarea value={featureFields.values || ''} onChange={(event) => setFeatureFields((current) => ({ ...current, values: event.target.value }))} placeholder="用逗号或换行分隔" /></label>}
              {(featureDialog.id === 'namedRange' || featureDialog.id === 'quickName') && <label className="wide"><span>说明（可选）</span><input value={featureFields.value || ''} onChange={(event) => setFeatureFields((current) => ({ ...current, value: event.target.value }))} /></label>}
              {featureDialog.id === 'calculation' && <label className="wide"><span>计算方式</span><select value={featureFields.mode || 'auto'} onChange={(event) => setFeatureFields((current) => ({ ...current, mode: event.target.value }))}><option value="auto">自动计算</option><option value="manual">手动计算</option><option value="autoExceptTables">自动计算（数据表除外）</option></select></label>}
              {(featureDialog.id === 'rowHeight' || featureDialog.id === 'columnWidth') && <label><span>{featureDialog.id === 'rowHeight' ? '行高（磅）' : '列宽（字符）'}</span><input type="number" min="1" max="255" value={featureFields.size || ''} onChange={(event) => setFeatureFields((current) => ({ ...current, size: event.target.value }))} /></label>}
            </>}
          </div>
          <footer><button type="button" className="button secondary" onClick={() => setFeatureDialog(null)} disabled={featureBusy}>取消</button><button type="button" className="button primary" onClick={() => void applyFeatureDialog()} disabled={featureBusy}>{featureBusy && <LoaderCircle className="spin" size={14} />}{featureDialog.id === 'functionCatalog' ? '知道了' : '应用修改'}</button></footer>
        </section>
      </div>}
    </section>
  )
}
