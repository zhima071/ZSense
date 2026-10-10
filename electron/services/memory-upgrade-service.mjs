import { isAutomaticMemory, unsafeAutomaticMemory } from './memory-intelligence.mjs'

export const MEMORY_UPGRADE_VERSION = 'local-memory-quality-v1'

const normalize = (value) => String(value || '').normalize('NFKC').replace(/\r\n?/gu, '\n').trim()
const durable = /(?:记住|以后|今后|长期|始终|每次|每周|默认|偏好|更喜欢|习惯|我的(?:名字|职业|公司|项目)|我叫|我是(?:一名|一位)|\b(?:remember|always|prefer|by default|from now on|my name|my profession|my company|my project)\b)/iu
const question = /[?？]\s*$|(?:吗|么|呢)[。.!！\s]*$|^(?:请问|你知道|能否|是否|能不能|可不可以|如何|怎么|为什么|(?:what|why|how|can you|could you|do you|is it)\b)/iu
const quotation = /^(?:>|```|["“「『])|^(?:请|帮我|麻烦你?)?\s*(?:翻译|译成|改写|润色|转述|引用|朗读)|^(?:他说|她说|原文|台词|示例|假设|\b(?:translate|rewrite|paraphrase|quoted text|for example|hypothetically)\b)/iu
const transient = /(?:本轮|这一轮|这次|本次|暂时|临时|仅这次|只这次|\b(?:this turn|this time|temporarily|for now)\b)|^(?:今天|明天|当前|现在|目前).{0,40}(?:天气|时间|日期|目录|路径|数量|状态|运行|结果|成功|失败|报错|使用|回复|回答)/iu
const completedTask = /^(?:已|刚刚|本轮|这次|本次|成功)?\s*(?:创建|修改|删除|读取|写入|执行|运行|扫描|测试|构建|部署|下载|上传).{0,40}(?:完成|成功|失败|通过|结束|个文件|条记录)|^(?:任务|测试|构建|命令|部署).{0,20}(?:已完成|已通过|成功|失败|退出码)/u
const toolHeader = /(?:^|\n)\s*(?:tool(?: output| result)?|工具输出|工具结果|执行结果|命令输出|stdout|stderr)\s*[:：]/iu
const toolRuntime = /(?:^|\n)\s*(?:exit code|process exited with code|session id|wall time|yield time|退出码|会话\s*id|耗时)\s*[:：\d]/iu
const toolJson = /"(?:tool_call_id|tool_calls|stdout|stderr|exitCode|session_id)"\s*:/u
const quotedCredential = /["'](?:password|passwd|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|token|secret|private[_ -]?key|session[_ -]?id|cookie|密码|口令|密钥)["']\s*[:=]\s*["'][^"']+/iu

/** 只给旧自动记录标注召回准入；人工与无法确定的来源保守保留。 */
export function classifyLegacyMemory(memory) {
  if (!isAutomaticMemory(memory)) return { eligible: true, reason: 'manual-or-unknown-source' }
  const excerpt = normalize(memory?.excerpt)
  const evidence = normalize(memory?.evidence)
  const title = normalize(memory?.title)
  const combined = `${title}\n${excerpt}\n${evidence}`
  if (unsafeAutomaticMemory(combined) || quotedCredential.test(combined)) return { eligible: false, reason: 'sensitive' }
  // 旧迁移也会给自动记录加保护。仅有实际修改历史的保护项疑似经过人工策展。
  if (memory?.locked === true && (Number(memory?.revision || 1) > 1 || memory?.history?.length)) {
    return { eligible: true, reason: 'protected-edit-preserved' }
  }
  const source = evidence || excerpt
  if (question.test(source)) return { eligible: false, reason: 'question' }
  if (quotation.test(source)) return { eligible: false, reason: 'quoted' }
  if (transient.test(source)) return { eligible: false, reason: 'transient' }
  // 明确长期流程里的命令、日志格式与提问范例仍有价值，不把关键词当作转录。
  if (durable.test(source) && !completedTask.test(source)) return { eligible: true, reason: 'stable-or-uncertain' }
  if (toolHeader.test(source) || toolRuntime.test(source) || toolJson.test(source) || completedTask.test(source)) {
    return { eligible: false, reason: 'tool-transcript' }
  }
  if (!evidence && question.test(excerpt)) return { eligible: false, reason: 'question' }
  return { eligible: true, reason: 'stable-or-uncertain' }
}

/** 数据库决定旧设备/新设备，并原子提交策略及完成标记；失败留待下次启动重试。 */
export class MemoryUpgradeService {
  constructor({ database } = {}) {
    if (!database || typeof database.applyMemoryUpgrade !== 'function') throw new Error('记忆升级整理缺少数据库支持。')
    this.database = database
  }

  inspect() { return this.database.memoryUpgradeStatus() }
  async run() { return this.database.applyMemoryUpgrade({ version: MEMORY_UPGRADE_VERSION, classify: classifyLegacyMemory }) }
}
