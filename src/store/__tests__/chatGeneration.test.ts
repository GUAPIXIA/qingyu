import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Message } from '../../../shared/types'

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

import { continueChatMessage, regenerateChatMessage } from '../chatGeneration'

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
    expect((state.messages[0] as unknown as Message).speakerKind).toBe('character')
    expect((state.messages[0] as unknown as Message).generationKind).toBe('regenerate')
  })
})

describe('continueChatMessage', () => {
  beforeEach(() => {
    streamAIResponseMock.mockClear()
    ;(globalThis as { window: { api?: unknown } }).window = {
      ...((globalThis as { window: object }).window ?? {}),
      api: {
        chat: { saveMessage: vi.fn(async () => undefined) },
      },
    }
  })

  it('继承目标消息的全局叙事身份，不受当前会话切换影响', async () => {
    const character = { id: 'char-1', name: '角色' }
    let state = {
      isStreaming: false,
      sessions: [{ id: 'session-1', characterId: 'char-1', narrativeMode: 'immersive' as const }],
      messages: [{
        id: 'assistant-1',
        sessionId: 'session-1',
        characterId: 'char-1',
        role: 'assistant' as const,
        content: '旁白描述了远方正在发生的事件。',
        images: [],
        timestamp: 1,
        narrativeMode: 'omniscient' as const,
      }],
    }
    const get = () => state
    const set = (patch: unknown) => {
      const next = typeof patch === 'function'
        ? (patch as (current: typeof state) => Partial<typeof state>)(state)
        : patch as Partial<typeof state>
      state = { ...state, ...next }
    }

    await continueChatMessage(set as never, get as never, 'assistant-1', character as never, null, [])

    expect(state.messages.at(-1)?.narrativeMode).toBe('omniscient')
    expect((state.messages.at(-1) as Message | undefined)?.speakerKind).toBe('character')
    expect((state.messages.at(-1) as Message | undefined)?.generationKind).toBe('message_continue')
    // 创建时即标记语义分块：流式期间也走 blocks 样式
    expect((state.messages.at(-1) as Message | undefined)?.contentRenderMode).toBe('blocks')
    expect(streamAIResponseMock).toHaveBeenCalledWith(
      set,
      get,
      expect.objectContaining({ continuation: true, narrativeMode: 'omniscient' }),
    )
  })

  it('onComplete 收尾后仍标记 contentRenderMode=blocks 并落盘', async () => {
    const character = { id: 'char-1', name: '角色' }
    let state = {
      isStreaming: false,
      sessions: [{ id: 'session-1', characterId: 'char-1' }],
      messages: [{
        id: 'assistant-1',
        sessionId: 'session-1',
        characterId: 'char-1',
        role: 'assistant' as const,
        content: '她推开门，屋内很安静。',
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

    streamAIResponseMock.mockImplementationOnce(async (
      _set?: unknown,
      _get?: unknown,
      opts?: { onComplete: (content: string, meta: { legacy?: boolean }) => Promise<void> },
    ) => {
      await opts?.onComplete('转过身，她低声说：“我回来了。”', { legacy: false })
    })

    await continueChatMessage(set as never, get as never, 'assistant-1', character as never, null, [])

    const continued = state.messages.at(-1) as unknown as Message
    expect(continued.content).toContain('我回来了')
    expect(continued.contentRenderMode).toBe('blocks')
    const saveMessage = (globalThis as unknown as { window: { api: { chat: { saveMessage: ReturnType<typeof vi.fn> } } } })
      .window.api.chat.saveMessage
    expect(saveMessage.mock.calls.some((c) => (c[0] as Message).contentRenderMode === 'blocks')).toBe(true)
  })
})
