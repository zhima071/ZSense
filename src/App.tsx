import { AlertTriangle, Bell, CheckCircle2, LoaderCircle, Menu, PanelLeftOpen, Search, X } from 'lucide-react'
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import brandLogo from './assets/zsense-brand.png'
import { activities as fallbackActivities, initialBots, initialChannels, initialGatewayConnections, initialModelConfiguration, initialSavedModelConfigurations, initialSkills } from './data'
import { Overview } from './components/Overview'
import { Sidebar } from './components/Sidebar'
import { SessionProgressCenter, latestSessionItems } from './components/SessionProgressCenter'
import { VoiceInteractionStatus } from './components/VoiceInteractionStatus'
import { VoiceWakeToggle } from './components/VoiceWakeToggle'
import { DisplaySettingsProvider, defaultDisplaySettings } from './components/DisplaySettingsContext'
import type { SettingsSection } from './components/SystemPages'
import { AppLockScreen } from './components/AppLockScreen'
import { errorMessage, isDesktopApp, unwrapDesktop } from './services/desktop'
import { startVoiceBargeInCapture, startVoiceTextCapture, startVoiceWakeCapture, voiceTextRecognitionSupported, type VoiceBargeInCaptureHandle, type VoiceTextCaptureHandle, type VoiceWakeCaptureHandle } from './services/voice-wake'
import { createLocalSpeechStream, stopLocalSpeech, type LocalSpeechStream } from './services/local-speech'
import { VOICE_LANGUAGE } from './services/voice-language'
import type { Activity, AppSettings, AuthStatus, Bot, Channel, ChatAttachment, ChatClarificationAnswer, ChatResult, ChatStreamEvent, Conversation, ConversationGroup, DwsAuthStatus, GatewayAuthorizedUser, GatewayConnection, GatewayConnectionConfigurationInput, GatewayPairingRequest, MemoryItem, ModelCatalog, ModelCatalogRequest, ModelConfiguration, ModelConfigurationInput, ModelProvider, ReasoningEffort, RuntimeStatus, ScheduledTask, ScheduledTaskInput, ScheduledTaskRun, SessionProgressItem, Skill, SkillEditorInput, SkillMaintenanceResult, ViewId, VoiceChatRequest, VoiceInteractionStatus as VoiceInteractionStatusValue, VoiceWakeStatus, WeixinQrLoginStatus, WorkspaceSnapshot } from './types'

// 默认首屏只需要总览与导航。聊天、设置、技能、任务和 Bot 工作区按第一次进入时加载，
// 避免启动就解析整个应用（尤其 Markdown、网关设置和编辑器外壳）。
const BotWorkspace = lazy(() => import('./components/BotWorkspace').then((module) => ({ default: module.BotWorkspace })))
const BotsPage = lazy(() => import('./components/BotsPage').then((module) => ({ default: module.BotsPage })))
const ChatDialog = lazy(() => import('./components/ChatDialog').then((module) => ({ default: module.ChatDialog })))
const CreateBotDialog = lazy(() => import('./components/CreateBotDialog').then((module) => ({ default: module.CreateBotDialog })))
const DwsAuthSetupDialog = lazy(() => import('./components/DwsAuthSetupDialog').then((module) => ({ default: module.DwsAuthSetupDialog })))
const FirstRunSetup = lazy(() => import('./components/FirstRunSetup').then((module) => ({ default: module.FirstRunSetup })))
const OnboardingFlow = lazy(() => import('./components/OnboardingFlow').then((module) => ({ default: module.OnboardingFlow })))
const SkillsPage = lazy(() => import('./components/SkillsPage').then((module) => ({ default: module.SkillsPage })))
const ModelPage = lazy(() => import('./components/ModelPage').then((module) => ({ default: module.ModelPage })))
const NativeChatPage = lazy(() => import('./components/NativeChatPage').then((module) => ({ default: module.NativeChatPage })))
const ScheduledTasksPage = lazy(() => import('./components/ScheduledTasksPage').then((module) => ({ default: module.ScheduledTasksPage })))
const OfficeTasksPage = lazy(() => import('./components/OfficeTasksPage').then((module) => ({ default: module.OfficeTasksPage })))
const loadSystemPages = () => import('./components/SystemPages')
const ActivityPage = lazy(() => loadSystemPages().then((module) => ({ default: module.ActivityPage })))
const GlobalMemoryPage = lazy(() => loadSystemPages().then((module) => ({ default: module.GlobalMemoryPage })))
const SettingsPage = lazy(() => loadSystemPages().then((module) => ({ default: module.SettingsPage })))

function LazyPageFallback({ label = '正在打开页面…' }: { label?: string }) {
  return <div className="app-loading route-loading"><LoaderCircle className="spin" size={21} /><strong>{label}</strong></div>
}

const BOT_STORAGE_KEY = 'zsense-bots-v2'
const CHANNEL_STORAGE_KEY = 'zsense-channels-v2'
const GATEWAY_CONNECTION_STORAGE_KEY = 'zsense-gateway-connections-v3'
const SKILL_STORAGE_KEY = 'zsense-skills-v2'
const SETTINGS_STORAGE_KEY = 'zsense-settings-v2'
const MODEL_STORAGE_KEY = 'zsense-model-v2'
const SAVED_MODELS_STORAGE_KEY = 'zsense-saved-models-v1'
const SIDEBAR_COLLAPSED_STORAGE_KEY = 'zsense-sidebar-collapsed-v1'
const NATIVE_BOT_ID = '__zsense_native__'

const defaultSettings: AppSettings = {
  // 默认按「已设置过」处理：启动时数据还没到位（或读取失败）也绝不弹首次启动向导
  firstRunSetupCompleted: true,
  defaultWorkspacePath: '',
  hiddenSidebarBotIds: [],
  gatewayUrl: 'http://127.0.0.1:9119',
  updateFeedUrl: '',
  strictMemory: true,
  autoApprovalEnabled: false,
  autoExtractMemory: true,
  memoryPeriodicReview: true,
  memoryReviewInterval: 10,
  memoryRecallLimit: 24,
  memoryMaxItems: 500,
  bindChannelIdentity: true,
  runWhileLocked: false,
  appLockEnabled: false,
  appLockPasswordConfigured: false,
  computerUseEnabled: false,
  browserEnabled: true,
  browserWebLinkTarget: 'system',
  browserLocalUrlTarget: 'zsense',
  browserShowFullUrl: false,
  browserScreenshotPolicy: 'always',
  browserDownloadPath: '',
  browserAskDownloadLocation: false,
  browserHistoryAccess: 'ask',
  browserWebMcpEnabled: true,
  browserAgentBrowsePermission: 'ask',
  browserAgentDownloadPermission: 'ask',
  browserAgentUploadPermission: 'ask',
  browserFullCdpAccess: false,
  contextAutoCompression: true,
  contextCompressionThreshold: 0.5,
  contextCompressionTargetRatio: 0.2,
  contextCompressionProtectLastN: 20,
  contextCompressionProtectFirstN: 3,
  sensitiveDataRedaction: true,
  voiceWakeEnabled: false,
  voiceWakePhrase: '你好 ZSense',
  voiceWakeSound: true,
  voiceWakeStartNewConversation: true,
  voiceWakeSensitivity: 0.3,
  voiceWakeConfirmationFrames: 1,
  voiceConversationEnabled: true,
  voiceAutoSpeak: true,
  voiceContinuousConversation: true,
  voiceTtsVoice: 'Xiaoyu',
  voiceTtsSpeed: 1,
  responseLanguage: 'zh-CN',
  ...defaultDisplaySettings,
}

const browserVoiceWakeStatus: VoiceWakeStatus = {
  supported: false,
  enabled: false,
  listening: false,
  state: 'unavailable',
  phrase: '你好 ZSense',
  provider: 'whisper.cpp base 多语言模型 · 完全本地',
  capture: 'local',
  sampleRate: 16_000,
  frameLength: 0,
  sensitivity: 0.3,
  confirmationFrames: 1,
  permission: 'unknown',
  message: '语音唤醒只在 ZSense 桌面端中可用。',
  checkedAt: new Date().toISOString(),
}

const browserRuntime: RuntimeStatus = {
  runnable: false, version: null,
  status: 'browser', message: '浏览器预览不提供本机 Agent、文件与消息网关能力，请运行桌面端。',
  checkedAt: new Date().toISOString(),
  scope: 'browser', agentDataPath: null, gatewayDataPath: null,
  managedByApp: false, managedGatewayCount: 0, lifecycle: 'unavailable', lastGatewayError: null,
  gatewayMonitorEnabled: false, gatewayHealthCheckIntervalSeconds: 30,
  lastGatewayHealthCheckAt: null, gatewayHealthyCount: 0, gatewayExpectedCount: 0, gatewayRecoveryCount: 0,
}

const browserAuthStatus: AuthStatus = {
  setupRequired: false,
  authenticated: true,
  locked: false,
  user: {
    id: 'browser-preview', username: 'preview', displayName: '预览用户', role: 'admin', enabled: true,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastLoginAt: null,
  },
}

const checkingDwsAuthStatus: DwsAuthStatus = {
  available: true,
  authenticated: true,
  state: 'active',
  message: 'dws 将在首次使用钉钉能力时检查登录状态。',
  checkedAt: new Date().toISOString(),
}

const browserNativeBot: Bot = {
  id: NATIVE_BOT_ID,
  name: 'AI 对话',
  initials: 'AI',
  role: 'ZSense 工作台助手',
  description: '使用独立 SQLite 记忆分区的 ZSense Agent Core 对话空间。',
  status: 'online',
  color: '#2563eb',
  modelProvider: '',
  model: '',
  memoryCount: 0,
  memorySize: '0 KB',
  channels: ['web'],
  lastActive: '尚未运行',
  conversations: 0,
  successRate: 100,
  prompt: '只基于当前 ZSense 工作区状态回答，并使用 AI 对话的独立记忆。',
  memories: [],
}

const settingsViewSections: Partial<Record<ViewId, SettingsSection>> = {
  models: 'models',
  skills: 'skills',
  memory: 'memory',
  activity: 'activity',
}

function readStorage<T>(key: string, fallback: T): T {
  try {
    const stored = localStorage.getItem(key)
    return stored ? JSON.parse(stored) as T : fallback
  } catch {
    return fallback
  }
}

function getStoredChannels(): Channel[] {
  const stored = readStorage<Channel[]>(CHANNEL_STORAGE_KEY, initialChannels)
  return initialChannels.map((fallback) => ({ ...fallback, ...stored.find((channel) => channel.id === fallback.id) }))
}

function getStoredSkills(): Skill[] {
  const stored = readStorage<Skill[]>(SKILL_STORAGE_KEY, initialSkills)
  const botIds = getStoredBots().map((bot) => bot.id)
  const compatible = stored.filter((skill) => typeof skill.content === 'string' && typeof skill.builtIn === 'boolean' && typeof skill.fileCount === 'number').map((skill) => ({
    ...skill,
    editable: true,
    assignedBotIds: Array.isArray(skill.assignedBotIds) ? skill.assignedBotIds.filter((id) => botIds.includes(id)) : botIds,
  }))
  const defaults = initialSkills.map((fallback) => ({ ...fallback, ...compatible.find((skill) => skill.id === fallback.id), editable: true }))
  const defaultIds = new Set(initialSkills.map((skill) => skill.id))
  return [...defaults, ...compatible.filter((skill) => !defaultIds.has(skill.id))].map((skill) => ({ ...skill, editable: true }))
}

function getStoredBots(): Bot[] {
  const connections = readStorage<GatewayConnection[]>(GATEWAY_CONNECTION_STORAGE_KEY, initialGatewayConnections)
  return readStorage<Bot[]>(BOT_STORAGE_KEY, initialBots).map((bot) => ({
    ...bot,
    modelProvider: bot.modelProvider || '',
    model: bot.model,
    channels: ['web', ...connections.filter((item) => item.botId === bot.id).map((item) => item.provider)].filter((id, index, values) => values.indexOf(id) === index) as Bot['channels'],
  }))
}

function getStoredModelConfiguration(): ModelConfiguration {
  return readStorage<ModelConfiguration>(MODEL_STORAGE_KEY, initialModelConfiguration)
}

function getStoredSettings(): AppSettings {
  return { ...defaultSettings, ...readStorage<Partial<AppSettings>>(SETTINGS_STORAGE_KEY, {}) }
}

type Notice = { tone: 'success' | 'error'; message: string } | null
type VoiceTarget = { kind: 'native'; newConversation?: boolean } | { kind: 'bot'; botId: string }
type VoiceOperation = { generation: number; target: VoiceTarget | null; requestId: string }
const STARTUP_ANIMATION_MS = 2_500 // CSS 入场动画 2.4 秒，额外留 100ms 给最后一帧

export default function App() {
  const [authStatus, setAuthStatus] = useState<AuthStatus | null>(() => isDesktopApp ? null : browserAuthStatus)
  const [bots, setBots] = useState<Bot[]>(() => isDesktopApp ? [] : getStoredBots())
  const [nativeBot, setNativeBot] = useState<Bot>(() => browserNativeBot)
  const [channels, setChannels] = useState<Channel[]>(() => isDesktopApp ? [] : getStoredChannels())
  const [gatewayConnections, setGatewayConnections] = useState<GatewayConnection[]>(() => isDesktopApp ? [] : readStorage(GATEWAY_CONNECTION_STORAGE_KEY, initialGatewayConnections))
  const [skills, setSkills] = useState<Skill[]>(() => isDesktopApp ? [] : getStoredSkills())
  const [activityItems, setActivityItems] = useState<Activity[]>(isDesktopApp ? [] : fallbackActivities)
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [conversationGroups, setConversationGroups] = useState<ConversationGroup[]>([])
  const [scheduledTasks, setScheduledTasks] = useState<ScheduledTask[]>([])
  const [scheduledTaskRuns, setScheduledTaskRuns] = useState<ScheduledTaskRun[]>([])
  const [settings, setSettings] = useState<AppSettings>(() => isDesktopApp ? defaultSettings : getStoredSettings())
  const [modelConfiguration, setModelConfiguration] = useState<ModelConfiguration>(() => isDesktopApp ? initialModelConfiguration : getStoredModelConfiguration())
  // 启动数据（设置 + 全局模型）是否已从主进程读完；读完之前不做任何首次启动判断
  const [bootstrapped, setBootstrapped] = useState(false)
  // 启动过程出错时记录原因，界面显示可重试的错误页，而不是渲染成空数据
  const [bootError, setBootError] = useState('')
  const [savedModelConfigurations, setSavedModelConfigurations] = useState<ModelConfiguration[]>(() => isDesktopApp ? [] : readStorage(SAVED_MODELS_STORAGE_KEY, initialSavedModelConfigurations))
  const [availableModelConfigurations, setAvailableModelConfigurations] = useState<ModelConfiguration[]>(() => isDesktopApp ? [] : readStorage(SAVED_MODELS_STORAGE_KEY, initialSavedModelConfigurations))
  const [storagePath, setStoragePath] = useState<string | undefined>()
  const [skillsPath, setSkillsPath] = useState<string | undefined>(() => isDesktopApp ? undefined : 'ZSense Preview/skills')
  const [runtime, setRuntime] = useState<RuntimeStatus>(browserRuntime)
  const [dwsAuthStatus, setDwsAuthStatus] = useState<DwsAuthStatus>(checkingDwsAuthStatus)
  const [dwsAuthDismissed, setDwsAuthDismissed] = useState(true)
  const coreReady = runtime.agentCoreReady ?? runtime.runnable
  const [voiceWakeStatus, setVoiceWakeStatus] = useState<VoiceWakeStatus>(browserVoiceWakeStatus)
  const [voiceWakeSuspended, setVoiceWakeSuspended] = useState(false)
  const [voiceInteraction, setVoiceInteraction] = useState<VoiceInteractionStatusValue>({ state: 'idle', message: '点击开始语音交流。' })
  const [voiceWakeBusy, setVoiceWakeBusy] = useState(false)
  const [nativeVoiceRequest, setNativeVoiceRequest] = useState<VoiceChatRequest>()
  const [botVoiceRequest, setBotVoiceRequest] = useState<VoiceChatRequest>()
  const [loading, setLoading] = useState(isDesktopApp)
  const [startupAnimationFinished, setStartupAnimationFinished] = useState(() => !isDesktopApp || window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  const [notice, setNotice] = useState<Notice>(null)
  const [activeView, setActiveView] = useState<ViewId>('overview')
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('runtime')
  const [activeBotId, setActiveBotId] = useState<string | null>(null)
  const [activeNativeConversationId, setActiveNativeConversationId] = useState<string | undefined>()
  const [nativeChatResetToken, setNativeChatResetToken] = useState(0)
  const [chatTarget, setChatTarget] = useState<{ botId: string; conversationId?: string } | null>(null)
  // 从总览卡片的详情面板点「编辑任务」时，跳到定时任务页并打开这个任务的表单
  const [pendingEditTaskId, setPendingEditTaskId] = useState('')
  /** 从 Bot 页面新建任务时，把任务归属预置为这个 Bot */
  const [pendingTaskOwnerId, setPendingTaskOwnerId] = useState('')
  const createScheduledTaskWithOwner = (input: Parameters<typeof createScheduledTask>[0]) => {
    const ownerBotId = pendingTaskOwnerId
    setPendingTaskOwnerId('')
    return createScheduledTask({ ...input, ownerBotId })
  }
  const [sessionProgressItems, setSessionProgressItems] = useState<SessionProgressItem[]>([])
  const [nativeChatDraftRequest, setNativeChatDraftRequest] = useState<{ id: string; text: string; submit?: boolean }>()
  const [sessionCenterOpen, setSessionCenterOpen] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try {
      return window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === 'true'
    } catch {
      return false
    }
  })
  const voiceWakeCaptureRef = useRef<VoiceWakeCaptureHandle | null>(null)
  const voiceConversationCaptureRef = useRef<VoiceTextCaptureHandle | null>(null)
  const voiceBargeInCaptureRef = useRef<VoiceBargeInCaptureHandle | null>(null)
  const voiceSpeechStreamRef = useRef<{ requestId: string; stream: LocalSpeechStream } | null>(null)
  const voiceOperationRef = useRef<VoiceOperation>({ generation: 0, target: null, requestId: '' })
  const voiceStartRef = useRef<(target?: VoiceTarget) => void>(() => undefined)

  useEffect(() => {
    if (startupAnimationFinished) return undefined
    const timer = window.setTimeout(() => setStartupAnimationFinished(true), STARTUP_ANIMATION_MS)
    return () => window.clearTimeout(timer)
  }, [startupAnimationFinished])

  const applySnapshot = useCallback((snapshot: WorkspaceSnapshot) => {
    setBots(snapshot.bots)
    setNativeBot(snapshot.nativeBot || browserNativeBot)
    setChannels(snapshot.channels)
    setGatewayConnections(snapshot.gatewayConnections || [])
    setSkills(snapshot.skills)
    setActivityItems(snapshot.activities)
    setConversations(snapshot.conversations || [])
    setConversationGroups(snapshot.conversationGroups || [])
    setScheduledTasks(snapshot.scheduledTasks || [])
    setScheduledTaskRuns(snapshot.scheduledTaskRuns || [])
    setSettings(snapshot.settings)
    setModelConfiguration(snapshot.modelConfiguration || initialModelConfiguration)
    setBootstrapped(true)
    setSavedModelConfigurations(snapshot.savedModelConfigurations || [])
    setAvailableModelConfigurations(snapshot.availableModelConfigurations || snapshot.savedModelConfigurations || [])
    setStoragePath(snapshot.storagePath)
    setSkillsPath(snapshot.skillsPath)
  }, [])

  const showNotice = useCallback((tone: 'success' | 'error', message: string) => {
    setNotice({ tone, message })
    window.setTimeout(() => setNotice(null), tone === 'error' ? 5_000 : 2_500)
  }, [])

  const refreshRuntime = useCallback(async () => {
    if (!window.zsenseDesktop) return setRuntime(browserRuntime)
    try {
      setRuntime(await unwrapDesktop(window.zsenseDesktop.runtime.inspect()))
    } catch (error) {
      showNotice('error', `ZSense 核心检测失败：${errorMessage(error)}`)
    }
  }, [showNotice])

  // ── 启动流程（全应用唯一入口）────────────────────────────────────────
  // 以前这段逻辑写在挂载 effect 里，而且「未认证/被锁」时直接 return：
  //   1) 安全锁开启时冷启动必然被锁 → 数据一次都不加载；
  //   2) 解锁函数只更新状态、不加载数据 → 解锁后停在空壳界面（0 个会话、默认设置），
  //      看起来就像「数据全没了」，必须手动重载窗口才恢复。
  // 现在收敛成一条路径：等主进程就绪 → 读认证状态 → 需要解锁就交给锁屏 → 否则加载工作台。
  // 解锁成功后走的是同一个 enterWorkspace，不再有第二条分支。
  const enterWorkspace = useCallback(async (status: AuthStatus) => {
    setAuthStatus(status)
    if (!window.zsenseDesktop || !status.authenticated) return
    setLoading(true)
    try {
      const [snapshot, runtimeStatus] = await Promise.all([
        unwrapDesktop(window.zsenseDesktop.data.loadWorkspace()),
        unwrapDesktop(window.zsenseDesktop.runtime.inspect()),
      ])
      applySnapshot(snapshot)
      setRuntime(runtimeStatus)
      setDwsAuthStatus(checkingDwsAuthStatus)
      setDwsAuthDismissed(true)
      setBootError('')
    } catch (error) {
      showNotice('error', `打开工作台失败：${errorMessage(error)}`)
      throw error
    } finally {
      setLoading(false)
    }
  }, [applySnapshot, showNotice])

  const bootstrapWorkspace = useCallback(async () => {
    if (!window.zsenseDesktop) { setBootstrapped(true); setLoading(false); return }
    let status: AuthStatus | null = null
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        status = await unwrapDesktop(window.zsenseDesktop.auth.status())
        break
      } catch (error) {
        // 应用刚起来时主进程可能还没就绪：短暂重试，绝不静默退化成空壳界面
        if (attempt === 7) throw error
        await new Promise((resolve) => window.setTimeout(resolve, 350))
      }
    }
    if (!status) return
    setAuthStatus(status)
    if (!status.authenticated) return
    if (status.locked) return // 锁屏接管；解锁后由 unlockApplication 走同一条加载路径
    await enterWorkspace(status)
  }, [enterWorkspace])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        await bootstrapWorkspace()
      } catch (error) {
        if (!cancelled) {
          setBootError(errorMessage(error))
          showNotice('error', `工作区初始化失败：${errorMessage(error)}`)
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [bootstrapWorkspace, showNotice])

  useEffect(() => window.zsenseDesktop?.runtime.onStatusChanged((status) => setRuntime(status)), [])
  useEffect(() => window.zsenseDesktop?.data.onChanged((snapshot) => applySnapshot(snapshot)), [applySnapshot])

  // 自愈：只要有请求还在跑，就定时从主进程取一次真实快照。
  // 进度项原本只在 chat.send 的 Promise 结束时才收尾；那一次 IPC 回执一旦没回来，
  // 界面就会一直停在「执行中」，必须手动切换会话才刷新（用户报过这个问题）。
  const hasRunningRequest = sessionProgressItems.some((item) => item.status === 'running')
  useEffect(() => {
    if (!hasRunningRequest || !window.zsenseDesktop) return undefined
    let cancelled = false
    const tick = async () => {
      try {
        // 只拉「会话 id + 更新时间」这一小份数据：够判断这一轮是否已结束，
        // 不必每次构建整份工作区快照（那才是内存与 CPU 的主要开销）
        const stamps = await unwrapDesktop(window.zsenseDesktop!.data.conversationTimestamps())
        if (cancelled) return
        const latest = new Map(stamps.map((item) => [item.id, item]))
        setSessionProgressItems((current) => current.map((item) => {
          if (item.status !== 'running' || !item.conversationId) return item
          const updatedAt = Date.parse(latest.get(item.conversationId)?.updatedAt || '')
          const startedAt = Date.parse(item.startedAt || '')
          // 会话时间已经比这次请求更晚 ⇒ 这一轮其实早就结束了，只是界面没收到事件，这里补上
          if (Number.isFinite(updatedAt) && Number.isFinite(startedAt) && updatedAt > startedAt) {
            return { ...item, status: 'complete', detail: '回答已生成', read: false, updatedAt: new Date().toISOString() }
          }
          return item
        }))
      } catch { /* 主进程或网络波动，下个周期再试 */ }
    }
    const timer = window.setInterval(() => void tick(), 3_000)
    void tick()
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [hasRunningRequest, applySnapshot])

  const refreshDwsAuth = useCallback(async () => {
    if (!window.zsenseDesktop) return
    setDwsAuthStatus({ ...checkingDwsAuthStatus, checkedAt: new Date().toISOString() })
    try {
      const status = await unwrapDesktop(window.zsenseDesktop.dws.status())
      setDwsAuthStatus(status)
      if (status.authenticated) {
        setDwsAuthDismissed(false)
        showNotice('success', '钉钉登录状态正常，dws 文件读取已启用')
      }
    } catch (error) {
      setDwsAuthStatus({ available: true, authenticated: false, state: 'error', message: errorMessage(error), checkedAt: new Date().toISOString() })
    }
  }, [showNotice])

  const loginDws = useCallback(async () => {
    if (!window.zsenseDesktop) return
    setDwsAuthStatus((current) => ({ ...current, state: 'authorizing', message: '等待你在钉钉授权页完成登录…', checkedAt: new Date().toISOString() }))
    try {
      const status = await unwrapDesktop(window.zsenseDesktop.dws.login())
      setDwsAuthStatus(status)
      setDwsAuthDismissed(false)
      showNotice('success', '钉钉授权成功，dws 文件读取已启用')
    } catch (error) {
      setDwsAuthStatus({ available: true, authenticated: false, state: 'error', message: errorMessage(error), checkedAt: new Date().toISOString() })
    }
  }, [showNotice])

  useEffect(() => { if (!isDesktopApp) localStorage.setItem(BOT_STORAGE_KEY, JSON.stringify(bots)) }, [bots])
  useEffect(() => { if (!isDesktopApp) localStorage.setItem(CHANNEL_STORAGE_KEY, JSON.stringify(channels)) }, [channels])
  useEffect(() => { if (!isDesktopApp) localStorage.setItem(GATEWAY_CONNECTION_STORAGE_KEY, JSON.stringify(gatewayConnections)) }, [gatewayConnections])
  useEffect(() => { if (!isDesktopApp) localStorage.setItem(SKILL_STORAGE_KEY, JSON.stringify(skills)) }, [skills])
  useEffect(() => { if (!isDesktopApp) localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings)) }, [settings])
  useEffect(() => { if (!isDesktopApp) localStorage.setItem(MODEL_STORAGE_KEY, JSON.stringify(modelConfiguration)) }, [modelConfiguration])
  useEffect(() => { if (!isDesktopApp) localStorage.setItem(SAVED_MODELS_STORAGE_KEY, JSON.stringify(savedModelConfigurations)) }, [savedModelConfigurations])
  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, String(sidebarCollapsed))
    } catch {
      // The layout still works when renderer storage is unavailable.
    }
  }, [sidebarCollapsed])

  const navigate = (view: ViewId) => {
    const settingsSectionForView = settingsViewSections[view]
    if (settingsSectionForView) {
      setSettingsSection(settingsSectionForView)
      setActiveView('settings')
    } else {
      setActiveView(view)
    }
    setActiveBotId(null)
    setMobileOpen(false)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }
  const openBot = (id: string) => {
    setActiveBotId(id)
    setMobileOpen(false)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const openNativeChat = (conversationId?: string) => {
    setActiveNativeConversationId(conversationId)
    setActiveView('chat')
    setActiveBotId(null)
    setMobileOpen(false)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const startNativeChat = () => {
    setActiveNativeConversationId(undefined)
    setNativeChatResetToken((current) => current + 1)
    openNativeChat()
  }

  const stopVoiceInteraction = useCallback((announce = false) => {
    const current = voiceOperationRef.current
    voiceOperationRef.current = { generation: current.generation + 1, target: null, requestId: '' }
    voiceConversationCaptureRef.current?.cancel()
    voiceConversationCaptureRef.current = null
    voiceBargeInCaptureRef.current?.stop()
    voiceBargeInCaptureRef.current = null
    voiceSpeechStreamRef.current?.stream.cancel()
    voiceSpeechStreamRef.current = null
    void stopLocalSpeech().catch(() => undefined)
    if (current.requestId) void window.zsenseDesktop?.chat.cancel(current.requestId).catch(() => undefined)
    setNativeVoiceRequest(undefined)
    setBotVoiceRequest(undefined)
    setVoiceWakeSuspended(false)
    setVoiceInteraction({ state: 'idle', message: settings.voiceWakeEnabled ? '语音交互已停止，正在恢复唤醒词监听。' : '点击开始语音交流。' })
    if (announce) showNotice('success', '语音交互已停止')
  }, [settings.voiceWakeEnabled, showNotice])

  const startVoiceInteraction = useCallback(async (targetOverride?: VoiceTarget) => {
    const desktop = window.zsenseDesktop
    if (!desktop?.voice) {
      setVoiceInteraction({ state: 'error', message: '语音交流只能在 ZSense 桌面端中使用。' })
      return
    }
    if (!coreReady) {
      setVoiceInteraction({ state: 'error', message: 'ZSense Agent Core 当前不可用，请在设置中重新检测。' })
      showNotice('error', '语音交流需要可用的 ZSense Agent Core')
      return
    }

    const target: VoiceTarget = targetOverride || (chatTarget ? { kind: 'bot', botId: chatTarget.botId } : { kind: 'native' })
    const targetBot = target.kind === 'bot' ? bots.find((bot) => bot.id === target.botId) : undefined
    if (target.kind === 'bot' && !targetBot) {
      setVoiceInteraction({ state: 'error', message: '当前 Bot 已不存在，无法开始语音交流。' })
      return
    }
    const targetLabel = target.kind === 'bot' ? targetBot!.name : 'AI 对话'
    const currentConversation = target.kind === 'bot'
      ? conversations.find((conversation) => conversation.id === chatTarget?.conversationId && conversation.botId === target.botId)
      : target.newConversation
        ? undefined
        : conversations.find((conversation) => conversation.id === activeNativeConversationId && conversation.kind === 'native')
    const inheritedWorkspace = conversations.find((conversation) => (
      target.kind === 'bot'
        ? conversation.botId === target.botId
        : conversation.kind === 'native' && conversation.channelId !== 'scheduled'
    ) && Boolean(conversation.workspacePath))?.workspacePath || ''
    const workspacePath = currentConversation?.workspacePath || inheritedWorkspace

    if (target.kind === 'native') {
      if (target.newConversation) {
        setActiveNativeConversationId(undefined)
        setNativeChatResetToken((current) => current + 1)
      }
      setChatTarget(null)
      setActiveView('chat')
      setActiveBotId(null)
      setMobileOpen(false)
    }
    if (!workspacePath) {
      const message = `请先在${targetLabel}的对话输入框中选择工作区，再开始语音交流。`
      voiceOperationRef.current = { generation: voiceOperationRef.current.generation + 1, target: null, requestId: '' }
      setVoiceWakeSuspended(false)
      setVoiceInteraction({ state: 'error', message, targetLabel })
      showNotice('error', message)
      window.setTimeout(() => document.querySelector<HTMLButtonElement>('.chat-workspace-button')?.focus(), 180)
      return
    }

    const generation = voiceOperationRef.current.generation + 1
    voiceOperationRef.current = { generation, target, requestId: '' }
    voiceConversationCaptureRef.current?.cancel()
    voiceConversationCaptureRef.current = null
    voiceBargeInCaptureRef.current?.stop()
    voiceBargeInCaptureRef.current = null
    voiceSpeechStreamRef.current?.stream.cancel()
    voiceSpeechStreamRef.current = null
    void stopLocalSpeech().catch(() => undefined)
    setNativeVoiceRequest(undefined)
    setBotVoiceRequest(undefined)
    setVoiceWakeSuspended(true)
    setVoiceInteraction({ state: 'starting', message: '正在释放唤醒监听并打开麦克风…', targetLabel })

    try {
      voiceWakeCaptureRef.current?.stop()
      voiceWakeCaptureRef.current = null
      if (desktop.voiceWake) await unwrapDesktop(desktop.voiceWake.stop())
      if (voiceOperationRef.current.generation !== generation) return
      if (!voiceTextRecognitionSupported()) throw new Error('当前安装缺少 ZSense 本地 STT 组件，请重新安装包含 Whisper 模型的完整版本。')
      const capture = startVoiceTextCapture({
        language: VOICE_LANGUAGE,
        onInterim: (value) => {
          if (voiceOperationRef.current.generation === generation) {
            const transcribing = value.startsWith('录音完成')
            setVoiceInteraction({ state: transcribing ? 'transcribing' : 'listening', message: transcribing ? value : `正在识别：${value.slice(0, 64)}${value.length > 64 ? '…' : ''}`, transcript: value, targetLabel })
          }
        },
      })
      voiceConversationCaptureRef.current = capture
      setVoiceInteraction({ state: 'listening', message: '请开始说话，停顿后由内置 Whisper 模型在本机转写；录音不会上传。', targetLabel })
      const recognition = await capture.result
      const transcript = recognition.transcript.trim()
      if (voiceOperationRef.current.generation !== generation) return
      voiceConversationCaptureRef.current = null
      if (!transcript) throw new Error('这次录音没有识别到可发送的文字，请点击顶部麦克风重试。')
      const compactTranscript = transcript.replace(/[\s,.，。!！?？_-]+/gu, '')
      if (compactTranscript.length < 2) throw new Error('检测到的语音过短，已为你拦截，没有发送。请再完整说一次。')
      const requestId = crypto.randomUUID()
      voiceOperationRef.current = { generation, target, requestId }
      setVoiceInteraction({ state: 'thinking', message: `已发送：${transcript.slice(0, 72)}${transcript.length > 72 ? '…' : ''}`, transcript, targetLabel })
      const request: VoiceChatRequest = { id: requestId, text: transcript, interactionMode: 'voice' }
      if (target.kind === 'bot') setBotVoiceRequest(request)
      else setNativeVoiceRequest(request)
    } catch (error) {
      if (voiceOperationRef.current.generation !== generation || (error instanceof Error && error.name === 'AbortError')) return
      const message = errorMessage(error)
      voiceConversationCaptureRef.current = null
      voiceOperationRef.current = { generation, target: null, requestId: '' }
      setVoiceWakeSuspended(false)
      setVoiceInteraction({ state: 'error', message, targetLabel })
      showNotice('error', `语音交互失败：${message}`)
    }
  }, [activeNativeConversationId, bots, chatTarget, conversations, coreReady, showNotice])

  voiceStartRef.current = (target?: VoiceTarget) => { void startVoiceInteraction(target) }

  const interruptVoiceInteraction = useCallback(async () => {
    const desktop = window.zsenseDesktop
    const current = voiceOperationRef.current
    if (!desktop?.voice || !current.target) {
      voiceStartRef.current()
      return
    }
    const restartTarget: VoiceTarget = current.target.kind === 'native' ? { kind: 'native' } : current.target
    const generation = current.generation + 1
    voiceOperationRef.current = { generation, target: restartTarget, requestId: '' }
    voiceConversationCaptureRef.current?.cancel()
    voiceConversationCaptureRef.current = null
    voiceBargeInCaptureRef.current?.stop()
    voiceBargeInCaptureRef.current = null
    voiceSpeechStreamRef.current?.stream.cancel()
    voiceSpeechStreamRef.current = null
    setNativeVoiceRequest(undefined)
    setBotVoiceRequest(undefined)
    setVoiceWakeSuspended(true)
    setVoiceInteraction({ state: 'starting', message: '已打断当前回复，正在重新打开麦克风…', targetLabel: voiceInteraction.targetLabel })
    const operations: Promise<unknown>[] = [stopLocalSpeech()]
    if (current.requestId) operations.push(desktop.chat.cancel(current.requestId))
    await Promise.allSettled(operations)
    if (voiceOperationRef.current.generation !== generation) return
    window.setTimeout(() => {
      if (voiceOperationRef.current.generation === generation) voiceStartRef.current(restartTarget)
    }, 120)
  }, [voiceInteraction.targetLabel])

  useEffect(() => {
    voiceBargeInCaptureRef.current?.stop()
    voiceBargeInCaptureRef.current = null
    if ((voiceInteraction.state !== 'thinking' && voiceInteraction.state !== 'speaking') || !voiceOperationRef.current.target) return
    let cancelled = false
    void startVoiceBargeInCapture({
      armDelayMs: voiceInteraction.state === 'speaking' ? 850 : 300,
      echoResistant: voiceInteraction.state === 'speaking',
      onDetected: () => {
        if (cancelled) return
        voiceBargeInCaptureRef.current = null
        void interruptVoiceInteraction()
      },
      onError: () => undefined,
    }).then((capture) => {
      if (cancelled) capture.stop()
      else voiceBargeInCaptureRef.current = capture
    }).catch(() => undefined)
    return () => {
      cancelled = true
      voiceBargeInCaptureRef.current?.stop()
      voiceBargeInCaptureRef.current = null
    }
  }, [interruptVoiceInteraction, voiceInteraction.state])

  const handleVoiceTurnDelta = useCallback((requestId: string, delta: string) => {
    const operation = voiceOperationRef.current
    if (!settings.voiceAutoSpeak || !operation.target || operation.requestId !== requestId || !delta) return
    let activeStream = voiceSpeechStreamRef.current
    if (activeStream?.requestId !== requestId) {
      activeStream?.stream.cancel()
      const { generation, target } = operation
      const targetLabel = target.kind === 'bot' ? bots.find((bot) => bot.id === target.botId)?.name || 'Bot' : 'AI 对话'
      const stream = createLocalSpeechStream({
        native: target.kind === 'native',
        language: VOICE_LANGUAGE,
        voice: settings.voiceTtsVoice,
        speed: settings.voiceTtsSpeed,
        ...(target.kind === 'bot' ? { botId: target.botId } : {}),
      }, () => {
        const current = voiceOperationRef.current
        if (current.generation === generation && current.requestId === requestId) {
          setVoiceInteraction({ state: 'speaking', message: 'ZSense 正在和你说话；你可以直接开口打断。', targetLabel })
        }
      })
      activeStream = { requestId, stream }
      voiceSpeechStreamRef.current = activeStream
    }
    activeStream.stream.push(delta)
  }, [bots, settings.voiceAutoSpeak, settings.voiceTtsSpeed, settings.voiceTtsVoice])

  const handleVoiceTurnCompleted = useCallback(async (requestId: string, responseText: string) => {
    const operation = voiceOperationRef.current
    if (!operation.target || operation.requestId !== requestId) return
    const { generation, target } = operation
    const targetLabel = target.kind === 'bot' ? bots.find((bot) => bot.id === target.botId)?.name || 'Bot' : 'AI 对话'
    setNativeVoiceRequest(undefined)
    setBotVoiceRequest(undefined)
    try {
      if (settings.voiceAutoSpeak && responseText.trim()) {
        let activeStream = voiceSpeechStreamRef.current
        if (activeStream?.requestId !== requestId) {
          activeStream?.stream.cancel()
          const stream = createLocalSpeechStream({
            native: target.kind === 'native',
            language: VOICE_LANGUAGE,
            voice: settings.voiceTtsVoice,
            speed: settings.voiceTtsSpeed,
            ...(target.kind === 'bot' ? { botId: target.botId } : {}),
          }, () => setVoiceInteraction({ state: 'speaking', message: 'ZSense 正在和你说话；你可以直接开口打断。', targetLabel }))
          stream.push(responseText)
          activeStream = { requestId, stream }
          voiceSpeechStreamRef.current = activeStream
        }
        const spoken = await activeStream.stream.finish()
        if (voiceSpeechStreamRef.current?.requestId === requestId) voiceSpeechStreamRef.current = null
        if (voiceOperationRef.current.generation !== generation || voiceOperationRef.current.requestId !== requestId) return
        if (!spoken.played && !spoken.cancelled) throw new Error('系统语音没有完成本地输出。')
      }
      if (voiceOperationRef.current.generation !== generation || voiceOperationRef.current.requestId !== requestId) return
      if (settings.voiceContinuousConversation) {
        voiceOperationRef.current = { generation, target, requestId: '' }
        setVoiceInteraction({ state: 'starting', message: '回复完成，正在等待扬声器尾音结束后继续聆听…', targetLabel })
        window.setTimeout(() => voiceStartRef.current(target.kind === 'native' ? { kind: 'native' } : target), 520)
      } else {
        voiceOperationRef.current = { generation, target: null, requestId: '' }
        setVoiceWakeSuspended(false)
        setVoiceInteraction({ state: 'idle', message: settings.voiceWakeEnabled ? '本轮语音交流已完成，正在恢复唤醒词监听。' : '本轮语音交流已完成。' })
      }
    } catch (error) {
      if (voiceOperationRef.current.generation !== generation) return
      const message = errorMessage(error)
      voiceOperationRef.current = { generation, target: null, requestId: '' }
      setVoiceWakeSuspended(false)
      setVoiceInteraction({ state: 'error', message: `文字回答已保留，但语音输出失败：${message}`, targetLabel })
      showNotice('error', `语音输出失败：${message}`)
    }
  }, [bots, settings.voiceAutoSpeak, settings.voiceContinuousConversation, settings.voiceTtsSpeed, settings.voiceTtsVoice, settings.voiceWakeEnabled, showNotice])

  const handleVoiceTurnFailed = useCallback((requestId: string, reason: string) => {
    const operation = voiceOperationRef.current
    if (operation.requestId !== requestId) return
    if (voiceSpeechStreamRef.current?.requestId === requestId) {
      voiceSpeechStreamRef.current.stream.cancel()
      voiceSpeechStreamRef.current = null
    }
    voiceOperationRef.current = { generation: operation.generation, target: null, requestId: '' }
    setNativeVoiceRequest(undefined)
    setBotVoiceRequest(undefined)
    setVoiceWakeSuspended(false)
    if (reason === '已停止生成。') {
      setVoiceInteraction({ state: 'idle', message: '语音交互已停止。' })
      return
    }
    setVoiceInteraction({ state: 'error', message: reason || 'AI 语音会话失败。' })
    showNotice('error', `语音会话失败：${reason}`)
  }, [showNotice])

  useEffect(() => {
    const voiceWake = window.zsenseDesktop?.voiceWake
    if (!voiceWake || !authStatus?.authenticated) return
    const removeStatusListener = voiceWake.onStatusChanged((status) => {
      setVoiceWakeStatus((current) => ({
        ...status,
        permission: status.permission === 'unknown' ? current.permission : status.permission,
      }))
    })
    void unwrapDesktop(voiceWake.status()).then(setVoiceWakeStatus).catch(() => undefined)
    return () => {
      removeStatusListener()
    }
  }, [authStatus?.authenticated])

  useEffect(() => {
    const voiceWake = window.zsenseDesktop?.voiceWake
    const stopLocalCapture = () => {
      voiceWakeCaptureRef.current?.stop()
      voiceWakeCaptureRef.current = null
    }
    if (!voiceWake || !authStatus?.authenticated) {
      stopLocalCapture()
      return
    }
    if (!settings.voiceWakeEnabled || !coreReady || voiceWakeSuspended) {
      stopLocalCapture()
      void unwrapDesktop(voiceWake.stop()).then(setVoiceWakeStatus).catch(() => undefined)
      return
    }

    let cancelled = false
    const start = async () => {
      stopLocalCapture()
      setVoiceWakeStatus((current) => ({
        ...current,
        supported: true,
        enabled: true,
        listening: false,
        state: 'starting',
        message: '正在请求麦克风权限并启动 ZSense 语音唤醒…',
        checkedAt: new Date().toISOString(),
      }))
      try {
        const permissionResult = await unwrapDesktop(voiceWake.requestPermission())
        if (cancelled) return
        if (permissionResult.permission !== 'granted') {
          throw new Error('麦克风权限未开启，请在系统设置中允许 ZSense 使用麦克风。')
        }
        const status = await unwrapDesktop(voiceWake.start({
          phrase: settings.voiceWakePhrase,
          sensitivity: settings.voiceWakeSensitivity,
          confirmationFrames: settings.voiceWakeConfirmationFrames,
        }))
        if (cancelled) return
        setVoiceWakeStatus({ ...status, permission: permissionResult.permission })
        if (!status.listening) return
        const capture = await startVoiceWakeCapture({
          phrase: status.phrase || settings.voiceWakePhrase,
          language: VOICE_LANGUAGE,
          sensitivity: settings.voiceWakeSensitivity,
          confirmationFrames: settings.voiceWakeConfirmationFrames,
          onDetected: (phrase) => {
            void unwrapDesktop(voiceWake.detected({ phrase })).catch(() => undefined)
            if (settings.voiceConversationEnabled) {
              showNotice('success', `已听到“${phrase}”，正在开始语音交流`)
              voiceStartRef.current({ kind: 'native', newConversation: settings.voiceWakeStartNewConversation })
              return
            }
            if (settings.voiceWakeStartNewConversation) {
              setActiveNativeConversationId(undefined)
              setNativeChatResetToken((current) => current + 1)
            }
            setActiveView('chat')
            setActiveBotId(null)
            setMobileOpen(false)
            showNotice('success', `已听到“${phrase}”，AI 对话已就绪`)
            window.setTimeout(() => document.querySelector<HTMLTextAreaElement>('.native-chat-page textarea')?.focus(), 180)
          },
          onError: (error) => {
            stopLocalCapture()
            void unwrapDesktop(voiceWake.stop()).catch(() => undefined)
            setVoiceWakeStatus((current) => ({
              ...current,
              enabled: true,
              listening: false,
              state: 'error',
              message: `麦克风监听中断：${error.message}`,
              checkedAt: new Date().toISOString(),
            }))
          },
        })
        if (cancelled) capture.stop()
        else voiceWakeCaptureRef.current = capture
      } catch (error) {
        if (cancelled) return
        stopLocalCapture()
        setVoiceWakeStatus((current) => ({
          ...current,
          supported: true,
          enabled: true,
          listening: false,
          state: current.state === 'unavailable' ? 'unavailable' : 'error',
          message: errorMessage(error),
          checkedAt: new Date().toISOString(),
        }))
      }
    }
    void start()
    return () => {
      cancelled = true
      stopLocalCapture()
    }
  }, [authStatus?.authenticated, coreReady, settings.voiceConversationEnabled, settings.voiceWakeConfirmationFrames, settings.voiceWakeEnabled, settings.voiceWakePhrase, settings.voiceWakeSensitivity, settings.voiceWakeStartNewConversation, showNotice, voiceWakeSuspended])

  useEffect(() => {
    if (authStatus?.authenticated) return
    if (voiceOperationRef.current.target) stopVoiceInteraction(false)
  }, [authStatus?.authenticated, stopVoiceInteraction])

  useEffect(() => () => {
    voiceConversationCaptureRef.current?.cancel()
    voiceBargeInCaptureRef.current?.stop()
    void stopLocalSpeech().catch(() => undefined)
  }, [])

  useEffect(() => window.zsenseDesktop?.auth.onLocked((status) => {
    stopVoiceInteraction(false)
    setSessionCenterOpen(false)
    setAuthStatus(status)
  }), [stopVoiceInteraction])

  const lockApplication = useCallback(async () => {
    if (!window.zsenseDesktop || !settings.appLockEnabled) return
    stopVoiceInteraction(false)
    setSessionCenterOpen(false)
    try { setAuthStatus(await unwrapDesktop(window.zsenseDesktop.auth.lock())) }
    catch (error) { showNotice('error', `锁定应用失败：${errorMessage(error)}`) }
  }, [settings.appLockEnabled, showNotice, stopVoiceInteraction])

  const unlockApplication = useCallback(async (password: string) => {
    if (!window.zsenseDesktop) throw new Error('安全锁只在桌面端可用。')
    const status = await unwrapDesktop(window.zsenseDesktop.auth.unlock(password))
    setAuthStatus(status)
    // 解锁后立刻加载工作台（这里以前漏了加载：解锁后停在空壳界面，看起来像数据全丢）
    if (status.authenticated && !status.locked) {
      try {
        await enterWorkspace(status)
      } catch (error) {
        setBootError(errorMessage(error))
      }
    }
    return status
  }, [enterWorkspace])

  // 用邮箱验证码重置安全锁密码：重置成功后按「已解锁」处理，并走与解锁完全相同的加载路径
  const resetApplicationLock = useCallback(async (input: { code: string; password: string }) => {
    if (!window.zsenseDesktop) throw new Error('安全锁只在桌面端可用。')
    const status = await unwrapDesktop(window.zsenseDesktop.auth.resetLockPassword(input))
    setAuthStatus(status)
    if (status.authenticated && !status.locked) {
      try { await enterWorkspace(status) } catch (error) { setBootError(errorMessage(error)) }
    }
    return status
  }, [enterWorkspace])

  const updateSessionProgress = (requestId: string, update: Partial<SessionProgressItem>) => {
    setSessionProgressItems((current) => {
      const index = current.findIndex((item) => item.requestId === requestId)
      // 流式回答每个 token 都会走到这里（'正在生成回答…'）。如果没有任何可见字段变化，
      // 直接返回原数组引用让 React 跳过重渲染，避免一次长回答触发上千次整树渲染。
      if (index >= 0 && !Object.keys(update).some((key) => key !== 'updatedAt' && current[index][key as keyof SessionProgressItem] !== update[key as keyof SessionProgressItem])) return current
      const next = index >= 0
        ? current.map((item, position) => position === index ? { ...item, ...update, updatedAt: update.updatedAt || new Date().toISOString() } : item)
        : current
      return next
    })
  }

  const trackSessionEvent = (event: ChatStreamEvent) => {
    if (event.type === 'started') return updateSessionProgress(event.requestId, { conversationId: event.conversationId, detail: '已连接 ZSense Agent Core，正在准备会话' })
    if (event.type === 'status') return updateSessionProgress(event.requestId, { conversationId: event.conversationId, detail: event.message || 'ZSense Agent Core 正在处理' })
    if (event.type === 'reasoning') return updateSessionProgress(event.requestId, { conversationId: event.conversationId, detail: event.summary ? '推理摘要已生成' : '正在推理…' })
    if (event.type === 'tool') return updateSessionProgress(event.requestId, { conversationId: event.conversationId, detail: event.status === 'running' ? `正在使用 ${event.name}…` : `${event.name} ${event.status === 'complete' ? '已完成' : '执行失败'}` })
    if (event.type === 'clarify') return updateSessionProgress(event.requestId, { conversationId: event.conversationId, detail: '正在等待你的选择…', read: false })
    if (event.type === 'clarify-expired') return updateSessionProgress(event.requestId, { conversationId: event.conversationId, detail: '选择已超时，ZSense 正在继续处理…' })
    if (event.type === 'answer') return updateSessionProgress(event.requestId, { conversationId: event.conversationId, detail: '正在生成回答…' })
    if (event.type === 'done') {
      return updateSessionProgress(event.requestId, { conversationId: event.conversationId, status: 'complete', detail: '回答已生成', read: false })
    }
    if (event.type === 'error') {
      return updateSessionProgress(event.requestId, { conversationId: event.conversationId, status: 'failed', detail: event.message || '会话处理失败', read: false })
    }
  }

  const updateBot = async (next: Bot) => {
    if (!window.zsenseDesktop) return setBots((current) => current.map((bot) => bot.id === next.id ? next : bot))
    try {
      applySnapshot(await unwrapDesktop(window.zsenseDesktop.bots.update(next)))
    } catch (error) {
      showNotice('error', `保存 Bot 失败：${errorMessage(error)}`)
      throw error
    }
  }

  const toggleSidebarBot = async (botId: string) => {
    const hidden = new Set(settings.hiddenSidebarBotIds)
    if (hidden.has(botId)) hidden.delete(botId)
    else hidden.add(botId)
    const next = { ...settings, hiddenSidebarBotIds: [...hidden] }
    const previous = settings
    setSettings(next)
    try {
      if (window.zsenseDesktop) applySnapshot(await unwrapDesktop(window.zsenseDesktop.settings.update(next)))
    } catch (error) {
      setSettings(previous)
      showNotice('error', `保存侧栏 Bot 显示设置失败：${errorMessage(error)}`)
      throw error
    }
  }

  const createBot = async (bot: Bot) => {
    try {
      if (window.zsenseDesktop) applySnapshot(await unwrapDesktop(window.zsenseDesktop.bots.create(bot)))
      else {
        setBots((current) => [...current, bot])
        setSkills((current) => current.map((skill) => skill.essential ? { ...skill, enabled: true, assignedBotIds: [...new Set([...skill.assignedBotIds, bot.id])] } : skill))
      }
      setCreateOpen(false)
      setActiveBotId(bot.id)
      showNotice('success', `${bot.name} 已创建，并拥有独立记忆空间`)
    } catch (error) { showNotice('error', `创建 Bot 失败：${errorMessage(error)}`) }
  }

  const duplicateBot = async (source: Bot) => {
    const duplicateBotId = `bot-copy-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
    try {
      if (window.zsenseDesktop) {
        applySnapshot(await unwrapDesktop(window.zsenseDesktop.bots.duplicate(source.id, duplicateBotId)))
      } else {
        const existingNames = new Set(bots.map((bot) => bot.name))
        let copyNumber = 1
        let duplicateName = `${source.name} 副本`
        while (existingNames.has(duplicateName)) {
          copyNumber += 1
          duplicateName = `${source.name} 副本 ${copyNumber}`
        }
        const duplicate: Bot = {
          ...source,
          id: duplicateBotId,
          name: duplicateName,
          status: 'paused',
          memoryCount: 0,
          memorySize: '0 KB',
          channels: ['web'],
          lastActive: '尚未运行',
          conversations: 0,
          successRate: 100,
          memories: [],
        }
        setBots((current) => [...current, duplicate])
        setSkills((current) => current.map((skill) => skill.assignedBotIds.includes(source.id)
          ? { ...skill, assignedBotIds: [...skill.assignedBotIds, duplicateBotId] }
          : skill))
      }
      setActiveBotId(duplicateBotId)
      showNotice('success', `已复制 ${source.name}；私有记忆、对话与网关凭证未复制`)
    } catch (error) {
      showNotice('error', `复制 Bot 失败：${errorMessage(error)}`)
      throw error
    }
  }

  const deleteBot = async (bot: Bot) => {
    try {
      if (window.zsenseDesktop) applySnapshot(await unwrapDesktop(window.zsenseDesktop.bots.delete(bot.id)))
      else {
        setBots((current) => current.filter((item) => item.id !== bot.id))
        setGatewayConnections((current) => current.filter((connection) => connection.botId !== bot.id))
        setSkills((current) => current.map((skill) => ({ ...skill, assignedBotIds: skill.assignedBotIds.filter((botId) => botId !== bot.id) })))
        setConversations((current) => current.filter((conversation) => conversation.botId !== bot.id))
      }
      navigate('bots')
      showNotice('success', `${bot.name} 已删除`)
    } catch (error) {
      showNotice('error', `删除 Bot 失败：${errorMessage(error)}`)
      throw error
    }
  }

  const addMemory = async (botId: string, memory: MemoryItem) => {
    try {
      if (window.zsenseDesktop) applySnapshot(await unwrapDesktop(window.zsenseDesktop.memories.create(botId, memory)))
      else if (botId === NATIVE_BOT_ID) setNativeBot((current) => ({ ...current, memoryCount: current.memoryCount + 1, memories: [memory, ...current.memories] }))
      else setBots((current) => current.map((bot) => bot.id === botId ? { ...bot, memoryCount: bot.memoryCount + 1, memories: [memory, ...bot.memories] } : bot))
      showNotice('success', '记忆已写入独立空间')
    } catch (error) {
      showNotice('error', `保存记忆失败：${errorMessage(error)}`)
      throw error
    }
  }

  const updateMemory = async (botId: string, memory: MemoryItem) => {
    try {
      if (window.zsenseDesktop) applySnapshot(await unwrapDesktop(window.zsenseDesktop.memories.update(botId, memory)))
      else if (botId === NATIVE_BOT_ID) setNativeBot((current) => ({ ...current, memories: current.memories.map((item) => item.id === memory.id ? memory : item) }))
      else setBots((current) => current.map((bot) => bot.id === botId ? { ...bot, memories: bot.memories.map((item) => item.id === memory.id ? memory : item) } : bot))
      showNotice('success', '记忆已更新')
    } catch (error) {
      showNotice('error', `修改记忆失败：${errorMessage(error)}`)
      throw error
    }
  }

  const deleteMemory = async (botId: string, memoryId: string) => {
    try {
      if (window.zsenseDesktop) applySnapshot(await unwrapDesktop(window.zsenseDesktop.memories.delete(botId, memoryId)))
      else if (botId === NATIVE_BOT_ID) setNativeBot((current) => ({ ...current, memoryCount: Math.max(0, current.memoryCount - 1), memories: current.memories.filter((memory) => memory.id !== memoryId) }))
      else setBots((current) => current.map((bot) => bot.id === botId ? { ...bot, memoryCount: Math.max(0, bot.memoryCount - 1), memories: bot.memories.filter((memory) => memory.id !== memoryId) } : bot))
      showNotice('success', '记忆已删除')
    } catch (error) {
      showNotice('error', `删除记忆失败：${errorMessage(error)}`)
      throw error
    }
  }

  const saveGatewayConnection = async (configuration: GatewayConnectionConfigurationInput) => {
    try {
      if (window.zsenseDesktop) {
        applySnapshot(await unwrapDesktop(window.zsenseDesktop.gatewayConnections.save(configuration)))
        await refreshRuntime()
      } else {
        const existing = gatewayConnections.find((item) => item.id === configuration.id)
        const duplicate = gatewayConnections.find((item) => item.id !== configuration.id && item.botId === configuration.botId && item.provider === configuration.provider)
        if (duplicate) throw new Error('这个 Bot 已经有一个同类型机器人账号。')
        const secretKeys = [...new Set([...(existing?.secretKeys || []).filter((key) => !configuration.clearSecrets.includes(key)), ...Object.keys(configuration.secrets).filter((key) => Boolean(configuration.secrets[key]))])]
        const configured = Boolean(Object.values(configuration.config).some(Boolean) || secretKeys.length)
        const nextConnection: GatewayConnection = {
          id: existing?.id || `preview-${Date.now()}`,
          provider: configuration.provider,
          name: configuration.name,
          botId: configuration.botId,
          profileName: existing?.profileName || `zsense-${configuration.botId.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 24) || 'bot'}`,
          status: configuration.enabled && configured ? 'connected' : configured ? 'paused' : 'setup',
          latency: configuration.enabled && configured ? '预览模式' : '—',
          messages: existing?.messages || 0,
          configured,
          config: configuration.config,
          secretKeys,
          updatedAt: new Date().toISOString(),
        }
        const nextConnections = existing ? gatewayConnections.map((item) => item.id === existing.id ? nextConnection : item) : [nextConnection, ...gatewayConnections]
        setGatewayConnections(nextConnections)
        setBots((current) => current.map((bot) => ({ ...bot, channels: ['web', ...nextConnections.filter((item) => item.botId === bot.id).map((item) => item.provider)].filter((id, index, values) => values.indexOf(id) === index) as Bot['channels'] })))
      }
      showNotice('success', '机器人账号与 Bot 路由已保存')
    } catch (error) {
      showNotice('error', `保存机器人账号失败：${errorMessage(error)}`)
      throw error
    }
  }

  const deleteGatewayConnection = async (connectionId: string) => {
    try {
      if (window.zsenseDesktop) {
        applySnapshot(await unwrapDesktop(window.zsenseDesktop.gatewayConnections.delete(connectionId)))
        await refreshRuntime()
      } else {
        const nextConnections = gatewayConnections.filter((item) => item.id !== connectionId)
        setGatewayConnections(nextConnections)
        setBots((current) => current.map((bot) => ({ ...bot, channels: ['web', ...nextConnections.filter((item) => item.botId === bot.id).map((item) => item.provider)].filter((id, index, values) => values.indexOf(id) === index) as Bot['channels'] })))
      }
      showNotice('success', '机器人账号已删除，凭证路由已解除')
    } catch (error) {
      showNotice('error', `删除机器人账号失败：${errorMessage(error)}`)
      throw error
    }
  }

  const loadGatewayPairings = async (connectionId: string): Promise<GatewayPairingRequest[]> => {
    if (!window.zsenseDesktop) return []
    return unwrapDesktop(window.zsenseDesktop.gatewayConnections.pairings(connectionId))
  }

  const loadGatewayAuthorizedUsers = useCallback(async (connectionId: string): Promise<GatewayAuthorizedUser[]> => {
    if (!window.zsenseDesktop) return []
    return unwrapDesktop(window.zsenseDesktop.gatewayConnections.authorizedUsers(connectionId))
  }, [])

  const approveGatewayPairing = async (connectionId: string, requestId: string): Promise<GatewayPairingRequest[]> => {
    if (!window.zsenseDesktop) throw new Error('用户授权仅在桌面端可用。')
    const result = await unwrapDesktop(window.zsenseDesktop.gatewayConnections.approvePairing(connectionId, requestId))
    applySnapshot(result.workspace)
    showNotice('success', '用户已授权；下一条消息会进入对应 Bot，并同步到 ZSense。')
    return result.pairings
  }

  const startWeixinLogin = useCallback(async (botId: string): Promise<WeixinQrLoginStatus> => {
    if (!window.zsenseDesktop) throw new Error('微信扫码授权仅在 ZSense 桌面应用中可用。')
    return unwrapDesktop(window.zsenseDesktop.gatewayConnections.startWeixinLogin(botId))
  }, [])

  const getWeixinLoginStatus = useCallback(async (loginId: string): Promise<WeixinQrLoginStatus> => {
    if (!window.zsenseDesktop) throw new Error('微信扫码授权仅在 ZSense 桌面应用中可用。')
    return unwrapDesktop(window.zsenseDesktop.gatewayConnections.getWeixinLoginStatus(loginId))
  }, [])

  const cancelWeixinLogin = useCallback(async (loginId: string): Promise<void> => {
    if (!window.zsenseDesktop) return
    await unwrapDesktop(window.zsenseDesktop.gatewayConnections.cancelWeixinLogin(loginId))
  }, [])

  // ── 对话分组与拖拽排序：都走桌面桥，成功后用返回的快照刷新 ──

  const createConversationGroup = async (botId: string, name: string) => {
    if (!window.zsenseDesktop) throw new Error('对话分组只能在 ZSense 桌面端中管理。')
    applySnapshot(await unwrapDesktop(window.zsenseDesktop.conversationGroups.create(botId, name)))
    showNotice('success', `已创建分组「${name}」`)
  }

  const renameConversationGroup = async (groupId: string, name: string) => {
    if (!window.zsenseDesktop) throw new Error('对话分组只能在 ZSense 桌面端中管理。')
    applySnapshot(await unwrapDesktop(window.zsenseDesktop.conversationGroups.rename(groupId, name)))
    showNotice('success', '分组名称已更新')
  }

  const deleteConversationGroup = async (groupId: string) => {
    if (!window.zsenseDesktop) throw new Error('对话分组只能在 ZSense 桌面端中管理。')
    applySnapshot(await unwrapDesktop(window.zsenseDesktop.conversationGroups.delete(groupId)))
    showNotice('success', '分组已删除，组内会话回到未分组')
  }

  const toggleConversationGroup = async (groupId: string, collapsed: boolean) => {
    if (!window.zsenseDesktop) throw new Error('对话分组只能在 ZSense 桌面端中管理。')
    applySnapshot(await unwrapDesktop(window.zsenseDesktop.conversationGroups.setCollapsed(groupId, collapsed)))
  }

  const moveConversationToGroup = async (conversationId: string, groupId: string) => {
    if (!window.zsenseDesktop) throw new Error('对话分组只能在 ZSense 桌面端中管理。')
    applySnapshot(await unwrapDesktop(window.zsenseDesktop.conversations.moveGroup(conversationId, groupId)))
    const group = conversationGroups.find((item) => item.id === groupId)
    showNotice('success', group ? `已移动到「${group.name}」` : '已移出分组')
  }

  const reorderConversations = async (botId: string, orderedIds: string[]) => {
    if (!window.zsenseDesktop) throw new Error('对话排序只能在 ZSense 桌面端中调整。')
    applySnapshot(await unwrapDesktop(window.zsenseDesktop.conversations.reorder(botId, orderedIds)))
  }

  const nativeSpaceId = conversations.find((conversation) => conversation.kind === 'native')?.botId || '__zsense_native__'
  const nativeConversationGroups = conversationGroups.filter((group) => group.botId === nativeSpaceId)

  const renameConversation = async (conversationId: string, title: string) => {
    try {
      if (window.zsenseDesktop) applySnapshot(await unwrapDesktop(window.zsenseDesktop.conversations.rename(conversationId, title)))
      else setConversations((current) => current.map((item) => item.id === conversationId ? { ...item, title, updatedAt: new Date().toISOString() } : item))
      showNotice('success', '对话名称已更新')
    } catch (error) {
      showNotice('error', `重命名对话失败：${errorMessage(error)}`)
      throw error
    }
  }

  const archiveConversation = async (conversationId: string, archived: boolean) => {
    try {
      if (window.zsenseDesktop) applySnapshot(await unwrapDesktop(window.zsenseDesktop.conversations.archive(conversationId, archived)))
      else setConversations((current) => current.map((item) => item.id === conversationId ? { ...item, archived, updatedAt: new Date().toISOString() } : item))
      showNotice('success', archived ? '对话已归档' : '对话已恢复')
    } catch (error) {
      showNotice('error', `${archived ? '归档' : '恢复'}对话失败：${errorMessage(error)}`)
      throw error
    }
  }

  const deleteConversation = async (conversationId: string) => {
    try {
      if (window.zsenseDesktop) applySnapshot(await unwrapDesktop(window.zsenseDesktop.conversations.delete(conversationId)))
      else setConversations((current) => current.filter((item) => item.id !== conversationId))
      if (chatTarget?.conversationId === conversationId) setChatTarget(null)
      setSessionProgressItems((current) => current.filter((item) => item.conversationId !== conversationId))
      showNotice('success', '对话已删除')
    } catch (error) {
      showNotice('error', `删除对话失败：${errorMessage(error)}`)
      throw error
    }
  }

  const deleteConversationMessage = async (conversationId: string, messageId: string) => {
    try {
      if (window.zsenseDesktop) applySnapshot(await unwrapDesktop(window.zsenseDesktop.conversations.deleteMessage(conversationId, messageId)))
      else setConversations((current) => current.map((conversation) => conversation.id === conversationId
        ? { ...conversation, messages: conversation.messages.filter((message) => message.id !== messageId), messageCount: Math.max(0, conversation.messageCount - 1), updatedAt: new Date().toISOString() }
        : conversation))
      showNotice('success', '消息已删除')
    } catch (error) {
      showNotice('error', `删除消息失败：${errorMessage(error)}`)
      throw error
    }
  }

  const archiveNativeConversation = async (conversationId: string, archived: boolean) => {
    await archiveConversation(conversationId, archived)
    if (archived && activeNativeConversationId === conversationId) {
      const nextConversation = conversations.find((item) => item.kind === 'native' && item.channelId !== 'scheduled' && item.id !== conversationId && !item.archived)
      if (nextConversation) openNativeChat(nextConversation.id)
      else navigate('overview')
    }
  }

  const deleteNativeConversation = async (conversationId: string) => {
    await deleteConversation(conversationId)
    if (activeNativeConversationId === conversationId) {
      const nextConversation = conversations.find((item) => item.kind === 'native' && item.channelId !== 'scheduled' && item.id !== conversationId && !item.archived)
      if (nextConversation) openNativeChat(nextConversation.id)
      else navigate('overview')
    }
  }

  const saveModelConfiguration = async (configuration: ModelConfigurationInput) => {
    try {
      if (window.zsenseDesktop) {
        applySnapshot(await unwrapDesktop(window.zsenseDesktop.models.update(configuration)))
      } else {
        const savedConfiguration: ModelConfiguration = {
          provider: configuration.provider,
          model: configuration.model,
          baseUrl: configuration.baseUrl,
          apiKeyName: configuration.apiKeyName,
          apiKeyConfigured: configuration.clearApiKey ? false : Boolean(configuration.apiKey) || (modelConfiguration.provider === configuration.provider && modelConfiguration.apiKeyName === configuration.apiKeyName && modelConfiguration.apiKeyConfigured),
          updatedAt: new Date().toISOString(),
          contextWindow: availableModelConfigurations.find((item) => item.provider === configuration.provider && item.model === configuration.model)?.contextWindow,
        }
        setModelConfiguration(savedConfiguration)
        setSavedModelConfigurations((current) => [savedConfiguration, ...current.filter((item) => item.provider !== savedConfiguration.provider || item.model !== savedConfiguration.model)].map((item) => item.provider === savedConfiguration.provider ? { ...item, apiKeyConfigured: savedConfiguration.apiKeyConfigured, apiKeyName: savedConfiguration.apiKeyName, baseUrl: savedConfiguration.baseUrl } : item))
        setAvailableModelConfigurations((current) => [savedConfiguration, ...current.filter((item) => item.provider !== savedConfiguration.provider || item.model !== savedConfiguration.model)].map((item) => item.provider === savedConfiguration.provider ? { ...item, apiKeyConfigured: savedConfiguration.apiKeyConfigured, apiKeyName: savedConfiguration.apiKeyName, baseUrl: savedConfiguration.baseUrl } : item))
      }
      showNotice('success', 'AI 模型与 API 配置已保存')
    } catch (error) {
      showNotice('error', `保存模型配置失败：${errorMessage(error)}`)
      throw error
    }
  }

  const loadModelCatalog = useCallback(async (request: ModelCatalogRequest): Promise<ModelCatalog> => {
    if (!window.zsenseDesktop) throw new Error('浏览器预览不能安全调用模型官网 API，请运行桌面端获取实时列表。')
    const catalog = await unwrapDesktop(window.zsenseDesktop.models.list(request))
    applySnapshot(await unwrapDesktop(window.zsenseDesktop.data.loadWorkspace()))
    return catalog
  }, [applySnapshot])

  const refreshWorkspace = useCallback(async () => {
    if (!window.zsenseDesktop) return
    applySnapshot(await unwrapDesktop(window.zsenseDesktop.data.loadWorkspace()))
  }, [applySnapshot])

  const createSkill = async (input: SkillEditorInput) => {
    try {
      if (window.zsenseDesktop) {
        applySnapshot(await unwrapDesktop(window.zsenseDesktop.skills.create(input)))
      } else {
        const baseId = input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || `skill-${Date.now()}`
        const existingIds = new Set(skills.map((skill) => skill.id))
        let id = baseId
        let suffix = 2
        while (existingIds.has(id)) id = `${baseId}-${suffix++}`
        const skill: Skill = { ...input, enabled: input.assignedBotIds.length > 0, id, category: '我的技能', source: 'ZSense', updatedAt: new Date().toISOString(), fileCount: 1, installPath: `ZSense Preview/skills/zsense-custom/${id}`, editable: true, builtIn: false, essential: false, updateMode: 'manual' }
        setSkills((current) => [skill, ...current])
      }
      showNotice('success', `${input.name} 已创建，并分配给 ${input.assignedBotIds.length} 个 Bot`)
    } catch (error) {
      showNotice('error', `创建技能失败：${errorMessage(error)}`)
      throw error
    }
  }

  const saveSkill = async (id: string, input: SkillEditorInput) => {
    try {
      if (window.zsenseDesktop) applySnapshot(await unwrapDesktop(window.zsenseDesktop.skills.update({ ...input, id })))
      else setSkills((current) => current.map((skill) => skill.id === id ? { ...skill, ...input, enabled: input.assignedBotIds.length > 0, updatedAt: new Date().toISOString() } : skill))
      showNotice('success', `${input.name} 的 SKILL.md 已保存`)
    } catch (error) {
      showNotice('error', `保存技能失败：${errorMessage(error)}`)
      throw error
    }
  }

  const assignSkill = async (id: string, botIds: string[]) => {
    try {
      if (window.zsenseDesktop) applySnapshot(await unwrapDesktop(window.zsenseDesktop.skills.assign(id, botIds)))
      else setSkills((current) => current.map((skill) => skill.id === id ? { ...skill, assignedBotIds: botIds, enabled: botIds.length > 0 } : skill))
      const skill = skills.find((item) => item.id === id)
      showNotice('success', `${skill?.name || '技能'}已分配给 ${botIds.length} 个 Bot`)
    } catch (error) {
      showNotice('error', `保存技能分配失败：${errorMessage(error)}`)
      throw error
    }
  }

  const deleteSkill = async (skill: Skill) => {
    try {
      if (window.zsenseDesktop) applySnapshot(await unwrapDesktop(window.zsenseDesktop.skills.delete(skill.id)))
      else setSkills((current) => current.filter((item) => item.id !== skill.id))
      showNotice('success', `${skill.name} 已从 ZSense 专属空间删除`)
    } catch (error) {
      showNotice('error', `删除技能失败：${errorMessage(error)}`)
      throw error
    }
  }

  const importSkill = async (mode: 'file' | 'folder') => {
    try {
      if (!window.zsenseDesktop) throw new Error('浏览器预览无法读取本地文件夹，请在 ZSense 桌面端中导入。')
      const result = await unwrapDesktop(window.zsenseDesktop.skills.import(mode))
      applySnapshot(result.workspace)
      if (!result.canceled) showNotice('success', `${result.importedSkillName || '技能'} 已导入，可继续按 Bot 调整分配`)
    } catch (error) {
      showNotice('error', `导入技能失败：${errorMessage(error)}`)
      throw error
    }
  }

  const openSkillsFolder = async (skillId?: string) => {
    try {
      if (!window.zsenseDesktop) throw new Error('请在桌面端中打开真实技能目录。')
      await unwrapDesktop(window.zsenseDesktop.skills.openFolder(skillId))
    } catch (error) {
      showNotice('error', errorMessage(error))
      throw error
    }
  }

  const checkSkillUpdates = async (): Promise<SkillMaintenanceResult> => {
    try {
      if (!window.zsenseDesktop) throw new Error('请在 ZSense 桌面端中检查技能更新。')
      const result = await unwrapDesktop(window.zsenseDesktop.skills.checkUpdates())
      applySnapshot(result.workspace)
      const detail = result.command.output.replace(/\s+/g, ' ').trim().slice(0, 160)
      showNotice(result.command.ok ? 'success' : 'error', detail || '技能更新检查完成')
      return result
    } catch (error) {
      showNotice('error', `检查技能更新失败：${errorMessage(error)}`)
      throw error
    }
  }

  const updateRegistrySkill = async (skillId?: string): Promise<SkillMaintenanceResult> => {
    try {
      if (!window.zsenseDesktop) throw new Error('请在桌面端中更新 Skills Hub 技能。')
      const result = await unwrapDesktop(window.zsenseDesktop.skills.updateRegistry(skillId))
      applySnapshot(result.workspace)
      showNotice(result.command.ok ? 'success' : 'error', result.command.output.replace(/\s+/g, ' ').trim().slice(0, 160) || '技能已更新')
      return result
    } catch (error) {
      showNotice('error', `更新技能失败：${errorMessage(error)}`)
      throw error
    }
  }

  const restoreSkillVersion = async (skillId: string, versionId: string) => {
    try {
      if (!window.zsenseDesktop) throw new Error('请在 ZSense 桌面端中恢复技能版本。')
      applySnapshot(await unwrapDesktop(window.zsenseDesktop.skills.restoreVersion(skillId, versionId)))
      showNotice('success', '技能历史版本已恢复，恢复前的内容也已自动保留')
    } catch (error) {
      showNotice('error', `恢复技能版本失败：${errorMessage(error)}`)
      throw error
    }
  }

  const saveSettings = async (next: AppSettings) => {
    try {
      if (window.zsenseDesktop) applySnapshot(await unwrapDesktop(window.zsenseDesktop.settings.update(next)))
      else setSettings(next)
      showNotice('success', '设置已保存')
    } catch (error) {
      showNotice('error', `保存设置失败：${errorMessage(error)}`)
      throw error
    }
  }

  const toggleVoiceWake = async () => {
    if (voiceWakeBusy) return
    setVoiceWakeBusy(true)
    try {
      await saveSettings({ ...settings, voiceWakeEnabled: !settings.voiceWakeEnabled })
    } catch {
      // saveSettings 已显示保存失败提示，保留原有开关状态。
    } finally {
      setVoiceWakeBusy(false)
    }
  }

  const updateChatInputHeight = useCallback(async (height: number) => {
    const next = { ...settings, chatInputHeight: Math.min(320, Math.max(80, Math.round(height))) }
    const previous = settings
    setSettings(next)
    try {
      if (window.zsenseDesktop) applySnapshot(await unwrapDesktop(window.zsenseDesktop.settings.update(next)))
    } catch (error) {
      setSettings(previous)
      showNotice('error', `保存输入框高度失败：${errorMessage(error)}`)
    }
  }, [applySnapshot, settings, showNotice])

  const displaySettingsValue = useMemo(() => ({
    streamingResponse: settings.streamingResponse,
    compactMode: settings.compactMode,
    showReasoning: settings.showReasoning,
    showUsage: settings.showUsage,
    inlineDiff: settings.inlineDiff,
    completionSound: settings.completionSound,
    approvalSound: settings.approvalSound,
    approvalDesktopNotification: settings.approvalDesktopNotification,
    completionDesktopNotification: settings.completionDesktopNotification,
    chatInputHeight: settings.chatInputHeight,
    onChatInputHeightChange: updateChatInputHeight,
  }), [
    settings.streamingResponse, settings.compactMode, settings.showReasoning, settings.showUsage,
    settings.inlineDiff, settings.completionSound, settings.approvalSound,
    settings.approvalDesktopNotification, settings.completionDesktopNotification,
    settings.chatInputHeight, updateChatInputHeight,
  ])

  const createScheduledTask = async (input: ScheduledTaskInput) => {
    if (!window.zsenseDesktop) throw new Error('真实定时任务只能在 ZSense 桌面端运行。')
    try {
      applySnapshot(await unwrapDesktop(window.zsenseDesktop.tasks.create(input)))
      showNotice('success', '定时任务已创建，ZSense 会按计划自动执行')
    } catch (error) {
      showNotice('error', `创建定时任务失败：${errorMessage(error)}`)
      throw error
    }
  }

  const updateScheduledTask = async (id: string, input: ScheduledTaskInput) => {
    if (!window.zsenseDesktop) throw new Error('真实定时任务只能在 ZSense 桌面端运行。')
    try {
      applySnapshot(await unwrapDesktop(window.zsenseDesktop.tasks.update(id, input)))
      showNotice('success', '定时任务已更新')
    } catch (error) {
      showNotice('error', `更新定时任务失败：${errorMessage(error)}`)
      throw error
    }
  }

  const toggleScheduledTask = async (id: string, enabled: boolean) => {
    if (!window.zsenseDesktop) throw new Error('真实定时任务只能在 ZSense 桌面端运行。')
    try {
      applySnapshot(await unwrapDesktop(window.zsenseDesktop.tasks.toggle(id, enabled)))
      showNotice('success', enabled ? '定时任务已继续' : '定时任务已暂停')
    } catch (error) {
      showNotice('error', `调整定时任务失败：${errorMessage(error)}`)
      throw error
    }
  }

  /** 定时任务是否在总览页展示（定时任务面板里的眼睛按钮） */
  const setScheduledTaskOverviewVisibility = async (id: string, visible: boolean) => {
    if (!window.zsenseDesktop) throw new Error('真实定时任务只能在 ZSense 桌面端运行。')
    try {
      applySnapshot(await unwrapDesktop(window.zsenseDesktop.tasks.setOverviewVisibility(id, visible)))
      showNotice('success', visible ? '已设为在总览页显示' : '已从总览页隐藏')
    } catch (error) {
      showNotice('error', `设置总览展示失败：${errorMessage(error)}`)
      throw error
    }
  }

  const deleteScheduledTask = async (id: string) => {
    if (!window.zsenseDesktop) throw new Error('真实定时任务只能在 ZSense 桌面端运行。')
    try {
      applySnapshot(await unwrapDesktop(window.zsenseDesktop.tasks.delete(id)))
      showNotice('success', '定时任务及其运行历史已删除')
    } catch (error) {
      showNotice('error', `删除定时任务失败：${errorMessage(error)}`)
      throw error
    }
  }

  const deleteScheduledTaskRun = async (id: string) => {
    if (!window.zsenseDesktop) throw new Error('运行记录只能在 ZSense 桌面端删除。')
    try {
      applySnapshot(await unwrapDesktop(window.zsenseDesktop.tasks.deleteRun(id)))
      showNotice('success', '运行记录及对应任务对话已删除')
    } catch (error) {
      showNotice('error', `删除运行记录失败：${errorMessage(error)}`)
      throw error
    }
  }

  const runScheduledTaskNow = async (id: string) => {
    if (!window.zsenseDesktop) throw new Error('真实定时任务只能在 ZSense 桌面端运行。')
    try {
      await unwrapDesktop(window.zsenseDesktop.tasks.runNow(id))
      showNotice('success', '任务已开始；可在运行历史和会话通知中查看进度')
    } catch (error) {
      showNotice('error', `启动定时任务失败：${errorMessage(error)}`)
      throw error
    }
  }

  const openScheduledTaskWorkspace = async (id: string) => {
    if (!window.zsenseDesktop) throw new Error('任务工作区只能在 ZSense 桌面端打开。')
    try { await unwrapDesktop(window.zsenseDesktop.tasks.openWorkspace(id)) }
    catch (error) { showNotice('error', `打开任务工作区失败：${errorMessage(error)}`); throw error }
  }

  const pickScheduledTaskWorkspace = async (): Promise<string> => {
    if (!window.zsenseDesktop) throw new Error('任务工作区只能在 ZSense 桌面端中选择。')
    return unwrapDesktop(window.zsenseDesktop.tasks.pickWorkspace())
  }

  const sendChat = async (botId: string, message: string, conversationId: string | undefined, requestId: string, options: { attachments: ChatAttachment[]; modelProvider?: ModelProvider; model?: string; reasoningEffort: ReasoningEffort; interactionMode?: 'text' | 'voice'; workspacePath: string; browserSessionId?: string; delegateBotId?: string }, onEvent: (event: ChatStreamEvent) => void): Promise<ChatResult> => {
    if (!window.zsenseDesktop) throw new Error('真实对话仅在 ZSense 桌面端中可用。')
    const bot = bots.find((item) => item.id === botId)
    const conversation = conversations.find((item) => item.id === conversationId)
    const startedAt = new Date().toISOString()
    const progressItem: SessionProgressItem = { requestId, conversationId, botId, kind: 'bot', title: conversation?.title || `${bot?.name || 'Bot'} · 新会话`, status: 'running', detail: '正在连接 ZSense Agent Core…', startedAt, updatedAt: startedAt, read: true }
    setSessionProgressItems((current) => [progressItem, ...current.filter((item) => item.requestId !== requestId)].slice(0, 50))
    const unsubscribe = window.zsenseDesktop.chat.onEvent((event) => {
      if (event.requestId !== requestId) return
      trackSessionEvent(event)
      onEvent(event)
    })
    try {
      const result = await unwrapDesktop(window.zsenseDesktop.chat.send({ requestId, botId, message, conversationId, ...options }))
      applySnapshot(result.workspace)
      const savedConversation = result.workspace.conversations.find((item) => item.id === result.conversationId)
      updateSessionProgress(requestId, { conversationId: result.conversationId, title: savedConversation?.title || conversation?.title || `${bot?.name || 'Bot'} 对话`, status: 'complete', detail: '回答已生成', read: false })
      return result
    } catch (error) {
      const message = errorMessage(error)
      updateSessionProgress(requestId, { status: message === '已停止生成。' ? 'cancelled' : 'failed', detail: message === '已停止生成。' ? '生成已停止' : message, read: false })
      throw error
    } finally {
      unsubscribe()
    }
  }

  const sendNativeChat = async (message: string, conversationId: string | undefined, requestId: string, options: { attachments: ChatAttachment[]; modelProvider?: ModelProvider; model?: string; reasoningEffort: ReasoningEffort; interactionMode?: 'text' | 'voice'; workspacePath: string; browserSessionId?: string; delegateBotId?: string }, onEvent: (event: ChatStreamEvent) => void): Promise<ChatResult> => {
    if (!window.zsenseDesktop) throw new Error('AI 对话仅在 ZSense 桌面端中可用。')
    const conversation = conversations.find((item) => item.id === conversationId)
    const startedAt = new Date().toISOString()
    const progressItem: SessionProgressItem = { requestId, conversationId, kind: 'native', title: conversation?.title || 'AI 对话 · 新会话', status: 'running', detail: '正在连接 ZSense Agent Core…', startedAt, updatedAt: startedAt, read: true }
    setSessionProgressItems((current) => [progressItem, ...current.filter((item) => item.requestId !== requestId)].slice(0, 50))
    const unsubscribe = window.zsenseDesktop.chat.onEvent((event) => {
      if (event.requestId !== requestId) return
      trackSessionEvent(event)
      onEvent(event)
    })
    try {
      const result = await unwrapDesktop(window.zsenseDesktop.chat.send({ requestId, native: true, message, conversationId, ...options }))
      applySnapshot(result.workspace)
      const savedConversation = result.workspace.conversations.find((item) => item.id === result.conversationId)
      updateSessionProgress(requestId, { conversationId: result.conversationId, title: savedConversation?.title || conversation?.title || 'AI 对话', status: 'complete', detail: '回答已生成', read: false })
      return result
    } catch (error) {
      const message = errorMessage(error)
      updateSessionProgress(requestId, { status: message === '已停止生成。' ? 'cancelled' : 'failed', detail: message === '已停止生成。' ? '生成已停止' : message, read: false })
      throw error
    } finally {
      unsubscribe()
    }
  }

  const cancelChat = async (requestId: string) => {
    if (window.zsenseDesktop) {
      await unwrapDesktop(window.zsenseDesktop.chat.cancel(requestId))
      updateSessionProgress(requestId, { status: 'cancelled', detail: '生成已停止', read: false })
    }
  }

  const respondToChatClarification = async (requestId: string, clarificationRequestId: string, answers: ChatClarificationAnswer[]) => {
    if (!window.zsenseDesktop) throw new Error('澄清选择只能在 ZSense 桌面端中提交。')
    await unwrapDesktop(window.zsenseDesktop.chat.clarify(requestId, clarificationRequestId, answers))
    updateSessionProgress(requestId, { detail: '选择已提交，ZSense 正在继续处理…', read: true })
  }

  const pickChatAttachments = async (): Promise<ChatAttachment[]> => {
    if (!window.zsenseDesktop) throw new Error('附件仅能在 ZSense 桌面端中选择。')
    return unwrapDesktop(window.zsenseDesktop.chat.pickAttachments())
  }

  const pickChatWorkspace = async (): Promise<string> => {
    if (!window.zsenseDesktop) throw new Error('会话工作区仅能在 ZSense 桌面端中选择。')
    return unwrapDesktop(window.zsenseDesktop.chat.pickWorkspace())
  }

  const saveConversationWorkspace = async (conversationId: string, workspacePath: string) => {
    if (!window.zsenseDesktop) throw new Error('会话工作区仅能在 ZSense 桌面端中保存。')
    try {
      applySnapshot(await unwrapDesktop(window.zsenseDesktop.conversations.setWorkspace(conversationId, workspacePath)))
      showNotice('success', '会话工作区已更新')
    } catch (error) {
      showNotice('error', `保存会话工作区失败：${errorMessage(error)}`)
      throw error
    }
  }

  const activeBot = bots.find((bot) => bot.id === activeBotId) ?? null
  const chatBot = bots.find((bot) => bot.id === chatTarget?.botId) ?? null
  const chatConversation = conversations.find((conversation) => conversation.id === chatTarget?.conversationId)
  const nativeConversations = conversations.filter((conversation) => conversation.kind === 'native')
  const listedNativeConversations = nativeConversations.filter((conversation) => conversation.channelId !== 'scheduled')
  const listedBotConversations = conversations.filter((conversation) => conversation.kind === 'bot' && conversation.channelId !== 'scheduled')
  const nativeDefaultWorkspacePath = settings.defaultWorkspacePath
  const chatDefaultWorkspacePath = settings.defaultWorkspacePath
  const visibleProgressItems = latestSessionItems(sessionProgressItems)
  const runningSessionCount = visibleProgressItems.filter((item) => item.status === 'running').length
  const unreadSessionCount = visibleProgressItems.filter((item) => item.status !== 'running' && !item.read).length
  const topVoiceState = voiceInteraction.state !== 'idle'
    ? voiceInteraction.state
    : settings.voiceWakeEnabled
      ? voiceWakeStatus.state === 'error' || voiceWakeStatus.state === 'unavailable'
        ? 'error'
        : voiceWakeStatus.listening
          ? 'standby'
          : 'starting'
      : 'idle'
  const topVoiceMessage = voiceInteraction.state !== 'idle'
    ? voiceInteraction.message
    : settings.voiceWakeEnabled
      ? voiceWakeStatus.message
      : voiceInteraction.message

  const toggleSessionCenter = () => {
    const nextOpen = !sessionCenterOpen
    setSessionCenterOpen(nextOpen)
    if (nextOpen) setSessionProgressItems((current) => current.map((item) => item.status === 'running' ? item : { ...item, read: true }))
  }

  const openProgressSession = (item: SessionProgressItem) => {
    setSessionCenterOpen(false)
    setMobileOpen(false)
    if (item.kind === 'native') return openNativeChat(item.conversationId)
    if (item.botId) setChatTarget({ botId: item.botId, conversationId: item.conversationId })
  }

  // 四态明确：加载中 / 已锁 / 出错 / 就绪。任何一态都不会再出现「界面在、数据是空的」这种假象。
  const waitingFirstStatus = isDesktopApp && !authStatus && !bootError
  const loadingWorkspace = isDesktopApp && Boolean(authStatus?.authenticated) && !authStatus?.locked && !bootstrapped && !bootError
  const appStillStarting = loading || waitingFirstStatus || loadingWorkspace
  if (!startupAnimationFinished || appStillStarting) {
    const startupStage = bootError ? '启动失败，正在准备错误提示…' : !appStillStarting ? '准备就绪，即将进入工作空间…' : !authStatus ? '正在检查本地安全状态…' : authStatus.locked ? '正在打开安全锁…' : '正在恢复本地工作区…'
    return <div className={`zsense-startup${startupAnimationFinished ? ' zsense-startup--waiting' : ''}`} role="status" aria-live="polite" aria-busy="true"><div className="zsense-startup-inner"><div className="zsense-startup-symbol" aria-hidden="true"><span className="zsense-startup-halo" /><span className="zsense-startup-orbit" /><span className="zsense-startup-orbit zsense-startup-orbit-secondary" /><span className="zsense-startup-logo"><img src={brandLogo} alt="" width={88} height={88} /></span></div><strong className="zsense-startup-name">ZSense</strong><span className="zsense-startup-tagline">你的智能工作空间</span><div className="zsense-startup-progress" aria-hidden="true" /><span className="zsense-startup-stage">{startupStage}</span></div></div>
  }

  if (isDesktopApp && bootError) {
    return <div className="app-loading"><img className="loading-logo" src={brandLogo} alt="ZSense" /><strong>工作区没有加载成功</strong><small>{bootError}</small><button type="button" className="button primary small" onClick={() => { setBootError(''); setLoading(true); void bootstrapWorkspace().catch((error) => setBootError(errorMessage(error))).finally(() => setLoading(false)) }}>重试</button><small>你的数据仍在本机数据库中，重试不会丢失任何内容。</small></div>
  }

  if (isDesktopApp && authStatus?.authenticated && authStatus.locked && authStatus.user) {
    return <AppLockScreen user={authStatus.user} onUnlock={unlockApplication} onReset={resetApplicationLock} />
  }

  const currentUser = authStatus?.user || browserAuthStatus.user!

  // 只有在「确实没有配置全局模型」时才进入首次启动设置。
  // 之前只要 firstRunSetupCompleted 标记位丢失、或默认工作区为空就会再弹一次，
  // Windows 上每次装完新版都要过一遍这个页面就是这么来的。
  // 必须等工作区快照加载完成（!loading）再判断，避免初始默认值造成误判。
  // 首启引导（① 用户名 ② 邮箱验证码 ③ 可选安全锁 ④ 设备号）：没走完先走这条，
  // 走完才轮到下面的「AI 模型」那一步——合并成一条流程，不重复弹。
  if (isDesktopApp && bootstrapped && !settings.onboardingCompleted) {
    return <Suspense fallback={<LazyPageFallback label="正在打开首次设置…" />}><OnboardingFlow user={currentUser} settings={settings} onSaveSettings={saveSettings} /></Suspense>
  }

  if (isDesktopApp && bootstrapped && !loading && !modelConfiguration.model && !settings.firstRunSetupCompleted) {
    console.info('[ZSense] 进入首次启动设置：全局默认模型未配置')
    return <Suspense fallback={<LazyPageFallback label="正在打开模型设置…" />}><FirstRunSetup
      configuration={modelConfiguration}
      initialUserName={currentUser.displayName}
      onLoadModels={loadModelCatalog}
      onPickWorkspace={pickChatWorkspace}
      onComplete={async (configuration, defaultWorkspacePath, userName) => {
        if (window.zsenseDesktop && authStatus?.user) {
          const updatedUser = await unwrapDesktop(window.zsenseDesktop.auth.users.update({
            id: authStatus.user.id,
            username: authStatus.user.username,
            displayName: userName,
            role: authStatus.user.role,
            enabled: authStatus.user.enabled,
          }))
          setAuthStatus((current) => current ? { ...current, user: updatedUser } : current)
        }
        await saveModelConfiguration(configuration)
        await saveSettings({ ...settings, firstRunSetupCompleted: true, defaultWorkspacePath })
      }}
    /></Suspense>
  }

  const voiceStatus = voiceInteraction.state !== 'idle' && <VoiceInteractionStatus
    state={topVoiceState}
    message={topVoiceMessage}
    wakePhrase={settings.voiceWakePhrase}
    targetLabel={voiceInteraction.targetLabel}
    onToggle={() => voiceInteraction.state === 'thinking' || voiceInteraction.state === 'speaking' ? void interruptVoiceInteraction() : voiceOperationRef.current.target ? stopVoiceInteraction(true) : voiceStartRef.current()}
  />

  return (
    <DisplaySettingsProvider value={displaySettingsValue}>
    <div className={`app-shell ${settings.compactMode ? 'compact-mode' : ''} ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`} style={{ '--chat-input-height': `${settings.chatInputHeight}px` } as React.CSSProperties}>
      <a className="skip-link" href="#main-content">跳到主要内容</a>
      <Sidebar activeView={activeView} bots={bots.filter((bot) => !settings.hiddenSidebarBotIds.includes(bot.id))} nativeConversations={listedNativeConversations} activeNativeConversationId={activeNativeConversationId} activeBotId={activeBotId} mobileOpen={mobileOpen} collapsed={sidebarCollapsed} onNavigate={navigate} onOpenBot={openBot} onOpenNativeChat={openNativeChat} onStartNativeChat={startNativeChat} onRenameNativeConversation={renameConversation} onArchiveNativeConversation={archiveNativeConversation} onDeleteNativeConversation={deleteNativeConversation} nativeSpaceId={nativeSpaceId} nativeConversationGroups={nativeConversationGroups} onCreateConversationGroup={createConversationGroup} onRenameConversationGroup={renameConversationGroup} onDeleteConversationGroup={deleteConversationGroup} onToggleConversationGroup={toggleConversationGroup} onMoveConversationToGroup={moveConversationToGroup} onReorderConversations={reorderConversations} onCloseMobile={() => setMobileOpen(false)} onToggleCollapsed={() => setSidebarCollapsed((current) => !current)} currentUser={currentUser} appLockEnabled={settings.appLockEnabled} onLock={lockApplication} voiceStatus={voiceStatus} voiceWakeEnabled={settings.voiceWakeEnabled} voiceWakeStatus={voiceWakeStatus} voiceWakeBusy={voiceWakeBusy} onToggleVoiceWake={() => void toggleVoiceWake()} sessionCenterOpen={sessionCenterOpen} runningSessionCount={runningSessionCount} unreadSessionCount={unreadSessionCount} onToggleSessionCenter={toggleSessionCenter} />
      <div className="app-main">
        <header className="topbar">
          <button className="icon-button mobile-menu" onClick={() => setMobileOpen(true)} aria-label="打开导航"><Menu size={20} /></button>
          {sidebarCollapsed && <button className="icon-button desktop-sidebar-open" onClick={() => setSidebarCollapsed(false)} aria-label="展开左侧导航" title="展开左侧导航" aria-expanded="false"><PanelLeftOpen size={19} /></button>}
          <div className="topbar-actions">
            {voiceStatus}
            <VoiceWakeToggle enabled={settings.voiceWakeEnabled} status={voiceWakeStatus} busy={voiceWakeBusy} onToggle={() => void toggleVoiceWake()} />
            <button type="button" className={`icon-button notification-button ${sessionCenterOpen ? 'active' : ''}`} onClick={toggleSessionCenter} aria-label={`查看会话进度${runningSessionCount ? `，${runningSessionCount} 个进行中` : ''}${unreadSessionCount ? `，${unreadSessionCount} 个新通知` : ''}`} title="会话进度" aria-expanded={sessionCenterOpen} aria-haspopup="dialog">
              <Bell size={18} />
              {runningSessionCount > 0 && <i className="notification-running-dot" />}
              {unreadSessionCount > 0 && <small className="notification-count">{Math.min(unreadSessionCount, 9)}</small>}
            </button>
          </div>
        </header>
        <SessionProgressCenter open={sessionCenterOpen} items={visibleProgressItems} onClose={() => setSessionCenterOpen(false)} onOpenSession={openProgressSession} onClearFinished={() => setSessionProgressItems((current) => current.filter((item) => item.status === 'running'))} />
        <main id="main-content" tabIndex={-1}>
          <Suspense fallback={<LazyPageFallback />}>
          {activeBot ? <BotWorkspace bot={activeBot} channels={channels} gatewayConnections={gatewayConnections.filter((connection) => connection.botId === activeBot.id)} skills={skills} conversations={listedBotConversations.filter((conversation) => conversation.botId === activeBot.id)} savedModelConfigurations={availableModelConfigurations} defaultModelConfiguration={modelConfiguration} runtime={runtime} scheduledTasks={scheduledTasks.filter((task) => task.ownerBotId === activeBot.id)} onRunScheduledTask={runScheduledTaskNow} onToggleScheduledTask={toggleScheduledTask} onEditScheduledTask={(task) => { setPendingEditTaskId(task.id); navigate('scheduled-tasks') }} onOpenScheduledTaskWorkspace={openScheduledTaskWorkspace} onCreateScheduledTask={() => { setPendingTaskOwnerId(activeBot.id); setPendingEditTaskId('new'); navigate('scheduled-tasks') }} onBack={() => navigate('bots')} onOpenModels={() => navigate('models')} onLoadAuthorizedUsers={loadGatewayAuthorizedUsers} onSaveGateway={saveGatewayConnection} onDeleteGateway={deleteGatewayConnection} onLoadGatewayPairings={loadGatewayPairings} onApproveGatewayPairing={approveGatewayPairing} onStartWeixinLogin={startWeixinLogin} onGetWeixinLoginStatus={getWeixinLoginStatus} onCancelWeixinLogin={cancelWeixinLogin} onOpenRuntime={() => { setSettingsSection('runtime'); navigate('settings') }} onRefreshRuntime={refreshRuntime} onUpdate={updateBot} onDuplicate={duplicateBot} onDelete={deleteBot} onAddMemory={addMemory} onUpdateMemory={updateMemory} onDeleteMemory={deleteMemory} onStartChat={(conversationId) => setChatTarget({ botId: activeBot.id, conversationId })} onRenameConversation={renameConversation} onArchiveConversation={archiveConversation} onDeleteConversation={deleteConversation} /> : (
            <>
              {activeView === 'overview' && <Overview bots={bots} conversations={listedBotConversations} channels={channels} activities={activityItems} scheduledTasks={scheduledTasks} scheduledTaskRuns={scheduledTaskRuns} runtime={runtime} defaultModelConfiguration={modelConfiguration} voiceWakeEnabled={settings.voiceWakeEnabled} onOpenBot={openBot} onNavigate={navigate} onToggleTask={toggleScheduledTask} onRunTask={runScheduledTaskNow} onEditTask={(task) => { setPendingEditTaskId(task.id); navigate('scheduled-tasks') }} onOpenTaskWorkspace={openScheduledTaskWorkspace} onDeleteTask={deleteScheduledTask} onOpenConversation={openNativeChat} onToggleOverviewVisibility={setScheduledTaskOverviewVisibility} onOpenVoiceSettings={() => { setSettingsSection('voice'); navigate('settings') }} />}
              {activeView === 'chat' && <NativeChatPage conversations={nativeConversations} bots={bots} skills={skills} activeConversationId={activeNativeConversationId} resetToken={nativeChatResetToken} draftRequest={nativeChatDraftRequest} runtime={runtime} savedModelConfigurations={availableModelConfigurations} defaultModelConfiguration={modelConfiguration} defaultWorkspacePath={nativeDefaultWorkspacePath} voiceRequest={nativeVoiceRequest} speechLanguage={VOICE_LANGUAGE} speechVoice={settings.voiceTtsVoice} speechSpeed={settings.voiceTtsSpeed} browserSettings={settings} onSend={sendNativeChat} onPickAttachments={pickChatAttachments} onPickWorkspace={pickChatWorkspace} onSaveWorkspace={saveConversationWorkspace} onDeleteMessage={deleteConversationMessage} onCancel={cancelChat} onClarify={respondToChatClarification} onConversationChange={setActiveNativeConversationId} onOpenSettings={() => navigate('settings')} onNewConversation={startNativeChat} onVoiceTurnDelta={handleVoiceTurnDelta} onVoiceTurnCompleted={handleVoiceTurnCompleted} onVoiceTurnFailed={handleVoiceTurnFailed} />}
              {activeView === 'bots' && <BotsPage bots={bots} conversations={listedBotConversations} gatewayConnections={gatewayConnections} hiddenSidebarBotIds={settings.hiddenSidebarBotIds} onToggleSidebarBot={toggleSidebarBot} onOpenBot={openBot} onCreate={() => setCreateOpen(true)} onUpdate={updateBot} onDuplicate={duplicateBot} onDelete={deleteBot} />}
              {activeView === 'scheduled-tasks' && <ScheduledTasksPage tasks={scheduledTasks} runs={scheduledTaskRuns} models={availableModelConfigurations} skills={skills} defaultWorkspacePath={settings.defaultWorkspacePath} onCreate={createScheduledTaskWithOwner} onUpdate={updateScheduledTask} onToggle={toggleScheduledTask} onDelete={deleteScheduledTask} onDeleteRun={deleteScheduledTaskRun} onRunNow={runScheduledTaskNow} onPickWorkspace={pickScheduledTaskWorkspace} onOpenWorkspace={openScheduledTaskWorkspace} onOpenConversation={openNativeChat} onToggleOverviewVisibility={setScheduledTaskOverviewVisibility} editingTaskId={pendingEditTaskId} onEditingTaskHandled={() => setPendingEditTaskId('')} />}
              {activeView === 'office-tasks' && <OfficeTasksPage bots={bots} onOpenConversation={(task) => task.botId === NATIVE_BOT_ID ? openNativeChat(task.conversationId) : setChatTarget({ botId: task.botId, conversationId: task.conversationId })} />}
              {activeView === 'settings' && <SettingsPage
                settings={settings}
                voiceWakeStatus={voiceWakeStatus}
                storagePath={storagePath}
                runtime={runtime}
                onSave={saveSettings}
                onPickWorkspace={pickChatWorkspace}
                onRefreshRuntime={refreshRuntime}
                onRuntimeChanged={setRuntime}
                currentUser={currentUser}
                onCurrentUserChanged={(user) => setAuthStatus((current) => current ? { ...current, user } : current)}
                section={settingsSection}
                onSectionChange={setSettingsSection}
                modelPanel={<ModelPage embedded configuration={modelConfiguration} savedConfigurations={savedModelConfigurations} availableConfigurations={availableModelConfigurations} runtime={runtime} onSave={saveModelConfiguration} onLoadModels={loadModelCatalog} onRefreshRuntime={refreshRuntime} onOpenRuntime={() => setSettingsSection('runtime')} />}
                skillsPanel={<SkillsPage embedded bots={bots} skills={skills} skillsPath={skillsPath} onCreateSkill={createSkill} onUpdateSkill={saveSkill} onDeleteSkill={deleteSkill} onAssignSkill={assignSkill} onImportSkill={importSkill} onOpenSkillsFolder={openSkillsFolder} onCheckUpdates={checkSkillUpdates} onUpdateRegistrySkill={updateRegistrySkill} onRestoreVersion={restoreSkillVersion} />}
                memoryPanel={<GlobalMemoryPage embedded bots={bots} nativeBot={nativeBot} onAddMemory={addMemory} onUpdateMemory={updateMemory} onDeleteMemory={deleteMemory} />}
                activityPanel={<ActivityPage embedded bots={bots} conversations={conversations} activities={activityItems} />}
              />}
            </>
          )}
          </Suspense>
        </main>
      </div>
      <Suspense fallback={null}>
        {createOpen && <CreateBotDialog open onClose={() => setCreateOpen(false)} onCreate={createBot} defaultModel={modelConfiguration.model || ''} />}
        {chatBot && <ChatDialog key={chatConversation?.id || `new-${chatBot.id}`} bot={chatBot} bots={bots} skills={skills} conversation={chatConversation} runtime={runtime} savedModelConfigurations={availableModelConfigurations} defaultModelConfiguration={modelConfiguration} defaultWorkspacePath={chatDefaultWorkspacePath} voiceRequest={voiceOperationRef.current.target?.kind === 'bot' && voiceOperationRef.current.target.botId === chatBot.id ? botVoiceRequest : undefined} speechLanguage={VOICE_LANGUAGE} speechVoice={settings.voiceTtsVoice} speechSpeed={settings.voiceTtsSpeed} browserSettings={settings} onClose={() => { if (voiceOperationRef.current.target?.kind === 'bot' && voiceOperationRef.current.target.botId === chatBot.id) stopVoiceInteraction(false); setChatTarget(null) }} onNewConversation={() => setChatTarget({ botId: chatBot.id })} onSend={sendChat} onPickAttachments={pickChatAttachments} onPickWorkspace={pickChatWorkspace} onSaveWorkspace={saveConversationWorkspace} onDeleteMessage={deleteConversationMessage} onCancel={cancelChat} onClarify={respondToChatClarification} onVoiceTurnDelta={handleVoiceTurnDelta} onVoiceTurnCompleted={handleVoiceTurnCompleted} onVoiceTurnFailed={handleVoiceTurnFailed} onOpenSettings={() => { if (voiceOperationRef.current.target?.kind === 'bot') stopVoiceInteraction(false); setChatTarget(null); navigate('settings') }} />}
        {isDesktopApp && !dwsAuthDismissed && !dwsAuthStatus.authenticated && <DwsAuthSetupDialog status={dwsAuthStatus} onLogin={loginDws} onRefresh={refreshDwsAuth} onLater={() => setDwsAuthDismissed(true)} />}
      </Suspense>
      {notice && <div className={`app-notice ${notice.tone}`} role="status">{notice.tone === 'success' ? <CheckCircle2 size={17} /> : <AlertTriangle size={17} />}<span>{notice.message}</span><button onClick={() => setNotice(null)} aria-label="关闭提示"><X size={15} /></button></div>}
    </div>
    </DisplaySettingsProvider>
  )
}
