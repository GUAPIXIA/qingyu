import { beforeEach, describe, expect, it, vi } from 'vitest'

const { streamAIResponseMock } = vi.hoisted(() => ({
  streamAIResponseMock: vi.fn(async () => undefined),
}))

vi.mock('../streamController', () => ({
  streamAIResponse: streamAIResponseMock,
}))

vi.mock('../chatUtils', () => ({
  invalidateDerivedMemory: vi.fn(async () => null),
}))

vi.mock('../memoryManager', () => ({
  maybeRunAutoMemorySummary: vi.fn(async () => undefined),
}))

vi.mock('../../lib/logger', () => ({
  logError: vi.fn(),
}))

import { regenerateChatMessage } from '../chatGeneration'

describe('regenerateChatMessage', () => {
  beforeEach(() => {
    streamAIResponseMock.mockClear()
  })

  it('向世界书触发链传递 regenerate 生成类型', async () => {
    const character = {
      id: 'char-1',
      name: '角色',
    }
    let state = {
      isStreaming: false,
      sessions: [],
      messages: [{
        id: 'assistant-1',
        sessionId: 'session-1',
        characterId: 'char-1',
        role: 'assistant',
        content: '旧回复',
        images: [],
        timestamp: 1,
      }],
    }
    const get = () => state
    const set = (patch: unknown) => {
      const next = typeof patch === 'function'
        ? (patch as (current: typeof state) => Partial<typeof state>)(state)
        : patch as Partial<typeof state>
      state = { ...state, ...next }
    }

    await regenerateChatMessage(set as never, get as never, 'assistant-1', character as never, null, [])

    expect(streamAIResponseMock).toHaveBeenCalledWith(
      set,
      get,
      expect.objectContaining({ generationType: 'regenerate' }),
    )
  })
})
