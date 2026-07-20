// ===================== 基础数据模型 =====================

/** 角色卡（兼容 SillyTavern Character Card V2 简化版） */
export interface Character {
  id: string
  name: string
  avatar: string // 本地路径或 base64（圆形小头像）
  cover?: string // base64（3:4 封面大图）
  description: string // 角色描述
  personality: string // 性格特征
  scenario: string // 场景设定
  firstMessage: string // 首条消息
  exampleDialog: string // 对话示例
  tags: string[]
  lorebookId: string | null
  creator: string
  createdAt: number
  updatedAt: number
  /** 备选首条消息列表 */
  alternateGreetings: string[]
  /** 角色级系统提示词（覆盖预设） */
  systemPrompt?: string
  /** 对话历史后注入指令 */
  postHistoryInstructions?: string
  /** 创作者备注（隐藏元数据，导入导出保留） */
  creatorNotes?: string
  /** 角色卡版本号 */
  characterVersion?: string
  /** 群聊专用开场白 */
  groupOnlyGreetings?: string[]
  /** 扩展数据（保证导入导出往返） */
  extensions?: Record<string, any>
  /** 原始封面图片URL（用于重新加载封面，不导出） */
  _importImageUrl?: string
  /** 聊天页背景图（base64 data URL） */
  chatBackground?: string
}

/** 聊天消息 */
export interface Message {
  id: string
  sessionId: string
  characterId: string
  role: 'user' | 'assistant' | 'system'
  content: string
  images: string[] // base64 数组
  isEditing: boolean
  timestamp: number
  translation?: string | null // 翻译结果（持久化）
  /** 所有候选回复（仅 assistant 角色）- Swipe 多候选 */
  swipes?: string[]
  /** 当前显示的候选索引 */
  swipeIndex?: number
  /** 本次 AI 回复的 token 用量（仅 assistant 消息） */
  tokenUsage?: MessageTokenUsage
}

/** 单条消息的 token 统计 */
export interface MessageTokenUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  /** 本次调用估算费用（美元） */
  cost: number
  /** 使用的模型 */
  model: string
  timestamp: number
}

/** 用量记录（持久化到 usage.json） */
export interface UsageRecord {
  id: string
  timestamp: number
  characterId: string
  sessionId: string
  model: string
  promptTokens: number
  completionTokens: number
  totalTokens: number
  cost: number
}

/** 费用规则 */
export interface PricingRule {
  id: string
  /** 模型名匹配模式（支持 *，如 gpt-4*） */
  modelPattern: string
  /** 输入价格（美元 / 1M tokens） */
  inputPricePer1M: number
  /** 输出价格（美元 / 1M tokens） */
  outputPricePer1M: number
  /** 是否内置（不可删除） */
  isBuiltin?: boolean
}

/** 用户身份/人设 */
export interface Persona {
  id: string
  name: string          // {{user}} 替换值
  description: string   // 用户描述
  persona: string       // 用户性格
  avatar: string        // base64 头像（可为空）
  createdAt: number
  updatedAt: number
}

/** 聊天会话 */
export interface ChatSession {
  id: string
  characterId: string
  title: string
  createdAt: number
  updatedAt: number
  memoryEnabled: boolean
  memoryMode: 'manual' | 'auto'
  autoMemoryInterval: number
  memory: string
  memoryUpdatedAt: number
}

/** 会话预览（含消息数和最后消息摘要） */
export interface SessionPreview extends ChatSession {
  messageCount: number
  lastMessage: string
}

/** 世界书条目 */
export interface LoreEntry {
  id: string
  keywords: string[]
  content: string
  position: 'before_char' | 'after_char' | 'at_end'
  order: number
  probability: number // 0-100
  enabled: boolean
}

/** 世界书 */
export interface Lorebook {
  id: string
  name: string
  description: string
  entries: LoreEntry[]
  enabled: boolean
  scanDepth: number // 扫描最近 N 条消息
}

/** 预设 */
export interface Preset {
  id: string
  name: string
  description: string
  systemPrompt: string
  jailbreak: string
  maxContext: number
  temperature: number
  topP: number
  maxTokens: number
  frequencyPenalty: number
  presencePenalty: number
  isBuiltin: boolean
}

/** 群聊 */
export interface GroupChat {
  id: string
  name: string
  memberIds: string[]
  currentSpeakerIndex: number
  autoMode: boolean
  createdAt: number
}

/** AI 后端提供商类型 */
export type ProviderType = 'openai' | 'claude' | 'gemini' | 'ollama'

/** 连接配置 Profile */
export interface ConnectionProfile {
  id: string
  name: string
  provider: ProviderType
  baseUrl: string
  model: string
  apiKey: string
  maxContext: number
  useInstructTemplate?: boolean
}

/** API 配置 */
export interface APIConfig {
  type: ProviderType
  apiKey: string
  baseUrl: string
  model: string
}

/** 应用设置 */
export interface Settings {
  activeProvider: ProviderType
  providers: Record<ProviderType, Omit<APIConfig, 'apiKey'>>
  /** 新版：多连接 Profile */
  connectionProfiles: ConnectionProfile[]
  activeProfileId: string | null
  activeModel: string
  activePresetId: string | null
  activeCharacterId: string | null
  theme: 'dark' | 'light' | 'system'
  themeColor: 'amber' | 'emerald' | 'ocean' | 'rose' | 'purple' | 'cyan'
  fontSize: 'compact' | 'comfortable' | 'loose' | 'custom'
  fontSizeCustom: number
  bubbleStyle: 'round' | 'standard' | 'sharp'
  messageSpacing: 'compact' | 'normal' | 'loose'
  streamOutput: boolean
  autoScroll: boolean
  // TTS 多模型配置
  ttsEnabled: boolean
  ttsModels: TTSModelConfig[]
  activeTTSModelId: string | null
  // 生图多模型配置
  imageGenModels: ImageGenModelConfig[]
  activeImageGenModelId: string | null
  // 识图多模型配置
  visionModels: VisionModelConfig[]
  activeVisionModelId: string | null
  // 用户人设
  userName: string
  userDescription: string
  userPersona: string
  activePersonaId: string | null
  // 显示选项
  htmlRendering: boolean
  showTokenCount: boolean
  /** 心理描写输出格式（<thought> 标签）是否启用，默认 true */
  enableThoughtFormat?: boolean
  /** 是否启用 token 用量统计 */
  enableUsageTracking?: boolean
  /** 费用规则列表 */
  pricingRules?: PricingRule[]
  /** 用户时区（用于按天统计） */
  timezone?: string
}

// ===================== 功能模型配置 =====================

/** TTS 模型配置 */
export interface TTSModelConfig {
  id: string
  name: string
  provider: 'edge' | 'openai'
  model: string
  voice: string
  apiKey: string
  baseUrl: string
  enabled: boolean
  order: number
}

/** 生图模型配置 */
export interface ImageGenModelConfig {
  id: string
  name: string
  provider: string
  model: string
  apiKey: string
  baseUrl: string
  size: string
  quality: string
  enabled: boolean
  order: number
}

/** 识图模型配置 */
export interface VisionModelConfig {
  id: string
  name: string
  model: string
  enabled: boolean
  order: number
}

/** TTS 选项 */
export interface TTSOptions {
  provider: 'edge' | 'openai'
  voice: string
  rate: number
}

/** 语音列表项 */
export interface Voice {
  id: string
  name: string
  lang: string
}

// ===================== 正则表达式 =====================

export interface RegexRule {
  id: string
  name: string
  pattern: string
  replacement: string
  enabled: boolean
  scope: 'input' | 'output' | 'both'
}

// ===================== AI 调用参数 =====================

export interface ChatParams {
  requestId: string
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[]
  provider: ProviderType
  apiKey: string
  baseUrl: string
  model: string
  temperature: number
  topP: number
  maxTokens: number
  frequencyPenalty: number
  presencePenalty: number
  stream: boolean
  /** 可选的 instruct 模板（本次调用的消息包装格式） */
  instructTemplate?: InstructTemplateConfig
  /** 工具定义（OpenAI Function Calling 格式） */
  tools?: Array<{
    type: 'function'
    function: {
      name: string
      description: string
      parameters: object  // JSON Schema
    }
  }>
  /** 工具选择策略 */
  toolChoice?: 'auto' | 'none' | 'required'
}

/** Instruct 模板配置（简化版，跨 IPC 传输） */
export interface InstructTemplateConfig {
  systemPrefix: string
  systemSuffix: string
  userPrefix: string
  userSuffix: string
  assistantPrefix: string
  assistantSuffix: string
  stopSequences: string[]
  appendAssistantPrefix: boolean
}
