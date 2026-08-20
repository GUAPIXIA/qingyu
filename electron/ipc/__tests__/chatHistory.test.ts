/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const TEST_ROOT = '/tmp/qingyu-chat-history-test'
vi.mock('electron', () => ({
  app: { getPath: () => TEST_ROOT },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() },
}))

import { registerChatIPC, chatData } from '../chat'

// Helper to capture ipc handlers
function makeIpc() {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const ipcMain = {
    handle: (ch: string, fn: (...a: unknown[]) => unknown) => handlers.set(ch, fn),
  } as unknown as import('electron').IpcMain
  return { ipcMain, handlers }
}

beforeEach(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true })
})

afterEach(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true })
})

describe('chat:getMemoryHistory', () => {
  it('返回归档历史并支持分页与状态过滤', async () => {
    const { ipcMain, handlers } = makeIpc()
    registerChatIPC(ipcMain)
    const h = handlers.get('chat:getMemoryHistory')
    expect(h).toBeDefined()

    // 准备角色与会话
    const charId = 'char-history'
    mkdirSync(join(TEST_ROOT, 'data', 'chats', charId), { recursive: true })
    // 需要角色目录下的 sessions 写入，通过 chatData API 创建
    const session = await chatData.createSession(charId, '历史测试')
    const hist = [
      { id: 'f1', subject: '林夏', predicate: '关系', value: '朋友', status: 'superseded', importance: 3, confidence: 0.8, sourceMessageIds: ['m1'], updatedAt: 1000 },
      { id: 'f2', subject: '林夏', predicate: '关系', value: '恋人', status: 'active', importance: 5, confidence: 0.9, sourceMessageIds: ['m2'], updatedAt: 2000 },
      { id: 'f3', subject: '道具', predicate: '持有', value: '钥匙', status: 'inactive', importance: 2, confidence: 0.7, sourceMessageIds: ['m3'], updatedAt: 3000 },
      { id: 'f4', subject: '地点', predicate: '所在地', value: '旅店', status: 'superseded', importance: 4, confidence: 0.8, sourceMessageIds: [], updatedAt: 4000 },
    ]
    // history 是归档（inactive/superseded），active 事实在 memoryFacts，history 仅归档
    await chatData.updateSession(charId, session.id, {
      memoryFactHistory: [hist[0], hist[2], hist[3]],
      memoryFacts: [hist[1]],
    } as unknown)

    const all = await (h as unknown as (e: unknown, a: string, b: string) => Promise<{ history: unknown[]; total: number }>)(null, charId, session.id, {})
    expect(all.total).toBe(3)
    expect(all.history).toHaveLength(3)

    const page = await (h as unknown as (e: unknown, a: string, b: string, o: unknown) => Promise<{ history: unknown[]; total: number }>)(null, charId, session.id, { limit: 1, offset: 1 })
    expect(page.history).toHaveLength(1)
    expect(page.total).toBe(3)
    // 按插入顺序，offset 1 为第二条（inactive）
    expect((page.history[0] as { id: string }).id).toBe('f3')

    const filtered = await (h as unknown as (e: unknown, a: string, b: string, o: unknown) => Promise<{ history: unknown[]; total: number }>)(null, charId, session.id, { status: 'superseded' })
    expect(filtered.total).toBe(2)
    expect(filtered.history.every((x: { status: string }) => x.status === 'superseded')).toBe(true)

    const inactive = await (h as unknown as (e: unknown, a: string, b: string, o: unknown) => Promise<{ history: unknown[]; total: number }>)(null, charId, session.id, { status: 'inactive' })
    expect(inactive.total).toBe(1)
  })

  it('会话不存在抛错', async () => {
    const { ipcMain, handlers } = makeIpc()
    registerChatIPC(ipcMain)
    const h = handlers.get('chat:getMemoryHistory')!
    await expect((h as unknown as (e: unknown, a: string, b: string) => Promise<unknown>)(null, 'no-char', 'no-session')).rejects.toThrow('会话不存在')
  })
})

describe('bridge GET /sessions/:id/memory/history', () => {
  it('桥接历史接口分页过滤', async () => {
    // 复用 chatData 创建会话与历史
    const charId = 'char-bridge-hist'
    const session = await chatData.createSession(charId, '桥接历史')
    const hist = [
      { id: 'h1', subject: 'A', predicate: 'p', value: 'v1', status: 'superseded', importance: 3, confidence: 0.8, sourceMessageIds: [], updatedAt: 1 },
      { id: 'h2', subject: 'B', predicate: 'p', value: 'v2', status: 'inactive', importance: 2, confidence: 0.7, sourceMessageIds: [], updatedAt: 2 },
    ]
    await chatData.updateSession(charId, session.id, { memoryFactHistory: hist } as unknown)

    // 通过 bridge router 直接调用 handler：模拟 express req/res
    const { buildBridgeRouter } = await import('../../bridge/routes')
    const { WsHub } = await import('../../bridge/ws')
    const { BridgeChatService } = await import('../../bridge/chatService')
    const express = (await import('express')).default
    const { registerDevice, signToken } = await import('../../bridge/auth')
    const hub = new WsHub()
    const chatService = new BridgeChatService(hub, () => {})
    const router = buildBridgeRouter(hub, chatService, () => {})
    const app = express()
    app.use(express.json())
    app.use('/api/v1', router)
    const { createServer } = await import('node:http')
    const server = createServer(app)
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const port = (server.address() as { port: number }).port
    const device = registerDevice('test-device', 'fp-test')
    const token = signToken(device.deviceId)
    try {
      const headers = { Authorization: `Bearer ${token}` }
      const r1 = await fetch(`http://127.0.0.1:${port}/api/v1/sessions/${session.id}/memory/history?characterId=${charId}`, { headers })
      expect(r1.status).toBe(200)
      const j1 = await r1.json() as { history: unknown[]; total: number }
      expect(j1.total).toBe(2)
      const r2 = await fetch(`http://127.0.0.1:${port}/api/v1/sessions/${session.id}/memory/history?status=inactive&characterId=${charId}`, { headers })
      const j2 = await r2.json() as { history: unknown[]; total: number }
      expect(j2.total).toBe(1)
    } finally {
      server.close()
      hub.close()
    }
  })
})
