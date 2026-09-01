import type { LorebookFormatAdapter } from '../../../shared/lorebook/adapters/types'
import type { CanonicalLoreEntryV2, JsonValue } from '../../../shared/lorebook/domain/v2'
import { compatibilityIssue, createCompatibilityReport } from './report'
import { consumedKeys, foreignSection, importExternalLorebook, isRecord } from './common'

const CONFIG = {
  id: 'agnai.memory-book',
  label: 'Agnai Memory Book',
  version: '1',
  sourceKind: 'character_book' as const,
  style: 'character_book' as const,
}

/** Agnai 条目中被本 adapter 消费的字段（在 ENTRY_KEYS 之外）；其余原样保留。 */
const CONSUMED_ENTRY_KEYS = consumedKeys(['entry'])

interface AgnaiEntry {
  name?: string
  entry?: string
  keywords?: string[]
  priority?: number
  enabled?: boolean
  id?: string | number
  [extra: string]: unknown
}

/** Agnai 条目 → 归一化器可读的载荷字段；原始字段保留在对象上以便进入 foreign 保留区。 */
function toPayloadEntry(entry: AgnaiEntry): Record<string, unknown> {
  return {
    ...entry,
    comment: entry.name,
    content: entry.entry,
    insertion_order: entry.priority ?? 0,
  }
}

export const agnaiMemoryBookAdapter: LorebookFormatAdapter = {
  id: CONFIG.id,
  label: CONFIG.label,
  formatVersion: CONFIG.version,
  priority: 50,

  detect(input) {
    if (!isRecord(input) || !Array.isArray(input.entries)) {
      return { adapterId: CONFIG.id, formatLabel: CONFIG.label, formatVersion: CONFIG.version, confidence: 0, reasons: [], conflicts: [] }
    }
    const entries = input.entries.filter(isRecord)
    // Agnai 记忆书条目的特征组合：name（标题）+ entry（正文）+ keywords（关键词数组）
    const agnaiEntries = entries.filter((entry) => typeof entry.entry === 'string' && Array.isArray(entry.keywords))
    if (agnaiEntries.length === 0) {
      return { adapterId: CONFIG.id, formatLabel: CONFIG.label, formatVersion: CONFIG.version, confidence: 0, reasons: [], conflicts: [] }
    }
    const hasNovelAiFields = entries.some((entry) => 'text' in entry || 'forceActivation' in entry)
    return {
      adapterId: CONFIG.id,
      formatLabel: CONFIG.label,
      formatVersion: CONFIG.version,
      confidence: Math.min(100, 88 + (typeof input.name === 'string' ? 4 : 0) - (hasNovelAiFields ? 40 : 0)),
      reasons: [`${agnaiEntries.length} 个条目使用 Agnai 的 name/entry/keywords 组合`],
      conflicts: hasNovelAiFields ? ['同时检测到 NovelAI 的 text/forceActivation 字段'] : [],
    }
  },

  import(input, context) {
    if (!isRecord(input)) throw new Error('Agnai Memory Book 顶层必须是对象')
    // 载荷保留书级字段（name/description）并原样透传非对象条目，让统一导入器生成拒绝报告
    const rawEntries = Array.isArray(input.entries) ? input.entries : []
    const payload: Record<string, unknown> = { ...input, entries: rawEntries.map((entry) => isRecord(entry) ? toPayloadEntry(entry as AgnaiEntry) : entry) }
    return importExternalLorebook(
      input,
      payload,
      context,
      { ...CONFIG, consumedEntryKeys: CONSUMED_ENTRY_KEYS },
    )
  },

  export(document) {
    const storedBook = foreignSection(document.foreign, CONFIG.id)
    const preservedCount = Object.keys(storedBook.fields).length + Object.keys(storedBook.extensions).length
      + document.entries.reduce((count, entry) => {
        const section = foreignSection(entry.foreign, CONFIG.id)
        return count + Object.keys(section.fields).length + Object.keys(section.extensions).length
      }, 0)
    const approximated = document.entries.filter((entry) => entry.insertion.kind !== 'prompt' || entry.insertion.anchor !== 'prompt_end').length
    const constantCount = document.entries.filter((entry) => entry.activation.mode === 'constant').length
    const issues = [
      ...(preservedCount > 0 ? [compatibilityIssue('info', 'preserved', 'foreign_exported', '$', `${preservedCount} 个未知字段已合并回导出格式`)] : []),
      ...(approximated > 0 ? [compatibilityIssue(
        'warning', 'approximated', 'agnai_insertion_unsupported', '$.entries',
        `Agnai Memory Book 通过记忆区插入正文，没有条目级提示词位置；${approximated} 个条目的位置设置无法表达，已省略`,
      )] : []),
      ...(constantCount > 0 ? [compatibilityIssue(
        'warning', 'approximated', 'agnai_constant_unsupported', '$.entries',
        `Agnai Memory Book 条目没有常驻字段；${constantCount} 个常驻条目导出后将按关键词触发`,
      )] : []),
    ]
    const value = {
      ...storedBook.fields,
      name: document.name,
      description: document.description,
      entries: document.entries.map((entry) => agnaiExportEntry(entry)),
    }
    return { value: value as JsonValue, report: createCompatibilityReport(CONFIG.id, CONFIG.label, CONFIG.version, issues) }
  },
}

function agnaiExportEntry(entry: CanonicalLoreEntryV2): Record<string, unknown> {
  const stored = foreignSection(entry.foreign, CONFIG.id)
  // 由 canonical 重建的字段拥有最高优先级；其余未知字段作为底稿保留
  const rebuilt = new Set(['id', 'name', 'entry', 'keywords', 'priority', 'enabled'])
  const passthrough = Object.fromEntries(Object.entries(stored.fields).filter(([key]) => !rebuilt.has(key)))
  return {
    ...passthrough,
    ...(entry.sourceId !== undefined ? { id: entry.sourceId } : {}),
    name: entry.title ?? '',
    entry: entry.content,
    keywords: [...entry.activation.primaryKeys, ...entry.activation.aliases],
    priority: entry.scheduling.order,
    enabled: entry.enabled,
  }
}
