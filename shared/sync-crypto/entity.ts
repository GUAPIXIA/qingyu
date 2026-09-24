/**
 * S8-01：实体 payload 加解密（AES-256-GCM）与 contentTag。
 *
 * - 每条记录独立随机 nonce；
 * - AAD 绑定空间/实体身份/schema/versionHash/keyEpoch/cipherRevision；
 * - 重加密只增 cipherRevision（AAD 变化 → 新密文实例），不改业务 version/dot/contentHash；
 * - 密码失败 fail closed。
 */
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto'
import { canonicalize, contentHash as computeContentHash, type CanonicalJsonValue } from '../contracts/canonical-json'
import { deriveSubkey, computeContentTag } from './kdf'
import {
  CIPHER_REVISION_START,
  GCM_NONCE_BYTES,
  GCM_TAG_BITS,
  KEY_EPOCH_START,
  SYNC_CRYPTO_FORMAT_VERSION,
  SyncCryptoError,
  type EncryptedEntity,
  type EntityAadInput,
} from './types'

/** AAD 规范串：字段顺序固定，两端逐字节一致 */
export function buildEntityAad(input: EntityAadInput): string {
  return [
    'qingyu-entity-aad/v1',
    input.spaceId,
    input.entityType,
    input.entityId,
    String(input.schemaVersion),
    input.versionHash,
    String(input.keyEpoch),
    String(input.cipherRevision),
  ].join('|')
}

export function cipherHashOf(ciphertext: Buffer): string {
  return `sha256:${createHash('sha256').update(ciphertext).digest('hex')}`
}

export interface EncryptEntityInput {
  spaceKey: Uint8Array
  /** AAD 输入对象，或已规范化的 AAD 字符串（与 Kotlin 对齐，禁止二次包装） */
  aad: EntityAadInput | string
  payload: CanonicalJsonValue
  contentHash: string
  /** 测试注 nonce；生产必须省略并用 CSPRNG */
  nonce?: Uint8Array
}

function resolveAad(aad: EntityAadInput | string): { text: string; meta: EntityAadInput | null } {
  if (typeof aad === 'string') {
    return { text: aad, meta: null }
  }
  return { text: buildEntityAad(aad), meta: aad }
}

function metaFromAadString(aad: string): Pick<EntityAadInput, 'entityType' | 'entityId' | 'keyEpoch' | 'cipherRevision'> {
  // AAD 格式: domain|spaceId|entityType|entityId|schemaVersion|versionHash|keyEpoch|cipherRevision
  const parts = aad.split('|')
  return {
    entityType: parts[2] ?? '',
    entityId: parts[3] ?? '',
    keyEpoch: Number(parts[6] ?? '1'),
    cipherRevision: Number(parts[7] ?? '1'),
  }
}

export function encryptEntity(input: EncryptEntityInput): EncryptedEntity {
  const key = deriveSubkey(input.spaceKey, 'entity')
  const nonce = input.nonce ? Buffer.from(input.nonce) : randomBytes(GCM_NONCE_BYTES)
  if (nonce.length !== GCM_NONCE_BYTES) {
    throw new SyncCryptoError('BAD_FORMAT', 'nonce 必须 12 字节')
  }
  const { text: aadText, meta } = resolveAad(input.aad)
  const meta2 = meta ?? metaFromAadString(aadText)
  const plain = Buffer.from(canonicalize(input.payload), 'utf8')
  const aad = Buffer.from(aadText, 'utf8')
  try {
    // 标准 GCM：AAD 进 GHASH，长度块为 (len(AAD)||len(plain)) 比特；与 JCE 互操作
    const cipher = createCipheriv('aes-256-gcm', key, nonce)
    cipher.setAAD(aad, { plaintextLength: plain.length })
    const body = Buffer.concat([cipher.update(plain), cipher.final()])
    const tag = cipher.getAuthTag()
    const ciphertext = Buffer.concat([body, tag])
    return {
      formatVersion: SYNC_CRYPTO_FORMAT_VERSION,
      keyEpoch: meta2.keyEpoch,
      cipherRevision: meta2.cipherRevision,
      nonce: nonce.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
      cipherHash: cipherHashOf(ciphertext),
      contentTag: computeContentTag(input.spaceKey, {
        entityType: meta2.entityType,
        entityId: meta2.entityId,
        contentHash: input.contentHash,
      }),
      contentHash: input.contentHash,
    }
  } catch (error) {
    if (error instanceof SyncCryptoError) throw error
    throw new SyncCryptoError('FAIL_CLOSED', '实体加密失败，拒绝回退明文')
  }
}

export function decryptEntity(input: {
  spaceKey: Uint8Array
  aad: EntityAadInput | string
  encrypted: EncryptedEntity
}): CanonicalJsonValue {
  const key = deriveSubkey(input.spaceKey, 'entity')
  const nonce = Buffer.from(input.encrypted.nonce, 'base64')
  const ciphertext = Buffer.from(input.encrypted.ciphertext, 'base64')
  if (nonce.length !== GCM_NONCE_BYTES || ciphertext.length < GCM_TAG_BITS / 8) {
    throw new SyncCryptoError('BAD_FORMAT', '密文结构非法')
  }
  const body = ciphertext.subarray(0, ciphertext.length - GCM_TAG_BITS / 8)
  const tag = ciphertext.subarray(ciphertext.length - GCM_TAG_BITS / 8)
  const { text: aadText } = resolveAad(input.aad)
  const aad = Buffer.from(aadText, 'utf8')
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce)
    decipher.setAAD(aad, { plaintextLength: body.length })
    decipher.setAuthTag(tag)
    const plain = Buffer.concat([decipher.update(body), decipher.final()])
    return JSON.parse(plain.toString('utf8')) as CanonicalJsonValue
  } catch {
    throw new SyncCryptoError('DECRYPT_FAILED', '实体解密失败（AAD/密钥/密文不匹配）')
  }
}

/**
 * 解密后校验业务 contentHash 与 contentTag。
 * contentTag 相等但 contentHash 不同 → 安全错误，不得自动收敛。
 */
export function decryptAndVerifyEntity(input: {
  spaceKey: Uint8Array
  aad: EntityAadInput | string
  encrypted: EncryptedEntity
  expectedContentHash: string
}): CanonicalJsonValue {
  const payload = decryptEntity(input)
  const actual = computeContentHash(payload)
  if (actual !== input.expectedContentHash) {
    throw new SyncCryptoError('TAG_MISMATCH', '解密后 contentHash 与预期不符（安全错误）')
  }
  const { text: aadText, meta } = resolveAad(input.aad)
  const meta2 = meta ?? metaFromAadString(aadText)
  const tag = computeContentTag(input.spaceKey, {
    entityType: meta2.entityType,
    entityId: meta2.entityId,
    contentHash: input.expectedContentHash,
  })
  if (tag !== input.encrypted.contentTag) {
    throw new SyncCryptoError('TAG_MISMATCH', 'contentTag 与解密结果不一致')
  }
  return payload
}

export function defaultAad(partial: Omit<EntityAadInput, 'keyEpoch' | 'cipherRevision'> & {
  keyEpoch?: number
  cipherRevision?: number
}): EntityAadInput {
  return {
    ...partial,
    keyEpoch: partial.keyEpoch ?? KEY_EPOCH_START,
    cipherRevision: partial.cipherRevision ?? CIPHER_REVISION_START,
  }
}
