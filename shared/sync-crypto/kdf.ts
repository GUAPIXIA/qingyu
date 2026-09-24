/**
 * S8-01：HKDF-SHA-256 子密钥派生。info 固定并版本化。
 */
import { createHash, createHmac, hkdfSync } from 'node:crypto'
import { SPACE_KEY_BYTES, SUBKEY_INFO_VERSION, type SubkeyPurpose, SyncCryptoError } from './types'

export function assertSpaceKey(spaceKey: Uint8Array): void {
  if (spaceKey.length !== SPACE_KEY_BYTES) {
    throw new SyncCryptoError('BAD_FORMAT', `spaceKey 必须是 ${SPACE_KEY_BYTES} 字节`)
  }
}

/** 版本化 info：`qingyu-sync-crypto/v{N}|{purpose}` */
export function subkeyInfo(purpose: SubkeyPurpose): string {
  return `qingyu-sync-crypto/v${SUBKEY_INFO_VERSION}|${purpose}`
}

/**
 * 从 spaceKey 派生 32 字节子密钥。
 * salt 固定域常量（与 LAN 会话密钥隔离）。
 */
export function deriveSubkey(spaceKey: Uint8Array, purpose: SubkeyPurpose): Buffer {
  assertSpaceKey(spaceKey)
  const salt = Buffer.from('qingyu-sync-crypto/subkey/v1', 'utf8')
  return Buffer.from(
    hkdfSync('sha256', Buffer.from(spaceKey), salt, Buffer.from(subkeyInfo(purpose), 'utf8'), 32),
  )
}

/** HMAC-SHA-256 */
export function hmacSha256(key: Uint8Array, message: Uint8Array | string): Buffer {
  return createHmac('sha256', Buffer.from(key)).update(typeof message === 'string' ? Buffer.from(message, 'utf8') : Buffer.from(message)).digest()
}

/**
 * contentTag = HMAC(content-dedupe subkey, entityType/entityId/contentHash)
 * 服务端只比较相等；客户端解密后必须重算 contentHash。
 */
export function computeContentTag(
  spaceKey: Uint8Array,
  input: { entityType: string; entityId: string; contentHash: string },
): string {
  const key = deriveSubkey(spaceKey, 'content-dedupe')
  const msg = `${input.entityType}|${input.entityId}|${input.contentHash}`
  return hmacSha256(key, msg).toString('base64')
}

/** versionHash = sha256(canonical version vector JSON)，格式 sha256:<hex> */
export function versionHashFromCanonical(canonicalVectorJson: string): string {
  return `sha256:${createHash('sha256').update(canonicalVectorJson, 'utf8').digest('hex')}`
}
