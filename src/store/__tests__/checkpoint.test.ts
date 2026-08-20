/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync } from 'node:fs'

const TEST_ROOT = '/tmp/qingyu-checkpoint-test'
vi.mock('electron', () => ({ app: { getPath: () => TEST_ROOT } }))

import type { Character } from '../../../shared/types'
import { invalidateDerivedMemory } from '../chatUtils'

function makeChar(): Character {
  return { id: 'char-1', name: 'Test' } as unknown as Character
}

function makeGet(sessions: unknown[], messages: { id: string }[], currentSessionId: string | null) {
  return () => ({ currentSessionId, sessions: sessions as never[], messages })
}

// Mock window.api.chat.updateSession
const updateCalls: unknown[] = []
;(globalThis as unknown as { window: unknown }).window = {
  api: {
    chat: {
      updateSession: vi.fn(async (...args: unknown[]) => { updateCalls.push(args) }),
    },
  },
} as unknown

beforeEach(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true })
  updateCalls.length = 0
  vi.clearAllMocks()
})
afterEach(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true })
})

describe('checkpoint - invalidateDerivedMemory', () => {
  it('编辑游标后消息不失效', async () => {
    const sessions = [
      {
        id: 's1',
        memory: '摘要',
        memoryCurrentState: 'state',
        memoryFacts: [{ id: 'f1', subject: 'A', predicate: 'p', value: 'v', status: 'active', importance: 3, confidence: 0.8, sourceMessageIds: [], updatedAt: 1 }],
        memoryFactHistory: [],
        factsVectors: [[1]],
        memoryLastMessageId: 'm2',
        memoryVersion: 1,
        compressedSummary: 'comp',
      },
    ]
    const messages = [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }, { id: 'm4' }]
    const get = makeGet(sessions, messages, 's1')
    const res = await invalidateDerivedMemory(get as never, makeChar(), 'm4')
    expect(res).toBeNull()
    expect(updateCalls.length).toBe(0)
  })

  it('编辑游标前消息全量失效', async () => {
    const sessions = [
      {
        id: 's1',
        memory: '摘要',
        memoryFacts: [{ id: 'f1', subject: 'A', predicate: 'p', value: 'v', status: 'active', importance: 3, confidence: 0.8, sourceMessageIds: [], updatedAt: 1 }],
        memoryLastMessageId: 'm3',
        memoryVersion: 2,
        compressedSummary: 'comp',
      },
    ]
    const messages = [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }, { id: 'm4' }]
    const get = makeGet(sessions, messages, 's1')
    const res = await invalidateDerivedMemory(get as never, makeChar(), 'm1')
    expect(res).not.toBeNull()
    expect(res?.patch.memory).toBe('')
    expect(res?.patch.memoryVersion).toBe(0)
    expect(res?.expectedVersion).toBe(2)
    expect(updateCalls.length).toBe(1)
  })

  it('删除游标消息本身失效', async () => {
    const sessions = [
      {
        id: 's1',
        memory: '摘要',
        memoryLastMessageId: 'm2',
        memoryVersion: 1,
        memoryFacts: [{ id: 'f1', subject: 'A', predicate: 'p', value: 'v', status: 'active', importance: 3, confidence: 0.8, sourceMessageIds: [], updatedAt: 1 }],
      },
    ]
    const messages = [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }]
    const get = makeGet(sessions, messages, 's1')
    const res = await invalidateDerivedMemory(get as never, makeChar(), 'm2')
    expect(res).not.toBeNull()
    expect(res?.patch.memoryVersion).toBe(0)
  })

  it('clearChat 全量（changedMessageId 为空）', async () => {
    const sessions = [
      {
        id: 's1',
        memory: '摘要',
        memoryLastMessageId: 'm2',
        memoryVersion: 1,
        memoryFacts: [{ id: 'f1', subject: 'A', predicate: 'p', value: 'v', status: 'active', importance: 3, confidence: 0.8, sourceMessageIds: [], updatedAt: 1 }],
      },
    ]
    const messages = [{ id: 'm1' }, { id: 'm2' }]
    const get = makeGet(sessions, messages, 's1')
    const res = await invalidateDerivedMemory(get as never, makeChar(), null)
    expect(res).not.toBeNull()
    expect(res?.patch.memory).toBe('')
  })

  it('乐观锁：版本不匹配跳过', async () => {
    let sessions: unknown[] = [
      {
        id: 's1',
        memory: '摘要',
        memoryLastMessageId: 'm1',
        memoryVersion: 5,
        memoryFacts: [{ id: 'f1', subject: 'A', predicate: 'p', value: 'v', status: 'active', importance: 3, confidence: 0.8, sourceMessageIds: [], updatedAt: 1 }],
      },
    ]
    const messages = [{ id: 'm1' }, { id: 'm2' }]
    // get 返回的 sessions 在调用期间版本已变
    let callCount = 0
    const get = () => {
      callCount++
      if (callCount === 4) {
        // 第四次读取（乐观锁校验时）版本已变为 6
        sessions = [
          {
            id: 's1',
            memory: '摘要2',
            memoryLastMessageId: 'm1',
            memoryVersion: 6,
            memoryFacts: [{ id: 'f1', subject: 'A', predicate: 'p', value: 'v', status: 'active', importance: 3, confidence: 0.8, sourceMessageIds: [], updatedAt: 1 }],
          },
        ]
      }
      return { currentSessionId: 's1', sessions: sessions as never[], messages }
    }
    const res = await invalidateDerivedMemory(get as never, makeChar(), 'm1')
    expect(res).toBeNull()
    expect(updateCalls.length).toBe(0)
  })

  it('无派生数据则不失效', async () => {
    const sessions = [{ id: 's1', memory: '', memoryFacts: [], memoryLastMessageId: null, memoryVersion: 0 }]
    const messages = [{ id: 'm1' }]
    const get = makeGet(sessions, messages, 's1')
    const res = await invalidateDerivedMemory(get as never, makeChar(), 'm1')
    expect(res).toBeNull()
  })
})
