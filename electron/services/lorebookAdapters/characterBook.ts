import type { LorebookFormatAdapter } from '../../../shared/lorebook/adapters/types'
import { exportExternalLorebook, importExternalLorebook, isRecord } from './common'

const CONFIG = {
  id: 'character-card.character-book',
  label: 'CCv2/CCv3 character_book',
  version: '2/3',
  sourceKind: 'character_book' as const,
  style: 'character_book' as const,
}

export const characterBookAdapter: LorebookFormatAdapter = {
  id: CONFIG.id,
  label: CONFIG.label,
  formatVersion: CONFIG.version,
  priority: 85,

  detect(input, file) {
    if (!isRecord(input) || !Array.isArray(input.entries)) {
      return { adapterId: CONFIG.id, formatLabel: CONFIG.label, formatVersion: CONFIG.version, confidence: 0, reasons: [], conflicts: [] }
    }
    const entries = input.entries.filter(isRecord)
    const hasCcFields = entries.some((entry) => 'keys' in entry || 'insertion_order' in entry || 'use_regex' in entry)
    const hasNativeFields = entries.some((entry) => 'keywords' in entry || 'matchMode' in entry)
    const hinted = /character[-_ ]?book/i.test(file?.fileName ?? '') ? 25 : 0
    const confidence = Math.min(100, (hasCcFields ? 96 : typeof input.scan_depth === 'number' ? 68 : 35) + hinted)
    return {
      adapterId: CONFIG.id,
      formatLabel: CONFIG.label,
      formatVersion: CONFIG.version,
      confidence,
      reasons: [
        'entries 为数组',
        ...(hasCcFields ? ['条目包含 keys/insertion_order/use_regex 字段'] : []),
        ...(hinted ? ['文件名提示 character_book'] : []),
      ],
      conflicts: hasNativeFields ? ['同时检测到轻语原生 keywords/matchMode 字段'] : [],
    }
  },

  import(input, context) {
    if (!isRecord(input)) throw new Error('character_book 顶层必须是对象')
    return importExternalLorebook(input, input, context, CONFIG)
  },

  export(document) {
    return exportExternalLorebook(document, CONFIG)
  },
}
