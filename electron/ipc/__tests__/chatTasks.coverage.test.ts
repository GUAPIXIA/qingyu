 
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { rmSync } from 'node:fs'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/qingyu-chattasks-cov-test', getVersion: () => '0.12.0' },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() },
  ipcMain: { handle: vi.fn() },
}))

const TEST_ROOT = '/tmp/qingyu-chattasks-cov-test'

import { registerChatTaskIPC } from '../chatTasks'
import { createTask } from '../../chat/taskStore'
import type { TaskSnapshot } from '../../../shared/chat-core/events'

function snap(over: Partial<TaskSnapshot> = {}): TaskSnapshot {
  return { schemaVersion: 1, taskId: 'task-' + Math.random().toString(36).slice(2,8), requestId: 'req-' + Math.random().toString(36).slice(2,8), type: 'send', state: 'completed', sessionId: 'sess-1', characterId: 'char-1', client: { kind: 'desktop', clientId: 'c1', protocolVersion: 2 }, accumulatedText: 'hi', lastSequence: 1, createdAt: Date.now(), updatedAt: Date.now(), ...over }
}

describe('chatTasks coverage', () => {
  beforeEach(async () => {
    rmSync(TEST_ROOT, { recursive: true, force: true })
    // 为 retry 准备真实会话/角色（messagePort.findSession 需要）
    const { DIRS } = await import('../../services/storage')
    const { mkdirSync, writeFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    mkdirSync(DIRS.characters(), { recursive: true })
    writeFileSync(join(DIRS.characters(), 'char-1.json'), JSON.stringify({ id: 'char-1', name: 'Test', description: '', personality: '', scenario: '', firstMessage: 'hi', exampleDialog: '', tags: [], lorebookId: null, creator: '', createdAt: 0, updatedAt: 0, alternateGreetings: [] }), 'utf-8')
    const { chatData } = await import('../../ipc/chat')
    await chatData.createSession('char-1', 'test')
    // 用真实创建的会话 ID 覆盖 snap 的 sessionId，确保后续 findSession 成功
    const sessions = await chatData.listSessions('char-1')
    const realSessionId = sessions[0]?.id ?? 'sess-1'
    // 覆盖全局 snap 工厂以使用真实 ID（测试内动态）
    ;(globalThis as unknown as { __realSessionId: string }).__realSessionId = realSessionId
  })
  afterEach(() => rmSync(TEST_ROOT, { recursive: true, force: true }))

  it('get/list/events/cancel/retry 分支', async () => {
    const handlers = new Map<string, (e: unknown, ...a: unknown[]) => unknown>()
    const ipcMain = { handle: vi.fn((ch: string, fn: unknown) => handlers.set(ch, fn as never)) } as unknown as import('electron').IpcMain
    registerChatTaskIPC(ipcMain, () => null)
    const realSessionId = (globalThis as unknown as { __realSessionId: string }).__realSessionId ?? 'sess-1'
    const s = snap({ taskId: 'task-get', requestId: 'req-get', sessionId: realSessionId })
    createTask(s)
    const get = handlers.get('chatTask:get')!
    expect(await (get as (e: unknown, id: string) => Promise<unknown>)({}, 'task-get')).toBeTruthy()
    expect(await (get as (e: unknown, id: string) => Promise<unknown>)({}, 'not-exist')).toBeNull()

    const list = handlers.get('chatTask:listBySession')!
    const listed = await (list as (e: unknown, sid: string) => Promise<TaskSnapshot[]>)({}, 'sess-1')
    expect(Array.isArray(listed)).toBe(true)

    const ev = handlers.get('chatTask:eventsAfter')!
    const page = await (ev as (e: unknown, id: string, seq: number) => Promise<{ events: unknown[] }>)({}, 'task-get', 0)
    expect(Array.isArray(page.events)).toBe(true)

    const cancel = handlers.get('chatTask:cancel')!
    const c = await (cancel as (e: unknown, id: string) => Promise<TaskSnapshot>)({}, 'task-get')
    expect(c.taskId).toBe('task-get')

    const retry = handlers.get('chatTask:retry')!
    const r = await (retry as (e: unknown, id: string) => Promise<{ taskId: string }>)({}, 'task-get')
    expect(r.taskId).toBeTruthy()

    await expect((retry as (e: unknown, id: string) => Promise<unknown>)({}, 'not-exist')).rejects.toThrow()
  })
})
