import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { rmSync } from 'node:fs'

const TEST_ROOT = '/tmp/qingyu-reconciler-test'
vi.mock('electron', () => ({ app: { getPath: () => TEST_ROOT } }))

import { createTask, getTaskSnapshot, appendEvent } from '../taskStore'
import { reconcileTasks } from '../reconciler'
import type { TaskSnapshot } from '../../../shared/chat-core/events'

function snap(over: Partial<TaskSnapshot> = {}): TaskSnapshot {
  return {
    schemaVersion: 1,
    taskId: 'task-' + Math.random().toString(36).slice(2, 8),
    requestId: 'req-' + Math.random().toString(36).slice(2, 8),
    type: 'send',
    state: 'streaming',
    sessionId: 'sess-1',
    characterId: 'char-1',
    client: { kind: 'desktop', clientId: 'c1', protocolVersion: 2 },
    accumulatedText: 'part',
    lastSequence: 2,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...over,
  }
}

beforeEach(() => rmSync(TEST_ROOT, { recursive: true, force: true }))
afterEach(() => rmSync(TEST_ROOT, { recursive: true, force: true }))

describe('Reconciler', () => {
  it('非终态统一 interrupted', async () => {
    for (const state of ['queued', 'preparing', 'streaming', 'waiting_approval', 'finalizing'] as const) {
      const s = snap({ taskId: `t-${state}`, requestId: `r-${state}`, state })
      createTask(s)
    }
    const res = await reconcileTasks()
    expect(res.interrupted).toHaveLength(5)
    for (const id of res.interrupted) {
      expect(getTaskSnapshot(id)?.state).toBe('interrupted')
    }
  })

  it('completed 但事件缺失补 recovered', async () => {
    const s = snap({ taskId: 't-comp', requestId: 'r-comp', state: 'completed', accumulatedText: 'done', assistantMessageId: 'msg-1', lastSequence: 5 })
    createTask(s)
    // 不写事件，触发补事件
    const res = await reconcileTasks({ findMessage: async () => true })
    expect(res.recovered).toContain('t-comp')
  })

  it('completed 但助手缺失标记 PERSISTENCE_FAILED', async () => {
    const s = snap({ taskId: 't-persist', requestId: 'r-persist', state: 'completed', assistantMessageId: 'msg-missing', lastSequence: 5 })
    createTask(s)
    appendEvent({ protocolVersion: 2, eventId: 'e1', taskId: 't-persist', requestId: 'r-persist', sessionId: 'sess-1', sequence: 1, type: 'task:completed', timestamp: Date.now(), payload: {} })
    const res = await reconcileTasks({ findMessage: async () => false })
    expect(res.persistenceFailed).toContain('t-persist')
    expect(getTaskSnapshot('t-persist')?.error?.code).toBe('PERSISTENCE_FAILED')
  })

  it('终态不重复 interrupted', async () => {
    const s = snap({ taskId: 't-done', requestId: 'r-done', state: 'completed' })
    createTask(s)
    appendEvent({ protocolVersion: 2, eventId: 'e1', taskId: 't-done', requestId: 'r-done', sessionId: 'sess-1', sequence: 1, type: 'task:completed', timestamp: Date.now(), payload: {} })
    const res = await reconcileTasks({ findMessage: async () => true })
    expect(res.interrupted).not.toContain('t-done')
  })
})
