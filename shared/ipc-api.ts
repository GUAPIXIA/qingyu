import type {
  Character,
  Message,
  ChatSession,
  SessionPreview,
  Lorebook,
  Preset,
  PresetImportResult,
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
  ComfyWorkflowMeta,
} from './types'
export type { ComfyWorkflowMeta } from './types'
import type { LocalModelAPI } from './localModels'
import type {
  LorebookCompatibilityReport,
  LorebookDetectionResult,
} from './lorebook/adapters/types'
import type { LorebookMappingTemplate } from './lorebook/adapters/mapping'
import type { LorebookHealthReport } from './lorebook/health'
import type { TaskSnapshot, EventPage } from './chat-core/events'
import type { ChatCommand } from './chat-core/commands'

// ===================== AI 调用接口 =====================
/** 阶段3：ai:done 结构化完成事件（length 是完成状态；cancelled 由主进程取消时给出） */
export interface AIDonePayload {
  requestId: string
  finishReason: import('./types').AIFinishReason
  usage?: { promptTokens: number; completionTokens: number; reasoningTokens?: number }
}

export interface AIAPI {
  chat(params: ChatParams): Promise<void>
  /** reason 供阶段0观测区分：user = 用户停止 / timeout = 空闲看门狗 / stop_string = 停止字符串命中 */
  cancelChat(requestId: string, reason?: 'user' | 'timeout' | 'stop_string'): Promise<void>
  testConnection(config: APIConfig): Promise<{ success: boolean; models?: string[]; error?: string }>
  listModels(provider: ProviderType, baseUrl: string, apiKey: string): Promise<{ success: boolean; models?: string[]; error?: string }>
  onChunk(callback: (data: { requestId: string; text: string }) => void): () => void
  /** 结构化完成回调（阶段3契约）：携带 finishReason 与 usage，所有完成监听统一走此轨道 */
  onComplete(callback: (payload: AIDonePayload) => void): () => void
  onError(callback: (data: { requestId: string; error: string }) => void): () => void
  /** Token 用量回调（每次 AI 调用完成时触发） */
  onUsage(callback: (data: { requestId: string; promptTokens: number; completionTokens: number; totalTokens: number }) => void): () => void
  countTokens(text: string, model: string): Promise<number>
  countMessagesTokens(messages: { content: string; role: string }[], model: string): Promise<number[]>
  /** 世界书超限条目 AI 压缩（非流式，返回完整摘要文本；失败抛错由调用方降级） */
  compressLorebook(payload: LorebookCompressPayload): Promise<string>
  /** 关键词 enrichment 管线（聊天模型离线扩词，不依赖 embedding）：localize = 英文条目中文化；enrich = 通用扩词 */
  localizeLorebookKeywords(payload: LorebookKeywordLocalizationPayload): Promise<LorebookKeywordLocalizationResult>
}

/** 世界书超限压缩请求（渲染进程 → 主进程） */
export interface LorebookCompressPayload {
  /** 被压缩条目内容（变量替换后） */
  contents: string[]
  /** 压缩目标 token（结果应不超过该值） */
  targetTokens: number
  provider: ProviderType
  apiKey: string
  baseUrl: string
  model: string
}

export interface LorebookKeywordLocalizationEntry {
  id: string
  keywords: string[]
  content: string
}

/** 关键词 enrichment 模式：localize = 英文条目中文化（旧行为）；enrich = 通用扩词（实体/别名/同义表达/多语言） */
export type LorebookKeywordEnrichmentMode = 'localize' | 'enrich'

/** AI 生成触发词的来源元数据（方案 7.5：保存生成来源、模型和时间） */
export interface LorebookKeywordSuggestionSource {
  provider: string
  model: string
  generatedAt: number
  mode: LorebookKeywordEnrichmentMode
}

export interface LorebookKeywordLocalizationSuggestion {
  entryId: string
  aliases: string[]
  /** 生成来源（模型与时间）；供 UI 追溯与 keywordProvenance 持久化。 */
  source?: LorebookKeywordSuggestionSource
}

/** 关键词 enrichment 请求（渲染进程按小批次调用；localize 模式仅处理英文条目） */
export interface LorebookKeywordLocalizationPayload {
  requestId: string
  entries: LorebookKeywordLocalizationEntry[]
  /** 默认 localize（英文条目生成中文触发词）；enrich 为通用扩词管线。 */
  mode?: LorebookKeywordEnrichmentMode
  provider: ProviderType
  apiKey: string
  baseUrl: string
  model: string
}

export interface LorebookKeywordLocalizationResult {
  suggestions: LorebookKeywordLocalizationSuggestion[]
  /** 请求由调用方主动取消；属于正常控制流，不是 IPC 错误。 */
  cancelled?: boolean
}

// ===================== 角色接口 =====================
export interface LorebookSuggestion {
  id: string
  name: string
  description: string
  score: number
  entryCount: number
}

export interface CharacterAPI {
  list(): Promise<Character[]>
  get(id: string): Promise<Character | null>
  save(character: Character): Promise<void>
  delete(id: string): Promise<void>
  importPng(): Promise<{ success: boolean; character?: Character; error?: string; canceled?: boolean; cardExtras?: { regexCount: number; quickReplyCount: number; skipped?: string[] }; lorebookSuggestions?: LorebookSuggestion[] }>
  importJson(): Promise<{ success: boolean; character?: Character; error?: string; canceled?: boolean; needAvatar?: boolean; cardExtras?: { regexCount: number; quickReplyCount: number; skipped?: string[] }; lorebookSuggestions?: LorebookSuggestion[] }>
  importBatch(): Promise<{
    success: boolean
    results?: { name: string; success: boolean; error?: string; needAvatar?: boolean }[]
    total?: number
    successCount?: number
    failCount?: number
    error?: string
    canceled?: boolean
  }>
  bindLorebook(characterId: string, lorebookId: string | null): Promise<void>
  exportPng(id: string): Promise<void>
  exportJson(id: string): Promise<void>
  /** 将角色封面导出为独立图片文件；无封面时返回 ok:false */
  exportCover(id: string): Promise<{ ok: boolean; canceled?: boolean; error?: string }>
  reloadAvatar(characterId: string, url: string): Promise<{ success: boolean; avatar: string; error?: string; code?: string }>
  onImportProgress(callback: (data: { current: number; total: number; fileName: string; status: 'processing' | 'done' | 'error' }) => void): () => void
}

// ===================== 对话接口 =====================
export interface MemoryVersionUpdateResult {
  applied: boolean
  currentVersion: number
}

export interface ChatAPI {
  listSessions(characterId: string): Promise<SessionPreview[]>
  createSession(characterId: string, title?: string, personaId?: string | null, lorebookIds?: string[]): Promise<ChatSession>
  deleteSession(characterId: string, sessionId: string): Promise<void>
  renameSession(characterId: string, sessionId: string, title: string): Promise<void>
  updateSession(characterId: string, sessionId: string, updates: Record<string, unknown>): Promise<ChatSession>
  /** 在 sessions 文件锁内比较并更新记忆版本，过期写入不会落盘。 */
  updateSessionIfMemoryVersion(characterId: string, sessionId: string, expectedVersion: number, updates: Record<string, unknown>): Promise<MemoryVersionUpdateResult>
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
  getMemoryHistory(characterId: string, sessionId: string, opts?: { limit?: number; offset?: number; status?: string }): Promise<{ history: import('./types').MemoryFact[]; total: number }>
}

// ===================== 设置接口 =====================
export interface SettingsAPI {
  get(): Promise<Settings>
  save(settings: Settings): Promise<void>
  saveAPICredential(provider: string, key: string): Promise<void>
  getAPICredential(provider: string): Promise<string | null>
  exportBackup(): Promise<{ status: 'canceled' | 'success'; path?: string; version?: 1 | 2; counts?: Record<string, number>; totalBytes?: number; excluded?: string[] }>
  importBackup(): Promise<{ status: 'canceled' | 'success'; version?: 1 | 2; counts?: Record<string, number> }>
}

// ===================== 世界书接口 =====================
export interface LorebookImportResult {
  lorebook: Lorebook
  detection: LorebookDetectionResult
  report: LorebookCompatibilityReport
}

export interface LorebookImportFormatCandidate {
  adapterId: string
  formatLabel: string
  confidence: number
}

/** 方案 §6.1：检测到多个相近格式时不静默猜测，返回候选让用户选择；导入源缓存在主进程 pendingId 下。 */
export interface LorebookFormatChoicePending {
  needsFormatChoice: true
  pendingId: string
  fileName: string
  candidates: LorebookImportFormatCandidate[]
}

export type LorebookImportOutcome = LorebookImportResult | LorebookFormatChoicePending

export interface LorebookImportOptions {
  /** 歧义确认后完成导入：从主进程缓存取回导入源，并强制使用用户选择的 adapter。 */
  pendingId?: string
  /** 用户选择的格式 adapter id。 */
  adapterId?: string
}

export interface LorebookAPI {
  list(): Promise<Lorebook[]>
  /** expectedRevision 提供时做乐观冲突检测（方案 §10.3）；返回保存后的最新 revision。 */
  save(lorebook: Lorebook, expectedRevision?: number): Promise<{ revision: number }>
  delete(id: string): Promise<void>
  /** 阶段 2：返回格式检测与兼容性报告；格式歧义时返回 LorebookFormatChoicePending 而不是静默猜测。 */
  importJsonDetailed(options?: LorebookImportOptions): Promise<LorebookImportOutcome | null>
  /** 阶段 6 P2：映射向导。打开文件并返回截断预览与猜测模板；原始内容缓存在主进程。 */
  openMappingSource(): Promise<{
    sourceId: string
    fileName: string
    preview: unknown
    guessedTemplate: LorebookMappingTemplate | null
  } | null>
  importWithTemplate(sourceId: string, template: LorebookMappingTemplate): Promise<LorebookImportResult>
  /** 阶段 7：一次性数据健康检查。 */
  healthCheck(): Promise<LorebookHealthReport>
  listMappingTemplates(): Promise<LorebookMappingTemplate[]>
  saveMappingTemplate(template: LorebookMappingTemplate): Promise<void>
  deleteMappingTemplate(id: string): Promise<void>
  exportJson(id: string, adapterId?: string): Promise<{
    ok: boolean
    canceled?: boolean
    path?: string
    adapterId?: string
    report?: LorebookCompatibilityReport
  }>
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
  /** 条目手写摘要（阶段三：预算紧张时代替全文注入） */
  summary?: string
}

/** 嵌入服务连接配置（传输层，仅取 SemanticTriggerConfig 中的连接字段） */
export interface EmbeddingEndpointConfig {
  provider: 'openai' | 'ollama' | 'local'
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
  indexStatus(lorebookIds: string[], config?: EmbeddingEndpointConfig): Promise<Record<string, { indexed: number; model: string; updatedAt: number; stale: number }>>
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
  /** 事实语义检索：查询文本与事实向量比对，保留真实相似度。 */
  searchFacts(payload: {
    query: string
    facts: string[]
    vectors: number[][]
    config: EmbeddingEndpointConfig
    threshold?: number
    maxResults?: number
  }): Promise<FactSearchHit[]>
}

export interface FactSearchHit {
  text: string
  index: number
  score: number
}

// ===================== 预设接口 =====================
export interface PresetAPI {
  list(): Promise<Preset[]>
  save(preset: Preset): Promise<Preset>
  delete(id: string): Promise<void>
  importJson(): Promise<PresetImportResult | null>
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
  saveMessagesBatch(groupId: string, sessionId: string, msgs: GroupMessage[]): Promise<void>
  editMessage(groupId: string, sessionId: string, messageId: string, content: string): Promise<void>
  deleteMessage(groupId: string, sessionId: string, messageId: string): Promise<void>
  clearChat(groupId: string, sessionId?: string): Promise<void>
  exportChat(groupId: string, sessionId: string, format: 'json' | 'md'): Promise<string>
  updateMemory(groupId: string, sessionId: string, memory: string): Promise<void>
  toggleMemory(groupId: string, sessionId: string, enabled: boolean): Promise<void>
  setMemoryMode(groupId: string, sessionId: string, mode: 'manual' | 'auto', interval?: number): Promise<void>
  updateSession(groupId: string, sessionId: string, updates: Record<string, unknown>): Promise<void>
  /** 群聊会话的原子记忆版本条件更新。 */
  updateSessionIfMemoryVersion(groupId: string, sessionId: string, expectedVersion: number, updates: Record<string, unknown>): Promise<MemoryVersionUpdateResult>
}

// ===================== TTS 接口 =====================
export interface TTSAPI {
  /** 朗读。openai provider 返回 audioBase64（渲染进程播放）；system 本地引擎无返回 */
  speak(text: string, options: TTSOptions & { model?: string; apiKey?: string; baseUrl?: string; proxy?: string }): Promise<{ success: boolean; audioBase64?: string; error?: string }>
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

export interface LocalComfyWorkflow {
  path: string
  name: string
  installation: string
  modifiedAt: number
}

/** 工作流用途判定，用于决定能否作为普通文生图配置保存。 */
export type ComfyWorkflowKind = 'text-to-image' | 'image-to-image' | 'video' | 'unknown'

/** 分析过程中的可提示问题；不阻断分析，但会影响 compatible。 */
export type ComfyWorkflowWarningCode =
  | 'no-output'
  | 'no-prompt'
  | 'ambiguous-prompt'
  | 'ambiguous-output'
  | 'unknown-node'
  | 'missing-model'
  | 'requires-image-input'
  | 'video-workflow'
  | 'multi-stage'
  | 'unreachable-nodes'

export interface ComfyWorkflowWarning {
  code: ComfyWorkflowWarningCode
  message: string
  nodeIds?: string[]
}

/** 提示词与输出节点的角色绑定；存在多个候选时由 ambiguous-prompt / ambiguous-output 警告标记歧义。 */
export interface ComfyWorkflowBinding {
  role: 'positive' | 'negative' | 'output'
  nodeId: string
  inputName?: string
  title?: string
}

/** 单个可调参数；id 即运行时覆盖表的键（`节点ID.输入名`）。 */
export interface ComfyWorkflowParameter {
  id: string
  nodeId: string
  inputName: string
  label: string
  type: 'number' | 'select' | 'text' | 'boolean' | 'size'
  /** 工作流当前值；size 类型为 `${width}x${height}` 字符串。 */
  workflowValue: unknown
  /** size 类型的第二个输入名（height）；运行时覆盖需同时写入 width 与 height。 */
  pairedInputName?: string
  pairedWorkflowValue?: unknown
  options?: unknown[]
  min?: number
  max?: number
  step?: number
  required: boolean
  /** 归入高级设置折叠区，默认不展示（如随机种子）。 */
  advanced?: boolean
}

/** 参数分组：输出尺寸、各采样阶段、模型侧可调项，以及未识别的自定义节点参数。 */
export interface ComfyWorkflowParameterGroup {
  id: string
  nodeId: string
  classType: string
  title: string
  stage: 'output' | 'sampling' | 'model' | 'custom'
  parameters: ComfyWorkflowParameter[]
}

/** 模型依赖条目，按 `节点ID + 模型名输入` 建立，避免把同节点的非模型输入误判为模型名。 */
export interface ComfyWorkflowDependency {
  nodeId: string
  inputName: string
  classType: string
  label: string
  /** 工作流当前引用的模型文件名。 */
  value: string
  /** 该 Loader 提供的输出能力，如 MODEL / CLIP / VAE。 */
  provides: string[]
  /** 引用该输出的下游节点，用于把共享依赖归并为一条。 */
  usedBy: Array<{ nodeId: string; inputName: string }>
  /** 来自 /object_info 的可用文件列表；缺失时表示无法校验。 */
  options?: string[]
  /** 仅在能取得 options 时给出：当前 value 是否在可用列表中。 */
  available?: boolean
}

export interface ComfyWorkflowAnalysis {
  kind: ComfyWorkflowKind
  nodeCount: number
  compatible: boolean
  promptBindings: ComfyWorkflowBinding[]
  outputBindings: ComfyWorkflowBinding[]
  parameterGroups: ComfyWorkflowParameterGroup[]
  dependencies: ComfyWorkflowDependency[]
  warnings: ComfyWorkflowWarning[]
}

export interface ComfyWorkflowImportResult {
  success: boolean
  canceled?: boolean
  error?: string
  sourceName?: string
  workflow?: string
  nodeCount?: number
  converted?: boolean
  settings?: {
    size?: string
    steps?: number
    cfgScale?: number
    sampler?: string
    scheduler?: string
    model?: string
    negativePrompt?: string
  }
  analysis?: ComfyWorkflowAnalysis
  workflowMeta?: ComfyWorkflowMeta
  objectInfo?: Record<string, unknown>
}

/** 分析已有工作流 JSON 的结果；用于编辑配置时重建动态参数。 */
export interface ComfyWorkflowAnalysisResult {
  success: boolean
  analysis?: ComfyWorkflowAnalysis
  error?: string
}

/** 拉取 /object_info 的结果；失败时调用侧按 JS 类型降级渲染，不阻塞编辑。 */
export interface ComfyObjectInfoResult {
  success: boolean
  objectInfo?: Record<string, unknown>
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
  listLocalComfyWorkflows(): Promise<{ success: boolean; workflows?: LocalComfyWorkflow[]; error?: string }>
  importLocalComfyWorkflow(path?: string): Promise<ComfyWorkflowImportResult>
  analyzeComfyWorkflow(workflow: string, objectInfo?: Record<string, unknown>): Promise<ComfyWorkflowAnalysisResult>
  fetchObjectInfo(baseUrl: string, apiKey?: string): Promise<ComfyObjectInfoResult>
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
  aggregate(filter: { characterId?: string; sessionId?: string; startTs?: number; endTs?: number; model?: string }, groupBy: 'character' | 'session' | 'day' | 'model', timeZone?: string): Promise<AggregatedUsage[]>
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

// ===================== 在线更新接口 =====================
/** 更新状态机：空闲 / 检查中 / 有更新 / 已最新 / 下载中 / 下载完成 / 出错 */
export type UpdaterStatus = 'idle' | 'checking' | 'available' | 'none' | 'downloading' | 'downloaded' | 'error'

export interface UpdateSourceResult {
  status: 'available' | 'none' | 'error'
  /** 此来源清单中的最新版本 */
  version?: string
  /** 此来源的说明或错误信息 */
  message?: string
  /** 此来源对应的手动下载地址 */
  downloadUrl?: string
  releaseNotes?: string
}

export interface UpdaterState {
  status: UpdaterStatus
  /** 状态说明 / 错误消息 */
  message: string
  version?: string
  releaseNotes?: string
  /** 下载进度百分比（downloading 时有效） */
  percent?: number
  /** 固定官方服务器 latest.yml 的检查结果 */
  server?: UpdateSourceResult
  /** GitHub Releases latest.yml 的检查结果 */
  github?: UpdateSourceResult
  /** 至少一个来源确认存在高于当前版本的更新 */
  hasAvailableUpdate?: boolean
}

export interface UpdaterAPI {
  check(): Promise<UpdaterState>
  download(): Promise<UpdaterState>
  install(): Promise<void>
  getState(): Promise<UpdaterState>
  /** 订阅主进程推送的状态变化，返回取消订阅函数 */
  onEvent(listener: (state: UpdaterState) => void): () => void
}

/** 会话变更载荷（阶段 0c：事件总线） */
export interface SessionChangePayload {
  sessionId: string
  /** created / message / title / deleted / swiped */
  change: 'created' | 'message' | 'title' | 'deleted' | 'swiped'
}

/** 阶段 0c：会话变更事件总线（渲染层上报 -> 主进程广播，桥接层转推 WS） */
export interface SessionSyncAPI {
  /** 渲染层上报会话变更（middleware 自动调用） */
  changed(payload: SessionChangePayload): void
  /** 订阅主进程广播的会话变更（PC 双窗口同步 / 桥接层事件源） */
  onUpdated(callback: (payload: SessionChangePayload) => void): () => void
}

// ===================== 桥接层接口（阶段一） =====================

export interface BridgeConfig {
  enabled: boolean
  host: string
  port: number
  bindIps: string[]
}

export interface BridgeStatus {
  running: boolean
  config: BridgeConfig
  bound: { host: string; port: number; clientCount: number } | null
}

export interface PairingInfo {
  host: string
  port: number
  /** 二维码 fingerprint 字段（安卓端将其作为配对码使用；v2 中同值于 pairingCode） */
  fingerprint: string
  expiresInSec: number
  // ===== QR v2（阶段 D-02；旧客户端忽略新增字段，向后兼容）=====
  /** 稳定服务器 ID（bridgeIdentity uuid） */
  serverId?: string
  /** PC 展示名 */
  displayName?: string
  /** REST 协议版本 */
  apiVersion?: number
  /** 能力声明（QR v2 capabilities；与 /server/info 同集合子集） */
  capabilities?: string[]
  /** 配对码到期时间戳（ms；QR v2 expiresAt） */
  expiresAt?: number
  /** QR v2 端点候选（当前绑定的局域网 host + 端口） */
  endpoints?: import('./pairingQr').PairingQrEndpoint[]
}

export interface BridgeDeviceInfo {
  deviceId: string
  name: string
  fingerprint: string
  createdAt: number
  lastSeen: number
}

/** 阶段一：PC 侧「手机连接」桥接层（设置页 + 配对审批） */
export interface BridgeAPI {
  status(): Promise<BridgeStatus>
  start(): Promise<{ ok: boolean; host?: string; port?: number; error?: string }>
  stop(): Promise<{ ok: boolean }>
  setConfig(partial: Partial<Pick<BridgeConfig, 'enabled' | 'host' | 'port'>>): Promise<{
    ok: boolean
    config?: BridgeConfig
    error?: string
  }>
  pairingInfo(): Promise<PairingInfo>
  /** 强制生成新配对码（旧码作废）并返回最新配对信息 */
  regeneratePairing(): Promise<PairingInfo>
  /** 生成配对二维码载荷 JSON（D-02）：v2 默认；legacy=旧格式 {host,port,fingerprint} */
  pairingQrPayload(mode?: 'v2' | 'legacy'): Promise<string>
  listDevices(): Promise<BridgeDeviceInfo[]>
  revokeDevice(deviceId: string): Promise<{ ok: boolean }>
  approvePair(requestId: string): Promise<{ ok: boolean; error?: string }>
  rejectPair(requestId: string): Promise<{ ok: boolean }>
  /** 订阅配对审批请求（PC 端人工确认弹窗） */
  onPairRequest(callback: (data: { requestId: string; deviceName: string }) => void): () => void
  wipeAll(): Promise<{ ok: boolean }>
}

export type RelayStatus =
  | { state: 'Disabled' }
  | { state: 'Registering' | 'Connecting' | 'Online' | 'NeedsAuth' | 'ServiceUnavailable'; baseUrl: string; spaceId?: string }
  | { state: 'Reconnecting'; baseUrl: string; spaceId?: string; attempt: number; nextAt: number }

export interface RelayDeviceInfo { deviceId: string; name: string; role: 'pc' | 'android'; approvedAt: number; lastSeenAt?: number }
export interface RelayPairRequest { requestId: string; deviceName: string; expiresAt: number }
export interface RelayAPI {
  status(): Promise<RelayStatus>
  enable(baseUrl: string): Promise<{ ok: boolean; error?: string }>
  disable(): Promise<{ ok: boolean }>
  retry(): Promise<{ ok: boolean; error?: string }>
  createPairTicket(): Promise<import('./relayProtocol').RelayPairingQr>
  listDevices(): Promise<RelayDeviceInfo[]>
  revokeDevice(deviceId: string): Promise<{ ok: boolean }>
  approvePair(requestId: string): Promise<{ ok: boolean }>
  rejectPair(requestId: string): Promise<{ ok: boolean }>
  clearCache(): Promise<{ ok: boolean }>
  onStatusChanged(callback: (status: RelayStatus) => void): () => void
  onPairRequest(callback: (request: RelayPairRequest) => void): () => void
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
export interface ChatTaskAPI {
  start(command: ChatCommand): Promise<{ taskId: string; state: string; lastSequence: number }>
  get(taskId: string): Promise<TaskSnapshot | null>
  listBySession(sessionId: string): Promise<TaskSnapshot[]>
  eventsAfter(taskId: string, sequence: number): Promise<EventPage>
  cancel(taskId: string): Promise<TaskSnapshot>
  retry(taskId: string): Promise<{ taskId: string; state: string }>
  onEvent(listener: (event: { taskId: string; type: string; task?: TaskSnapshot }) => void): () => void
}

export interface ExposedAPI {
  ai: AIAPI
  character: CharacterAPI
  chat: ChatAPI
  chatTask: ChatTaskAPI
  settings: SettingsAPI
  lorebook: LorebookAPI
  embedding: EmbeddingAPI
  localModel: LocalModelAPI
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
  updater: UpdaterAPI
  sessionSync: SessionSyncAPI
  bridge: BridgeAPI
  relay: RelayAPI
  app: AppAPI
}

declare global {
  interface Window {
    api: ExposedAPI
  }
}
