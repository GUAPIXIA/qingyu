import { contextBridge, ipcRenderer } from 'electron'
import type {
  CharacterAPI,
  ChatAPI,
  SettingsAPI,
  LorebookAPI,
  PresetAPI,
  AIAPI,
  TTSAPI,
  ImageGenAPI,
  FileAPI,
  RegexAPI,
  PersonaAPI,
  LogAPI,
  UsageAPI,
  McpAPI,
} from '../shared/ipc-api'

// ---- AI 调用 ----
const aiApi: AIAPI = {
  chat: (params) => ipcRenderer.invoke('ai:chat', params),
  cancelChat: (requestId) => ipcRenderer.invoke('ai:cancel', requestId),
  testConnection: (config) => ipcRenderer.invoke('ai:testConnection', config),
  countTokens: (text, model) => ipcRenderer.invoke('ai:countTokens', text, model),
  countMessagesTokens: (messages, model) => ipcRenderer.invoke('ai:countMessagesTokens', messages, model),
  onChunk: (callback) => {
    const handler = (_e: unknown, data: { requestId: string; text: string }) => callback(data)
    ipcRenderer.on('ai:chunk', handler)
    return () => ipcRenderer.removeListener('ai:chunk', handler)
  },
  onDone: (callback) => {
    const handler = (_e: unknown, requestId: string) => callback(requestId)
    ipcRenderer.on('ai:done', handler)
    return () => ipcRenderer.removeListener('ai:done', handler)
  },
  onError: (callback) => {
    const handler = (_e: unknown, data: { requestId: string; error: string }) => callback(data)
    ipcRenderer.on('ai:error', handler)
    return () => ipcRenderer.removeListener('ai:error', handler)
  },
  onUsage: (callback) => {
    const handler = (_e: unknown, data: { requestId: string; promptTokens: number; completionTokens: number; totalTokens: number }) => callback(data)
    ipcRenderer.on('ai:usage', handler)
    return () => ipcRenderer.removeListener('ai:usage', handler)
  },
}

// ---- 角色卡 ----
const characterApi: CharacterAPI = {
  list: () => ipcRenderer.invoke('character:list'),
  get: (id) => ipcRenderer.invoke('character:get', id),
  save: (character) => ipcRenderer.invoke('character:save', character),
  delete: (id) => ipcRenderer.invoke('character:delete', id),
  importPng: () => ipcRenderer.invoke('character:importPng'),
  importJson: () => ipcRenderer.invoke('character:importJson'),
  importBatch: () => ipcRenderer.invoke('character:importBatch'),
  exportPng: (id) => ipcRenderer.invoke('character:exportPng', id),
  exportJson: (id) => ipcRenderer.invoke('character:exportJson', id),
  reloadAvatar: (characterId, url) => ipcRenderer.invoke('character:reloadAvatar', characterId, url),
  onImportProgress: (callback) => {
    const handler = (_e: unknown, data: { current: number; total: number; fileName: string; status: 'processing' | 'done' | 'error' }) => callback(data)
    ipcRenderer.on('character:importProgress', handler)
    return () => ipcRenderer.removeListener('character:importProgress', handler)
  },
}

// ---- 对话 ----
const chatApi: ChatAPI = {
  listSessions: (characterId) => ipcRenderer.invoke('chat:listSessions', characterId),
  createSession: (characterId, title) => ipcRenderer.invoke('chat:createSession', characterId, title),
  deleteSession: (characterId, sessionId) => ipcRenderer.invoke('chat:deleteSession', characterId, sessionId),
  renameSession: (characterId, sessionId, title) => ipcRenderer.invoke('chat:renameSession', characterId, sessionId, title),
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

// ---- 预设 ----
const presetApi: PresetAPI = {
  list: () => ipcRenderer.invoke('preset:list'),
  save: (preset) => ipcRenderer.invoke('preset:save', preset),
  delete: (id) => ipcRenderer.invoke('preset:delete', id),
  importJson: () => ipcRenderer.invoke('preset:importJson'),
}

// ---- TTS ----
const ttsApi: TTSAPI = {
  speak: (text, options) => ipcRenderer.invoke('tts:speak', text, options.voice, options.rate),
  stop: () => ipcRenderer.invoke('tts:stop'),
  pause: () => ipcRenderer.invoke('tts:pause'),
  resume: () => ipcRenderer.invoke('tts:resume'),
  getState: () => ipcRenderer.invoke('tts:getState'),
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
  calculateCost: (model, promptTokens, completionTokens) => ipcRenderer.invoke('usage:calculateCost', model, promptTokens, completionTokens),
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

contextBridge.exposeInMainWorld('api', {
  ai: aiApi,
  character: characterApi,
  chat: chatApi,
  settings: settingsApi,
  lorebook: lorebookApi,
  preset: presetApi,
  tts: ttsApi,
  imageGen: imageGenApi,
  regex: regexApi,
  persona: personaApi,
  file: fileApi,
  log: logApi,
  usage: usageApi,
  mcp: mcpApi,
  group: {
    list: () => ipcRenderer.invoke('group:list'),
    save: (group) => ipcRenderer.invoke('group:save', group),
    delete: (id) => ipcRenderer.invoke('group:delete', id),
    listSessions: (groupId) => ipcRenderer.invoke('group:listSessions', groupId),
    createSession: (groupId) => ipcRenderer.invoke('group:createSession', groupId),
    deleteSession: (groupId, sessionId) => ipcRenderer.invoke('group:deleteSession', groupId, sessionId),
    renameSession: (groupId, sessionId, title) => ipcRenderer.invoke('group:renameSession', groupId, sessionId, title),
    listMessages: (groupId, sessionId) => ipcRenderer.invoke('group:listMessages', groupId, sessionId),
    saveMessage: (groupId, sessionId, msg) => ipcRenderer.invoke('group:saveMessage', groupId, sessionId, msg),
    editMessage: (groupId, sessionId, messageId, content) => ipcRenderer.invoke('group:editMessage', groupId, sessionId, messageId, content),
    deleteMessage: (groupId, sessionId, messageId) => ipcRenderer.invoke('group:deleteMessage', groupId, sessionId, messageId),
    clearChat: (groupId, sessionId) => ipcRenderer.invoke('group:clearChat', groupId, sessionId),
    exportChat: (groupId, sessionId, format) => ipcRenderer.invoke('group:exportChat', groupId, sessionId, format),
  },
})
