// 定时任务的展示口径：总览页与定时任务页共用，保证两处显示完全一致。
import type { ModelConfiguration, ScheduledTask, ScheduledTaskFrequency } from '../types'

export const frequencyOptions: Array<{ value: ScheduledTaskFrequency; label: string; needsTime?: boolean; needsWeekday?: boolean; needsDayOfMonth?: boolean; needsCron?: boolean }> = [
  { value: 'every-5m', label: '每 5 分钟' },
  { value: 'every-15m', label: '每 15 分钟' },
  { value: 'every-30m', label: '每 30 分钟' },
  { value: 'hourly', label: '每小时' },
  { value: 'daily', label: '每天', needsTime: true },
  { value: 'weekdays', label: '工作日', needsTime: true },
  { value: 'weekly', label: '每周', needsTime: true, needsWeekday: true },
  { value: 'monthly', label: '每月', needsTime: true, needsDayOfMonth: true },
  { value: 'custom', label: '自定义 Cron', needsCron: true },
]

export const providerNames: Record<ModelConfiguration['provider'], string> = {
  openrouter: 'OpenRouter', openai: 'OpenAI', anthropic: 'Anthropic', google: 'Google Gemini',
  deepseek: 'DeepSeek', zai: '智谱 GLM', 'kimi-coding-cn': 'Kimi', nous: 'Nous Research', custom: '自定义',
}

export const weekdayNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

export function formatDate(value: string | null) {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false })
}

export function formatDuration(value: number | null) {
  if (value == null) return '—'
  if (value < 1_000) return `${value} 毫秒`
  if (value < 60_000) return `${(value / 1_000).toFixed(1)} 秒`
  return `${Math.floor(value / 60_000)} 分 ${Math.round((value % 60_000) / 1_000)} 秒`
}

export function frequencyLabel(task: Pick<ScheduledTask, 'frequency' | 'timeOfDay' | 'weekday' | 'dayOfMonth' | 'cronExpression'>) {
  const option = frequencyOptions.find((item) => item.value === task.frequency)
  if (!option) return task.frequency
  if (task.frequency === 'weekly') return `${weekdayNames[task.weekday] || '周一'} ${task.timeOfDay}`
  if (task.frequency === 'monthly') return `每月 ${task.dayOfMonth} 日 ${task.timeOfDay}`
  if (task.frequency === 'custom') return `Cron · ${task.cronExpression}`
  return option.needsTime ? `${option.label} ${task.timeOfDay}` : option.label
}

export function folderLabel(value: string) {
  const parts = String(value || '').replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts.at(-1) || value
}

export function scheduledTaskStatusLabel(task: ScheduledTask, running = false) {
  if (running) return '运行中'
  if (task.status === 'active') return '已启用'
  if (task.status === 'completed') return '已完成'
  return '已暂停'
}
