import { createContext, useContext } from 'react'
import type { AppSettings } from '../types'

export const defaultDisplaySettings: Pick<AppSettings,
  | 'streamingResponse'
  | 'compactMode'
  | 'showReasoning'
  | 'showUsage'
  | 'inlineDiff'
  | 'completionSound'
  | 'approvalSound'
  | 'approvalDesktopNotification'
  | 'completionDesktopNotification'
  | 'chatInputHeight'
> = {
  streamingResponse: true,
  compactMode: true,
  showReasoning: true,
  showUsage: true,
  inlineDiff: false,
  completionSound: true,
  approvalSound: false,
  approvalDesktopNotification: false,
  completionDesktopNotification: false,
  chatInputHeight: 88,
}

type DisplaySettingsContextValue = typeof defaultDisplaySettings & {
  onChatInputHeightChange?: (height: number) => void | Promise<void>
}

const DisplaySettingsContext = createContext<DisplaySettingsContextValue>(defaultDisplaySettings)

export const DisplaySettingsProvider = DisplaySettingsContext.Provider

export function useDisplaySettings() {
  return useContext(DisplaySettingsContext)
}
