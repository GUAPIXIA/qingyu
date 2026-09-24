/**
 * 阶段 7 S7-03：PC 侧 LAN 一次性授权会话（内存态，TTL 5 分钟，scope 仅 sync）。
 *
 * - 用户进入同步中心点「允许局域网同步」后才创建 session（窗口外不接受新 sync 授权）；
 * - 生成临时 X25519 + 256 位 secret；拒绝/超时/完成立即吊销并清理私钥；
 * - 不复用 Bridge JWT；mDNS 只做发现，不参与本授权。
 */
import {
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  type KeyObject,
} from 'node:crypto'
import {
  LAN_SYNC_AUTH_TTL_MS,
  LAN_SYNC_SCOPE,
  buildLanAuthTranscript,
  buildLanSyncQrPayload,
  deriveLanSessionKeys,
  deriveShortAuthString,
  type LanSessionKeys,
  type LanSyncQrPayload,
} from '../../shared/sync-core/lanAuth'
import { createLogger } from '../services/logger'

const log = createLogger('sync-lan-auth')

export type SyncLanAuthPhase =
  | 'idle'
  | 'open'
  | 'awaiting_confirm'
  | 'confirmed'
  | 'revoked'
  | 'expired'

export interface SyncLanAuthPublicState {
  phase: SyncLanAuthPhase
  sessionId: string | null
  qrJson: string | null
  expiresAt: number | null
  host: string | null
  port: number | null
  displayName: string
  fingerprint: string
  /** 对端扫码后（submitPeerHello）才有 */
  peerDeviceName: string | null
  peerPublicKey: string | null
  shortAuth: string | null
}

interface PendingSession {
  sessionId: string
  host: string
  port: number
  displayName: string
  fingerprint: string
  secretB64: string
  publicKeyB64: string
  privateKey: KeyObject
  expiresAt: number
  phase: SyncLanAuthPhase
  peerDeviceName: string | null
  peerPublicKeyB64: string | null
  shortAuth: string | null
  sessionKeys: LanSessionKeys | null
  timer: ReturnType<typeof setTimeout> | null
}

export interface StartLanAuthInput {
  host: string
  port: number
  fingerprint: string
  displayName: string
  protocolVersion?: number
}

export interface SubmitPeerHelloInput {
  sessionId: string
  deviceName: string
  /** Android 临时 X25519 公钥 raw 32B base64 */
  androidPublicKey: string
  now?: number
}

export interface ConfirmPeerInput {
  sessionId: string
  /** 用户目视核对的短认证串；不匹配则拒绝确认 */
  shortAuth: string
  now?: number
}

function toRawPublicKeyB64(publicKey: KeyObject): string {
  const der = publicKey.export({ type: 'spki', format: 'der' }) as Buffer
  return der.subarray(-32).toString('base64')
}

function privateKeyFromRaw(raw32: Buffer): KeyObject {
  // PKCS8 X25519 prefix（RFC 8410）+ 32B raw
  const pkcs8 = Buffer.concat([
    Buffer.from('302e020100300506032b656e04220420', 'hex'),
    raw32,
  ])
  return createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' })
}

function publicKeyFromRaw(raw32: Buffer): KeyObject {
  const spki = Buffer.concat([
    Buffer.from('302a300506032b656e032100', 'hex'),
    raw32,
  ])
  return createPublicKey({ key: spki, format: 'der', type: 'spki' })
}

export class SyncLanAuthService {
  private pending: PendingSession | null = null

  getStatus(): SyncLanAuthPublicState {
    const s = this.pending
    return {
      phase: s?.phase ?? 'idle',
      sessionId: s?.sessionId ?? null,
      qrJson: s && (s.phase === 'open' || s.phase === 'awaiting_confirm')
        ? this.buildQrJson(s)
        : null,
      expiresAt: s?.expiresAt ?? null,
      host: s?.host ?? null,
      port: s?.port ?? null,
      displayName: s?.displayName ?? '',
      fingerprint: s?.fingerprint ?? '',
      peerDeviceName: s?.peerDeviceName ?? null,
      peerPublicKey: s?.peerPublicKeyB64 ?? null,
      shortAuth: s?.shortAuth ?? null,
    }
  }

  /** 打开 5 分钟授权窗口（替换未完成的旧 session，并清理其私钥）。 */
  startAuthWindow(input: StartLanAuthInput): SyncLanAuthPublicState {
    this.revoke('restart')
    const keyPair = generateKeyPairSync('x25519')
    const secret = randomBytes(32)
    const sessionId = randomUUID()
    const expiresAt = Date.now() + LAN_SYNC_AUTH_TTL_MS
    const publicKeyB64 = toRawPublicKeyB64(keyPair.publicKey)
    const secretB64 = secret.toString('base64')

    const session: PendingSession = {
      sessionId,
      host: input.host,
      port: input.port,
      displayName: input.displayName,
      fingerprint: input.fingerprint,
      secretB64,
      publicKeyB64,
      privateKey: keyPair.privateKey,
      expiresAt,
      phase: 'open',
      peerDeviceName: null,
      peerPublicKeyB64: null,
      shortAuth: null,
      sessionKeys: null,
      timer: null,
    }
    session.timer = setTimeout(() => this.expire(session.sessionId), LAN_SYNC_AUTH_TTL_MS)
    this.pending = session
    log.info('LAN 授权窗口已打开', { sessionId, ttlMs: LAN_SYNC_AUTH_TTL_MS, scope: LAN_SYNC_SCOPE })
    return this.getStatus()
  }

  /** 对端扫码后登记临时公钥，派生短认证串（用户尚未确认）。 */
  submitPeerHello(input: SubmitPeerHelloInput): SyncLanAuthPublicState {
    const s = this.pending
    const now = input.now ?? Date.now()
    if (!s || s.sessionId !== input.sessionId) {
      return this.getStatus()
    }
    if (s.phase !== 'open' || now >= s.expiresAt) {
      if (s.phase === 'open') this.expire(s.sessionId)
      return this.getStatus()
    }
    const raw = Buffer.from(input.androidPublicKey, 'base64')
    if (raw.length !== 32) {
      log.warn('peer hello 公钥长度非法', { len: raw.length })
      return this.getStatus()
    }
    s.peerDeviceName = input.deviceName.slice(0, 64) || '未知设备'
    s.peerPublicKeyB64 = input.androidPublicKey
    const transcript = buildLanAuthTranscript({
      sessionId: s.sessionId,
      host: s.host,
      port: s.port,
      fingerprint: s.fingerprint,
      expiresAt: s.expiresAt,
      secret: s.secretB64,
      pcPublicKey: s.publicKeyB64,
      androidPublicKey: s.peerPublicKeyB64,
    })
    s.shortAuth = deriveShortAuthString(transcript)
    s.phase = 'awaiting_confirm'
    log.info('收到 peer hello，等待用户核对短认证串', { sessionId: s.sessionId })
    return this.getStatus()
  }

  /** 用户核对设备名与短认证串后确认；不匹配保持 awaiting 并返回错误。 */
  confirmPeer(input: ConfirmPeerInput): { ok: boolean; state: SyncLanAuthPublicState; error?: string } {
    const s = this.pending
    const now = input.now ?? Date.now()
    if (!s || s.sessionId !== input.sessionId) {
      return { ok: false, state: this.getStatus(), error: 'session_not_found' }
    }
    if (s.phase === 'confirmed') {
      return { ok: true, state: this.getStatus() }
    }
    if (s.phase !== 'awaiting_confirm' || !s.peerPublicKeyB64 || !s.shortAuth) {
      return { ok: false, state: this.getStatus(), error: 'not_awaiting_confirm' }
    }
    if (now >= s.expiresAt) {
      this.expire(s.sessionId)
      return { ok: false, state: this.getStatus(), error: 'expired' }
    }
    if (input.shortAuth !== s.shortAuth) {
      return { ok: false, state: this.getStatus(), error: 'short_auth_mismatch' }
    }

    const transcript = buildLanAuthTranscript({
      sessionId: s.sessionId,
      host: s.host,
      port: s.port,
      fingerprint: s.fingerprint,
      expiresAt: s.expiresAt,
      secret: s.secretB64,
      pcPublicKey: s.publicKeyB64,
      androidPublicKey: s.peerPublicKeyB64,
    })
    const shared = diffieHellman({
      privateKey: s.privateKey,
      publicKey: publicKeyFromRaw(Buffer.from(s.peerPublicKeyB64, 'base64')),
    })
    s.sessionKeys = deriveLanSessionKeys({ sharedSecret: shared, transcript })
    s.phase = 'confirmed'
    if (s.timer) {
      clearTimeout(s.timer)
      s.timer = null
    }
    // 确认后立即清理临时私钥与 secret（密钥已派生，原文不再保留）
    this.zeroSecret(s)
    log.info('LAN 同步会话已确认', { sessionId: s.sessionId, peer: s.peerDeviceName })
    return { ok: true, state: this.getStatus() }
  }

  /** 拒绝 / 用户取消 / 完成：吊销并清理。 */
  revoke(_reason?: string): void {
    const s = this.pending
    if (!s) return
    if (s.timer) {
      clearTimeout(s.timer)
      s.timer = null
    }
    this.zeroSecret(s)
    s.phase = 'revoked'
    s.sessionKeys = null
    // 保留 sessionId 供 UI 展示「已拒绝」；下一窗 start 会替换
    log.info('LAN 授权已吊销', { sessionId: s.sessionId })
  }

  /** 确认后的会话密钥（主进程内部消费；IPC 不向渲染层暴露密钥材料）。 */
  takeSessionKeys(sessionId: string): LanSessionKeys | null {
    const s = this.pending
    if (!s || s.sessionId !== sessionId || s.phase !== 'confirmed') return null
    return s.sessionKeys
  }

  /** 是否存在已确认的 sync scope 会话（/sync/v1 鉴权前置）。 */
  hasActiveSyncSession(): boolean {
    return this.pending?.phase === 'confirmed' && this.pending.sessionKeys != null
  }

  private expire(sessionId: string): void {
    const s = this.pending
    if (!s || s.sessionId !== sessionId) return
    if (s.timer) {
      clearTimeout(s.timer)
      s.timer = null
    }
    this.zeroSecret(s)
    s.phase = 'expired'
    s.sessionKeys = null
    log.info('LAN 授权窗口已过期', { sessionId })
  }

  private zeroSecret(s: PendingSession): void {
    // 尽力清理密钥材料；不持久化任何私钥/secret。私钥在确认后已无用，直接丢弃。
    s.secretB64 = ''
    // 赋一个哑私钥对象以保持类型；后续路径不得再做 ECDH
    try {
      s.privateKey = privateKeyFromRaw(Buffer.alloc(32))
    } catch {
      // ignore
    }
  }

  private buildQrJson(s: PendingSession): string {
    const payload: LanSyncQrPayload = buildLanSyncQrPayload({
      host: s.host,
      port: s.port,
      sessionId: s.sessionId,
      pcPublicKey: s.publicKeyB64,
      secret: s.secretB64,
      expiresAt: s.expiresAt,
      fingerprint: s.fingerprint,
      displayName: s.displayName,
    })
    return JSON.stringify(payload)
  }

  /** 测试钩子 */
  resetForTests(): void {
    this.revoke('test-reset')
    this.pending = null
  }
}

export const syncLanAuthService = new SyncLanAuthService()
