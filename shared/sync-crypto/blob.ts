/**
 * S8-01：blob 分块加密 + manifest。
 *
 * - 固定明文分块上限；每块独立 nonce/AES-256-GCM；
 * - manifest 记录每块密文哈希与明文总哈希；
 * - manifest 自身加密；manifestHash 对规范 manifest body 计算（签名输入）。
 */
import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { canonicalize } from '../contracts/canonical-json'
import { deriveSubkey, hmacSha256 } from './kdf'
import {
  GCM_NONCE_BYTES,
  GCM_TAG_BITS,
  SYNC_CRYPTO_FORMAT_VERSION,
  SyncCryptoError,
  type BlobManifest,
  type EncryptedBlobChunk,
  type EncryptedBlobManifest,
} from './types'

/** 明文块上限 1 MiB（方案：固定上限分块） */
export const BLOB_CHUNK_PLAIN_MAX = 1024 * 1024

export function plainHashOf(data: Uint8Array): string {
  return `sha256:${createHash('sha256').update(data).digest('hex')}`
}

export function blobIdFromPlainHash(plainHash: string): string {
  return plainHash
}

export function chunkAad(input: {
  spaceId: string
  blobId: string
  keyEpoch: number
  cipherRevision: number
  index: number
}): string {
  return [
    'qingyu-blob-chunk-aad/v1',
    input.spaceId,
    input.blobId,
    String(input.keyEpoch),
    String(input.cipherRevision),
    String(input.index),
  ].join('|')
}

export function encryptBlob(input: {
  spaceKey: Uint8Array
  spaceId: string
  data: Uint8Array
  keyEpoch?: number
  cipherRevision?: number
  chunkPlaintextSize?: number
  /** 测试用确定性 nonce 派生；生产必须省略 */
  deterministicNonceForTest?: boolean
}): { chunks: EncryptedBlobChunk[]; manifest: BlobManifest; encryptedManifest: EncryptedBlobManifest } {
  const keyEpoch = input.keyEpoch ?? 1
  const cipherRevision = input.cipherRevision ?? 1
  const chunkSize = input.chunkPlaintextSize ?? BLOB_CHUNK_PLAIN_MAX
  if (chunkSize <= 0 || chunkSize > BLOB_CHUNK_PLAIN_MAX) {
    throw new SyncCryptoError('BAD_FORMAT', 'chunkPlaintextSize 非法')
  }
  const plainHash = plainHashOf(input.data)
  const blobId = blobIdFromPlainHash(plainHash)
  const chunkKey = deriveSubkey(input.spaceKey, 'blob-chunk')
  const chunks: EncryptedBlobChunk[] = []
  const manifestChunks: BlobManifest['chunks'] = []
  for (let index = 0, offset = 0; offset < input.data.length || (index === 0 && input.data.length === 0); index++) {
    const end = Math.min(offset + chunkSize, input.data.length)
    const slice = Buffer.from(input.data.subarray(offset, end))
    offset = end
    const nonce = input.deterministicNonceForTest
      ? Buffer.from(createHash('sha256').update(Buffer.from(`${blobId}|${keyEpoch}|${cipherRevision}|${index}`)).digest().subarray(0, GCM_NONCE_BYTES))
      : randomBytes(GCM_NONCE_BYTES)
    const aad = Buffer.from(
      chunkAad({ spaceId: input.spaceId, blobId, keyEpoch, cipherRevision, index }),
      'utf8',
    )
    const cipher = createCipheriv('aes-256-gcm', chunkKey, nonce)
    cipher.setAAD(aad, { plaintextLength: slice.length })
    const body = Buffer.concat([cipher.update(slice), cipher.final()])
    const tag = cipher.getAuthTag()
    const ciphertext = Buffer.concat([body, tag])
    chunks.push({
      index,
      nonce: nonce.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
      cipherHash: `sha256:${createHash('sha256').update(ciphertext).digest('hex')}`,
      plainLength: slice.length,
    })
    manifestChunks.push({
      index,
      cipherHash: `sha256:${createHash('sha256').update(ciphertext).digest('hex')}`,
      plainLength: slice.length,
    })
    if (input.data.length === 0) break
  }
  const manifestBody: Omit<BlobManifest, 'manifestHash'> = {
    formatVersion: SYNC_CRYPTO_FORMAT_VERSION,
    blobId,
    keyEpoch,
    cipherRevision,
    chunkPlaintextSize: chunkSize,
    plainTotalLength: input.data.length,
    plainHash,
    chunks: manifestChunks,
  }
  const manifestHash = `sha256:${createHash('sha256').update(canonicalize(manifestBody as never), 'utf8').digest('hex')}`
  const manifest: BlobManifest = { ...manifestBody, manifestHash }
  const encryptedManifest = encryptManifest({
    spaceKey: input.spaceKey,
    spaceId: input.spaceId,
    blobId,
    keyEpoch,
    cipherRevision,
    manifest,
  })
  return { chunks, manifest, encryptedManifest }
}

export function encryptManifest(input: {
  spaceKey: Uint8Array
  spaceId: string
  blobId: string
  keyEpoch: number
  cipherRevision: number
  manifest: BlobManifest
  nonce?: Uint8Array
}): EncryptedBlobManifest {
  const key = deriveSubkey(input.spaceKey, 'blob-manifest')
  const nonce = input.nonce ? Buffer.from(input.nonce) : randomBytes(GCM_NONCE_BYTES)
  const aad = Buffer.from(
    `qingyu-blob-manifest-aad/v1|${input.spaceId}|${input.blobId}|${input.keyEpoch}|${input.cipherRevision}`,
    'utf8',
  )
  const plain = Buffer.from(canonicalize(input.manifest as never), 'utf8')
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(aad, { plaintextLength: plain.length })
  const body = Buffer.concat([cipher.update(plain), cipher.final()])
  const tag = cipher.getAuthTag()
  const ciphertext = Buffer.concat([body, tag])
  return {
    formatVersion: SYNC_CRYPTO_FORMAT_VERSION,
    keyEpoch: input.keyEpoch,
    cipherRevision: input.cipherRevision,
    nonce: nonce.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    cipherHash: `sha256:${createHash('sha256').update(ciphertext).digest('hex')}`,
  }
}

export function decryptManifest(input: {
  spaceKey: Uint8Array
  spaceId: string
  blobId: string
  encryptedManifest: EncryptedBlobManifest
}): BlobManifest {
  const key = deriveSubkey(input.spaceKey, 'blob-manifest')
  const nonce = Buffer.from(input.encryptedManifest.nonce, 'base64')
  const ciphertext = Buffer.from(input.encryptedManifest.ciphertext, 'base64')
  const body = ciphertext.subarray(0, ciphertext.length - GCM_TAG_BITS / 8)
  const tag = ciphertext.subarray(ciphertext.length - GCM_TAG_BITS / 8)
  const aad = Buffer.from(
    `qingyu-blob-manifest-aad/v1|${input.spaceId}|${input.blobId}|${input.encryptedManifest.keyEpoch}|${input.encryptedManifest.cipherRevision}`,
    'utf8',
  )
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce)
    decipher.setAAD(aad, { plaintextLength: body.length })
    decipher.setAuthTag(tag)
    const plain = Buffer.concat([decipher.update(body), decipher.final()])
    const manifest = JSON.parse(plain.toString('utf8')) as BlobManifest
    const { manifestHash, ...rest } = manifest
    const expect = `sha256:${createHash('sha256').update(canonicalize(rest as never), 'utf8').digest('hex')}`
    if (manifestHash !== expect) {
      throw new SyncCryptoError('BAD_FORMAT', 'manifestHash 不匹配')
    }
    return manifest
  } catch (error) {
    if (error instanceof SyncCryptoError) throw error
    throw new SyncCryptoError('DECRYPT_FAILED', 'manifest 解密失败')
  }
}

export function decryptBlobChunk(input: {
  spaceKey: Uint8Array
  spaceId: string
  blobId: string
  keyEpoch: number
  cipherRevision: number
  chunk: EncryptedBlobChunk
}): Buffer {
  const key = deriveSubkey(input.spaceKey, 'blob-chunk')
  const nonce = Buffer.from(input.chunk.nonce, 'base64')
  const ciphertext = Buffer.from(input.chunk.ciphertext, 'base64')
  const body = ciphertext.subarray(0, ciphertext.length - GCM_TAG_BITS / 8)
  const tag = ciphertext.subarray(ciphertext.length - GCM_TAG_BITS / 8)
  const aad = Buffer.from(
    chunkAad({
      spaceId: input.spaceId,
      blobId: input.blobId,
      keyEpoch: input.keyEpoch,
      cipherRevision: input.cipherRevision,
      index: input.chunk.index,
    }),
    'utf8',
  )
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce)
    decipher.setAAD(aad, { plaintextLength: body.length })
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(body), decipher.final()])
  } catch {
    throw new SyncCryptoError('DECRYPT_FAILED', 'blob 块解密失败')
  }
}

export function decryptBlob(input: {
  spaceKey: Uint8Array
  spaceId: string
  /** 明文总哈希（sha256:<hex>），与 blobId 相同 */
  blobId: string
  encryptedManifest: EncryptedBlobManifest
  chunks: EncryptedBlobChunk[]
}): Buffer {
  const manifest = decryptManifest(input)
  const byIndex = new Map(input.chunks.map((c) => [c.index, c]))
  const parts: Buffer[] = []
  for (const meta of manifest.chunks) {
    const chunk = byIndex.get(meta.index)
    if (!chunk) throw new SyncCryptoError('BAD_FORMAT', `缺少 blob 块 ${meta.index}`)
    const plain = decryptBlobChunk({
      spaceKey: input.spaceKey,
      spaceId: input.spaceId,
      blobId: manifest.blobId,
      keyEpoch: manifest.keyEpoch,
      cipherRevision: manifest.cipherRevision,
      chunk,
    })
    if (plain.length !== meta.plainLength) {
      throw new SyncCryptoError('BAD_FORMAT', '块明文长度与 manifest 不符')
    }
    parts.push(plain)
  }
  const data = Buffer.concat(parts)
  if (data.length !== manifest.plainTotalLength || plainHashOf(data) !== manifest.plainHash) {
    throw new SyncCryptoError('TAG_MISMATCH', 'blob 明文总哈希与 manifest 不符')
  }
  return data
}

/** manifest 签名载荷：canonical(manifest 无 manifestHash) 的 UTF-8 字节 */
export function manifestSigningBytes(manifest: BlobManifest): Buffer {
  const { manifestHash: _ignored, ...rest } = manifest
  return Buffer.from(canonicalize(rest as never), 'utf8')
}

/** 设备对 manifest 签名（Ed25519 私钥由调用方持有） */
export function manifestSignatureMacForTest(spaceKey: Uint8Array, manifest: BlobManifest): string {
  // 仅测试向量：生产必须用 Ed25519；此处用 HMAC(receipt subkey) 占位对齐格式字段
  const key = deriveSubkey(spaceKey, 'receipt')
  return hmacSha256(key, manifestSigningBytes(manifest)).toString('base64')
}
