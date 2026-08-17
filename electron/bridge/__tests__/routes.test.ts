/**
 * 桥接层 REST 路由集成测试：server info / 会话列表 / 消息 cursor 分页 /
 * 配对全流程（配对码 -> 挂起 -> 批准 -> 令牌） / 鉴权拒绝。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import express from 'express'
import { createServer } from 'node:http'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/qingyu-bridge-route-test' },
  safeStorage: {
    isEncryptionAvailable: () => false,
  },
}))

// mock 公告/版本模块：避免测试访问真实网络（cjbtj.xyz）；路径相对本测试文件（electron/bridge/__tests__/ → ../../ipc/）
vi.mock('../../ipc/announcement', () => ({
  fetchAnnouncementList: vi.fn(async () => ({ items: [], total: 0, page: 1, pageSize: 20 })),
  fetchVersionInfo: vi.fn(async () => ({
    version: '0.11.22',
    changelog: '测试更新日志',
    downloadUrl: 'https://example.com/qingyu/download',
  })),
}))

import { DIRS } from '../../services/storage'
import { buildBridgeRouter } from '../routes'
import { WsHub } from '../ws'
import { BridgeChatService } from '../chatService'
import { chatData, messagesCacheInvalidate } from '../../ipc/chat'
import { generatePairingCode, settlePair, signToken, registerDevice } from '../auth'

const TEST_ROOT = '/tmp/qingyu-bridge-route-test'
const CHAR_ID = 'char-001'

function listen(app: express.Express): Promise<{ server: ReturnType<typeof createServer>; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer(app)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (addr && typeof addr === 'object') {
        resolve({ server, port: addr.port })
      } else {
        reject(new Error('无地址'))
      }
    })
    server.on('error', reject)
  })
}

beforeEach(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true })
  // 清理跨测试的消息读取缓存（nanoid mock 使 sessionId 恒为 mock-id，缓存会跨用例污染）
  messagesCacheInvalidate(CHAR_ID)
  mkdirSync(DIRS.chats(), { recursive: true })
  mkdirSync(DIRS.characters(), { recursive: true })
  writeFileSync(join(DIRS.characters(), `${CHAR_ID}.json`), JSON.stringify({
    id: CHAR_ID,
    name: '测试角色',
    description: '',
    personality: '',
    scenario: '',
    firstMessage: '',
    exampleDialog: '',
    tags: [],
    creator: '',
    createdAt: 0,
    updatedAt: 0,
    alternateGreetings: [],
    avatar: '',
  }))
})

afterEach(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true })
})

describe('桥接路由集成', () => {
  it('server/info 返回版本', async () => {
    const app = express()
    app.use(express.json())
    app.use('/api/v1', buildBridgeRouter(new WsHub(), new BridgeChatService(new WsHub(), () => {}), () => {}))
    const { server, port } = await listen(app)
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/server/info`)
      const body = await res.json()
      expect(res.status).toBe(200)
      expect(body.apiVersion).toBe(1)
    } finally {
      server.close()
    }
  })

  it('version 返回服务器最新版本信息（需配对令牌）', async () => {
    const device = registerDevice('测试设备', 'fp-version')
    const token = signToken(device.deviceId)

    const app = express()
    app.use(express.json())
    app.use('/api/v1', buildBridgeRouter(new WsHub(), new BridgeChatService(new WsHub(), () => {}), () => {}))
    const { server, port } = await listen(app)
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/version`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const body = await res.json()
      expect(res.status).toBe(200)
      expect(body.version).toBe('0.11.22')
      expect(body.changelog).toBe('测试更新日志')
      expect(body.downloadUrl).toBe('https://example.com/qingyu/download')
    } finally {
      server.close()
    }
  })

  it('未携带令牌访问受保护端点返回 401', async () => {
    const app = express()
    app.use(express.json())
    app.use('/api/v1', buildBridgeRouter(new WsHub(), new BridgeChatService(new WsHub(), () => {}), () => {}))
    const { server, port } = await listen(app)
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/sessions`)
      expect(res.status).toBe(401)
    } finally {
      server.close()
    }
  })

  it('携带有效令牌可拉取会话与消息（cursor 分页）', async () => {
    // 预置数据
    const session = await chatData.createSession(CHAR_ID, '测试会话')
    for (let i = 0; i < 15; i++) {
      chatData.saveMessage(CHAR_ID, {
        id: `m${String(i).padStart(3, '0')}`,
        sessionId: session.id,
        characterId: CHAR_ID,
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `消息${i}`,
        images: [],
        isEditing: false,
        timestamp: 1000 + i * 1000,
      })
    }
    const device = registerDevice('测试设备', 'fp-test')
    const token = signToken(device.deviceId)

    const app = express()
    app.use(express.json())
    app.use('/api/v1', buildBridgeRouter(new WsHub(), new BridgeChatService(new WsHub(), () => {}), () => {}))
    const { server, port } = await listen(app)
    try {
      const base = `http://127.0.0.1:${port}/api/v1`
      const headers = { Authorization: `Bearer ${token}` }

      const sessionsRes = await fetch(`${base}/sessions`, { headers })
      const sessions = await sessionsRes.json()
      expect(sessions.length).toBe(1)
      expect(sessions[0].characterId).toBe(CHAR_ID)

      // 第一页（5 条，最新在前）
      const page1 = await (await fetch(`${base}/sessions/${session.id}/messages?limit=5`, { headers })).json()
      expect(page1.messages).toHaveLength(5)
      expect(page1.messages[0].content).toBe('消息14')
      expect(page1.nextCursor).not.toBeNull()

      // 第二页（beforeId 游标续拉）
      const page2 = await (await fetch(
        `${base}/sessions/${session.id}/messages?limit=5&beforeId=${page1.nextCursor}`, { headers },
      )).json()
      expect(page2.messages).toHaveLength(5)
      expect(page2.messages[0].content).toBe('消息9')

      // 分页合并后 10 条不重复
      const ids = new Set([...page1.messages, ...page2.messages].map((m: { id: string }) => m.id))
      expect(ids.size).toBe(10)
    } finally {
      server.close()
    }
  })

  it('新建会话支持传入开场白 + 会话列表含角色名 + 角色列表含备选开场白', async () => {
    // 预置带开场白的角色
    writeFileSync(join(DIRS.characters(), `${CHAR_ID}.json`), JSON.stringify({
      id: CHAR_ID,
      name: '测试角色',
      description: '',
      personality: '',
      scenario: '',
      firstMessage: '你好，{{user}}，我是{{char}}',
      exampleDialog: '',
      tags: [],
      creator: '',
      createdAt: 0,
      updatedAt: 0,
      alternateGreetings: ['备选开场白一', '备选开场白二'],
      avatar: '',
    }))
    const device = registerDevice('测试设备2', 'fp-test2')
    const token = signToken(device.deviceId)

    const app = express()
    app.use(express.json())
    app.use('/api/v1', buildBridgeRouter(new WsHub(), new BridgeChatService(new WsHub(), () => {}), () => {}))
    const { server, port } = await listen(app)
    try {
      const base = `http://127.0.0.1:${port}/api/v1`
      const headers = { Authorization: `Bearer ${token}` }

      // 角色列表包含备选开场白
      const chars = await (await fetch(`${base}/characters`, { headers })).json()
      expect(chars[0].alternateGreetings).toEqual(['备选开场白一', '备选开场白二'])

      // 新建会话并传入开场白
      const createRes = await fetch(`${base}/sessions`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ characterId: CHAR_ID, title: '新会话', greeting: '备选开场白一' }),
      })
      const created = await createRes.json()
      expect(created.messageCount).toBe(1)
      expect(created.lastMessage).toBe('备选开场白一')

      // 会话列表含角色名
      const sessions = await (await fetch(`${base}/sessions`, { headers })).json()
      expect(sessions[0].characterName).toBe('测试角色')

      // 消息列表首条为 assistant 开场白
      const msgs = await (await fetch(`${base}/sessions/${created.id}/messages`, { headers })).json()
      expect(msgs.messages).toHaveLength(1)
      expect(msgs.messages[0].role).toBe('assistant')
      expect(msgs.messages[0].content).toBe('备选开场白一')
    } finally {
      server.close()
    }
  })

  it('配对流程：无效码 401 -> 有效码挂起 -> 批准后签发令牌', async () => {
    const app = express()
    app.use(express.json())
    app.use('/api/v1', buildBridgeRouter(
      new WsHub(),
      new BridgeChatService(new WsHub(), () => {}),
      () => {},
      (requestId, deviceName) => {
        // 模拟 PC 端自动批准（人工确认由设置页触发）
        setTimeout(() => settlePair(requestId, true), 50)
        void deviceName
      },
    ))
    const { server, port } = await listen(app)
    try {
      const base = `http://127.0.0.1:${port}/api/v1`
      // 无效配对码
      const bad = await fetch(`${base}/auth/pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pairingCode: 'invalid', deviceName: '手机', deviceFingerprint: 'fp-1' }),
      })
      expect(bad.status).toBe(401)

      // 有效配对码 -> 挂起 -> 自动批准 -> 签发
      const code = generatePairingCode()
      const good = await fetch(`${base}/auth/pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pairingCode: code, deviceName: '小米手机', deviceFingerprint: 'fp-1' }),
      })
      expect(good.status).toBe(200)
      const body = await good.json()
      expect(body.token).toBeTruthy()
      expect(body.deviceId).toBeTruthy()

      // 已登记设备直接续签（无需再审批）
      const again = await fetch(`${base}/auth/pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pairingCode: generatePairingCode(), deviceName: '小米手机', deviceFingerprint: 'fp-1' }),
      })
      expect(again.status).toBe(200)
      expect((await again.json()).deviceId).toBe(body.deviceId)
    } finally {
      server.close()
    }
  })

  it('配对码可选：无配对码时跳过校验（靠人工确认兜底）', async () => {
    const app = express()
    app.use(express.json())
    app.use('/api/v1', buildBridgeRouter(
      new WsHub(),
      new BridgeChatService(new WsHub(), () => {}),
      () => {},
      (_requestId, _deviceName) => {
        setTimeout(() => settlePair(_requestId, true), 50)
      },
    ))
    const { server, port } = await listen(app)
    try {
      const base = `http://127.0.0.1:${port}/api/v1`
      // 无配对码（不传/空串均视为可选）：未登记设备挂起 -> 自动批准 -> 签发
      const res = await fetch(`${base}/auth/pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceName: '无码手机', deviceFingerprint: 'fp-nocode' }),
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.token).toBeTruthy()
      expect(body.deviceId).toBeTruthy()
    } finally {
      server.close()
    }
  })

  it('设置/世界书/预设端点：读改写全链路', async () => {
    const device = registerDevice('测试设备3', 'fp-test3')
    const token = signToken(device.deviceId)
    const app = express()
    app.use(express.json())
    app.use('/api/v1', buildBridgeRouter(new WsHub(), new BridgeChatService(new WsHub(), () => {}), () => {}))
    const { server, port } = await listen(app)
    try {
      const base = `http://127.0.0.1:${port}/api/v1`
      const headers = { Authorization: `Bearer ${token}` }

      // 设置：读取 -> 修改 -> 再读
      const s1 = await (await fetch(`${base}/settings`, { headers })).json()
      expect(typeof s1.translationTargetLang).toBe('string')
      const patchSettings = await fetch(`${base}/settings`, {
        method: 'PATCH',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ userName: '安卓用户', translationTargetLang: '英语' }),
      })
      expect(patchSettings.status).toBe(200)
      const s2 = await (await fetch(`${base}/settings`, { headers })).json()
      expect(s2.userName).toBe('安卓用户')
      expect(s2.translationTargetLang).toBe('英语')

      // 世界书列表（空）与预设列表（含内置）
      const lorebooks = await (await fetch(`${base}/lorebooks`, { headers })).json()
      expect(Array.isArray(lorebooks)).toBe(true)
      const presets = await (await fetch(`${base}/presets`, { headers })).json()
      expect(Array.isArray(presets)).toBe(true)
      expect(presets.length).toBeGreaterThan(0)

      // 会话世界书：读 -> 改 -> 读
      const session = await chatData.createSession(CHAR_ID, '设置测试会话')
      const lb0 = await (await fetch(`${base}/sessions/${session.id}/lorebooks`, { headers })).json()
      expect(lb0.lorebookIds).toEqual([])
      const patchLb = await fetch(`${base}/sessions/${session.id}/lorebooks`, {
        method: 'PATCH',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ lorebookIds: ['lb-001', 'lb-002'] }),
      })
      expect(patchLb.status).toBe(200)
      const lb1 = await (await fetch(`${base}/sessions/${session.id}/lorebooks`, { headers })).json()
      expect(lb1.lorebookIds).toEqual(['lb-001', 'lb-002'])

      // 会话预设：读 -> 改 -> 读
      const p0 = await (await fetch(`${base}/sessions/${session.id}/preset`, { headers })).json()
      expect(p0).toHaveProperty('presetId')
      const patchPreset = await fetch(`${base}/sessions/${session.id}/preset`, {
        method: 'PATCH',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ presetId: 'preset-test' }),
      })
      expect(patchPreset.status).toBe(200)
      const p1 = await (await fetch(`${base}/sessions/${session.id}/preset`, { headers })).json()
      expect(p1.presetId).toBe('preset-test')

      // 清空对话：写入消息后 DELETE，消息应清空
      chatData.saveMessage(CHAR_ID, {
        id: 'clear-test-1',
        sessionId: session.id,
        characterId: CHAR_ID,
        role: 'user',
        content: '测试消息',
        images: [],
        isEditing: false,
        timestamp: Date.now(),
      })
      const before = chatData.readMessages(CHAR_ID, session.id)
      expect(before.length).toBeGreaterThan(0)
      const del = await fetch(`${base}/sessions/${session.id}/messages`, {
        method: 'DELETE',
        headers,
      })
      expect(del.status).toBe(200)
      const after = chatData.readMessages(CHAR_ID, session.id)
      expect(after.length).toBe(0)
    } finally {
      server.close()
    }
  })
})
