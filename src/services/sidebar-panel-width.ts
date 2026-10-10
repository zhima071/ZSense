import { useCallback, useState } from 'react'

export const SIDEBAR_PANEL_DEFAULT_WIDTH = 216
export const SIDEBAR_PANEL_MIN_WIDTH = 180
export const SIDEBAR_PANEL_MAX_WIDTH = 360
export const SIDEBAR_PANEL_WIDTH_STORAGE_KEY = 'zsense-sidebar-panel-width-v1'

export function normalizeSidebarPanelWidth(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return SIDEBAR_PANEL_DEFAULT_WIDTH
  return Math.min(SIDEBAR_PANEL_MAX_WIDTH, Math.max(SIDEBAR_PANEL_MIN_WIDTH, Math.round(value)))
}

function savedSidebarPanelWidth() {
  try {
    const stored = window.localStorage.getItem(SIDEBAR_PANEL_WIDTH_STORAGE_KEY)?.trim()
    return stored && /^\d+(?:\.\d+)?$/.test(stored) ? normalizeSidebarPanelWidth(Number(stored)) : SIDEBAR_PANEL_DEFAULT_WIDTH
  } catch {
    return SIDEBAR_PANEL_DEFAULT_WIDTH
  }
}

export function useSidebarPanelWidth() {
  const [width, setWidth] = useState(savedSidebarPanelWidth)
  const commitWidth = useCallback((value: number) => {
    const next = normalizeSidebarPanelWidth(value)
    setWidth(next)
    try { window.localStorage.setItem(SIDEBAR_PANEL_WIDTH_STORAGE_KEY, String(next)) } catch { /* Layout remains usable without storage. */ }
  }, [])
  return [width, commitWidth] as const
}
