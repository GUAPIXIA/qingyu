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
  const canonical = validateCanonicalLorebookV2(value)
  if (canonical.valid) return canonical.value

  const legacy = validateNativeLorebookV1(value)
  if (!legacy.valid) {
    throw new LorebookMigrationError(
      '世界书既不是有效的 canonical v2，也不是有效的 native v1',
      legacy.issues.map((issue) => ({ path: issue.path, message: issue.message })),
    )
  }
  return migrateNativeLorebookV1ToV2(legacy.value as Lorebook, options)
}

