import type { JsonValue } from '../../../shared/lorebook/domain/v2'
import type { LorebookFormatAdapter } from '../../../shared/lorebook/adapters/types'
import { validateCanonicalLorebookV2 } from '../../../shared/lorebook/domain/validation'
import { compatibilityIssue, createCompatibilityReport } from './report'
import { LorebookAdapterError } from './error'
import { isRecord } from './common'

const ID = 'qingyu.canonical-v2'
const LABEL = '轻语 Canonical 世界书 v2'
const VERSION = '2'

export const canonicalV2Adapter: LorebookFormatAdapter = {
  id: ID,
  label: LABEL,
  formatVersion: VERSION,
  priority: 100,

  detect(input) {
    const exact = isRecord(input) && input.schema === 'qingyu_lorebook' && input.schemaVersion === 2
    return {
      adapterId: ID,
      formatLabel: LABEL,
      formatVersion: VERSION,
      confidence: exact ? 100 : 0,
      reasons: exact ? ['schema=qingyu_lorebook 且 schemaVersion=2'] : [],
      conflicts: [],
    }
  },

  import(input, context) {
    const validation = validateCanonicalLorebookV2(input)
    if (!validation.valid) {
      const issues = validation.issues.map((item) => compatibilityIssue(
        'error', 'rejected', 'canonical_v2_invalid', item.path, item.message,
      ))
      const report = createCompatibilityReport(ID, LABEL, VERSION, issues)
      throw new LorebookAdapterError('Canonical 世界书 v2 校验失败', report)
    }
    const document = structuredClone(validation.value)
    if (context.id) document.id = context.id
    return { document, report: createCompatibilityReport(ID, LABEL, VERSION) }
  },

  export(document) {
    return {
      value: structuredClone(document) as unknown as JsonValue,
      report: createCompatibilityReport(ID, LABEL, VERSION),
    }
  },
}
