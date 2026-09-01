import type { LorebookFormatAdapter } from '../../../shared/lorebook/adapters/types'
import type { CanonicalLoreEntryV2, JsonValue } from '../../../shared/lorebook/domain/v2'
import { compatibilityIssue, createCompatibilityReport } from './report'
import { consumedKeys, foreignSection, importExternalLorebook, isRecord } from './common'

const CONFIG = {
  id: 'novelai.lorebook',
  label: 'NovelAI Lorebook',
  version: '4',
  sourceKind: 'character_book' as const,
  style: 'character_book' as const,
}

/** NovelAI 条目中被本 adapter 消费的字段（在 ENTRY_KEYS 之外）；其余（searchRange、category 等）原样保留。 */
const CONSUMED_ENTRY_KEYS = consumedKeys(['text', 'secondKey', 'forceActivation', 'useRegExp'])

const WRAPPER_KEYS = new Set(['entries'])

interface NovelAiEntry {
  text?: string
  keys?: string[]
  secondKey?: string
  displayName?: string
  comment?: string
  enabled?: boolean
  forceActivation?: boolean
  vectorized?: boolean
  caseSensitive?: boolean
  priority?: number
  id?: string | number
  useProbability?: boolean
  probability?: number
  useRegExp?: boolean
  [extra: string]: unknown
}

/** NovelAI 条目 → 归一化器可读的载荷字段；原始字段保留在对象上以便进入 foreign 保留区。 */
function toPayloadEntry(entry: NovelAiEntry): Record<string, unknown> {
  return {
    ...entry,
    content: entry.text,
    keysecondary: entry.secondKey,
    constant: entry.forceActivation === true,
    insertion_order: entry.priority ?? 0,
    useRegex: typeof entry.useRegExp === 'boolean' ? entry.useRegExp : undefined,
  }
}

function wrapperExtras(input: Record<string, unknown>): Record<string, JsonValue> {
  const wrapper: Record<string, JsonValue> = {}
  for (const [key, value] of Object.entries(input)) {
    if (WRAPPER_KEYS.has(key)) continue
    if (value === null || typeof value !== 'object' || isRecord(value) || Array.isArray(value)) {
      wrapper[key] = value as JsonValue
    }
  }
  return wrapper
}

export const novelAiLorebookAdapter: LorebookFormatAdapter = {
  id: CONFIG.id,
  label: CONFIG.label,
  formatVersion: CONFIG.version,
  priority: 50,

  detect(input) {
    if (!isRecord(input)) {
      return { adapterId: CONFIG.id, formatLabel: CONFIG.label, formatVersion: CONFIG.version, confidence: 0, reasons: [], conflicts: [] }
    }
    if (typeof input.lorebookVersion === 'number' && 'entries' in input) {
      return {
        adapterId: CONFIG.id, formatLabel: CONFIG.label, formatVersion: CONFIG.version,
        confidence: Array.isArray(input.entries) ? 98 : 90,
        reasons: ['顶层 lorebookVersion 是 NovelAI Lorebook 的版本标记'], conflicts: [],
      }
    }
    const entries = Array.isArray(input.entries) ? input.entries.filter(isRecord) : []
    if (entries.some((entry) => 'text' in entry && 'forceActivation' in entry)) {
      return {
        adapterId: CONFIG.id, formatLabel: CONFIG.label, formatVersion: CONFIG.version, confidence: 80,
        reasons: ['条目包含 NovelAI 特有的 text/forceActivation 字段'], conflicts: [],
      }
    }
    return { adapterId: CONFIG.id, formatLabel: CONFIG.label, formatVersion: CONFIG.version, confidence: 0, reasons: [], conflicts: [] }
  },

  import(input, context) {
    if (!isRecord(input)) throw new Error('NovelAI Lorebook 顶层必须是对象')
    // 不做预过滤：非对象条目交给统一导入器计数并生成结构化拒绝报告
    const rawEntries = Array.isArray(input.entries) ? input.entries : []
    const wrapper = wrapperExtras(input)
    const result = importExternalLorebook(
      input,
      { entries: rawEntries.map((entry) => isRecord(entry) ? toPayloadEntry(entry as NovelAiEntry) : entry) },
      context,
      { ...CONFIG, consumedEntryKeys: CONSUMED_ENTRY_KEYS },
      Object.keys(wrapper).length > 0 ? wrapper : undefined,
    )
    const version = input.lorebookVersion
    if (typeof version === 'number' && version !== 4) {
      result.report = createCompatibilityReport(CONFIG.id, CONFIG.label, CONFIG.version, [
        ...result.report.issues,
        compatibilityIssue('warning', 'mapped', 'novelai_version_mismatch', '$.lorebookVersion',
          `NovelAI lorebookVersion=${version} 未在本适配器验证范围内（4），按 v4 字段尽力导入`),
      ])
    }
    return result
  },

  export(document) {
    const storedBook = foreignSection(document.foreign, CONFIG.id)
    const wrapperNamespace = document.foreign?.[CONFIG.id]
    const wrapper = isRecord(wrapperNamespace) && isRecord(wrapperNamespace.wrapper)
      ? wrapperNamespace.wrapper as Record<string, JsonValue>
      : {}
    const preservedCount = Object.keys(storedBook.fields).length + Object.keys(storedBook.extensions).length
      + document.entries.reduce((count, entry) => {
        const section = foreignSection(entry.foreign, CONFIG.id)
        return count + Object.keys(section.fields).length + Object.keys(section.extensions).length
      }, 0)
    const approximated = document.entries.filter((entry) => entry.insertion.kind !== 'prompt' || entry.insertion.anchor !== 'prompt_end').length
    const issues = [
      ...(preservedCount > 0 ? [compatibilityIssue('info', 'preserved', 'foreign_exported', '$', `${preservedCount} 个未知字段已合并回导出格式`)] : []),
      ...(approximated > 0 ? [compatibilityIssue(
        'warning', 'approximated', 'novelai_insertion_unsupported', '$.entries',
        `NovelAI Lorebook 通过记忆区插入正文，没有条目级提示词位置；${approximated} 个条目的位置设置无法表达，已省略`,
      )] : []),
    ]
    const value = {
      ...storedBook.fields,
      ...wrapper,
      lorebookVersion: typeof wrapper.lorebookVersion === 'number' ? wrapper.lorebookVersion : 4,
      entries: document.entries.map((entry) => novelAiExportEntry(entry)),
    }
    return { value: value as JsonValue, report: createCompatibilityReport(CONFIG.id, CONFIG.label, CONFIG.version, issues) }
  },
}

function novelAiExportEntry(entry: CanonicalLoreEntryV2): Record<string, unknown> {
  const stored = foreignSection(entry.foreign, CONFIG.id)
  // 由 canonical 重建的字段拥有最高优先级；其余未知字段作为底稿保留
  const rebuilt = new Set(['id', 'text', 'keys', 'secondKey', 'comment', 'enabled', 'forceActivation', 'vectorized', 'caseSensitive', 'useProbability', 'probability', 'priority', 'useRegExp'])
  const passthrough = Object.fromEntries(Object.entries(stored.fields).filter(([key]) => !rebuilt.has(key)))
  return {
    ...passthrough,
    ...(entry.sourceId !== undefined ? { id: entry.sourceId } : {}),
    text: entry.content,
    keys: [...entry.activation.primaryKeys, ...entry.activation.aliases],
    secondKey: entry.activation.secondaryKeys.join(', '),
    comment: entry.title ?? '',
    enabled: entry.enabled,
    forceActivation: entry.activation.mode === 'constant',
    vectorized: entry.activation.retrieval !== 'keyword',
    caseSensitive: entry.activation.caseSensitive,
    useProbability: entry.scheduling.probability !== 100,
    probability: entry.scheduling.probability,
    priority: entry.scheduling.order,
    useRegExp: entry.activation.regex.enabled,
  }
}
