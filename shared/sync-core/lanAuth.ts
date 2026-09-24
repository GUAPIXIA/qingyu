/**
 * 阶段 7 S7-03：LAN 一次性授权纯逻辑——跨端共享、无副作用。
 *
 * 禁止访问网络、磁盘、时钟和随机数；密钥/secret/now 均由调用方注入。
 * ECDH 在边缘完成，本层只消费 sharedSecret 字节；HKDF/哈希为确定性计算。
 *
 * 契约要点（方案 §S7-03）：
 * - 临时 X25519 + 256 位一次性 secret，TTL 5 分钟，scope 仅 `sync`；
 * - QR 含协议版本、host/port、sessionId、PC 临时公钥、secret、过期、指纹；
 * - 短认证串由完整 transcript 派生，两端必须一致；
 * - 会话密钥 = HKDF(ECDH sharedSecret, transcript)；
 * - 不得复用 Bridge JWT。
 */
import { createHash, hkdfSync } from 'node:crypto'
import { canonicalize } from '../contracts/canonical-json'

/** 一次性授权窗口 TTL（方案：5 分钟） */
export const LAN_SYNC_AUTH_TTL_MS = 5 * 60 * 1000
/** 会话 scope：仅同步，不得扩权为聊天/设置 */
export const LAN_SYNC_SCOPE = 'sync' as const
export type LanSyncScope = typeof LAN_SYNC_SCOPE

export const LAN_SYNC_QR_VERSION = 1
export const LAN_SYNC_QR_SCHEME = 'qingyu-sync-auth'
/** transcript 域分隔，防跨协议重放 */
export const LAN_AUTH_TRANSCRIPT_DOMAIN = 'qingyu-sync-auth/v1'

/** 256 位一次性 secret（base64，32 字节） */
export type LanAuthSecretB64 = string
/** X25519 公钥 raw 32 字节的 base64 */
export type LanAuthPublicKeyB64 = string

export interface LanSyncQrPayload {
  version: typeof LAN_SYNC_QR_VERSION
  scheme: typeof LAN_SYNC_QR_SCHEME
  protocolVersion: number
  host: string
  port: number
  sessionId: string
  /** PC 临时 X25519 公钥（raw 32B base64） */
  pcPublicKey: LanAuthPublicKeyB64
  secret: LanAuthSecretB64
  /** 到期时间戳 ms；过期扫码必须拒绝 */
  expiresAt: number
  /** 服务器身份指纹（展示核对，非密钥） */
  fingerprint: string
  displayName: string
  scope: LanSyncScope
}

export type ParsedLanSyncQr =
  | { kind: 'ok'; payload: LanSyncQrPayload }
  | { kind: 'invalid'; reason: LanSyncQrInvalidReason }

export type LanSyncQrInvalidReason =
  | 'not_json'
  | 'unknown_scheme'
  | 'unsupported_version'
  | 'missing_sessionId'
  | 'missing_pcPublicKey'
  | 'missing_secret'
  | 'missing_endpoints'
  | 'bad_scope'
  | 'expired'

export interface LanAuthTranscriptInput {
  sessionId: string
  host: string
  port: number
  fingerprint: string
  expiresAt: number
  secret: LanAuthSecretB64
  pcPublicKey: LanAuthPublicKeyB64
  androidPublicKey: LanAuthPublicKeyB64
  protocolVersion?: number
  scope?: LanSyncScope
}

/** 规范 transcript 对象（字段固定，供 canonicalize 与 golden） */
function transcriptObject(input: LanAuthTranscriptInput): Record<string, string | number> {
  return {
    domain: LAN_AUTH_TRANSCRIPT_DOMAIN,
    protocolVersion: input.protocolVersion ?? LAN_SYNC_QR_VERSION,
    scope: input.scope ?? LAN_SYNC_SCOPE,
    sessionId: input.sessionId,
    host: input.host,
    port: input.port,
    fingerprint: input.fingerprint,
    expiresAt: input.expiresAt,
    secret: input.secret,
    pcPublicKey: input.pcPublicKey,
    androidPublicKey: input.androidPublicKey,
  }
}

/**
 * 完整 transcript 的规范字符串（两端逐字节一致）。
 * 含双方公钥 + secret + 端点 + 过期 + 指纹，任一字段变化短认证串必须变。
 */
export function buildLanAuthTranscript(input: LanAuthTranscriptInput): string {
  return canonicalize(transcriptObject(input) as never)
}

/** transcript 的稳定哈希（HKDF info / 短认证串共同输入） */
export function lanAuthTranscriptHash(transcript: string): string {
  return createHash('sha256').update(transcript, 'utf8').digest('hex')
}

/**
 * 短认证串：SHA-256(transcript) 前 3 字节 → 6 位十进制（000000–999999）。
 * 两端显示同一串，用户目视核对后 PC 再确认。
 */
export function deriveShortAuthString(transcript: string): string {
  const digest = createHash('sha256').update(transcript, 'utf8').digest()
  const n = ((digest[0]! << 16) | (digest[1]! << 8) | digest[2]!) % 1_000_000
  return n.toString().padStart(6, '0')
}

export interface LanSessionKeys {
  /** 32B base64：会话加密密钥 */
  sessionKey: string
  /** 32B base64：完整性 MAC 密钥 */
  macKey: string
}

/**
 * 会话密钥派生：HKDF-SHA256(ikm=ECDH sharedSecret, salt=域常量, info 含 transcriptHash)。
 * sharedSecret 由调用方完成 ECDH 后注入（本层不持有私钥）。
 */
export function deriveLanSessionKeys(input: {
  sharedSecret: Uint8Array
  transcript: string
}): LanSessionKeys {
  const th = lanAuthTranscriptHash(input.transcript)
  const salt = Buffer.from(LAN_AUTH_TRANSCRIPT_DOMAIN, 'utf8')
  const ikm = Buffer.from(input.sharedSecret)
  const sessionKey = Buffer.from(
    hkdfSync('sha256', ikm, salt, Buffer.from(`session-key|${th}`, 'utf8'), 32),
  )
  const macKey = Buffer.from(
    hkdfSync('sha256', ikm, salt, Buffer.from(`mac-key|${th}`, 'utf8'), 32),
  )
  return {
    sessionKey: sessionKey.toString('base64'),
    macKey: macKey.toString('base64'),
  }
}

export function buildLanSyncQrPayload(input: {
  protocolVersion?: number
  host: string
  port: number
  sessionId: string
  pcPublicKey: LanAuthPublicKeyB64
  secret: LanAuthSecretB64
  expiresAt: number
  fingerprint: string
  displayName: string
}): LanSyncQrPayload {
  return {
    version: LAN_SYNC_QR_VERSION,
    scheme: LAN_SYNC_QR_SCHEME,
    protocolVersion: input.protocolVersion ?? LAN_SYNC_QR_VERSION,
    host: input.host,
    port: input.port,
    sessionId: input.sessionId,
    pcPublicKey: input.pcPublicKey,
    secret: input.secret,
    expiresAt: input.expiresAt,
    fingerprint: input.fingerprint,
    displayName: input.displayName,
    scope: LAN_SYNC_SCOPE,
  }
}

/** 解析 QR JSON；`now` 注入（纯函数不读时钟）。过期必须拒绝。 */
export function parseLanSyncQr(raw: string, now: number): ParsedLanSyncQr {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { kind: 'invalid', reason: 'not_json' }
  }
  const p = parsed as Partial<LanSyncQrPayload> | null
  if (!p || typeof p !== 'object') return { kind: 'invalid', reason: 'not_json' }
  if (p.scheme !== LAN_SYNC_QR_SCHEME) return { kind: 'invalid', reason: 'unknown_scheme' }
  if (p.version !== LAN_SYNC_QR_VERSION) return { kind: 'invalid', reason: 'unsupported_version' }
  if (typeof p.sessionId !== 'string' || !p.sessionId) return { kind: 'invalid', reason: 'missing_sessionId' }
  if (typeof p.pcPublicKey !== 'string' || !p.pcPublicKey) return { kind: 'invalid', reason: 'missing_pcPublicKey' }
  if (typeof p.secret !== 'string' || !p.secret) return { kind: 'invalid', reason: 'missing_secret' }
  if (typeof p.host !== 'string' || !p.host || typeof p.port !== 'number' || !Number.isFinite(p.port)) {
    return { kind: 'invalid', reason: 'missing_endpoints' }
  }
  if (p.scope !== LAN_SYNC_SCOPE) return { kind: 'invalid', reason: 'bad_scope' }
  if (typeof p.expiresAt !== 'number' || p.expiresAt <= now) {
    return { kind: 'invalid', reason: 'expired' }
  }
  return {
    kind: 'ok',
    payload: {
      version: LAN_SYNC_QR_VERSION,
      scheme: LAN_SYNC_QR_SCHEME,
      protocolVersion: typeof p.protocolVersion === 'number' ? p.protocolVersion : LAN_SYNC_QR_VERSION,
      host: p.host,
      port: p.port,
      sessionId: p.sessionId,
      pcPublicKey: p.pcPublicKey,
      secret: p.secret,
      expiresAt: p.expiresAt,
      fingerprint: typeof p.fingerprint === 'string' ? p.fingerprint : '',
      displayName: typeof p.displayName === 'string' ? p.displayName : '',
      scope: LAN_SYNC_SCOPE,
    },
  }
}
