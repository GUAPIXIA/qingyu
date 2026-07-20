import type {
  Character,
  Message,
  ChatSession,
  SessionPreview,
  Lorebook,
  Preset,
  GroupChat,
  Settings,
  ChatParams,
  TTSOptions,
  Voice,
  APIConfig,
  RegexRule,
  Persona,
} from './types'

// ===================== AI 调用接口 =====================
export interface AIAPI {
  chat(params: ChatParams): Promise<void>
  cancelChat(requestId: string): Promise<void>
  testConnection(config: APIConfig): Promise<{ success: boolean; models?: string[]; error?: string }>
  onChunk(callback: (data: { requestId: string; text: string }) => void): () => void
  onDone(callback: (requestId: string) => void): () => void
  onError(callback: (data: { requestId: string; error: string }) => void): () => void
}

// ===================== 角色接口 =====================
export interface CharacterAPI {
  list(): Promise<Character[]>
  get(id: string): Promise<Character | null>
  save(character: Character): Promise<void>
  delete(id: string): Promise<void>
  importPng(): Promise<{ success: boolean; character?: Character; error?: string; canceled?: boolean }>
  importJson(): Promise<{ success: boolean; character?: Character; error?: string; canceled?: boolean; needAvatar?: boolean }>
  importBatch(): Promise<{
    success: boolean
    results?: { name: string; success: boolean; error?: string; needAvatar?: boolean }[]
    total?: number
    successCount?: number
    failCount?: number
    error?: string
    canceled?: boolean
  }>
  exportPng(id: string): Promise<void>
  exportJson(id: string): Promise<void>
}

// ===================== 对话接口 =====================
export interface ChatAPI {
  listSessions(characterId: string): Promise<SessionPreview[]>
  createSession(characterId: string, title?: string): Promise<ChatSession>
  deleteSession(characterId: string, sessionId: string): Promise<void>
  renameSession(characterId: string, sessionId: string, title: string): Promise<void>
  listMessages(characterId: string, sessionId?: string): Promise<Message[]>
  saveMessage(message: Message): Promise<void>
  deleteMessage(id: string, characterId: string, sessionId?: string): Promise<void>
  clearChat(characterId: string, sessionId?: string): Promise<void>
  exportChat(characterId: string, sessionId: string, format: 'md' | 'json'): Promise<string>
  updateMemory(characterId: string, sessionId: string, memory: string): Promise<void>
  toggleMemory(characterId: string, sessionId: string, enabled: boolean): Promise<void>
  setMemoryMode(characterId: string, sessionId: string, mode: 'manual' | 'auto', interval?: number): Promise<void>
  getStats(characterId: string, sessionId: string): Promise<{
    totalMessages: number
    userMessages: number
    assistantMessages: number
    totalChars: number
    firstMessageTime: number
    lastMessageTime: number
    durationMs: number
    durationStr: string
  }>
}

// ===================== 设置接口 =====================
export interface SettingsAPI {
  get(): Promise<Settings>
  save(settings: Settings): Promise<void>
  saveAPICredential(provider: string, key: string): Promise<void>
  getAPICredential(provider: string): Promise<string | null>
  exportBackup(): Promise<void>
  importBackup(): Promise<void>
}

// ===================== 世界书接口 =====================
export interface LorebookAPI {
  list(): Promise<Lorebook[]>
  save(lorebook: Lorebook): Promise<void>
  delete(id: string): Promise<void>
  importJson(): Promise<Lorebook | null>
}

// ===================== 预设接口 =====================
export interface PresetAPI {
  list(): Promise<Preset[]>
  save(preset: Preset): Promise<void>
  delete(id: string): Promise<void>
  importJson(): Promise<Preset | null>
}

// ===================== TTS 接口 =====================
export interface TTSAPI {
  speak(text: string, options: TTSOptions): Promise<void>
  stop(): Promise<void>
  pause(): Promise<void>
  resume(): Promise<void>
  getState(): Promise<{ state: 'idle' | 'speaking' | 'paused' }>
  listVoices(provider: string): Promise<Voice[]>
}

// ===================== 正则表达式接口 =====================
export interface RegexAPI {
  list(): Promise<RegexRule[]>
  save(rule: RegexRule): Promise<RegexRule>
  delete(id: string): Promise<void>
  create(name: string): Promise<RegexRule>
}

// ===================== 用户身份接口 =====================
export interface PersonaAPI {
  list(): Promise<Persona[]>
  save(persona: Persona): Promise<Persona>
  delete(id: string): Promise<void>
  createDefault(name: string): Promise<Persona>
}

// ===================== 文件接口 =====================
export interface FileAPI {
  selectImage(): Promise<string | null>
  readImageAsBase64(path: string): Promise<string>
}

// ===================== 完整 API 契约 =====================
export interface ExposedAPI {
  ai: AIAPI
  character: CharacterAPI
  chat: ChatAPI
  settings: SettingsAPI
  lorebook: LorebookAPI
  preset: PresetAPI
  tts: TTSAPI
  regex: RegexAPI
  persona: PersonaAPI
  file: FileAPI
}

declare global {
  interface Window {
    api: ExposedAPI
  }
}
