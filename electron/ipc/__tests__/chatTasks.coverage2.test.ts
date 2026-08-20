/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync } from 'node:fs'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/qingyu-chattasks-cov2-test' } }))
const TEST_ROOT = '/tmp/qingyu-chattasks-cov2-test'

import { registerChatTaskIPC } from '../chatTasks'

function makeIpc() {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const ipcMain = {
    handle: (ch: string, fn: (...a: unknown[]) => unknown) => handlers.set(ch, fn),
  }
  return { ipcMain: ipcMain as unknown as import('electron').IpcMain, handlers }
}

beforeEach(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true })
})
afterEach(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true })
})

describe('chatTasks coverage2 - 校验分支', () => {
  it('start 缺 requestId 抛', async () => {
    const { ipcMain, handlers } = makeIpc()
    registerChatTaskIPC(ipcMain, () => null)
    const fn = handlers.get('chatTask:start')!
    await expect(fn({} as unknown, { type: 'send', sessionId: 's1', content: 'hi' })).rejects.toThrow('requestId')
  })

  it('start 缺 sessionId 抛', async () => {
    const { ipcMain, handlers } = makeIpc()
    registerChatTaskIPC(ipcMain, () => null)
    const fn = handlers.get('chatTask:start')!
    await expect(fn({} as unknown, { type: 'send', requestId: 'req-1', content: 'hi' })).rejects.toThrow('sessionId')
  })

  it('start content 过长 抛', async () => {
    const { ipcMain, handlers } = makeIpc()
    registerChatTaskIPC(ipcMain, () => null)
    const fn = handlers.get('chatTask:start')!
    const long = 'a'.repeat(20001)
    await expect(fn({} as unknown, { type: 'send', requestId: 'req-long', sessionId: 's1', content: long })).rejects.toThrow('过长')
  })

  it('retry_generation 允许缺 sessionId', async () => {
    const { ipcMain, handlers } = makeIpc()
    const { mkdirSync, writeFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { DIRS } = await import('../../services/storage')
    const { chatData } = await import('../../ipc/chat')
    const { createTask } = await import('../../chat/taskStore')
    mkdirSync(DIRS.characters(), { recursive: true })
    writeFileSync(join(DIRS.characters(), 'char-cov2-retry.json'), JSON.stringify({ id: 'char-cov2-retry', name: 'T', description: '', personality: '', scenario: '', firstMessage: 'hi', exampleDialog: '', tags: [], lorebookId: null, creator: '', createdAt: 0, updatedAt: 0, alternateGreetings: [] }), 'utf-8')
    const session = await chatData.createSession('char-cov2-retry', 'retry-s')
    const snap = {
      schemaVersion: 1 as const,
      taskId: 'task-retry-cov2',
      requestId: 'req-retry-cov2',
      type: 'send' as const,
      state: 'completed' as const,
      sessionId: session.id,
      characterId: 'char-cov2-retry',
      client: { kind: 'desktop' as const, clientId: 'desktop', protocolVersion: 2 as const },
      accumulatedText: 'hi',
      lastSequence: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    createTask(snap as unknown as import('../../../shared/chat-core/events').TaskSnapshot)

    const fakeWin = { webContents: { send: vi.fn() } } as unknown as import('electron').BrowserWindow
    registerChatTaskIPC(ipcMain, () => fakeWin)

    const fn = handlers.get('chatTask:retry')!
    const out = await fn({} as unknown, 'task-retry-cov2')
    expect(out.taskId).toBeTruthy()
  })

  it('retry 不存在抛', async () => {
    const { ipcMain, handlers } = makeIpc()
    registerChatTaskIPC(ipcMain, () => null)
    const fn = handlers.get('chatTask:retry')!
    await expect(fn({} as unknown, 'not-exist')).rejects.toThrow('不存在')
  })
})
