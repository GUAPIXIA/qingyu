import type { Lorebook, LoreEntry } from '../../types'
import type {
  CanonicalLoreEntryV2,
  CanonicalLorebookDocumentV2,
  LorebookInsertionV2,
} from '../domain/v2'

function compileInsertion(insertion: LorebookInsertionV2): Pick<LoreEntry, 'position' | 'depth' | 'role'> {
  if (insertion.kind === 'chat') {
    return {
      position: 'at_depth',
      depth: Math.max(0, Math.floor(insertion.depth)),
      ...(insertion.role ? { role: insertion.role } : {}),
    }
  }
  if (insertion.kind === 'prompt' && insertion.anchor === 'before_character') {
    return { position: 'before_char' }
  }
  if (insertion.kind === 'prompt' && insertion.anchor === 'after_character') {
    return { position: 'after_char' }
  }
  return { position: 'at_end' }
}

/**
 * 从 native-v1 foreign 命名空间还原 AI 扩词来源记录（阶段4 enrichment 管线）。
 * 只信任结构合法的条目，其余静默丢弃——provenance 是追溯注记，损坏不致命。
 */
function compileKeywordProvenance(entry: CanonicalLoreEntryV2): LoreEntry['keywordProvenance'] {
  const foreign = entry.foreign?.['qingyu.native-v1']
  if (!foreign || typeof foreign !== 'object' || Array.isArray(foreign)) return undefined
  const raw = (foreign as Record<string, unknown>).keywordProvenance
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const result: NonNullable<LoreEntry['keywordProvenance']> = {}
  for (const [keyword, meta] of Object.entries(raw as Record<string, unknown>)) {
    if (keyword === '__proto__' || keyword === 'constructor' || keyword === 'prototype') continue
    if (!keyword || !meta || typeof meta !== 'object' || Array.isArray(meta)) continue
    const record = meta as Record<string, unknown>
    if (typeof record.provider !== 'string' || typeof record.model !== 'string') continue
    if (typeof record.generatedAt !== 'number' || !Number.isFinite(record.generatedAt)) continue
    result[keyword] = {
      provider: record.provider,
      model: record.model,
      generatedAt: record.generatedAt,
      mode: record.mode === 'enrich' ? 'enrich' : 'localize',
    }
  }
  return Object.keys(result).length > 0 ? result : undefined
}

function compileEntry(entry: CanonicalLoreEntryV2): LoreEntry {
  const firstGroup = entry.scheduling.groups[0]
  const keywordProvenance = compileKeywordProvenance(entry)
  const matchMode: LoreEntry['matchMode'] = entry.activation.retrieval === 'keyword'
    ? 'keyword'
    : entry.activation.retrieval === 'hybrid'
      ? 'both'
      : 'semantic'
  const priority: LoreEntry['priority'] = entry.activation.mode === 'constant'
    ? 'always'
    : entry.activation.budgetTier === 'supplemental'
      ? 'detail'
      : 'conditional'

  return {
    id: entry.id,
    keywords: [...entry.activation.primaryKeys, ...entry.activation.aliases],
    content: entry.content,
    ...compileInsertion(entry.insertion),
    order: entry.scheduling.order,
    probability: entry.scheduling.probability,
    enabled: entry.enabled,
    useRegex: entry.activation.regex.enabled,
    regexFlags: entry.activation.regex.flags,
    ...(entry.activation.secondaryKeys.length > 0 ? { secondaryKeywords: [...entry.activation.secondaryKeys] } : {}),
    ...(entry.activation.secondaryLogic ? { selectiveLogic: entry.activation.secondaryLogic } : {}),
    caseSensitive: entry.activation.caseSensitive,
    matchWholeWords: entry.activation.wholeWords,
    excludeRecursion: entry.scheduling.recursion.exclude,
    preventRecursion: entry.scheduling.recursion.prevent,
    ...(entry.scheduling.scanDepth !== undefined ? { scanDepth: entry.scheduling.scanDepth } : {}),
    ...(entry.scheduling.recursion.minDepth > 0 ? { delayUntilRecursion: entry.scheduling.recursion.minDepth } : {}),
    ...(entry.scheduling.groups.length > 0 ? { inclusionGroups: entry.scheduling.groups.map((group) => group.name) } : {}),
    ...(firstGroup?.prioritized ? { inclusionGroupPrioritized: true } : {}),
    ...(firstGroup ? { inclusionGroupWeight: firstGroup.weight } : {}),
    useGroupScoring: entry.scheduling.groupScoring,
    ...(entry.scheduling.characterFilter ? { characterFilter: {
      exclude: entry.scheduling.characterFilter.exclude,
      names: [...entry.scheduling.characterFilter.names],
      tags: [...entry.scheduling.characterFilter.tags],
    } } : {}),
    ...(entry.scheduling.generationTriggers
      ? { generationTriggers: [...entry.scheduling.generationTriggers] }
      : {}),
    ...(entry.scheduling.sticky !== undefined ? { sticky: entry.scheduling.sticky } : {}),
    ...(entry.scheduling.cooldown !== undefined ? { cooldown: entry.scheduling.cooldown } : {}),
    ...(entry.scheduling.delay !== undefined ? { delay: entry.scheduling.delay } : {}),
    ignoreBudget: entry.scheduling.ignoreBudget,
    matchMode,
    priority,
    ...(entry.summary !== undefined ? { summary: entry.summary } : {}),
    ...(entry.translation !== undefined ? { translation: entry.translation } : {}),
    ...(keywordProvenance !== undefined ? { keywordProvenance } : {}),
  }
}

/** canonical v2 → 当前 UI/触发器使用的兼容 Lorebook 视图。 */
export function compileCanonicalLorebookV2(document: CanonicalLorebookDocumentV2): Lorebook {
  return {
    id: document.id,
    name: document.name,
    description: document.description,
    enabled: document.enabled,
    scanDepth: document.defaults.scanDepth,
    recursiveScanning: document.defaults.recursiveScanning,
    ...(document.defaults.tokenBudget !== undefined ? { tokenBudget: document.defaults.tokenBudget } : {}),
    entries: document.entries.map((entry) => ({
      ...compileEntry(entry),
      runtime: {
        insertion: entry.insertion,
        retrieval: entry.activation.retrieval,
        ...(document.source?.adapterId ? { adapterId: document.source.adapterId } : {}),
        ...(entry.title ? { title: entry.title } : {}),
      },
    })),
    runtime: {
      schemaVersion: document.schemaVersion,
      revision: document.revision,
      ...(document.source?.adapterId ? { adapterId: document.source.adapterId } : {}),
      ...(document.source?.formatVersion ? { formatVersion: document.source.formatVersion } : {}),
    },
  }
}
