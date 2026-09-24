/**
 * 阶段 8：/sync/v1 服务端线格式与常量。
 *
 * 服务端只处理密文信封元数据，不解析业务 payload。
 */

export const SYNC_PROTOCOL_VERSION = 1

/** 单条 push 密文上限（小实体直存 DB） */
export const SMALL_CIPHERTEXT_MAX_BYTES = 32 * 1024
/** 单 batch 上限 */
export const SYNC_BATCH_MAX_ITEMS = 200
export const SYNC_BATCH_MAX_BYTES = 4 * 1024 * 1024
/** pull 单批条数 */
export const SYNC_PULL_MAX_ITEMS = 200
/** session TTL */
export const SYNC_SESSION_TTL_MS = 2 * 60 * 60 * 1000
/** 幂等 batch TTL */
export const SYNC_BATCH_TTL_MS = 24 * 60 * 60 * 1000

export type SyncSessionState =
  | 'open'
  | 'planned'
  | 'pushing'
  | 'pulling'
  | 'prepared'
  | 'committed'
  | 'aborted'
  | 'expired'

export type SyncErrorCode =
  | 'SCHEMA_UNSUPPORTED'
  | 'CONFLICT'
  | 'HASH_MISMATCH'
  | 'QUOTA_EXCEEDED'
  | 'SESSION_EXPIRED'
  | 'DEVICE_REVOKED'
  | 'DEPENDENCY_CONFLICT'
  | 'BATCH_TOO_LARGE'
  | 'BATCH_REPLAY_MISMATCH'
  | 'BAD_VERSION_VECTOR'
  | 'DOT_DEVICE_MISMATCH'
  | 'DOT_COUNTER_REGRESSION'
  | 'BAD_ENVELOPE'
  | 'KEY_ENVELOPE_INVALID'
  | 'REENTCRYPT_FORBIDDEN'
  | 'INTERNAL'

/** push 一条：密文 + 信封元数据（无 payload） */
export interface WireEntity {
  entityType: string
  entityId: string
  parentId: string | null
  schemaVersion: number
  /** 版本向量；counter 为无前导零十进制字符串 */
  version: Record<string, string>
  versionHash: string
  dot: { deviceId: string; counter: string }
  deleted: boolean
  updatedAt: number
  keyEpoch: number
  cipherRevision: number
  cipherHash: string
  contentTag: string
  /** base64 ciphertext||tag；与 blobManifestId 二选一 */
  ciphertext?: string
  blobManifestId?: string
}

export interface PushRequestBody {
  batchId: string
  envelopes: WireEntity[]
  /** 可选：冲突解决时被支配 head 证明 */
  dominatedProofs?: Array<{ entityType: string; entityId: string; versionHash: string }>
  /** 重加密批次：独立权限 */
  reencrypt?: { fromKeyEpoch: number; toKeyEpoch: number }
}

export interface PullRequestBody {
  cursor?: string
  limit?: number
}

export interface SessionResponse {
  sessionId: string
  state: SyncSessionState
  protocolVersion: number
  expiresAt: number
  preparedReceipt?: PreparedReceipt
  commitReceipt?: CommitReceipt
}

export interface PreparedReceipt {
  sessionId: string
  batchHash: string
  preparedAt: number
  stagedCount: number
}

export interface CommitReceipt {
  sessionId: string
  committedAt: number
  vector: Record<string, string>
  serverSeq: string
}

export interface PlanResponse {
  upload: number
  download: number
  conflicts: number
  estimatedBytes: number
  items: Array<{
    entityType: string
    entityId: string
    direction: 'upload' | 'download' | 'conflict'
  }>
  quota: {
    usedEntities: number
    maxEntities: number
    usedCiphertextBytes: number
    maxCiphertextBytes: number
  }
}

export interface DeviceKeyRegistration {
  deviceId: string
  x25519PublicKey: string
  ed25519PublicKey: string
  nonce: string
  expiresAt: number
}

export interface KeyEnvelopeWire {
  formatVersion: number
  spaceId: string
  keyEpoch: number
  recipientDeviceId: string
  recipientX25519PublicKey: string
  approverDeviceId: string
  approverX25519PublicKey: string
  approverEd25519PublicKey: string
  nonce: string
  expiresAt: number
  wrappedNonce: string
  wrappedKey: string
  transcriptHash: string
  signature: string
}
