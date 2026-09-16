import { nanoid } from 'nanoid'
import type { Lorebook, LoreEntry } from '../../shared/types'

type UnknownRecord = Record<string, unknown>
export type LoreSourceKind = 'native' | 'sillytavern' | 'character_book'

export interface NormalizeLorebookOptions {
  /** 调用方完成 safeId 校验后传入；内嵌世界书通常直接传新生成的 id。 */
  id?: string
  fallbackName: string
  /**
   * 来源格式。阶段 7 起为必填：格式识别是 adapter 的职责（多证据打分、可解释），
   * 统一导入器不再按单条字段猜测来源。
   */
  sourceKind: LoreSourceKind
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** lorebook_v3 使用 { spec, data } 包装；其他格式直接以顶层对象为书体。 */
export function unwrapLorebookPayload(raw: unknown): UnknownRecord {
  if (!isRecord(raw)) return {}
  if (raw.spec === 'lorebook_v3' && isRecord(raw.data)) return raw.data
  return raw
}

function entriesFrom(raw: unknown): UnknownRecord[] {
  if (Array.isArray(raw)) return raw.filter(isRecord)
  if (isRecord(raw)) return Object.values(raw).filter(isRecord)
  return []
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter(Boolean)
  }
  if (typeof value !== 'string') return []
  const trimmed = value.trim()
  if (!trimmed) return []
  // ST 的正则 key 可能包含逗号；完整的 /pattern/flags 必须作为单个 key 保留。
  if (/^\/[\s\S]+\/[a-z]*$/i.test(trimmed)) return [trimmed]
  return trimmed.split(/[,，\n]+/).map((item) => item.trim()).filter(Boolean)
}

function plainStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === 'string')
      .flatMap((item) => item.split(/[,，\n]+/))
      .map((item) => item.trim())
      .filter(Boolean)
  }
  if (typeof value !== 'string') return []
  return value.split(/[,，\n]+/).map((item) => item.trim()).filter(Boolean)
}

function finiteNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return undefined
}

function normalizePosition(value: unknown): LoreEntry['position'] {
  if (value === 'before_char' || value === 'before' || value === 0) return 'before_char'
  if (value === 'after_char' || value === 'after' || value === 1) return 'after_char'
  // 当前 ST：4 = in-chat at depth。旧字符串别名继续兼容。
  if (value === 'at_depth' || value === 'depth' || value === 4) return 'at_depth'
  if (value === 'at_end') return 'at_end'
  // ST 的 AN / example-message / outlet 位置在轻语暂无等价位置，统一降级到 system 尾部，
  // 避免像旧映射那样把 position=2 错当成 chat depth。
  return 'at_end'
}

/** ST/CC at_depth role：原始 ST JSON 使用 0/1/2，轻语原生格式使用字符串。 */
function normalizeDepthRole(value: unknown): LoreEntry['role'] {
  if (value === 'system' || value === 0) return 'system'
  if (value === 'user' || value === 1) return 'user'
  if (value === 'assistant' || value === 2) return 'assistant'
  return undefined
}

function normalizeSelectiveLogic(raw: UnknownRecord, secondaryKeywords: string[]): LoreEntry['selectiveLogic'] {
  if (secondaryKeywords.length === 0 || raw.selective === false) return undefined
  const value = raw.selectiveLogic ?? raw.selective_logic
  if (value === 'and_any' || value === 'AND ANY' || value === 0) return 'and_any'
  if (value === 'not_all' || value === 'NOT ALL' || value === 1) return 'not_all'
  if (value === 'not_any' || value === 'NOT ANY' || value === 2) return 'not_any'
  if (value === 'and_all' || value === 'AND ALL' || value === 3) return 'and_all'
  return raw.selective === true ? 'and_any' : undefined
}

function normalizeCharacterFilter(value: unknown): LoreEntry['characterFilter'] {
  if (!isRecord(value)) return undefined
  const names = plainStringList(value.names)
  const tags = plainStringList(value.tags)
  if (names.length === 0 && tags.length === 0 && value.isExclude !== true && value.exclude !== true) return undefined
  return {
    exclude: value.exclude === true || value.isExclude === true,
    names,
    tags,
  }
}

const GENERATION_TRIGGERS = new Set<NonNullable<LoreEntry['generationTriggers']>[number]>([
  'normal', 'continue', 'impersonate', 'swipe', 'regenerate', 'quiet',
])

function normalizeGenerationTriggers(value: unknown): LoreEntry['generationTriggers'] {
  const triggers = plainStringList(value)
    .map((item) => item.toLowerCase())
    .filter((item): item is NonNullable<LoreEntry['generationTriggers']>[number] => (
      GENERATION_TRIGGERS.has(item as NonNullable<LoreEntry['generationTriggers']>[number])
    ))
  return triggers.length > 0 ? [...new Set(triggers)] : undefined
}

function normalizeEntry(raw: UnknownRecord, index: number, source: LoreSourceKind): LoreEntry {
  const extensions = isRecord(raw.extensions) ? raw.extensions : {}
  const fields: UnknownRecord = { ...extensions, ...raw }
  const extended = (camel: string, snake: string = camel): unknown => raw[camel] ?? raw[snake] ?? extensions[camel] ?? extensions[snake]
  const keywords = stringList(raw.keywords ?? raw.keys ?? raw.key)
  const secondaryKeywords = stringList(raw.secondaryKeywords ?? raw.secondary_keys ?? raw.keysecondary)
  const selectiveLogic = normalizeSelectiveLogic(fields, secondaryKeywords)
  const rawId = raw.id ?? raw.uid
  const id = (typeof rawId === 'string' || typeof rawId === 'number') && String(rawId).trim()
    ? String(rawId)
    : nanoid()
  const order = finiteNumber(raw.order, raw.insertion_order) ?? index
  const probabilityValue = extended('useProbability', 'use_probability') === false
    ? 100
    : (finiteNumber(extended('probability')) ?? 100)
  const probability = Math.max(0, Math.min(100, probabilityValue))
  const enabled = typeof raw.enabled === 'boolean'
    ? raw.enabled
    : raw.disable !== true

  const priorityValue = extended('priority')
  const explicitPriority = priorityValue === 'always' || priorityValue === 'conditional' || priorityValue === 'detail'
    ? priorityValue
    : undefined
  const priority: LoreEntry['priority'] = explicitPriority ?? (extended('constant') === true ? 'always' : undefined)

  const matchModeValue = extended('matchMode', 'match_mode')
  const explicitMatchMode = matchModeValue === 'keyword' || matchModeValue === 'semantic' || matchModeValue === 'both'
    ? matchModeValue
    : undefined
  let matchMode: LoreEntry['matchMode'] = explicitMatchMode
  if (!matchMode && source !== 'native') {
    // ST 的 vectorized 是额外触发通道：有 key 时保留关键词+语义，无 key 时为纯语义。
    // 标准 character_book 没有语义匹配字段，按规范只走关键词。
    matchMode = extended('vectorized') === true
      ? (keywords.length > 0 ? 'both' : 'semantic')
      : 'keyword'
  }

  const useRegexValue = extended('useRegex', 'use_regex')
  const useRegex = typeof useRegexValue === 'boolean' ? useRegexValue : undefined
  const entryScanDepth = finiteNumber(extended('scanDepth', 'scan_depth'))
  const rawDelayUntilRecursion = extended('delayUntilRecursion', 'delay_until_recursion')
  const delayUntilRecursion = rawDelayUntilRecursion === true
    ? 1
    : finiteNumber(rawDelayUntilRecursion)
  const inclusionGroups = plainStringList(extended('group'))
  const characterFilter = normalizeCharacterFilter(extended('characterFilter', 'character_filter'))
  const generationTriggers = normalizeGenerationTriggers(extended('triggers'))
  const sticky = finiteNumber(extended('sticky'))
  const cooldown = finiteNumber(extended('cooldown'))
  const delay = finiteNumber(extended('delay'))

  // ST position=4（at_depth）的 depth 缺省是 4；其他位置 depth 无意义保持 0。
  // 需先算 position 再校正 depth 默认值。
  const position = normalizePosition(source === 'character_book' ? (extensions.position ?? raw.position) : extended('position'))
  const hasExplicitDepth = finiteNumber(extended('depth')) !== undefined
  const depth = hasExplicitDepth
    ? Math.max(0, Math.floor(finiteNumber(extended('depth'))!))
    : (position === 'at_depth' && source !== 'native' ? 4 : 0)
  // ST at_depth 条目的 role：注入消息角色（仅 at_depth 有意义，其他位置忽略）
  const roleValue = extended('role')
  const role = position === 'at_depth' ? normalizeDepthRole(roleValue) : undefined

  return {
    id,
    keywords,
    content: typeof raw.content === 'string' ? raw.content : '',
    position,
    depth,
    ...(role !== undefined ? { role } : {}),
    order,
    probability,
    enabled,
    ...(useRegex !== undefined ? { useRegex } : {}),
    ...(typeof extended('regexFlags', 'regex_flags') === 'string'
      ? { regexFlags: extended('regexFlags', 'regex_flags') as string }
      : {}),
    ...(secondaryKeywords.length > 0 ? { secondaryKeywords } : {}),
    ...(selectiveLogic !== undefined ? { selectiveLogic } : {}),
    ...(typeof extended('caseSensitive', 'case_sensitive') === 'boolean'
      ? { caseSensitive: extended('caseSensitive', 'case_sensitive') as boolean }
      : {}),
    ...(typeof extended('matchWholeWords', 'match_whole_words') === 'boolean'
      ? { matchWholeWords: extended('matchWholeWords', 'match_whole_words') as boolean }
      : {}),
    ...(extended('excludeRecursion', 'exclude_recursion') === true ? { excludeRecursion: true } : {}),
    ...(extended('preventRecursion', 'prevent_recursion') === true ? { preventRecursion: true } : {}),
    ...(entryScanDepth !== undefined ? { scanDepth: Math.max(0, Math.floor(entryScanDepth)) } : {}),
    ...(delayUntilRecursion !== undefined
      ? { delayUntilRecursion: Math.max(1, Math.floor(delayUntilRecursion)) }
      : {}),
    ...(inclusionGroups.length > 0 ? { inclusionGroups } : {}),
    ...(extended('groupOverride', 'group_override') === true ? { inclusionGroupPrioritized: true } : {}),
    ...(finiteNumber(extended('groupWeight', 'group_weight')) !== undefined
      ? { inclusionGroupWeight: Math.max(0, finiteNumber(extended('groupWeight', 'group_weight'))!) }
      : {}),
    ...(extended('useGroupScoring', 'use_group_scoring') === true ? { useGroupScoring: true } : {}),
    ...(characterFilter ? { characterFilter } : {}),
    ...(generationTriggers ? { generationTriggers } : {}),
    ...(sticky !== undefined && sticky > 0 ? { sticky: Math.floor(sticky) } : {}),
    ...(cooldown !== undefined && cooldown > 0 ? { cooldown: Math.floor(cooldown) } : {}),
    ...(delay !== undefined && delay > 0 ? { delay: Math.floor(delay) } : {}),
    ...(extended('ignoreBudget', 'ignore_budget') === true ? { ignoreBudget: true } : {}),
    ...(matchMode !== undefined ? { matchMode } : {}),
    ...(priority !== undefined ? { priority } : {}),
    ...(typeof raw.summary === 'string' ? { summary: raw.summary } : {}),
    ...(typeof raw.translation === 'string' ? { translation: raw.translation } : {}),
  }
}

/**
 * 将轻语原生、SillyTavern、CCv2/CCv3 character_book 与 lorebook_v3
 * 统一归一化为运行时 Lorebook。独立导入和角色卡内嵌导入必须共同调用此函数。
 */
export function normalizeImportedLorebook(raw: unknown, options: NormalizeLorebookOptions): Lorebook {
  const payload = unwrapLorebookPayload(raw)
  const scanDepthValue = finiteNumber(payload.scanDepth, payload.scan_depth) ?? 4
  const importedTokenBudget = finiteNumber(payload.tokenBudget, payload.token_budget)
  const enabled = typeof payload.enabled === 'boolean'
    ? payload.enabled
    : payload.disable !== true

  return {
    id: options.id ?? (typeof payload.id === 'string' && payload.id.trim() ? payload.id : nanoid()),
    name: typeof payload.name === 'string' && payload.name.trim() ? payload.name : options.fallbackName,
    description: typeof payload.description === 'string' ? payload.description : '',
    entries: entriesFrom(payload.entries).map((entry, index) => normalizeEntry(entry, index, options.sourceKind)),
    enabled,
    // 保留 0；它在 ST/CC 规范中有明确含义，不能在导入边界静默改成 1。
    scanDepth: Math.max(0, Math.floor(scanDepthValue)),
    ...(typeof payload.recursiveScanning === 'boolean'
      ? { recursiveScanning: payload.recursiveScanning }
      : (typeof payload.recursive_scanning === 'boolean' ? { recursiveScanning: payload.recursive_scanning } : {})),
    ...(importedTokenBudget !== undefined && Math.floor(importedTokenBudget) > 0
      ? { tokenBudget: Math.floor(importedTokenBudget) }
      : {}),
  }
}
