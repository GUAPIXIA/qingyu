/**
 * S7-04：/sync/v1 独立路由——休眠门、session、push 幂等/限流、receipt 恢复。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import express from 'express'
import type { Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { generateKeyPairSync } from 'node:crypto'
import { buildSyncV1Router, resetSyncV1ForTest, syncV1Runtime } from '../syncRoutes'
import { SyncLanAuthService, syncLanAuthService } from '../../domain/syncLanAuth'
import { makeEnvelope } from '../../../shared/contracts/sync-envelope'

function rawPub(key: ReturnType<typeof generateKeyPairSync>['publicKey']): string {
  return (key.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('base64')
}

let server: Server
let base: string
let lan: SyncLanAuthService

async function listen(): Promise<void> {
  const app = express()
  app.use(express.json({ limit: '5mb' }))
  app.use('/sync/v1', buildSyncV1Router())
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve())
  })
  const { port } = server.address() as AddressInfo
  base = `http://127.0.0.1:${port}/sync/v1`
}

async function openAuthedSession(): Promise<string> {
  // 打开 LAN 授权并确认（模拟对端 hello）
  lan.startAuthWindow({ host: '127.0.0.1', port: 1, fingerprint: 'fp', displayName: 'pc' })
  const android = generateKeyPairSync('x25519')
  const st = lan.getStatus()
  const hello = lan.submitPeerHello({
    sessionId: st.sessionId!,
    deviceName: 'A',
    androidPublicKey: rawPub(android.publicKey),
  })
  lan.confirmPeer({ sessionId: st.sessionId!, shortAuth: hello.shortAuth! })
  expect(syncLanAuthService.hasActiveSyncSession()).toBe(true)

  const res = await fetch(`${base}/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ role: 'android' }),
  })
  const body = (await res.json()) as { sessionId: string }
  return body.sessionId
}

beforeEach(async () => {
  resetSyncV1ForTest()
  lan = syncLanAuthService
  lan.resetForTests()
  await listen()
})

afterEach(async () => {
  lan.resetForTests()
  resetSyncV1ForTest()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

describe('S7-04 /sync/v1', () => {
  it('无授权会话时休眠：503，不建 session', async () => {
    const res = await fetch(`${base}/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'android' }),
    })
    expect(res.status).toBe(503)
    expect((await res.json()).error).toBe('sync_dormant')
    expect(syncV1Runtime.sessions.size).toBe(0)
  })

  it('session 创建 + plan 只读 stats', async () => {
    const sessionId = await openAuthedSession()
    const res = await fetch(`${base}/session/${sessionId}/plan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ remoteHeads: [] }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.planId).toBeTruthy()
    expect(body.stats).toBeTruthy()
    expect(body.items).toBeUndefined()
  })

  it('push 幂等：同 batchId 同 hash 重放 200 idempotent', async () => {
    const sessionId = await openAuthedSession()
    const env = makeEnvelope({
      entityType: 'character',
      entityId: 'c1',
      payload: { name: 'X' },
      deviceId: 'android_b',
      updatedAt: 1,
    })
    const payload = { batchId: 'b1', sequence: 0, envelopes: [env] }
    const r1 = await fetch(`${base}/session/${sessionId}/push`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    expect(r1.status).toBe(202)
    const b1 = await r1.json()
    expect(b1.idempotent).toBe(false)

    const r2 = await fetch(`${base}/session/${sessionId}/push`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    expect(r2.status).toBe(200)
    const b2 = await r2.json()
    expect(b2.idempotent).toBe(true)
    expect(b2.itemHash).toBe(b1.itemHash)
  })

  it('push 乱序 sequence 409，不提前 apply', async () => {
    const sessionId = await openAuthedSession()
    const env = makeEnvelope({
      entityType: 'character',
      entityId: 'c2',
      payload: { name: 'Y' },
      deviceId: 'android_b',
      updatedAt: 1,
    })
    const res = await fetch(`${base}/session/${sessionId}/push`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ batchId: 'b-seq', sequence: 5, envelopes: [env] }),
    })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('out_of_order')
  })

  it('abort 清理未提交 staging 并终态', async () => {
    const sessionId = await openAuthedSession()
    const env = makeEnvelope({
      entityType: 'character',
      entityId: 'c3',
      payload: { name: 'Z' },
      deviceId: 'android_b',
      updatedAt: 1,
    })
    await fetch(`${base}/session/${sessionId}/push`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ batchId: 'b-abort', sequence: 0, envelopes: [env] }),
    })
    const res = await fetch(`${base}/session/${sessionId}/abort`, { method: 'POST' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(['cancelled', 'cancelling']).toContain(body.state)
    // 未提交 staging 已清
    const staged = [...syncV1Runtime.staging.values()].filter((b) => b.sessionId === sessionId)
    expect(staged.every((b) => b.state === 'aborted' || b.state === 'committed')).toBe(true)
  })

  it('未知路径 404（严格匹配）', async () => {
    await openAuthedSession()
    const res = await fetch(`${base}/session/x/unknown`, { method: 'POST' })
    expect(res.status).toBe(404)
  })

  it('auth/hello + auth/status：授权窗内可登记公钥，确认后 confirmed', async () => {
    // 未开授权 → 503
    const early = await fetch(`${base}/auth/hello`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'x', androidPublicKey: 'AA==' }),
    })
    expect(early.status).toBe(503)

    const started = lan.startAuthWindow({ host: '127.0.0.1', port: 1, fingerprint: 'fp', displayName: 'pc' })
    const sessionId = started.sessionId!
    const android = generateKeyPairSync('x25519')
    const rawPub = (android.publicKey.export({ type: 'spki', format: 'der' }) as Buffer)
      .subarray(-32)
      .toString('base64')

    const hello = await fetch(`${base}/auth/hello`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, deviceName: 'Pixel', androidPublicKey: rawPub }),
    })
    expect(hello.status).toBe(200)
    const helloBody = (await hello.json()) as { shortAuth: string; phase: string }
    expect(helloBody.phase).toBe('awaiting_confirm')
    expect(helloBody.shortAuth).toMatch(/^\d{6}$/)

    const st1 = await fetch(`${base}/auth/status`)
    expect(((await st1.json()) as { confirmed: boolean }).confirmed).toBe(false)

    lan.confirmPeer({ sessionId, shortAuth: helloBody.shortAuth })
    const st2 = await fetch(`${base}/auth/status`)
    const body2 = (await st2.json()) as { confirmed: boolean; phase: string }
    expect(body2.confirmed).toBe(true)
    expect(body2.phase).toBe('confirmed')
  })
})
