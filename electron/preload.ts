import { contextBridge, ipcRenderer } from 'electron'
import { IPC_EVENTS } from '../shared/ipc-channels'
import type {
  CharacterAPI,
  ChatAPI,
  SettingsAPI,
  LorebookAPI,
  EmbeddingAPI,
  QuickReplyAPI,
  PresetAPI,
  AIAPI,
  TTSAPI,
  ImageGenAPI,
  FileAPI,
  FontAPI,
  RegexAPI,
  PersonaAPI,
  LogAPI,
  UsageAPI,
  McpAPI,
  AnnouncementAPI,
  GroupChatAPI,
  SessionSyncAPI,
  BridgeAPI,
} from '../shared/ipc-api'

// ---- AI 调用 ----
const aiApi: AIAPI = {
  chat: (params) => ipcRenderer.invoke('ai:chat', params),
  cancelChat: (requestId) => ipcRenderer.invoke('ai:cancel', requestId),
  testConnection: (config) => ipcRenderer.invoke('ai:testConnection', config),
  listModels: (provider, baseUrl, apiKey) => ipcRenderer.invoke('ai:listModels', provider, baseUrl, apiKey),
  countTokens: (text, model) => ipcRenderer.invoke('ai:countTokens', text, model),
  countMessagesTokens: (messages, model) => ipcRenderer.invoke('ai:countMessagesTokens', messages, model),
  onChunk: (callback) => {
    const handler = (_e: unknown, data: { requestId: string; text: string }) => callback(data)
    ipcRenderer.on(IPC_EVENTS.aiChunk, handler)
    return () => ipcRenderer.removeListener(IPC_EVENTS.aiChunk, handler)
  },
  onDone: (callback) => {
    const handler = (_e: unknown, requestId: string) => callback(requestId)
    ipcRenderer.on(IPC_EVENTS.aiDone, handler)
    return () => ipcRenderer.removeListener(IPC_EVENTS.aiDone, handler)
  },
  onError: (callback) => {
    const handler = (_e: unknown, data: { requestId: string; error: string }) => callback(data)
    ipcRenderer.on(IPC_EVENTS.aiError, handler)
    return () => ipcRenderer.removeListener(IPC_EVENTS.aiError, handler)
  },
  onUsage: (callback) => {
    const handler = (_e: unknown, data: { requestId: string; promptTokens: number; completionTokens: number; totalTokens: number }) => callback(data)
    ipcRenderer.on(IPC_EVENTS.aiUsage, handler)
    return () => ipcRenderer.removeListener(IPC_EVENTS.aiUsage, handler)
  },
}

// ---- 会话变更事件总线（阶段 0c） ----
const sessionSyncApi: SessionSyncAPI = {
  changed: (payload) => {
    ipcRenderer.send(IPC_EVENTS.sessionChanged, payload)
  },
  onUpdated: (callback) => {
    const handler = (_e: unknown, payload: Parameters<typeof callback>[0]) => callback(payload)
    ipcRenderer.on(IPC_EVENTS.sessionUpdated, handler)
    return () => ipcRenderer.removeListener(IPC_EVENTS.sessionUpdated, handler)
  },
}

// ---- 桥接层（阶段一：手机连接） ----
const bridgeApi: BridgeAPI = {
  status: () => ipcRenderer.invoke('bridge:status'),
  start: () => ipcRenderer.invoke('bridge:start'),
  stop: () => ipcRenderer.invoke('bridge:stop'),
  setConfig: (partial) => ipcRenderer.invoke('bridge:config', partial),
  pairingInfo: () => ipcRenderer.invoke('bridge:pairingInfo'),
  regeneratePairing: () => ipcRenderer.invoke('bridge:pairingInfo', true),
  listDevices: () => ipcRenderer.invoke('bridge:listDevices'),
  revokeDevice: (deviceId) => ipcRenderer.invoke('bridge:revokeDevice', deviceId),
  approvePair: (requestId) => ipcRenderer.invoke('bridge:approvePair', requestId),
  rejectPair: (requestId) => ipcRenderer.invoke('bridge:rejectPair', requestId),
  onPairRequest: (callback) => {
    const handler = (_e: unknown, data: { requestId: string; deviceName: string }) => callback(data)
    ipcRenderer.on('bridge:pairRequest', handler)
    return () => ipcRenderer.removeListener('bridge:pairRequest', handler)
  },
  wipeAll: () => ipcRenderer.invoke('bridge:wipeAll'),
}

// ---- 角色卡 ----
const characterApi: CharacterAPI = {  list: () => ipcRenderer.invoke('character:list'),
  get: (id) => ipcRenderer.invoke('character:get', id),
  save: (character) => ipcRenderer.invoke('character:save', character),
  delete: (id) => ipcRenderer.invoke('character:delete', id),
  importPng: () => ipcRenderer.invoke('character:importPng'),
  importJson: () => ipcRenderer.invoke('character:importJson'),
  importBatch: () => ipcRenderer.invoke('character:importBatch'),
  bindLorebook: (characterId, lorebookId) => ipcRenderer.invoke('character:bindLorebook', characterId, lorebookId),
  exportPng: (id) => ipcRenderer.invoke('character:exportPng', id),
  exportJson: (id) => ipcRenderer.invoke('character:exportJson', id),
  reloadAvatar: (characterId, url) => ipcRenderer.invoke('character:reloadAvatar', characterId, url),
  onImportProgress: (callback) => {
    const handler = (_e: unknown, data: { current: number; total: number; fileName: string; status: 'processing' | 'done' | 'error' }) => callback(data)
    ipcRenderer.on(IPC_EVENTS.characterImportProgress, handler)
    return () => ipcRenderer.removeListener(IPC_EVENTS.characterImportProgress, handler)
  },
}

// ---- 对话 ----
const chatApi: ChatAPI = {
  listSessions: (characterId) => ipcRenderer.invoke('chat:listSessions', characterId),
  createSession: (characterId, title, personaId, lorebookIds) => ipcRenderer.invoke('chat:createSession', characterId, title, personaId, lorebookIds),
  deleteSession: (characterId, sessionId) => ipcRenderer.invoke('chat:deleteSession', characterId, sessionId),
  renameSession: (characterId, sessionId, title) => ipcRenderer.invoke('chat:renameSession', characterId, sessionId, title),
  updateSession: (characterId, sessionId, updates) => ipcRenderer.invoke('chat:updateSession', characterId, sessionId, updates),
  listMessages: (characterId, sessionId) => ipcRenderer.invoke('chat:listMessages', characterId, sessionId),
  saveMessage: (message) => ipcRenderer.invoke('chat:saveMessage', message),
  deleteMessage: (id, characterId, sessionId) => ipcRenderer.invoke('chat:deleteMessage', { id, characterId, sessionId }),
  clearChat: (characterId, sessionId) => ipcRenderer.invoke('chat:clearChat', characterId, sessionId),
  exportChat: (characterId, sessionId, format) => ipcRenderer.invoke('chat:exportChat', characterId, sessionId, format),
  updateMemory: (characterId, sessionId, memory) => ipcRenderer.invoke('chat:updateMemory', characterId, sessionId, memory),
  toggleMemory: (characterId, sessionId, enabled) => ipcRenderer.invoke('chat:toggleMemory', characterId, sessionId, enabled),
  setMemoryMode: (characterId, sessionId, mode, interval) => ipcRenderer.invoke('chat:setMemoryMode', characterId, sessionId, mode, interval),
  getStats: (characterId, sessionId) => ipcRenderer.invoke('chat:getStats', characterId, sessionId),
}

// ---- 设置 ----
const settingsApi: SettingsAPI = {
  get: () => ipcRenderer.invoke('settings:get'),
  save: (settings) => ipcRenderer.invoke('settings:save', settings),
  saveAPICredential: (provider, key) => ipcRenderer.invoke('settings:saveCredential', provider, key),
  getAPICredential: (provider) => ipcRenderer.invoke('settings:getCredential', provider),
  exportBackup: () => ipcRenderer.invoke('settings:exportBackup'),
  importBackup: () => ipcRenderer.invoke('settings:importBackup'),
}

// ---- 世界书 ----
const lorebookApi: LorebookAPI = {
  list: () => ipcRenderer.invoke('lorebook:list'),
  save: (lorebook) => ipcRenderer.invoke('lorebook:save', lorebook),
  delete: (id) => ipcRenderer.invoke('lorebook:delete', id),
  importJson: () => ipcRenderer.invoke('lorebook:importJson'),
}

// ---- 语义触发（向量 RAG）----
const embeddingApi: EmbeddingAPI = {
  test: (config) => ipcRenderer.invoke('embedding:test', config),
  indexLorebook: (lorebookId, config) => ipcRenderer.invoke('embedding:indexLorebook', lorebookId, config),
  indexStatus: (lorebookIds) => ipcRenderer.invoke('embedding:indexStatus', lorebookIds),
  removeIndex: (lorebookId) => ipcRenderer.invoke('embedding:removeIndex', lorebookId),
  semanticSearch: (payload) => ipcRenderer.invoke('embedding:semanticSearch', payload),
  embedFacts: (config, texts) => ipcRenderer.invoke('embedding:embedFacts', config, texts),
  searchFacts: (payload) => ipcRenderer.invoke('embedding:searchFacts', payload),
}

// ---- 快捷回复 ----
const quickReplyApi: QuickReplyAPI = {
  listAll: () => ipcRenderer.invoke('quickReply:listAll'),
  saveAll: (store) => ipcRenderer.invoke('quickReply:saveAll', store),
  clearCharacter: (characterId) => ipcRenderer.invoke('quickReply:clearCharacter', characterId),
  exportJson: () => ipcRenderer.invoke('quickReply:exportJson'),
  importJson: () => ipcRenderer.invoke('quickReply:importJson'),
}

// ---- 预设 ----
const presetApi: PresetAPI = {
  list: () => ipcRenderer.invoke('preset:list'),
  save: (preset) => ipcRenderer.invoke('preset:save', preset),
  delete: (id) => ipcRenderer.invoke('preset:delete', id),
  importJson: () => ipcRenderer.invoke('preset:importJson'),
  exportJson: (id) => ipcRenderer.invoke('preset:exportJson', id),
}

// ---- TTS ----
const ttsApi: TTSAPI = {
  speak: (text, options) => ipcRenderer.invoke('tts:speak', text, options),
  stop: () => ipcRenderer.invoke('tts:stop'),
  pause: () => ipcRenderer.invoke('tts:pause'),
  resume: () => ipcRenderer.invoke('tts:resume'),
  getState: () => ipcRenderer.invoke('tts:getState'),
  onState: (callback) => {
    const handler = (_e: unknown, state: 'idle' | 'speaking' | 'paused') => callback(state)
    ipcRenderer.on('tts:state', handler)
    return () => ipcRenderer.removeListener('tts:state', handler)
  },
  listVoices: (provider) => ipcRenderer.invoke('tts:getVoices', provider),
}

// ---- 文生图 ----
const imageGenApi: ImageGenAPI = {
  generate: (prompt, options) => ipcRenderer.invoke('imageGen:generate', prompt, options),
  testConnection: (config) => ipcRenderer.invoke('imageGen:testConnection', config),
}

// ---- 文件 ----
const fileApi: FileAPI = {
  selectImage: () => ipcRenderer.invoke('file:selectImage'),
  readImageAsBase64: (path) => ipcRenderer.invoke('file:readImageBase64', path),
}

// ---- 字体 ----
const fontApi: FontAPI = {
  selectFont: () => ipcRenderer.invoke('font:select'),
  saveFont: (filePath) => ipcRenderer.invoke('font:save', filePath),
  listFonts: () => ipcRenderer.invoke('font:list'),
  deleteFont: (id) => ipcRenderer.invoke('font:delete', id),
  getFontPath: (id) => ipcRenderer.invoke('font:getPath', id),
}

// ---- 正则表达式 ----
const regexApi: RegexAPI = {
  list: () => ipcRenderer.invoke('regex:list'),
  save: (rule) => ipcRenderer.invoke('regex:save', rule),
  delete: (id) => ipcRenderer.invoke('regex:delete', id),
  create: (name) => ipcRenderer.invoke('regex:create', name),
}

// ---- 用户身份 ----
const personaApi: PersonaAPI = {
  list: () => ipcRenderer.invoke('persona:list'),
  save: (persona) => ipcRenderer.invoke('persona:save', persona),
  delete: (id) => ipcRenderer.invoke('persona:delete', id),
  createDefault: (name) => ipcRenderer.invoke('persona:createDefault', name),
}

// ---- 日志 ----
const logApi: LogAPI = {
  write: (level, mod, message, meta) => ipcRenderer.invoke('log:write', level, mod, message, meta),
  getRecent: (limit) => ipcRenderer.invoke('log:getRecent', limit || 200),
}

// ---- 用量统计 ----
const usageApi: UsageAPI = {
  record: (record) => ipcRenderer.invoke('usage:record', record),
  query: (filter) => ipcRenderer.invoke('usage:query', filter),
  aggregate: (filter, groupBy) => ipcRenderer.invoke('usage:aggregate', filter, groupBy),
  summary: (filter) => ipcRenderer.invoke('usage:summary', filter),
  clear: () => ipcRenderer.invoke('usage:clear'),
}

// ---- MCP 工具 ----
const mcpApi: McpAPI = {
  listServers: () => ipcRenderer.invoke('mcp:listServers'),
  listServerStatuses: () => ipcRenderer.invoke('mcp:listServerStatuses'),
  addServer: (config) => ipcRenderer.invoke('mcp:addServer', config),
  updateServer: (id, patch) => ipcRenderer.invoke('mcp:updateServer', id, patch),
  removeServer: (id) => ipcRenderer.invoke('mcp:removeServer', id),
  startServer: (id) => ipcRenderer.invoke('mcp:startServer', id),
  stopServer: (id) => ipcRenderer.invoke('mcp:stopServer', id),
  listTools: () => ipcRenderer.invoke('mcp:listTools'),
  callTool: (serverId, toolName, args) => ipcRenderer.invoke('mcp:callTool', serverId, toolName, args),
}

// ---- 在线公告 ----
const announcementApi: AnnouncementAPI = {
  fetchList: (page, pageSize) => ipcRenderer.invoke('announcement:fetchList', page, pageSize),
  fetchDetail: (id) => ipcRenderer.invoke('announcement:fetchDetail', id),
  getServerUrl: () => ipcRenderer.invoke('announcement:getServerUrl'),
  setServerUrl: (url) => ipcRenderer.invoke('announcement:setServerUrl', url),
}

// ---- 群聊 ----

/** 群聊 API（类型来自 shared/ipc-api 的 GroupChatAPI，参数自动获得类型） */
const groupApi: GroupChatAPI = {
  list: () => ipcRenderer.invoke('group:list'),
  save: (group) => ipcRenderer.invoke('group:save', group),
  delete: (id) => ipcRenderer.invoke('group:delete', id),
  listSessions: (groupId) => ipcRenderer.invoke('group:listSessions', groupId),
  createSession: (groupId) => ipcRenderer.invoke('group:createSession', groupId),
  deleteSession: (groupId, sessionId) => ipcRenderer.invoke('group:deleteSession', groupId, sessionId),
  renameSession: (groupId, sessionId, title) => ipcRenderer.invoke('group:renameSession', groupId, sessionId, title),
  listMessages: (groupId, sessionId) => ipcRenderer.invoke('group:listMessages', groupId, sessionId),
  saveMessage: (groupId, sessionId, msg) => ipcRenderer.invoke('group:saveMessage', groupId, sessionId, msg),
  saveMessagesBatch: (groupId, sessionId, msgs) => ipcRenderer.invoke('group:saveMessagesBatch', groupId, sessionId, msgs),
  editMessage: (groupId, sessionId, messageId, content) => ipcRenderer.invoke('group:editMessage', groupId, sessionId, messageId, content),
  deleteMessage: (groupId, sessionId, messageId) => ipcRenderer.invoke('group:deleteMessage', groupId, sessionId, messageId),
  clearChat: (groupId, sessionId?) => ipcRenderer.invoke('group:clearChat', groupId, sessionId),
  exportChat: (groupId, sessionId, format) => ipcRenderer.invoke('group:exportChat', groupId, sessionId, format),
  updateMemory: (groupId, sessionId, memory) => ipcRenderer.invoke('group:updateMemory', groupId, sessionId, memory),
  toggleMemory: (groupId, sessionId, enabled) => ipcRenderer.invoke('group:toggleMemory', groupId, sessionId, enabled),
  setMemoryMode: (groupId, sessionId, mode, interval) => ipcRenderer.invoke('group:setMemoryMode', groupId, sessionId, mode, interval),
  updateSession: (groupId, sessionId, updates) => ipcRenderer.invoke('group:updateSession', groupId, sessionId, updates),
}

contextBridge.exposeInMainWorld('api', {
  ai: aiApi,
  character: characterApi,
  chat: chatApi,
  settings: settingsApi,
  lorebook: lorebookApi,
  embedding: embeddingApi,
  quickReply: quickReplyApi,
  preset: presetApi,
  tts: ttsApi,
  imageGen: imageGenApi,
  regex: regexApi,
  persona: personaApi,
  file: fileApi,
  font: fontApi,
  log: logApi,
  usage: usageApi,
  mcp: mcpApi,
  announcement: announcementApi,
  group: groupApi,
  sessionSync: sessionSyncApi,
  bridge: bridgeApi,
  app: {
    getVersion: () => ipcRenderer.invoke('app:getVersion'),
    checkVersion: () => ipcRenderer.invoke('app:checkVersion'),
    openExternal: (url: string) => ipcRenderer.invoke('app:openExternal', url),
  },
})
