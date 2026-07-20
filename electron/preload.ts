import { contextBridge, ipcRenderer } from 'electron'
import type {
  CharacterAPI,
  ChatAPI,
  SettingsAPI,
  LorebookAPI,
  PresetAPI,
  AIAPI,
  TTSAPI,
  FileAPI,
  RegexAPI,
  PersonaAPI,
} from '../shared/ipc-api'

// ---- AI 调用 ----
const aiApi: AIAPI = {
  chat: (params) => ipcRenderer.invoke('ai:chat', params),
  cancelChat: (requestId) => ipcRenderer.invoke('ai:cancel', requestId),
  testConnection: (config) => ipcRenderer.invoke('ai:testConnection', config),
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

contextBridge.exposeInMainWorld('api', {
  ai: aiApi,
  character: characterApi,
  chat: chatApi,
  settings: settingsApi,
  lorebook: lorebookApi,
  preset: presetApi,
  tts: ttsApi,
  regex: regexApi,
  persona: personaApi,
  file: fileApi,
})
