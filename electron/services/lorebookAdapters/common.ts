import type { LoreEntry } from '../../../shared/types'
import type {
  CanonicalLoreEntryV2,
  CanonicalLorebookDocumentV2,
  JsonValue,
  LorebookInsertionV2,
} from '../../../shared/lorebook/domain/v2'
import type {
  LorebookAdapterExportResult,
  LorebookAdapterImportResult,
  LorebookCompatibilityIssue,
  LorebookImportContext,
} from '../../../shared/lorebook/adapters/types'
import { migrateNativeLorebookV1ToV2 } from '../../../shared/lorebook/migrations/v1-to-v2'
import { normalizeImportedLorebook, type LoreSourceKind } from '../lorebookImport'
import { compatibilityIssue, createCompatibilityReport } from './report'

type UnknownRecord = Record<string, unknown>

export interface ExternalAdapterConfig {
  id: string
  label: string
  version: string
  sourceKind: Exclude<LoreSourceKind, 'native'>
  style: 'sillytavern' | 'character_book'
  /**
   * adapter 实际消费的条目级字段。已列出的字段不再进入 unknown 保留区；
   * 未消费字段仍按 unknown 保留并可随同格式导出合并回去。
   * 默认使用 ST/CC 全集；P1 生态格式应传入自己的消费集。
   */
  consumedEntryKeys?: Set<string>
}

/** 组合适配器消费字段集：ENTRY_KEYS 基础上追加格式特有字段。 */
export function consumedKeys(extra: string[]): Set<string> {
  return new Set([...ENTRY_KEYS, ...extra])
}

const BOOK_KEYS = new Set([
  'id', 'name', 'description', 'entries', 'enabled', 'disable',
  'scanDepth', 'scan_depth', 'recursiveScanning', 'recursive_scanning',
  'tokenBudget', 'token_budget', 'extensions',
])

const ENTRY_KEYS = new Set([
  'id', 'uid', 'keywords', 'keys', 'key', 'content', 'position', 'depth', 'role',
  'order', 'insertion_order', 'probability', 'enabled', 'disable', 'constant',
  'useRegex', 'use_regex', 'regexFlags', 'regex_flags', 'secondaryKeywords',
  'secondary_keys', 'keysecondary', 'selective', 'selectiveLogic', 'selective_logic',
  'caseSensitive', 'case_sensitive', 'matchWholeWords', 'match_whole_words',
  'excludeRecursion', 'exclude_recursion', 'preventRecursion', 'prevent_recursion',
  'scanDepth', 'scan_depth', 'delayUntilRecursion', 'delay_until_recursion',
  'group', 'groupOverride', 'group_override', 'groupWeight', 'group_weight',
  'useGroupScoring', 'use_group_scoring', 'characterFilter', 'character_filter',
  'triggers', 'sticky', 'cooldown', 'delay', 'ignoreBudget', 'ignore_budget',
  'matchMode', 'match_mode', 'vectorized', 'priority', 'summary', 'translation',
  'useProbability', 'use_probability', 'extensions', 'comment', 'name', 'outletName',
  'outlet_name',
])

const EXTENSION_KEYS = new Set([
  'position', 'depth', 'role', 'probability', 'useProbability', 'use_probability',
  'constant', 'vectorized', 'useRegex', 'use_regex', 'regexFlags', 'regex_flags',
  'selective', 'selectiveLogic', 'selective_logic', 'caseSensitive', 'case_sensitive',
  'matchWholeWords', 'match_whole_words', 'excludeRecursion', 'exclude_recursion',
  'preventRecursion', 'prevent_recursion', 'scanDepth', 'scan_depth',
  'delayUntilRecursion', 'delay_until_recursion', 'group', 'groupOverride',
  'group_override', 'groupWeight', 'group_weight', 'useGroupScoring',
  'use_group_scoring', 'characterFilter', 'character_filter', 'triggers', 'sticky',
  'cooldown', 'delay', 'ignoreBudget', 'ignore_budget', 'matchMode', 'match_mode',
  'priority', 'outletName', 'outlet_name',
])

export function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

export function toJsonValue(value: unknown): JsonValue | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (Array.isArray(value)) {
    const result: JsonValue[] = []
    for (const item of value) {
      const converted = toJsonValue(item)
      if (converted !== undefined) result.push(converted)
    }
    return result
  }
  if (isRecord(value)) {
    const result: Record<string, JsonValue> = {}
    for (const [key, item] of Object.entries(value)) {
      if (DANGEROUS_KEYS.has(key)) continue
      const converted = toJsonValue(item)
      if (converted !== undefined) result[key] = converted
    }
    return result
  }
  return undefined
}

function sourceEntries(value: unknown): Array<{ key: string; value: UnknownRecord }> {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => isRecord(entry) ? [{ key: String(index), value: entry }] : [])
  }
  if (isRecord(value)) {
    return Object.entries(value).flatMap(([key, entry]) => isRecord(entry) ? [{ key, value: entry }] : [])
  }
  return []
}

function collectExtras(
  value: unknown,
  known: Set<string>,
  path: string,
  issues: LorebookCompatibilityIssue[],
): Record<string, JsonValue> {
  if (!isRecord(value)) return {}
  const extras: Record<string, JsonValue> = {}
  for (const [key, raw] of Object.entries(value)) {
    if (DANGEROUS_KEYS.has(key)) {
      issues.push(compatibilityIssue('warning', 'dropped', 'dangerous_key', `${path}.${key}`, '危险键已忽略'))
      continue
    }
    if (known.has(key)) continue
    const converted = toJsonValue(raw)
    if (converted === undefined) {
      issues.push(compatibilityIssue('warning', 'dropped', 'non_json_field', `${path}.${key}`, '字段不是可持久化的 JSON 值，已忽略'))
      continue
    }
    extras[key] = converted
    issues.push(compatibilityIssue('info', 'preserved', 'unknown_field', `${path}.${key}`, '未知字段已原样保留在 namespaced foreign 中'))
  }
  return extras
}

function foreignPayload(fields: Record<string, JsonValue>, extensions: Record<string, JsonValue>): JsonValue | undefined {
  const payload: Record<string, JsonValue> = {}
  if (Object.keys(fields).length > 0) payload.fields = fields
  if (Object.keys(extensions).length > 0) payload.extensions = extensions
  return Object.keys(payload).length > 0 ? payload : undefined
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function normalizeRole(value: unknown): 'system' | 'user' | 'assistant' | undefined {
  if (value === 'system' || value === 0) return 'system'
  if (value === 'user' || value === 1) return 'user'
  if (value === 'assistant' || value === 2) return 'assistant'
  return undefined
}

function sourceField(raw: UnknownRecord, config: ExternalAdapterConfig, key: string): unknown {
  const extensions = isRecord(raw.extensions) ? raw.extensions : {}
  return config.style === 'character_book'
    ? extensions[key] ?? raw[key]
    : raw[key] ?? extensions[key]
}

function insertionFromSource(
  raw: UnknownRecord,
  config: ExternalAdapterConfig,
  path: string,
  issues: LorebookCompatibilityIssue[],
): LorebookInsertionV2 {
  const rawPosition = raw.position
  const extensionPosition = isRecord(raw.extensions) ? raw.extensions.position : undefined
  if (config.style === 'character_book'
    && rawPosition !== undefined
    && extensionPosition !== undefined
    && rawPosition !== extensionPosition) {
    issues.push(compatibilityIssue(
      'warning', 'mapped', 'position_conflict', `${path}.extensions.position`,
      '顶层 position 与 extensions.position 冲突；按 character_book 扩展规则采用 extensions.position',
    ))
  }
  const value = config.style === 'character_book' ? extensionPosition ?? rawPosition : rawPosition ?? extensionPosition
  if (value === 0 || value === 'before' || value === 'before_char' || value === 'before_character') {
    return { kind: 'prompt', anchor: 'before_character' }
  }
  if (value === 1 || value === 'after' || value === 'after_char' || value === 'after_character') {
    return { kind: 'prompt', anchor: 'after_character' }
  }
  if (value === 4 || value === 'at_depth' || value === 'depth') {
    const depth = Math.max(0, Math.floor(finiteNumber(sourceField(raw, config, 'depth')) ?? 4))
    const role = normalizeRole(sourceField(raw, config, 'role'))
    return { kind: 'chat', depth, ...(role ? { role } : {}) }
  }

  const anchors = new Map<unknown, LorebookInsertionV2>([
    [2, { kind: 'prompt', anchor: 'authors_note_top' }],
    ['authors_note_top', { kind: 'prompt', anchor: 'authors_note_top' }],
    ['before_an', { kind: 'prompt', anchor: 'authors_note_top' }],
    [3, { kind: 'prompt', anchor: 'authors_note_bottom' }],
    ['authors_note_bottom', { kind: 'prompt', anchor: 'authors_note_bottom' }],
    ['after_an', { kind: 'prompt', anchor: 'authors_note_bottom' }],
    [5, { kind: 'prompt', anchor: 'before_examples' }],
    ['before_examples', { kind: 'prompt', anchor: 'before_examples' }],
    [6, { kind: 'prompt', anchor: 'after_examples' }],
    ['after_examples', { kind: 'prompt', anchor: 'after_examples' }],
  ])
  const anchor = anchors.get(value)
  if (anchor) {
    // 运行时 renderer 对这 4 个锚点原位渲染（方案 §9.1），此处为精确映射而非近似
    issues.push(compatibilityIssue(
      'info', 'mapped', 'insertion_anchor', `${path}.position`,
      '插入位置已保留；运行时将按作者注释/示例区锚点原位渲染',
    ))
    return anchor
  }
  if (value === 7 || value === 'outlet') {
    const outlet = sourceField(raw, config, 'outletName') ?? sourceField(raw, config, 'outlet_name')
    issues.push(compatibilityIssue(
      'warning', 'approximated', 'runtime_outlet_fallback', `${path}.position`,
      '命名 outlet 已保留；普通聊天消息协议没有对应插槽，运行时回退到提示词末尾并输出诊断',
    ))
    return { kind: 'outlet', name: typeof outlet === 'string' && outlet ? outlet : 'default' }
  }
  if (value === undefined || value === 'at_end' || value === 'prompt_end') {
    return { kind: 'prompt', anchor: 'prompt_end' }
  }
  issues.push(compatibilityIssue(
    'warning', 'approximated', 'custom_insertion', `${path}.position`,
    '未知插入位置已作为 custom 值保留；运行时回退到提示词末尾并输出诊断',
  ))
  return { kind: 'custom', source: config.id, value: toJsonValue(value) ?? null }
}

export function importExternalLorebook(
  rawInput: unknown,
  payload: UnknownRecord,
  context: LorebookImportContext,
  config: ExternalAdapterConfig,
  wrapperExtras: Record<string, JsonValue> = {},
): LorebookAdapterImportResult {
  const issues: LorebookCompatibilityIssue[] = []
  const normalized = normalizeImportedLorebook(payload, {
    id: context.id,
    fallbackName: context.fallbackName,
    sourceKind: config.sourceKind,
  })
  const document = migrateNativeLorebookV1ToV2(normalized, {
    now: context.now,
    contentHash: context.contentHash,
  })
  document.source = {
    adapterId: config.id,
    formatVersion: config.version,
    originalName: normalized.name,
    importedAt: context.now,
    contentHash: context.contentHash,
  }

  const bookFields = collectExtras(payload, BOOK_KEYS, '$', issues)
  const bookExtensions = collectExtras(payload.extensions, new Set<string>(), '$.extensions', issues)
  const bookForeign: Record<string, JsonValue> = {}
  const payloadForeign = foreignPayload(bookFields, bookExtensions)
  if (payloadForeign !== undefined) bookForeign.payload = payloadForeign
  if (Object.keys(wrapperExtras).length > 0) bookForeign.wrapper = wrapperExtras
  if (Object.keys(bookForeign).length > 0) {
    document.foreign = { ...(document.foreign ?? {}), [config.id]: bookForeign }
  }

  const rawEntryValue = payload.entries
  const sourceEntryList = sourceEntries(rawEntryValue)
  const sourceCount = Array.isArray(rawEntryValue)
    ? rawEntryValue.length
    : isRecord(rawEntryValue) ? Object.keys(rawEntryValue).length : 0
  if (sourceCount > sourceEntryList.length) {
    issues.push(compatibilityIssue(
      'error', 'rejected', 'invalid_entries', '$.entries',
      `${sourceCount - sourceEntryList.length} 个条目不是对象，无法导入`,
    ))
  }
  if (sourceEntryList.length === 0) {
    issues.push(compatibilityIssue('error', 'rejected', 'empty_entries', '$.entries', '没有可导入的世界书条目'))
  }

  document.entries = document.entries.map((entry, index) => {
    const sourceEntry = sourceEntryList[index]
    if (!sourceEntry) return entry
    const rawEntry = sourceEntry.value
    const fields = collectExtras(rawEntry, config.consumedEntryKeys ?? ENTRY_KEYS, `$.entries[${sourceEntry.key}]`, issues)
    const extensions = collectExtras(
      rawEntry.extensions,
      EXTENSION_KEYS,
      `$.entries[${sourceEntry.key}].extensions`,
      issues,
    )
    const foreign = foreignPayload(fields, extensions)
    const sourceId = rawEntry.id ?? rawEntry.uid ?? sourceEntry.key
    const title = typeof rawEntry.comment === 'string'
      ? rawEntry.comment
      : typeof rawEntry.name === 'string' ? rawEntry.name : undefined
    return {
      ...entry,
      sourceId: typeof sourceId === 'string' || typeof sourceId === 'number' ? sourceId : entry.sourceId,
      ...(title ? { title } : {}),
      insertion: insertionFromSource(rawEntry, config, `$.entries[${sourceEntry.key}]`, issues),
      ...(foreign !== undefined
        ? { foreign: { ...(entry.foreign ?? {}), [config.id]: foreign } }
        : {}),
    }
  })

  // rawInput is intentionally accepted separately: wrapper adapters hash/report the complete envelope.
  void rawInput
  return {
    document,
    report: createCompatibilityReport(config.id, config.label, config.version, issues),
  }
}

/** 读取某 adapter 命名空间下按 fields/extensions 分组的未知字段（导出底稿）。 */
export function foreignSection(
  foreign: Record<string, JsonValue> | undefined,
  adapterId: string,
): { fields: Record<string, JsonValue>; extensions: Record<string, JsonValue> } {
  const namespace = foreign?.[adapterId]
  const payload = isRecord(namespace) && isRecord(namespace.payload) ? namespace.payload : namespace
  return {
    fields: isRecord(payload) && isRecord(payload.fields) ? payload.fields as Record<string, JsonValue> : {},
    extensions: isRecord(payload) && isRecord(payload.extensions) ? payload.extensions as Record<string, JsonValue> : {},
  }
}

export function wrapperForeign(document: CanonicalLorebookDocumentV2, adapterId: string): Record<string, JsonValue> {
  const namespace = document.foreign?.[adapterId]
  return isRecord(namespace) && isRecord(namespace.wrapper)
    ? namespace.wrapper as Record<string, JsonValue>
    : {}
}

function roleNumber(role: LoreEntry['role']): number | undefined {
  if (role === 'system') return 0
  if (role === 'user') return 1
  if (role === 'assistant') return 2
  return undefined
}

function insertionPosition(insertion: LorebookInsertionV2): { position: unknown; extension?: UnknownRecord } {
  if (insertion.kind === 'chat') {
    return { position: 4, extension: { depth: insertion.depth, ...(insertion.role ? { role: roleNumber(insertion.role) } : {}) } }
  }
  if (insertion.kind === 'outlet') return { position: 7, extension: { outlet_name: insertion.name } }
  if (insertion.kind === 'custom') return { position: insertion.value }
  const positions: Record<string, unknown> = {
    before_character: 0,
    after_character: 1,
    authors_note_top: 2,
    authors_note_bottom: 3,
    before_examples: 5,
    after_examples: 6,
    prompt_end: 'at_end',
  }
  return { position: positions[insertion.anchor] }
}

function externalEntry(
  entry: CanonicalLoreEntryV2,
  config: ExternalAdapterConfig,
): UnknownRecord {
  const stored = foreignSection(entry.foreign, config.id)
  const insertion = insertionPosition(entry.insertion)
  const vectorized = entry.activation.retrieval !== 'keyword'
  if (config.style === 'sillytavern') {
    return {
      ...stored.fields,
      uid: entry.sourceId ?? entry.id,
      key: [...entry.activation.primaryKeys, ...entry.activation.aliases],
      keysecondary: [...entry.activation.secondaryKeys],
      selective: entry.activation.secondaryKeys.length > 0,
      ...(entry.activation.secondaryLogic ? { selectiveLogic: entry.activation.secondaryLogic } : {}),
      content: entry.content,
      position: insertion.position,
      ...(insertion.extension ?? {}),
      order: entry.scheduling.order,
      probability: entry.scheduling.probability,
      useProbability: entry.scheduling.probability !== 100,
      disable: !entry.enabled,
      constant: entry.activation.mode === 'constant',
      vectorized,
      caseSensitive: entry.activation.caseSensitive,
      matchWholeWords: entry.activation.wholeWords,
      excludeRecursion: entry.scheduling.recursion.exclude,
      preventRecursion: entry.scheduling.recursion.prevent,
      ...(entry.scheduling.recursion.minDepth > 0 ? { delayUntilRecursion: entry.scheduling.recursion.minDepth } : {}),
      ...(entry.scheduling.scanDepth !== undefined ? { scanDepth: entry.scheduling.scanDepth } : {}),
      ...(entry.scheduling.groups.length > 0 ? { group: entry.scheduling.groups.map((group) => group.name).join(', ') } : {}),
      ...(entry.scheduling.groups[0]?.prioritized ? { groupOverride: true } : {}),
      ...(entry.scheduling.groups[0] ? { groupWeight: entry.scheduling.groups[0].weight } : {}),
      useGroupScoring: entry.scheduling.groupScoring,
      ...(entry.scheduling.characterFilter ? { characterFilter: {
        isExclude: entry.scheduling.characterFilter.exclude,
        names: [...entry.scheduling.characterFilter.names],
        tags: [...entry.scheduling.characterFilter.tags],
      } } : {}),
      ...(entry.scheduling.generationTriggers ? { triggers: [...entry.scheduling.generationTriggers] } : {}),
      ...(entry.scheduling.sticky !== undefined ? { sticky: entry.scheduling.sticky } : {}),
      ...(entry.scheduling.cooldown !== undefined ? { cooldown: entry.scheduling.cooldown } : {}),
      ...(entry.scheduling.delay !== undefined ? { delay: entry.scheduling.delay } : {}),
      ...(Object.keys(stored.extensions).length > 0 ? { extensions: stored.extensions } : {}),
    }
  }

  const richExtensions: UnknownRecord = {
    ...stored.extensions,
    ...(insertion.position !== 0 && insertion.position !== 1 ? { position: insertion.position } : {}),
    ...(insertion.extension ?? {}),
    probability: entry.scheduling.probability,
    use_probability: entry.scheduling.probability !== 100,
    vectorized,
    selective: entry.activation.secondaryKeys.length > 0,
    ...(entry.activation.secondaryLogic ? { selective_logic: entry.activation.secondaryLogic } : {}),
    case_sensitive: entry.activation.caseSensitive,
    match_whole_words: entry.activation.wholeWords,
    exclude_recursion: entry.scheduling.recursion.exclude,
    prevent_recursion: entry.scheduling.recursion.prevent,
    ignore_budget: entry.scheduling.ignoreBudget,
    ...(entry.scheduling.scanDepth !== undefined ? { scan_depth: entry.scheduling.scanDepth } : {}),
    ...(entry.scheduling.recursion.minDepth > 0 ? { delay_until_recursion: entry.scheduling.recursion.minDepth } : {}),
    ...(entry.scheduling.groups.length > 0 ? { group: entry.scheduling.groups.map((group) => group.name).join(', ') } : {}),
    ...(entry.scheduling.groups[0]?.prioritized ? { group_override: true } : {}),
    ...(entry.scheduling.groups[0] ? { group_weight: entry.scheduling.groups[0].weight } : {}),
    use_group_scoring: entry.scheduling.groupScoring,
    ...(entry.scheduling.characterFilter ? { character_filter: {
      isExclude: entry.scheduling.characterFilter.exclude,
      names: [...entry.scheduling.characterFilter.names],
      tags: [...entry.scheduling.characterFilter.tags],
    } } : {}),
    ...(entry.scheduling.generationTriggers ? { triggers: [...entry.scheduling.generationTriggers] } : {}),
    ...(entry.scheduling.sticky !== undefined ? { sticky: entry.scheduling.sticky } : {}),
    ...(entry.scheduling.cooldown !== undefined ? { cooldown: entry.scheduling.cooldown } : {}),
    ...(entry.scheduling.delay !== undefined ? { delay: entry.scheduling.delay } : {}),
  }
  return {
    ...stored.fields,
    id: entry.sourceId ?? entry.id,
    keys: [...entry.activation.primaryKeys, ...entry.activation.aliases],
    secondary_keys: [...entry.activation.secondaryKeys],
    content: entry.content,
    enabled: entry.enabled,
    insertion_order: entry.scheduling.order,
    position: insertion.position === 1 ? 'after_char' : 'before_char',
    constant: entry.activation.mode === 'constant',
    use_regex: entry.activation.regex.enabled,
    ...(Object.keys(richExtensions).length > 0 ? { extensions: richExtensions } : {}),
  }
}

export function exportExternalLorebook(
  document: CanonicalLorebookDocumentV2,
  config: ExternalAdapterConfig,
): LorebookAdapterExportResult {
  const stored = foreignSection(document.foreign, config.id)
  const entries = document.entries.map((entry) => externalEntry(entry, config))
  const value: UnknownRecord = {
    ...stored.fields,
    name: document.name,
    description: document.description,
    scan_depth: document.defaults.scanDepth,
    recursive_scanning: document.defaults.recursiveScanning,
    ...(document.defaults.tokenBudget !== undefined ? { token_budget: document.defaults.tokenBudget } : {}),
    ...(Object.keys(stored.extensions).length > 0 ? { extensions: stored.extensions } : {}),
    entries: config.style === 'sillytavern'
      ? Object.fromEntries(entries.map((entry, index) => [String(document.entries[index].sourceId ?? index), entry]))
      : entries,
  }
  const preservedCount = Object.keys(stored.fields).length + Object.keys(stored.extensions).length
    + document.entries.reduce((count, entry) => {
      const section = foreignSection(entry.foreign, config.id)
      return count + Object.keys(section.fields).length + Object.keys(section.extensions).length
    }, 0)
  const issues = preservedCount > 0
    ? [compatibilityIssue('info', 'preserved', 'foreign_exported', '$', `${preservedCount} 个未知字段已合并回导出格式`)]
    : []
  return {
    value: value as JsonValue,
    report: createCompatibilityReport(config.id, config.label, config.version, issues),
  }
}

export function collectWrapperExtras(
  raw: UnknownRecord,
  known: Set<string>,
  issues: LorebookCompatibilityIssue[],
): Record<string, JsonValue> {
  return collectExtras(raw, known, '$', issues)
}
