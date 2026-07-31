/**
 * 世界书（Lorebook）工具函数与统一缓存
 *
 * 统一入口，避免 fallback 链在各处重复。
 * 缓存层供 buildContext 同步使用（无需 IPC）。
 */

import type { Character, Lorebook, LoreEntry } from '../../shared/types'
import { estimateTokens } from './tokenCounter'
import { replaceVariables } from './variables'
import { expandMacros } from './macros'

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

// ===================== 关键词匹配（去噪） =====================

/** 转义正则特殊字符 */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** CJK 单字关键词命中处的边界字符（标点/空白） */
const CJK_BOUNDARY = /[\s，。、；：！？…·—""''（）【】《》〈〉「」『』,.!?;:()[\]{}<>"'|/\\-]/

/** ASCII 关键词的词边界正则缓存 */
const asciiKeywordRegexCache = new Map<string, RegExp | null>()

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
      asciiKeywordRegexCache.set(kw, regex)
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

// ===================== 世界书 token 预算 =====================

/** 参与预算裁剪的世界书条目（三段共享一个预算池） */
export interface BudgetLoreItem {
  content: string
  order: number
  position: 'before_char' | 'after_char' | 'at_depth' | 'at_end'
  /** at_depth 注入深度（默认 0 = 对话末尾） */
  depth?: number
}

/** at_depth 注入项：按 depth 插入历史消息段内 */
export interface DepthLoreItem {
  content: string
  order: number
  depth: number
}

/** triggerLorebooks 输入参数 */
export interface LorebookTriggerOptions {
  /** 已缓存且启用的世界书列表 */
  lorebooks: Lorebook[]
  /** 初始扫描文本（调用方拼接最近 N 条消息，可带角色名前缀） */
  scanText: string
  userName: string
  charName: string
  /** 世界书 token 预算 */
  budget: number
  model: string
  /** 递归触发最大深度（默认 5） */
  maxRecursiveDepth?: number
}

/** triggerLorebooks 输出：按插入位置分发的触发结果 */
export interface LorebookTriggerResult {
  /** 角色定义前（按 order 升序） */
  beforeChar: string[]
  /** 角色定义后（按 order 升序） */
  afterChar: string[]
  /** 系统提示末尾（按 order 升序） */
  atEnd: string[]
  /** 历史消息内按深度注入（按 order 升序） */
  atDepth: DepthLoreItem[]
  /** 实际触发的条目数（裁剪前） */
  triggeredCount: number
  /** 因预算不足被丢弃的条目数 */
  droppedCount: number
}

/**
 * 世界书预算裁剪：按 order 升序注入，内容去重，超出预算的条目丢弃
 * （继续尝试后面更小的条目）。三段（before/after/atEnd）应合并后传入，
 * 共享同一个预算池，裁剪后由调用方按 position 分回。
 */
export function fitLorebookBudget(
  items: BudgetLoreItem[],
  budget: number,
  model: string,
): { kept: BudgetLoreItem[]; dropped: number; usedTokens: number } {
  const sorted = [...items].sort((a, b) => a.order - b.order)
  const seen = new Set<string>()
  const kept: BudgetLoreItem[] = []
  let used = 0
  for (const it of sorted) {
    if (seen.has(it.content)) continue
    const t = estimateTokens(it.content, model)
    if (used + t > budget) continue
    seen.add(it.content)
    kept.push(it)
    used += t
  }
  return { kept, dropped: items.length - kept.length, usedTokens: used }
}

/**
 * 将已裁剪的世界书条目按插入位置分发。
 * 纯函数：供 triggerLorebooks 与 mergeSemanticHits 复用。
 */
export function distributeLoreItems(items: BudgetLoreItem[]): LorebookTriggerResult {
  const result: LorebookTriggerResult = {
    beforeChar: [],
    afterChar: [],
    atEnd: [],
    atDepth: [],
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
        result.atDepth.push({ content: item.content, order: item.order, depth: item.depth ?? 0 })
        break
      default:
        result.atEnd.push(item.content)
    }
  }
  return result
}

/**
 * 合并语义命中（向量 RAG）条目与关键词触发结果。
 * 策略：关键词命中的条目优先保留，语义命中条目按 order 升序填充剩余预算，
 * 相同内容自动去重（与关键词重复的语义命中跳过）。
 *
 * @param base 关键词触发的分发结果（各段已裁剪，占用预算 ≤ budget）
 * @param semanticItems 语义命中条目（尚未裁剪）
 * @param budget 世界书总预算（tokens）
 * @param model 用于 token 估算的模型
 */
export function mergeSemanticHits(
  base: LorebookTriggerResult,
  semanticItems: BudgetLoreItem[],
  budget: number,
  model: string,
): LorebookTriggerResult {
  if (semanticItems.length === 0) return base

  // 关键词已保留条目的 token 占用（各段内容保序）
  const baseTokens = estimateTokens(base.beforeChar.join(''), model)
    + estimateTokens(base.afterChar.join(''), model)
    + estimateTokens(base.atEnd.join(''), model)
    + estimateTokens(base.atDepth.map((d) => d.content).join(''), model)

  // 去重：跳过与关键词已保留内容重复的条目；候选之间按 order 升序
  const seen = new Set<string>([
    ...base.beforeChar,
    ...base.afterChar,
    ...base.atEnd,
    ...base.atDepth.map((d) => d.content),
  ])
  const candidates = semanticItems
    .filter((it) => {
      if (seen.has(it.content)) return false
      seen.add(it.content)
      return true
    })
    .sort((a, b) => a.order - b.order)

  // 剩余预算填充语义候选
  let remaining = Math.max(0, budget - baseTokens)
  const kept: BudgetLoreItem[] = []
  for (const item of candidates) {
    const t = estimateTokens(item.content, model)
    if (t > remaining) continue
    remaining -= t
    kept.push(item)
  }
  if (kept.length === 0) return base

  // 语义命中并入对应段（各段内按 order 有序）
  const result: LorebookTriggerResult = {
    beforeChar: [...base.beforeChar],
    afterChar: [...base.afterChar],
    atEnd: [...base.atEnd],
    atDepth: [...base.atDepth],
    triggeredCount: base.triggeredCount + kept.length,
    droppedCount: base.droppedCount + (semanticItems.length - kept.length),
  }
  for (const item of kept) {
    switch (item.position) {
      case 'before_char':
        result.beforeChar.push(item.content)
        break
      case 'after_char':
        result.afterChar.push(item.content)
        break
      case 'at_depth':
        result.atDepth.push({ content: item.content, order: item.order, depth: item.depth ?? 0 })
        break
      default:
        result.atEnd.push(item.content)
    }
  }
  return result
}

// ===================== 统一触发入口 =====================

/**
 * 世界书统一触发（单聊 / 群聊共用）：
 * 1. 关键词（词边界感知）与正则匹配
 * 2. 递归扫描：条目内容加入扫描文本可触发其他条目
 * 3. 概率骰子（probability < 100 时随机跳过）
 * 4. 预算裁剪（按 order 升序，超出丢弃）
 * 5. 按插入位置分发（before/after/at_end/at_depth）
 */
export function triggerLorebooks(opts: LorebookTriggerOptions): LorebookTriggerResult {
  const {
    lorebooks,
    scanText,
    userName,
    charName,
    budget,
    model,
    maxRecursiveDepth = 5,
  } = opts

  let recentText = scanText

  // 收集所有启用条目（matchMode = 'semantic' 的条目仅走语义触发，不参与关键词匹配）
  const allEntries: { entry: LoreEntry; lbId: string }[] = []
  for (const lb of lorebooks) {
    if (!lb?.enabled) continue
    for (const entry of lb.entries) {
      if (!entry.enabled) continue
      if ((entry.matchMode ?? 'both') === 'semantic') continue
      allEntries.push({ entry, lbId: lb.id })
    }
  }

  // 预编译正则缓存 + 预分组 plain/regex 条目
  const regexCache = new Map<string, RegExp>()
  const plainKeywordEntries: typeof allEntries = []
  const regexEntries: typeof allEntries = []
  for (const item of allEntries) {
    if (item.entry.useRegex) regexEntries.push(item)
    else plainKeywordEntries.push(item)
  }

  const triggeredIds = new Set<string>()
  const triggeredItems: BudgetLoreItem[] = []

  for (let depth = 0; depth < maxRecursiveDepth; depth++) {
    let newTriggered = false
    const recentTextLower = recentText.toLowerCase()

    // 普通关键词
    for (const { entry, lbId } of plainKeywordEntries) {
      if (!Array.isArray(entry.keywords)) continue
      const entryId = `${lbId}:${entry.id || entry.keywords.join(',')}`
      if (triggeredIds.has(entryId)) continue

      const matched = entry.keywords.some((k) => !!k && keywordMatch(k, recentTextLower))
      if (!matched) continue

      if (entry.probability < 100 && Math.random() * 100 >= entry.probability) continue

      triggeredIds.add(entryId)
      newTriggered = true

      const entryContent = expandMacros(replaceVariables(entry.content, userName, charName), {
        userName,
        charName,
      })
      triggeredItems.push({
        content: entryContent,
        order: entry.order,
        position: entry.position,
        depth: entry.position === 'at_depth' ? (entry.depth ?? 0) : undefined,
      })

      recentText += ' ' + entryContent
    }

    // 正则关键词
    for (const { entry, lbId } of regexEntries) {
      if (!Array.isArray(entry.keywords)) continue
      const entryId = `${lbId}:${entry.id || entry.keywords.join(',')}`
      if (triggeredIds.has(entryId)) continue

      const matched = entry.keywords.some((k) => {
        if (!k) return false
        const cacheKey = `${k}|${entry.regexFlags || 'i'}`
        let regex = regexCache.get(cacheKey)
        if (!regex) {
          try {
            regex = new RegExp(k, entry.regexFlags || 'i')
            regexCache.set(cacheKey, regex)
          } catch {
            return false
          }
        }
        return regex.test(recentText)
      })
      if (!matched) continue

      if (entry.probability < 100 && Math.random() * 100 >= entry.probability) continue

      triggeredIds.add(entryId)
      newTriggered = true

      const entryContent = expandMacros(replaceVariables(entry.content, userName, charName), {
        userName,
        charName,
      })
      triggeredItems.push({
        content: entryContent,
        order: entry.order,
        position: entry.position,
        depth: entry.position === 'at_depth' ? (entry.depth ?? 0) : undefined,
      })

      recentText += ' ' + entryContent
    }

    if (!newTriggered) break
  }

  // 预算裁剪（fitLorebookBudget 已按 order 升序）
  const { kept, dropped } = fitLorebookBudget(triggeredItems, budget, model)

  // 按插入位置分发（filter 保序）
  const result: LorebookTriggerResult = {
    beforeChar: [],
    afterChar: [],
    atEnd: [],
    atDepth: [],
    triggeredCount: triggeredItems.length,
    droppedCount: dropped,
  }
  for (const item of kept) {
    switch (item.position) {
      case 'before_char':
        result.beforeChar.push(item.content)
        break
      case 'after_char':
        result.afterChar.push(item.content)
        break
      case 'at_depth':
        result.atDepth.push({ content: item.content, order: item.order, depth: item.depth ?? 0 })
        break
      default:
        result.atEnd.push(item.content)
    }
  }
  return result
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
