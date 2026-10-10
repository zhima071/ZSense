import type { OfficeDocumentState } from '../types'

export interface PresentationElement {
  path: string
  type: string
  name: string
  text: string
  textEditable: boolean
  x: string
  y: string
  width: string
  height: string
}
export interface PresentationSlide { index: number; path: string; title: string; elements: PresentationElement[] }
export interface PresentationOperation { path: string; properties: Partial<Record<'text' | 'x' | 'y' | 'width' | 'height', string>> }
export interface PresentationSession {
  filePath: string
  sessionId: string
  sessionRevision: number
  previewRevision: number
  baseContentHash: string
  conflict: string
  dirty: boolean
  pendingCount: number
  operations: PresentationOperation[]
  slides: PresentationSlide[]
  document: OfficeDocumentState
  saved?: number
  message?: string
}
