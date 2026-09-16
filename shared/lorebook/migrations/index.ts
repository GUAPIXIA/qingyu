import type { Lorebook } from '../../types'
import { validateNativeLorebookV1 } from '../nativeV1'
import type { CanonicalLorebookDocumentV2 } from '../domain/v2'
import { validateCanonicalLorebookV2 } from '../domain/validation'
import { migrateNativeLorebookV1ToV2, type MigrateNativeV1Options } from './v1-to-v2'

export class LorebookMigrationError extends Error {
  constructor(message: string, readonly issues: Array<{ path: string; message: string }>) {
    super(message)
    this.name = 'LorebookMigrationError'
  }
}

export function migrateLorebookDocumentToLatest(
  value: unknown,
  options: MigrateNativeV1Options,
): CanonicalLorebookDocumentV2 {
  // 旧版本曾把 0 保存为“硬上限为零”，会导致整本世界书静默失效。
  // 读取时宽容归一化为未设置；后续保存自然写回正整数或缺省字段。
  const normalizedValue = value
    && typeof value === 'object'
    && !Array.isArray(value)
    && (value as { schema?: unknown }).schema === 'qingyu_lorebook'
    && (value as { defaults?: { tokenBudget?: unknown } }).defaults?.tokenBudget === 0
    ? (() => {
        const document = structuredClone(value) as Record<string, unknown>
        const defaults = { ...(document.defaults as Record<string, unknown>) }
        delete defaults.tokenBudget
        document.defaults = defaults
        return document
      })()
    : value
  const canonical = validateCanonicalLorebookV2(normalizedValue)
  if (canonical.valid) return canonical.value

  const legacy = validateNativeLorebookV1(normalizedValue)
  if (!legacy.valid) {
    throw new LorebookMigrationError(
      '世界书既不是有效的 canonical v2，也不是有效的 native v1',
      legacy.issues.map((issue) => ({ path: issue.path, message: issue.message })),
    )
  }
  return migrateNativeLorebookV1ToV2(legacy.value as Lorebook, options)
}

