import type { LorebookInsertionV2, LorebookRetrievalMode } from './lorebook/domain/v2'

// ===================== 基础数据模型 =====================

/** AI 在故事中的身份、视角与叙事控制范围。 */
export type NarrativeMode = 'immersive' | 'omniscient'

/** 输入续写的剧情转折强度：控制推进幅度与采样创造性（见 shared/continueIntensity.ts）。 */
export type ContinueIntensity = 'subtle' | 'steady' | 'active' | 'bold'

/** 输入续写的最终内容长度：控制篇幅指令与输出 token 上限。 */
export type ContinueLength = 'brief' | 'standard' | 'detailed' | 'extended'

/** 消息在界面中的叙事身份；与 API role / 群聊 characterId 的消息方向解耦。 */
export type MessageSpeakerKind = 'persona' | 'narrator' | 'character' | 'system'

/** 消息内容的生成来源；用于续写、重生成与跨端协议追踪。 */
export type MessageGenerationKind =
  | 'manual'
  | 'input_continue'
  | 'assistant_reply'
  | 'regenerate'
  | 'message_continue'

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
  /** 新建会话的默认叙事模式；undefined 表示跟随全局设置。 */
  defaultNarrativeMode?: NarrativeMode
  /** 创作者备注（隐藏元数据，导入导出保留） */
  creatorNotes?: string
  /** 角色级作者注释 */
  authorNote?: AuthorNoteConfig
  /** 角色卡版本号 */
  characterVersion?: string
  /** 群聊专用开场白 */
  groupOnlyGreetings?: string[]
  /** 扩展数据（保证导入导出往返） */
  extensions?: Record<string, unknown>
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
    /** 备选开场白译文（与 alternateGreetings 数组索引对齐，未翻译项为空字符串） */
    alternateGreetings?: string[]
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
  /** 创建或生成本条消息时使用的叙事模式快照；用于历史显示与生成连续性。 */
  narrativeMode?: NarrativeMode
  /** 界面显示身份快照；旧消息缺失时由 role + narrativeMode 安全推导。 */
  speakerKind?: MessageSpeakerKind
  /** 本条内容的生成来源。 */
  generationKind?: MessageGenerationKind
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
export type MemoryFactStatus = 'active' | 'inactive' | 'superseded'

/**
 * 可追溯的长记忆事实。active 事实参与上下文和向量检索；历史事实仅用于审计与冲突追踪。
 */
export interface MemoryFact {
  id: string
  subject: string
  predicate: string
  value: string
  status: MemoryFactStatus
  importance: 1 | 2 | 3 | 4 | 5
  confidence: number
  /** 事实生效范围；用于在多角色/多分支场景下区分同名实体。 */
  scope?: string
  /** 可选实体 ID，优先于名称参与规范化键匹配。 */
  entityId?: string
  sourceMessageIds: string[]
  updatedAt: number
}

/** 旧会话的字符串事实与新结构化事实并存，成功摘要时渐进迁移。 */
export type MemoryFactRecord = string | MemoryFact

/** 模型输出的语义提案，不含事实 ID；服务端负责键匹配和变更生成。 */
export interface FactProposal {
  subject: string
  predicate: string
  value: string
  changeType: 'set' | 'clear'
  scope?: string
  entityId?: string
  importance?: 1 | 2 | 3 | 4 | 5
  confidence?: number
}

export interface MemoryFactChange {
  action: 'add' | 'update' | 'deactivate'
  id?: string
  fact?: Pick<MemoryFact, 'subject' | 'predicate' | 'value'> & Partial<Pick<MemoryFact, 'scope' | 'entityId' | 'importance' | 'confidence'>>
  patch?: Partial<Pick<MemoryFact, 'subject' | 'predicate' | 'value' | 'scope' | 'entityId' | 'importance' | 'confidence'>>
}

export interface LorebookTimedEffectState {
  /** 条目内容与触发配置指纹；条目编辑后旧效果自动失效 */
  hash: string
  /** 激活时的会话消息数 */
  start: number
  /** 效果截止消息数（到达时失效） */
  end: number
  /** sticky 结束后创建的 cooldown 可在同一消息数立即生效 */
  protected?: boolean
}

export interface LorebookTimedEffectsState {
  sticky: Record<string, LorebookTimedEffectState>
  cooldown: Record<string, LorebookTimedEffectState>
}

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
  /** 当前情节状态：场景、地点、进行中的任务等，优先于时间线注入。 */
  memoryCurrentState?: string
  memoryUpdatedAt: number
  /** 关键事实列表（长记忆升级：摘要之外抽取的持久事实，随摘要一起更新） */
  memoryFacts?: MemoryFactRecord[]
  /** 已被推翻或替代的事实，不参与上下文和向量检索。 */
  memoryFactHistory?: MemoryFact[]
  /** 最近连续的结构化事实解析失败次数；不影响时间线摘要推进。 */
  memoryFactParseFailureCount?: number
  /** 下一次允许尝试结构化事实的 memoryVersion，供指数退避使用。 */
  memoryFactRetryAfterVersion?: number
  /** 事实向量（与 memoryFacts 平行，语义检索注入用；memoryUpdatedAt 作缓存失效键） */
  factsVectors?: number[][]
  /** 最后一条已纳入长记忆的消息 ID；用于增量调度，不依赖设备时钟 */
  memoryLastMessageId?: string | null
  /** 长记忆快照版本；摘要/事实每次成功提交递增 */
  memoryVersion?: number
  /** factsVectors 对应的 memoryVersion；不一致时禁止语义检索 */
  factsVectorVersion?: number
  /** 上下文溢出压缩摘要（历史被裁剪时异步压缩的早期内容） */
  compressedSummary?: string | null
  /** 已压缩消息的时间范围（防重复压缩） */
  compressedRange?: { startTs: number; endTs: number } | null
  /** 是否已自动生成标题（防重复调用） */
  titleGenerated?: boolean
  /** 绑定的用户身份 ID（null/undefined 时使用 Settings 中的默认身份） */
  personaId?: string | null
  /** 当前会话选中的世界书 ID 列表。undefined 表示未设置（回退到角色的 boundLorebookIds） */
  lorebookIds?: string[]
  /** 当前会话的叙事模式；旧会话缺省时按 immersive 运行。 */
  narrativeMode?: NarrativeMode
  /** 全局叙事下启用游戏主持式判定与行动选项；默认关闭。 */
  gameMasterMode?: boolean
  /** 最近 N 轮触发过的世界书条目 key（`${lbId}:${entryId}`），用于 recency 加权。环形缓冲 */
  recentTriggeredIds?: string[][]
  /** 世界书 sticky/cooldown 会话状态；按消息数推进 */
  lorebookTimedEffects?: LorebookTimedEffectsState
  /**
   * 世界书超限压缩缓存（阶段三）：key = 被压缩条目 key + content hash
   * （条目编辑后 key 变化，缓存天然失效）。仅保留少量条目（LRU 淘汰）。
   */
  lorebookCompressionCache?: Record<string, LorebookCompressionCacheEntry>
}

/** 世界书超限压缩缓存条目（会话持久化） */
export interface LorebookCompressionCacheEntry {
  /** AI 压缩产生的合并摘要（注入时替代被丢弃的条目集合） */
  summary: string
  /** 被压缩条目的定位 key 列表（`${lbId}:${entryId}`） */
  entryKeys: string[]
  /** 创建时间戳（旧缓存无 lastUsedAt 时的 LRU 回退依据） */
  createdAt: number
  /** 最近一次成功注入该缓存摘要的时间（LRU 淘汰依据；旧数据回退 createdAt）。 */
  lastUsedAt?: number
}

/** 会话预览（含消息数和最后消息摘要） */
export interface SessionPreview extends ChatSession {
  messageCount: number
  lastMessage: string
}

/** AI 生成触发词的来源元数据（阶段4 enrichment 管线；方案 7.5） */
export interface LoreKeywordProvenance {
  provider: string
  model: string
  generatedAt: number
  /** localize = 英文条目中文化；enrich = 通用扩词（实体/别名/多语言） */
  mode: 'localize' | 'enrich'
}

/** 世界书条目 */
export interface LoreEntry {
  id: string
  keywords: string[]
  content: string
  position: 'before_char' | 'after_char' | 'at_depth' | 'at_end'
  /** at_depth 注入深度：0 = 对话末尾，1 = 倒数第二条消息之后，依此类推 */
  depth?: number
  /**
   * at_depth 条目注入时使用的消息角色（ST position=4 的 role）。
   * undefined 时沿用现有注入行为（system 侧）；仅 at_depth 位置有意义。
   */
  role?: 'system' | 'user' | 'assistant'
  order: number
  probability: number // 0-100（运行时已有防御：导入/保存时 clamp，匹配时 Number.isFinite + clamp）
  enabled: boolean
  /** 是否使用正则表达式匹配关键词 */
  useRegex?: boolean
  /** 正则表达式标志（如 'i' 表示不区分大小写） */
  regexFlags?: string
  /** 可选过滤关键词（ST keysecondary / CC secondary_keys） */
  secondaryKeywords?: string[]
  /** 主关键词命中后的二级过滤逻辑 */
  selectiveLogic?: 'and_any' | 'and_all' | 'not_any' | 'not_all'
  /** 条目级大小写覆盖；undefined 使用项目默认（不区分大小写） */
  caseSensitive?: boolean
  /** 条目级整词覆盖；false 时允许子串匹配 */
  matchWholeWords?: boolean
  /** 该条目不能由其他世界书条目递归触发 */
  excludeRecursion?: boolean
  /** 该条目触发后，其内容不再继续触发其他条目 */
  preventRecursion?: boolean
  /** 条目级扫描消息数覆盖；0 表示初始轮仅允许递归内容触发 */
  scanDepth?: number
  /** 仅递归层可触发；数字表示最小递归层，true 等价于 1 */
  delayUntilRecursion?: boolean | number
  /** ST Inclusion Group；一个条目可属于多个互斥组 */
  inclusionGroups?: string[]
  /** 同组中优先按 order 选取，而非权重随机 */
  inclusionGroupPrioritized?: boolean
  /** 包含组随机仲裁权重 */
  inclusionGroupWeight?: number
  /** 包含组仲裁前按命中关键词数量筛选最高分条目 */
  useGroupScoring?: boolean
  /** 角色名称/标签过滤（include 或 exclude） */
  characterFilter?: {
    exclude: boolean
    names: string[]
    tags: string[]
  }
  /** 允许触发的生成类型；空或 undefined 表示全部 */
  generationTriggers?: Array<'normal' | 'continue' | 'impersonate' | 'swipe' | 'regenerate' | 'quiet'>
  /** 激活后继续保持的消息数 */
  sticky?: number
  /** 激活（或 sticky 结束）后禁止再次激活的消息数 */
  cooldown?: number
  /** 至少达到该消息数后才允许激活 */
  delay?: number
  /** 忽略世界书 token 预算（仍受上下文总上限约束） */
  ignoreBudget?: boolean
  /**
   * 匹配模式：keyword = 仅关键词/正则，semantic = 仅语义（向量），both = 两者都参与（默认）。
   * undefined 视为 both（兼容旧数据）。
   */
  matchMode?: 'keyword' | 'semantic' | 'both'
  /** AI 翻译结果（持久化，不替换原始 content） */
  translation?: string
  /**
   * 条目优先级：always = 无条件注入（跳过关键词/语义触发检查）；
   * conditional = 命中时注入（默认）；detail = 命中时注入但仅使用预算剩余额度。
   * undefined 视为 conditional（兼容旧数据）。
   */
  priority?: 'always' | 'conditional' | 'detail'
  /** 条目摘要（可选）：预算紧张时优先用此替代全文（阶段三使用，当前仅持久化） */
  summary?: string
  /**
   * AI 扩词来源记录（键为追加到 keywords 的触发词；阶段4 enrichment 管线）。
   * 仅作追溯展示，不参与匹配逻辑；经 canonical foreign 命名空间往返保留。
   */
  keywordProvenance?: Record<string, LoreKeywordProvenance>
  /**
   * canonical 编译器附带的只读运行时信息。旧 UI 仍编辑 position/matchMode，
   * 执行器优先使用这里的完整插入位置与检索语义，避免兼容视图折叠信息。
   */
  runtime?: {
    insertion: LorebookInsertionV2
    retrieval: LorebookRetrievalMode
    adapterId?: string
    title?: string
  }
}

/** 世界书 */
export interface Lorebook {
  id: string
  name: string
  description: string
  entries: LoreEntry[]
  enabled: boolean
  scanDepth: number // 扫描最近 N 条消息
  /** 是否允许本书条目内容继续递归触发；undefined 维持旧行为（允许） */
  recursiveScanning?: boolean
  /**
   * 书级 token 预算上限（Risu character_book / 外部格式导入携带）：
   * 该书条目注入 token 总量不超过此值（评分降序保留，超限先尝试 summary 替代）。
   * undefined 表示不受书级限制（仍受全局世界书预算约束）；ignoreBudget 条目不占此额度。
   */
  tokenBudget?: number
  /** canonical 文档来源；仅供运行时诊断，不参与旧 UI 编辑。 */
  runtime?: {
    schemaVersion: number
    revision?: number
    adapterId?: string
    formatVersion?: string
  }
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
  /** 分组名（按用途组织，如：通用 / 越狱 / 风格特化；空 = 未分组） */
  group?: string
  /** 预设级示例对话发送模式（覆盖全局 settings.exampleDialogMode） */
  exampleDialogMode?: 'always' | 'first_turn' | 'off'
  /** 预设级心理描写格式开关；undefined = 跟随全局设置 */
  enableThoughtFormat?: boolean
}

/** 预设 JSON 导入结果（包含兼容转换信息） */
export interface PresetImportResult {
  preset: Preset
  /** qingyu = 项目原生格式；standard = 蛇形字段的通用/酒馆预设格式 */
  sourceFormat: 'qingyu' | 'standard'
  /** 源文件中当前运行时无法应用、因此未导入的字段 */
  unsupportedFields: string[]
}

/** 群聊 */
export interface GroupChat {
  id: string
  name: string
  memberIds: string[]
  currentSpeakerIndex: number
  autoMode: boolean
  chatMode: 'mention' | 'polling' | 'free'
  /** 新建群聊会话的默认叙事模式；undefined 表示跟随全局默认值 */
  defaultNarrativeMode?: NarrativeMode
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
  /** 创建或生成本条消息时使用的叙事模式快照；用于历史显示与生成连续性。 */
  narrativeMode?: NarrativeMode
  /** 界面显示身份快照；旧消息缺失时由 characterId + narrativeMode 安全推导。 */
  speakerKind?: MessageSpeakerKind
  /** 本条内容的生成来源。 */
  generationKind?: MessageGenerationKind
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
  /** 当前群聊会话实际使用的叙事模式；旧会话缺失时固定回退 immersive */
  narrativeMode?: NarrativeMode
  /** 全局叙事下启用游戏主持式判定与行动选项；默认关闭。 */
  gameMasterMode?: boolean
  /** 是否启用长期记忆/对话摘要 */
  memoryEnabled?: boolean
  /** 记忆模式：manual 手动 / auto 自动 */
  memoryMode?: 'manual' | 'auto'
  /** 自动摘要间隔（消息数） */
  autoMemoryInterval?: number
  /** 对话历史摘要文本 */
  memory?: string
  /** 当前群聊情节状态，优先于时间线注入。 */
  memoryCurrentState?: string
  /** 上次摘要时间 */
  memoryUpdatedAt?: number
  /** 关键事实列表（长记忆升级） */
  memoryFacts?: MemoryFactRecord[]
  /** 已被推翻或替代的群聊事实，不参与上下文和向量检索。 */
  memoryFactHistory?: MemoryFact[]
  memoryFactParseFailureCount?: number
  memoryFactRetryAfterVersion?: number
  /** 事实向量（语义检索注入用） */
  factsVectors?: number[][]
  /** 最后一条已纳入长记忆的消息 ID */
  memoryLastMessageId?: string | null
  /** 长记忆快照版本 */
  memoryVersion?: number
  /** factsVectors 对应的长记忆版本 */
  factsVectorVersion?: number
  /** 上下文溢出压缩摘要 */
  compressedSummary?: string | null
  /** 已压缩消息的时间范围 */
  compressedRange?: { startTs: number; endTs: number } | null
  /** 当前群聊会话绑定的用户身份；null 表示不使用身份，undefined 为旧数据并回退默认身份 */
  personaId?: string | null
  /** 最近 N 轮触发过的世界书条目 key（`${lbId}:${entryId}`），用于 recency 加权。环形缓冲 */
  recentTriggeredIds?: string[][]
  /** 世界书 sticky/cooldown 群聊会话状态；按消息数推进 */
  lorebookTimedEffects?: LorebookTimedEffectsState
  /** 世界书超限压缩缓存（阶段三，同 ChatSession） */
  lorebookCompressionCache?: Record<string, LorebookCompressionCacheEntry>
}

/** AI 后端提供商类型 */
export type ProviderType =
  | 'openai' | 'claude' | 'gemini' | 'ollama'
  | 'openrouter'   // 路由聚合，一个 key 全模型（OpenAI 兼容）
  | 'vllm'         // 本地推理（OpenAI 兼容，默认 /v1）
  | 'lmstudio'     // LM Studio（OpenAI 兼容，默认 /v1）
  | 'tabby'        // TabbyAPI / exllamav2（OpenAI 兼容）
  | 'deepseek'     // DeepSeek（OpenAI 兼容）
  | 'groq'         // Groq 极速推理（OpenAI 兼容）
  | 'siliconflow'  // 硅基流动（OpenAI 兼容）

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
  /** 新建对话时默认启用长记忆；仅影响后续创建的单聊和群聊 */
  defaultMemoryEnabled?: boolean
  /** 新建单聊的默认叙事模式；已有会话不受影响。 */
  defaultNarrativeMode?: NarrativeMode
  /** 输入框 AI 续写的剧情转折强度（全局，默认 active） */
  continueIntensity?: ContinueIntensity
  /** 输入框 AI 续写的最终内容长度（全局，默认 standard） */
  continueLength?: ContinueLength
  /** 全局叙事模式的自定义规则模板；支持 {{user}} / {{char}}，空值时使用内置规则。 */
  omniscientNarrativeRules?: string
  // TTS 多模型配置
  ttsEnabled: boolean
  ttsModels: TTSModelConfig[]
  activeTTSModelId: string | null
  // 生图多模型配置
  imageGenModels: ImageGenModelConfig[]
  activeImageGenModelId: string | null
  /** 是否启用 AI 自动生图（AI 回复中包含 [image: ...] 标记时自动生成） */
  imageGenAutoEnabled?: boolean
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
  /** TTS 朗读时是否朗读内心想法（<thought> 块），默认 false */
  ttsReadThought?: boolean
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
  /** 语义触发（向量 RAG）配置：世界书条目语义匹配 + 向量检索 */
  semanticTrigger?: SemanticTriggerConfig
  /** 本地向量模型与后台索引策略。 */
  localModels?: LocalModelPreferences
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
  /** 嵌入服务提供商；local 由应用内已验证的本地 ONNX 模型提供。 */
  provider: 'openai' | 'ollama' | 'local'
  baseUrl: string
  model: string
  apiKey: string
  /** 复用已有连接档案的 id（可选，复用其 baseUrl/apiKey/provider） */
  profileId?: string | null
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
  /** system = Windows 系统语音（System.Speech）；openai = OpenAI 兼容 TTS（/audio/speech）；'edge' 为旧值，加载时迁移为 system */
  provider: 'system' | 'openai' | 'edge'
  model: string
  voice: string
  apiKey: string
  baseUrl: string
  /** Edge TTS 代理地址（如 http://127.0.0.1:7890）；留空 = 直连 */
  proxy?: string
  enabled: boolean
  order: number
}

/** 生图提供商 */
export type ImageGenProvider = 'openai' | 'sd-webui' | 'comfyui'

/** 生图配置的公共字段 */
export interface ImageGenModelBase {
  id: string
  name: string
  apiKey: string
  baseUrl: string
  enabled: boolean
  order: number
}

/** OpenAI DALL-E 配置 */
export interface OpenAiImageGenConfig extends ImageGenModelBase {
  provider: 'openai'
  model: string
  size: string
  quality: string
}

/** SD WebUI (A1111) 配置 */
export interface SdWebUiImageGenConfig extends ImageGenModelBase {
  provider: 'sd-webui'
  model: string
  size: string
  negativePrompt?: string
  steps?: number
  cfgScale?: number
  sampler?: string
}

/**
 * ComfyUI 配置。
 *
 * 以工作流快照为唯一事实来源：参数只通过 `overrides` 按节点精确覆盖，
 * 不再保存 SD WebUI 风格的通用字段。
 */
export interface ComfyImageGenConfig extends ImageGenModelBase {
  provider: 'comfyui'
  /** 可执行工作流快照；原文件移动或删除后仍可运行 */
  workflow: string
  workflowMeta?: ComfyWorkflowMeta
  /** 仅在自动识别无法唯一确定时保存用户选择 */
  bindings?: ComfyWorkflowBindings
  /** 节点级覆盖，键为 `节点ID.输入名`，例如 `57:3.steps` */
  overrides?: Record<string, unknown>
  /**
   * @deprecated 仅供内置基础工作流回退使用。
   * 阶段四迁移会把内置工作流物化为真实快照，届时移除本字段。
   */
  model?: string
  /** @deprecated 导入工作流时的来源名称，仅用于界面展示 */
  workflowName?: string
}

/** 生图模型配置；按 provider 判别 */
export type ImageGenModelConfig = OpenAiImageGenConfig | SdWebUiImageGenConfig | ComfyImageGenConfig

/** 工作流来源元信息，用于展示来源并检测文件更新 */
export interface ComfyWorkflowMeta {
  sourceName?: string
  sourcePath?: string
  nodeCount: number
  converted: boolean
  hash: string
  analyzerVersion: number
}

/** 提示词与输出节点的角色绑定；只保存自动识别无法唯一确定的项 */
export interface ComfyWorkflowBindings {
  positivePromptNodeIds: string[]
  negativePromptNodeIds?: string[]
  outputNodeIds: string[]
}

export interface LocalModelPreferences {
  retrievalMode: 'auto' | 'local' | 'remote' | 'lexical'
  autoIndex: boolean
  updatePolicy: 'notify' | 'download' | 'auto'
  idleOnly: boolean
  batchSize: number
}

/** 识图模型配置 */
export interface VisionModelConfig {
  id: string
  name: string
  /** 提供商；留空 = 复用当前对话 Profile 的连接 */
  provider?: string
  model: string
  /** Base URL；留空 = 复用当前对话 Profile 的 baseUrl */
  baseUrl?: string
  /** API Key；留空 = 复用当前对话 Profile 的 apiKey */
  apiKey?: string
  enabled: boolean
  order: number
}

/** TTS 选项 */
export interface TTSOptions {
  provider: 'system' | 'openai' | 'edge'
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
  messages: { role: 'system' | 'user' | 'assistant'; content: string; images?: string[] }[]
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
  /** 辅助型请求可关闭推理；不支持该能力的适配器忽略此字段。 */
  reasoningMode?: 'default' | 'disabled'
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
  /** 工具选择策略（'auto' | 'none' | 'required'，或对象形式指定具体工具） */
  toolChoice?: 'auto' | 'none' | 'required' | { type: 'auto' | 'any' | 'tool'; function?: { name: string } }
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
