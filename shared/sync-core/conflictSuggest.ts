import type { ConflictRecord } from '../contracts/conflict'
import type { ConflictUiSuggestion } from './types'

export type ConflictKind = ConflictRecord['kind']

/**
 * 冲突默认 UI 建议（S7-01）。
 * 删除 vs 修改必须单独确认；依赖冲突引导恢复父实体或级联删除。
 */
export function suggestConflictResolution(kind: ConflictKind): ConflictUiSuggestion {
  switch (kind) {
    case 'delete_vs_modify':
      return 'confirm_delete_vs_modify'
    case 'dependency':
      return 'resolve_dependency'
    case 'version_concurrent':
    default:
      return 'manual_merge'
  }
}

/** 批量处理仅允许同类型且策略安全的冲突（方案 S7-06） */
export function canBatchResolve(kinds: readonly ConflictKind[]): boolean {
  if (kinds.length === 0) return false
  // 删除 vs 修改、依赖冲突绝不允许批量
  return kinds.every((k) => k === 'version_concurrent')
}

export interface ConflictResolutionRecord {
  conflictId: string
  choice: 'local' | 'remote' | 'copy_as_new' | 'manual'
  /** 解决前双方 contentHash（诊断用，不含正文） */
  localHash: string
  remoteHash: string
  resolvedAt: number
  /** copy_as_new 时新实体 id */
  newEntityId?: string
}

/** 解决记录：保留原版本 hash 与选择，但不含正文（方案 S7-06） */
export function buildResolutionRecord(input: {
  conflictId: string
  choice: ConflictResolutionRecord['choice']
  localHash: string
  remoteHash: string
  resolvedAt: number
  newEntityId?: string
}): ConflictResolutionRecord {
  const out: ConflictResolutionRecord = {
    conflictId: input.conflictId,
    choice: input.choice,
    localHash: input.localHash,
    remoteHash: input.remoteHash,
    resolvedAt: input.resolvedAt,
  }
  if (input.newEntityId) out.newEntityId = input.newEntityId
  return out
}
