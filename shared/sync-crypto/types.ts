/**
 * 阶段 8 S8-01：E2EE 格式与常量——跨端共享契约。
 *
 * 决策冻结（方案 §13.7 / S8-01）：
 * - 实体：AES-256-GCM，96 位随机 nonce，128 位 tag。
 * - 子密钥：HKDF-SHA-256 从 spaceKey 派生，info 固定并版本化。
 * - AAD 至少含 spaceId/entityType/entityId/schemaVersion/versionHash/keyEpoch/cipherRevision。
 * - contentTag = HMAC(content-dedupe subkey, entityType/entityId/contentHash)，服务端只判等。
 * - 密码库失败 fail closed，不得回退明文。
 * - 重加密只增加 cipherRevision，不改业务 version/dot/contentHash。
 *
 * 恢复包 KDF 决策（S8-02）：
 * - 评估 Argon2id：Node 无内置、需原生/纯 JS 依赖；JVM 侧 BC 可用但两端依赖面不一致。
 * - 冻结 **scrypt**（RFC 7914）为恢复包 KDF：`node:crypto` 与 BouncyCastle `SCrypt` 双端零原生依赖可用。
 * - 最低参数 N≥2^15, r=8, p=1, dkLen=32；导出侧推荐 N=2^18。导入拒绝低于最低参数或参数被降级的包。
 * - 错误次数由调用方限流；恢复成功后必须立即轮换 spaceKey（S8-06）。
 */

export const SYNC_CRYPTO_FORMAT_VERSION = 1
export const SPACE_KEY_BYTES = 32
export const GCM_NONCE_BYTES = 12
export const GCM_TAG_BITS = 128
export const GCM_TAG_BYTES = 16

/** key epoch 从 1 开始 */
export const KEY_EPOCH_START = 1

/** cipher revision 从 1 开始；重加密递增，不产生业务 dot */
export const CIPHER_REVISION_START = 1

/** HKDF info 版本前缀，变更必须升版本并保持旧可读 */
export const SUBKEY_INFO_VERSION = 1

export type SubkeyPurpose =
  | 'entity'
  | 'blob-chunk'
  | 'blob-manifest'
  | 'receipt'
  | 'content-dedupe'
  | 'key-envelope'
  | 'recovery'
  | 'challenge'

export interface EntityAadInput {
  spaceId: string
  entityType: string
  entityId: string
  schemaVersion: number
  /** 版本向量规范哈希（sha256:<hex>） */
  versionHash: string
  keyEpoch: number
  cipherRevision: number
}

export interface EncryptedEntity {
  formatVersion: typeof SYNC_CRYPTO_FORMAT_VERSION
  keyEpoch: number
  cipherRevision: number
  /** base64 12B */
  nonce: string
  /** base64 ciphertext||tag */
  ciphertext: string
  /** sha256:<hex> of ciphertext bytes（只上密文 hash） */
  cipherHash: string
  /** HMAC 标签 base64，仅用于服务端相等判断 */
  contentTag: string
  /** 明文业务 hash，仅本地/客户端持有，不上服务器 */
  contentHash?: string
}

export interface BlobChunkPlain {
  index: number
  /** 明文块字节 */
  data: Uint8Array
}

export interface EncryptedBlobChunk {
  index: number
  nonce: string
  ciphertext: string
  cipherHash: string
  plainLength: number
}

export interface BlobManifest {
  formatVersion: typeof SYNC_CRYPTO_FORMAT_VERSION
  blobId: string
  keyEpoch: number
  cipherRevision: number
  chunkPlaintextSize: number
  plainTotalLength: number
  /** sha256:<hex> of full plaintext */
  plainHash: string
  chunks: Array<{ index: number; cipherHash: string; plainLength: number }>
  /** manifest 自身签名：Ed25519 over canonical manifest body（无 signature 字段） */
  manifestHash: string
}

export interface EncryptedBlobManifest {
  formatVersion: typeof SYNC_CRYPTO_FORMAT_VERSION
  keyEpoch: number
  cipherRevision: number
  nonce: string
  ciphertext: string
  cipherHash: string
}

export interface KeyEnvelopeBody {
  formatVersion: typeof SYNC_CRYPTO_FORMAT_VERSION
  spaceId: string
  keyEpoch: number
  recipientDeviceId: string
  /** X25519 raw 32B base64 */
  recipientX25519PublicKey: string
  approverDeviceId: string
  approverX25519PublicKey: string
  /** Ed25519 raw 32B base64 */
  approverEd25519PublicKey: string
  /** 一次性 nonce base64 */
  nonce: string
  /** 过期 ms */
  expiresAt: number
  /** AES-GCM wrapped spaceKey */
  wrappedNonce: string
  wrappedKey: string
  /** ECDH transcript hash sha256:<hex> */
  transcriptHash: string
}

export interface KeyEnvelope extends KeyEnvelopeBody {
  /** Ed25519 over canonical(transcript || envelopeBody) */
  signature: string
}

export interface RecoveryPackage {
  formatVersion: typeof SYNC_CRYPTO_FORMAT_VERSION
  kind: 'qingyu-space-key-recovery'
  spaceId: string
  keyEpoch: number
  kdf: {
    algorithm: 'scrypt'
    N: number
    r: number
    p: number
    salt: string
    dkLen: number
  }
  /** AES-256-GCM(spaceKey) under KDF(passphrase) */
  nonce: string
  ciphertext: string
  createdAt: number
  /** 轮换承诺：恢复成功后调用方必须 rotate；仅标记 */
  rotateAfterRestore: true
}

export type SyncCryptoErrorCode =
  | 'DECRYPT_FAILED'
  | 'TAG_MISMATCH'
  | 'AAD_MISMATCH'
  | 'BAD_FORMAT'
  | 'BAD_KDF_PARAMS'
  | 'WEAK_PASSPHRASE'
  | 'CROSS_SPACE'
  | 'SIGNATURE_INVALID'
  | 'EXPIRED'
  | 'FAIL_CLOSED'

export class SyncCryptoError extends Error {
  constructor(
    readonly code: SyncCryptoErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'SyncCryptoError'
  }
}

/** 恢复包 scrypt 最低参数（低于此拒绝导入） */
export const RECOVERY_KDF_MIN = { N: 1 << 15, r: 8, p: 1, dkLen: 32 } as const
/** 导出推荐参数 */
export const RECOVERY_KDF_RECOMMENDED = { N: 1 << 18, r: 8, p: 1, dkLen: 32 } as const

/** 口令最低强度：长度 ≥ 12 且至少含 2 类字符（导出侧检查） */
export const RECOVERY_PASSPHRASE_MIN_LENGTH = 12

export function assertPassphraseStrength(passphrase: string): void {
  if (passphrase.length < RECOVERY_PASSPHRASE_MIN_LENGTH) {
    throw new SyncCryptoError('WEAK_PASSPHRASE', `口令长度必须 ≥ ${RECOVERY_PASSPHRASE_MIN_LENGTH}`)
  }
  let classes = 0
  if (/[a-z]/.test(passphrase)) classes++
  if (/[A-Z]/.test(passphrase)) classes++
  if (/[0-9]/.test(passphrase)) classes++
  if (/[^a-zA-Z0-9]/.test(passphrase)) classes++
  if (classes < 2) {
    throw new SyncCryptoError('WEAK_PASSPHRASE', '口令至少包含 2 类字符')
  }
}
