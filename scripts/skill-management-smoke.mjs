import assert from 'node:assert/strict'
import fs from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { ZSenseDatabase } from '../electron/services/database.mjs'
import { SkillManager } from '../electron/services/skill-manager.mjs'

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'zsense-skill-management-'))

const skillDocument = ({ name, version = '1.0.0', instruction = '读取工作区中的输入文件，并生成结构化结果。' }) => [
  '---',
  `name: ${name}`,
  'description: "由用户手动创建和维护的文件处理技能。"',
  `version: ${version}`,
  'author: ZSense User',
  'license: Proprietary',
  'platforms: [macos, linux, windows]',
  '---',
  '',
  `# ${name}`,
  '',
  '## When to Use',
  '',
  '- 用户需要执行同类文件整理任务时使用。',
  '',
  '## Instructions',
  '',
  `1. ${instruction}`,
  '2. 失败时停止写入并报告具体错误，不覆盖原始文件。',
  '',
  '## Verification',
  '',
  '- 检查输出文件存在，并核对关键字段数量。',
].join('\n')

try {
  const skillManager = new SkillManager(path.join(temporaryDirectory, 'agent-core'))
  const databaseRoot = path.join(temporaryDirectory, 'database')
  fs.mkdirSync(databaseRoot, { recursive: true })
  const database = new ZSenseDatabase(databaseRoot, skillManager)
  try {
    const initialWorkspace = database.loadWorkspace()
    assert.equal('skillLearningEnabled' in initialWorkspace.settings, false, '设置中仍暴露自动技能学习开关')
    assert.equal('skillLearningProposals' in initialWorkspace, false, '工作区仍暴露技能学习建议')
    assert.equal('createSkillLearningProposal' in database, false, '数据库仍暴露技能学习写入接口')
    assert.equal(database.db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='skill_learning_proposals'").get().count, 0, '新数据库仍创建技能学习建议表')

    let workspace = database.createSkill({
      name: 'manual-file-review',
      description: '由用户手动创建和维护的文件处理技能。',
      version: '1.0.0',
      repositoryUrl: '',
      content: skillDocument({ name: 'manual-file-review' }),
      assignedBotIds: ['atlas'],
    })
    const createdSkill = workspace.skills.find((skill) => skill.name === 'manual-file-review')
    assert(createdSkill, '手动创建技能失败')
    assert.deepEqual(createdSkill.assignedBotIds, ['atlas'], '手动创建技能时的 Bot 分配没有保存')
    assert(fs.existsSync(path.join(createdSkill.installPath, 'SKILL.md')), '手动创建技能没有写入 SKILL.md')

    workspace = database.updateSkill(createdSkill.id, {
      name: createdSkill.name,
      description: createdSkill.description,
      version: '1.1.0',
      repositoryUrl: '',
      content: skillDocument({ name: createdSkill.name, version: '1.1.0', instruction: '读取输入文件，规范字段名称，再生成结构化结果。' }),
      assignedBotIds: ['atlas'],
    })
    const updatedSkill = workspace.skills.find((skill) => skill.id === createdSkill.id)
    assert(updatedSkill?.versions?.some((version) => version.version === '1.0.0'), '编辑技能前没有生成版本快照')
    const versionToRestore = updatedSkill.versions.find((version) => version.version === '1.0.0')
    workspace = database.restoreSkillVersion(updatedSkill.id, versionToRestore.id)
    const restoredSkill = workspace.skills.find((skill) => skill.id === createdSkill.id)
    assert.equal(restoredSkill?.version, '1.0.0', '技能历史版本没有恢复')
    assert.deepEqual(restoredSkill?.assignedBotIds, ['atlas'], '恢复版本时不应丢失 Bot 分配')

    const recorded = database.recordSkillUsage({
      botId: 'atlas',
      conversationId: 'conversation-skill-usage',
      durationMs: 420,
      toolEvents: [{ name: 'load_skill', status: 'complete', input: JSON.stringify({ name: restoredSkill.name }) }, { name: 'read_file', status: 'complete' }],
    })
    assert.equal(recorded, 1, 'load_skill 成功后没有记录技能使用情况')
    const usedSkill = database.loadWorkspace().skills.find((skill) => skill.id === createdSkill.id)
    assert.equal(usedSkill?.usageCount, 1, '技能使用次数统计不正确')
    assert.equal(usedSkill?.successRate, 100, '技能成功率统计不正确')
    assert(usedSkill?.lastUsedAt, '技能最近使用时间未记录')

    const localOnlyCheck = await skillManager.checkUpdates()
    assert.equal(localOnlyCheck.summary.totalSkills, 1, '更新检查没有统计已安装技能')
    assert.equal(localOnlyCheck.summary.checkedCount, 0, '未配置仓库的技能不应联网检查')
    assert.equal(localOnlyCheck.summary.manualCount, 1, '手动维护技能统计不正确')
    assert.equal(localOnlyCheck.results[0]?.skipped, true, '无仓库技能没有返回明确的跳过状态')
    assert.match(localOnlyCheck.output, /检查完成/, '无在线更新源时没有明确完成反馈')

    workspace = database.createSkill({
      name: 'repository-updatable',
      description: '验证技能仓库检查与更新闭环。',
      version: '1.0.0',
      repositoryUrl: 'https://github.com/zsense/example-skill',
      content: skillDocument({ name: 'repository-updatable', version: '1.0.0' }),
      assignedBotIds: ['atlas'],
    })
    const repositorySkill = workspace.skills.find((skill) => skill.name === 'repository-updatable')
    const originalFetch = globalThis.fetch
    try {
      globalThis.fetch = async () => new Response(skillDocument({ name: 'repository-updatable', version: '1.1.0', instruction: '执行仓库中的新版指令。' }), { status: 200, headers: { 'content-type': 'text/plain' } })
      const updateCheck = await skillManager.checkUpdates(repositorySkill.id)
      assert.equal(updateCheck.results[0]?.updateAvailable, true, '技能仓库检查没有发现新版本')
      assert.equal(updateCheck.summary.checkedCount, 1, '技能仓库检查数量不正确')
      assert.equal(updateCheck.summary.availableCount, 1, '可用更新数量不正确')
      const remotelyUpdated = await skillManager.updateFromRepository(repositorySkill.id)
      assert.equal(remotelyUpdated.version, '1.1.0', '技能没有从仓库更新到最新版本')
      assert(remotelyUpdated.versions.some((version) => version.version === '1.0.0'), '在线更新前没有保留版本快照')
    } finally { globalThis.fetch = originalFetch }
  } finally {
    database.close()
  }

  const legacySkillPath = path.join(skillManager.rootPath, 'plugin-packages', 'old-package', 'legacy-skill')
  fs.mkdirSync(legacySkillPath, { recursive: true })
  fs.writeFileSync(path.join(legacySkillPath, 'SKILL.md'), skillDocument({ name: 'legacy-skill' }), 'utf8')
  const legacySkill = skillManager.listSkills().find((skill) => skill.name === 'legacy-skill')
  assert(legacySkill && legacySkill.source === '本地导入' && legacySkill.category === '本地导入', '历史目录中的 SKILL.md 应保留为普通本地技能')
  const skillsPageSource = fs.readFileSync(new URL('../src/components/SkillsPage.tsx', import.meta.url), 'utf8')
  const skillManagerSource = fs.readFileSync(new URL('../electron/services/skill-manager.mjs', import.meta.url), 'utf8')
  const bundledSkillsRoot = path.resolve(new URL('../bundled-skills/', import.meta.url).pathname)
  const unifiedLarkSkill = path.join(bundledSkillsRoot, 'lark', 'SKILL.md')
  assert(fs.existsSync(unifiedLarkSkill), '统一飞书技能没有内置')
  assert(fs.readFileSync(unifiedLarkSkill, 'utf8').includes('skills read'), '统一飞书技能没有按需加载具体能力说明')
  assert(skillManagerSource.includes("'lark-cli'") && skillManagerSource.includes("'lark'") && skillManagerSource.includes('LARK_SKILL_DIRECTORIES'), '技能安装器没有登记飞书 CLI、统一飞书技能或旧目录迁移')
  assert(skillManagerSource.includes("'bsk'") && skillManagerSource.includes("'browser-skill'"), '技能安装器没有登记 BrowserSkill CLI 和技能')
  assert(skillManagerSource.includes("'one-mail'"), '技能安装器没有登记 one-mail 技能')
  assert(fs.existsSync(path.join(bundledSkillsRoot, 'one-mail', 'SKILL.md')), 'one-mail 技能没有内置')
  if (process.platform === 'darwin' && process.arch === 'arm64') {
    const larkCli = path.resolve(new URL('../bundled-tools/darwin-arm64/lark-cli', import.meta.url).pathname)
    assert.match(execFileSync(larkCli, ['--version'], { encoding: 'utf8' }), /1\.0\.95/)
  }
  assert(skillsPageSource.includes('更新全部'), '技能更新界面缺少一键更新入口')
  assert(skillsPageSource.includes('updateResults'), '技能更新检查结果没有进入可见状态')
  assert(skillsPageSource.includes('aria-busy'), '技能更新检查缺少即时进度反馈')
  assert.equal(skillsPageSource.includes('disabled={!runtimeReady'), false, '技能更新检查仍被 Agent Core 状态错误拦截')
  console.log(JSON.stringify({ ok: true, selfEvolutionRemoved: true, manualCreate: true, versionHistory: true, usageMetrics: true, updateCheckClosedLoop: true, larkSkills: 1, larkCli: true }))
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true })
}
