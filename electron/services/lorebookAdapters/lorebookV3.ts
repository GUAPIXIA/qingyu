import type { JsonValue } from '../../../shared/lorebook/domain/v2'
import type {
  LorebookCompatibilityIssue,
  LorebookFormatAdapter,
} from '../../../shared/lorebook/adapters/types'
import {
  collectWrapperExtras,
  exportExternalLorebook,
  importExternalLorebook,
  isRecord,
  wrapperForeign,
} from './common'
import { createCompatibilityReport } from './report'
import { LorebookAdapterError } from './error'

const CONFIG = {
  id: 'character-card.lorebook-v3',
  label: 'Character Card lorebook_v3',
  version: '3.0',
  sourceKind: 'character_book' as const,
  style: 'character_book' as const,
}

const WRAPPER_KEYS = new Set(['spec', 'spec_version', 'data'])

export const lorebookV3Adapter: LorebookFormatAdapter = {
  id: CONFIG.id,
  label: CONFIG.label,
  formatVersion: CONFIG.version,
  priority: 95,

  detect(input) {
    const spec = isRecord(input) ? input.spec : undefined
    const exact = spec === 'lorebook_v3' && isRecord(input) && isRecord(input.data)
    const partial = spec === 'lorebook_v3'
    return {
      adapterId: CONFIG.id,
      formatLabel: CONFIG.label,
      formatVersion: CONFIG.version,
      confidence: exact ? 100 : partial ? 90 : 0,
      reasons: partial ? ['spec=lorebook_v3', ...(exact ? ['data 为对象'] : [])] : [],
      conflicts: partial && !exact ? ['lorebook_v3 缺少对象类型 data'] : [],
    }
  },

  import(input, context) {
    if (!isRecord(input) || input.spec !== 'lorebook_v3' || !isRecord(input.data)) {
      throw new LorebookAdapterError('lorebook_v3 包装结构无效')
    }
    const wrapperIssues: LorebookCompatibilityIssue[] = []
    const wrapperExtras = collectWrapperExtras(input, WRAPPER_KEYS, wrapperIssues)
    const result = importExternalLorebook(input, input.data, context, CONFIG, wrapperExtras)
    result.report = createCompatibilityReport(
      CONFIG.id,
      CONFIG.label,
      typeof input.spec_version === 'string' ? input.spec_version : CONFIG.version,
      [...wrapperIssues, ...result.report.issues],
    )
    result.document.source = {
      ...result.document.source!,
      formatVersion: typeof input.spec_version === 'string' ? input.spec_version : CONFIG.version,
    }
    return result
  },

  export(document) {
    const payload = exportExternalLorebook(document, CONFIG)
    const wrapper = wrapperForeign(document, CONFIG.id)
    return {
      value: {
        ...wrapper,
        spec: 'lorebook_v3',
        spec_version: document.source?.adapterId === CONFIG.id
          ? document.source.formatVersion ?? CONFIG.version
          : CONFIG.version,
        data: payload.value,
      } as JsonValue,
      report: payload.report,
    }
  },
}
