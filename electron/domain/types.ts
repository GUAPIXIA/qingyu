import type { DeviceIdentityStore } from './deviceIdentity'
import type { SyncMetaDb } from './syncMeta'
import type { PcDomainRepository } from './pcRepository'
import type { RepoFeatureFlags } from './featureFlag'
import type { SyncEntityType } from '../../shared/contracts/sync-envelope'

export interface SyncDomainContext {
  repo: PcDomainRepository
  flags: RepoFeatureFlags
  meta: SyncMetaDb
  identity: DeviceIdentityStore
  userDataDir: string
}

/** 一次域写入要落盘的文件；content 为 null 表示删除 */
export interface DomainWriteFile {
  path: string
  content: string | null
  /** true 表示追加到文件末尾（JSONL 消息追加，保持旧实现的 O(1) 追加语义） */
  append?: boolean
}

/** S2-05：只读扫描得到的一个待建 head 的实体 */
export interface BootstrapScanItem {
  entityType: SyncEntityType
  entityId: string
  parentId?: string | null
  payload: Record<string, unknown>
  schemaVersion?: number
  references?: string[]
}

export type BootstrapIssueKind =
  | 'invalid_id'
  | 'duplicate_id'
  | 'missing_parent'
  | 'invalid_parent'
  | 'unreadable_file'
  | 'invalid_payload'

export interface BootstrapIssue {
  kind: BootstrapIssueKind
  entityType: string
  entityId: string
  detail: string
}

export interface BootstrapResult {
  alreadyBootstrapped: boolean
  genesisId: string
  entityCount: number
  datasetHash: string
  receiptId: string
  checkpointId: string | null
  issues: BootstrapIssue[]
  /** 受认证 genesis manifest（供旧 Android 迁移器校验） */
  manifest: GenesisManifest
}

export interface GenesisManifest {
  genesisId: string
  platform: 'pc'
  createdAt: number
  datasetHash: string
  entityCount: number
  /** 按 entityType:entityId 排序的规范业务哈希清单 */
  entries: Array<{ entityType: string; entityId: string; hash: string }>
  /** HMAC-SHA256(manifestSecret, canonical(genesisId|datasetHash|entries)) */
  signature: string
}
