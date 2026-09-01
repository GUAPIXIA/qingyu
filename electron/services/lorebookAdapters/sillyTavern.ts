import type { LorebookFormatAdapter } from '../../../shared/lorebook/adapters/types'
import { exportExternalLorebook, importExternalLorebook, isRecord } from './common'

const CONFIG = {
  id: 'sillytavern.world-info',
  label: 'SillyTavern World Info',
  version: '2026-07',
  sourceKind: 'sillytavern' as const,
  style: 'sillytavern' as const,
}

export const sillyTavernWorldInfoAdapter: LorebookFormatAdapter = {
  id: CONFIG.id,
  label: CONFIG.label,
  formatVersion: CONFIG.version,
  priority: 80,

  detect(input, file) {
    if (!isRecord(input) || !('entries' in input)) {
      return { adapterId: CONFIG.id, formatLabel: CONFIG.label, formatVersion: CONFIG.version, confidence: 0, reasons: [], conflicts: [] }
    }
    const entries = isRecord(input.entries)
      ? Object.values(input.entries).filter(isRecord)
      : Array.isArray(input.entries) ? input.entries.filter(isRecord) : []
    const hasStFields = entries.some((entry) => 'uid' in entry || 'key' in entry || 'keysecondary' in entry || 'disable' in entry)
    const hasCcFields = entries.some((entry) => 'keys' in entry || 'insertion_order' in entry)
    const objectEntries = isRecord(input.entries)
    const hinted = /sillytavern|world[-_ ]?info/i.test(file?.fileName ?? '') ? 20 : 0
    const confidence = Math.min(100, (objectEntries && hasStFields ? 97 : hasStFields ? 82 : objectEntries ? 65 : 0) + hinted)
    return {
      adapterId: CONFIG.id,
      formatLabel: CONFIG.label,
      formatVersion: CONFIG.version,
      confidence,
      reasons: [
        ...(objectEntries ? ['entries 使用 ST 常见的 uid 键控对象'] : []),
        ...(hasStFields ? ['条目包含 uid/key/keysecondary/disable 字段'] : []),
        ...(hinted ? ['文件名提示 SillyTavern World Info'] : []),
      ],
      conflicts: hasCcFields ? ['同时检测到 character_book 的 keys/insertion_order 字段'] : [],
    }
  },

  import(input, context) {
    if (!isRecord(input)) throw new Error('SillyTavern World Info 顶层必须是对象')
    return importExternalLorebook(input, input, context, CONFIG)
  },

  export(document) {
    return exportExternalLorebook(document, CONFIG)
  },
}
