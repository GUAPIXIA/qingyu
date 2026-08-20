/* eslint-disable @typescript-eslint/no-unused-vars */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { join } from 'node:path'
import { rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs'

const TEST_ROOT = '/tmp/qingyu-compaction-test'

vi.mock('electron', () => ({
  app: { getPath: () => TEST_ROOT },
}))

import { createTask, appendEvent, readEvents, getTaskSnapshot, listActiveTasks } from '../taskStore'
import { compactTaskEvents, cleanupTerminalTasks, compactAllEligible } from '../compaction'
import type { TaskSnapshot, TaskEventEnvelope } from '../../../shared/chat-core/events'

function snap(over: Partial<TaskSnapshot> = {}): TaskSnapshot {
  return {
    schemaVersion: 1,
    taskId: 'task-' + Math.random().toString(36).slice(2, 8),
    requestId: 'req-' + Math.random().toString(36).slice(2, 8),
    type: 'send',
    state: 'completed',
    sessionId: 'sess-1',
    characterId: 'char-1',
    client: { kind: 'desktop', clientId: 'c1', protocolVersion: 2 },
    accumulatedText: 'hello world',
    lastSequence: 5,
    createdAt: Date.now() - 30 * 60 * 60 * 1000,
    finishedAt: Date.now() - 25 * 60 * 60 * 1000,
    updatedAt: Date.now() - 25 * 60 * 60 * 1000,
    ...over,
  }
}

function ev(taskId: string, requestId: string, seq: number, type: TaskEventEnvelope['type']): TaskEventEnvelope {
  return { protocolVersion: 2, eventId: `e${seq}`, taskId, requestId, sessionId: 'sess-1', sequence: seq, type, timestamp: Date.now(), payload: {} }
}

beforeEach(() => rmSync(TEST_ROOT, { recursive: true, force: true }))
afterEach(() => rmSync(TEST_ROOT, { recursive: true, force: true }))

describe('压缩策略', () => {
  it('24h 后压缩仅保留 terminal', () => {
    const s = snap({ taskId: 't1', requestId: 'r1', state: 'completed', finishedAt: Date.now() - 25 * 60 * 60 * 1000, updatedAt: Date.now() - 25 * 60 * 60 * 1000 })
    createTask(s)
    appendEvent(ev('t1', 'r1', 1, 'task:accepted'))
    appendEvent(ev('t1', 'r1', 2, 'task:chunk'))
    appendEvent(ev('t1', 'r1', 3, 'task:completed'))
    expect(compactTaskEvents('t1')).toBe(true)
    const page = readEvents('t1', 0, 200)
    expect(page.events).toHaveLength(1)
    expect(page.events[0].type).toBe('task:completed')
  })

  it('未满 24h 不压缩', () => {
    const s = snap({ taskId: 't2', requestId: 'r2', state: 'completed', finishedAt: Date.now() - 1 * 60 * 60 * 1000, updatedAt: Date.now() - 1 * 60 * 60 * 1000 })
    createTask(s)
    appendEvent(ev('t2', 'r2', 1, 'task:completed'))
    expect(compactTaskEvents('t2')).toBe(false)
  })

  it('非终态不压缩', () => {
    const s = snap({ taskId: 't3', requestId: 'r3', state: 'streaming', finishedAt: undefined } as Partial<TaskSnapshot>)
    createTask({ ...s, state: 'streaming', finishedAt: undefined } as TaskSnapshot)
    appendEvent(ev('t3', 'r3', 1, 'task:chunk'))
    expect(compactTaskEvents('t3')).toBe(false)
  })

  it('压缩后 readEvents 触发 resyncRequired', () => {
    const s = snap({ taskId: 't4', requestId: 'r4', state: 'completed', lastSequence: 10, accumulatedText: 'compressed', finishedAt: Date.now() - 30 * 60 * 60 * 1000, updatedAt: Date.now() - 30 * 60 * 60 * 1000 })
    createTask(s)
    appendEvent(ev('t4', 'r4', 1, 'task:accepted'))
    appendEvent(ev('t4', 'r4', 10, 'task:completed'))
    compactTaskEvents('t4')
    const page = readEvents('t4', 5, 200)
    expect(page.resyncRequired).toBe(true)
    expect(page.snapshot?.accumulatedText).toBe('compressed')
  })
})

describe('保留策略', () => {
  it('超过 200 个或 7 天的 terminal 被清理', () => {
    const now = Date.now()
    // 创建 205 个过期任务
    for (let i = 0; i < 205; i++) {
      const s = snap({
        taskId: `t-ret-${i}`,
        requestId: `r-ret-${i}`,
        state: 'completed',
        updatedAt: now - 8 * 24 * 60 * 60 * 1000,
        finishedAt: now - 8 * 24 * 60 * 60 * 1000,
      })
      createTask(s)
    }
    const deleted = cleanupTerminalTasks(now)
    expect(deleted.length).toBeGreaterThan(0)
    // 保留不超过 200
    const remaining = listActiveTasks().filter((t: TaskSnapshot) => ['completed'].includes(t.state))
    expect(remaining.length).toBeLessThanOrEqual(200)
  })

  it('7天内且 200 以内不清理', () => {
    const s = snap({ taskId: 't-keep', requestId: 'r-keep', state: 'completed', updatedAt: Date.now(), finishedAt: Date.now() })
    createTask(s)
    const deleted = cleanupTerminalTasks(Date.now())
    expect(deleted).not.toContain('t-keep')
    expect(getTaskSnapshot('t-keep')).not.toBeNull()
  })
})
