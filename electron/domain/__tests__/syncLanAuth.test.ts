/**
 * S7-03：PC 侧 LAN 一次性授权会话——窗口/确认/吊销/清理。
 */
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'
import { SyncLanAuthService } from '../syncLanAuth'
import { deriveShortAuthString, buildLanAuthTranscript, parseLanSyncQr } from '../../../shared/sync-core/lanAuth'

function rawPub(key: ReturnType<typeof generateKeyPairSync>['publicKey']): string {
  return (key.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('base64')
}

describe('S7-03 SyncLanAuthService', () => {
  let svc: SyncLanAuthService

  beforeEach(() => {
    vi.useFakeTimers()
    svc = new SyncLanAuthService()
  })

  it('startAuthWindow 生成 QR：scope=sync、TTL 5 分钟、字段齐全', () => {
    const st = svc.startAuthWindow({
      host: '192.168.1.8',
      port: 8321,
      fingerprint: 'fp-1',
      displayName: '我的电脑',
    })
    expect(st.phase).toBe('open')
    expect(st.qrJson).toBeTruthy()
    const parsed = parseLanSyncQr(st.qrJson!, Date.now())
    expect(parsed.kind).toBe('ok')
    if (parsed.kind !== 'ok') return
    expect(parsed.payload.scope).toBe('sync')
    expect(parsed.payload.host).toBe('192.168.1.8')
    expect(parsed.payload.sessionId).toBe(st.sessionId)
    expect(parsed.payload.secret).toBeTruthy()
    expect(parsed.payload.pcPublicKey).toBeTruthy()
  })

  it('peer hello → awaiting_confirm，短认证串与对端派生一致', () => {
    const st = svc.startAuthWindow({
      host: '192.168.1.8', port: 8321, fingerprint: 'fp-1', displayName: 'PC',
    })
    const android = generateKeyPairSync('x25519')
    const after = svc.submitPeerHello({
      sessionId: st.sessionId!,
      deviceName: 'Pixel',
      androidPublicKey: rawPub(android.publicKey),
    })
    expect(after.phase).toBe('awaiting_confirm')
    expect(after.shortAuth).toMatch(/^\d{6}$/)
    expect(after.peerDeviceName).toBe('Pixel')

    const qr = parseLanSyncQr(after.qrJson!, Date.now())
    expect(qr.kind).toBe('ok')
    if (qr.kind !== 'ok') return
    const transcript = buildLanAuthTranscript({
      sessionId: qr.payload.sessionId,
      host: qr.payload.host,
      port: qr.payload.port,
      fingerprint: qr.payload.fingerprint,
      expiresAt: qr.payload.expiresAt,
      secret: qr.payload.secret,
      pcPublicKey: qr.payload.pcPublicKey,
      androidPublicKey: rawPub(android.publicKey),
    })
    expect(deriveShortAuthString(transcript)).toBe(after.shortAuth)
  })

  it('confirmPeer：短认证串匹配则 confirmed；UI 不含会话密钥', () => {
    const st = svc.startAuthWindow({
      host: '127.0.0.1', port: 8321, fingerprint: 'fp', displayName: 'pc',
    })
    const android = generateKeyPairSync('x25519')
    const hello = svc.submitPeerHello({
      sessionId: st.sessionId!,
      deviceName: 'A',
      androidPublicKey: rawPub(android.publicKey),
    })
    const r = svc.confirmPeer({ sessionId: st.sessionId!, shortAuth: hello.shortAuth! })
    expect(r.ok).toBe(true)
    expect(r.state.phase).toBe('confirmed')
    expect((r.state as { sessionKeys?: unknown }).sessionKeys).toBeUndefined()
    const keys = svc.takeSessionKeys(st.sessionId!)
    expect(keys?.sessionKey).toBeTruthy()
    expect(keys?.macKey).toBeTruthy()
    expect(Buffer.from(keys!.sessionKey, 'base64')).toHaveLength(32)
    expect(svc.hasActiveSyncSession()).toBe(true)
  })

  it('短认证串不匹配拒绝确认；revoke 后无活跃会话', () => {
    const st = svc.startAuthWindow({
      host: '127.0.0.1', port: 8321, fingerprint: 'fp', displayName: 'pc',
    })
    const android = generateKeyPairSync('x25519')
    const hello = svc.submitPeerHello({
      sessionId: st.sessionId!, deviceName: 'A', androidPublicKey: rawPub(android.publicKey),
    })
    const wrong = hello.shortAuth === '000000' ? '000001' : '000000'
    const bad = svc.confirmPeer({ sessionId: st.sessionId!, shortAuth: wrong })
    expect(bad.ok).toBe(false)
    expect(bad.error).toBe('short_auth_mismatch')
    svc.revoke('user')
    expect(svc.hasActiveSyncSession()).toBe(false)
    expect(svc.getStatus().phase).toBe('revoked')
    expect(svc.takeSessionKeys(st.sessionId!)).toBeNull()
  })

  it('TTL 过期自动失效；重新 start 会替换旧 session', () => {
    const st = svc.startAuthWindow({
      host: '127.0.0.1', port: 8321, fingerprint: 'fp', displayName: 'pc',
    })
    vi.advanceTimersByTime(5 * 60 * 1000 + 1)
    expect(svc.getStatus().phase).toBe('expired')
    expect(svc.hasActiveSyncSession()).toBe(false)

    const next = svc.startAuthWindow({
      host: '127.0.0.1', port: 8321, fingerprint: 'fp', displayName: 'pc',
    })
    expect(next.sessionId).not.toBe(st.sessionId)
    expect(next.phase).toBe('open')
  })
})
