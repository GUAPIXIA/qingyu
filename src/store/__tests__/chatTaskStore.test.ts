import { describe, it, expect, vi, beforeEach } from 'vitest'
import { submitChatTask, resumeActiveTask } from '../chatTaskStore'

describe('chatTaskStore', () => {
  beforeEach(() => {
    vi.stubGlobal('window', {
      api: {
        chatTask: {
          start: vi.fn(async () => ({ taskId: 'task-1', state: 'queued', lastSequence: 1 })),
          get: vi.fn(async () => ({ taskId: 'task-1', state: 'streaming', lastSequence: 1, sessionId: 's1' })),
          listBySession: vi.fn(async () => [{ taskId: 'task-1', state: 'streaming', lastSequence: 5, sessionId: 's1' }]),
          eventsAfter: vi.fn(async () => ({ events: [], snapshot: null })),
          onEvent: vi.fn(() => () => {}),
        },
      },
    } as unknown)
  })

  it('submitChatTask 提交并获取快照', async () => {
    const snap = await submitChatTask('s1', 'hello', 'c1')
    expect(snap.taskId).toBe('task-1')
  })

  it('resumeActiveTask 查询并补拉', async () => {
    const snap = await resumeActiveTask('s1')
    expect(snap?.taskId).toBe('task-1')
  })
})
