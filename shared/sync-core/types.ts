import type { VersionVector } from '../contracts/version-vector'
import type { SyncEntityType } from '../contracts/sync-envelope'

/** 同步侧实体头（来自 entity_heads / journal，不含正文 payload） */
export interface EntityHeadSummary {
  entityType: SyncEntityType | string
  entityId: string
  version: VersionVector
  contentHash: string
  deleted: boolean
  parentId: string | null
  schemaVersion: number
  updatedAt: number
}

/** 同步会话固定状态机（方案 §1） */
export type SyncSessionState =
  | 'idle'
  | 'scanning'
  | 'plan_ready'
  | 'awaiting_confirmation'
  | 'transferring'
  | 'validating'
  | 'prepared'
  | 'committing'
  | 'applying_local'
  | 'committed'
  | 'completed'
  | 'cancelling'
  | 'cancelled'
  | 'failed'

export type SyncSessionEvent =
  | 'start_scan'
  | 'plan_ready'
  | 'await_confirmation'
  | 'user_confirm'
  | 'transfer_start'
  | 'validate'
  | 'prepare'
  | 'commit'
  | 'apply_local'
  | 'mark_completed'
  | 'cancel'
  | 'cancel_done'
  | 'fail_retryable'
  | 'fail_non_retryable'

export interface SessionMachineResult {
  next: SyncSessionState
  ok: boolean
  reason?: 'INVALID_TRANSITION' | 'TERMINAL_LOCKED'
}

export interface Capabilities {
  protocolVersion: number
  features: readonly string[]
  schemaVersions: Readonly<Record<string, number>>
}

export interface NegotiatedCapabilities {
  protocolVersion: number
  features: string[]
  schemaVersions: Record<string, number>
  unsupportedEntityTypes: string[]
}

export type ConflictUiSuggestion =
  | 'prefer_local'
  | 'prefer_remote'
  | 'manual_merge'
  | 'copy_as_new'
  | 'confirm_delete_vs_modify'
  | 'resolve_dependency'

export type PlanBucket = 'upload' | 'download' | 'same' | 'conflict' | 'unknown_schema'

export interface PlanItem {
  entityType: string
  entityId: string
  bucket: PlanBucket
  localVersion?: VersionVector
  remoteVersion?: VersionVector
  localHash?: string
  remoteHash?: string
  deleted?: boolean
  schemaVersion?: number
  conflictKind?: 'version_concurrent' | 'delete_vs_modify' | 'dependency'
  unknownSchemaReason?: string
}

export interface PlanStats {
  uploadCount: number
  downloadCount: number
  sameCount: number
  conflictCount: number
  unknownSchemaCount: number
  uploadBytesEstimate: number
  downloadBytesEstimate: number
}

export interface SyncPlan {
  items: PlanItem[]
  stats: PlanStats
  planId: string
}
