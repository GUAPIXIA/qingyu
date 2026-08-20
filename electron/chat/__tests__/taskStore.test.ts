import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { join } from 'node:path'
import { rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs'

const TEST_ROOT = '/tmp/qingyu-taskstore-test'

vi.mock('electron', () => ({
  app: { getPath: () => TEST_ROOT },
}))

import { createTask, findByRequestId, getTaskSnapshot, updateTask, appendEvent, readEvents, listActiveTasks, markInterrupted } from '../taskStore'
import type { TaskSnapshot, TaskEventEnvelope } from '../../../shared/chat-core/events'

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

beforeEach(() => rmSync(TEST_ROOT, { recursive: true, force: true }))
afterEach(() => rmSync(TEST_ROOT, { recursive: true, force: true }))

describe('TaskStore', () => {
  it('create + findByRequestId 幂等', () => {
    const s = snap({ requestId: 'req-1', taskId: 'task-1' })
    createTask(s)
    const dup = snap({ requestId: 'req-1', taskId: 'task-2' })
    const returned = createTask(dup)
    expect(returned.taskId).toBe('task-1')
    expect(findByRequestId('req-1')?.taskId).toBe('task-1')
  })

  it('updateTask 原子更新并同步索引', () => {
    const s = snap({ requestId: 'req-2', taskId: 'task-2', state: 'queued' })
    createTask(s)
    updateTask('task-2', { state: 'streaming' })
    expect(getTaskSnapshot('task-2')?.state).toBe('streaming')
    expect(findByRequestId('req-2')?.state).toBe('streaming')
  })

  it('appendEvent + readEvents 分页与 afterSequence', () => {
    const s = snap({ requestId: 'req-3', taskId: 'task-3' })
    createTask(s)
    for (let i = 1; i <= 5; i++) {
      appendEvent({ protocolVersion: 2, eventId: `e${i}`, taskId: 'task-3', requestId: 'req-3', sessionId: 'sess-1', sequence: i, type: 'task:chunk', timestamp: Date.now(), payload: { delta: `c${i}` } } as TaskEventEnvelope)
    }
    const page1 = readEvents('task-3', 0, 2)
    expect(page1.events).toHaveLength(2)
    expect(page1.events[0].sequence).toBe(1)
    expect(page1.nextAfterSequence).toBe(2)
    const page2 = readEvents('task-3', 2, 10)
    expect(page2.events[0].sequence).toBe(3)
  })

  it('损坏的 active json 不崩溃', () => {
    const s = snap({ requestId: 'req-4', taskId: 'task-4' })
    createTask(s)
    writeFileSync(join(TEST_ROOT, 'data/tasks/active/task-4.json'), '{ broken', 'utf-8')
    expect(getTaskSnapshot('task-4')).toBeNull()
    expect(listActiveTasks().find((t) => t.taskId === 'task-4')).toBeUndefined()
  })

  it('markInterrupted 仅对非终态生效', () => {
    const s = snap({ requestId: 'req-5', taskId: 'task-5', state: 'streaming' })
    createTask(s)
    markInterrupted('task-5')
    expect(getTaskSnapshot('task-5')?.state).toBe('interrupted')
    const c = snap({ requestId: 'req-6', taskId: 'task-6', state: 'completed' })
    createTask(c)
    markInterrupted('task-6')
    expect(getTaskSnapshot('task-6')?.state).toBe('completed')
  })

  it('并发创建同一 requestId 只保留一个（串行幂等）', () => {
    const s1 = snap({ requestId: 'req-7', taskId: 'task-7a' })
    const s2 = snap({ requestId: 'req-7', taskId: 'task-7b' })
    createTask(s1)
    createTask(s2)
    expect(findByRequestId('req-7')?.taskId).toBe('task-7a')
    expect(listActiveTasks().filter((t) => t.requestId === 'req-7')).toHaveLength(1)
  })
})
