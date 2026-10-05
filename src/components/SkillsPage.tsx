import {
  Blocks,
  Check,
  ChevronDown,
  CircleAlert,
  ExternalLink,
  FileText,
  FileCode2,
  FolderOpen,
  History,
  LoaderCircle,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldCheck,
  Trash2,
  Upload,
  UsersRound,
  X,
} from 'lucide-react'
import { FormEvent, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { errorMessage } from '../services/desktop'
import type { Bot as BotType, Skill, SkillEditorInput, SkillMaintenanceResult, SkillMaintenanceSummary, SkillSource, SkillUpdateResult } from '../types'

interface SkillsPageProps {
  bots: BotType[]
  skills: Skill[]
  skillsPath?: string
  onCreateSkill: (input: SkillEditorInput) => Promise<void>
  onUpdateSkill: (id: string, input: SkillEditorInput) => Promise<void>
  onDeleteSkill: (skill: Skill) => Promise<void>
  onAssignSkill: (skillId: string, botIds: string[]) => Promise<void>
  onImportSkill: (mode: 'file' | 'folder') => Promise<void>
  onOpenSkillsFolder: (skillId?: string) => Promise<void>
  onCheckUpdates: () => Promise<SkillMaintenanceResult>
  onUpdateRegistrySkill: (skillId?: string) => Promise<SkillMaintenanceResult>
  onRestoreVersion: (skillId: string, versionId: string) => Promise<void>
  embedded?: boolean
}

type EditorState = { mode: 'create' | 'edit'; skill?: Skill; input: SkillEditorInput }

const sourceLabels: Record<SkillSource, string> = {
  'ZSense Core': 'ZSense 内置',
  'Skills Hub': 'Skills Hub',
  ZSense: '我的技能',
  本地导入: '本地导入',
}

const updateModeLabels = {
  runtime: '随 ZSense 更新',
  registry: '支持在线更新',
  manual: '手动维护',
}

function skillSourceLabel(skill: Skill) {
  return skill.source === 'ZSense' && skill.builtIn ? 'ZSense 内置' : sourceLabels[skill.source]
}

function skillUpdateLabel(skill: Skill) {
  return skill.officialUpdate ? '官方渠道更新' : updateModeLabels[skill.updateMode]
}

const emptyInput = (botIds: string[]): SkillEditorInput => ({
  name: '',
  description: '',
  version: '1.0.0',
  repositoryUrl: '',
  enabled: true,
  assignedBotIds: botIds,
  content: [
    '---',
    'name: my-skill',
    'description: "说明这个技能能帮助 Agent 完成什么任务。"',
    'version: 1.0.0',
    'author: Your Name',
    'license: MIT',
    'platforms: [macos, linux, windows]',
    '---',
    '',
    '# My Skill',
    '',
    '简要说明这个技能会做什么，以及它不会做什么。',
    '',
    '## When to Use',
    '',
    '- 写下什么情况下 Agent 应该加载这个技能。',
    '',
    '## Instructions',
    '',
    '1. 写下清晰、可执行的步骤。',
    '2. 说明安全边界和失败时的处理方式。',
    '',
    '## Verification',
    '',
    '- 写下如何确认任务已经正确完成。',
  ].join('\n'),
})

function formatUpdatedAt(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value || '未知'
  return new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date)
}

function toggleBotId(current: string[], botId: string, checked: boolean) {
  return checked ? [...new Set([...current, botId])] : current.filter((id) => id !== botId)
}

function SkillEditor({ state, bots, busy, onClose, onSave }: { state: EditorState; bots: BotType[]; busy: boolean; onClose: () => void; onSave: (input: SkillEditorInput) => Promise<void> }) {
  const [input, setInput] = useState(state.input)
  const update = <K extends keyof SkillEditorInput>(key: K, value: SkillEditorInput[K]) => setInput((current) => ({ ...current, [key]: value }))
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    await onSave({ ...input, enabled: input.assignedBotIds.length > 0 })
  }

  return (
    <div className="dialog-backdrop skill-editor-backdrop" role="presentation">
      <form className="skill-editor-dialog" onSubmit={submit} aria-labelledby="skill-editor-title">
        <header>
          <div><span className="eyebrow">SKILL WORKBENCH</span><h2 id="skill-editor-title">{state.mode === 'create' ? '创建技能' : `编辑 ${state.skill?.name}`}</h2><p>技能文件只保存一份，你可以决定哪些 Bot 能使用它。</p></div>
          <button type="button" className="icon-button" onClick={onClose} disabled={busy} aria-label="关闭技能编辑器"><X size={18} /></button>
        </header>

        <div className="skill-editor-body">
          <aside>
            <label className="form-field"><span>技能名称 *</span><input value={input.name} onChange={(event) => update('name', event.target.value)} required maxLength={160} placeholder="例如：weekly-review" /></label>
            <label className="form-field"><span>用途描述 *</span><textarea value={input.description} onChange={(event) => update('description', event.target.value)} required maxLength={2_000} rows={5} placeholder="一句话说明何时使用这个技能" /></label>
            <label className="form-field"><span>版本号 *</span><input value={input.version} onChange={(event) => update('version', event.target.value)} required maxLength={80} placeholder="1.0.0" /></label>
            <label className="form-field"><span>仓库地址（可选）</span><input type="url" value={input.repositoryUrl} onChange={(event) => update('repositoryUrl', event.target.value)} placeholder="https://github.com/…" /></label>
            <fieldset className="skill-bot-fieldset">
              <legend>分配给 Bot</legend>
              <div className="skill-bot-fieldset-actions"><small>已选 {input.assignedBotIds.length} / {bots.length}</small><button type="button" onClick={() => update('assignedBotIds', bots.map((bot) => bot.id))}>全选</button><button type="button" onClick={() => update('assignedBotIds', [])} disabled={state.skill?.essential}>清空</button></div>
              <div className="skill-bot-options">
                {bots.map((bot) => <label key={bot.id}><input type="checkbox" checked={input.assignedBotIds.includes(bot.id)} disabled={state.skill?.essential} onChange={(event) => update('assignedBotIds', toggleBotId(input.assignedBotIds, bot.id, event.target.checked))} /><span className="bot-choice-avatar" style={{ '--bot-color': bot.color } as React.CSSProperties}>{bot.initials}</span><span><strong>{bot.name}</strong><small>{bot.role}</small></span></label>)}
              </div>
              {!bots.length && <p className="skill-bot-empty">请先创建 Bot，再为技能分配使用对象。</p>}
            </fieldset>
            <div className="skill-editor-hint"><ShieldCheck size={17} /><p><strong>独立空间</strong>这里只修改 ZSense Agent Core 的技能目录，不会读取或覆盖电脑上其他 Agent 的 Skill。</p></div>
          </aside>
          <label className="skill-code-field"><span><FileCode2 size={16} />SKILL.md 指令</span><textarea spellCheck={false} value={input.content} onChange={(event) => update('content', event.target.value)} required aria-label="SKILL.md 指令内容" /></label>
        </div>

        <footer><button type="button" className="secondary-button" onClick={onClose} disabled={busy}>取消</button><button className="primary-button" disabled={busy}>{busy ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}{busy ? '正在保存…' : '保存技能'}</button></footer>
      </form>
    </div>
  )
}

function SkillAssignmentDialog({ skill, bots, busy, onClose, onSave }: { skill: Skill; bots: BotType[]; busy: boolean; onClose: () => void; onSave: (botIds: string[]) => Promise<void> }) {
  const [selected, setSelected] = useState(skill.assignedBotIds)
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    await onSave(selected)
  }
  return (
    <div className="dialog-backdrop" role="presentation">
      <form className="skill-assignment-dialog" onSubmit={submit} aria-labelledby="skill-assignment-title">
        <header><span className="assignment-icon"><UsersRound size={20} /></span><div><span className="eyebrow">BOT ACCESS</span><h2 id="skill-assignment-title">分配“{skill.name}”</h2><p>只有勾选的 Bot 会在 ZSense Agent Core 中加载这个技能。</p></div><button type="button" className="icon-button" onClick={onClose} disabled={busy} aria-label="关闭技能分配"><X size={18} /></button></header>
        <div className="skill-assignment-tools"><span>已选择 <strong>{selected.length}</strong> / {bots.length}</span><button type="button" onClick={() => setSelected(bots.map((bot) => bot.id))}>全部选择</button><button type="button" onClick={() => setSelected([])}>全部清空</button></div>
        <div className="skill-assignment-list">
          {bots.map((bot) => <label key={bot.id} className={selected.includes(bot.id) ? 'selected' : ''}><input type="checkbox" checked={selected.includes(bot.id)} onChange={(event) => setSelected((current) => toggleBotId(current, bot.id, event.target.checked))} /><span className="bot-choice-avatar" style={{ '--bot-color': bot.color } as React.CSSProperties}>{bot.initials}</span><span><strong>{bot.name}</strong><small>{bot.role}</small></span><Check size={16} /></label>)}
          {!bots.length && <p className="skill-bot-empty">还没有可分配的 Bot。</p>}
        </div>
        <footer><button type="button" className="secondary-button" onClick={onClose} disabled={busy}>取消</button><button className="primary-button" disabled={busy}>{busy ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}{busy ? '正在同步…' : '保存分配'}</button></footer>
      </form>
    </div>
  )
}

function SkillDetailDialog({ skill, bots, onClose, onOpenFolder, onEdit, onRestoreVersion }: { skill: Skill; bots: BotType[]; onClose: () => void; onOpenFolder: () => Promise<void>; onEdit?: () => void; onRestoreVersion: (versionId: string) => Promise<void> }) {
  const assignedBots = bots.filter((bot) => skill.assignedBotIds.includes(bot.id))
  const [restoringVersionId, setRestoringVersionId] = useState('')
  const [restoreError, setRestoreError] = useState('')
  const restoreVersion = async (versionId: string) => {
    if (restoringVersionId) return
    setRestoringVersionId(versionId)
    setRestoreError('')
    try {
      await onRestoreVersion(versionId)
      onClose()
    } catch (error) {
      setRestoreError(errorMessage(error))
    } finally {
      setRestoringVersionId('')
    }
  }
  return (
    <div className="dialog-backdrop skill-detail-backdrop" role="presentation">
      <section className="skill-detail-dialog" role="dialog" aria-modal="true" aria-labelledby="skill-detail-title">
        <header>
          <span className={`skill-detail-icon ${skill.builtIn ? 'builtin' : 'custom'}`}><Blocks size={22} /></span>
          <div><span className="eyebrow">SKILL DETAILS</span><h2 id="skill-detail-title">{skill.name}{skill.essential && <em>核心</em>}</h2><p>{skill.description}</p></div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="关闭技能详情"><X size={18} /></button>
        </header>

        <div className="skill-detail-body">
          <aside>
            <section className="skill-detail-card">
              <h3>基本信息</h3>
              <dl>
                <div><dt>版本</dt><dd>v{skill.version}</dd></div>
                <div><dt>分类</dt><dd>{skill.category}</dd></div>
                <div><dt>来源</dt><dd>{skillSourceLabel(skill)}</dd></div>
                <div><dt>维护方式</dt><dd>{skillUpdateLabel(skill)}</dd></div>
                <div><dt>文件</dt><dd>{skill.fileCount} 个</dd></div>
                <div><dt>更新时间</dt><dd>{formatUpdatedAt(skill.updatedAt)}</dd></div>
                <div><dt>使用次数</dt><dd>{skill.usageCount || 0} 次</dd></div>
                <div><dt>成功率</dt><dd>{skill.usageCount ? `${Math.round(skill.successRate || 0)}%` : '尚无记录'}</dd></div>
                <div><dt>最近使用</dt><dd>{skill.lastUsedAt ? formatUpdatedAt(skill.lastUsedAt) : '尚未使用'}</dd></div>
              </dl>
            </section>

            <section className="skill-detail-card">
              <h3><UsersRound size={15} />已分配的 Bot</h3>
              <div className="skill-detail-bots">
                {assignedBots.map((bot) => <span key={bot.id}><i style={{ '--bot-color': bot.color } as React.CSSProperties}>{bot.initials}</i><span><strong>{bot.name}</strong><small>{bot.role}</small></span></span>)}
                {!assignedBots.length && <p>该技能尚未分配给任何 Bot。</p>}
              </div>
            </section>

            <section className="skill-detail-card skill-detail-path">
              <h3><FolderOpen size={15} />安装位置</h3>
              <code title={skill.installPath}>{skill.installPath || '浏览器预览不提供真实路径'}</code>
              <small>打开时会在文件管理器中直接选中 SKILL.md。</small>
            </section>

            {skill.editable && <section className="skill-detail-card skill-version-history">
              <h3><History size={15} />版本历史</h3>
              {skill.versions?.length ? <div>{skill.versions.map((version) => <article key={version.id}><span><strong>v{version.version}</strong><small>{formatUpdatedAt(version.createdAt)}</small></span><button type="button" disabled={Boolean(restoringVersionId)} onClick={() => void restoreVersion(version.id)} aria-label={`恢复 ${skill.name} 的 ${version.version} 版本`}>{restoringVersionId === version.id ? <LoaderCircle className="spin" size={14} /> : <RotateCcw size={14} />}恢复</button></article>)}</div> : <p>编辑或在线更新后，这里会自动保留旧版本。</p>}
            </section>}

            {skill.repositoryUrl && <a className="skill-repository-link" href={skill.repositoryUrl} target="_blank" rel="noreferrer"><ExternalLink size={15} /><span><strong>查看技能仓库</strong><small>{skill.repositoryUrl}</small></span></a>}
          </aside>

          <section className="skill-detail-document" aria-label={`${skill.name} 的 SKILL.md 内容`}>
            <header><span><FileCode2 size={16} />SKILL.md</span><small>只读预览 · {skill.content.split('\n').length} 行</small></header>
            {skill.content ? <pre tabIndex={0}><code>{skill.content}</code></pre> : <div className="skill-document-empty"><FileText size={24} /><strong>暂无可预览内容</strong><p>请在桌面端打开真实技能文件。</p></div>}
          </section>
        </div>

        {restoreError && <p className="skill-detail-error" role="alert">恢复版本失败：{restoreError}</p>}
        <footer>
          <button type="button" className="secondary-button" onClick={() => void onOpenFolder()}><FolderOpen size={16} />在目录中显示 SKILL.md</button>
          {onEdit && <button type="button" className="secondary-button" onClick={onEdit}><Pencil size={16} />编辑技能</button>}
          <button type="button" className="primary-button" onClick={onClose}>完成</button>
        </footer>
      </section>
    </div>
  )
}

export function SkillsPage({ bots, skills, skillsPath, onCreateSkill, onUpdateSkill, onDeleteSkill, onAssignSkill, onImportSkill, onOpenSkillsFolder, onCheckUpdates, onUpdateRegistrySkill, onRestoreVersion, embedded = false }: SkillsPageProps) {
  const [query, setQuery] = useState('')
  const deferredQuery = useDeferredValue(query)
  const [category, setCategory] = useState('all')
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [detailTarget, setDetailTarget] = useState<Skill | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Skill | null>(null)
  const [assignmentTarget, setAssignmentTarget] = useState<Skill | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const importMenuRef = useRef<HTMLDivElement>(null)
  const [busyAction, setBusyAction] = useState('')
  const [updateResults, setUpdateResults] = useState<SkillUpdateResult[] | null>(null)
  const [updateSummary, setUpdateSummary] = useState<SkillMaintenanceSummary | null>(null)
  const [updateError, setUpdateError] = useState('')
  const [lastCheckedAt, setLastCheckedAt] = useState('')
  const [selectedScope, setSelectedScope] = useState<'all' | 'builtin' | 'mine'>('all')
  const [actionError, setActionError] = useState('')

  const scopedSkills = useMemo(() => skills.filter((skill) => selectedScope === 'all'
    || selectedScope === 'builtin' && skill.builtIn
    || selectedScope === 'mine' && !skill.builtIn), [selectedScope, skills])
  const categories = useMemo(() => [...new Set(scopedSkills.map((skill) => skill.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-CN')), [scopedSkills])
  useEffect(() => { if (category !== 'all' && !categories.includes(category)) setCategory('all') }, [categories, category])
  useEffect(() => {
    if (!importOpen) return
    const onPointerDown = (event: PointerEvent) => { if (!importMenuRef.current?.contains(event.target as Node)) setImportOpen(false) }
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') setImportOpen(false) }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('pointerdown', onPointerDown); document.removeEventListener('keydown', onKeyDown) }
  }, [importOpen])
  const visibleSkills = useMemo(() => {
    const normalizedQuery = deferredQuery.trim().toLowerCase()
    return scopedSkills.filter((skill) => {
      const matchesCategory = category === 'all' || skill.category === category
      const haystack = `${skill.name} ${skill.description} ${skill.source} ${skill.category}`.toLowerCase()
      return matchesCategory && (!normalizedQuery || haystack.includes(normalizedQuery))
    })
  }, [category, deferredQuery, scopedSkills])

  const run = async (key: string, action: () => Promise<void>) => {
    if (busyAction) return
    setBusyAction(key)
    setActionError('')
    try { await action() }
    catch (error) { setActionError(errorMessage(error)) }
    finally { setBusyAction('') }
  }

  const openCreate = () => setEditor({ mode: 'create', input: emptyInput(bots.map((bot) => bot.id)) })
  const openEdit = (skill: Skill) => setEditor({ mode: 'edit', skill, input: { id: skill.id, name: skill.name, description: skill.description, version: skill.version, repositoryUrl: skill.repositoryUrl, content: skill.content, enabled: skill.enabled, assignedBotIds: skill.assignedBotIds } })
  const saveEditor = async (input: SkillEditorInput) => {
    if (!editor) return
    await run('save', async () => {
      if (editor.mode === 'create') await onCreateSkill(input)
      else if (editor.skill) await onUpdateSkill(editor.skill.id, input)
      setEditor(null)
    })
  }

  const checkUpdates = async () => {
    if (busyAction) return
    setBusyAction('check')
    setUpdateResults([])
    setUpdateSummary(null)
    setUpdateError('')
    try {
      const result = await onCheckUpdates()
      setUpdateResults(result.results)
      setUpdateSummary(result.summary)
      setLastCheckedAt(result.summary.completedAt)
    } catch (error) {
      setUpdateError(error instanceof Error ? error.message : '检查技能更新失败')
      setLastCheckedAt(new Date().toISOString())
    } finally { setBusyAction('') }
  }

  const updateSkills = async (skillId?: string) => {
    if (busyAction) return
    setBusyAction(skillId ? `update-${skillId}` : 'update-all')
    setUpdateError('')
    try {
      const result = await onUpdateRegistrySkill(skillId)
      setUpdateSummary(result.summary)
      setUpdateResults((current) => {
        if (!current) return result.results
        const changed = new Map(result.results.map((item) => [item.id, item]))
        return current.map((item) => changed.has(item.id) ? { ...item, ...changed.get(item.id) } : item)
      })
      setLastCheckedAt(new Date().toISOString())
    } catch (error) {
      setUpdateError(errorMessage(error))
      setActionError(`更新技能失败：${errorMessage(error)}`)
    } finally { setBusyAction('') }
  }

  const builtInSkills = skills.filter((skill) => skill.builtIn)
  const personalSkills = skills.filter((skill) => !skill.builtIn)

  const availableUpdates = updateResults?.filter((item) => item.updateAvailable) || []
  const updateFailures = updateResults?.filter((item) => item.error) || []

  return (
    <div className="page skills-page">
      <section className="page-heading skills-heading">
        <div><span className="eyebrow">ZSENSE SKILLS</span>{embedded ? <h2>技能管理</h2> : <h1>技能管理</h1>}<p>统一查看、编辑、分配和更新技能。</p></div>
        <div className="skills-heading-actions">
          <button className="secondary-button" onClick={() => void checkUpdates()} disabled={Boolean(busyAction)} title="手动检查官方渠道、Skills Hub 和已配置仓库；不会在后台自动联网">{busyAction === 'check' ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}{busyAction === 'check' ? '正在检查…' : '检查技能更新'}</button>
          <div className="import-menu-wrap" ref={importMenuRef}>
            <button className="secondary-button" onClick={() => setImportOpen((open) => !open)} aria-controls="skill-import-menu" aria-expanded={importOpen} disabled={Boolean(busyAction)}><Upload size={16} />导入<ChevronDown size={14} /></button>
            {importOpen && <div className="import-menu" id="skill-import-menu"><button onClick={() => { setImportOpen(false); void run('import-file', () => onImportSkill('file')) }}><FileCode2 size={17} /><span><strong>导入 SKILL.md</strong><small>导入一个技能说明文件</small></span></button><button onClick={() => { setImportOpen(false); void run('import-folder', () => onImportSkill('folder')) }}><FolderOpen size={17} /><span><strong>导入技能文件夹</strong><small>保留 scripts、references 等资源</small></span></button></div>}
          </div>
          <button className="primary-button" onClick={openCreate} disabled={Boolean(busyAction)}><Plus size={17} />新建技能</button>
        </div>
      </section>

      <section className="skills-scope-banner" aria-label="技能目录">
        <span className="skills-scope-icon"><ShieldCheck size={21} /></span>
        <div><strong>独立技能目录</strong><p>技能以 SKILL.md 保存；可为不同 Bot 分配，编辑后的内置技能会保留你的修改。</p></div>
        <button className="scope-path" onClick={() => void run('open-folder', () => onOpenSkillsFolder())} title={skillsPath || '打开技能目录'}><small>SKILLS PATH</small><code>{skillsPath || '桌面端启动后显示真实路径'}</code><FolderOpen size={15} /></button>
      </section>

      <section className="skills-stats" aria-label="技能统计">
        <div><span className="skill-stat-icon purple"><Blocks size={18} /></span><span><small>全部技能</small><strong>{skills.length}</strong></span></div>
        <div><span className="skill-stat-icon green"><UsersRound size={18} /></span><span><small>已分配给 Bot</small><strong>{skills.filter((skill) => skill.assignedBotIds.length > 0).length}</strong></span></div>
        <div><span className="skill-stat-icon blue"><RefreshCw size={18} /></span><span><small>支持单独更新</small><strong>{skills.filter((skill) => skill.updateMode === 'registry').length}</strong></span></div>
      </section>

      {actionError && <div className="skill-action-message error" role="alert"><span>{actionError}</span><button type="button" className="icon-button" onClick={() => setActionError('')} aria-label="关闭错误提示"><X size={15} /></button></div>}

      <div className="segmented skills-source-tabs" role="group" aria-label="技能范围">
        <button type="button" className={selectedScope === 'all' ? 'active' : ''} onClick={() => setSelectedScope('all')}>全部 <span>{skills.length}</span></button>
        <button type="button" className={selectedScope === 'builtin' ? 'active' : ''} onClick={() => setSelectedScope('builtin')}>内置 <span>{builtInSkills.length}</span></button>
        <button type="button" className={selectedScope === 'mine' ? 'active' : ''} onClick={() => setSelectedScope('mine')}>我的 <span>{personalSkills.length}</span></button>
      </div>

      <div className="skills-toolbar">
        <label className="search-field wide"><Search size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索当前范围内的技能" aria-label="搜索当前范围内的技能" /></label>
        <select value={category} onChange={(event) => setCategory(event.target.value)} aria-label="按技能分类筛选"><option value="all">全部分类</option>{categories.map((item) => <option key={item} value={item}>{item}</option>)}</select>
        <span className="skills-result-count" role="status">显示 {visibleSkills.length} / {scopedSkills.length}</span>
      </div>

      {updateResults && <section className="skill-update-center panel" aria-live="polite" aria-busy={busyAction === 'check'}>
        <header>
          <span className={`skill-update-center-icon ${updateFailures.length || updateError ? 'warning' : ''}`}>{busyAction === 'check' ? <LoaderCircle className="spin" size={18} /> : updateFailures.length || updateError ? <CircleAlert size={18} /> : <RefreshCw size={18} />}</span>
          <span><strong>{busyAction === 'check' ? '正在检查技能更新' : updateError ? '技能更新检查失败' : availableUpdates.length ? `发现 ${availableUpdates.length} 个可用更新` : '技能检查已完成'}</strong><small>{busyAction === 'check' ? '正在读取技能配置并连接可用仓库…' : updateError || (updateSummary ? `共 ${updateSummary.totalSkills} 个技能 · 联网检查 ${updateSummary.checkedCount} 个 · ${updateSummary.failureCount ? `${updateSummary.failureCount} 个失败` : '检查完成'}` : '检查完成')}{lastCheckedAt && busyAction !== 'check' ? ` · ${formatUpdatedAt(lastCheckedAt)}` : ''}</small></span>
          {availableUpdates.length > 0 && <button className="button primary small" onClick={() => void updateSkills()} disabled={Boolean(busyAction)}>{busyAction === 'update-all' ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}{busyAction === 'update-all' ? '更新中…' : `更新全部 (${availableUpdates.length})`}</button>}
          <button className="icon-button" onClick={() => setUpdateResults(null)} aria-label="关闭技能更新结果" title="关闭"><X size={16} /></button>
        </header>
        {updateError && <p className="skill-update-empty error">{updateError}</p>}
        {!updateError && busyAction !== 'check' && updateSummary && updateSummary.skippedCount > 0 && <div className="skill-update-summary">
          {updateSummary.runtimeManagedCount > 0 && <span><strong>{updateSummary.runtimeManagedCount}</strong><small>随 ZSense 版本更新</small></span>}
          {updateSummary.manualCount > 0 && <span><strong>{updateSummary.manualCount}</strong><small>由你手动维护</small></span>}
          <p>钉钉 DWS、金山文档、飞书 CLI、OfficeCLI 与 BrowserSkill 会在你点击后检查官方渠道；其他技能按仓库地址检查。不会后台自动联网。</p>
        </div>}
        {!updateError && busyAction !== 'check' && updateResults.length > 0 && <div className="skill-update-results">
          {updateResults.map((item) => <article className={item.error ? 'error' : item.updateAvailable ? 'available' : 'current'} key={item.id}>
            <span><strong>{item.name}</strong><small>{item.error || (item.skipped ? item.updateMode === 'runtime' ? '内置技能随 ZSense 版本更新' : '未配置仓库地址，由你手动维护' : `${item.currentVersion || '未知'} → ${item.latestVersion || item.currentVersion || '未知'}`)}</small></span>
            {item.updateAvailable ? <button className="button secondary small" onClick={() => void updateSkills(item.id)} disabled={Boolean(busyAction)}>{busyAction === `update-${item.id}` ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}{busyAction === `update-${item.id}` ? '更新中' : '更新'}</button> : <em>{item.error ? '检查失败' : item.skipped ? item.updateMode === 'runtime' ? '随应用更新' : '手动维护' : '已是最新'}</em>}
          </article>)}
        </div>}
        {!updateError && busyAction !== 'check' && !updateResults.length && <p className="skill-update-empty">当前还没有安装技能。</p>}
      </section>}

      {visibleSkills.length ? (
        <section className="skill-list panel" aria-live="polite" aria-label="共享技能列表">
          <div className="skill-list-head" aria-hidden="true"><span>技能</span><span>分类</span><span>分配数量</span><span>操作</span></div>
          {visibleSkills.map((skill) => {
            const assignedBots = bots.filter((bot) => skill.assignedBotIds.includes(bot.id))
            return (
            <article className={`skill-list-row ${assignedBots.length ? '' : 'unassigned'}`} key={skill.id}>
              <button type="button" className="skill-list-identity skill-identity-button" onClick={() => setDetailTarget(skill)} aria-label={`查看 ${skill.name} 的技能详情`}><span className={`skill-logo ${skill.builtIn ? 'builtin' : 'custom'}`}><Blocks size={19} /></span><span><h2>{skill.name}{skill.essential && <em>核心</em>}</h2><p title={skill.description}>{skill.description}</p></span></button>
              <span className="skill-category">{skill.category}</span>
              <span className={`skill-assignment-count ${assignedBots.length ? 'assigned' : ''}`} aria-label={`已分配给 ${assignedBots.length} 个 Bot`}><strong>{assignedBots.length}</strong><small>个 Bot</small></span>
              <div className="skill-row-actions">
                <button className="table-action" onClick={() => setDetailTarget(skill)} aria-label={`查看 ${skill.name} 的技能详情`} title="查看技能详情"><FileText size={15} /><span>详情</span></button>
                {skill.updateMode === 'registry' && <button className="table-action" onClick={() => void updateSkills(skill.id)} disabled={Boolean(busyAction)} aria-label={`更新技能 ${skill.name}`} title={skill.officialUpdate ? '从官方渠道检查并更新技能与配套 CLI' : '从技能仓库检查并更新'}><RefreshCw className={busyAction === `update-${skill.id}` ? 'spin' : ''} size={15} /><span>更新</span></button>}
                <button className="table-action assignment-action" onClick={() => setAssignmentTarget(skill)} disabled={skill.essential || Boolean(busyAction)} aria-label={skill.essential ? `${skill.name} 是核心技能，必须分配给全部 Bot` : `分配技能 ${skill.name}`} title={skill.essential ? 'ZSense 核心技能必须分配给全部 Bot' : '指定可以使用此技能的 Bot'}><UsersRound size={15} /><span>分配</span></button>
                {skill.editable && <button className="table-action" onClick={() => openEdit(skill)} aria-label={`编辑技能 ${skill.name}`} title="编辑技能"><Pencil size={15} /><span>编辑</span></button>}
                <button className="table-action" onClick={() => void run('open-folder', () => onOpenSkillsFolder(skill.id))} aria-label={`打开 ${skill.name} 的技能目录`} title="打开技能目录"><FolderOpen size={15} /><span>目录</span></button>
                {skill.editable && <button className="table-action danger" onClick={() => setDeleteTarget(skill)} aria-label={`删除技能 ${skill.name}`} title="删除技能"><Trash2 size={15} /><span>删除</span></button>}
              </div>
            </article>
          )})}
        </section>
      ) : <div className="panel empty-state skill-empty"><Search size={25} /><strong>{scopedSkills.length ? '没有找到匹配的技能' : '当前范围没有技能'}</strong><p>{scopedSkills.length ? '试试清空搜索或分类筛选。' : skills.length ? '切换到“全部”，或新建、导入技能。' : '你可以新建技能，或从本地导入 SKILL.md。'}</p>{(query || category !== 'all' || selectedScope !== 'all') && <button className="secondary-button" onClick={() => { setQuery(''); setCategory('all'); setSelectedScope('all') }}>显示全部技能</button>}{!skills.length && <button className="primary-button" onClick={openCreate}><Plus size={16} />创建第一个技能</button>}</div>}

      <section className="skill-maintenance-note"><CircleAlert size={18} /><div><strong>所有技能都可以编辑和管理</strong><p>无论来源，你都可以编辑、分配、打开目录或删除。编辑过的内置技能会转为手动维护，ZSense 重启或升级时不会覆盖你的修改。</p></div></section>

      {detailTarget && <SkillDetailDialog key={detailTarget.id} skill={detailTarget} bots={bots} onClose={() => setDetailTarget(null)} onOpenFolder={() => run('open-folder', () => onOpenSkillsFolder(detailTarget.id))} onRestoreVersion={(versionId) => onRestoreVersion(detailTarget.id, versionId)} onEdit={detailTarget.editable ? () => { setDetailTarget(null); openEdit(detailTarget) } : undefined} />}
      {editor && <SkillEditor key={`${editor.mode}-${editor.skill?.id || 'new'}`} state={editor} bots={bots} busy={busyAction === 'save'} onClose={() => setEditor(null)} onSave={saveEditor} />}
      {assignmentTarget && <SkillAssignmentDialog key={assignmentTarget.id} skill={assignmentTarget} bots={bots} busy={busyAction === 'assign'} onClose={() => setAssignmentTarget(null)} onSave={(botIds) => run('assign', async () => { await onAssignSkill(assignmentTarget.id, botIds); setAssignmentTarget(null) })} />}
      {deleteTarget && <div className="dialog-backdrop" role="presentation"><div className="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="delete-skill-title"><span className="confirm-icon"><Trash2 size={22} /></span><h2 id="delete-skill-title">删除“{deleteTarget.name}”？</h2><p>这会从 ZSense Agent Core 的独立技能目录中删除该技能文件夹。</p><div><button className="secondary-button" onClick={() => setDeleteTarget(null)} disabled={busyAction === 'delete'}>取消</button><button className="danger-button" onClick={() => void run('delete', async () => { await onDeleteSkill(deleteTarget); setDeleteTarget(null) })} disabled={busyAction === 'delete'}>{busyAction === 'delete' ? <LoaderCircle className="spin" size={16} /> : <Trash2 size={16} />}确认删除</button></div></div></div>}
    </div>
  )
}
