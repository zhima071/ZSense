export type BotStatus = 'online' | 'paused' | 'offline'
export type ChannelId = 'web' | 'telegram' | 'discord' | 'slack' | 'wecom' | 'weixin' | 'dingtalk' | 'feishu' | 'webhook'
export type ExternalChannelId = Exclude<ChannelId, 'web'>
export type ConversationChannelId = ChannelId | 'scheduled' | 'device-link'
export type ViewId = 'overview' | 'chat' | 'bots' | 'scheduled-tasks' | 'office-tasks' | 'memory' | 'skills' | 'models' | 'activity' | 'settings'

export interface OfficeWorkItem {
  id: string
  botId: string
  conversationId: string
  sourceChannel: string
  sourceConnectionId: string
  sourceThreadId: string
  sourceMessageId: string
  title: string
  request: string
  status: 'running' | 'review' | 'delivering' | 'completed' | 'failed' | 'interrupted'
  steps: Array<{ id: string; label: string; status: string; detail?: string }>
  evidence: Array<{ type: string; label: string; sourceId?: string; path?: string; page?: number; cell?: string }>
  artifacts: Array<{ name: string; path: string; verified?: boolean; sha256?: string; error?: string }>
  output: string
  deliveryStatus: string
  deliveryReceipt: string
  errorCode: string
  error: string
  attempts: number
  createdAt: string
  updatedAt: string
}

export interface OfficeSearchHit {
  id: string
  taskId: string
  sourceType: string
  sourceId: string
  title: string
  filePath: string
  updatedAt: string
  snippet: string
}
export type BotTab = 'overview' | 'memory' | 'gateway' | 'identity' | 'tasks'
export type SkillSource = 'ZSense Core' | 'Skills Hub' | 'ZSense' | '本地导入'
export type SkillUpdateMode = 'runtime' | 'registry' | 'manual'
export type UserRole = 'admin' | 'member'

export interface AuthUser {
  id: string
  email?: string
  username: string
  displayName: string
  role: UserRole
  enabled: boolean
  createdAt: string
  updatedAt: string
  lastLoginAt: string | null
}

export interface AuthStatus {
  setupRequired: boolean
  authenticated: boolean
  locked: boolean
  user: AuthUser | null
}

export interface CreateUserInput {
  username: string
  displayName: string
  role: UserRole
}

export interface UpdateUserInput {
  id: string
  username: string
  displayName: string
  role: UserRole
  enabled: boolean
}

export interface MemoryItem {
  id: string
  title: string
  excerpt: string
  type: 'fact' | 'preference' | 'episode'
  updatedAt: string
  source: string
  confidence?: number
  evidence?: string
  conversationId?: string
  createdAt?: string
  lastRecalledAt?: string | null
  recallCount?: number
}

export interface Bot {
  id: string
  name: string
  initials: string
  role: string
  description: string
  status: BotStatus
  color: string
  modelProvider: ModelProvider | ''
  model: string
  memoryCount: number
  memorySize: string
  channels: ChannelId[]
  lastActive: string
  conversations: number
  successRate: number
  prompt: string
  memories: MemoryItem[]
}

export interface Channel {
  id: ChannelId | 'device-link'
  name: string
  description: string
  status: 'connected' | 'setup' | 'paused'
  latency: string
  messages: number
  configured: boolean
  config: Record<string, string>
  secretKeys: string[]
}

export interface GatewayConnection {
  id: string
  provider: ExternalChannelId
  name: string
  botId: string
  profileName: string
  status: 'connected' | 'setup' | 'paused'
  latency: string
  messages: number
  configured: boolean
  config: Record<string, string>
  secretKeys: string[]
  updatedAt: string
}

export interface GatewayPairingRequest {
  requestId: string
  provider: ExternalChannelId
  userId: string
  userName: string
  createdAt: string
}

export type WeixinQrLoginState = 'preparing' | 'waiting' | 'scanned' | 'confirmed' | 'expired' | 'cancelled' | 'error'

export interface WeixinQrLoginStatus {
  loginId: string
  state: WeixinQrLoginState
  qrImage: string
  message: string
  accountId: string
  userId: string
  baseUrl: string
  token?: string
}

export interface GatewayAuthorizedUser {
  provider: ExternalChannelId
  userId: string
  userName: string
  approvedAt: string
}

export type DwsAuthState = 'checking' | 'active' | 'expired' | 'missing' | 'error' | 'authorizing'

export interface DwsAuthStatus {
  available: boolean
  authenticated: boolean
  state: DwsAuthState
  accountLabel?: string
  expiresAt?: string
  message: string
  checkedAt: string
}

export type ModelProvider = 'openrouter' | 'openai' | 'anthropic' | 'google' | 'deepseek' | 'zai' | 'kimi-coding-cn' | 'nous' | 'custom'
export type ReasoningEffort = 'none' | 'low' | 'high' | 'max'
export type ScheduledTaskFrequency = 'every-5m' | 'every-15m' | 'every-30m' | 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'custom'
export type ScheduledTaskStatus = 'active' | 'paused' | 'completed'
export type ScheduledTaskRunStatus = 'running' | 'success' | 'failed'

export interface ModelConfiguration {
  provider: ModelProvider
  model: string
  baseUrl: string
  apiKeyName: string
  apiKeyConfigured: boolean
  updatedAt: string
  contextWindow?: number
}

export interface GatewayConnectionConfigurationInput {
  id?: string
  provider: ExternalChannelId
  name: string
  botId: string
  enabled: boolean
  config: Record<string, string>
  secrets: Record<string, string>
  clearSecrets: string[]
}

export interface ModelConfigurationInput {
  provider: ModelProvider
  model: string
  baseUrl: string
  apiKeyName: string
  apiKey: string
  clearApiKey: boolean
}

export interface ModelCatalogRequest {
  provider: ModelProvider
  baseUrl: string
  apiKeyName: string
  apiKey: string
  forceRefresh: boolean
}

export interface ModelCatalog {
  provider: ModelProvider
  models: string[]
  entries?: Array<{ id: string; contextWindow: number }>
  source: 'official-api'
  endpoint: string
  fetchedAt: string
}

export interface Skill {
  id: string
  name: string
  description: string
  category: string
  version: string
  enabled: boolean
  assignedBotIds: string[]
  source: SkillSource
  updatedAt: string
  fileCount: number
  content: string
  installPath: string
  editable: boolean
  builtIn: boolean
  essential: boolean
  defaultEnabled?: boolean
  updateMode: SkillUpdateMode
  repositoryUrl: string
  pluginId?: string
  officialUpdate?: boolean
  usageCount?: number
  successRate?: number
  lastUsedAt?: string
  versions?: SkillVersion[]
}

export interface SkillVersion {
  id: string
  version: string
  createdAt: string
}

export type OfficeDocumentKind = 'word' | 'excel' | 'powerpoint' | 'html' | 'image' | 'pdf' | 'legacy'

export interface OfficeRecentFile {
  filePath: string
  name: string
  extension: string
  kind: OfficeDocumentKind
  accessedAt: string
}

export interface OfficeWorkspaceStatus {
  available: boolean
  version: string
  message: string
  supportedExtensions: string[]
  legacyExtensions: string[]
}

export interface OfficeDocumentState extends OfficeRecentFile {
  editable: boolean
  previewUrl: string
  modifiedAt: string
  size: number
  sheets: string[]
  message: string
}

export interface HtmlDocumentSession {
  filePath: string
  sessionId: string
  revision: number
  dirty: boolean
  pendingCount: number
  source: string
  modifiedAt: string
}

export type OfficeWordOperationAction =
  | 'setText'
  | 'formatText'
  | 'formatParagraph'
  | 'insertParagraph'
  | 'insertTable'
  | 'insertImage'
  | 'insertLink'
  | 'insertPageBreak'
  | 'setHeader'
  | 'setFooter'
  | 'insertToc'
  | 'addComment'
  | 'removeBlock'

export interface OfficeWordOperation {
  action: OfficeWordOperationAction
  path?: string
  text?: string
  filePath?: string
  url?: string
  options?: Record<string, string | number | boolean>
}

export interface WordDocumentSession {
  filePath: string
  sessionId: string
  sessionRevision: number
  dirty: boolean
  pendingCount: number
  modifiedAt: string
  operations: OfficeWordOperation[]
  document: OfficeDocumentState
}

export interface OfficeSheetCell {
  address: string
  value: string
  display: string
  formula: string
  dataType: string
  style?: OfficeSheetCellStyle
}

export interface OfficeSheetCellStyle {
  fontName?: string
  fontSize?: number
  bold?: boolean
  italic?: boolean
  underline?: string
  strike?: boolean
  fontColor?: string
  fill?: string
  numberFormat?: string
  horizontalAlignment?: string
  verticalAlignment?: string
  wrapText?: boolean
}

export interface OfficeSheetGrid {
  id: string
  sheet: string
  rowCount: number
  columnCount: number
  usedRowCount: number
  usedColumnCount: number
  cells: Record<string, OfficeSheetCell>
}

export interface OfficeWorkbookGrid {
  filePath: string
  revision: string
  sessionId?: string
  sessionRevision?: number
  dirty?: boolean
  pendingCount?: number
  sheets: OfficeSheetGrid[]
}

export interface OfficeSheetCellChange {
  sheet: string
  cell: string
  value?: string | number | boolean | null
  formula?: string
  contentChanged?: boolean
  style?: OfficeSheetCellStyle
}

export type OfficeWorkbookOperationAction =
  | 'insertRows'
  | 'insertColumns'
  | 'mergeCells'
  | 'unmergeCells'
  | 'addFilter'
  | 'sortRange'
  | 'addConditionalFormatting'
  | 'addValidation'
  | 'addTable'
  | 'addHyperlink'
  | 'addPicture'
  | 'addChart'
  | 'addSparkline'
  | 'addShape'
  | 'addPivotTable'
  | 'addNamedRange'
  | 'groupRows'
  | 'groupColumns'
  | 'setRowHeight'
  | 'setColumnWidth'
  | 'setFreeze'
  | 'setZoom'
  | 'setCalculationMode'

export interface OfficeWorkbookOperation {
  action: OfficeWorkbookOperationAction
  sheet?: string
  range?: string
  target?: string
  name?: string
  value?: string
  secondaryValue?: string
  mode?: string
  direction?: 'asc' | 'desc'
  index?: number
  count?: number
  size?: number
  options?: Record<string, string | number | boolean>
}

export interface OfficeEditResult {
  document: OfficeDocumentState
  message: string
  matched?: number
  cell?: OfficeSheetCell
  saved?: number
}

export interface OfficeSessionResult {
  filePath: string
  sessionId: string
  revision: number
  dirty: boolean
  pendingCount: number
  changed?: number
  saved?: number
  savedAt?: string
  bytesWritten?: number
  contentHash?: string
  document?: OfficeDocumentState
  message: string
}

export interface OfficeSessionEvent {
  filePath: string
  sessionId: string
  revision: number
  kind: 'changed' | 'saved' | 'discarded'
  source: 'editor' | 'agent' | 'system'
  sourceClientId?: string
  dirty: boolean
  pendingCount: number
  changes?: OfficeSheetCellChange[]
  operations?: Array<OfficeWorkbookOperation | OfficeWordOperation>
}

export interface SkillEditorInput {
  id?: string
  name: string
  description: string
  version: string
  repositoryUrl: string
  content: string
  enabled: boolean
  assignedBotIds: string[]
}

export interface SkillImportResult {
  canceled: boolean
  importedSkillName?: string
  workspace: WorkspaceSnapshot
}

export interface SkillMaintenanceResult {
  command: RuntimeCommandResult
  results: SkillUpdateResult[]
  summary: SkillMaintenanceSummary
  workspace: WorkspaceSnapshot
}

export interface SkillMaintenanceSummary {
  totalSkills: number
  checkedCount: number
  skippedCount: number
  runtimeManagedCount: number
  manualCount: number
  availableCount: number
  failureCount: number
  completedAt: string
}

export interface SkillUpdateResult {
  id: string
  name: string
  currentVersion?: string
  latestVersion?: string
  updateAvailable?: boolean
  updated?: boolean
  skipped?: boolean
  updateMode?: 'runtime' | 'registry' | 'manual'
  official?: boolean
  releaseUrl?: string
  error?: string
}

export interface ConfigurationTransferResult {
  canceled: boolean
  filePath?: string
  message: string
  counts?: Record<string, number>
  workspace?: WorkspaceSnapshot
}

export interface ScheduledTask {
  id: string
  name: string
  frequency: ScheduledTaskFrequency
  timeOfDay: string
  weekday: number
  dayOfMonth: number
  cronExpression: string
  modelProvider: ModelProvider
  model: string
  prompt: string
  memoryEnabled: boolean
  memorySummary: string
  memorySummaryUpdatedAt: string | null
  memorySummaryRunCount: number
  skillIds: string[]
  deliveryTarget: 'local'
  repeatCount: number
  runCount: number
  enabled: boolean
  /** 是否在总览页展示（定时任务面板里可逐个开关） */
  showOnOverview: boolean
  /** 归属哪个 Bot（空字符串 = AI 对话空间）；Bot 页面的定时任务板块按它筛选 */
  ownerBotId: string
  status: ScheduledTaskStatus
  workspacePath: string
  nextRunAt: string | null
  lastRunAt: string | null
  createdAt: string
  updatedAt: string
}

export interface ScheduledTaskInput {
  name: string
  frequency: ScheduledTaskFrequency
  timeOfDay: string
  weekday: number
  dayOfMonth: number
  cronExpression: string
  modelProvider: ModelProvider
  model: string
  prompt: string
  memoryEnabled: boolean
  skillIds: string[]
  deliveryTarget: 'local'
  repeatCount: number
  enabled: boolean
  workspacePath: string
  /** 归属哪个 Bot（空 = AI 对话空间） */
  ownerBotId?: string
}

export interface ScheduledTaskRun {
  id: string
  taskId: string
  taskName: string
  status: ScheduledTaskRunStatus
  startedAt: string
  finishedAt: string | null
  durationMs: number | null
  conversationId: string | null
  modelProvider: ModelProvider | ''
  model: string
  output: string
  error: string
}

export interface Activity {
  id: string
  botId: string
  type: 'message' | 'memory' | 'tool' | 'system'
  title: string
  detail: string
  time: string
  createdAt: string
  metadata?: Record<string, string>
}

export interface ChatMessageRecord {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  reasoning: string
  agentSteps: AgentLoopStep[]
  toolEvents: ChatToolEvent[]
  attachments: ChatAttachment[]
  externalMessageId: string
  modelProvider: ModelProvider | ''
  model: string
  durationMs: number | null
  outputTokens: number | null
  createdAt: string
}

export interface ChatAttachment {
  id: string
  name: string
  path?: string
  workspaceRelativePath?: string
  size: number
  mimeType: string
  kind: 'image' | 'file'
}

export interface ChatUsage {
  contextUsed: number
  contextMax: number
  contextPercent: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
}

export interface Conversation {
  id: string
  botId: string
  kind: 'bot' | 'native'
  title: string
  channelId: ConversationChannelId
  externalThreadId: string
  runtimeEngine: 'zsense-core' | 'legacy' | ''
  runtimeSessionId: string
  modelProvider: ModelProvider | ''
  model: string
  reasoningEffort: ReasoningEffort
  workspacePath: string
  usage?: ChatUsage
  createdAt: string
  updatedAt: string
  messageCount: number
  archived: boolean
  /** 手动拖拽排序后的位置（0 表示还没手动排过，按最近更新排在最前） */
  sortOrder: number
  /** 所属对话分组 ID，空字符串表示未分组 */
  groupId: string
  messages: ChatMessageRecord[]
}

/** 对话分组：把若干会话收在一起、可折叠收纳；同一对话空间内各自独立 */
export interface ConversationGroup {
  id: string
  botId: string
  name: string
  sortOrder: number
  collapsed: boolean
  createdAt: string
}

export type SessionProgressStatus = 'running' | 'complete' | 'failed' | 'cancelled'

export interface SessionProgressItem {
  requestId: string
  conversationId?: string
  botId?: string
  kind: 'bot' | 'native'
  title: string
  status: SessionProgressStatus
  detail: string
  startedAt: string
  updatedAt: string
  read: boolean
}

export interface ChatToolEvent {
  type?: 'tool'
  toolId: string
  name: string
  status: 'running' | 'complete' | 'error'
  step?: number
  detail?: string
  input?: string
  output?: string
  durationMs?: number
}

export interface AgentLoopStep {
  step: number
  status: 'running' | 'complete' | 'error'
  outcome: 'thinking' | 'tool_calls' | 'final_answer' | 'steered' | 'stalled' | 'error'
  reasoning: string
  content: string
  tools: ChatToolEvent[]
  startedAt: string
  durationMs?: number
  toolCallCount?: number
  error?: string
}


export interface ChatClarificationQuestion {
  questionId: string
  question: string
  choices: string[]
  multiSelect: boolean
}

export interface ChatClarification {
  requestId: string
  kind?: 'clarification' | 'approval'
  approvalCategory?: string
  approvalLabel?: string
  /** 自动审批为什么没有直接放行：disabled=没开启 / unavailable=这次没给出判断 / denied=模型要求人工确认 */
  approvalAutoState?: string
  approvalAutoReason?: string
  questions: ChatClarificationQuestion[]
  lockedAnswers: Record<string, string>
}

export interface ChatClarificationAnswer {
  questionId?: string
  answer: string
}

export type ChatStreamEvent =
  | { requestId: string; conversationId: string; type: 'conversation-ready' }
  | { requestId: string; conversationId: string; type: 'started'; sessionId: string; runtimeSessionId: string }
  | { requestId: string; conversationId: string; type: 'status'; phase: string; message: string }
  | { requestId: string; conversationId: string; type: 'agent-state'; phase: 'preparing' | 'steering' | 'model' | 'tools' | 'finalizing' | 'complete' | 'cancelled' | 'failed'; previousPhase?: string; step: number; revision: number; updatedAt: string; reason?: string; toolCallCount?: number; error?: string }
  | { requestId: string; conversationId: string; type: 'steering'; phase: 'queued' | 'applied'; steeringId: string; content: string; receivedAt: string; source: 'user' | 'agent'; intent: 'adjust' | 'supplement' | 'next'; attachments?: ChatAttachment[]; pendingCount: number }
  | { requestId: string; conversationId: string; type: 'agent-step'; phase: 'started' | 'completed'; step: number; status: AgentLoopStep['status']; outcome: AgentLoopStep['outcome']; reasoning?: string; content?: string; tools?: ChatToolEvent[]; startedAt?: string; durationMs?: number; toolCallCount?: number; error?: string }
  | { requestId: string; conversationId: string; type: 'reasoning'; delta: string; step?: number; summary?: boolean; replace?: boolean }
  | ({ requestId: string; conversationId: string; type: 'tool' } & ChatToolEvent)
  | { requestId: string; conversationId: string; type: 'clarify'; clarification: ChatClarification }
  | { requestId: string; conversationId: string; type: 'clarify-expired'; clarificationRequestId: string }
  | { requestId: string; conversationId: string; type: 'answer'; delta: string; step?: number }
  | { requestId: string; conversationId: string; type: 'usage'; usage: ChatUsage }
  | { requestId: string; conversationId: string; type: 'done'; content: string; reasoning: string; agentSteps?: AgentLoopStep[]; status: string; usage?: ChatUsage }
  | { requestId: string; conversationId: string; type: 'error'; message: string }

export interface ChatRequest {
  requestId: string
  browserSessionId?: string
  botId?: string
  native?: boolean
  message: string
  conversationId?: string
  attachments?: ChatAttachment[]
  modelProvider?: ModelProvider
  model?: string
  reasoningEffort?: ReasoningEffort
  interactionMode?: ChatInteractionMode
  workspacePath?: string
  /** 把这条消息交给另一个 Bot 执行，但会话与回复都留在当前对话里（「/bot <名字> <指令>」） */
  delegateBotId?: string
}

export type ChatInteractionMode = 'text' | 'voice'

export type ResponseLanguage = 'auto' | 'zh-CN' | 'en-US'

export type BrowserOpenTarget = 'zsense' | 'system'
export type BrowserPermissionPolicy = 'ask' | 'allow' | 'block'
export type BrowserScreenshotPolicy = 'always' | 'ask' | 'never'

export interface BrowserHistoryEntry {
  id: string
  url: string
  title: string
  visitedAt: string
}

export interface BrowserDownloadEntry {
  id: string
  url: string
  fileName: string
  savePath: string
  state: 'progressing' | 'completed' | 'cancelled' | 'interrupted'
  receivedBytes: number
  totalBytes: number
  startedAt: string
  completedAt: string
}

export interface BrowserSitePermission {
  origin: string
  camera: BrowserPermissionPolicy
  microphone: BrowserPermissionPolicy
}

export interface BrowserDataState {
  history: BrowserHistoryEntry[]
  downloads: BrowserDownloadEntry[]
  sitePermissions: BrowserSitePermission[]
}

export interface AppSettings {
  /** 首启引导（用户名 → 邮箱验证 → 可选安全锁 → 设备号）是否已完成 */
  onboardingCompleted?: boolean
  firstRunSetupCompleted: boolean
  defaultWorkspacePath: string
  hiddenSidebarBotIds: string[]
  gatewayUrl: string
  updateFeedUrl: string
  strictMemory: boolean
  autoApprovalEnabled: boolean
  autoExtractMemory: boolean
  memoryPeriodicReview: boolean
  memoryReviewInterval: number
  memoryRecallLimit: number
  memoryMaxItems: number
  bindChannelIdentity: boolean
  runWhileLocked: boolean
  appLockEnabled: boolean
  appLockPasswordConfigured: boolean
  computerUseEnabled: boolean
  browserEnabled: boolean
  browserWebLinkTarget: BrowserOpenTarget
  browserLocalUrlTarget: BrowserOpenTarget
  browserShowFullUrl: boolean
  browserScreenshotPolicy: BrowserScreenshotPolicy
  browserDownloadPath: string
  browserAskDownloadLocation: boolean
  browserHistoryAccess: BrowserPermissionPolicy
  browserWebMcpEnabled: boolean
  browserAgentBrowsePermission: BrowserPermissionPolicy
  browserAgentDownloadPermission: BrowserPermissionPolicy
  browserAgentUploadPermission: BrowserPermissionPolicy
  browserFullCdpAccess: boolean
  contextAutoCompression: boolean
  contextCompressionThreshold: number
  contextCompressionTargetRatio: number
  contextCompressionProtectLastN: number
  contextCompressionProtectFirstN: number
  sensitiveDataRedaction: boolean
  streamingResponse: boolean
  compactMode: boolean
  showReasoning: boolean
  showUsage: boolean
  inlineDiff: boolean
  completionSound: boolean
  approvalSound: boolean
  approvalDesktopNotification: boolean
  completionDesktopNotification: boolean
  chatInputHeight: number
  voiceWakeEnabled: boolean
  voiceWakePhrase: string
  voiceWakeSound: boolean
  voiceWakeStartNewConversation: boolean
  voiceWakeSensitivity: number
  voiceWakeConfirmationFrames: number
  voiceConversationEnabled: boolean
  voiceAutoSpeak: boolean
  voiceContinuousConversation: boolean
  voiceTtsVoice: string
  voiceTtsSpeed: number
  responseLanguage: ResponseLanguage
}

export type VoiceWakeState = 'disabled' | 'starting' | 'listening' | 'error' | 'unavailable'

export interface VoiceWakeStatus {
  supported: boolean
  enabled: boolean
  listening: boolean
  state: VoiceWakeState
  phrase: string
  provider: string
  capture: 'local'
  sampleRate: number
  frameLength: number
  sensitivity: number
  confirmationFrames: number
  permission: 'granted' | 'denied' | 'restricted' | 'not-determined' | 'unknown'
  message: string
  checkedAt: string
}

export interface VoiceWakeDetectedEvent {
  phrase: string
  detectedAt: string
}

export type VoiceInteractionState = 'idle' | 'standby' | 'starting' | 'listening' | 'transcribing' | 'thinking' | 'speaking' | 'error'

export interface VoiceInteractionStatus {
  state: VoiceInteractionState
  message: string
  transcript?: string
  targetLabel?: string
}

export interface VoiceChatRequest {
  id: string
  text: string
  interactionMode: 'voice'
}

export interface ComputerUseStatus {
  supported: boolean
  enabled: boolean
  platform: string
  screenCapturePermission: string
  accessibilityPermission: string
  dryRun: boolean
  checkedAt: string
}

export type DeviceLinkPlatform = 'darwin' | 'win32' | 'linux'

export interface DeviceLinkDevice {
  deviceId: string
  name: string
  platform: DeviceLinkPlatform
  platformLabel: string
  address: string
  port: number
  lastSeenAt: string
  paired: boolean
}

export interface DeviceLinkTrustedPeer {
  /** lan = 局域网配对/扫描；remote = 对方从公网用设备号+配对码连进来 */
  source?: 'lan' | 'remote'
  deviceId: string
  name: string
  platform: DeviceLinkPlatform
  platformLabel: string
  address: string
  port: number
  connected: boolean
  online: boolean
  pairedAt: string
  lastSeenAt: string
  access: DeviceLinkPeerAccess
  remoteDeviceId?: string
  cloudPaired?: boolean
  accountDiscovered?: boolean
  connectionMode?: 'lan' | 'cloud' | 'offline'
  identityPublicKey?: string
  tlsFingerprint?: string
}

export interface DeviceLinkPeerAccess {
  allowStatus: boolean
  allowFiles: boolean
  allowTasks: boolean
}

export interface DeviceLinkRemoteActivity {
  bots: number
  onlineBots: number
  conversations: number
  scheduledTasks: number
  runningTasks: number
  skills: number
  memories: number
}

export interface DeviceLinkRemoteStatus {
  device: {
    deviceId: string
    name: string
    platform: DeviceLinkPlatform
    platformLabel: string
  }
  app: {
    version: string
    startedAt: string
    uptimeMs: number
    platform: DeviceLinkPlatform
  }
  activity: DeviceLinkRemoteActivity
  capabilities: {
    agentCore: boolean
    remoteTasks: boolean
    voiceWake: boolean
    gateway: boolean
  }
  access: DeviceLinkPeerAccess
  receivedAt: string
}

export interface DeviceLinkRemoteRunResult {
  output: string
  conversationId: string
  model: string
  modelProvider: string
  reasoningEffort: string
  durationMs: number
  usage: { inputTokens: number; outputTokens: number }
  toolCalls: number
  refusedOperations: number
  startedAt: string
  finishedAt: string
}

export interface UpdateStatus {
  currentVersion: string
  platform: string
}

export interface UpdateCheckResult {
  ok: boolean
  feedUrl?: string
  currentVersion: string
  latestVersion?: string
  updateAvailable?: boolean
  upToDate?: boolean
  downloadUrl?: string
  notes?: string
  publishedAt?: string
  checkedAt?: string
  error?: string
}

export interface WebBridgeSession {
  token: string
  createdAt: string
  expiresAt: string
  remoteAddress: string
  userAgent: string
  lastSeenAt: string
}

export interface WebBridgeStatus {
  supported: boolean
  enabled: boolean
  running: boolean
  port: number
  httpPort?: number
  protocol?: 'https' | 'http'
  certificate?: { subject: string; fingerprint: string; validFrom: string; validTo: string; path: string } | null
  accessCode: string
  urls: string[]
  localUrl?: string
  sessions: WebBridgeSession[]
  error: string
  blockedChannels: string[]
}

export interface DeviceLinkStatus {
  /** 远程连接（公网）状态：与局域网直连、本机安全锁相互独立 */
  remote: {
    enabled: boolean
    running: boolean
    hostname: string
    url: string
    mode: 'token' | 'named'
    tunnelName: string
    tokenConfigured: boolean
    deviceLockEnabled: boolean
    startedAt: string
    /** 由交换中心首次注册时分配并绑定 Ed25519 公钥，地址形如 https://设备号.zsense.space */
    deviceId: string
    identityPublicKey: string
    publicKeyFingerprint: string
    publicUrl: string
    hubUrl: string
    accountVerified: boolean
    sameEmailPeers: { deviceId: string; name: string; url: string; seenAt: string }[]
    upstreamMode: 'auto' | 'local'
    upstream: string
    registeredAt: string
    lastError: string
  }
  supported: boolean
  enabled: boolean
  running: boolean
  error: string
  protocol: string
  version: number
  device: {
    deviceId: string
    name: string
    platform: DeviceLinkPlatform
    platformLabel: string
    addresses: string[]
    port: number
  }
  pairingCode: string
  pairingIdentityCode: string
  pairingCodeExpiresAt: string
  discoveredDevices: DeviceLinkDevice[]
  scanProgress: { scanned: number; total: number } | null
  trustedPeers: DeviceLinkTrustedPeer[]
  security: {
    scope: 'private-network-only'
    encryptedCredentials: boolean
    remoteAgentAccess: boolean
    remoteStatusAccess: boolean
    remoteFileAccess: boolean
    remoteTaskAccess: boolean
  }
}

export interface VoiceSynthesisRequest {
  text: string
  native?: boolean
  botId?: string
  language?: ResponseLanguage
  voice?: string
  speed?: number
}

export interface LocalVoiceOption {
  id: string
  name: string
  language: Exclude<ResponseLanguage, 'auto'>
  gender: 'female' | 'male' | 'custom'
  engine: 'moss-tts-nano'
  local: true
  bundled: boolean
}

export interface LocalVoiceTranscriptionRequest {
  pcmBase64: string
  sampleRate: 16000
  language: ResponseLanguage
  mode: 'conversation' | 'wake' | 'enrollment'
}

export interface LocalVoiceTranscriptionResult {
  transcript: string
  confidence: number
  provider: string
  language: 'zh' | 'en' | 'auto'
  durationMs: number
  offline: true
}

export interface LocalVoiceSpeechResult {
  played: boolean
  cancelled: boolean
  provider: string
  language: Exclude<ResponseLanguage, 'auto'>
  voice: string
  durationMs: number
  offline: true
  audioBase64?: string
  audioMimeType?: 'audio/wav'
}

export interface WorkspaceSnapshot {
  bots: Bot[]
  nativeBot?: Bot
  channels: Channel[]
  gatewayConnections: GatewayConnection[]
  skills: Skill[]
  activities: Activity[]
  conversations: Conversation[]
  conversationGroups: ConversationGroup[]
  scheduledTasks: ScheduledTask[]
  scheduledTaskRuns: ScheduledTaskRun[]
  settings: AppSettings
  modelConfiguration: ModelConfiguration
  savedModelConfigurations: ModelConfiguration[]
  availableModelConfigurations: ModelConfiguration[]
  storagePath?: string
  skillsPath?: string
}

export interface ApprovalGrant {
  id: string
  category: string
  label: string
  workspaceRoot: string
  grantedAt: string
  lastUsedAt: string
}

export interface AgentCapabilitiesStatus {
  toolCount: number
  registeredToolCount: number
  enabledToolCount: number
  toolsets: string[]
  registeredToolsetCount: number
  enabledToolsets: string[]
  enabledToolsetCount: number
  processCount: number
  checkpointCount: number
  mcp: { serverCount: number; enabledCount: number; connectedCount: number; lastVerifiedAt: string }
  autonomy: { goalCount: number; loopCount: number; heartbeatCount: number; activeCount: number }
  approvals: {
    rememberedCount: number
    grants: ApprovalGrant[]
    policy: 'minimal'
    autoApproval?: {
      enabled: boolean
      total: number
      recent: Array<{ id: string; category: string; label: string; question: string; operationKey: string; allow: boolean; reason: string; model: string; modelProvider: string; conversationId: string; botId: string; at: string }>
    }
  }
  computerUse: ComputerUseStatus
  subagents: {
    totalCount: number
    activeCount: number
    queued: number
    running: number
    completed: number
    failed: number
    cancelled: number
    interrupted: number
    maxConcurrent: number
    maxPerTurn: number
    recentTask: { id: string; title: string; status: string; createdAt: string } | null
  }
  refreshedAt: string
}

export type AutonomyTaskKind = 'goal' | 'loop' | 'heartbeat'

export interface AutonomyTask {
  id: string
  kind: AutonomyTaskKind
  scope: string
  conversationId?: string
  workspacePath?: string
  modelProvider?: string
  model?: string
  reasoningEffort?: ReasoningEffort
  name?: string
  objective?: string
  prompt?: string
  successCriteria?: string
  statusNote?: string
  status: 'active' | 'paused' | 'completed' | 'blocked'
  enabled: boolean
  intervalMinutes?: number
  iterationCount?: number
  maxIterations?: number
  nextRunAt?: string
  lastRunAt?: string
  lastDurationMs?: number
  lastOutput?: string
  lastError?: string
  createdAt: string
  updatedAt: string
}

export interface AutonomySnapshot {
  goals: AutonomyTask[]
  loops: AutonomyTask[]
  heartbeats: AutonomyTask[]
}

export interface McpServerConfiguration {
  id: string
  name: string
  transport: 'stdio' | 'http'
  command: string
  args: string[]
  url: string
  enabled: boolean
  oauthConfigured: boolean
  status: 'saved' | 'connected' | 'error'
  toolCount?: number
  error?: string
  builtIn?: boolean
  locked?: boolean
  description?: string
}

export interface McpServerConfigurationInput {
  id: string
  name: string
  transport: 'stdio' | 'http'
  command: string
  args: string[]
  url: string
  enabled: boolean
  oauthToken: string
  clearOAuthToken: boolean
}

export interface McpTestResult {
  id: string
  connected: boolean
  toolCount: number
  tools: Array<{ server: string; name: string; description: string; inputSchema: Record<string, unknown> }>
}

export interface RuntimeStatus {
  runnable: boolean
  version: string | null
  status: 'ready' | 'broken' | 'missing' | 'initializing' | 'browser'
  message: string
  checkedAt: string
  scope: 'isolated' | 'browser'
  agentDataPath: string | null
  gatewayDataPath: string | null
  managedByApp: boolean
  managedGatewayCount: number
  lifecycle: 'running' | 'idle' | 'stopped' | 'unavailable'
  lastGatewayError: string | null
  gatewayMonitorEnabled: boolean
  gatewayHealthCheckIntervalSeconds: number
  lastGatewayHealthCheckAt: string | null
  gatewayHealthyCount: number
  gatewayExpectedCount: number
  gatewayRecoveryCount: number
  agentEngine?: 'zsense-core'
  agentCoreReady?: boolean
  agentCoreVersion?: string | null
  gatewayEngine?: 'zsense-native'
  voiceEngine?: 'zsense-native'
  voiceSupported?: boolean
  voiceProvider?: string
  wakePhrase?: string
  capabilities?: AgentCapabilitiesStatus | null
}

export interface RuntimeCommandResult {
  ok: boolean
  output: string
  exitCode: number | null
  durationMs: number
  status?: RuntimeStatus
}

export interface ChatResult {
  conversationId: string
  message: string
  attachments: ChatAttachment[]
  modelProvider: ModelProvider | ''
  model: string
  durationMs: number
  agentSteps?: AgentLoopStep[]
  usage?: ChatUsage
  workspace: WorkspaceSnapshot
}

export interface DesktopResult<T> {
  ok: boolean
  data?: T
  error?: string
}
