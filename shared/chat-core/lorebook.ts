/**
 * 世界书（Lorebook）工具函数与统一缓存
 *
 * 统一入口，避免 fallback 链在各处重复。
 * 缓存层供 buildContext 同步使用（无需 IPC）。
 */

import type {
  Character,
  Lorebook,
  LoreEntry,
  LorebookCompressionCacheEntry,
  LorebookTimedEffectsState,
} from '../types'
import type { LorebookInsertionV2, LorebookRetrievalMode } from '../lorebook/domain/v2'
import { estimateTokens } from './tokenCounter'
import { replaceVariables } from './variables'
import { expandMacros } from './macros'
import { logWarn } from './logging'
import { LOREBOOK_PRIORITY_BUDGET, LOREBOOK_SCORE_WEIGHTS, LOREBOOK_RECENCY_WINDOW } from './chatConstants'
import {
  renderLorebookItems,
  type LorebookRenderItem,
  type LorebookRenderPlan,
} from './lorebookRenderer'
import {
  defaultLexicalRetrievalProvider,
  reciprocalRankFusion,
  type LexicalRetrievalHit,
  type RetrievalProvider,
} from './lorebookRetrieval'

// ===================== 工具函数 =====================

/** 从角色获取有效的世界书 ID 列表（处理 boundLorebookIds / lorebookId 兼容） */
export function getEffectiveLorebookIds(character: Character | null | undefined): string[] {
  if (!character) return []
  return character.boundLorebookIds
    ?? (character.lorebookId ? [character.lorebookId] : [])
}

/**
 * 将角色的 legacy lorebookId 迁移到 boundLorebookIds。
 * 纯函数：不执行持久化，调用者自行保存。
 * 如果不需要迁移则返回原对象引用。
 */
export function migrateLorebookId(char: Character): Character {
  if (char.lorebookId && (!char.boundLorebookIds || char.boundLorebookIds.length === 0)) {
    return { ...char, boundLorebookIds: [char.lorebookId] }
  }
  return char
}

// ===================== 扫描文本去噪（P0） =====================

/**
 * 扫描文本去噪：剥离 markdown 语法与代码，降低关键词误触发：
 * - 围栏代码块（```/~~~）整体移除（代码 token 对剧情关键词无意义，且是 ASCII 误报源）
 * - 图片/HTML 标签整体移除；链接保留文字、丢弃 URL
 * - 行内代码去反引号保留内容；粗体/斜体/删除线/`*动作*` 去标记保留内容
 * - 行首标题/引用/列表/表格标记剥离
 * 递归触发的条目内容不去噪（那是世界书作者原文，非对话噪声）。
 */
export function stripMarkdownNoise(text: string): string {
  if (!text) return text
  return text
    // 1. 围栏代码块整体移除
    .replace(/(```|~~~)[\s\S]*?\1/g, ' ')
    // 2. 图片整体移除（先于链接，避免 ![]() 被当成链接保留 alt）
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    // 3. 链接保留文字
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    // 4. HTML 标签移除
    .replace(/<\/?[a-zA-Z][^>]*>/g, ' ')
    // 5. 行内代码去反引号
    .replace(/`([^`\n]*)`/g, '$1')
    // 6. 粗体/删除线/斜体标记剥离（**x** / __x__ / ~~x~~ / *x* / _x_）
    .replace(/(\*\*|__|~~)(?=\S)([\s\S]*?\S)\1/g, '$2')
    .replace(/(?<![A-Za-z0-9_*])(\*|_)(?=\S)([^*_\n]*?\S)\1(?![A-Za-z0-9_*])/g, '$2')
    // 7. 行首标题/引用/列表/表格分隔符标记
    .replace(/^[ \t]*(?:#{1,6}[ \t]+|>[ \t]?|[-*+][ \t]+|[0-9]+[.)][ \t]+|[|][-|: ]+[|])[ \t]*/gm, '')
    // 8. 水平分割线
    .replace(/^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/gm, ' ')
}

/** 去噪结果缓存（消息文本固定且幂等；上限淘汰最早项防内存增长） */
const STRIP_CACHE_MAX = 200
const stripNoiseCache = new Map<string, string>()
function stripScanText(text: string): string {
  const cached = stripNoiseCache.get(text)
  if (cached !== undefined) return cached
  const stripped = stripMarkdownNoise(text)
  if (stripNoiseCache.size >= STRIP_CACHE_MAX) {
    const oldest = stripNoiseCache.keys().next().value
    if (oldest !== undefined) stripNoiseCache.delete(oldest)
  }
  stripNoiseCache.set(text, stripped)
  return stripped
}

// ===================== 关键词匹配（去噪） =====================

/** 转义正则特殊字符 */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** CJK 单字关键词命中处的边界字符（标点/空白） */
const CJK_BOUNDARY = /[\s，。、；：！？…·—""''（）【】《》〈〉「」『』,.!?;:()[\]{}<>"'|/\\-]/

/** ASCII 关键词的词边界正则缓存 */
// BUG-23 修复：限制缓存上限，超出时淘汰最早项，避免长期使用内存无限增长
const ASCII_REGEX_CACHE_MAX = 500
const asciiKeywordRegexCache = new Map<string, RegExp | null>()
function cacheAsciiRegex(kw: string, regex: RegExp | null): void {
  if (asciiKeywordRegexCache.size >= ASCII_REGEX_CACHE_MAX) {
    const oldest = asciiKeywordRegexCache.keys().next().value
    if (oldest !== undefined) asciiKeywordRegexCache.delete(oldest)
  }
  asciiKeywordRegexCache.set(kw, regex)
}

/**
 * 世界书普通关键词匹配（词边界感知，减少误触发）：
 * - 纯 ASCII 关键词：`\b` 词边界匹配（避免 cat 误中 category）
 * - 含 CJK 且长度 ≥ 2：子串匹配（中文多字词误报率低，维持召回）
 * - CJK 单字：命中位置前后需为标点/空白/文本边界，否则视为未命中
 *
 * @param keyword 原始关键词（内部会 trim + 小写）
 * @param textLower 已转小写的扫描文本
 */
export function keywordMatch(keyword: string, textLower: string): boolean {
  const kw = keyword.trim().toLowerCase()
  if (!kw) return false

  // 纯 ASCII：词边界匹配（\b 仅在关键词首/尾为单词字符时适用）
  if (/^\p{ASCII}+$/u.test(kw)) {
    let regex = asciiKeywordRegexCache.get(kw)
    if (regex === undefined) {
      try {
        const start = /^\w/.test(kw) ? '\\b' : ''
        const end = /\w$/.test(kw) ? '\\b' : ''
        regex = new RegExp(`${start}${escapeRegExp(kw)}${end}`)
      } catch {
        regex = null
      }
      cacheAsciiRegex(kw, regex)
    }
    return regex ? regex.test(textLower) : textLower.includes(kw)
  }

  // 含 CJK 的多字词：维持子串匹配（不引入漏触发）
  if (kw.length >= 2) return textLower.includes(kw)

  // CJK 单字：要求命中处前后为边界
  let idx = textLower.indexOf(kw)
  while (idx !== -1) {
    const before = idx === 0 ? '' : textLower[idx - 1]
    const after = idx + kw.length >= textLower.length ? '' : textLower[idx + kw.length]
    if ((before === '' || CJK_BOUNDARY.test(before)) && (after === '' || CJK_BOUNDARY.test(after))) {
      return true
    }
    idx = textLower.indexOf(kw, idx + 1)
  }
  return false
}

/** 解析 ST 的 /pattern/flags 关键词；非法正则回退为普通关键词。 */
function parseRegexLiteral(keyword: string): { pattern: string; flags: string } | null {
  const match = keyword.trim().match(/^\/([\s\S]*)\/([a-z]*)$/i)
  if (!match) return null
  try {
    // 仅用于校验；触发时使用当前轮次的正则缓存。
    new RegExp(match[1], match[2])
    return { pattern: match[1], flags: match[2] }
  } catch {
    return null
  }
}

/** 计数上限：频率计分无需精确计数，防御超长文本下的循环开销 */
const KEYWORD_COUNT_MAX = 100

/** 统计正则匹配次数（强制全局 flag；缓存 key 含 flags 故与布尔匹配缓存互不冲突） */
function countRegexMatches(
  pattern: string,
  flags: string,
  text: string,
  cache: Map<string, RegExp>,
): number {
  const globalFlags = flags.includes('g') ? flags : flags + 'g'
  const cacheKey = `${pattern}|${globalFlags}`
  let regex = cache.get(cacheKey)
  if (!regex) {
    try {
      regex = new RegExp(pattern, globalFlags)
      cache.set(cacheKey, regex)
    } catch {
      return 0
    }
  }
  regex.lastIndex = 0
  let count = 0
  while (count < KEYWORD_COUNT_MAX && regex.exec(text) !== null) count++
  regex.lastIndex = 0
  return count
}

/** 子串出现次数计数 */
function countSubstring(haystack: string, needle: string): number {
  let count = 0
  let idx = haystack.indexOf(needle)
  while (idx !== -1 && count < KEYWORD_COUNT_MAX) {
    count++
    idx = haystack.indexOf(needle, idx + 1)
  }
  return count
}

/** CJK 单字关键词的边界命中计数（命中处前后需为标点/空白/文本边界） */
function countCjkSingleChar(text: string, kw: string): number {
  let count = 0
  let idx = text.indexOf(kw)
  while (idx !== -1 && count < KEYWORD_COUNT_MAX) {
    const before = idx === 0 ? '' : text[idx - 1]
    const after = idx + kw.length >= text.length ? '' : text[idx + kw.length]
    if ((before === '' || CJK_BOUNDARY.test(before)) && (after === '' || CJK_BOUNDARY.test(after))) count++
    idx = text.indexOf(kw, idx + 1)
  }
  return count
}

/**
 * 条目级关键词命中计数（P0 频率计分核心）：返回关键词在文本中的出现次数（0-N）。
 * 匹配语义与原布尔匹配完全一致（大小写/整词覆盖、entry useRegex 与 ST /regex/flags）。
 */
function loreEntryKeywordCount(
  entry: LoreEntry,
  keyword: string,
  text: string,
  textLower: string,
  regexCache: Map<string, RegExp>,
): number {
  const regexLiteral = parseRegexLiteral(keyword)
  if (regexLiteral) {
    return countRegexMatches(regexLiteral.pattern, regexLiteral.flags, text, regexCache)
  }
  if (entry.useRegex) {
    return countRegexMatches(keyword, entry.regexFlags || 'i', text, regexCache)
  }

  const trimmed = keyword.trim()
  if (!trimmed) return 0
  const caseSensitive = entry.caseSensitive === true
  const matchWholeWords = entry.matchWholeWords !== false
  const haystack = caseSensitive ? text : textLower
  const needle = caseSensitive ? trimmed : trimmed.toLowerCase()
  if (!matchWholeWords) return countSubstring(haystack, needle)
  if (!caseSensitive) {
    if (/^\p{ASCII}+$/u.test(needle)) {
      const start = /^\w/.test(needle) ? '\\b' : ''
      const end = /\w$/.test(needle) ? '\\b' : ''
      return countRegexMatches(`${start}${escapeRegExp(needle)}${end}`, '', textLower, regexCache)
    }
    if (needle.length >= 2) return countSubstring(textLower, needle)
    return countCjkSingleChar(textLower, needle)
  }

  if (/^\p{ASCII}+$/u.test(needle)) {
    const start = /^\w/.test(needle) ? '\\b' : ''
    const end = /\w$/.test(needle) ? '\\b' : ''
    return countRegexMatches(`${start}${escapeRegExp(needle)}${end}`, '', text, regexCache)
  }
  if (needle.length >= 2) return countSubstring(text, needle)
  return countCjkSingleChar(text, needle)
}

/** 条目级关键词匹配（布尔）：命中次数 > 0。 */
function loreEntryKeywordMatch(
  entry: LoreEntry,
  keyword: string,
  text: string,
  textLower: string,
  regexCache: Map<string, RegExp>,
): boolean {
  return loreEntryKeywordCount(entry, keyword, text, textLower, regexCache) > 0
}

/** 主关键词命中后的 ST/CC 二级关键词过滤。 */
function loreEntrySecondaryMatch(
  entry: LoreEntry,
  text: string,
  textLower: string,
  regexCache: Map<string, RegExp>,
): boolean {
  const secondary = (entry.secondaryKeywords ?? []).filter((keyword) => typeof keyword === 'string' && keyword.trim())
  const logic = entry.selectiveLogic
  if (!logic || secondary.length === 0) return true
  const matches = secondary.map((keyword) => loreEntryKeywordMatch(entry, keyword, text, textLower, regexCache))
  switch (logic) {
    case 'and_all': return matches.every(Boolean)
    case 'not_any': return matches.every((matched) => !matched)
    case 'not_all': return !matches.every(Boolean)
    default: return matches.some(Boolean)
  }
}

// ===================== 世界书 token 预算 =====================

/** 参与预算裁剪的世界书条目（分桶瀑布共享一个预算池） */
export interface BudgetLoreItem {
  content: string
  order: number
  position: 'before_char' | 'after_char' | 'at_depth' | 'at_end'
  /** at_depth 注入深度（默认 0 = 对话末尾） */
  depth?: number
  /** 条目优先级（undefined 视为 conditional，兼容旧数据） */
  priority?: 'always' | 'conditional' | 'detail'
  /** 语义相似度（余弦 0-1；语义候选携带，关键词触发条目可能经内容反查补充） */
  score?: number
  /** 条目定位键 `${lbId}:${entryId}`（recency 加权与关键词反查用；旧缓存可能缺失） */
  key?: string
  /** 手写摘要（变量替换后；阶段三：预算紧张时代替全文注入） */
  summary?: string
  /** 不占用世界书预算 */
  ignoreBudget?: boolean
  /** at_depth 条目注入消息角色（ST role）；仅 at_depth 位置有意义 */
  role?: 'system' | 'user' | 'assistant'
  /** canonical 完整插入位置；旧数据缺失时由 position/depth/role 推导。 */
  insertion?: LorebookInsertionV2
  /** 来源格式与检索策略，仅用于执行诊断。 */
  adapterId?: string
  retrievalMode?: LorebookRetrievalMode
  keywordRank?: number
  lexicalRank?: number
  lexicalScore?: number
  vectorRank?: number
  vectorScore?: number
  /** 归一化后的 RRF 分数（0-1）；原始各通道分数仍独立保留。 */
  fusionScore?: number
  fallbackReason?: 'lexical_fallback' | 'vector_miss_lexical_fallback'
}

/** 统一评分后的条目（阶段二B：关键词/语义/实体/近因合并为单一 score） */
export interface ScoredLoreItem extends BudgetLoreItem {
  score: number
  /** 关键词命中分（0-1）：coverage（命中关键词数/总数）与 frequency（1-e^(-命中次数)）各占一半 */
  keywordHits: number
  /** 语义相似度（0-1，缺失时为 0） */
  semanticScore: number
  semanticSource: 'real' | 'approx' | 'none'
  entityHit: boolean
  recencyHit: boolean
}

export type LoreTriggerOutcome =
  | 'injected'
  | 'injected_summary'
  | 'injected_compression'
  | 'dropped'
  | 'not_triggered'

export type LoreTriggerStage =
  | 'eligibility'
  | 'matching'
  | 'group_arbitration'
  | 'probability'
  | 'deduplication'
  | 'book_budget'
  | 'global_budget'
  | 'injection'

export type LoreTriggerReason =
  | 'primary_miss'
  | 'secondary_miss'
  | 'semantic_unavailable'
  | 'semantic_miss'
  | 'retrieval_miss'
  | 'character_filter'
  | 'generation_filter'
  | 'delay'
  | 'cooldown'
  | 'recursion_delay'
  | 'exclude_recursion'
  | 'inclusion_group_lost'
  | 'probability'
  | 'duplicate_content'
  | 'book_budget'
  | 'priority_budget'

export interface LoreMatchedKeyword {
  keyword: string
  count: number
  channel: 'primary' | 'secondary'
}

/** 单个世界书条目经过触发管线时的可解释轨迹。 */
export interface LoreTriggerDetail {
  key: string
  bookId: string
  bookName: string
  entryId: string
  name: string
  outcome: LoreTriggerOutcome
  stage: LoreTriggerStage
  reason?: LoreTriggerReason
  activationSource?: 'always' | 'sticky' | 'keyword' | 'lexical' | 'vector' | 'hybrid' | 'recursive'
  score?: number
  keywordHits?: number
  semanticScore?: number
  semanticSource?: 'real' | 'approx' | 'none'
  keywordRank?: number
  lexicalRank?: number
  lexicalScore?: number
  vectorRank?: number
  vectorScore?: number
  fusionScore?: number
  fallbackReason?: BudgetLoreItem['fallbackReason']
  entityHit?: boolean
  recencyHit?: boolean
  matchedKeywords?: LoreMatchedKeyword[]
  position: BudgetLoreItem['position']
  depth?: number
  role?: BudgetLoreItem['role']
  priority: NonNullable<BudgetLoreItem['priority']>
  recursionDepth?: number
  effectiveScanDepth?: number
  scanText?: string
  probability?: number
  probabilityRoll?: number
  originalTokens?: number
  injectedTokens?: number
  remainingTokens?: number
  budgetRank?: number
  ignoreBudget?: boolean
  duplicateOf?: string
  adapterId?: string
  retrievalMode?: LorebookRetrievalMode
  insertion?: LorebookInsertionV2
  renderStatus?: 'exact' | 'fallback'
  renderTarget?: string
  renderReason?: string
}

/** 一次上下文构建对应的世界书诊断快照；仅驻留内存，不持久化。 */
export interface LorebookDiagnostics {
  mode: 'live' | 'preview'
  generationType: NonNullable<LoreEntry['generationTriggers']>[number]
  createdAt: number
  summary: {
    activeBooks: number
    enabledEntries: number
    matchedEntries: number
    injectedEntries: number
    summaryEntries: number
    compressionEntries: number
    droppedEntries: number
    untriggeredEntries: number
    semanticDeadEntries: number
    budget: number
    usedTokens: number
    ignoredBudgetTokens: number
    bookBudgetDropped: number
    globalBudgetDropped: number
  }
  semantic: {
    enabled: boolean | undefined
    candidateCount: number
    source: 'current_cache'
  }
  retrieval: {
    lexicalProvider: string
    lexicalCandidateCount: number
    vectorCandidateCount: number
    embeddingsAvailable: boolean | undefined
  }
  scan: {
    rawText: string
    cleanedText: string
    messageCount: number
  }
  entries: LoreTriggerDetail[]
}

/** at_depth 注入项：按 depth 插入历史消息段内 */
export interface DepthLoreItem {
  content: string
  order: number
  depth: number
  /** 注入消息角色（ST at_depth 的 role）；undefined 沿用默认 system 侧 */
  role?: 'system' | 'user' | 'assistant'
}

/** 统一触发入口输入参数 */
export interface LorebookTriggerOptions {
  /** 已缓存且启用的世界书列表 */
  lorebooks: Lorebook[]
  /** 初始扫描文本（调用方拼接最近 N 条消息，可带角色名前缀） */
  scanText: string
  /** 按时间升序排列的消息文本；提供后可执行条目级 scanDepth 覆盖 */
  scanMessages?: string[]
  userName: string
  charName: string
  /** 当前上下文中的角色名称与标签，供 ST characterFilter 使用 */
  characterNames?: string[]
  characterTags?: string[]
  /** 当前生成类型，供 ST triggers 使用；默认 normal */
  generationType?: NonNullable<LoreEntry['generationTriggers']>[number]
  /** 当前会话消息数与已持久化定时效果；两者共同提供时启用 timed effects */
  messageCount?: number
  timedEffects?: LorebookTimedEffectsState
  /** 世界书 token 预算 */
  budget: number
  model: string
  /** 递归触发最大深度（默认 5） */
  maxRecursiveDepth?: number
  /** 语义命中候选（预取）：与关键词触发结果合并去重后统一评分裁剪（无 priority 时进 conditional 桶） */
  semanticItems?: BudgetLoreItem[]
  /** 本地词法检索实现；默认使用无原生依赖的内存 BM25 provider。 */
  lexicalProvider?: RetrievalProvider
  /** 受控实体词表补充（角色 tags、群聊成员名等；条目 keywords 与 charName 始终参与）。阶段二B */
  entityVocabulary?: string[]
  /** 最近 N 轮触发过的条目 key（环形缓冲，会话持久化），用于 recency 加权。阶段二B */
  recentTriggeredIds?: string[][]
  /** 超限压缩缓存（会话持久化）：命中时以缓存摘要替代被丢弃条目集合。阶段三 */
  compressionCache?: Record<string, LorebookCompressionCacheEntry>
  /**
   * 语义触发是否可用（调用方按设置计算：enabled 且 baseUrl/model 配置完整）。
   * 传 false 时对仅依赖语义通道（无关键词可触发）的条目发出 warn-once 告警。
   * undefined 表示未知，不告警（兼容旧行为）。
   */
  semanticEnabled?: boolean
  /** 收集条目级触发轨迹；preview 使用稳定随机数，避免每次打开面板结果跳变。 */
  diagnosticsMode?: 'live' | 'preview'
}

/** 统一触发入口输出：按插入位置分发的触发结果 */
export interface LorebookTriggerResult {
  /** 角色定义前（常驻 → 条件 → 细节；常驻段按 order，其余段按 score 降序、order 升序） */
  beforeChar: string[]
  /** 角色定义后（排序同上） */
  afterChar: string[]
  /** 系统提示末尾（排序同上） */
  atEnd: string[]
  /** 历史消息内按深度注入（排序同上） */
  atDepth: DepthLoreItem[]
  /** canonical 插入位置经过统一 renderer 后的完整渲染计划。 */
  renderPlan: LorebookRenderPlan
  /** 实际触发的条目数（合并去重后、裁剪前） */
  triggeredCount: number
  /** 因预算不足被丢弃的条目数（内容去重跳过的不计入） */
  droppedCount: number
  /** always 段被截断的条目数（正常应为 0，>0 提示常驻内容超出硬上限） */
  alwaysDropped?: number
  conditionalDropped?: number
  detailDropped?: number
  /** 因书级 tokenBudget 超限被丢弃的条目数（导入的外部格式自带书级预算） */
  bookBudgetDropped?: number
  /** 本轮触发（去重后）的条目 key，供调用方更新会话 recency 窗口。阶段二B */
  triggeredEntryKeys?: string[]
  /**
   * 超限压缩请求（阶段三）：本轮被丢弃且无法用手写 summary 替代的条目集合。
   * 调用方异步 AI 压缩后写入会话 compressionCache；下一轮同一集合再被丢弃时
   * 以缓存摘要注入（本函数内查缓存）。缓存命中并注入时不再发出请求。
   */
  compressionRequests?: LorebookCompressionRequest[]
  /** 本轮命中的压缩缓存 key，供调用方刷新 LRU 使用时间。 */
  compressionCacheHitKeys?: string[]
  /** 更新后的 sticky/cooldown 状态，供真实发送路径持久化 */
  timedEffects?: LorebookTimedEffectsState
  /** 可选触发诊断；仅调用方显式请求时生成。 */
  diagnostics?: LorebookDiagnostics
}

/** 超限压缩请求：本轮被丢弃（无手写 summary 可替代）的条件/细节条目集合 */
export interface LorebookCompressionRequest {
  /** 缓存键：被压缩条目 key + content hash（条目编辑后 key 变化，缓存天然失效） */
  key: string
  /** 被压缩条目的定位 key 列表 */
  entryKeys: string[]
  /** 被压缩条目内容（变量替换后，按注入顺序） */
  contents: string[]
  /** 压缩目标 token（= 丢弃时的剩余预算，压缩结果应恰好可容纳） */
  targetTokens: number
  /** 摘要必须保持的注入位置；不同位置/深度永不合并压缩。 */
  placement: {
    position: BudgetLoreItem['position']
    depth?: number
    insertion?: LorebookInsertionV2
  }
}

/**
 * 单桶内贪心填充：按传入顺序注入（调用方已排序），超出预算的条目丢弃
 * （继续尝试后面更小的条目）。内容去重由调用方在合并阶段全局完成。
 */
function fitGreedy(
  items: BudgetLoreItem[],
  budget: number,
  model: string,
): { kept: BudgetLoreItem[]; dropped: BudgetLoreItem[]; usedTokens: number } {
  const kept: BudgetLoreItem[] = []
  const dropped: BudgetLoreItem[] = []
  let used = 0
  for (const item of items) {
    if (item.ignoreBudget) {
      kept.push(item)
      continue
    }
    const t = estimateTokens(item.content, model)
    if (used + t > budget) {
      dropped.push(item)
      continue
    }
    kept.push(item)
    used += t
  }
  return { kept, dropped, usedTokens: used }
}

/**
 * 相关度优先填充：每个条目按排序依次尝试“全文 → 手写摘要”。
 * 避免低分短全文先占满预算，导致更高分条目的摘要反而无法注入。
 */
function fitRankedWithSummaries(
  items: BudgetLoreItem[],
  budget: number,
  model: string,
): { kept: BudgetLoreItem[]; dropped: BudgetLoreItem[]; usedTokens: number } {
  const kept: BudgetLoreItem[] = []
  const dropped: BudgetLoreItem[] = []
  let usedTokens = 0
  for (const item of items) {
    if (item.ignoreBudget) {
      kept.push(item)
      continue
    }
    const fullTokens = estimateTokens(item.content, model)
    if (usedTokens + fullTokens <= budget) {
      kept.push(item)
      usedTokens += fullTokens
      continue
    }
    const summary = typeof item.summary === 'string' ? item.summary.trim() : ''
    if (summary) {
      const summaryTokens = estimateTokens(summary, model)
      if (usedTokens + summaryTokens <= budget) {
        kept.push({ ...item, content: summary })
        usedTokens += summaryTokens
        continue
      }
    }
    dropped.push(item)
  }
  return { kept, dropped, usedTokens }
}

function legacyInsertion(
  position: BudgetLoreItem['position'],
  depth?: number,
  role?: BudgetLoreItem['role'],
): LorebookInsertionV2 {
  if (position === 'before_char') return { kind: 'prompt', anchor: 'before_character' }
  if (position === 'after_char') return { kind: 'prompt', anchor: 'after_character' }
  if (position === 'at_depth') {
    return {
      kind: 'chat',
      depth: Math.max(0, Math.floor(depth ?? 0)),
      ...(role ? { role } : {}),
    }
  }
  return { kind: 'prompt', anchor: 'prompt_end' }
}

function loreEntryInsertion(entry: LoreEntry): LorebookInsertionV2 {
  return entry.runtime?.insertion ?? legacyInsertion(entry.position, entry.depth, entry.role)
}

function loreEntryRetrievalMode(entry: LoreEntry): LorebookRetrievalMode {
  if (entry.runtime?.retrieval) return entry.runtime.retrieval
  if (entry.matchMode === 'keyword') return 'keyword'
  if (entry.matchMode === 'semantic') return 'semanticPreferred'
  return 'hybrid'
}

function loreItemInsertion(item: BudgetLoreItem): LorebookInsertionV2 {
  return item.insertion ?? legacyInsertion(item.position, item.depth, item.role)
}

function placementKey(item: BudgetLoreItem): string {
  return JSON.stringify(loreItemInsertion(item))
}

/**
 * 分桶瀑布裁剪：额度自上而下流动，低段未用完的自动留给高段。
 * - always：硬上限 40%（超限按 order 截断，调用方告警；不参与压缩）
 * - conditional：全文按 score 降序填充至「always + conditional 累计 ≤ 90%」
 *   （本轮无 detail 条目触发时不预留额度，conditional 可用满预算，旧行为精确一致）
 * - detail：全文填充剩余额度
 * - 阶段三：各段被丢弃的条目先尝试手写 summary 替代（零成本），
 *   仍被丢弃的集合按注入位置查压缩缓存（命中则以缓存摘要注入），未命中时发出 compressionRequests
 *   供调用方异步 AI 压缩（下一轮生效）。
 * 桶内排序：always 按 order 升序（全量注入，输出顺序稳定）；
 * conditional / detail 按统一 score 降序、同分按 order 升序（稳定排序）。
 */
function fitLorebookBudgetByPriority(
  items: ScoredLoreItem[],
  budget: number,
  model: string,
  compressionCache?: Record<string, LorebookCompressionCacheEntry>,
): {
  kept: BudgetLoreItem[]
  droppedItems: BudgetLoreItem[]
  compressionCoveredItems: BudgetLoreItem[]
  usedTokens: number
  alwaysDropped: number
  conditionalDropped: number
  detailDropped: number
  compressionRequests?: LorebookCompressionRequest[]
  compressionCacheHitKeys?: string[]
} {
  // 未识别的 priority 值一并落入 conditional（安全默认）
  const isAlways = (i: BudgetLoreItem) => i.priority === 'always'
  const isDetail = (i: BudgetLoreItem) => i.priority === 'detail'
  const isConditional = (i: BudgetLoreItem) => !isAlways(i) && !isDetail(i)

  const alwaysCap = Math.floor(budget * LOREBOOK_PRIORITY_BUDGET.always)
  const conditionalCumCap = items.some(isDetail)
    ? Math.floor(budget * LOREBOOK_PRIORITY_BUDGET.alwaysPlusConditional)
    : budget

  const byOrder = (a: BudgetLoreItem, b: BudgetLoreItem) => a.order - b.order
  const byScore = (a: ScoredLoreItem, b: ScoredLoreItem) => b.score - a.score || a.order - b.order

  // 1. always：全量注入（order 升序），不参与压缩
  const alwaysResult = fitGreedy([...items.filter(isAlways)].sort(byOrder), alwaysCap, model)

  // 2. conditional：按相关度逐条尝试全文 → 手写摘要
  const conditionalResult = fitRankedWithSummaries(
    [...items.filter(isConditional)].sort(byScore),
    Math.max(0, conditionalCumCap - alwaysResult.usedTokens),
    model,
  )

  // 3. detail：使用总预算剩余部分，同样逐条尝试全文 → 手写摘要
  let used = alwaysResult.usedTokens + conditionalResult.usedTokens
  const detailResult = fitRankedWithSummaries(
    [...items.filter(isDetail)].sort(byScore),
    Math.max(0, budget - used),
    model,
  )
  used += detailResult.usedTokens

  // 4. 按 position + depth 分组查缓存/请求压缩，绝不跨注入位置合并。
  const dropped = [...conditionalResult.dropped, ...detailResult.dropped]
  const groups = new Map<string, BudgetLoreItem[]>()
  for (const item of dropped) {
    const groupKey = placementKey(item)
    const group = groups.get(groupKey)
    if (group) group.push(item)
    else groups.set(groupKey, [item])
  }

  const cacheItems: BudgetLoreItem[] = []
  const covered = new Set<BudgetLoreItem>()
  const compressionCacheHitKeys: string[] = []
  const pendingGroups: Array<{ items: BudgetLoreItem[]; key: string; weight: number }> = []

  for (const groupItems of groups.values()) {
    const key = buildCompressionKey(groupItems)
    const cached = compressionCache?.[key]
    const remainingBudget = Math.max(0, budget - used)
    if (cached?.summary?.trim() && estimateTokens(cached.summary, model) <= remainingBudget) {
      const first = groupItems[0]
      cacheItems.push({
        content: cached.summary.trim(),
        order: first.order,
        position: first.position,
        depth: first.depth,
        priority: first.priority,
        insertion: loreItemInsertion(first),
        adapterId: first.adapterId,
        retrievalMode: first.retrievalMode,
      })
      used += estimateTokens(cached.summary, model)
      groupItems.forEach((item) => covered.add(item))
      compressionCacheHitKeys.push(key)
      continue
    }
    pendingGroups.push({
      items: groupItems,
      key,
      weight: groupItems.reduce((sum, item) => sum + estimateTokens(item.content, model), 0),
    })
  }

  // 将剩余预算按各位置组原始 token 占比分配，保证下一轮所有缓存同时命中也不超总预算。
  let allocatable = Math.max(0, budget - used)
  let remainingWeight = pendingGroups.reduce((sum, group) => sum + group.weight, 0)
  const compressionRequests: LorebookCompressionRequest[] = []
  for (let index = 0; index < pendingGroups.length; index++) {
    const group = pendingGroups[index]
    const targetTokens = index === pendingGroups.length - 1
      ? allocatable
      : Math.floor(allocatable * (group.weight / Math.max(1, remainingWeight)))
    remainingWeight -= group.weight
    if (targetTokens < MIN_COMPRESS_TARGET_TOKENS) continue
    allocatable -= targetTokens
    const first = group.items[0]
    compressionRequests.push({
      key: group.key,
      entryKeys: group.items.map((item) => item.key).filter((key): key is string => !!key),
      contents: group.items.map((item) => item.content),
      targetTokens,
      placement: {
        position: first.position,
        ...(first.position === 'at_depth' ? { depth: first.depth ?? 0 } : {}),
        ...(first.insertion ? { insertion: first.insertion } : {}),
      },
    })
  }

  const remainingDropped = dropped.filter((item) => !covered.has(item))

  return {
    kept: [
      ...alwaysResult.kept,
      ...conditionalResult.kept,
      ...detailResult.kept,
      ...cacheItems,
    ],
    droppedItems: remainingDropped,
    compressionCoveredItems: [...covered],
    usedTokens: used,
    alwaysDropped: alwaysResult.dropped.length,
    conditionalDropped: remainingDropped.filter(isConditional).length,
    detailDropped: remainingDropped.filter(isDetail).length,
    compressionRequests: compressionRequests.length > 0 ? compressionRequests : undefined,
    compressionCacheHitKeys: compressionCacheHitKeys.length > 0 ? compressionCacheHitKeys : undefined,
  }
}

/**
 * 多书预算配额分配（P1）：部分书带 tokenBudget、部分不带时，未带书无信号按
 * 带书配额的平均值对待。总配额不超全局预算时足额分配（行为不变）；
 * 超出时按配额比例分配，最后一份吃剩余误差（总和不超全局预算）。
 * 全部书都不带预算时返回 null（调用方跳过配额步骤）。
 */
export function allocateGlobalBudgetByBooks(
  globalBudget: number,
  bookBudgets: Map<string, number>,
): Map<string, number> | null {
  if (bookBudgets.size === 0) return null
  const ownedBudgets: number[] = []
  for (const budget of bookBudgets.values()) {
    if (budget > 0) ownedBudgets.push(budget)
  }
  // 无预算书按带预算书的平均值对待
  const average = ownedBudgets.length > 0
    ? ownedBudgets.reduce((sum, v) => sum + v, 0) / ownedBudgets.length
    : 0
  const quotas = new Map<string, number>()
  let totalQuota = 0
  for (const [lbId, budget] of bookBudgets) {
    const quota = budget > 0 ? budget : average
    quotas.set(lbId, quota)
    totalQuota += quota
  }
  // 配额充裕（含全部预算为 0）：足额分配
  if (totalQuota <= globalBudget) return quotas
  // 超出：按比例分配，最后一份吃剩余
  const allocated = new Map<string, number>()
  let remaining = globalBudget
  const entries = [...quotas.entries()]
  for (let i = 0; i < entries.length; i++) {
    const [lbId, quota] = entries[i]
    const share = i === entries.length - 1
      ? remaining
      : Math.max(0, Math.floor(globalBudget * (quota / totalQuota)))
    allocated.set(lbId, share)
    remaining = Math.max(0, remaining - share)
  }
  return allocated
}

/**
 * 书级 tokenBudget 裁剪（Risu character_book / 外部格式导入语义）：
 * 每本书注入的 token 总量不超过该书 cap（优先保高分条目，
 * 超限条目先尝试手写 summary 替代，与全局裁剪策略一致）。
 * - cap 未定义的书不受额外限制（仍受全局预算约束）
 * - ignoreBudget 条目不占书级预算（与全局预算行为一致）
 * - 保留原始条目顺序（仅替换/移除，不重排）
 */
function enforceBookBudgets(
  items: ScoredLoreItem[],
  bookCaps: Map<string, number>,
  lbIdByKey: Map<string, string>,
  model: string,
): { items: ScoredLoreItem[]; dropped: number; droppedItems: ScoredLoreItem[] } {
  const perBook = new Map<string, ScoredLoreItem[]>()
  for (const item of items) {
    const lbId = item.key ? lbIdByKey.get(item.key) : undefined
    if (lbId === undefined || item.ignoreBudget || !bookCaps.has(lbId)) continue
    const list = perBook.get(lbId)
    if (list) list.push(item)
    else perBook.set(lbId, [item])
  }
  if (perBook.size === 0) return { items, dropped: 0, droppedItems: [] }

  const replacements = new Map<ScoredLoreItem, ScoredLoreItem>()
  const droppedSet = new Set<ScoredLoreItem>()
  for (const [lbId, list] of perBook) {
    const cap = bookCaps.get(lbId)!
    let used = 0
    for (const item of [...list].sort((a, b) => b.score - a.score || a.order - b.order)) {
      const fullTokens = estimateTokens(item.content, model)
      if (used + fullTokens <= cap) {
        used += fullTokens
        continue
      }
      const summary = typeof item.summary === 'string' ? item.summary.trim() : ''
      if (summary) {
        const summaryTokens = estimateTokens(summary, model)
        if (used + summaryTokens <= cap) {
          used += summaryTokens
          replacements.set(item, { ...item, content: summary })
          continue
        }
      }
      droppedSet.add(item)
    }
  }
  return {
    items: items
      .filter((item) => !droppedSet.has(item))
      .map((item) => replacements.get(item) ?? item),
    dropped: droppedSet.size,
    droppedItems: [...droppedSet],
  }
}

/** FNV-1a 32 位字符串哈希（压缩缓存 key 用，无需密码学强度） */
function hashString(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}

/** 压缩缓存 key：条目 key + content hash 排序拼接（条目编辑后 key 变化，缓存天然失效） */
export function buildCompressionKey(items: { key?: string; content: string }[]): string {
  return items
    .map((i) => `${i.key ?? ''}:${hashString(i.content)}`)
    .sort()
    .join(';')
}

/** 压缩缓存上限（按最近使用时间 LRU 淘汰） */
const COMPRESSION_CACHE_MAX_ENTRIES = 10

/** 压缩目标下限：剩余预算过小时压缩无意义，跳过请求 */
const MIN_COMPRESS_TARGET_TOKENS = 32

/** 写入压缩缓存（按 lastUsedAt/createdAt 淘汰最久未使用条目，保持上限） */
export function upsertCompressionCache(
  cache: Record<string, LorebookCompressionCacheEntry> | undefined,
  key: string,
  entry: LorebookCompressionCacheEntry,
  maxEntries: number = COMPRESSION_CACHE_MAX_ENTRIES,
): Record<string, LorebookCompressionCacheEntry> {
  const next: Record<string, LorebookCompressionCacheEntry> = { ...(cache ?? {}) }
  next[key] = entry
  const keys = Object.keys(next)
  if (keys.length > maxEntries) {
    const oldest = keys.sort((a, b) =>
      (next[a].lastUsedAt ?? next[a].createdAt) - (next[b].lastUsedAt ?? next[b].createdAt))
    for (const k of oldest.slice(0, keys.length - maxEntries)) delete next[k]
  }
  return next
}

/** 刷新已命中压缩缓存的 LRU 时间，不改变摘要内容。 */
export function touchCompressionCache(
  cache: Record<string, LorebookCompressionCacheEntry> | undefined,
  keys: string[],
  usedAt: number = Date.now(),
): Record<string, LorebookCompressionCacheEntry> | undefined {
  if (!cache || keys.length === 0) return cache
  const hitKeys = new Set(keys)
  let changed = false
  const next: Record<string, LorebookCompressionCacheEntry> = {}
  for (const [key, entry] of Object.entries(cache)) {
    if (hitKeys.has(key)) {
      next[key] = { ...entry, lastUsedAt: usedAt }
      changed = true
    } else {
      next[key] = entry
    }
  }
  return changed ? next : cache
}

// ===================== 无索引语义近似补偿（P1） =====================

/**
 * 判断是否对条目使用词面重叠近似：仅当该内容本轮没有真实语义命中
 * （有真实相似度时近似值无意义，直接用真实值）。
 */
export function shouldUseOverlapApprox(
  item: { content: string; score?: number },
  semanticScoreByContent: Map<string, number>,
): boolean {
  if (typeof item.score === 'number' && Number.isFinite(item.score)) return false
  const contentScore = semanticScoreByContent.get(item.content)
  return contentScore === undefined || !Number.isFinite(contentScore)
}

/**
 * 词面重叠语义近似（P1）：无语义索引时填补 semantic 评分维度。
 * 大粒度 token（CJK 双字滑窗 + ASCII 词），n>1 滑窗降低中文字面碰撞；
 * Dice 系数（2|A∩B| / (|A|+|B|)）对长度差异鲁棒，天然 0-1。
 * keywords 与 content 各出一组 token 后 Dice 合并（关键词命中是
 * 侧重的相关度信号），R 增强语义成分（0.35/1.0=0.35）。
 */
export function semanticScoreByOverlap(
  entry: { keywords: string[]; content: string },
  dialogueTextLower: string,
  R = 0.35,
): number {
  const dialogueTokens = overlapTokens(dialogueTextLower)
  if (dialogueTokens.length === 0) return 0

  const contentScore = diceCoefficient(overlapTokens(entry.content.toLowerCase()), dialogueTokens)
  const keywordScore = diceCoefficient(overlapTokens(
    entry.keywords.filter((k) => typeof k === 'string' && k.trim()).join(' ').toLowerCase(),
  ), dialogueTokens)

  return Math.min(1, R * (0.5 * contentScore + 0.5 * keywordScore))
}

/** 大粒度 token：ASCII 按词（≥2 字符），CJK 双字滑窗；过滤空白与单符号 */
function overlapTokens(text: string): string[] {
  const tokens: string[] = []
  const asciiMatches = text.match(/[a-zA-Z0-9]{2,}/g) ?? []
  tokens.push(...asciiMatches)
  for (let i = 0; i < text.length - 1; i++) {
    const c1 = text[i]
    const c2 = text[i + 1]
    if (isCjk(c1) && isCjk(c2)) tokens.push(c1 + c2)
  }
  return tokens
}

function isCjk(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0
  return (code >= 0x4E00 && code <= 0x9FFF)
    || (code >= 0x3400 && code <= 0x4DBF)
    || (code >= 0xF900 && code <= 0xFAFF)
}

/** Dice 系数（2|A∩B| / (|A|+|B|)）：任一集合为空返回 0，对长度差异鲁棒 */
function diceCoefficient(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0
  const counts = new Map<string, number>()
  for (const t of a) counts.set(t, (counts.get(t) ?? 0) + 1)
  let intersection = 0
  for (const t of b) {
    const remaining = counts.get(t) ?? 0
    if (remaining > 0) {
      intersection++
      counts.set(t, remaining - 1)
    }
  }
  return (2 * intersection) / (a.length + b.length)
}

// ===================== 实体提取与统一评分（阶段二B） =====================

/**
 * 从受控词表收集「最近对话中被提及的」实体（人名/地名/物品名）。
 * 受控词表 = charName + entityVocabulary（角色 tags / 群成员名等）+ 激活条目全部 keywords，
 * 再用词边界匹配过滤出确实出现在最近扫描文本中的词——零误报且保留「最近被提及」语义。
 * 纯函数、轻量正则，不依赖 NLP 库。
 */
export function extractEntities(opts: {
  /** 最近扫描文本（已小写，与关键词匹配共用） */
  scanTextLower: string
  charName: string
  /** 受控词表补充（角色 tags、群聊成员名等） */
  entityVocabulary?: string[]
  lorebooks: Lorebook[]
}): Set<string> {
  const vocab = new Set<string>()
  const add = (w: unknown) => {
    if (typeof w !== 'string') return
    const t = w.trim().toLowerCase()
    if (t) vocab.add(t)
  }
  add(opts.charName)
  for (const w of opts.entityVocabulary ?? []) add(w)
  for (const lb of opts.lorebooks) {
    if (!lb?.enabled) continue
    for (const entry of lb.entries) {
      if (!entry.enabled) continue
      for (const k of entry.keywords ?? []) add(k)
    }
  }

  const entities = new Set<string>()
  for (const word of vocab) {
    if (keywordMatch(word, opts.scanTextLower)) entities.add(word)
  }
  return entities
}

/**
 * 实体命中检查：条目 keywords 直接命中最近实体，或条目内容包含实体名
 * （实体统一小写；内容比较大小写不敏感；长度 < 2 的实体跳过 includes，降低双字误报）。
 */
export function checkEntityBoost(
  entry: { keywords: string[]; content: string },
  recentEntities: Set<string>,
): boolean {
  for (const kw of entry.keywords) {
    if (typeof kw === 'string' && recentEntities.has(kw.trim().toLowerCase())) return true
  }
  if (recentEntities.size === 0) return false
  const contentLower = entry.content.toLowerCase()
  for (const entity of recentEntities) {
    if (entity.length >= 2 && contentLower.includes(entity)) return true
  }
  return false
}

/**
 * 统一评分：score = w_keyword×keywordHits + w_semantic×semanticScore
 *                  + w_entity×entityBoost + w_recency×recencyBoost。
 * - keywordHits（P0 频率计分）：coverage 与 frequency 各占一半：
 *   coverage = 命中关键词数 / 关键词总数（条目内归一化，避免多关键词条目天然占优）；
 *   frequency = 1 - e^(-totalOccurrences)，totalOccurrences 为各关键词命中次数之和
 *   （每词上限 3，防单关键词刷屏主导），区分「提到一次」与「反复讨论」。
 * - semanticScore：语义候选自带；关键词触发条目若同时被语义命中，按内容反查补回；
 *   无真实语义命中时（语义关闭/未配置/未命中）用词面重叠近似补偿（P1），
 *   权重 R = W.semantic / W.semantic满配 = 0.35/1.0，保证与真实语义命中可比
 * - 关键词通过条目 key 反查，评分沿用条目级大小写/整词/正则语义
 */
function scoreItems(
  items: BudgetLoreItem[],
  ctx: {
    scanText: string
    scanTextLower: string
    /** 对话扫描文本（不含递归条目内容）：关键词频率计数基于对话相关度，避免条目自含关键词的递归自我强化 */
    dialogueText: string
    dialogueTextLower: string
    entriesByKey: Map<string, LoreEntry>
    semanticScoreByContent: Map<string, number>
    recentEntities: Set<string>
    recentTriggered: Set<string>
  },
): ScoredLoreItem[] {
  const W = LOREBOOK_SCORE_WEIGHTS
  const regexCache = new Map<string, RegExp>()
  return items.map((item) => {
    const entry = item.key ? ctx.entriesByKey.get(item.key) : undefined
    const keywords = entry?.keywords ?? []
    const validKeywords = keywords.filter((k) => typeof k === 'string' && k.trim())
    const hitCounts = entry
      ? validKeywords.map((keyword) => loreEntryKeywordCount(
        entry, keyword, ctx.dialogueText, ctx.dialogueTextLower, regexCache,
      ))
      : []
    const hitKeywords = hitCounts.filter((c) => c > 0).length
    const totalOccurrences = hitCounts.reduce((sum, c) => sum + Math.min(c, 3), 0)
    const coverage = validKeywords.length > 0 ? hitKeywords / validKeywords.length : 0
    const frequency = 1 - Math.exp(-totalOccurrences)
    const keywordHits = 0.5 * coverage + 0.5 * frequency

    const rawSemantic = item.score ?? ctx.semanticScoreByContent.get(item.content)
    // P1 词面重叠补偿：无真实语义命中时填补 semantic 维度（约 0-0.35 的小分）
    const approxSemantic = entry && shouldUseOverlapApprox(item, ctx.semanticScoreByContent)
      ? semanticScoreByOverlap({ keywords: validKeywords, content: item.content }, ctx.dialogueTextLower)
      : 0
    const semanticScore = Math.min(1, Math.max(0, Number.isFinite(rawSemantic) ? rawSemantic! : approxSemantic))
    const entityHit = checkEntityBoost({ keywords: validKeywords, content: item.content }, ctx.recentEntities)
    const recencyHit = !!item.key && ctx.recentTriggered.has(item.key)

    return {
      ...item,
      keywordHits,
      semanticScore,
      semanticSource: Number.isFinite(rawSemantic) ? 'real' : semanticScore > 0 ? 'approx' : 'none',
      entityHit,
      recencyHit,
      score: W.keyword * keywordHits
        + W.semantic * (Number.isFinite(item.fusionScore) ? item.fusionScore! : semanticScore)
        + (entityHit ? W.entity : 0)
        + (recencyHit ? W.recency : 0),
    }
  })
}

/** 将本轮触发的条目 key 追加到会话 recency 环形缓冲（最多保留 windowSize 轮） */
export function appendRecentTriggeredIds(
  prev: string[][] | undefined,
  ids: string[],
  windowSize: number = LOREBOOK_RECENCY_WINDOW,
): string[][] {
  if (!ids.length && !(prev?.length)) return []
  return [...(prev ?? []), ids].slice(-windowSize)
}

/**
 * 将已裁剪的世界书条目按插入位置分发（executeLorebookRuntime 内部使用）。
 */
function distributeLoreItems(items: BudgetLoreItem[]): LorebookTriggerResult {
  const renderItems: LorebookRenderItem[] = items.map((item) => ({
    content: item.content,
    order: item.order,
    insertion: loreItemInsertion(item),
    key: item.key,
    adapterId: item.adapterId,
    retrievalMode: item.retrievalMode,
  }))
  const result: LorebookTriggerResult = {
    beforeChar: [],
    afterChar: [],
    atEnd: [],
    atDepth: [],
    renderPlan: renderLorebookItems(renderItems),
    triggeredCount: items.length,
    droppedCount: 0,
  }
  for (const item of items) {
    switch (item.position) {
      case 'before_char':
        result.beforeChar.push(item.content)
        break
      case 'after_char':
        result.afterChar.push(item.content)
        break
      case 'at_depth':
        result.atDepth.push({ content: item.content, order: item.order, depth: item.depth ?? 0, role: item.role })
        break
      default:
        result.atEnd.push(item.content)
    }
  }
  return result
}

// ===================== 统一触发入口 =====================

/** 语义死条目告警上限（warn-once 集合大小；超限淘汰最早项，防内存无限增长） */
const SEMANTIC_DEAD_WARN_MAX = 500
const semanticDeadWarnedKeys = new Set<string>()

/** 词法候选触发阈值：BM25 归一化分数达到该值才允许词法通道单独触发条目（防止长文本弱重叠误触发）。 */
const LEXICAL_TRIGGER_THRESHOLD = 0.15
/** 运行时 RRF 的 k：小候选集下取小 k，让通道内排名差异参与融合排序（归一化基准见 reciprocalRankFusion）。 */
const LEXICAL_RRF_K = 1

/**
 * 语义死条目告警：语义触发不可用（未启用/未配置）时，
 * 仅向量条目（semanticRequired）永远无法触发——按条目 warn-once 提示
 * （sticky / always 条目不受影响）。semanticPreferred / hybrid 条目由本地词法兜底，不再告警。
 */
function warnSemanticDeadEntries(
  triggerableEntries: Array<{ entry: LoreEntry; lbId: string }>,
  semanticEnabled: boolean | undefined,
  stickyKeys: Set<string>,
): void {
  if (semanticEnabled !== false) return
  for (const { entry, lbId } of triggerableEntries) {
    if (!isSemanticDeadEntry(entry)) continue
    const key = `${lbId}:${entry.id}`
    if (stickyKeys.has(key) || semanticDeadWarnedKeys.has(key)) continue
    if (semanticDeadWarnedKeys.size >= SEMANTIC_DEAD_WARN_MAX) {
      const oldest = semanticDeadWarnedKeys.keys().next().value
      if (oldest !== undefined) semanticDeadWarnedKeys.delete(oldest)
    }
    semanticDeadWarnedKeys.add(key)
    const preview = entry.content.slice(0, 24).replace(/\s+/g, ' ')
    logWarn('lorebook', `条目「${preview}…」要求向量语义触发（retrieval=semanticRequired），但 embeddings 未启用或未配置，该条目已停用。可启用 embeddings，或改用 semanticPreferred / hybrid 以启用本地词法兜底`)
  }
}

/** 条目稳定键（lbId + entry.id，兼容无 id 的旧数据回退 keywords 拼接） */
function entryKey(lbId: string, entry: LoreEntry): string {
  const fallback = Array.isArray(entry.keywords) ? entry.keywords.join(',') : ''
  return `${lbId}:${entry.id || fallback}`
}

/** 条目文本统一变换（变量替换 + 宏展开），content 与 summary 共用 */
function transformEntryText(text: string, userName: string, charName: string): string {
  return expandMacros(replaceVariables(text, userName, charName), { userName, charName })
}

/**
 * 语义死条目：只有显式 semanticRequired（仅向量）的条目才允许在无 embeddings 时停用。
 * 阶段四起 legacy semantic（→ semanticPreferred）与无关键词的 hybrid 条目
 * 均由本地词法检索兜底，不再视为死条目（调试面板显示 fallbackReason）。
 */
function isSemanticDeadEntry(entry: LoreEntry): boolean {
  if (entry.priority === 'always') return false
  if (entry.runtime?.retrieval) return entry.runtime.retrieval === 'semanticRequired'
  return false
}

/** 词法通道是否可参与该条目触发：hybrid 恒可；semanticPreferred 在无向量命中时兜底；keyword / semanticRequired 不参与。 */
function isLexicalEligibleMode(mode: LorebookRetrievalMode, hasVectorHit: boolean): boolean {
  if (mode === 'hybrid') return true
  if (mode === 'semanticPreferred') return !hasVectorHit
  return false
}

/** 条目拥有显式关键词通道（可参与关键词/正则触发）：keyword 与 hybrid。 */
function hasKeywordChannel(mode: LorebookRetrievalMode): boolean {
  return mode === 'keyword' || mode === 'hybrid'
}

/** 各通道全部未命中时的可解释原因（按条目检索策略区分）。 */
function loreEntryMissReason(
  entry: LoreEntry,
  mode: LorebookRetrievalMode,
  keywordChannelPresent: boolean,
  embeddingsAvailable: boolean,
): LoreTriggerReason {
  if (isSemanticDeadEntry(entry)) return embeddingsAvailable ? 'semantic_miss' : 'semantic_unavailable'
  if (mode === 'keyword') return 'primary_miss'
  if (mode === 'hybrid') return keywordChannelPresent ? 'primary_miss' : 'retrieval_miss'
  // semanticPreferred：无 embeddings 时由词法兜底，仍未召回记为词法未命中
  return embeddingsAvailable ? 'semantic_miss' : 'retrieval_miss'
}

function createSeededRandom(seedText: string): () => number {
  let seed = Number.parseInt(hashString(seedText), 36) || 1
  return () => {
    seed = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    seed ^= seed + Math.imul(seed ^ (seed >>> 7), 61 | seed)
    return ((seed ^ (seed >>> 14)) >>> 0) / 4294967296
  }
}

function loreEntryTimedHash(entry: LoreEntry): string {
  const serialized = JSON.stringify(entry)
  let hash = 2166136261
  for (let index = 0; index < serialized.length; index++) {
    hash ^= serialized.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

function prepareLorebookTimedEffects(
  input: LorebookTimedEffectsState | undefined,
  messageCount: number | undefined,
  entriesByKey: Map<string, LoreEntry>,
): {
  state?: LorebookTimedEffectsState
  stickyKeys: Set<string>
  cooldownKeys: Set<string>
} {
  const stickyKeys = new Set<string>()
  const cooldownKeys = new Set<string>()
  if (messageCount === undefined) return { state: undefined, stickyKeys, cooldownKeys }

  const state: LorebookTimedEffectsState = {
    sticky: { ...(input?.sticky ?? {}) },
    cooldown: { ...(input?.cooldown ?? {}) },
  }

  for (const [key, effect] of Object.entries(state.sticky)) {
    const entry = entriesByKey.get(key)
    if (!entry?.sticky || effect.hash !== loreEntryTimedHash(entry) || (messageCount <= effect.start && !effect.protected)) {
      delete state.sticky[key]
      continue
    }
    if (messageCount >= effect.end) {
      delete state.sticky[key]
      if (entry.cooldown) {
        state.cooldown[key] = {
          hash: loreEntryTimedHash(entry),
          start: messageCount,
          end: messageCount + entry.cooldown,
          protected: true,
        }
      }
      continue
    }
    stickyKeys.add(key)
  }

  for (const [key, effect] of Object.entries(state.cooldown)) {
    const entry = entriesByKey.get(key)
    if (!entry?.cooldown || effect.hash !== loreEntryTimedHash(entry) || (messageCount <= effect.start && !effect.protected)) {
      delete state.cooldown[key]
      continue
    }
    if (messageCount >= effect.end) {
      delete state.cooldown[key]
      continue
    }
    cooldownKeys.add(key)
  }

  return { state, stickyKeys, cooldownKeys }
}

function setLorebookTimedEffects(
  state: LorebookTimedEffectsState | undefined,
  entry: LoreEntry,
  key: string,
  messageCount: number | undefined,
): void {
  if (!state || messageCount === undefined) return
  const hash = loreEntryTimedHash(entry)
  if (entry.sticky && !state.sticky[key]) {
    state.sticky[key] = { hash, start: messageCount, end: messageCount + entry.sticky }
  }
  if (entry.cooldown && !state.cooldown[key]) {
    state.cooldown[key] = { hash, start: messageCount, end: messageCount + entry.cooldown }
  }
}

/**
 * 世界书统一触发 + 统一评分 + 预算裁剪（单聊 / 群聊共用）：
 * 1. always 条目无条件收集（跳过关键词/正则/语义阈值检查，matchMode 不生效；
 *    probability 骰子照常生效），内容拼入扫描文本参与递归触发
 * 2. 关键词（词边界感知）与正则匹配 + 递归扫描（条目内容可触发其他条目）
 * 3. 语义候选合并：与关键词/always 已保留内容重复的跳过（不计入 droppedCount）
 * 4. 统一评分（关键词命中 + 语义相似度 + 实体命中 + 近因加权，阶段二B）
 * 5. 书级 tokenBudget 裁剪（书自带预算时，该书条目注入总量不超上限）
 * 6. 分桶瀑布裁剪（fitLorebookBudgetByPriority：conditional/detail 段按 score 降序）
 * 7. 按插入位置分发（before/after/at_end/at_depth）
 */
export function executeLorebookRuntime(opts: LorebookTriggerOptions): LorebookTriggerResult {
  const {
    lorebooks,
    scanText,
    scanMessages,
    userName,
    charName,
    characterNames,
    characterTags,
    generationType = 'normal',
    messageCount,
    timedEffects,
    budget,
    model,
    maxRecursiveDepth = 5,
    semanticItems = [],
    entityVocabulary,
    recentTriggeredIds,
    compressionCache,
    semanticEnabled,
    diagnosticsMode,
  } = opts

  const triggeredIds = new Set<string>()
  const failedProbabilityChecks = new Set<string>()
  const triggeredItems: BudgetLoreItem[] = []
  let recursionText = ''

  // 扫描文本去噪（P0）：剥离 markdown 语法/代码块后参与关键词/正则匹配与评分。
  // 仅去噪用户对话（scanText/scanMessages）；递归文本是条目原文，不去噪。
  const cleanScanText = stripScanText(scanText)
  const cleanScanMessages = scanMessages?.map(stripScanText)
  const diagnosticsEnabled = diagnosticsMode !== undefined

  // 阶段四：本地词法检索通道（无 embeddings 也可用）。
  // 候选仅在深度 0 作为触发通道使用；稍后按条目有效 scanDepth 分组检索。
  const semanticAvailable = semanticEnabled === true
  const lexicalProvider = opts.lexicalProvider ?? defaultLexicalRetrievalProvider
  let lexicalHits: LexicalRetrievalHit[] = []
  const lexicalHitByKey = new Map<string, LexicalRetrievalHit>()
  // 向量通道 rank：semanticItems 即向量检索的降序结果，次序就是通道排名。
  const semanticRankByKey = new Map<string, number>()
  semanticItems.forEach((item, index) => {
    if (item.key && !semanticRankByKey.has(item.key)) semanticRankByKey.set(item.key, index + 1)
  })
  // 关键词通道信号：任意递归层的命中数（取最大值），供 RRF 关键词通道排名。
  const keywordSignalByKey = new Map<string, { activationScore: number; order: number }>()
  const detailByKey = new Map<string, LoreTriggerDetail>()
  const random = diagnosticsMode === 'preview'
    ? createSeededRandom(`${generationType}:${messageCount ?? 0}:${cleanScanText}`)
    : Math.random

  // 正则缓存 + 可触发条目；always / keyword / semantic 在同一递归层参与包含组仲裁。
  const regexCache = new Map<string, RegExp>()
  const triggerableEntries: Array<{
    entry: LoreEntry
    lbId: string
    bookName: string
    bookScanDepth: number | undefined
    recursiveScanning: boolean
  }> = []
  const entriesByKey = new Map<string, LoreEntry>()
  const lbIdByKey = new Map<string, string>()
  const bookBudgets = new Map<string, number>()
  const semanticByKey = new Map(semanticItems.flatMap((item) => item.key ? [[item.key, item] as const] : []))
  const contextNames = normalizedSet(characterNames?.length ? characterNames : [charName])
  const contextTags = normalizedSet(characterTags)

  for (const lb of lorebooks) {
    if (!lb?.enabled) continue
    const bookScanDepth = typeof lb.scanDepth === 'number' && Number.isFinite(lb.scanDepth)
      ? Math.max(0, Math.floor(lb.scanDepth))
      : undefined
    for (const entry of lb.entries) {
      if (!entry.enabled) continue
      const key = entryKey(lb.id, entry)
      entriesByKey.set(key, entry)
      lbIdByKey.set(key, lb.id)
      triggerableEntries.push({
        entry,
        lbId: lb.id,
        bookName: lb.name,
        bookScanDepth,
        recursiveScanning: lb.recursiveScanning !== false,
      })
      if (diagnosticsEnabled) {
        const detailRetrievalMode = loreEntryRetrievalMode(entry)
        const detailKeywordChannel = hasKeywordChannel(detailRetrievalMode)
          && Array.isArray(entry.keywords)
          && entry.keywords.some((k) => typeof k === 'string' && k.trim())
        detailByKey.set(key, {
          key,
          bookId: lb.id,
          bookName: lb.name,
          entryId: entry.id,
          name: entry.content.slice(0, 24).replace(/\s+/g, ' ').trim() || entry.keywords[0] || '空条目',
          outcome: 'not_triggered',
          stage: 'matching',
          reason: loreEntryMissReason(entry, detailRetrievalMode, detailKeywordChannel, semanticAvailable),
          semanticSource: 'none',
          position: entry.position,
          depth: entry.position === 'at_depth' ? (entry.depth ?? 0) : undefined,
          role: entry.position === 'at_depth' ? entry.role : undefined,
          insertion: loreEntryInsertion(entry),
          adapterId: entry.runtime?.adapterId ?? lb.runtime?.adapterId,
          retrievalMode: loreEntryRetrievalMode(entry),
          priority: entry.priority ?? 'conditional',
          probability: Math.min(100, Math.max(0, Number.isFinite(entry.probability) ? entry.probability : 100)),
          effectiveScanDepth: loreEntryEffectiveScanDepth(entry, cleanScanMessages, bookScanDepth),
          ignoreBudget: entry.ignoreBudget,
        })
      }
    }
    // 书级 tokenBudget（导入的外部格式自带）：该书条目注入总量不超过此值
    if (typeof lb.tokenBudget === 'number' && Number.isFinite(lb.tokenBudget) && lb.tokenBudget >= 0) {
      bookBudgets.set(lb.id, Math.floor(lb.tokenBudget))
    }
  }

  // 同一有效扫描文本只查询一次，再把候选限制到使用该窗口的条目。
  // 这既保留共享倒排索引，也避免 scanDepth=0/较小的条目读取窗口外消息。
  if (lexicalProvider.available().available) {
    const keysByQuery = new Map<string, Set<string>>()
    for (const { entry, lbId, bookScanDepth } of triggerableEntries) {
      const mode = loreEntryRetrievalMode(entry)
      if (mode !== 'semanticPreferred' && mode !== 'hybrid') continue
      const query = loreEntryScanText(entry, cleanScanText, cleanScanMessages, bookScanDepth).trim()
      if (!query) continue
      const keys = keysByQuery.get(query) ?? new Set<string>()
      keys.add(entryKey(lbId, entry))
      keysByQuery.set(query, keys)
    }
    for (const [query, allowedKeys] of keysByQuery) {
      const hits = lexicalProvider.search({
        query,
        lorebooks,
        threshold: LEXICAL_TRIGGER_THRESHOLD,
        topK: Math.max(24, allowedKeys.size),
      })
      for (const hit of hits) {
        if (!allowedKeys.has(hit.key)) continue
        lexicalHitByKey.set(hit.key, hit)
      }
    }
    lexicalHits = [...lexicalHitByKey.values()].sort((a, b) => b.score - a.score || a.key.localeCompare(b.key))
  }

  const timed = prepareLorebookTimedEffects(timedEffects, messageCount, entriesByKey)

  // 语义不可用时，仅依赖语义通道的条目永远无法触发——warn-once 提示
  if (diagnosticsMode !== 'preview') {
    warnSemanticDeadEntries(triggerableEntries, semanticEnabled, timed.stickyKeys)
  }

  const activatedGroups = new Set<string>()
  for (let depth = 0; depth < maxRecursiveDepth; depth++) {
    const candidates: LoreActivationCandidate[] = []
    for (const { entry, lbId, bookScanDepth, recursiveScanning } of triggerableEntries) {
      const entryId = entryKey(lbId, entry)
      if (triggeredIds.has(entryId) || failedProbabilityChecks.has(entryId)) continue
      const detail = detailByKey.get(entryId)
      const contextBlockReason = loreEntryContextBlockReason(entry, generationType, contextNames, contextTags)
      if (contextBlockReason) {
        if (detail) Object.assign(detail, { stage: 'eligibility', reason: contextBlockReason })
        continue
      }
      const isSticky = timed.stickyKeys.has(entryId)
      if (messageCount !== undefined && entry.delay && messageCount < entry.delay) {
        if (detail) Object.assign(detail, { stage: 'eligibility', reason: 'delay' as const })
        continue
      }
      if (timed.cooldownKeys.has(entryId) && !isSticky) {
        if (detail) Object.assign(detail, { stage: 'eligibility', reason: 'cooldown' as const })
        continue
      }
      if (depth > 0 && entry.excludeRecursion === true && !isSticky) {
        if (detail && detail.reason === 'primary_miss') Object.assign(detail, { stage: 'eligibility', reason: 'exclude_recursion' as const })
        continue
      }
      const recursionDelay = entry.delayUntilRecursion === true
        ? 1
        : (typeof entry.delayUntilRecursion === 'number' ? entry.delayUntilRecursion : 0)
      if (depth < recursionDelay && !isSticky) {
        if (detail) Object.assign(detail, { stage: 'eligibility', reason: 'recursion_delay' as const })
        continue
      }

      const baseText = loreEntryScanText(entry, cleanScanText, cleanScanMessages, bookScanDepth)
      const scanTextAtDepth = recursionText ? `${baseText} ${recursionText}`.trim() : baseText
      const scanTextAtDepthLower = scanTextAtDepth.toLowerCase()
      const retrievalMode = loreEntryRetrievalMode(entry)
      const entryKeywords = Array.isArray(entry.keywords) ? entry.keywords : []
      const semanticItem = depth === 0 && retrievalMode !== 'keyword' ? semanticByKey.get(entryId) : undefined
      // 词法通道只在深度 0 参与触发（递归层沿用关键词/正则扫描，防止条目内容自我反馈）
      const lexicalHit = depth === 0 && isLexicalEligibleMode(retrievalMode, !!semanticItem)
        ? lexicalHitByKey.get(entryId)
        : undefined
      const keywordChannelPresent = hasKeywordChannel(retrievalMode)
        && entryKeywords.some((keyword) => typeof keyword === 'string' && keyword.trim())

      // 关键词通道始终评估（即使向量/词法先行命中）：供匹配关键词诊断、组评分与 RRF 关键词通道使用
      let primaryMatches: string[] = []
      if (keywordChannelPresent) {
        primaryMatches = entryKeywords.filter((keyword) => !!keyword && loreEntryKeywordMatch(
          entry, keyword, scanTextAtDepth, scanTextAtDepthLower, regexCache,
        ))
      }
      const keywordMatched = primaryMatches.length > 0
      let activationScore = primaryMatches.length
      const matched = isSticky || entry.priority === 'always' || !!semanticItem || !!lexicalHit || keywordMatched

      if (!matched) {
        if (detail) {
          detail.scanText = scanTextAtDepth
          detail.recursionDepth = depth
          detail.reason = loreEntryMissReason(entry, retrievalMode, keywordChannelPresent, semanticAvailable)
        }
        continue
      }
      // ST constant / active sticky are immediate activations，关键词与二级关键词均不参与过滤。
      if (!isSticky && entry.priority !== 'always'
        && !loreEntrySecondaryMatch(entry, scanTextAtDepth, scanTextAtDepthLower, regexCache)) {
        if (detail) Object.assign(detail, {
          stage: 'matching' as const,
          reason: 'secondary_miss' as const,
          scanText: scanTextAtDepth,
          recursionDepth: depth,
        })
        continue
      }
      const matchedKeywords: LoreMatchedKeyword[] = [
        ...primaryMatches.map((keyword) => ({
          keyword,
          count: loreEntryKeywordCount(entry, keyword, scanTextAtDepth, scanTextAtDepthLower, regexCache),
          channel: 'primary' as const,
        })),
        ...(entry.secondaryKeywords ?? [])
          .map((keyword) => ({
            keyword,
            count: loreEntryKeywordCount(entry, keyword, scanTextAtDepth, scanTextAtDepthLower, regexCache),
            channel: 'secondary' as const,
          }))
          .filter((item) => item.count > 0),
      ]
      // 激活来源记录“决定通道”：sticky/always/递归优先，其次关键词、向量、词法；
      // 关键词未命中且向量与词法同时命中时记为 hybrid（多通道融合确认）。
      const activationSource: NonNullable<LoreTriggerDetail['activationSource']> = isSticky
        ? 'sticky'
        : entry.priority === 'always'
          ? 'always'
          : depth > 0
            ? 'recursive'
            : keywordMatched
              ? 'keyword'
              : semanticItem && lexicalHit
                ? 'hybrid'
                : semanticItem
                  ? 'vector'
                  : 'lexical'
      // 词法兜底语义：仅当词法是决定通道时标注——无 embeddings 为 lexical_fallback，
      // embeddings 可用但向量未召回该条目为 vector_miss_lexical_fallback。
      const lexicalFallbackReason: BudgetLoreItem['fallbackReason'] = activationSource === 'lexical'
        ? semanticAvailable ? 'vector_miss_lexical_fallback' : 'lexical_fallback'
        : undefined
      if (detail) Object.assign(detail, {
        stage: 'matching' as const,
        reason: undefined,
        activationSource,
        fallbackReason: lexicalFallbackReason,
        lexicalRank: lexicalHit?.rank,
        lexicalScore: lexicalHit?.score,
        vectorRank: semanticItem ? semanticRankByKey.get(entryId) : undefined,
        vectorScore: semanticItem?.score,
        matchedKeywords,
        scanText: scanTextAtDepth,
        recursionDepth: depth,
      })
      if (entry.useGroupScoring && (entry.selectiveLogic === 'and_any' || entry.selectiveLogic === 'and_all')) {
        activationScore += (entry.secondaryKeywords ?? []).filter((keyword) => loreEntryKeywordMatch(
          entry, keyword, scanTextAtDepth, scanTextAtDepthLower, regexCache,
        )).length
      }
      if (keywordMatched) {
        const prevSignal = keywordSignalByKey.get(entryId)
        if (!prevSignal || activationScore > prevSignal.activationScore) {
          keywordSignalByKey.set(entryId, { activationScore, order: entry.order })
        }
      }
      candidates.push({
        entry,
        lbId,
        key: entryId,
        recursiveScanning,
        activationScore,
        semanticScore: semanticItem?.score,
        sticky: isSticky,
        hasVectorHit: !!semanticItem,
        lexicalHit,
        activationSource,
        lexicalFallbackReason,
      })
    }

    const selected = resolveInclusionGroups(candidates, activatedGroups, random, (candidate) => {
      const detail = detailByKey.get(candidate.key)
      if (detail) Object.assign(detail, {
        stage: 'group_arbitration' as const,
        reason: 'inclusion_group_lost' as const,
      })
    })
    let appendedRecursion = false
    for (const candidate of selected) {
      const { entry, key: entryId, recursiveScanning } = candidate

      const p = Math.min(100, Math.max(0, Number.isFinite(entry.probability) ? entry.probability : 100))
      const probabilityRoll = !candidate.sticky && p < 100 ? random() * 100 : undefined
      const detail = detailByKey.get(entryId)
      if (detail && probabilityRoll !== undefined) detail.probabilityRoll = probabilityRoll
      if (probabilityRoll !== undefined && probabilityRoll >= p) {
        failedProbabilityChecks.add(entryId)
        if (detail) Object.assign(detail, {
          stage: 'probability' as const,
          reason: 'probability' as const,
        })
        continue
      }

      triggeredIds.add(entryId)
      setLorebookTimedEffects(timed.state, entry, entryId, messageCount)
      for (const group of entry.inclusionGroups ?? []) activatedGroups.add(group)

      const entryContent = transformEntryText(entry.content, userName, charName)
      const entrySummary = entry.summary?.trim() ? transformEntryText(entry.summary, userName, charName) : undefined
      triggeredItems.push({
        content: entryContent,
        order: entry.order,
        position: entry.position,
        depth: entry.position === 'at_depth' ? (entry.depth ?? 0) : undefined,
        role: entry.position === 'at_depth' ? entry.role : undefined,
        priority: entry.priority,
        score: candidate.semanticScore,
        key: entryId,
        summary: entrySummary,
        ignoreBudget: entry.ignoreBudget,
        insertion: entry.runtime?.insertion,
        adapterId: entry.runtime?.adapterId,
        retrievalMode: loreEntryRetrievalMode(entry),
        lexicalRank: candidate.lexicalHit?.rank,
        lexicalScore: candidate.lexicalHit?.score,
        vectorRank: candidate.hasVectorHit ? semanticRankByKey.get(entryId) : undefined,
        vectorScore: candidate.semanticScore,
        fallbackReason: candidate.lexicalFallbackReason,
      })

      if (recursiveScanning && entry.preventRecursion !== true) {
        recursionText = recursionText ? `${recursionText} ${entryContent}` : entryContent
        appendedRecursion = true
      }
    }

    if (!appendedRecursion) break
  }

  const recentText = recursionText ? `${cleanScanText} ${recursionText}` : cleanScanText

  // 全局内容去重：关键词 / always / 已定位语义条目优先保留。
  const seen = new Set<string>()
  const firstKeyByContent = new Map<string, string>()
  const dedupedItems: BudgetLoreItem[] = []
  for (const item of triggeredItems) {
    if (seen.has(item.content)) {
      if (item.key) {
        const detail = detailByKey.get(item.key)
        if (detail) Object.assign(detail, {
          outcome: 'not_triggered' as const,
          stage: 'deduplication' as const,
          reason: 'duplicate_content' as const,
          duplicateOf: firstKeyByContent.get(item.content),
        })
      }
      continue
    }
    seen.add(item.content)
    if (item.key) firstKeyByContent.set(item.content, item.key)
    dedupedItems.push(item)
  }
  // 语义相似度映射：已定位条目在统一候选阶段恢复 score；无 key 的旧缓存继续兼容。
  const semanticScoreByContent = new Map<string, number>()
  for (const item of triggeredItems) {
    if (typeof item.score === 'number' && Number.isFinite(item.score)) {
      const previous = semanticScoreByContent.get(item.content)
      if (previous === undefined || item.score > previous) semanticScoreByContent.set(item.content, item.score)
    }
  }
  // 仅无定位 key 的历史缓存使用内容兜底。带 key 但当前条目不存在，表示条目已禁用、
  // 删除或不在激活书中，必须拒绝，不能把过期语义命中重新注入。
  for (const item of semanticItems.filter((candidate) => !candidate.key)) {
    if (seen.has(item.content)) continue
    seen.add(item.content)
    dedupedItems.push(item)
  }

  // 阶段四：关键词 / 向量 / 词法三通道 RRF 融合，替代直接混加 BM25 与余弦分数。
  // 各通道 rank 取自通道候选序：向量 = semanticItems 次序，词法 = BM25 命中次序，
  // 关键词 = 命中数降序（同分按条目 order）；归一化后经 fusionScore 参与统一评分。
  const triggeredKeys = new Set(dedupedItems.flatMap((item) => item.key ? [item.key] : []))
  const keywordChannel = [...keywordSignalByKey.entries()]
    .filter(([key]) => triggeredKeys.has(key))
    .sort((a, b) => b[1].activationScore - a[1].activationScore || a[1].order - b[1].order)
    .map(([key, signal]) => ({ key, score: signal.activationScore }))
  const vectorChannel = semanticItems
    .filter((item) => item.key !== undefined && triggeredKeys.has(item.key))
    .map((item) => ({ key: item.key as string, score: item.score ?? 0 }))
  const lexicalChannel = lexicalHits
    .filter((hit) => triggeredKeys.has(hit.key))
    .map((hit) => ({ key: hit.key, score: hit.score }))
  const fusedHits = reciprocalRankFusion(
    { keyword: keywordChannel, vector: vectorChannel, lexical: lexicalChannel },
    { k: LEXICAL_RRF_K },
  )
  const fusionScoreByKey = new Map(fusedHits.map((hit) => [hit.key, hit.normalizedScore]))
  const keywordRankByKey = new Map(keywordChannel.map((hit, index) => [hit.key, index + 1]))
  for (const item of dedupedItems) {
    if (!item.key) continue
    const fusionScore = fusionScoreByKey.get(item.key)
    if (fusionScore !== undefined) item.fusionScore = fusionScore
    const keywordRank = keywordRankByKey.get(item.key)
    if (keywordRank !== undefined) item.keywordRank = keywordRank
  }

  // 统一评分（阶段二B）：关键词命中 + 语义相似度 + 实体命中 + 近因加权
  const scanTextLower = recentText.toLowerCase()
  const scored = scoreItems(dedupedItems, {
    scanText: recentText,
    scanTextLower,
    dialogueText: cleanScanText,
    dialogueTextLower: cleanScanText.toLowerCase(),
    entriesByKey,
    semanticScoreByContent,
    recentEntities: extractEntities({ scanTextLower, charName, entityVocabulary, lorebooks }),
    // 读侧同样按窗口裁剪（防御异常数据：写入侧已裁剪，但窗口常量缩小后旧数据可能超长）
    recentTriggered: new Set((recentTriggeredIds ?? []).slice(-LOREBOOK_RECENCY_WINDOW).flat()),
  })
  for (const item of scored) {
    if (!item.key) continue
    const detail = detailByKey.get(item.key)
    if (!detail) continue
    Object.assign(detail, {
      score: item.score,
      keywordHits: item.keywordHits,
      semanticScore: item.semanticScore,
      semanticSource: item.semanticSource,
      entityHit: item.entityHit,
      recencyHit: item.recencyHit,
      fusionScore: item.fusionScore,
      keywordRank: item.keywordRank,
      originalTokens: estimateTokens(item.content, model),
    })
  }

  // 书级 tokenBudget 裁剪：cap = min(书级预算, 全局预算按书级预算比例分配的份额)。
  // 单书激活或总配额不超全局预算时等价于纯书级预算（行为不变）。
  const allocatedQuotas = allocateGlobalBudgetByBooks(budget, bookBudgets)
  const bookCaps = new Map<string, number>()
  if (allocatedQuotas) {
    for (const [lbId, bookBudget] of bookBudgets) {
      const quota = allocatedQuotas.get(lbId) ?? bookBudget
      bookCaps.set(lbId, Math.min(bookBudget, quota))
    }
  }
  const bookFitted = enforceBookBudgets(scored, bookCaps, lbIdByKey, model)
  for (const item of bookFitted.droppedItems) {
    if (!item.key) continue
    const detail = detailByKey.get(item.key)
    if (detail) Object.assign(detail, {
      outcome: 'dropped' as const,
      stage: 'book_budget' as const,
      reason: 'book_budget' as const,
      injectedTokens: 0,
    })
  }

  // 分桶瀑布裁剪（阶段三：含手写 summary 替代与压缩缓存命中注入）
  const fitted = fitLorebookBudgetByPriority(bookFitted.items, budget, model, compressionCache)
  for (const item of fitted.droppedItems) {
    if (!item.key) continue
    const detail = detailByKey.get(item.key)
    if (detail) Object.assign(detail, {
      outcome: 'dropped' as const,
      stage: 'global_budget' as const,
      reason: 'priority_budget' as const,
      injectedTokens: 0,
      remainingTokens: Math.max(0, budget - fitted.usedTokens),
    })
  }
  const compressionCoveredKeys = new Set(
    fitted.compressionCoveredItems.map((item) => item.key).filter((key): key is string => !!key),
  )
  const originalByKey = new Map(scored.flatMap((item) => item.key ? [[item.key, item] as const] : []))
  for (const item of fitted.kept) {
    if (!item.key) continue
    const detail = detailByKey.get(item.key)
    const original = originalByKey.get(item.key)
    if (!detail || !original) continue
    const usedSummary = item.content !== original.content
    Object.assign(detail, {
      outcome: usedSummary ? 'injected_summary' as const : 'injected' as const,
      stage: 'injection' as const,
      reason: undefined,
      injectedTokens: estimateTokens(item.content, model),
    })
  }
  for (const key of compressionCoveredKeys) {
    const detail = detailByKey.get(key)
    if (detail) Object.assign(detail, {
      outcome: 'injected_compression' as const,
      stage: 'injection' as const,
      reason: undefined,
    })
  }

  const rankedByPriority = new Map<string, number>()
  for (const priority of ['conditional', 'detail'] as const) {
    scored
      .filter((item) => (item.priority ?? 'conditional') === priority)
      .sort((a, b) => b.score - a.score || a.order - b.order)
      .forEach((item, index) => {
        if (item.key) rankedByPriority.set(item.key, index + 1)
      })
  }
  for (const [key, rank] of rankedByPriority) {
    const detail = detailByKey.get(key)
    if (detail) detail.budgetRank = rank
  }

  // 按插入位置分发（filter 保序）+ 计数
  const result = distributeLoreItems(fitted.kept)
  for (const decision of result.renderPlan.decisions) {
    if (!decision.key) continue
    const detail = detailByKey.get(decision.key)
    if (!detail) continue
    detail.renderStatus = decision.status
    detail.renderTarget = decision.target
    detail.renderReason = decision.reason
  }
  result.triggeredCount = dedupedItems.length
  result.droppedCount = fitted.alwaysDropped + fitted.conditionalDropped + fitted.detailDropped + bookFitted.dropped
  result.alwaysDropped = fitted.alwaysDropped
  result.conditionalDropped = fitted.conditionalDropped
  result.detailDropped = fitted.detailDropped
  result.bookBudgetDropped = bookFitted.dropped > 0 ? bookFitted.dropped : undefined
  // 本轮触发（去重后）的条目 key：供调用方更新会话 recency 窗口
  result.triggeredEntryKeys = dedupedItems
    .map((item) => item.key)
    .filter((k): k is string => !!k)
  // 超限压缩请求：供调用方异步 AI 压缩并写入会话缓存
  result.compressionRequests = fitted.compressionRequests
  result.compressionCacheHitKeys = fitted.compressionCacheHitKeys
  result.timedEffects = timed.state
  if (diagnosticsMode) {
    const details = [...detailByKey.values()]
    const injected = details.filter((detail) => detail.outcome.startsWith('injected'))
    const dropped = details.filter((detail) => detail.outcome === 'dropped')
    result.diagnostics = {
      mode: diagnosticsMode,
      generationType,
      createdAt: Date.now(),
      summary: {
        activeBooks: lorebooks.filter((book) => book?.enabled).length,
        enabledEntries: details.length,
        matchedEntries: details.filter((detail) => detail.activationSource !== undefined).length,
        injectedEntries: injected.length,
        summaryEntries: details.filter((detail) => detail.outcome === 'injected_summary').length,
        compressionEntries: details.filter((detail) => detail.outcome === 'injected_compression').length,
        droppedEntries: dropped.length,
        untriggeredEntries: details.filter((detail) => detail.outcome === 'not_triggered').length,
        semanticDeadEntries: semanticEnabled === false
          ? triggerableEntries.filter(({ entry, lbId }) => (
              isSemanticDeadEntry(entry) && !timed.stickyKeys.has(entryKey(lbId, entry))
            )).length
          : 0,
        budget,
        usedTokens: fitted.usedTokens,
        ignoredBudgetTokens: fitted.kept
          .filter((item) => item.ignoreBudget)
          .reduce((sum, item) => sum + estimateTokens(item.content, model), 0),
        bookBudgetDropped: bookFitted.dropped,
        globalBudgetDropped: fitted.droppedItems.length,
      },
      semantic: {
        enabled: semanticEnabled,
        candidateCount: semanticItems.length,
        source: 'current_cache',
      },
      retrieval: {
        lexicalProvider: lexicalProvider.id,
        lexicalCandidateCount: lexicalHits.length,
        vectorCandidateCount: semanticItems.length,
        embeddingsAvailable: semanticEnabled === undefined ? undefined : semanticAvailable,
      },
      scan: {
        rawText: scanText,
        cleanedText: cleanScanText,
        messageCount: scanMessages?.length ?? 0,
      },
      entries: details.sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || a.key.localeCompare(b.key)),
    }
  }
  return result
}

function normalizedSet(values: string[] | undefined): Set<string> {
  return new Set((values ?? []).map((value) => value.trim().toLocaleLowerCase()).filter(Boolean))
}

/** ST 的生成类型与角色/标签过滤。名称与标签均配置时，两组 include 条件都必须满足。 */
function loreEntryContextAllowed(
  entry: LoreEntry,
  generationType: NonNullable<LoreEntry['generationTriggers']>[number],
  characterNames: Set<string>,
  characterTags: Set<string>,
): boolean {
  if (entry.generationTriggers?.length && !entry.generationTriggers.includes(generationType)) return false
  const filter = entry.characterFilter
  if (!filter) return true
  const nameMatched = filter.names.some((name) => characterNames.has(name.trim().toLocaleLowerCase()))
  const tagMatched = filter.tags.some((tag) => characterTags.has(tag.trim().toLocaleLowerCase()))
  if (filter.exclude) return !nameMatched && !tagMatched
  if (filter.names.length > 0 && !nameMatched) return false
  if (filter.tags.length > 0 && !tagMatched) return false
  return true
}

function loreEntryContextBlockReason(
  entry: LoreEntry,
  generationType: NonNullable<LoreEntry['generationTriggers']>[number],
  characterNames: Set<string>,
  characterTags: Set<string>,
): Extract<LoreTriggerReason, 'generation_filter' | 'character_filter'> | undefined {
  if (entry.generationTriggers?.length && !entry.generationTriggers.includes(generationType)) {
    return 'generation_filter'
  }
  if (!loreEntryContextAllowed(entry, generationType, characterNames, characterTags)) {
    return 'character_filter'
  }
  return undefined
}

function loreEntryEffectiveScanDepth(
  entry: LoreEntry,
  messages: string[] | undefined,
  bookScanDepth: number | undefined,
): number | undefined {
  if (!messages) return undefined
  const configuredDepth = entry.scanDepth ?? bookScanDepth
  return configuredDepth === undefined ? messages.length : Math.max(0, Math.floor(configuredDepth))
}

function loreEntryScanText(
  entry: LoreEntry,
  fallback: string,
  messages: string[] | undefined,
  bookScanDepth: number | undefined,
): string {
  if (!messages) return fallback
  const configuredDepth = entry.scanDepth ?? bookScanDepth
  if (configuredDepth === undefined) return fallback
  const depth = Math.max(0, Math.floor(configuredDepth))
  return depth === 0 ? '' : messages.slice(-depth).join(' ')
}

interface LoreActivationCandidate {
  entry: LoreEntry
  lbId: string
  key: string
  recursiveScanning: boolean
  activationScore: number
  semanticScore?: number
  sticky?: boolean
  /** 本轮向量通道是否命中（semanticItems 含该条目）。 */
  hasVectorHit?: boolean
  /** 本轮词法通道命中（含排名与 BM25 分数）；仅深度 0 且策略允许时存在。 */
  lexicalHit?: LexicalRetrievalHit
  /** 决定通道（与诊断 detail.activationSource 一致）。 */
  activationSource?: NonNullable<LoreTriggerDetail['activationSource']>
  /** 词法兜底原因（仅词法为决定通道时存在）。 */
  lexicalFallbackReason?: BudgetLoreItem['fallbackReason']
}

/**
 * ST inclusion group 仲裁：已有组优先封锁后续递归候选；本层先按关键词评分，
 * 再处理 prioritize inclusion，最后按 groupWeight 加权随机。
 */
function resolveInclusionGroups(
  candidates: LoreActivationCandidate[],
  alreadyActivatedGroups: Set<string>,
  random: () => number = Math.random,
  onRejected?: (candidate: LoreActivationCandidate) => void,
): LoreActivationCandidate[] {
  const active = new Set(candidates)
  const groupNames = [...new Set(candidates.flatMap((candidate) => candidate.entry.inclusionGroups ?? []))]

  for (const groupName of groupNames) {
    let group = candidates.filter((candidate) => (
      active.has(candidate) && candidate.entry.inclusionGroups?.includes(groupName)
    ))
    if (group.length === 0) continue
    if (alreadyActivatedGroups.has(groupName)) {
      group.forEach((candidate) => {
        active.delete(candidate)
        onRejected?.(candidate)
      })
      continue
    }

    const sticky = group.filter((candidate) => candidate.sticky)
    if (sticky.length > 0) {
      group.filter((candidate) => !candidate.sticky).forEach((candidate) => {
        active.delete(candidate)
        onRejected?.(candidate)
      })
      continue
    }

    if (group.some((candidate) => candidate.entry.useGroupScoring === true)) {
      const highest = Math.max(...group.map((candidate) => candidate.activationScore))
      group.filter((candidate) => candidate.activationScore < highest).forEach((candidate) => {
        active.delete(candidate)
        onRejected?.(candidate)
      })
      group = group.filter((candidate) => active.has(candidate))
    }
    if (group.length <= 1) continue

    const prioritized = group
      .filter((candidate) => candidate.entry.inclusionGroupPrioritized === true)
      .sort((a, b) => b.entry.order - a.entry.order)
    let winner: LoreActivationCandidate
    if (prioritized.length > 0) {
      winner = prioritized[0]
    } else {
      const totalWeight = group.reduce((sum, candidate) => (
        sum + Math.max(0, candidate.entry.inclusionGroupWeight ?? 100)
      ), 0)
      let roll = totalWeight > 0 ? random() * totalWeight : 0
      winner = group[group.length - 1]
      for (const candidate of group) {
        roll -= Math.max(0, candidate.entry.inclusionGroupWeight ?? 100)
        if (roll <= 0) {
          winner = candidate
          break
        }
      }
    }
    group.filter((candidate) => candidate !== winner).forEach((candidate) => {
      active.delete(candidate)
      onRejected?.(candidate)
    })
  }

  return candidates.filter((candidate) => active.has(candidate))
}

// ===================== 统一缓存 =====================

const _cache = new Map<string, Lorebook>()

export const lorebookCache = {
  get(id: string): Lorebook | undefined {
    return _cache.get(id)
  },

  getAll(ids: string[]): Lorebook[] {
    return ids.map(id => _cache.get(id)).filter(Boolean) as Lorebook[]
  },

  set(id: string, lb: Lorebook): void {
    _cache.set(id, lb)
  },

  setAll(lbs: Lorebook[]): void {
    for (const lb of lbs) _cache.set(lb.id, lb)
  },

  delete(id: string): void {
    _cache.delete(id)
  },

  clear(): void {
    _cache.clear()
  },

  /** 批量加载：从 IPC 获取世界书列表并更新缓存。返回匹配 ids 的 Lorebook[]。 */
  async refresh(ids: string[]): Promise<Lorebook[]> {
    const all = await window.api.lorebook.list()
    // 清理不再活跃的条目
    for (const [cachedId] of _cache) {
      if (!ids.includes(cachedId)) _cache.delete(cachedId)
    }
    // 仅缓存需要的
    for (const id of ids) {
      const lb = all.find(b => b.id === id)
      if (lb) _cache.set(lb.id, lb)
    }
    return ids.map(id => _cache.get(id)).filter(Boolean) as Lorebook[]
  },
}
