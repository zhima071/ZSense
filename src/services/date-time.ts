export function formatLocalDateTime(value?: string | null, fallback = '') {
  const source = String(value || '').trim()
  if (!source) return fallback
  if (!/[T\s]\d{2}:\d{2}/.test(source)) return source
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(source) ? `${source.replace(' ', 'T')}Z` : source
  const date = new Date(normalized)
  if (Number.isNaN(date.getTime())) return source
  const parts = new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date)
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value || ''
  return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}:${part('second')}`
}
