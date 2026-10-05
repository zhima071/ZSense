export {}

import type { AgentCapabilitiesStatus, AppSettings, ApprovalGrant, AuthStatus, AuthUser, AutonomySnapshot, AutonomyTaskKind, Bot, BrowserDataState, BrowserSitePermission, ChatAttachment, ChatClarificationAnswer, ChatRequest, ChatResult, ChatStreamEvent, ComputerUseStatus, ConfigurationTransferResult, CreateUserInput, DesktopResult, DeviceLinkPeerAccess, DeviceLinkRemoteRunResult, DeviceLinkRemoteStatus, DeviceLinkStatus, DwsAuthStatus, GatewayAuthorizedUser, GatewayConnectionConfigurationInput, GatewayPairingRequest, HtmlDocumentSession, LocalVoiceOption, LocalVoiceSpeechResult, LocalVoiceTranscriptionRequest, McpServerConfiguration, McpServerConfigurationInput, McpTestResult, MemoryItem, ModelCatalog, ModelCatalogRequest, ModelConfigurationInput, OfficeDocumentState, OfficeEditResult, OfficeRecentFile, OfficeSearchHit, OfficeSessionEvent, OfficeSessionResult, OfficeSheetCellChange, OfficeSheetGrid, OfficeWorkItem, OfficeWordOperation, OfficeWorkbookGrid, OfficeWorkbookOperation, OfficeWorkspaceStatus, RuntimeCommandResult, RuntimeStatus, ScheduledTaskInput, SkillEditorInput, SkillImportResult, SkillMaintenanceResult, UpdateCheckResult, UpdateStatus, UpdateUserInput, VoiceSynthesisRequest, VoiceWakeDetectedEvent, VoiceWakeStatus, WebBridgeStatus, WeixinQrLoginStatus, WordDocumentSession, WorkspaceSnapshot } from './types'

declare global {
  interface Window {
    zsenseDesktop?: {
      isDesktop: true
      platform: 'darwin' | 'win32' | 'linux'
      versions: {
        electron: string
        chrome: string
      }
      clipboard: {
        writeText: (text: string) => Promise<DesktopResult<boolean>>
      }
      deviceLink: {
        status: () => Promise<DesktopResult<DeviceLinkStatus>>
        setEnabled: (enabled: boolean) => Promise<DesktopResult<DeviceLinkStatus>>
        setRemoteEnabled: (enabled: boolean) => Promise<DesktopResult<DeviceLinkStatus>>
        setRemoteHostname: (hostname: string) => Promise<DesktopResult<DeviceLinkStatus>>
        revokeRemoteIdentity: () => Promise<DesktopResult<DeviceLinkStatus>>
        setRemoteUpstream: (mode: 'auto' | 'local') => Promise<DesktopResult<DeviceLinkStatus>>
        setRemoteToken: (token: string) => Promise<DesktopResult<DeviceLinkStatus>>
        trustConnect: (deviceId: string) => Promise<{ ok: boolean; data?: { url: string; deviceId: string }; error?: string }>
        pairConnect: (deviceId: string, code: string) => Promise<{ ok: boolean; data?: { url: string; deviceId: string }; error?: string }>
        setName: (name: string) => Promise<DesktopResult<DeviceLinkStatus>>
        refreshCode: () => Promise<DesktopResult<DeviceLinkStatus>>
        refresh: () => Promise<DesktopResult<DeviceLinkStatus>>
        pair: (deviceId: string, code: string) => Promise<DesktopResult<DeviceLinkStatus>>
        pairByAddress: (request: { address: string; port?: number; code: string }) => Promise<DesktopResult<DeviceLinkStatus>>
        connect: (deviceId: string) => Promise<DesktopResult<DeviceLinkStatus>>
        disconnect: (deviceId: string) => Promise<DesktopResult<DeviceLinkStatus>>
        unpair: (deviceId: string) => Promise<DesktopResult<DeviceLinkStatus>>
        remoteStatus: (deviceId: string) => Promise<DesktopResult<DeviceLinkRemoteStatus>>
        remoteRun: (request: { deviceId: string; prompt: string; timeoutMs?: number }) => Promise<DesktopResult<DeviceLinkRemoteRunResult>>
        setPeerAccess: (request: { deviceId: string; access: DeviceLinkPeerAccess }) => Promise<DesktopResult<DeviceLinkStatus>>
        onChanged: (callback: (status: DeviceLinkStatus) => void) => () => void
      }
      webBridge: {
        status: () => Promise<DesktopResult<WebBridgeStatus>>
        setEnabled: (enabled: boolean) => Promise<DesktopResult<WebBridgeStatus>>
        rotateCode: () => Promise<DesktopResult<WebBridgeStatus>>
        revokeSession: (token: string) => Promise<DesktopResult<WebBridgeStatus>>
        onChanged: (callback: (status: WebBridgeStatus) => void) => () => void
      }
      update: {
        status: () => Promise<DesktopResult<UpdateStatus>>
        check: (feedUrl?: string) => Promise<DesktopResult<UpdateCheckResult>>
        openDownload: (url: string) => Promise<DesktopResult<{ opened: boolean; url: string }>>
      }
      pdf: {
        openExternally: (filePath: string) => Promise<DesktopResult<boolean>>
        read: (filePath: string) => Promise<DesktopResult<{ modifiedAt: number; size: number }>>
        readChunk: (request: { filePath: string; expectedModifiedAt: number; offset: number; length: number }) => Promise<DesktopResult<Uint8Array>>
        save: (request: { filePath: string; expectedModifiedAt: number; operations: unknown[] }) => Promise<DesktopResult<{ modifiedAt: number; size: number; filePath: string; backupPath: string }>>
        saveAs: (request: { filePath: string; expectedModifiedAt: number; operations: unknown[] }) => Promise<DesktopResult<{ canceled: boolean; saved?: { modifiedAt: number; size: number; filePath: string; backupPath: string } }>>
        pageAction: (request: { filePath: string; expectedModifiedAt: number; action: 'rotateLeft' | 'rotateRight' | 'delete' | 'duplicate' | 'moveUp' | 'moveDown' | 'insertBlank' | 'extract' | 'merge'; page: number }) => Promise<DesktopResult<{ canceled: boolean; saved?: { modifiedAt: number; size: number; filePath: string; backupPath: string } }>>
      }
      browser: {
        register: (sessionId: string, webContentsId: number) => Promise<DesktopResult<{ attached: boolean; sessionId: string; webContentsId: number }>>
        unregister: (sessionId: string, webContentsId: number) => Promise<DesktopResult<{ detached: boolean }>>
        activate: (sessionId: string) => Promise<DesktopResult<{ active: boolean; sessionId: string }>>
        close: (sessionId: string) => Promise<DesktopResult<{ closed: boolean; visible?: boolean }>>
        capture: (sessionId: string) => Promise<DesktopResult<{ dataUrl: string; width: number; height: number; name: string; url: string }>>
        state: () => Promise<DesktopResult<BrowserDataState>>
        clearData: () => Promise<DesktopResult<BrowserDataState>>
        clearHistory: (kind: 'history' | 'downloads' | 'all') => Promise<DesktopResult<BrowserDataState>>
        pickDownloadDirectory: () => Promise<DesktopResult<string>>
        setSitePermission: (permission: BrowserSitePermission) => Promise<DesktopResult<BrowserDataState>>
        removeSitePermission: (origin: string) => Promise<DesktopResult<BrowserDataState>>
        openExternal: (url: string) => Promise<DesktopResult<boolean>>
        onActivity: (callback: (event: { sessionId: string; action: 'open' | 'close' | 'permission-request'; origin?: string; permission?: string }) => void) => () => void
      }
      screenshot: {
        captureRegion: (rectangle: { x: number; y: number; width: number; height: number }) => Promise<DesktopResult<{ dataUrl: string; width: number; height: number; name: string }>>
      }
      auth: {
        status: () => Promise<DesktopResult<AuthStatus>>
        lock: () => Promise<DesktopResult<AuthStatus>>
        unlock: (password: string) => Promise<DesktopResult<AuthStatus>>
        setLockPassword: (password: string) => Promise<DesktopResult<AuthStatus>>
        emailStatus: () => Promise<{ ok: boolean; data?: { bound: boolean; masked: string }; error?: string }>
        accountPasswordStatus: () => Promise<{ ok: boolean; data?: { configured: boolean }; error?: string }>
        setAccountPassword: (password: string) => Promise<{ ok: boolean; data?: { configured: boolean }; error?: string }>
        setEmail: (email: string) => Promise<{ ok: boolean; data?: AuthStatus; error?: string }>
        sendBindCode: (email: string) => Promise<{ ok: boolean; data?: { masked: string; expiresInSeconds: number }; error?: string }>
        verifyBindCode: (input: { email: string; code: string }) => Promise<{ ok: boolean; data?: AuthStatus; error?: string }>
        sendResetCode: () => Promise<{ ok: boolean; data?: { masked: string; expiresInSeconds: number }; error?: string }>
        resetLockPassword: (input: { code: string; password: string }) => Promise<{ ok: boolean; data?: AuthStatus; error?: string }>
        onLocked: (callback: (status: AuthStatus) => void) => () => void
        users: {
          list: () => Promise<DesktopResult<AuthUser[]>>
          create: (input: CreateUserInput) => Promise<DesktopResult<AuthUser>>
          update: (input: UpdateUserInput) => Promise<DesktopResult<AuthUser>>
          delete: (userId: string) => Promise<DesktopResult<AuthUser[]>>
        }
      }
      onboarding: {
    status: () => Promise<{ ok: boolean; data?: { completed: boolean }; error?: string }>
    setName: (displayName: string, username?: string) => Promise<{ ok: boolean; data?: { username: string; displayName: string }; error?: string }>
    complete: () => Promise<{ ok: boolean; data?: { completed: boolean }; error?: string }>
  }
      data: {
        loadWorkspace: () => Promise<DesktopResult<WorkspaceSnapshot>>
        conversationTimestamps: () => Promise<{ ok: boolean; data?: { id: string; updatedAt: string }[]; error?: string }>
        syncMessages: () => Promise<DesktopResult<{ importedMessages: number; workspace: WorkspaceSnapshot }>>
        onChanged: (callback: (snapshot: WorkspaceSnapshot) => void) => () => void
      }
      officeTasks: {
        list: (filter?: { botId?: string; conversationId?: string }) => Promise<DesktopResult<OfficeWorkItem[]>>
        search: (botId: string, query: string) => Promise<DesktopResult<OfficeSearchHit[]>>
        deliver: (taskId: string) => Promise<DesktopResult<OfficeWorkItem>>
        onChanged: (callback: () => void) => () => void
      }
      dws: {
        status: () => Promise<DesktopResult<DwsAuthStatus>>
        login: () => Promise<DesktopResult<DwsAuthStatus>>
      }
      office: {
        apiVersion: number
        status: () => Promise<DesktopResult<OfficeWorkspaceStatus>>
        recent: () => Promise<DesktopResult<OfficeRecentFile[]>>
        pick: () => Promise<DesktopResult<OfficeDocumentState | null>>
        open: (filePath: string) => Promise<DesktopResult<OfficeDocumentState>>
        inlineImage: (request: { workspacePath: string; filePath: string }) => Promise<DesktopResult<{ previewUrl: string }>>
        refresh: (filePath: string) => Promise<DesktopResult<OfficeDocumentState>>
        imageThumbnail: (filePath: string) => Promise<DesktopResult<{ dataUrl: string; width: number; height: number }>>
        getSheet: (request: { filePath: string; sheet: string }) => Promise<DesktopResult<OfficeSheetGrid>>
        getWorkbook: (request: { filePath: string }) => Promise<DesktopResult<OfficeWorkbookGrid>>
        stageCells: (request: { filePath: string; changes: OfficeSheetCellChange[]; clientId: string }) => Promise<DesktopResult<OfficeSessionResult>>
        stageOperations?: (request: { filePath: string; operations: OfficeWorkbookOperation[]; clientId: string }) => Promise<DesktopResult<OfficeSessionResult>>
        getWord: (request: { filePath: string }) => Promise<DesktopResult<WordDocumentSession>>
        stageWordOperations: (request: { filePath: string; operations: OfficeWordOperation[]; clientId: string }) => Promise<DesktopResult<OfficeSessionResult>>
        saveWord: (request: { filePath: string; clientId: string }) => Promise<DesktopResult<OfficeSessionResult>>
        discardWord: (request: { filePath: string; clientId: string }) => Promise<DesktopResult<WordDocumentSession>>
        getHtml: (request: { filePath: string }) => Promise<DesktopResult<HtmlDocumentSession>>
        stageHtml: (request: { filePath: string; source: string; clientId: string }) => Promise<DesktopResult<OfficeSessionResult>>
        saveHtml: (request: { filePath: string; source: string; expectedRevision: number; clientId: string }) => Promise<DesktopResult<OfficeSessionResult>>
        discardHtml: (request: { filePath: string; clientId: string }) => Promise<DesktopResult<HtmlDocumentSession>>
        pickSpreadsheetImage: () => Promise<DesktopResult<string | null>>
        pickHtmlImage: () => Promise<DesktopResult<{ dataUrl: string; name: string } | null>>
        pickWordImage: () => Promise<DesktopResult<string | null>>
        saveWorkbook: (request: { filePath: string; clientId: string }) => Promise<DesktopResult<OfficeSessionResult>>
        discardWorkbook: (request: { filePath: string; clientId: string }) => Promise<DesktopResult<OfficeWorkbookGrid>>
        onSessionChanged: (callback: (event: OfficeSessionEvent) => void) => () => void
        replaceText: (request: { filePath: string; find: string; replace: string }) => Promise<DesktopResult<OfficeEditResult>>
        setCell: (request: { filePath: string; sheet: string; cell: string; value: string }) => Promise<DesktopResult<OfficeEditResult>>
        setCells: (request: { filePath: string; changes: OfficeSheetCellChange[] }) => Promise<DesktopResult<OfficeEditResult>>
        openExternally: (filePath: string) => Promise<DesktopResult<void>>
        reveal: (filePath: string) => Promise<DesktopResult<void>>
      }
      bots: {
        create: (bot: Bot) => Promise<DesktopResult<WorkspaceSnapshot>>
        duplicate: (sourceBotId: string, duplicateBotId: string) => Promise<DesktopResult<WorkspaceSnapshot>>
        update: (bot: Bot) => Promise<DesktopResult<WorkspaceSnapshot>>
        delete: (botId: string) => Promise<DesktopResult<WorkspaceSnapshot>>
      }
      memories: {
        status: () => Promise<DesktopResult<{ engine: string; localOnly: boolean; ready: boolean; error: string }>>
        create: (botId: string, memory: MemoryItem) => Promise<DesktopResult<WorkspaceSnapshot>>
        update: (botId: string, memory: MemoryItem) => Promise<DesktopResult<WorkspaceSnapshot>>
        delete: (botId: string, memoryId: string) => Promise<DesktopResult<WorkspaceSnapshot>>
      }
      gatewayConnections: {
        save: (configuration: GatewayConnectionConfigurationInput) => Promise<DesktopResult<WorkspaceSnapshot>>
        delete: (connectionId: string) => Promise<DesktopResult<WorkspaceSnapshot>>
        pairings: (connectionId: string) => Promise<DesktopResult<GatewayPairingRequest[]>>
        authorizedUsers: (connectionId: string) => Promise<DesktopResult<GatewayAuthorizedUser[]>>
        renameAuthorizedUser: (connectionId: string, userId: string, userName: string) => Promise<DesktopResult<GatewayAuthorizedUser[]>>
        approvePairing: (connectionId: string, requestId: string) => Promise<DesktopResult<{ pairings: GatewayPairingRequest[]; workspace: WorkspaceSnapshot }>>
        startWeixinLogin: (botId: string) => Promise<DesktopResult<WeixinQrLoginStatus>>
        getWeixinLoginStatus: (loginId: string) => Promise<DesktopResult<WeixinQrLoginStatus>>
        cancelWeixinLogin: (loginId: string) => Promise<DesktopResult<WeixinQrLoginStatus>>
      }
      conversations: {
        rename: (conversationId: string, title: string) => Promise<DesktopResult<WorkspaceSnapshot>>
        archive: (conversationId: string, archived: boolean) => Promise<DesktopResult<WorkspaceSnapshot>>
        setWorkspace: (conversationId: string, workspacePath: string) => Promise<DesktopResult<WorkspaceSnapshot>>
        deleteMessage: (conversationId: string, messageId: string) => Promise<DesktopResult<WorkspaceSnapshot>>
        delete: (conversationId: string) => Promise<DesktopResult<WorkspaceSnapshot>>
        moveGroup: (conversationId: string, groupId: string) => Promise<DesktopResult<WorkspaceSnapshot>>
        reorder: (botId: string, orderedIds: string[]) => Promise<DesktopResult<WorkspaceSnapshot>>
      }
      conversationGroups: {
        create: (botId: string, name: string) => Promise<DesktopResult<WorkspaceSnapshot>>
        rename: (groupId: string, name: string) => Promise<DesktopResult<WorkspaceSnapshot>>
        delete: (groupId: string) => Promise<DesktopResult<WorkspaceSnapshot>>
        setCollapsed: (groupId: string, collapsed: boolean) => Promise<DesktopResult<WorkspaceSnapshot>>
      }
      skills: {
        create: (skill: SkillEditorInput) => Promise<DesktopResult<WorkspaceSnapshot>>
        update: (skill: SkillEditorInput & { id: string }) => Promise<DesktopResult<WorkspaceSnapshot>>
        toggle: (skillId: string, enabled: boolean) => Promise<DesktopResult<WorkspaceSnapshot>>
        assign: (skillId: string, botIds: string[]) => Promise<DesktopResult<WorkspaceSnapshot>>
        delete: (skillId: string) => Promise<DesktopResult<WorkspaceSnapshot>>
        import: (mode: 'file' | 'folder') => Promise<DesktopResult<SkillImportResult>>
        openFolder: (skillId?: string) => Promise<DesktopResult<void>>
        checkUpdates: () => Promise<DesktopResult<SkillMaintenanceResult>>
        updateRegistry: (skillId?: string) => Promise<DesktopResult<SkillMaintenanceResult>>
        restoreVersion: (skillId: string, versionId: string) => Promise<DesktopResult<WorkspaceSnapshot>>
      }
      settings: {
        update: (settings: AppSettings) => Promise<DesktopResult<WorkspaceSnapshot>>
      }
      configuration: {
        export: () => Promise<DesktopResult<ConfigurationTransferResult>>
        import: () => Promise<DesktopResult<ConfigurationTransferResult>>
      }
      capabilities: {
        status: () => Promise<DesktopResult<AgentCapabilitiesStatus>>
        autonomy: () => Promise<DesktopResult<AutonomySnapshot>>
        manageAutonomy: (kind: AutonomyTaskKind, id: string, action: 'pause' | 'resume' | 'run' | 'remove') => Promise<DesktopResult<AutonomySnapshot>>
        revokeApproval: (id: string) => Promise<DesktopResult<ApprovalGrant[]>>
      }
      computerUse: {
        status: () => Promise<DesktopResult<ComputerUseStatus>>
        requestPermissions: () => Promise<DesktopResult<ComputerUseStatus>>
      }
      mcp: {
        list: () => Promise<DesktopResult<McpServerConfiguration[]>>
        configure: (configuration: McpServerConfigurationInput) => Promise<DesktopResult<McpServerConfiguration>>
        delete: (id: string) => Promise<DesktopResult<McpServerConfiguration[]>>
        test: (id: string) => Promise<DesktopResult<McpTestResult>>
      }
      canvas: {
        load: (workspacePath: string) => Promise<DesktopResult<{ document: unknown; storagePath: string; savedAt: string }>>
        save: (workspacePath: string, document: unknown, clientId: string) => Promise<DesktopResult<{ document: unknown; storagePath: string; savedAt: string }>>
        importFile: (workspacePath: string, filePath: string, clientId: string, document: unknown, conversationId: string) => Promise<DesktopResult<{ kind: 'image' | 'pdf'; existing: boolean; deduplicated: number; node: { id: string; x: number; y: number; width: number; height: number }; pageId: string; document: unknown; filePath: string; message: string }>>
        onChanged: (callback: (event: { workspacePath: string; document: unknown; sourceClientId: string }) => void) => () => void
      }
      tasks: {
        create: (task: ScheduledTaskInput) => Promise<DesktopResult<WorkspaceSnapshot>>
        update: (id: string, task: ScheduledTaskInput) => Promise<DesktopResult<WorkspaceSnapshot>>
        toggle: (id: string, enabled: boolean) => Promise<DesktopResult<WorkspaceSnapshot>>
        delete: (id: string) => Promise<DesktopResult<WorkspaceSnapshot>>
        deleteRun: (id: string) => Promise<DesktopResult<WorkspaceSnapshot>>
        runNow: (id: string) => Promise<DesktopResult<{ accepted: boolean; taskId: string }>>
        setOverviewVisibility: (id: string, visible: boolean) => Promise<DesktopResult<WorkspaceSnapshot>>
        pickWorkspace: () => Promise<DesktopResult<string>>
        openWorkspace: (id: string) => Promise<DesktopResult<void>>
      }
      notifications: {
        test: (kind: 'approval' | 'completion') => Promise<DesktopResult<{ supported: boolean; soundPlayed: boolean; notificationShown: boolean; failureReason: string }>>
      }
      voiceWake: {
        status: () => Promise<DesktopResult<VoiceWakeStatus>>
        requestPermission: () => Promise<DesktopResult<{ permission: VoiceWakeStatus['permission'] }>>
        start: (configuration: { phrase: string; sensitivity: number; confirmationFrames: number }) => Promise<DesktopResult<VoiceWakeStatus>>
        feed: (pcm: string) => Promise<DesktopResult<{ accepted: boolean }>>
        detected: (event: { phrase: string }) => Promise<DesktopResult<VoiceWakeDetectedEvent>>
        stop: () => Promise<DesktopResult<VoiceWakeStatus>>
        onStatusChanged: (callback: (status: VoiceWakeStatus) => void) => () => void
        onDetected: (callback: (event: VoiceWakeDetectedEvent) => void) => () => void
      }
      voice: {
        transcribeLocal: (request: LocalVoiceTranscriptionRequest) => Promise<DesktopResult<LocalVoiceTranscriptionResult>>
        listVoices: () => Promise<DesktopResult<LocalVoiceOption[]>>
        ttsConfig: () => Promise<DesktopResult<{ engine: 'moss-tts-nano'; modelUrl: string; threadCount: number; streaming: true; offline: true }>>
        stopSpeaking: () => Promise<DesktopResult<{ stopped: boolean }>>
      }
      models: {
        list: (request: ModelCatalogRequest) => Promise<DesktopResult<ModelCatalog>>
        update: (configuration: ModelConfigurationInput) => Promise<DesktopResult<WorkspaceSnapshot>>
      }
      runtime: {
        inspect: () => Promise<DesktopResult<RuntimeStatus>>
        onStatusChanged: (callback: (status: RuntimeStatus) => void) => () => void
        doctor: () => Promise<DesktopResult<RuntimeCommandResult>>
      }
      chat: {
        pickAttachments: () => Promise<DesktopResult<ChatAttachment[]>>
        resolveDroppedAttachments: (files: File[]) => Promise<DesktopResult<ChatAttachment[]>>
        resolvePastedAttachments: (files: File[], workspacePath: string) => Promise<DesktopResult<ChatAttachment[]>>
        pickWorkspace: () => Promise<DesktopResult<string>>
        send: (request: ChatRequest) => Promise<DesktopResult<ChatResult>>
        steer: (requestId: string, message: string, attachments?: ChatAttachment[], workspacePath?: string) => Promise<DesktopResult<{ accepted: boolean; pendingCount: number; steeringId: string; intent: 'adjust' | 'supplement' | 'next' }>>
        cancel: (requestId: string) => Promise<DesktopResult<{ cancelled: boolean }>>
        clarify: (requestId: string, clarificationRequestId: string, answers: ChatClarificationAnswer[]) => Promise<DesktopResult<{ accepted: boolean }>>
        deleteNative: (conversationId: string) => Promise<DesktopResult<WorkspaceSnapshot>>
        onEvent: (callback: (event: ChatStreamEvent) => void) => () => void
      }
    }
  }
}
