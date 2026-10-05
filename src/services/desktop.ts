import type { DesktopResult } from '../types'

export const isDesktopApp = Boolean(window.zsenseDesktop?.isDesktop)

export async function unwrapDesktop<T>(operation: Promise<DesktopResult<T>>): Promise<T> {
  const result = await operation
  if (!result.ok || result.data === undefined) throw new Error(result.error || '桌面服务没有返回数据')
  return result.data
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '发生未知错误'
}
