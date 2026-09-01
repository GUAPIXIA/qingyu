import type { Lorebook, LoreEntry } from '../../types'
import {
  CANONICAL_LOREBOOK_SCHEMA,
  CANONICAL_LOREBOOK_VERSION,
  type CanonicalLoreEntryV2,
  type CanonicalLorebookDocumentV2,
  type JsonValue,
  type LorebookInsertionV2,
  type LorebookRetrievalMode,
} from '../domain/v2'

export interface MigrateNativeV1Options {
  now: number
  contentHash: string
  revision?: number
}

const BOOK_KEYS = new Set([
  'id', 'name', 'description', 'entries', 'enabled', 'scanDepth', 'recursiveScanning', 'tokenBudget', 'schemaVersion',
  'runtime',
])
const ENTRY_KEYS = new Set([
  'id', 'keywords', 'content', 'position', 'depth', 'role', 'order', 'probability', 'enabled',
  'useRegex', 'regexFlags', 'secondaryKeywords', 'selectiveLogic', 'caseSensitive', 'matchWholeWords',
  'excludeRecursion', 'preventRecursion', 'scanDepth', 'delayUntilRecursion', 'inclusionGroups',
  'inclusionGroupPrioritized', 'inclusionGroupWeight', 'useGroupScoring', 'characterFilter',
  'generationTriggers', 'sticky', 'cooldown', 'delay', 'ignoreBudget', 'matchMode', 'translation',
  'priority', 'summary', 'runtime',
])

function jsonValue(value: unknown): JsonValue | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (Array.isArray(value)) {
    const result: JsonValue[] = []
    for (const item of value) {
      const converted = jsonValue(item)
      if (converted !== undefined) result.push(converted)
    }
    return result
  }
  if (typeof value === 'object' && value !== null) {
    const result: Record<string, JsonValue> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const converted = jsonValue(item)
      if (converted !== undefined) result[key] = converted
    }
    return result
  }
  return undefined
}

function collectForeign(value: object, known: Set<string>, namespace: string): Record<string, JsonValue> | undefined {
  const extras: Record<string, JsonValue> = {}
  for (const [key, item] of Object.entries(value)) {
    if (known.has(key)) continue
    const converted = jsonValue(item)
    if (converted !== undefined) extras[key] = converted
  }
  return Object.keys(extras).length > 0 ? { [namespace]: extras } : undefined
}

function retrievalFromLegacy(value: LoreEntry['matchMode']): LorebookRetrievalMode {
  if (value === 'keyword') return 'keyword'
  if (value === 'semantic') return 'semanticPreferred'
  return 'hybrid'
}

function runtimeInsertion(entry: LoreEntry): LorebookInsertionV2 | undefined {
  const insertion = entry.runtime?.insertion
  if (!insertion || typeof insertion !== 'object') return undefined
  if (insertion.kind === 'chat') {
    if (typeof insertion.depth !== 'number' || !Number.isFinite(insertion.depth)) return undefined
    if (insertion.role !== undefined && !['system', 'user', 'assistant'].includes(insertion.role)) return undefined
    return {
      kind: 'chat',
      depth: Math.max(0, Math.floor(insertion.depth)),
      ...(insertion.role ? { role: insertion.role } : {}),
    }
  }
  if (insertion.kind === 'prompt') {
    const anchors = [
      'before_character', 'after_character', 'before_examples', 'after_examples',
      'authors_note_top', 'authors_note_bottom', 'prompt_end',
    ]
    return anchors.includes(insertion.anchor) ? insertion : undefined
  }
  if (insertion.kind === 'outlet' && typeof insertion.name === 'string') return insertion
  if (insertion.kind === 'custom' && typeof insertion.source === 'string') {
    const value = jsonValue(insertion.value)
    return value !== undefined ? { kind: 'custom', source: insertion.source, value } : undefined
  }
  return undefined
}

function runtimeRetrieval(entry: LoreEntry): LorebookRetrievalMode {
  const value = entry.runtime?.retrieval
  return value && ['keyword', 'semanticPreferred', 'semanticRequired', 'hybrid'].includes(value)
    ? value
    : retrievalFromLegacy(entry.matchMode)
}

function insertionFromLegacy(entry: LoreEntry): LorebookInsertionV2 {
  const runtime = runtimeInsertion(entry)
  if (runtime) return runtime
  if (entry.position === 'before_char') return { kind: 'prompt', anchor: 'before_character' }
  if (entry.position === 'after_char') return { kind: 'prompt', anchor: 'after_character' }
  if (entry.position === 'at_depth') {
    return {
      kind: 'chat',
      depth: Math.max(0, Math.floor(entry.depth ?? 0)),
      ...(entry.role ? { role: entry.role } : {}),
    }
  }
  return { kind: 'prompt', anchor: 'prompt_end' }
}

function entryFromLegacy(entry: LoreEntry): CanonicalLoreEntryV2 {
  const constant = entry.priority === 'always'
  const budgetTier = entry.priority === 'always'
    ? 'protected' as const
    : entry.priority === 'detail'
      ? 'supplemental' as const
      : 'standard' as const
  const recursionDepth = entry.delayUntilRecursion === true
    ? 1
    : typeof entry.delayUntilRecursion === 'number'
      ? Math.max(1, Math.floor(entry.delayUntilRecursion))
      : 0
  const groupWeight = Math.max(0, entry.inclusionGroupWeight ?? 100)
  const groupPrioritized = entry.inclusionGroupPrioritized === true

  return {
    id: entry.id,
    sourceId: entry.id,
    enabled: entry.enabled,
    content: entry.content,
    ...(entry.summary !== undefined ? { summary: entry.summary } : {}),
    ...(entry.translation !== undefined ? { translation: entry.translation } : {}),
    activation: {
      mode: constant ? 'constant' : 'conditional',
      budgetTier,
      primaryKeys: [...entry.keywords],
      secondaryKeys: [...(entry.secondaryKeywords ?? [])],
      aliases: [],
      keyLogic: 'any',
      ...(entry.selectiveLogic ? { secondaryLogic: entry.selectiveLogic } : {}),
      caseSensitive: entry.caseSensitive === true,
      wholeWords: entry.matchWholeWords !== false,
      regex: { enabled: entry.useRegex === true, flags: entry.regexFlags ?? 'i' },
      retrieval: runtimeRetrieval(entry),
    },
    insertion: insertionFromLegacy(entry),
    scheduling: {
      order: entry.order,
      probability: entry.probability,
      ...(entry.scanDepth !== undefined ? { scanDepth: entry.scanDepth } : {}),
      recursion: {
        exclude: entry.excludeRecursion === true,
        prevent: entry.preventRecursion === true,
        minDepth: recursionDepth,
      },
      groups: (entry.inclusionGroups ?? []).map((name) => ({
        name,
        weight: groupWeight,
        prioritized: groupPrioritized,
      })),
      groupScoring: entry.useGroupScoring === true,
      ...(entry.sticky !== undefined ? { sticky: entry.sticky } : {}),
      ...(entry.cooldown !== undefined ? { cooldown: entry.cooldown } : {}),
      ...(entry.delay !== undefined ? { delay: entry.delay } : {}),
      ignoreBudget: entry.ignoreBudget === true,
      ...(entry.characterFilter ? { characterFilter: {
        exclude: entry.characterFilter.exclude,
        names: [...entry.characterFilter.names],
        tags: [...entry.characterFilter.tags],
      } } : {}),
      ...(entry.generationTriggers ? { generationTriggers: [...entry.generationTriggers] } : {}),
    },
    foreign: collectForeign(entry, ENTRY_KEYS, 'qingyu.native-v1'),
  }
}

export function migrateNativeLorebookV1ToV2(
  lorebook: Lorebook,
  options: MigrateNativeV1Options,
): CanonicalLorebookDocumentV2 {
  const seenIds = new Set<string>()
  const entries = lorebook.entries.map(entryFromLegacy).map((entry) => {
    // 方案 §13.1 契约：重复 source ID 不得产生冲突条目 ID；对同一输入确定性去重
    if (!seenIds.has(entry.id)) {
      seenIds.add(entry.id)
      return entry
    }
    let suffix = 2
    while (seenIds.has(`${entry.id}-${suffix}`)) suffix += 1
    const deduped = { ...entry, id: `${entry.id}-${suffix}` }
    seenIds.add(deduped.id)
    return deduped
  })
  return {
    schema: CANONICAL_LOREBOOK_SCHEMA,
    schemaVersion: CANONICAL_LOREBOOK_VERSION,
    id: lorebook.id,
    revision: Math.max(1, Math.floor(options.revision ?? 1)),
    name: lorebook.name,
    description: lorebook.description,
    enabled: lorebook.enabled,
    defaults: {
      scanDepth: lorebook.scanDepth,
      recursiveScanning: lorebook.recursiveScanning !== false,
      ...(lorebook.tokenBudget !== undefined ? { tokenBudget: lorebook.tokenBudget } : {}),
    },
    entries,
    source: {
      adapterId: 'qingyu.native-v1',
      formatVersion: '1',
      originalName: lorebook.name,
      importedAt: options.now,
      contentHash: options.contentHash,
    },
    foreign: collectForeign(lorebook, BOOK_KEYS, 'qingyu.native-v1'),
    createdAt: options.now,
    updatedAt: options.now,
  }
}
