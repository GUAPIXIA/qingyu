import type { Lorebook } from '../../../shared/types'
import type { JsonValue } from '../../../shared/lorebook/domain/v2'
import type { LorebookFormatAdapter } from '../../../shared/lorebook/adapters/types'
import { validateNativeLorebookV1 } from '../../../shared/lorebook/nativeV1'
import { migrateNativeLorebookV1ToV2 } from '../../../shared/lorebook/migrations/v1-to-v2'
import { compileCanonicalLorebookV2 } from '../../../shared/lorebook/runtime/compile'
import { compatibilityIssue, createCompatibilityReport } from './report'
import { LorebookAdapterError } from './error'
import { isRecord } from './common'

const ID = 'qingyu.native-v1'
const LABEL = '轻语原生世界书 v1'
const VERSION = '1'

function nativeSignals(input: unknown): { score: number; reasons: string[]; conflicts: string[] } {
  if (!isRecord(input) || !Array.isArray(input.entries)) return { score: 0, reasons: [], conflicts: [] }
  const entries = input.entries.filter(isRecord)
  const nativeEntry = entries.some((entry) => 'keywords' in entry || 'matchMode' in entry || 'useRegex' in entry)
  const externalEntry = entries.some((entry) => 'keys' in entry || 'key' in entry || 'insertion_order' in entry)
  let score = typeof input.scanDepth === 'number' ? 72 : 45
  const reasons = ['entries 为数组']
  if (nativeEntry) {
    score += 23
    reasons.push('条目使用 keywords/matchMode/useRegex 原生字段')
  }
  if (input.schemaVersion === 1) {
    score = Math.max(score, 98)
    reasons.push('schemaVersion=1')
  }
  return {
    score: Math.min(100, score),
    reasons,
    conflicts: externalEntry ? ['条目同时出现原生与外部格式字段'] : [],
  }
}

export const nativeV1Adapter: LorebookFormatAdapter = {
  id: ID,
  label: LABEL,
  formatVersion: VERSION,
  priority: 90,

  detect(input, file) {
    const detected = nativeSignals(input)
    const hinted = file?.fileName?.toLowerCase().includes('native-v1') ? 8 : 0
    return {
      adapterId: ID,
      formatLabel: LABEL,
      formatVersion: VERSION,
      confidence: Math.min(100, detected.score + hinted),
      reasons: [...detected.reasons, ...(hinted ? ['文件名提示 native-v1'] : [])],
      conflicts: detected.conflicts,
    }
  },

  import(input, context) {
    const validation = validateNativeLorebookV1(input)
    if (!validation.valid) {
      const issues = validation.issues.map((item) => compatibilityIssue(
        'error', 'rejected', 'native_v1_invalid', item.path, item.message,
      ))
      const report = createCompatibilityReport(ID, LABEL, VERSION, issues)
      throw new LorebookAdapterError('轻语原生世界书 v1 校验失败', report)
    }
    const document = migrateNativeLorebookV1ToV2(validation.value, {
      now: context.now,
      contentHash: context.contentHash,
    })
    if (context.id) document.id = context.id
    const preserved = (isRecord(document.foreign?.[ID]) ? Object.keys(document.foreign![ID] as object).length : 0)
      + document.entries.reduce((count, entry) => (
        count + (isRecord(entry.foreign?.[ID]) ? Object.keys(entry.foreign![ID] as object).length : 0)
      ), 0)
    const issues = preserved > 0
      ? [compatibilityIssue('info', 'preserved', 'unknown_field', '$', `${preserved} 个未知原生字段已保留在 namespaced foreign 中`)]
      : []
    return { document, report: createCompatibilityReport(ID, LABEL, VERSION, issues) }
  },

  export(document) {
    const view = compileCanonicalLorebookV2(document) as Lorebook & Record<string, unknown>
    const bookExtras = document.foreign?.[ID]
    const value: Record<string, unknown> = {
      ...(isRecord(bookExtras) ? bookExtras : {}),
      ...view,
      entries: view.entries.map((entry, index) => {
        const extras = document.entries[index]?.foreign?.[ID]
        return { ...(isRecord(extras) ? extras : {}), ...entry }
      }),
    }
    const preserved = (isRecord(bookExtras) ? Object.keys(bookExtras).length : 0)
      + document.entries.reduce((count, entry) => {
        const extras = entry.foreign?.[ID]
        return count + (isRecord(extras) ? Object.keys(extras).length : 0)
      }, 0)
    const issues = preserved > 0
      ? [compatibilityIssue('info', 'preserved', 'foreign_exported', '$', `${preserved} 个未知原生字段已合并回导出结果`)]
      : []
    return {
      value: value as JsonValue,
      report: createCompatibilityReport(ID, LABEL, VERSION, issues),
    }
  },
}
