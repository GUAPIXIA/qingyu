/**
 * S7-05 LAN 联调端到端（真实 HTTP，vitest 环境）：
 *   PC 开授权窗 → QR → 客户端扫码/ECDH/SAS → POST auth/hello →
 *   PC 核对 SAS 确认 → 会话密钥一致 → session → push 幂等 → prepare → commit → receipt。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import express from 'express'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import {
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  type KeyObject,
} from 'node:crypto'
import { buildSyncV1Router, resetSyncV1ForTest, syncV1Runtime, setSyncV1DomainPeekForTest } from '../syncRoutes'
import { syncLanAuthService } from '../../domain/syncLanAuth'
import {
  setSyncDomainUserDataDirForTest,
  resetSyncDomainForTest,
  getSyncDomain,
} from '../../domain/syncDomainService'
import {
  buildLanAuthTranscript,
  deriveLanSessionKeys,
  deriveShortAuthString,
  parseLanSyncQr,
} from '../../../shared/sync-core/lanAuth'
import { makeEnvelope } from '../../../shared/contracts/sync-envelope'

function rawPub(key: KeyObject): string {
  return (key.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('base64')
}

function publicKeyFromRaw(raw32: Buffer): KeyObject {
  const spki = Buffer.concat([Buffer.from('302a300506032b656e032100', 'hex'), raw32])
  return createPublicKey({ key: spki, format: 'der', type: 'spki' })
}

describe('S7-05 LAN 联调 e2e', () => {
  let server: Server
  let base: string
  let port: number
  let workDir: string
  let userData: string

  beforeEach(async () => {
    resetSyncV1ForTest()
    syncLanAuthService.resetForTests()
    workDir = mkdtempSync(join(tmpdir(), 'qingyu-lan-e2e-'))
    userData = join(workDir, 'userdata')
    mkdirSync(join(userData, 'data', 'config'), { recursive: true })
    setSyncDomainUserDataDirForTest(userData)
    setSyncV1DomainPeekForTest(() => {
      try {
        return getSyncDomain()
      } catch {
        return null
      }
    })
    const app = express()
    app.use(express.json({ limit: '5mb' }))
    app.use('/sync/v1', buildSyncV1Router())
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve())
    })
    port = (server.address() as AddressInfo).port
    base = `http://127.0.0.1:${port}/sync/v1`
  })

  afterEach(async () => {
    syncLanAuthService.resetForTests()
    resetSyncV1ForTest()
    resetSyncDomainForTest()
    setSyncV1DomainPeekForTest(() => null)
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(workDir, { recursive: true, force: true })
  })

  it('QR→SAS 一致→确认→push 幂等→commit/receipt→吊销后休眠', async () => {
    // 1. PC 授权窗
    const started = syncLanAuthService.startAuthWindow({
      host: '127.0.0.1',
      port,
      fingerprint: 'fp-lan-e2e',
      displayName: 'PC-LAN-E2E',
    })
    expect(started.qrJson).toBeTruthy()
    expect(started.phase).toBe('open')

    // 2. 客户端扫码（Android 语义）
    const parsed = parseLanSyncQr(started.qrJson!, Date.now())
    expect(parsed.kind).toBe('ok')
    if (parsed.kind !== 'ok') return
    const qr = parsed.payload
    expect(qr.scope).toBe('sync')
    expect(qr.host).toBe('127.0.0.1')
    expect(qr.port).toBe(port)

    const android = generateKeyPairSync('x25519')
    const androidPub = rawPub(android.publicKey)
    const transcript = buildLanAuthTranscript({
      sessionId: qr.sessionId,
      host: qr.host,
      port: qr.port,
      fingerprint: qr.fingerprint,
      expiresAt: qr.expiresAt,
      secret: qr.secret,
      pcPublicKey: qr.pcPublicKey,
      androidPublicKey: androidPub,
    })
    const clientSas = deriveShortAuthString(transcript)

    // 3. hello
    const helloRes = await fetch(`${base}/auth/hello`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: qr.sessionId,
        deviceName: 'MuMu-Android',
        androidPublicKey: androidPub,
      }),
    })
    const helloBody = (await helloRes.json()) as { phase: string; shortAuth: string; peerDeviceName: string }
    expect(helloRes.status).toBe(200)
    expect(helloBody.shortAuth).toBe(clientSas)
    expect(helloBody.peerDeviceName).toBe('MuMu-Android')

    // 4. PC 确认（用户核对 SAS）
    const confirm = syncLanAuthService.confirmPeer({
      sessionId: qr.sessionId,
      shortAuth: clientSas,
    })
    expect(confirm.ok).toBe(true)
    expect(confirm.state.phase).toBe('confirmed')

    const statusRes = await fetch(`${base}/auth/status`)
    const status = (await statusRes.json()) as { confirmed: boolean }
    expect(status.confirmed).toBe(true)

    // 5. 会话密钥两端一致
    const shared = diffieHellman({
      privateKey: android.privateKey,
      publicKey: publicKeyFromRaw(Buffer.from(qr.pcPublicKey, 'base64')),
    })
    const clientKeys = deriveLanSessionKeys({ sharedSecret: shared, transcript })
    const pcKeys = syncLanAuthService.takeSessionKeys(qr.sessionId)
    expect(pcKeys).toBeTruthy()
    expect(pcKeys!.sessionKey).toBe(clientKeys.sessionKey)
    expect(pcKeys!.macKey).toBe(clientKeys.macKey)

    // 6. session + push 幂等 + prepare + commit + receipt
    const sessionRes = await fetch(`${base}/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'android' }),
    })
    const sessionBody = (await sessionRes.json()) as { sessionId: string }
    expect(sessionBody.sessionId).toBeTruthy()

    const env = makeEnvelope({
      entityType: 'character',
      entityId: 'char-lan-e2e',
      payload: { name: 'LAN联调角色', greeting: '你好' },
      deviceId: 'android-e2e',
      schemaVersion: 3,
    })

    const pushBody = { batchId: 'e2e-batch-1', sequence: 0, envelopes: [env] }
    const pushRes = await fetch(`${base}/session/${sessionBody.sessionId}/push`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(pushBody),
    })
    expect(pushRes.status).toBeLessThan(400)

    const push2 = await fetch(`${base}/session/${sessionBody.sessionId}/push`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(pushBody),
    })
    expect(push2.status).toBe(200)
    const push2Body = (await push2.json()) as { idempotent?: boolean }
    expect(push2Body.idempotent).toBe(true)

    const prepRes = await fetch(`${base}/session/${sessionBody.sessionId}/prepare`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ batchIds: ['e2e-batch-1'] }),
    })
    expect(prepRes.status).toBeLessThan(400)

    const commitRes = await fetch(`${base}/session/${sessionBody.sessionId}/commit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ batchId: 'e2e-batch-1', peerId: 'android-e2e' }),
    })
    expect(commitRes.status).toBeLessThan(400)

    const receiptRes = await fetch(
      `${base}/session/${sessionBody.sessionId}/receipt/e2e-batch-1`,
    )
    expect(receiptRes.status).toBe(200)
    const receiptBody = (await receiptRes.json()) as { receipt?: { receiptId?: string } }
    expect(receiptBody.receipt?.receiptId).toBeTruthy()

    // 7. 吊销后休眠门
    syncLanAuthService.revoke('e2e-done')
    const after = await fetch(`${base}/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'android' }),
    })
    expect(after.status).toBe(503)
    expect(syncV1Runtime.sessions.has(sessionBody.sessionId)).toBe(true) // 已建 session 保留，仅拒绝新建
  })

  it('SAS 不一致必须拒绝确认', async () => {
    const started = syncLanAuthService.startAuthWindow({
      host: '127.0.0.1',
      port,
      fingerprint: 'fp',
      displayName: 'pc',
    })
    const parsed = parseLanSyncQr(started.qrJson!, Date.now())
    expect(parsed.kind).toBe('ok')
    if (parsed.kind !== 'ok') return
    const android = generateKeyPairSync('x25519')
    const hello = syncLanAuthService.submitPeerHello({
      sessionId: parsed.payload.sessionId,
      deviceName: 'A',
      androidPublicKey: rawPub(android.publicKey),
    })
    const bad = syncLanAuthService.confirmPeer({
      sessionId: parsed.payload.sessionId,
      shortAuth: '000000',
    })
    expect(bad.ok).toBe(false)
    expect(bad.error).toBe('short_auth_mismatch')
    expect(hello.shortAuth).not.toBe('000000')
  })
})
