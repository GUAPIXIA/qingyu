import type {
  Character,
  Message,
  ChatSession,
  SessionPreview,
  Lorebook,
  Preset,
  GroupChat,
  GroupMessage,
  GroupSession,
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
  /** Token 用量回调（每次 AI 调用完成时触发） */
  onUsage(callback: (data: { requestId: string; promptTokens: number; completionTokens: number; totalTokens: number }) => void): () => void
  countTokens(text: string, model: string): Promise<number>
  countMessagesTokens(messages: { content: string; role: string }[], model: string): Promise<number[]>
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
  reloadAvatar(characterId: string, url: string): Promise<{ success: boolean; avatar: string; error?: string; code?: string }>
  onImportProgress(callback: (data: { current: number; total: number; fileName: string; status: 'processing' | 'done' | 'error' }) => void): () => void
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

// ===================== 群聊接口 =====================
export interface GroupChatAPI {
  list(): Promise<GroupChat[]>
  save(group: GroupChat): Promise<void>
  delete(id: string): Promise<void>
  listSessions(groupId: string): Promise<GroupSession[]>
  createSession(groupId: string): Promise<GroupSession>
  deleteSession(groupId: string, sessionId: string): Promise<void>
  renameSession(groupId: string, sessionId: string, title: string): Promise<void>
  listMessages(groupId: string, sessionId: string): Promise<GroupMessage[]>
  saveMessage(groupId: string, sessionId: string, msg: GroupMessage): Promise<void>
  editMessage(groupId: string, sessionId: string, messageId: string, content: string): Promise<void>
  deleteMessage(groupId: string, sessionId: string, messageId: string): Promise<void>
  clearChat(groupId: string, sessionId?: string): Promise<void>
  exportChat(groupId: string, sessionId: string, format: 'json' | 'md'): Promise<string>
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

// ===================== 文生图接口 =====================
export interface ImageGenResult {
  success: boolean
  images?: string[]    // base64 data URL 数组
  error?: string
}

export interface ImageGenTestResult {
  success: boolean
  message?: string
  error?: string
}

export interface ImageGenAPI {
  generate(prompt: string, options?: {
    negativePrompt?: string
    size?: string
    quality?: string
  }): Promise<ImageGenResult>
  testConnection(config: {
    provider: string
    baseUrl: string
    apiKey: string
  }): Promise<ImageGenTestResult>
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

// ===================== 日志接口 =====================
export interface LogAPI {
  write(level: 'debug' | 'info' | 'warn' | 'error', module: string, message: string, meta?: Record<string, any>): Promise<void>
  getRecent(limit?: number): Promise<string>
}

// ===================== 用量统计接口 =====================
export interface UsageAPI {
  record(record: { timestamp: number; characterId: string; sessionId: string; model: string; promptTokens: number; completionTokens: number; totalTokens: number; cost: number }): Promise<any>
  query(filter: { characterId?: string; sessionId?: string; startTs?: number; endTs?: number; model?: string }): Promise<any[]>
  aggregate(filter: { characterId?: string; sessionId?: string; startTs?: number; endTs?: number; model?: string }, groupBy: 'character' | 'session' | 'day' | 'model'): Promise<Array<{ key: string; promptTokens: number; completionTokens: number; totalTokens: number; cost: number; count: number }>>
  summary(filter?: { startTs?: number; endTs?: number }): Promise<{ totalPrompt: number; totalCompletion: number; totalTokens: number; totalCost: number; count: number }>
  clear(): Promise<void>
  calculateCost(model: string, promptTokens: number, completionTokens: number): Promise<number>
}

// ===================== MCP 接口 =====================
export interface McpAPI {
  listServers(): Promise<any[]>
  listServerStatuses(): Promise<Array<{ id: string; connected: boolean; toolCount: number; lastError?: string }>>
  addServer(config: any): Promise<any>
  updateServer(id: string, patch: any): Promise<void>
  removeServer(id: string): Promise<void>
  startServer(id: string): Promise<void>
  stopServer(id: string): Promise<void>
  listTools(): Promise<any[]>
  callTool(serverId: string, toolName: string, args: Record<string, any>): Promise<any>
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
  imageGen: ImageGenAPI
  regex: RegexAPI
  persona: PersonaAPI
  file: FileAPI
  log: LogAPI
  usage: UsageAPI
  mcp: McpAPI
  group: GroupChatAPI
}

declare global {
  interface Window {
    api: ExposedAPI
  }
}
