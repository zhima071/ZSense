import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const projectRoot = path.resolve(new URL('..', import.meta.url).pathname)
const sourceRoot = path.join(projectRoot, 'src')
const sourceFiles = []

function collect(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filePath = path.join(directory, entry.name)
    if (entry.isDirectory()) collect(filePath)
    else if (entry.name.endsWith('.tsx')) sourceFiles.push(filePath)
  }
}

function attribute(attributes, name) {
  return attributes.properties.find((property) => ts.isJsxAttribute(property) && property.name.text === name)
}

function expressionMayRenderText(expression) {
  if (!expression) return false
  if (ts.isJsxElement(expression) || ts.isJsxFragment(expression)) return nodeHasText(expression)
  if (ts.isParenthesizedExpression(expression)) return expressionMayRenderText(expression.expression)
  if (ts.isConditionalExpression(expression)) return expressionMayRenderText(expression.whenTrue) || expressionMayRenderText(expression.whenFalse)
  if (ts.isBinaryExpression(expression)) return expressionMayRenderText(expression.left) || expressionMayRenderText(expression.right)
  if (ts.isArrayLiteralExpression(expression)) return expression.elements.some(expressionMayRenderText)
  return ts.isCallExpression(expression)
    || ts.isIdentifier(expression)
    || ts.isPropertyAccessExpression(expression)
    || ts.isElementAccessExpression(expression)
    || ts.isStringLiteralLike(expression)
    || ts.isNumericLiteral(expression)
    || ts.isTemplateExpression(expression)
    || ts.isNoSubstitutionTemplateLiteral(expression)
}

function nodeHasText(node) {
  for (const child of node.children || []) {
    if (ts.isJsxText(child) && child.text.trim()) return true
    if (ts.isJsxExpression(child) && expressionMayRenderText(child.expression)) return true
    if ((ts.isJsxElement(child) || ts.isJsxFragment(child)) && nodeHasText(child)) return true
  }
  return false
}

collect(sourceRoot)
const unlabeled = []
let iconOnlyCandidates = 0

for (const filePath of sourceFiles) {
  const source = fs.readFileSync(filePath, 'utf8')
  const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const visit = (node) => {
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText(sourceFile) === 'button' && !nodeHasText(node)) {
      iconOnlyCandidates += 1
      const attributes = node.openingElement.attributes
      if (!['aria-label', 'aria-labelledby', 'title', 'data-tooltip'].some((name) => attribute(attributes, name))) {
        const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
        unlabeled.push(`${path.relative(projectRoot, filePath)}:${line}`)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
}

const tooltipSource = fs.readFileSync(path.join(sourceRoot, 'components', 'GlobalIconTooltips.tsx'), 'utf8')
const mainSource = fs.readFileSync(path.join(sourceRoot, 'main.tsx'), 'utf8')
const styles = fs.readFileSync(path.join(sourceRoot, 'styles.css'), 'utf8')

assert(iconOnlyCandidates > 40, '纯图标按钮扫描数量异常，检查扫描器是否失效')
assert.deepEqual(unlabeled, [], `这些纯图标按钮缺少用途名称：${unlabeled.join('、')}`)
for (const requirement of [
  "document.addEventListener('pointerover'",
  "document.addEventListener('focusin'",
  "document.addEventListener('pointerdown'",
  "if (touchFocus) return",
  "event.key === 'Escape'",
  'role="tooltip"',
  'TOOLTIP_DELAY_MS',
  'tooltipRef.current.offsetWidth',
  'createPortal(',
  "event.propertyName === 'transform'",
]) assert(tooltipSource.includes(requirement), `全局按钮提示缺少交互：${requirement}`)
assert(mainSource.includes('<GlobalIconTooltips />'), '全局按钮提示没有挂载到应用根节点')
assert(styles.includes('.global-icon-tooltip') && styles.includes('var(--tooltip-arrow-offset') && styles.includes('@media (prefers-reduced-motion: reduce)'), '全局按钮提示缺少动态边缘定位、箭头对齐或减少动态效果支持')
assert(styles.includes('.sidebar.is-open { transform: translateX(0); box-shadow: 20px 0 50px'), '移动端侧栏阴影必须只在展开时出现')

console.log(JSON.stringify({ ok: true, iconOnlyCandidates, unlabeled: 0, hover: true, keyboardFocus: true, escapeDismiss: true }))
