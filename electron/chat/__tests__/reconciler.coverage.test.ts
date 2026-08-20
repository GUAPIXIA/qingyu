/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync } from 'node:fs'

const TEST_ROOT = '/tmp/qingyu-reconciler-cov-test'
vi.mock('electron', () => ({ app: { getPath: () => TEST_ROOT } }))

import { reconcileTasks } from '../reconciler'
import { createTask } from '../taskStore'

beforeEach(() => rmSync(TEST_ROOT, { recursive: true, force: true }))
afterEach(() => rmSync(TEST_ROOT, { recursive: true, force: true }))

function baseSnap(overrides = {}): import('../../../shared/chat-core/events').TaskSnapshot {
  return {
    schemaVersion: 1 as const,
    taskId: `task-${Math.random().toString(36).slice(2, 6)}`,
    requestId: `req-${Math.random().toString(36).slice(2, 6)}`,
    type: 'send' as const,
    state: 'streaming' as const,
    sessionId: 's1',
    characterId: 'c1',
    client: { kind: 'desktop' as const, clientId: 'c1', protocolVersion: 2 as const },
    accumulatedText: 'part',
    lastSequence: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    userMessageId: 'msg-u1',
    ...overrides,
  }
}

describe('reconciler coverage - 剩余分支', () => {
  it('findUserMessage / findMessage 异常被捕获', async () => {
    createTask(baseSnap({ taskId: 'task-err-user', requestId: 'req-err-user', userMessageId: 'msg-u1', assistantMessageId: 'msg-a1', state: 'streaming' }))
    const res = await reconcileTasks({
      findUserMessage: async () => { throw new Error('boom') },
      findMessage: async () => { throw new Error('boom') },
    })
    expect(res.interrupted.length).toBeGreaterThanOrEqual(1)
  })

  it('finalizing 且 assistant 存在 -> recovered completed', async () => {
    const snap = baseSnap({ taskId: 'task-finalizing', requestId: 'req-finalizing', state: 'finalizing', assistantMessageId: 'msg-a2' })
    createTask(snap)
    const res = await reconcileTasks({
      findMessage: async () => true,
    })
    expect(res.recovered).toContain('task-finalizing')
  })

  it('completed 已有 terminal 事件不重复 recovered', async () => {
    const { appendEvent } = await import('../taskStore')
    const snap = baseSnap({ taskId: 'task-comp-ok', requestId: 'req-comp-ok', state: 'completed', assistantMessageId: 'msg-a3' })
    createTask(snap)
    // 补一个 completed 事件
    appendEvent({
      protocolVersion: 2,
      eventId: 'ev1',
      taskId: 'task-comp-ok',
      requestId: 'req-comp-ok',
      sessionId: 's1',
      sequence: 2,
      type: 'task:completed',
      timestamp: Date.now(),
      payload: {},
    })
    const res = await reconcileTasks({
      findMessage: async () => true,
    })
    // 不应标记 persistenceFailed 或 recovered（已有事件）
    expect(res.recovered).not.toContain('task-comp-ok')
  })
})
