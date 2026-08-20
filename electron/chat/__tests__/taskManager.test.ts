import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { rmSync } from 'node:fs'

const TEST_ROOT = '/tmp/qingyu-taskmanager-test'
vi.mock('electron', () => ({ app: { getPath: () => TEST_ROOT } }))

import { createTask } from '../taskStore'
import { transitionTask, cancelTask, acquireSessionOrThrow } from '../taskManager'
import { sessionLock } from '../sessionLock'
import type { TaskSnapshot } from '../../../shared/chat-core/events'

function snap(over: Partial<TaskSnapshot> = {}): TaskSnapshot {
  return {
    schemaVersion: 1,
    taskId: 'task-' + Math.random().toString(36).slice(2, 8),
    requestId: 'req-' + Math.random().toString(36).slice(2, 8),
    type: 'send',
    state: 'queued',
    sessionId: 'sess-1',
    characterId: 'char-1',
    client: { kind: 'desktop', clientId: 'c1', protocolVersion: 2 },
    accumulatedText: '',
    lastSequence: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...over,
  }
}

beforeEach(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true })
  sessionLock.clear()
})
afterEach(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true })
  sessionLock.clear()
})

describe('TaskManager 状态机', () => {
  it('合法流转 queued->preparing->streaming->finalizing->completed', () => {
    const s = snap({ taskId: 't1', requestId: 'r1', state: 'queued' })
    createTask(s)
    expect(transitionTask('t1', 'preparing').state).toBe('preparing')
    expect(transitionTask('t1', 'streaming').state).toBe('streaming')
    expect(transitionTask('t1', 'finalizing').state).toBe('finalizing')
    expect(transitionTask('t1', 'completed').state).toBe('completed')
  })

  it('waiting_approval 往返', () => {
    const s = snap({ taskId: 't2', requestId: 'r2', state: 'streaming' })
    createTask(s)
    expect(transitionTask('t2', 'waiting_approval').state).toBe('waiting_approval')
    expect(transitionTask('t2', 'streaming').state).toBe('streaming')
  })

  it('非法转换抛 TASK_CONFLICT', () => {
    const s = snap({ taskId: 't3', requestId: 'r3', state: 'completed' })
    createTask(s)
    try {
      transitionTask('t3', 'streaming')
      expect.unreachable('应抛')
    } catch (e) {
      expect((e as { code?: string }).code).toBe('TASK_CONFLICT')
    }
  })

  it('cancel 幂等', () => {
    const s = snap({ taskId: 't4', requestId: 'r4', state: 'streaming' })
    createTask(s)
    const c1 = cancelTask('t4')
    expect(c1.state).toBe('cancelled')
    const c2 = cancelTask('t4')
    expect(c2.state).toBe('cancelled')
  })

  it('终态 cancel 返回快照不抛错', () => {
    const s = snap({ taskId: 't5', requestId: 'r5', state: 'completed' })
    createTask(s)
    expect(cancelTask('t5').state).toBe('completed')
  })

  it('acquireSessionOrThrow 并发抛 TASK_CONFLICT', () => {
    const s1 = snap({ taskId: 't6', requestId: 'r6', sessionId: 'sess-x' })
    const s2 = snap({ taskId: 't7', requestId: 'r7', sessionId: 'sess-x' })
    createTask(s1)
    createTask(s2)
    acquireSessionOrThrow('sess-x', 't6')
    try {
      acquireSessionOrThrow('sess-x', 't7')
      expect.unreachable('应抛 TASK_CONFLICT')
    } catch (e) {
      expect((e as { code?: string }).code).toBe('TASK_CONFLICT')
    }
  })
})
