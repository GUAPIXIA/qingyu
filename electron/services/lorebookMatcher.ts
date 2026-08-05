/**
 * 世界书自动匹配（导入角色卡时的世界书推荐）
 *
 * 原实现缺陷（问题 32）：
 * 1. 匹配用 split(/\s+/) 按空格分词，中文无空格 → 整段被切成 1 个超长词，
 *    对中文角色/世界书完全失效；
 * 2. 每次导入全量读取所有世界书文件且无规模上限。
 *
 * 修复：
 * - CJK 感知词提取：英文/数字按边界分词，连续中文段短段整段、长段拆 bigram；
 * - 加权计分：角色 name + tags 是精确信号（权重高），description 等是宽信号；
 * - 规模兜底：世界书数量/单文件大小超限时直接跳过匹配，防极端大库卡顿。
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { DIRS } from './storage'
import { createLogger } from './logger'
import type { Character, Lorebook } from '../../shared/types'

const log = createLogger('lorebook-matcher')

/** 参与匹配的世界书数量上限（超过则跳过匹配，防极端大库卡顿） */
const MAX_LOREBOOKS = 100
/** 单个世界书文件大小上限（超过视为超大规模，跳过） */
const MAX_LOREBOOK_SIZE = 20 * 1024 * 1024
/** 推荐数量上限 */
const SUGGEST_LIMIT = 3
/** 推荐阈值：总分达到该值才推荐。
 * 计分权重：角色 name/tags（精确信号）命中世界书名称 +4（强）；
 * 精确词命中描述/关键词 +1、宽信号命中 +1（弱）。
 * 1 个精确词命中世界书名称即达标；常见词偶然命中条目内容无法达标，避免误报 */
const MATCH_THRESHOLD = 4

export interface LorebookSuggestion {
  id: string
  name: string
  description: string
  score: number
  entryCount: number
}

/**
 * CJK 感知词提取：
 * - 英文/数字词：按字母数字边界提取（至少 2 字符，不区分大小写）
 * - 连续中文段：统一拆成相邻二元组（bigram）——保证词粒度一致。
 *   若短段整段入袋（如"修仙世界"整段）而角色侧是单词"修仙"，
 *   粒度不一致导致永远无法命中；统一 bigram 后"修仙世界"→[修仙,仙世,世界]，
 *   与角色侧"修仙"/"世界"可正常求交。
 */
export function extractWords(text: string): Set<string> {
  const words = new Set<string>()
  for (const m of text.matchAll(/[a-zA-Z0-9][a-zA-Z0-9'_-]{1,}/g)) {
    words.add(m[0].toLowerCase())
  }
  for (const seg of text.matchAll(/[\u4e00-\u9fff]{2,}/g)) {
    const s = seg[0]
    for (let i = 0; i < s.length - 1; i++) words.add(s.slice(i, i + 2))
  }
  return words
}

/**
 * 为角色推荐可能相关的世界书（按得分降序，取前 SUGGEST_LIMIT 个）。
 * 角色卡含内嵌世界书（已有 lorebookId）时返回空数组。
 * 规模超限或读取失败时返回空数组（不阻断导入）。
 */
export function suggestLorebooks(character: Character, limit = SUGGEST_LIMIT): LorebookSuggestion[] {
  if (character.lorebookId) return []

  const lorebookDir = DIRS.lorebooks()
  if (!existsSync(lorebookDir)) return []

  let files: string[]
  try {
    files = readdirSync(lorebookDir).filter((f) => f.endsWith('.json'))
  } catch {
    return []
  }
  // 规模兜底：世界书数量过多时跳过匹配，防导入卡顿
  if (files.length > MAX_LOREBOOKS) {
    log.warn('世界书数量超过上限，跳过自动匹配', { count: files.length, max: MAX_LOREBOOKS })
    return []
  }

  // 角色侧词袋：精确信号（name + tags）与宽信号（描述/性格/场景）分开计权
  const preciseText = [character.name, ...(character.tags ?? [])].filter(Boolean).join(' ').toLowerCase()
  const broadText = [character.description, character.personality, character.scenario].filter(Boolean).join(' ').toLowerCase()
  const preciseWords = extractWords(preciseText)
  const broadWords = extractWords(broadText)

  const suggestions: LorebookSuggestion[] = []
  for (const file of files) {
    try {
      const filePath = join(lorebookDir, file)
      // 规模兜底：单文件过大跳过
      const size = statSync(filePath).size
      if (size > MAX_LOREBOOK_SIZE) continue

      const lb = JSON.parse(readFileSync(filePath, 'utf-8')) as Lorebook
      if (!lb.enabled || !lb.id || !Array.isArray(lb.entries)) continue

      // 世界书侧：名称（强信号）与描述/关键词（弱信号）分开建袋
      const lbNameWords = extractWords(lb.name || '')
      const lbBodyWords = extractWords(
        [lb.description, ...lb.entries.flatMap((e) => (Array.isArray(e.keywords) ? e.keywords : []))]
          .filter(Boolean).join(' ').toLowerCase(),
      )

      let score = 0
      // 精确信号：角色名/标签命中世界书名称 → 权重 4（强）
      for (const w of preciseWords) if (lbNameWords.has(w)) score += 4
      // 精确信号命中描述/关键词 → 权重 1（弱，防常见词误报）
      for (const w of preciseWords) if (lbBodyWords.has(w)) score += 1
      // 宽信号：描述/性格/场景命中 → 权重 1
      for (const w of broadWords) if (lbNameWords.has(w) || lbBodyWords.has(w)) score += 1

      if (score >= MATCH_THRESHOLD) {
        suggestions.push({
          id: lb.id,
          name: lb.name || '(未命名世界书)',
          description: (lb.description || '').slice(0, 80),
          score,
          entryCount: lb.entries.length,
        })
      }
    } catch {
      // 单个文件损坏/解析失败跳过，不阻断整体匹配
      continue
    }
  }

  suggestions.sort((a, b) => b.score - a.score)
  return suggestions.slice(0, limit)
}
