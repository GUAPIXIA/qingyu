import type { LorebookFormatAdapter } from '../../../shared/lorebook/adapters/types'
import type { CanonicalLoreEntryV2, JsonValue } from '../../../shared/lorebook/domain/v2'
import { compatibilityIssue, createCompatibilityReport } from './report'
import { consumedKeys, foreignSection, importExternalLorebook, isRecord } from './common'

const CONFIG = {
  id: 'risu.lorebook',
  label: 'Risu Lorebook',
  version: '1',
  sourceKind: 'sillytavern' as const,
  style: 'sillytavern' as const,
}

/**
 * Risu 条目中被本 adapter 消费的字段（在 ENTRY_KEYS 之外）。
 * extentions 整体不标为已消费：其中除 risu_case_sensitive 外的字段仍需原样保留。
 */
const CONSUMED_ENTRY_KEYS = consumedKeys(['secondkey', 'insertorder', 'mode', 'alwaysActive', 'activationPercent'])

const WRAPPER_KEYS = new Set(['type', 'ver', 'data'])

interface RisuEntry {
  key?: string
  secondkey?: string
  insertorder?: number
  comment?: string
  content?: string
  mode?: 'multiple' | 'constant' | 'normal' | 'child' | 'folder'
  alwaysActive?: boolean
  selective?: boolean
  activationPercent?: number
  useRegex?: boolean
  extentions?: { risu_case_sensitive?: boolean } & Record<string, unknown>
  id?: string | number
  [extra: string]: unknown
}

/** 独立 Risu 世界书是 { type:'risu', ver:1, data: 条目数组 }；兼容 data 为 { entries } 的变体。 */
function resolveEntries(input: Record<string, unknown>): Array<Record<string, unknown>> | null {
  const data = input.data
  if (Array.isArray(data)) return data.filter(isRecord)
  if (isRecord(data) && Array.isArray(data.entries)) return data.entries.filter(isRecord)
  return null
}

function wrapperExtras(input: Record<string, unknown>): Record<string, JsonValue> {
  const wrapper: Record<string, JsonValue> = {}
  for (const [key, value] of Object.entries(input)) {
    if (WRAPPER_KEYS.has(key)) continue
    const converted = value
    if (converted !== undefined && (converted === null || typeof converted !== 'object' || isRecord(converted) || Array.isArray(converted))) {
      wrapper[key] = converted as JsonValue
    }
  }
  return wrapper
}

/** Risu 条目 → 归一化器可读的载荷字段；原始字段保留在对象上以便进入 foreign 保留区。 */
function toPayloadEntry(entry: RisuEntry): Record<string, unknown> {
  const alwaysActive = entry.alwaysActive === true || entry.mode === 'constant'
  return {
    ...entry,
    keysecondary: entry.secondkey ?? '',
    insertion_order: entry.insertorder ?? 0,
    constant: alwaysActive,
    probability: entry.activationPercent,
    useProbability: entry.activationPercent !== undefined && entry.activationPercent < 100,
    caseSensitive: entry.extentions?.risu_case_sensitive === true,
  }
}

export const risuLorebookAdapter: LorebookFormatAdapter = {
  id: CONFIG.id,
  label: CONFIG.label,
  formatVersion: CONFIG.version,
  priority: 50,

  detect(input) {
    if (!isRecord(input)) {
      return { adapterId: CONFIG.id, formatLabel: CONFIG.label, formatVersion: CONFIG.version, confidence: 0, reasons: [], conflicts: [] }
    }
    if (input.type === 'risu' && resolveEntries(input)) {
      return {
        adapterId: CONFIG.id, formatLabel: CONFIG.label, formatVersion: CONFIG.version, confidence: 98,
        reasons: ['顶层 type=risu 且 data 为 Risu 条目数组'], conflicts: [],
      }
    }
    const bare = Array.isArray(input.data) ? input.data.filter(isRecord) : []
    if (bare.some((entry) => 'secondkey' in entry && 'insertorder' in entry)) {
      return {
        adapterId: CONFIG.id, formatLabel: CONFIG.label, formatVersion: CONFIG.version, confidence: 82,
        reasons: ['条目包含 Risu 特有的 secondkey/insertorder 字段'], conflicts: [],
      }
    }
    return { adapterId: CONFIG.id, formatLabel: CONFIG.label, formatVersion: CONFIG.version, confidence: 0, reasons: [], conflicts: [] }
  },

  import(input, context) {
    if (!isRecord(input)) throw new Error('Risu Lorebook 顶层必须是对象')
    // 不做预过滤：非对象条目交给统一导入器计数并生成结构化拒绝报告
    const entries = resolveEntries(input) ?? []
    const wrapper = wrapperExtras(input)
    const result = importExternalLorebook(
      input,
      { entries: entries.map((entry) => isRecord(entry) ? toPayloadEntry(entry as RisuEntry) : entry) },
      context,
      { ...CONFIG, consumedEntryKeys: CONSUMED_ENTRY_KEYS },
      Object.keys(wrapper).length > 0 ? wrapper : undefined,
    )
    // Risu mode=multiple 表示全部关键词命中才触发；canonical 以 keyLogic='all' 保留原意
    result.document.entries.forEach((entry, index) => {
      if ((entries[index] as RisuEntry | undefined)?.mode === 'multiple') entry.activation.keyLogic = 'all'
    })
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
        'warning', 'approximated', 'risu_insertion_unsupported', '$.entries',
        `Risu Lorebook 没有条目级插入位置；${approximated} 个条目的位置设置无法表达，已省略`,
      )] : []),
    ]
    const value = {
      ...storedBook.fields,
      ...wrapper,
      type: 'risu',
      ver: typeof wrapper.ver === 'number' ? wrapper.ver : 1,
      data: document.entries.map((entry) => risuExportEntry(entry)),
    }
    return { value: value as JsonValue, report: createCompatibilityReport(CONFIG.id, CONFIG.label, CONFIG.version, issues) }
  },
}

function risuExportEntry(entry: CanonicalLoreEntryV2): Record<string, unknown> {
  const stored = foreignSection(entry.foreign, CONFIG.id)
  const constant = entry.activation.mode === 'constant'
  const multiple = entry.activation.keyLogic === 'all'
  const originalMode = typeof stored.fields.mode === 'string' ? stored.fields.mode : undefined
  // 由 canonical 重建的字段拥有最高优先级；其余未知字段作为底稿保留
  const rebuilt = new Set(['comment', 'key', 'secondkey', 'content', 'insertorder', 'mode', 'alwaysActive', 'selective', 'activationPercent', 'useRegex', 'id'])
  const passthrough = Object.fromEntries(Object.entries(stored.fields).filter(([key]) => !rebuilt.has(key)))
  const originalExtensions = isRecord(stored.fields.extentions) ? stored.fields.extentions : {}
  return {
    ...passthrough,
    ...(entry.sourceId !== undefined ? { id: entry.sourceId } : {}),
    comment: entry.title ?? '',
    key: [...entry.activation.primaryKeys, ...entry.activation.aliases].join(', '),
    secondkey: entry.activation.secondaryKeys.join(', '),
    content: entry.content,
    insertorder: entry.scheduling.order,
    mode: multiple ? 'multiple' : constant ? 'constant' : (originalMode ?? 'normal'),
    alwaysActive: constant,
    selective: entry.activation.secondaryKeys.length > 0,
    ...(entry.scheduling.probability !== 100 ? { activationPercent: entry.scheduling.probability } : {}),
    useRegex: entry.activation.regex.enabled,
    extentions: { ...originalExtensions, risu_case_sensitive: entry.activation.caseSensitive },
  }
}
