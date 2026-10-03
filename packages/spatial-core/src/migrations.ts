/**
 * 版本迁移：只做逐版本迁移，不写任意版本直达逻辑。
 * 当前仅有 v1。
 */
import type {
  SpatialRuntimeStateV1,
  SpatialWorldDocumentV1,
} from './model.ts'
import { removeNodeCategories } from './nodeFields.ts'

export type MigrationResult<T> =
  | { ok: true; value: T; migratedFrom?: number }
  | { ok: false; code: 'unknown_version' | 'invalid_document'; message: string }

export function migrateWorldDocument(
  raw: unknown
): MigrationResult<SpatialWorldDocumentV1> {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, code: 'invalid_document', message: '世界文档不是对象' }
  }
  const doc = raw as { schemaVersion?: unknown }
  if (doc.schemaVersion === 1) {
    return { ok: true, value: removeNodeCategories(raw as SpatialWorldDocumentV1).world }
  }
  if (typeof doc.schemaVersion === 'number' && doc.schemaVersion > 1) {
    return {
      ok: false,
      code: 'unknown_version',
      message: `不支持的 schemaVersion=${doc.schemaVersion}（只读预览或拒绝，不降级覆盖）`,
    }
  }
  return {
    ok: false,
    code: 'invalid_document',
    message: `缺少或非法的 schemaVersion：${String(doc.schemaVersion)}`,
  }
}

export function migrateRuntimeState(
  raw: unknown
): MigrationResult<SpatialRuntimeStateV1> {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, code: 'invalid_document', message: '运行状态不是对象' }
  }
  const doc = raw as { schemaVersion?: unknown }
  if (doc.schemaVersion === 1) {
    return { ok: true, value: raw as SpatialRuntimeStateV1 }
  }
  if (typeof doc.schemaVersion === 'number' && doc.schemaVersion > 1) {
    return {
      ok: false,
      code: 'unknown_version',
      message: `不支持的 schemaVersion=${doc.schemaVersion}`,
    }
  }
  return {
    ok: false,
    code: 'invalid_document',
    message: `缺少或非法的 schemaVersion：${String(doc.schemaVersion)}`,
  }
}
