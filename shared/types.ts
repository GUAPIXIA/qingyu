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
  /** 长记忆默认配置：新建会话时继承（会话级开关可覆盖） */
  defaultMemoryEnabled?: boolean
  defaultMemoryMode?: 'manual' | 'auto'
  defaultMemoryInterval?: number
  /** 创作者备注（隐藏元数据，导入导出保留） */
  creatorNotes?: string
  /** 角色级作者注释（覆盖全局 settings.authorNote；未设置时使用全局） */
  authorNote?: AuthorNoteConfig
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
  /** 引用回复的目标消息 ID（单聊引用回复） */
  replyToId?: string
  /** 本次 AI 回复的字符用量（仅 assistant 消息） */
  charUsage?: MessageCharUsage
}

/** 单条消息的字符统计 */
export interface MessageCharUsage {
  /** 用户输入字符数 */
  inputChars: number
  /** 系统输出字符数 */
  outputChars: number
  /** 总字符数 */
  totalChars: number
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
  inputChars: number
  outputChars: number
  totalChars: number
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
  /** 关键事实列表（长记忆升级：摘要之外抽取的持久事实，随摘要一起更新） */
  memoryFacts?: string[]
  /** 事实向量（与 memoryFacts 平行，语义检索注入用；memoryUpdatedAt 作缓存失效键） */
  factsVectors?: number[][]
  /** 上下文溢出压缩摘要（历史被裁剪时异步压缩的早期内容） */
  compressedSummary?: string
  /** 已压缩消息的时间范围（防重复压缩） */
  compressedRange?: { startTs: number; endTs: number }
  /** 是否已自动生成标题（防重复调用） */
  titleGenerated?: boolean
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
  position: 'before_char' | 'after_char' | 'at_depth' | 'at_end'
  /** at_depth 注入深度：0 = 对话末尾，1 = 倒数第二条消息之后，依此类推 */
  depth?: number
  order: number
  probability: number // 0-100
  enabled: boolean
  /** 是否使用正则表达式匹配关键词 */
  useRegex?: boolean
  /** 正则表达式标志（如 'i' 表示不区分大小写） */
  regexFlags?: string
  /**
   * 匹配模式：keyword = 仅关键词/正则，semantic = 仅语义（向量），both = 两者都参与（默认）。
   * undefined 视为 both（兼容旧数据）。
   */
  matchMode?: 'keyword' | 'semantic' | 'both'
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
  /** 上下文模板名（如 'chatml' / 'llama3' / 'alpaca'；空 = 不启用模板包装） */
  contextTemplate?: string
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
  /** 消息气泡不透明度 (0-1) */
  bubbleOpacity?: number
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
  /** 字符用量 */
  charUsage?: MessageCharUsage
  /** 引用回复的目标消息 ID */
  replyToId?: string | null
  /** 用户消息发送状态：sending 发送中 / sent 已发送（仅 characterId === '__user__'） */
  status?: 'sending' | 'sent'
  /** @提及的角色 ID 列表 */
  mentionedCharacterIds?: string[]
}

/** 自定义字体信息 */
export interface CustomFont {
  id: string
  name: string          // 显示名（不含扩展名）
  fileName: string      // 存储文件名（id + 扩展名）
  format: 'ttf' | 'otf'
  size: number          // 文件大小（字节）
  createdAt: number
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
  /** 关键事实列表（长记忆升级） */
  memoryFacts?: string[]
  /** 事实向量（语义检索注入用） */
  factsVectors?: number[][]
  /** 上下文溢出压缩摘要 */
  compressedSummary?: string
  /** 已压缩消息的时间范围 */
  compressedRange?: { startTs: number; endTs: number }
}

/** AI 后端提供商类型 */
export type ProviderType =
  | 'openai' | 'claude' | 'gemini' | 'ollama'
  | 'openrouter'   // 路由聚合，一个 key 全模型（OpenAI 兼容）
  | 'vllm'         // 本地推理（OpenAI 兼容，默认 /v1）
  | 'lmstudio'     // LM Studio（OpenAI 兼容，默认 /v1）
  | 'tabby'        // TabbyAPI / exllamav2（OpenAI 兼容）

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
  /** 对话示例发送模式：always（默认）每轮发送 / first_turn 仅会话首轮 / off 关闭 */
  exampleDialogMode?: 'always' | 'first_turn' | 'off'
  /** 世界书 token 预算占上下文预算的比例（0-1，默认 0.3；1 = 不限制） */
  lorebookRatio?: number
  /** 是否启用字符用量统计 */
  enableUsageTracking?: boolean
  /** 用户时区（用于按天统计） */
  timezone?: string
  /** 是否使用角色封面作为聊天背景（未设置封面的角色回退到手动背景） */
  useCoverAsBackground?: boolean
  /** 翻译目标语言（默认中文） */
  translationTargetLang?: string
  /** 封面下载代理地址（如 http://127.0.0.1:7890），为空则不使用代理 */
  coverProxyUrl?: string
  /** 对话字体族：'system' 使用系统默认，其余为字体族名或自定义字体名 */
  fontFamily?: string
  /** 自定义字体 ID（对应 font:list 返回的 id），null 表示使用内置字体 */
  customFontId?: string | null
  /** 作者注释（全局级；角色可设置 authorNote 覆盖） */
  authorNote?: AuthorNoteConfig
  /** 语义触发（向量 RAG）配置：世界书条目语义匹配 + 向量检索 */
  semanticTrigger?: SemanticTriggerConfig
  /** 用户人设注入配置：与系统提示词的合并规则 */
  personaInjection?: PersonaInjectionConfig
  /** 上下文溢出压缩配置：历史被裁剪时异步压缩早期内容 */
  contextCompression?: {
    enabled: boolean
    /** 触发阈值：被裁剪的历史 token 量 ≥ 此值才压缩 */
    minDropTokens: number
  }
  /** 新会话自动生成标题（默认开） */
  autoTitle?: boolean
}

/** 用户人设注入配置（ST 的 User Persona description placement） */
export interface PersonaInjectionConfig {
  /** 是否注入用户人设（关闭 = 仅保留 {{user}} 变量替换） */
  enabled: boolean
  /** 注入位置：system = 拼入系统提示词（默认）；separate = 独立 system 消息 */
  position: 'system' | 'separate'
  /** 是否注入用户描述（userDescription） */
  includeDescription: boolean
  /** 是否注入用户性格（userPersona） */
  includePersona: boolean
}

/** 语义触发（向量 RAG）配置 */
export interface SemanticTriggerConfig {
  /** 是否启用语义触发 */
  enabled: boolean
  /** 嵌入服务提供商：openai = OpenAI 兼容 embeddings，ollama = Ollama /api/embed */
  provider: 'openai' | 'ollama'
  baseUrl: string
  model: string
  apiKey: string
  /** 余弦相似度阈值（0-1），分数 ≥ 阈值才命中。默认 0.3 */
  threshold: number
  /** 每次最多注入的语义命中条目数。默认 3 */
  maxResults: number
}

/** 作者注释配置（ST Author's Note 简化版） */
export interface AuthorNoteConfig {
  enabled: boolean
  text: string
  /** 注入位置：top = 系统提示之后，middle = 历史消息中（按 depth），bottom = 历史消息末尾 */
  position: 'top' | 'middle' | 'bottom'
  /** middle 时的注入深度：0 = 对话末尾，1 = 倒数第二条消息之后，依此类推 */
  depth: number
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
  /** 正则标志,默认 'g' */
  flags?: string
  enabled: boolean
  scope: 'input' | 'output' | 'both'
  /** 分组名（按用途组织：翻译修复 / 格式清理 / 越狱清理 等，空 = 未分组） */
  group?: string
  /** 处理阶段：text = 生成/输入文本（默认），markdown = 渲染前文本（仅 output，在 text 规则之后应用） */
  stage?: 'text' | 'markdown'
  /** 触发条件：文本匹配此正则才执行本规则（空 = 总是执行） */
  triggerPattern?: string
  /** 触发条件正则标志 */
  triggerFlags?: string
  /** 停止字符串（output）：生成文本命中后终止输出并截断（可多条） */
  stopStrings?: string[]
}

// ===================== 快捷回复 =====================

/** 快捷回复动作类型 */
export interface QuickReply {
  id: string
  /** 按钮显示名 */
  label: string
  /** 发送内容（支持宏展开） */
  content: string
  /** text = 发送文本；preset = 切换预设；command = 触发斜杠命令 */
  action: 'text' | 'preset' | 'command'
  /** action=preset 时的预设 ID */
  presetId?: string
  /** action=command 时的命令文本（含 /） */
  command?: string
  /** 发送后是否触发 AI 回复（仅 action=text） */
  sendWithAI: boolean
  /** 键盘快捷键 1-9（Ctrl+数字触发） */
  hotkey?: number
  order: number
  enabled: boolean
}

/** 快捷回复存储结构：全局 + 按角色 */
export interface QuickReplyStore {
  global: QuickReply[]
  /** characterId → 角色专属快捷回复 */
  byCharacter: Record<string, QuickReply[]>
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

// ===================== MCP 工具协议 =====================

/** MCP Server 配置 */
export interface McpServerConfig {
  id: string
  name: string
  /** 传输方式 */
  transport: 'stdio' | 'sse'
  /** stdio: 命令和参数；sse: URL */
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  /** 是否启用 */
  enabled: boolean
  /** 自动启动 */
  autoStart: boolean
}

/** MCP 工具定义 */
export interface McpTool {
  serverId: string
  name: string
  description: string
  inputSchema: {
    type: 'object'
    properties: Record<string, {
      type: string
      description?: string
      enum?: string[]
    }>
    required?: string[]
  }
}

/** MCP 调用结果 */
export interface McpToolResult {
  content: Array<{
    type: 'text' | 'image' | 'resource'
    text?: string
    data?: string  // base64
    mimeType?: string
  }>
  isError?: boolean
}

/** Server 状态信息 */
export interface McpServerStatus {
  id: string
  connected: boolean
  toolCount: number
  lastError?: string
}

// ===================== 用量统计聚合 =====================

/** 用量聚合结果项 */
export interface AggregatedUsage {
  key: string
  inputChars: number
  outputChars: number
  totalChars: number
  count: number
}

/** 用量汇总 */
export interface UsageSummary {
  totalInput: number
  totalOutput: number
  totalChars: number
  count: number
}
