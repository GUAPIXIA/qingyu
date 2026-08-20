import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { rmSync } from 'node:fs'

const TEST_ROOT = '/tmp/qingyu-chat-tasks-ipc-test'
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/qingyu-chat-tasks-ipc-test', getVersion: () => '0.12.0' },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() },
  ipcMain: { handle: vi.fn() },
}))

import { registerChatTaskIPC } from '../chatTasks'

function mockIpc() {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  const ipcMain = { handle: vi.fn((ch: string, fn: unknown) => handlers.set(ch, fn as never)) } as unknown as import('electron').IpcMain
  return { ipcMain, handlers }
}

describe('chatTask IPC', () => {
  beforeEach(() => rmSync(TEST_ROOT, { recursive: true, force: true }))
  afterEach(() => rmSync(TEST_ROOT, { recursive: true, force: true }))

  it('注册 6 个 channel', () => {
    const { ipcMain, handlers } = mockIpc()
    registerChatTaskIPC(ipcMain, () => null)
    expect(handlers.has('chatTask:start')).toBe(true)
    expect(handlers.has('chatTask:get')).toBe(true)
    expect(handlers.has('chatTask:listBySession')).toBe(true)
    expect(handlers.has('chatTask:eventsAfter')).toBe(true)
    expect(handlers.has('chatTask:cancel')).toBe(true)
    expect(handlers.has('chatTask:retry')).toBe(true)
  })

  it('start 校验 requestId/sessionId', async () => {
    const { ipcMain, handlers } = mockIpc()
    registerChatTaskIPC(ipcMain, () => null)
    const h = handlers.get('chatTask:start')!
    await expect(h({}, { requestId: '', sessionId: 's1' })).rejects.toThrow(/参数无效/)
    await expect(h({}, { requestId: 'r1', sessionId: '' })).rejects.toThrow(/参数无效/)
  })
})
