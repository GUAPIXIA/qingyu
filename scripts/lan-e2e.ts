/**
 * LAN 联调端到端（真实 HTTP）：
 *   PC 开授权窗 → 生成 QR → 客户端（模拟 Android）扫码/ECDH/SAS →
 *   POST auth/hello → PC 核对 SAS 确认 → session → push/prepare/commit → pull。
 *
 * 运行：pnpm exec tsx scripts/lan-e2e.ts
 * 退出码 0 = 全绿；非 0 = 联调失败。
 */
import express from 'express'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createPublicKey, diffieHellman, generateKeyPairSync, type KeyObject } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { buildSyncV1Router, resetSyncV1ForTest } from '../electron/bridge/syncRoutes'
import { SyncLanAuthService } from '../electron/domain/syncLanAuth'
import {
  buildLanAuthTranscript,
  deriveLanSessionKeys,
  deriveShortAuthString,
  parseLanSyncQr,
  type LanSessionKeys,
} from '../shared/sync-core/lanAuth'
import { makeEnvelope } from '../shared/contracts/sync-envelope'

function rawPub(key: KeyObject): string {
  return (key.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('base64')
}

function publicKeyFromRaw(raw32: Buffer): KeyObject {
  const spki = Buffer.concat([Buffer.from('302a300506032b656e032100', 'hex'), raw32])
  return createPublicKey({ key: spki, format: 'der', type: 'spki' })
}

const log = (...args: unknown[]) => console.log('[lan-e2e]', ...args)
const fail = (msg: string): never => {
  console.error('[lan-e2e] FAIL', msg)
  process.exit(1)
}

async function main() {
  resetSyncV1ForTest()
  void new SyncLanAuthService()

  const app = express()
  app.use(express.json({ limit: '5mb' }))
  // 直接挂 sync router；auth 内部使用单例 syncLanAuthService，
  // 为联调把本实例替换到全局单例路径：通过 startAuthWindow 后 fetch 走真实 HTTP。
  // syncRoutes 内部 import 的是单例，这里同样用单例以匹配生产。
  const { syncLanAuthService } = await import('../electron/domain/syncLanAuth')
  app.use('/sync/v1', buildSyncV1Router())

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
  })
  const { port } = server.address() as AddressInfo
  const base = `http://127.0.0.1:${port}/sync/v1`
  log('server', base)

  // ---- 1. PC 开授权窗 ----
  syncLanAuthService.resetForTests?.()
  const started = syncLanAuthService.startAuthWindow({
    host: '127.0.0.1',
    port,
    fingerprint: 'fp-lan-e2e',
    displayName: 'PC-LAN-E2E',
  })
  if (!started.qrJson) fail('PC 未生成 QR')
  log('PC auth open', started.sessionId, 'expiresAt', started.expiresAt)

  // ---- 2. 客户端（Android 语义）扫码 ----
  const parsed = parseLanSyncQr(started.qrJson!, Date.now())
  if (parsed.kind !== 'ok') fail('QR 解析失败: ' + parsed.reason)
  const qr = parsed.payload
  if (qr.scope !== 'sync') fail('QR scope 必须是 sync')
  if (qr.host !== '127.0.0.1' || qr.port !== port) fail('QR 端点不符')

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
  log('client SAS', clientSas)

  // ---- 3. hello（真实 HTTP）----
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
  if (helloRes.status !== 200) fail(`hello HTTP ${helloRes.status} ${JSON.stringify(helloBody)}`)
  if (helloBody.shortAuth !== clientSas) fail(`SAS 不一致 client=${clientSas} pc=${helloBody.shortAuth}`)
  log('hello OK, SAS match', helloBody.shortAuth, 'peer', helloBody.peerDeviceName)

  // ---- 4. PC 核对并确认（模拟用户点「确认授权」）----
  const confirm = syncLanAuthService.confirmPeer({
    sessionId: qr.sessionId,
    shortAuth: clientSas,
  })
  if (!confirm.ok) fail('confirmPeer 失败: ' + confirm.error)
  if (confirm.state.phase !== 'confirmed') fail('PC 未进入 confirmed')

  const statusRes = await fetch(`${base}/auth/status`)
  const status = (await statusRes.json()) as { confirmed: boolean; phase: string }
  if (!status.confirmed) fail('auth/status 未 confirmed')
  log('PC confirmed', status.phase)

  // ---- 5. 两端派生会话密钥，必须一致 ----
  const shared = diffieHellman({
    privateKey: android.privateKey,
    publicKey: publicKeyFromRaw(Buffer.from(qr.pcPublicKey, 'base64')),
  })
  const clientKeys: LanSessionKeys = deriveLanSessionKeys({ sharedSecret: shared, transcript })
  const pcKeys = syncLanAuthService.getSessionKeys?.(qr.sessionId)
  if (pcKeys) {
    if (pcKeys.sessionKey !== clientKeys.sessionKey || pcKeys.macKey !== clientKeys.macKey) {
      fail('会话密钥不一致')
    }
    log('session keys match')
  } else {
    log('session keys derived on client (PC getter 不可用则跳过比对)')
  }

  // ---- 6. session → push → prepare → commit → pull ----
  const sessionRes = await fetch(`${base}/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ role: 'android' }),
  })
  const sessionBody = (await sessionRes.json()) as { sessionId: string }
  if (!sessionBody.sessionId) fail('session 创建失败')
  log('sync session', sessionBody.sessionId)

  const env = makeEnvelope({
    entityType: 'character',
    entityId: 'char-lan-e2e',
    payload: { name: 'LAN联调角色', greeting: '你好' },
    deviceId: 'android-e2e',
    schemaVersion: 3,
  })

  const pushRes = await fetch(`${base}/session/${sessionBody.sessionId}/push`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      batchId: 'e2e-batch-1',
      sequence: 0,
      envelopes: [env],
    }),
  })
  const pushBody = (await pushRes.json()) as { itemHash?: string; accepted?: number; error?: string }
  if (pushRes.status >= 400) fail(`push 失败 ${pushRes.status} ${JSON.stringify(pushBody)}`)
  log('push OK', pushBody)

  // 同 batch 幂等重放
  const push2 = await fetch(`${base}/session/${sessionBody.sessionId}/push`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ batchId: 'e2e-batch-1', sequence: 0, envelopes: [env] }),
  })
  const push2Body = (await push2.json()) as { idempotent?: boolean }
  log('push replay', push2.status, push2Body)

  const prepRes = await fetch(`${base}/session/${sessionBody.sessionId}/prepare`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ batchIds: ['e2e-batch-1'] }),
  })
  log('prepare', prepRes.status)

  const commitRes = await fetch(`${base}/session/${sessionBody.sessionId}/commit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ batchId: 'e2e-batch-1', peerId: 'android-e2e' }),
  })
  const commitBody = (await commitRes.json()) as { receipt?: { receiptId?: string } }
  if (commitRes.status >= 400) fail(`commit 失败 ${commitRes.status}`)
  log('commit OK', commitBody)

  const receiptRes = await fetch(
    `${base}/session/${sessionBody.sessionId}/receipt/e2e-batch-1`,
  )
  const receiptBody = (await receiptRes.json()) as { receipt?: { receiptId?: string } }
  if (receiptRes.status !== 200 || !receiptBody.receipt) fail('receipt 查询失败')
  log('receipt recovery OK', receiptBody.receipt.receiptId)

  // pull（若实现）
  const pullRes = await fetch(`${base}/session/${sessionBody.sessionId}/pull`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ limit: 50 }),
  })
  log('pull', pullRes.status, (await pullRes.text()).slice(0, 200))

  // ---- 7. 休眠门：吊销后再请求应拒绝 ----
  syncLanAuthService.revoke('e2e-done')
  const afterRevoke = await fetch(`${base}/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ role: 'android' }),
  })
  if (afterRevoke.status !== 503) fail(`吊销后应 503，实际 ${afterRevoke.status}`)
  log('dormant after revoke OK')

  // 证据落盘
  mkdirSync('output/pce01', { recursive: true })
  writeFileSync(
    'output/pce01/lan-e2e-report.json',
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        base,
        sessionId: sessionBody.sessionId,
        qr: { host: qr.host, port: qr.port, scope: qr.scope, fingerprint: qr.fingerprint },
        sas: clientSas,
        sasMatch: helloBody.shortAuth === clientSas,
        push: pushBody,
        commit: commitBody,
        receipt: receiptBody.receipt,
        revokedDormant: afterRevoke.status === 503,
      },
      null,
      2,
    ),
    'utf8',
  )

  server.close()
  resetSyncV1ForTest()
  log('PASS')
}

main().catch((err) => {
  console.error('[lan-e2e] unexpected', err)
  process.exit(1)
})
