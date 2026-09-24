/**
 * S8-03：push/plan 纯校验逻辑（不触网、不触库）。
 * 服务端不解密 payload；只验元数据、版本向量结构、hash 形状与授权约束。
 */
import {
  SYNC_BATCH_MAX_BYTES,
  SYNC_BATCH_MAX_ITEMS,
  type SyncErrorCode,
  type WireEntity,
} from './types.js'

export interface ValidationError {
  code: SyncErrorCode
  message: string
  retryable: boolean
}

export type ValidationResult = { ok: true } | { ok: false; error: ValidationError }

const COUNTER_RE = /^(0|[1-9][0-9]*)$/
const HASH_RE = /^sha256:[0-9a-f]{64}$/
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/

function fail(code: SyncErrorCode, message: string, retryable = false): ValidationResult {
  return { ok: false, error: { code, message, retryable } }
}

/** 版本向量：counter 无前导零十进制，不经 JS number 有损转换 */
export function validateVersionVector(version: unknown): ValidationResult {
  if (version === null || typeof version !== 'object' || Array.isArray(version)) {
    return fail('BAD_VERSION_VECTOR', 'version 必须是对象')
  }
  for (const [device, counter] of Object.entries(version as Record<string, unknown>)) {
    if (!device || device.length > 128) return fail('BAD_VERSION_VECTOR', 'deviceId 非法')
    if (typeof counter !== 'string' || !COUNTER_RE.test(counter)) {
      return fail('BAD_VERSION_VECTOR', `counter 必须是无前导零十进制字符串: ${device}`)
    }
    if (counter.length > 20) return fail('BAD_VERSION_VECTOR', 'counter 过长')
    // 拒绝 JS number 有损形态（科学计数等已由正则排除）与 UInt64 溢出
    if (String(BigInt(counter)) !== counter) return fail('BAD_VERSION_VECTOR', 'counter 规范形态非法')
    if (BigInt(counter) > (1n << 64n) - 1n) return fail('BAD_VERSION_VECTOR', 'counter 溢出 UInt64')
  }
  return { ok: true }
}

export interface ReencryptOpt {
  fromKeyEpoch: number
  toKeyEpoch: number
}

export function validateDot(dot: unknown, authenticatedDeviceId: string, opts: { reencrypt?: ReencryptOpt }): ValidationResult {
  if (!dot || typeof dot !== 'object') return fail('BAD_ENVELOPE', 'dot 缺失')
  const d = dot as { deviceId?: unknown; counter?: unknown }
  if (typeof d.deviceId !== 'string' || typeof d.counter !== 'string') {
    return fail('BAD_ENVELOPE', 'dot 结构非法')
  }
  if (!COUNTER_RE.test(d.counter) || String(BigInt(d.counter)) !== d.counter) {
    return fail('DOT_COUNTER_REGRESSION', 'dot.counter 规范形态非法')
  }
  // 重加密批次不得伪造业务 dot
  if (!opts.reencrypt && d.deviceId !== authenticatedDeviceId) {
    return fail('DOT_DEVICE_MISMATCH', 'dot.deviceId 必须等于已认证设备')
  }
  return { ok: true }
}

export function validateWireEntity(
  entity: unknown,
  authenticatedDeviceId: string,
  opts: { reencrypt?: ReencryptOpt; maxBlobBytes: number },
): ValidationResult {
  if (!entity || typeof entity !== 'object') return fail('BAD_ENVELOPE', 'envelope 必须是对象')
  const e = entity as Partial<WireEntity>
  if (typeof e.entityType !== 'string' || !e.entityType || e.entityType.length > 64) {
    return fail('BAD_ENVELOPE', 'entityType 非法')
  }
  if (typeof e.entityId !== 'string' || !e.entityId || e.entityId.length > 128) {
    return fail('BAD_ENVELOPE', 'entityId 非法')
  }
  if (e.parentId !== null && e.parentId !== undefined && typeof e.parentId !== 'string') {
    return fail('BAD_ENVELOPE', 'parentId 非法')
  }
  if (typeof e.schemaVersion !== 'number' || !Number.isInteger(e.schemaVersion) || e.schemaVersion < 1) {
    return fail('SCHEMA_UNSUPPORTED', 'schemaVersion 非法')
  }
  const vv = validateVersionVector(e.version)
  if (!vv.ok) return vv
  if (typeof e.versionHash !== 'string' || !HASH_RE.test(e.versionHash)) {
    return fail('HASH_MISMATCH', 'versionHash 形状非法')
  }
  const dot = validateDot(e.dot, authenticatedDeviceId, opts)
  if (!dot.ok) return dot
  if (typeof e.deleted !== 'boolean') return fail('BAD_ENVELOPE', 'deleted 必须是布尔')
  if (typeof e.updatedAt !== 'number' || !Number.isFinite(e.updatedAt)) {
    return fail('BAD_ENVELOPE', 'updatedAt 非法')
  }
  if (typeof e.keyEpoch !== 'number' || !Number.isInteger(e.keyEpoch) || e.keyEpoch < 1) {
    return fail('BAD_ENVELOPE', 'keyEpoch 非法')
  }
  if (typeof e.cipherRevision !== 'number' || !Number.isInteger(e.cipherRevision) || e.cipherRevision < 1) {
    return fail('BAD_ENVELOPE', 'cipherRevision 非法')
  }
  // 重加密：toKeyEpoch 必须与 envelope 一致
  if (opts.reencrypt && e.keyEpoch !== opts.reencrypt.toKeyEpoch) {
    return fail('REENTCRYPT_FORBIDDEN', '重加密批次 keyEpoch 必须等于目标 epoch')
  }
  if (typeof e.cipherHash !== 'string' || !HASH_RE.test(e.cipherHash)) {
    return fail('HASH_MISMATCH', 'cipherHash 形状非法')
  }
  if (typeof e.contentTag !== 'string' || !e.contentTag || e.contentTag.length > 128) {
    return fail('BAD_ENVELOPE', 'contentTag 非法')
  }
  const hasCipher = typeof e.ciphertext === 'string' && e.ciphertext.length > 0
  const hasBlob = typeof e.blobManifestId === 'string' && e.blobManifestId.length > 0
  if (hasCipher === hasBlob) {
    return fail('BAD_ENVELOPE', 'ciphertext 与 blobManifestId 必须恰好其一')
  }
  if (hasCipher) {
    const raw = Buffer.from(e.ciphertext!, 'base64')
    if (!BASE64_RE.test(e.ciphertext!)) return fail('BAD_ENVELOPE', 'ciphertext 非 base64')
    if (raw.length > 32 * 1024) return fail('BATCH_TOO_LARGE', '小实体密文超过 32KiB，请走 blob')
    if (raw.length < 16) return fail('BAD_ENVELOPE', 'ciphertext 过短')
  }
  if (hasBlob && e.blobManifestId!.length > 128) {
    return fail('BAD_ENVELOPE', 'blobManifestId 非法')
  }
  return { ok: true }
}

export function validatePushBatch(
  envelopes: unknown,
  authenticatedDeviceId: string,
  opts: { reencrypt?: { fromKeyEpoch: number; toKeyEpoch: number }; maxBlobBytes?: number },
): ValidationResult {
  if (!Array.isArray(envelopes)) return fail('BAD_ENVELOPE', 'envelopes 必须是数组')
  if (envelopes.length === 0) return fail('BAD_ENVELOPE', 'envelopes 不能为空')
  if (envelopes.length > SYNC_BATCH_MAX_ITEMS) {
    return fail('BATCH_TOO_LARGE', `单批最多 ${SYNC_BATCH_MAX_ITEMS} 条`)
  }
  let bytes = 0
  const seen = new Set<string>()
  for (const raw of envelopes) {
    const r = validateWireEntity(raw, authenticatedDeviceId, {
      maxBlobBytes: opts.maxBlobBytes ?? 64 * 1024 * 1024,
      ...(opts.reencrypt ? { reencrypt: opts.reencrypt } : {}),
    })
    if (!r.ok) return r
    const e = raw as WireEntity
    const key = `${e.entityType}|${e.entityId}|${e.versionHash}|${e.keyEpoch}|${e.cipherRevision}`
    if (seen.has(key)) return fail('BAD_ENVELOPE', '同一 batch 内重复实体版本')
    seen.add(key)
    if (e.ciphertext) bytes += Buffer.from(e.ciphertext, 'base64').length
    if (bytes > SYNC_BATCH_MAX_BYTES) {
      return fail('BATCH_TOO_LARGE', `单批密文超过 ${SYNC_BATCH_MAX_BYTES} 字节`)
    }
  }
  return { ok: true }
}

/**
 * 业务 versionHash 与 version 规范哈希一致性（服务端可复算，不解密 payload）。
 * versionHash = sha256(canonical(version JSON))
 */
export function expectedVersionHash(canonicalVersionJson: string, sha256HexUtf8: (s: string) => string): string {
  return `sha256:${sha256HexUtf8(canonicalVersionJson)}`
}

/** 幂等：同 batchId 重试必须同 requestHash */
export function requestFingerprint(batchId: string, envelopes: readonly WireEntity[]): string {
  const body = JSON.stringify({
    batchId,
    items: envelopes.map((e) => ({
      t: e.entityType,
      i: e.entityId,
      v: e.versionHash,
      k: e.keyEpoch,
      c: e.cipherRevision,
      h: e.cipherHash,
    })),
  })
  // 不依赖 crypto，调用方注入哈希；此处用长度+简单 FNV 仅作结构键，真实 hash 在路由层用 sha256
  return body
}

export function isValidBatchId(batchId: unknown): batchId is string {
  return typeof batchId === 'string' && batchId.length >= 8 && batchId.length <= 64 && /^[A-Za-z0-9_-]+$/.test(batchId)
}

export function isValidCursor(cursor: unknown): cursor is string {
  return typeof cursor === 'string' && /^[0-9]+$/.test(cursor) && cursor.length <= 20
}
