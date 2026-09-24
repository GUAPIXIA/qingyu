/**
 * S8-02：新设备密钥信封格式与校验（纯逻辑；ECDH/签名在边缘）。
 *
 * 流程（方案 §S8-02）：
 * 1. 新设备登记 deviceId/publicKeys/nonce/expiry，用户带外核对 SAS；
 * 2. 已授权设备 ECDH + HKDF 得封装密钥，AES-GCM 加密 spaceKey；
 * 3. 批准设备 Ed25519 签署完整 envelope/transcript；
 * 4. 服务端只存不透明签名信封；替换公钥后客户端必须拒绝；
 * 5. 新设备验签、解封、Keystore 保存，再用 challenge 证明可解密。
 */
import { createHash, hkdfSync } from 'node:crypto'
import { canonicalize } from '../contracts/canonical-json'
import { deriveSubkey, hmacSha256 } from './kdf'
import {
  GCM_NONCE_BYTES,
  GCM_TAG_BITS,
  GCM_TAG_BYTES,
  SPACE_KEY_BYTES,
  SYNC_CRYPTO_FORMAT_VERSION,
  SyncCryptoError,
  type KeyEnvelope,
  type KeyEnvelopeBody,
} from './types'

export const KEY_ENVELOPE_TRANSCRIPT_DOMAIN = 'qingyu-key-envelope/v1'

export interface KeyEnvelopeTranscriptInput {
  spaceId: string
  keyEpoch: number
  recipientDeviceId: string
  recipientX25519PublicKey: string
  approverDeviceId: string
  approverX25519PublicKey: string
  approverEd25519PublicKey: string
  nonce: string
  expiresAt: number
}

/** transcript 规范串（两端一致；SAS 与封装密钥共同输入） */
export function buildKeyEnvelopeTranscript(input: KeyEnvelopeTranscriptInput): string {
  return canonicalize({
    domain: KEY_ENVELOPE_TRANSCRIPT_DOMAIN,
    ...input,
  } as never)
}

export function keyEnvelopeTranscriptHash(transcript: string): string {
  return `sha256:${createHash('sha256').update(transcript, 'utf8').digest('hex')}`
}

/** 短认证串：与 LAN 同构——transcriptHash 前 3 字节 → 6 位十进制 */
export function deriveKeyEnvelopeSas(transcript: string): string {
  const digest = createHash('sha256').update(transcript, 'utf8').digest()
  const n = ((digest[0]! << 16) | (digest[1]! << 8) | digest[2]!) % 1_000_000
  return n.toString().padStart(6, '0')
}

/** 封装密钥 = HKDF(ECDH sharedSecret, info=key-envelope|transcriptHash) */
export function deriveKeyEnvelopeWrapKey(input: {
  sharedSecret: Uint8Array
  transcript: string
}): Buffer {
  const th = keyEnvelopeTranscriptHash(input.transcript)
  return Buffer.from(
    hkdfSync(
      'sha256',
      Buffer.from(input.sharedSecret),
      Buffer.from(KEY_ENVELOPE_TRANSCRIPT_DOMAIN, 'utf8'),
      Buffer.from(`${KEY_ENVELOPE_TRANSCRIPT_DOMAIN}|wrap|${th}`, 'utf8'),
      32,
    ),
  )
}

/** 信封签名载荷 = canonical(transcript || body 无 signature) */
export function keyEnvelopeSigningBytes(transcript: string, body: KeyEnvelopeBody): Buffer {
  return Buffer.from(
    `${transcript}\n${canonicalize(body as never)}`,
    'utf8',
  )
}

export function buildKeyEnvelopeBody(input: {
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
}): KeyEnvelopeBody {
  return {
    formatVersion: SYNC_CRYPTO_FORMAT_VERSION,
    spaceId: input.spaceId,
    keyEpoch: input.keyEpoch,
    recipientDeviceId: input.recipientDeviceId,
    recipientX25519PublicKey: input.recipientX25519PublicKey,
    approverDeviceId: input.approverDeviceId,
    approverX25519PublicKey: input.approverX25519PublicKey,
    approverEd25519PublicKey: input.approverEd25519PublicKey,
    nonce: input.nonce,
    expiresAt: input.expiresAt,
    wrappedNonce: input.wrappedNonce,
    wrappedKey: input.wrappedKey,
    transcriptHash: input.transcriptHash,
  }
}

/**
 * 组装待签信封（wrapped 字段由边缘加密后传入）。
 * verify 时重建 transcript 并比对 transcriptHash + 签名。
 */
export function assembleKeyEnvelope(input: {
  body: KeyEnvelopeBody
  signature: string
}): KeyEnvelope {
  return { ...input.body, signature: input.signature }
}

export function verifyKeyEnvelopeStructure(input: {
  envelope: KeyEnvelope
  now: number
  expected: KeyEnvelopeTranscriptInput
}): { ok: true; transcript: string } | { ok: false; reason: 'TRANSCRIPT_MISMATCH' | 'EXPIRED' | 'BAD_FORMAT' | 'CROSS_SPACE' } {
  const e = input.envelope
  if (e.formatVersion !== SYNC_CRYPTO_FORMAT_VERSION) return { ok: false, reason: 'BAD_FORMAT' }
  if (e.expiresAt <= input.now) return { ok: false, reason: 'EXPIRED' }
  if (e.spaceId !== input.expected.spaceId) return { ok: false, reason: 'CROSS_SPACE' }
  const transcript = buildKeyEnvelopeTranscript(input.expected)
  const th = keyEnvelopeTranscriptHash(transcript)
  if (th !== e.transcriptHash) return { ok: false, reason: 'TRANSCRIPT_MISMATCH' }
  // 公钥/设备绑定必须与 transcript 一致（防服务端替换目标公钥）
  if (
    e.recipientDeviceId !== input.expected.recipientDeviceId ||
    e.recipientX25519PublicKey !== input.expected.recipientX25519PublicKey ||
    e.approverDeviceId !== input.expected.approverDeviceId ||
    e.approverX25519PublicKey !== input.expected.approverX25519PublicKey ||
    e.approverEd25519PublicKey !== input.expected.approverEd25519PublicKey ||
    e.nonce !== input.expected.nonce
  ) {
    return { ok: false, reason: 'TRANSCRIPT_MISMATCH' }
  }
  return { ok: true, transcript }
}

/**
 * 解封 spaceKey（wrapKey 与 AES 边缘完成；此处校验长度）。
 * 签名验证必须在调用本函数前完成。
 */
export function unwrapSpaceKeyMaterial(wrappedPlain: Uint8Array): Uint8Array {
  if (wrappedPlain.length !== SPACE_KEY_BYTES) {
    throw new SyncCryptoError('BAD_FORMAT', '解封后 spaceKey 长度非法')
  }
  return wrappedPlain
}

/**
 * challenge 证明：HMAC(challenge subkey, challenge)。
 * 新设备解封后应答，服务端/批准设备核对（证明持有 spaceKey）。
 */
export function computeChallengeProof(spaceKey: Uint8Array, challenge: string): string {
  const key = deriveSubkey(spaceKey, 'challenge')
  return hmacSha256(key, challenge).toString('base64')
}

export function verifyChallengeProof(input: {
  spaceKey: Uint8Array
  challenge: string
  proof: string
}): boolean {
  const expect = computeChallengeProof(input.spaceKey, input.challenge)
  return expect === input.proof
}

/** 辅助：wrapped 空间密钥的 AAD（绑定 transcriptHash，防剥离重放） */
export function keyEnvelopeWrapAad(transcriptHash: string): string {
  return `${KEY_ENVELOPE_TRANSCRIPT_DOMAIN}|wrap-aad|${transcriptHash}`
}

export function assertNonceLength(nonceB64: string): void {
  const n = Buffer.from(nonceB64, 'base64')
  if (n.length !== GCM_NONCE_BYTES) {
    throw new SyncCryptoError('BAD_FORMAT', 'wrappedNonce 必须 12 字节')
  }
}

export function assertWrappedKeyLength(ciphertextB64: string): void {
  const c = Buffer.from(ciphertextB64, 'base64')
  if (c.length < SPACE_KEY_BYTES + GCM_TAG_BYTES) {
    throw new SyncCryptoError('BAD_FORMAT', 'wrappedKey 长度非法')
  }
}
