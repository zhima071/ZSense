const { contextBridge, ipcRenderer, webUtils } = require('electron')

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload)

contextBridge.exposeInMainWorld('zsenseDesktop', Object.freeze({
  isDesktop: true,
  platform: process.platform,
  versions: Object.freeze({
    electron: process.versions.electron,
    chrome: process.versions.chrome,
  }),
  clipboard: Object.freeze({
    writeText: (text) => invoke('zsense:clipboard:write-text', text),
  }),
  deviceLink: Object.freeze({
    setRemoteEnabled: (enabled) => ipcRenderer.invoke('zsense:device-link:set-remote-enabled', { enabled: Boolean(enabled) }),
    setRemoteHostname: (hostname) => ipcRenderer.invoke('zsense:device-link:set-remote-hostname', hostname),
    revokeRemoteIdentity: () => ipcRenderer.invoke('zsense:device-link:revoke-remote-identity'),
    setRemoteUpstream: (mode) => ipcRenderer.invoke('zsense:device-link:set-remote-upstream', mode),
    setRemoteToken: (token) => ipcRenderer.invoke('zsense:device-link:set-remote-token', token),
    trustConnect: (deviceId) => invoke('zsense:device-link:trust-connect', { deviceId }),
    pairConnect: (deviceId, code) => invoke('zsense:device-link:pair-connect', { deviceId, code }),
    status: () => invoke('zsense:device-link:status'),
    setEnabled: (enabled) => invoke('zsense:device-link:set-enabled', enabled),
    setName: (name) => invoke('zsense:device-link:set-name', name),
    refreshCode: () => invoke('zsense:device-link:refresh-code'),
    refresh: () => invoke('zsense:device-link:refresh'),
    pair: (deviceId, code) => invoke('zsense:device-link:pair', { deviceId, code }),
    pairByAddress: (request) => invoke('zsense:device-link:pair-by-address', request),
    connect: (deviceId) => invoke('zsense:device-link:connect', deviceId),
    disconnect: (deviceId) => invoke('zsense:device-link:disconnect', deviceId),
    unpair: (deviceId) => invoke('zsense:device-link:unpair', deviceId),
    setPeerAccess: (request) => invoke('zsense:device-link:set-peer-access', request),
    remoteStatus: (deviceId) => invoke('zsense:device-link:remote-status', deviceId),
    remoteRun: (request) => invoke('zsense:device-link:remote-run', request),
    onChanged: (callback) => {
      const listener = (_event, status) => callback(status)
      ipcRenderer.on('zsense:device-link:changed', listener)
      return () => ipcRenderer.removeListener('zsense:device-link:changed', listener)
    },
  }),
  webBridge: Object.freeze({
    status: () => invoke('zsense:web-bridge:status'),
    setEnabled: (enabled) => invoke('zsense:web-bridge:set-enabled', enabled),
    rotateCode: () => invoke('zsense:web-bridge:rotate-code'),
    revokeSession: (token) => invoke('zsense:web-bridge:revoke-session', token),
    onChanged: (callback) => {
      const listener = (_event, status) => callback(status)
      ipcRenderer.on('zsense:web-bridge:changed', listener)
      return () => ipcRenderer.removeListener('zsense:web-bridge:changed', listener)
    },
  }),
  update: Object.freeze({
    status: () => invoke('zsense:update:status'),
    check: (feedUrl) => invoke('zsense:update:check', feedUrl || ''),
    openDownload: (url) => invoke('zsense:update:open-download', url),
  }),
  pdf: Object.freeze({
    openExternally: (filePath) => invoke('zsense:pdf:open-external', filePath),
    read: (filePath) => invoke('zsense:pdf:read', filePath),
    readChunk: (request) => invoke('zsense:pdf:read-chunk', request),
    save: (request) => invoke('zsense:pdf:save', request),
    saveAs: (request) => invoke('zsense:pdf:save-as', request),
    pageAction: (request) => invoke('zsense:pdf:page-action', request),
  }),
  browser: Object.freeze({
    register: (sessionId, webContentsId) => invoke('zsense:browser:register', { sessionId, webContentsId }),
    unregister: (sessionId, webContentsId) => invoke('zsense:browser:unregister', { sessionId, webContentsId }),
    activate: (sessionId) => invoke('zsense:browser:activate', sessionId),
    close: (sessionId) => invoke('zsense:browser:close', sessionId),
    capture: (sessionId) => invoke('zsense:browser:capture', sessionId),
    state: () => invoke('zsense:browser:state'),
    clearData: () => invoke('zsense:browser:clear-data'),
    clearHistory: (kind) => invoke('zsense:browser:clear-history', kind),
    pickDownloadDirectory: () => invoke('zsense:browser:pick-download-directory'),
    setSitePermission: (permission) => invoke('zsense:browser:set-site-permission', permission),
    removeSitePermission: (origin) => invoke('zsense:browser:remove-site-permission', origin),
    openExternal: (url) => invoke('zsense:browser:open-external', url),
    onActivity: (callback) => {
      const listener = (_event, activity) => callback(activity)
      ipcRenderer.on('zsense:browser:activity', listener)
      return () => ipcRenderer.removeListener('zsense:browser:activity', listener)
    },
  }),
  screenshot: Object.freeze({
    captureRegion: (rectangle) => invoke('zsense:screenshot:capture-region', rectangle),
    globalStatus: () => invoke('zsense:global-screenshot:status').then((data) => ({ ok: true, data })),
    setGlobalShortcut: (shortcut) => invoke('zsense:global-screenshot:set-shortcut', shortcut).then((data) => ({ ok: true, data })),
    startGlobal: () => invoke('zsense:global-screenshot:start').then((data) => ({ ok: true, data })),
    onGlobalError: (callback) => {
      const listener = (_event, message) => callback(message)
      ipcRenderer.on('zsense:global-screenshot:error', listener)
      return () => ipcRenderer.removeListener('zsense:global-screenshot:error', listener)
    },
  }),
  auth: Object.freeze({
    status: () => invoke('zsense:auth:status'),
    lock: () => invoke('zsense:auth:lock'),
    unlock: (password) => invoke('zsense:auth:unlock', { password }),
    setLockPassword: (password) => invoke('zsense:auth:set-lock-password', { password }),
    emailStatus: () => invoke('zsense:auth:email:status'),
    accountPasswordStatus: () => invoke('zsense:auth:account-password:status'),
    setAccountPassword: (password) => invoke('zsense:auth:account-password:set', { password }),
    setEmail: (email) => invoke('zsense:auth:email:set', { email }),
    sendBindCode: (email) => invoke('zsense:auth:email:bind-send', { email }),
    verifyBindCode: (input) => invoke('zsense:auth:email:bind-verify', input),
    sendResetCode: () => invoke('zsense:auth:email:send-code'),
    resetLockPassword: (input) => invoke('zsense:auth:email:reset', input),
    onLocked: (callback) => {
      const listener = (_event, status) => callback(status)
      ipcRenderer.on('zsense:auth:locked', listener)
      return () => ipcRenderer.removeListener('zsense:auth:locked', listener)
    },
    users: Object.freeze({
      list: () => invoke('zsense:auth:users:list'),
      create: (input) => invoke('zsense:auth:users:create', input),
      update: (input) => invoke('zsense:auth:users:update', input),
      delete: (userId) => invoke('zsense:auth:users:delete', userId),
    }),
  }),
  onboarding: Object.freeze({
    status: () => invoke('zsense:onboarding:status'),
    setName: (displayName, username) => invoke('zsense:onboarding:set-name', { displayName, username }),
    complete: () => invoke('zsense:onboarding:complete'),
  }),
  data: Object.freeze({
    loadWorkspace: () => invoke('zsense:data:load'),
    loadWorkspaceSummary: () => invoke('zsense:data:load-summary'),
    loadConversation: (conversationId) => invoke('zsense:data:conversation', conversationId),
    conversationTimestamps: () => invoke('zsense:data:conversation-timestamps'),
    syncMessages: () => invoke('zsense:data:sync-messages'),
    onChanged: (callback) => {
      const listener = (_event, snapshot) => callback(snapshot)
      ipcRenderer.on('zsense:data:changed', listener)
      return () => ipcRenderer.removeListener('zsense:data:changed', listener)
    },
  }),
  officeTasks: Object.freeze({
    list: (filter = {}) => invoke('zsense:office-tasks:list', filter),
    search: (botId, query) => invoke('zsense:office-tasks:search', { botId, query }),
    deliver: (taskId) => invoke('zsense:office-tasks:deliver', taskId),
    onChanged: (callback) => {
      const listener = () => callback()
      ipcRenderer.on('zsense:office-tasks:changed', listener)
      return () => ipcRenderer.removeListener('zsense:office-tasks:changed', listener)
    },
  }),
  dws: Object.freeze({
    status: () => invoke('zsense:dws:auth-status'),
    login: () => invoke('zsense:dws:auth-login'),
  }),
  office: Object.freeze({
    apiVersion: 7,
    status: () => invoke('zsense:office:status'),
    recent: () => invoke('zsense:office:recent'),
    pick: () => invoke('zsense:office:pick'),
    open: (filePath) => invoke('zsense:office:open', filePath),
    inlineImage: (request) => invoke('zsense:office:inline-image', request),
    refresh: (filePath) => invoke('zsense:office:refresh', filePath),
    imageThumbnail: (filePath) => invoke('zsense:office:image-thumbnail', filePath),
    getSheet: (request) => invoke('zsense:office:get-sheet', request),
    getWorkbook: (request) => invoke('zsense:office:get-workbook', request),
    stageCells: (request) => invoke('zsense:office:stage-cells', request),
    stageOperations: (request) => invoke('zsense:office:stage-operations', request),
    getWord: (request) => invoke('zsense:office:get-word', request),
    stageWordOperations: (request) => invoke('zsense:office:stage-word-operations', request),
    saveWord: (request) => invoke('zsense:office:save-word', request),
    discardWord: (request) => invoke('zsense:office:discard-word', request),
    getHtml: (request) => invoke('zsense:office:get-html', request),
    stageHtml: (request) => invoke('zsense:office:stage-html', request),
    saveHtml: (request) => invoke('zsense:office:save-html', request),
    discardHtml: (request) => invoke('zsense:office:discard-html', request),
    pickSpreadsheetImage: () => invoke('zsense:office:pick-spreadsheet-image'),
    pickHtmlImage: () => invoke('zsense:office:pick-html-image'),
    pickWordImage: () => invoke('zsense:office:pick-word-image'),
    saveWorkbook: (request) => invoke('zsense:office:save-workbook', request),
    discardWorkbook: (request) => invoke('zsense:office:discard-workbook', request),
    onSessionChanged: (callback) => {
      const listener = (_event, sessionEvent) => callback(sessionEvent)
      ipcRenderer.on('zsense:office:session-changed', listener)
      return () => ipcRenderer.removeListener('zsense:office:session-changed', listener)
    },
    replaceText: (request) => invoke('zsense:office:replace-text', request),
    setCell: (request) => invoke('zsense:office:set-cell', request),
    setCells: (request) => invoke('zsense:office:set-cells', request),
    openExternally: (filePath) => invoke('zsense:office:open-external', filePath),
    reveal: (filePath) => invoke('zsense:office:reveal', filePath),
  }),
  bots: Object.freeze({
    create: (bot) => invoke('zsense:bots:create', bot),
    duplicate: (sourceBotId, duplicateBotId) => invoke('zsense:bots:duplicate', { sourceBotId, duplicateBotId }),
    update: (bot) => invoke('zsense:bots:update', bot),
    delete: (botId) => invoke('zsense:bots:delete', botId),
  }),
  memories: Object.freeze({
    status: () => invoke('zsense:memories:status'),
    create: (botId, memory) => invoke('zsense:memories:create', { botId, memory }),
    update: (botId, memory) => invoke('zsense:memories:update', { botId, memory }),
    delete: (botId, memoryId) => invoke('zsense:memories:delete', { botId, memoryId }),
  }),
  gatewayConnections: Object.freeze({
    save: (configuration) => invoke('zsense:gateway-connections:save', configuration),
    delete: (connectionId) => invoke('zsense:gateway-connections:delete', connectionId),
    pairings: (connectionId) => invoke('zsense:gateway-connections:pairings', connectionId),
    authorizedUsers: (connectionId) => invoke('zsense:gateway-connections:authorized-users', connectionId),
    renameAuthorizedUser: (connectionId, userId, userName) => invoke('zsense:gateway-connections:rename-authorized-user', { connectionId, userId, userName }),
    approvePairing: (connectionId, requestId) => invoke('zsense:gateway-connections:approve-pairing', { connectionId, requestId }),
    startWeixinLogin: (botId) => invoke('zsense:gateway-connections:weixin-login-start', { botId }),
    getWeixinLoginStatus: (loginId) => invoke('zsense:gateway-connections:weixin-login-status', loginId),
    cancelWeixinLogin: (loginId) => invoke('zsense:gateway-connections:weixin-login-cancel', loginId),
  }),
  conversations: Object.freeze({
    rename: (conversationId, title) => invoke('zsense:conversations:rename', { conversationId, title }),
    archive: (conversationId, archived) => invoke('zsense:conversations:archive', { conversationId, archived }),
    setWorkspace: (conversationId, workspacePath) => invoke('zsense:conversations:set-workspace', { conversationId, workspacePath }),
    deleteMessage: (conversationId, messageId) => invoke('zsense:conversations:delete-message', { conversationId, messageId }),
    delete: (conversationId) => invoke('zsense:conversations:delete', conversationId),
    moveGroup: (conversationId, groupId) => invoke('zsense:conversations:move-group', { conversationId, groupId }),
    reorder: (botId, orderedIds) => invoke('zsense:conversations:reorder', { botId, orderedIds }),
  }),
  conversationGroups: Object.freeze({
    create: (botId, name) => invoke('zsense:conversation-groups:create', { botId, name }),
    rename: (groupId, name) => invoke('zsense:conversation-groups:rename', { groupId, name }),
    delete: (groupId) => invoke('zsense:conversation-groups:delete', groupId),
    setCollapsed: (groupId, collapsed) => invoke('zsense:conversation-groups:set-collapsed', { groupId, collapsed }),
  }),
  skills: Object.freeze({
    create: (skill) => invoke('zsense:skills:create', skill),
    update: (skill) => invoke('zsense:skills:update', skill),
    toggle: (skillId, enabled) => invoke('zsense:skills:toggle', { id: skillId, enabled }),
    assign: (skillId, botIds) => invoke('zsense:skills:assign', { skillId, botIds }),
    delete: (skillId) => invoke('zsense:skills:delete', skillId),
    import: (mode) => invoke('zsense:skills:import', mode),
    openFolder: (skillId) => invoke('zsense:skills:open-folder', skillId),
    checkUpdates: () => invoke('zsense:skills:check-updates'),
    updateRegistry: (skillId) => invoke('zsense:skills:update-registry', skillId),
    restoreVersion: (skillId, versionId) => invoke('zsense:skills:restore-version', { skillId, versionId }),
  }),
  settings: Object.freeze({
    update: (settings) => invoke('zsense:settings:update', settings),
  }),
  configuration: Object.freeze({
    export: () => invoke('zsense:configuration:export'),
    import: () => invoke('zsense:configuration:import'),
  }),
  capabilities: Object.freeze({
    status: () => invoke('zsense:capabilities:status'),
    autonomy: () => invoke('zsense:capabilities:autonomy'),
    manageAutonomy: (kind, id, action) => invoke('zsense:capabilities:autonomy-manage', { kind, id, action }),
    revokeApproval: (id) => invoke('zsense:capabilities:approval-revoke', id),
  }),
  computerUse: Object.freeze({
    status: () => invoke('zsense:computer-use:status'),
    requestPermissions: () => invoke('zsense:computer-use:request-permissions'),
  }),
  mcp: Object.freeze({
    list: () => invoke('zsense:mcp:list'),
    configure: (configuration) => invoke('zsense:mcp:configure', configuration),
    delete: (id) => invoke('zsense:mcp:delete', id),
    test: (id) => invoke('zsense:mcp:test', id),
  }),
  canvas: Object.freeze({
    load: (workspacePath) => invoke('zsense:canvas:load', workspacePath),
    save: (workspacePath, document, clientId) => invoke('zsense:canvas:save', { workspacePath, document, clientId }),
    importFile: (workspacePath, filePath, clientId, document, conversationId) => invoke('zsense:canvas:import-file', { workspacePath, filePath, clientId, document, conversationId }),
    onChanged: (callback) => {
      const listener = (_event, change) => callback(change)
      ipcRenderer.on('zsense:canvas:changed', listener)
      return () => ipcRenderer.removeListener('zsense:canvas:changed', listener)
    },
  }),
  tasks: Object.freeze({
    create: (task) => invoke('zsense:tasks:create', task),
    update: (id, task) => invoke('zsense:tasks:update', { id, task }),
    toggle: (id, enabled) => invoke('zsense:tasks:toggle', { id, enabled }),
    delete: (id) => invoke('zsense:tasks:delete', id),
    deleteRun: (id) => invoke('zsense:tasks:delete-run', id),
    runNow: (id) => invoke('zsense:tasks:run-now', id),
    setOverviewVisibility: (id, visible) => invoke('zsense:tasks:set-overview-visibility', { id, visible }),
    pickWorkspace: () => invoke('zsense:tasks:pick-workspace'),
    openWorkspace: (id) => invoke('zsense:tasks:open-workspace', id),
  }),
  notifications: Object.freeze({
    test: (kind) => invoke('zsense:notifications:test', kind),
  }),
  voiceWake: Object.freeze({
    status: () => invoke('zsense:voice-wake:status'),
    requestPermission: () => invoke('zsense:voice-wake:request-permission'),
    start: (configuration) => invoke('zsense:voice-wake:start', configuration),
    feed: (pcm) => invoke('zsense:voice-wake:feed', { pcm }),
    detected: (event) => invoke('zsense:voice-wake:detected-client', event),
    stop: () => invoke('zsense:voice-wake:stop'),
    onStatusChanged: (callback) => {
      const listener = (_event, status) => callback(status)
      ipcRenderer.on('zsense:voice-wake:status-changed', listener)
      return () => ipcRenderer.removeListener('zsense:voice-wake:status-changed', listener)
    },
    onDetected: (callback) => {
      const listener = (_event, detected) => callback(detected)
      ipcRenderer.on('zsense:voice-wake:detected', listener)
      return () => ipcRenderer.removeListener('zsense:voice-wake:detected', listener)
    },
  }),
  voice: Object.freeze({
    transcribeLocal: (request) => invoke('zsense:voice:transcribe-local', request),
    listVoices: () => invoke('zsense:voice:list-voices'),
    ttsConfig: () => invoke('zsense:voice:tts-config'),
    stopSpeaking: () => invoke('zsense:voice:stop-speaking'),
  }),
  models: Object.freeze({
    list: (request) => invoke('zsense:models:list', request),
    update: (configuration) => invoke('zsense:models:update', configuration),
  }),
  runtime: Object.freeze({
    inspect: () => invoke('zsense:runtime:inspect'),
    onStatusChanged: (callback) => {
      const listener = (_event, status) => callback(status)
      ipcRenderer.on('zsense:runtime:status-changed', listener)
      return () => ipcRenderer.removeListener('zsense:runtime:status-changed', listener)
    },
    doctor: () => invoke('zsense:runtime:doctor'),
  }),
  chat: Object.freeze({
    pickAttachments: () => invoke('zsense:chat:pick-attachments'),
    resolveDroppedAttachments: (files) => invoke('zsense:chat:resolve-dropped-attachments', Array.from(files || [], (file) => webUtils.getPathForFile(file)).filter(Boolean)),
    resolvePastedAttachments: async (files, workspacePath) => invoke('zsense:chat:resolve-pasted-attachments', {
      workspacePath,
      files: await Promise.all(Array.from(files || [], async (file) => ({
        name: file.name || '',
        mimeType: file.type || '',
        bytes: await file.arrayBuffer(),
      }))),
    }),
    pickWorkspace: () => invoke('zsense:chat:pick-workspace'),
    listWorkspaceDirectories: (directoryPath = '') => invoke('zsense:chat:list-workspace-directories', directoryPath),
    send: (request) => invoke('zsense:chat:send', request),
    steer: (requestId, message, attachments = [], workspacePath = '') => invoke('zsense:chat:steer', { requestId, message, attachments, workspacePath }),
    cancel: (requestId) => invoke('zsense:chat:cancel', requestId),
    clarify: (requestId, clarificationRequestId, answers) => invoke('zsense:chat:clarify', { requestId, clarificationRequestId, answers }),
    deleteNative: (conversationId) => invoke('zsense:chat:delete-native', conversationId),
    onEvent: (callback) => {
      const listener = (_event, streamEvent) => callback(streamEvent)
      ipcRenderer.on('zsense:chat:event', listener)
      return () => ipcRenderer.removeListener('zsense:chat:event', listener)
    },
  }),
}))
