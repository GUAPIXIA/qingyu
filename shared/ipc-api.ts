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
  Announcement,
  ProviderType,
  UsageRecord,
  McpServerConfig,
  McpTool,
  McpToolResult,
  McpServerStatus,
  AggregatedUsage,
  UsageSummary,
  CustomFont,
  QuickReply,
} from './types'

// ===================== AI 调用接口 =====================
export interface AIAPI {
  chat(params: ChatParams): Promise<void>
  cancelChat(requestId: string): Promise<void>
  testConnection(config: APIConfig): Promise<{ success: boolean; models?: string[]; error?: string }>
  listModels(provider: ProviderType, baseUrl: string, apiKey: string): Promise<{ success: boolean; models?: string[]; error?: string }>
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
  createSession(characterId: string, title?: string, personaId?: string | null, lorebookIds?: string[]): Promise<ChatSession>
  deleteSession(characterId: string, sessionId: string): Promise<void>
  renameSession(characterId: string, sessionId: string, title: string): Promise<void>
  updateSession(characterId: string, sessionId: string, updates: Record<string, unknown>): Promise<ChatSession>
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

// ===================== 快捷回复接口 =====================
export interface QuickReplyAPI {
  /** 读取全部（全局 + 角色级） */
  listAll(): Promise<{ global: QuickReply[]; byCharacter: Record<string, QuickReply[]> }>
  /** 全量保存 */
  saveAll(store: { global: QuickReply[]; byCharacter: Record<string, QuickReply[]> }): Promise<void>
  /** 删除指定角色的专属快捷回复 */
  clearCharacter(characterId: string): Promise<void>
  /** 导出 JSON 到文件 */
  exportJson(): Promise<{ ok: boolean; canceled?: boolean; error?: string }>
  /** 从 JSON 文件导入（合并） */
  importJson(): Promise<{ ok: boolean; canceled?: boolean; error?: string }>
}

// ===================== 语义触发（向量 RAG）接口 =====================
export interface SemanticHit {
  id: string
  lbId: string
  content: string
  position: Lorebook['entries'][number]['position']
  order: number
  depth?: number
  score: number
}

/** 嵌入服务连接配置（传输层，仅取 SemanticTriggerConfig 中的连接字段） */
export interface EmbeddingEndpointConfig {
  provider: 'openai' | 'ollama'
  baseUrl: string
  model: string
  apiKey: string
}

export interface IndexResult {
  ok: boolean
  total?: number
  indexed?: number
  failed?: number
  error?: string
}

export interface EmbeddingAPI {
  /** 测试嵌入服务连接，返回向量维度 */
  test(config: EmbeddingEndpointConfig): Promise<{ ok: boolean; dim?: number; error?: string }>
  /** 为世界书生成/重建向量索引 */
  indexLorebook(lorebookId: string, config: EmbeddingEndpointConfig): Promise<IndexResult>
  /** 查询多个世界书的索引状态 */
  indexStatus(lorebookIds: string[]): Promise<Record<string, { indexed: number; model: string; updatedAt: number }>>
  /** 删除世界书向量索引 */
  removeIndex(lorebookId: string): Promise<{ ok: boolean }>
  /** 扫描文本语义检索，返回命中条目 */
  semanticSearch(payload: {
    scanText: string
    lorebookIds: string[]
    config: EmbeddingEndpointConfig
    threshold?: number
    maxResults?: number
  }): Promise<SemanticHit[]>
  /** 为会话事实批量嵌入，返回向量数组（渲染进程负责存会话） */
  embedFacts(config: EmbeddingEndpointConfig, texts: string[]): Promise<number[][]>
  /** 事实语义检索：查询文本与事实向量比对，返回命中的事实文本 */
  searchFacts(payload: {
    query: string
    facts: string[]
    vectors: number[][]
    config: EmbeddingEndpointConfig
    threshold?: number
    maxResults?: number
  }): Promise<string[]>
}

// ===================== 预设接口 =====================
export interface PresetAPI {
  list(): Promise<Preset[]>
  save(preset: Preset): Promise<void>
  delete(id: string): Promise<void>
  importJson(): Promise<Preset | null>
  exportJson(id: string): Promise<{ ok: boolean; canceled?: boolean; error?: string }>
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
  updateMemory(groupId: string, sessionId: string, memory: string): Promise<void>
  toggleMemory(groupId: string, sessionId: string, enabled: boolean): Promise<void>
  setMemoryMode(groupId: string, sessionId: string, mode: 'manual' | 'auto', interval?: number): Promise<void>
  updateSession(groupId: string, sessionId: string, updates: Record<string, unknown>): Promise<void>
}

// ===================== TTS 接口 =====================
export interface TTSAPI {
  /** 朗读。openai provider 返回 audioBase64（渲染进程播放）；system 本地引擎无返回 */
  speak(text: string, options: TTSOptions & { model?: string; apiKey?: string; baseUrl?: string }): Promise<{ success: boolean; audioBase64?: string; error?: string }>
  stop(): Promise<void>
  pause(): Promise<void>
  resume(): Promise<void>
  getState(): Promise<{ state: 'idle' | 'speaking' | 'paused' }>
  /** 订阅 TTS 状态变化（系统语音完成/停止事件），返回取消订阅函数 */
  onState(callback: (state: 'idle' | 'speaking' | 'paused') => void): () => void
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

// ===================== 字体接口 =====================
export interface FontAPI {
  /** 选择字体文件（dialog），返回临时路径 */
  selectFont(): Promise<string | null>
  /** 保存字体到 userData/fonts/，返回字体信息 */
  saveFont(filePath: string): Promise<CustomFont>
  /** 列出所有已保存的自定义字体 */
  listFonts(): Promise<CustomFont[]>
  /** 删除指定字体 */
  deleteFont(id: string): Promise<void>
  /** 获取字体文件的完整路径（用于 @font-face src） */
  getFontPath(id: string): Promise<string | null>
}

// ===================== 日志接口 =====================
export interface LogAPI {
  write(level: 'debug' | 'info' | 'warn' | 'error', module: string, message: string, meta?: Record<string, unknown>): Promise<void>
  getRecent(limit?: number): Promise<string>
}

// ===================== 用量统计接口 =====================
export interface UsageAPI {
  record(record: Omit<UsageRecord, 'id'>): Promise<UsageRecord>
  query(filter: { characterId?: string; sessionId?: string; startTs?: number; endTs?: number; model?: string }): Promise<UsageRecord[]>
  aggregate(filter: { characterId?: string; sessionId?: string; startTs?: number; endTs?: number; model?: string }, groupBy: 'character' | 'session' | 'day' | 'model'): Promise<AggregatedUsage[]>
  summary(filter?: { startTs?: number; endTs?: number }): Promise<UsageSummary>
  clear(): Promise<void>
}

// ===================== MCP 接口 =====================
export interface McpAPI {
  listServers(): Promise<McpServerConfig[]>
  listServerStatuses(): Promise<McpServerStatus[]>
  addServer(config: Omit<McpServerConfig, 'id'>): Promise<McpServerConfig>
  updateServer(id: string, patch: Partial<McpServerConfig>): Promise<void>
  removeServer(id: string): Promise<void>
  startServer(id: string): Promise<void>
  stopServer(id: string): Promise<void>
  listTools(): Promise<McpTool[]>
  callTool(serverId: string, toolName: string, args: Record<string, unknown>): Promise<McpToolResult>
}

// ===================== 在线公告接口 =====================
export interface AnnouncementAPI {
  fetchList(page?: number, pageSize?: number): Promise<{ items: Announcement[]; total: number }>
  fetchDetail(id: number): Promise<Announcement | null>
  getServerUrl(): Promise<string>
  setServerUrl(url: string): Promise<void>
}

// ===================== 应用接口 =====================
export interface AppAPI {
  /** 获取当前应用版本号 */
  getVersion(): Promise<string>
  /** 检查服务器最新版本 */
  checkVersion(): Promise<{ version: string; changelog: string; downloadUrl: string } | null>
  /** 打开外部链接 */
  openExternal(url: string): Promise<void>
}

// ===================== 完整 API 契约 =====================
export interface ExposedAPI {
  ai: AIAPI
  character: CharacterAPI
  chat: ChatAPI
  settings: SettingsAPI
  lorebook: LorebookAPI
  embedding: EmbeddingAPI
  quickReply: QuickReplyAPI
  preset: PresetAPI
  tts: TTSAPI
  imageGen: ImageGenAPI
  regex: RegexAPI
  persona: PersonaAPI
  file: FileAPI
  font: FontAPI
  log: LogAPI
  usage: UsageAPI
  mcp: McpAPI
  group: GroupChatAPI
  announcement: AnnouncementAPI
  app: AppAPI
}

declare global {
  interface Window {
    api: ExposedAPI
  }
}
