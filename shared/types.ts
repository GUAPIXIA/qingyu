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
  /** @deprecated 使用 boundLorebookIds 替代，保留仅为向后兼容旧数据 */
  lorebookId: string | null
  /** 绑定的预设 ID（切换到此角色时自动激活） */
  boundPresetId?: string | null
  /** 绑定的世界书 ID 列表（切换到此角色时自动激活，取代单个 lorebookId） */
  boundLorebookIds?: string[]
  /** 是否置顶 */
  pinned?: boolean
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
  /** 聊天页背景参数 */
  chatBackgroundParams?: {
    opacity: number
    blur: number
    type: 'image' | 'gradient'
    gradient?: string
    posX: number
    posY: number
    scale: number
    /** 使用角色封面作为背景（与自定义图片互斥） */
    useCover?: boolean
  }
  /** 封面毛玻璃效果（角色卡页面独立控制） */
  coverBlurEnabled?: boolean
  /** 翻译内容：UI 显示优先使用，AI 上下文继续使用原始字段 */
  translatedContent?: {
    name?: string
    description?: string
    personality?: string
    scenario?: string
    firstMessage?: string
    exampleDialog?: string
  }
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
  /** 绑定的用户身份 ID（null/undefined 时使用 Settings 中的默认身份） */
  personaId?: string | null
  /** 当前会话选中的世界书 ID 列表。undefined 表示未设置（回退到角色的 boundLorebookIds） */
  lorebookIds?: string[]
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
  /** 是否使用正则表达式匹配关键词 */
  useRegex?: boolean
  /** 正则表达式标志（如 'i' 表示不区分大小写） */
  regexFlags?: string
  /** AI 翻译结果（持久化，不替换原始 content） */
  translation?: string
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
  chatMode: 'mention' | 'polling' | 'free'
  maxRounds: number
  speakerInterval: number
  lorebookIds: string[]
  presetId: string | null
  systemPrompt: string
  createdAt: number
  updatedAt: number
  /** 聊天背景图（base64） */
  chatBackground?: string
  /** 背景参数 */
  chatBackgroundParams?: {
    opacity: number
    blur: number
    type: 'image' | 'gradient'
    gradient?: string
  }
  /** 自定义主题色（十六进制） */
  themeColor?: string
}

/** 群聊消息 */
export interface GroupMessage {
  id: string
  groupId: string
  characterId: string
  content: string
  images: string[]
  timestamp: number
  round: number
  /** 翻译结果 */
  translation?: string | null
  /** 是否显示翻译 */
  _showTranslation?: boolean
  /** Token 用量 */
  tokenUsage?: MessageTokenUsage
}

/** 群聊会话 */
export interface GroupSession {
  id: string
  groupId: string
  title: string
  messageCount: number
  createdAt: number
  updatedAt: number
  /** 是否启用长期记忆/对话摘要 */
  memoryEnabled?: boolean
  /** 记忆模式：manual 手动 / auto 自动 */
  memoryMode?: 'manual' | 'auto'
  /** 自动摘要间隔（消息数） */
  autoMemoryInterval?: number
  /** 对话历史摘要文本 */
  memory?: string
  /** 上次摘要时间 */
  memoryUpdatedAt?: number
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
  activeSessionId: string | null
  theme: 'dark' | 'light' | 'system'
  themeColor: 'amber' | 'emerald' | 'ocean' | 'rose' | 'purple' | 'cyan'
  fontSize: 'compact' | 'comfortable' | 'loose' | 'custom'
  fontSizeCustom: number
  bubbleStyle: 'round' | 'standard' | 'sharp'
  messageSpacing: number
  /** 消息宽度（px） */
  messageWidth: number
  streamOutput: boolean
  autoScroll: boolean
  // TTS 多模型配置
  ttsEnabled: boolean
  ttsModels: TTSModelConfig[]
  activeTTSModelId: string | null
  // 生图多模型配置
  imageGenModels: ImageGenModelConfig[]
  activeImageGenModelId: string | null
  /** 是否启用 AI 自动生图（AI 回复中包含 [image: ...] 标记时自动生成） */
  imageGenAutoEnabled?: boolean
  /** 当前选择的生图尺寸（运行时可切换，覆盖模型配置中的默认值） */
  imageGenSize?: string
  // 识图多模型配置
  visionModels: VisionModelConfig[]
  activeVisionModelId: string | null
  // 用户人设
  userName: string
  userDescription: string
  userPersona: string
  activePersonaId: string | null
  /** 默认身份 ID（新建会话时自动绑定，侧栏切换时同步更新） */
  defaultPersonaId?: string | null
  // 显示选项
  htmlRendering: boolean
  showTokenCount: boolean
  /** 心理描写输出格式（<thought> 标签）是否启用，默认 true */
  enableThoughtFormat?: boolean
  /** 心理描写是否默认展开，默认 false */
  autoExpandThought?: boolean
  /** 封面毛玻璃模糊强度（px，0 = 禁用，默认 8） */
  coverBlurStrength?: number
  /** 对话示例位置：after_system（默认）= 系统提示后，after_history = 历史消息后 */
  exampleDialogPosition?: 'after_system' | 'after_history'
  /** 是否启用 token 用量统计 */
  enableUsageTracking?: boolean
  /** 费用规则列表 */
  pricingRules?: PricingRule[]
  /** 用户时区（用于按天统计） */
  timezone?: string
  /** 是否使用角色封面作为聊天背景（未设置封面的角色回退到手动背景） */
  useCoverAsBackground?: boolean
  /** 翻译目标语言（默认中文） */
  translationTargetLang?: string
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
  provider: string          // 'openai' | 'sd-webui'
  model: string
  apiKey: string
  baseUrl: string
  size: string
  quality: string           // OpenAI DALL-E 用
  enabled: boolean
  order: number
  // SD WebUI 特有参数（provider === 'sd-webui' 时使用）
  negativePrompt?: string
  steps?: number            // 默认 20
  cfgScale?: number         // 默认 7
  sampler?: string          // 如 'Euler a'
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

// ===================== 在线公告 =====================

/** 在线公告（从服务器拉取） */
export interface Announcement {
  id: number
  title: string
  content: string      // Markdown 内容
  summary: string
  pinned: boolean
  published: boolean
  createdAt: string
  updatedAt: string
}
