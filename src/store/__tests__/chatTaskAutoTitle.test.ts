/**
 * V2 发送链路的自动标题回归测试：任务完成且用户仍在原会话时，
 * 用本轮的当前预设触发标题检查；失败终态或已切换会话不触发。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { maybeAutoTitleMock } = vi.hoisted(() => ({
  maybeAutoTitleMock: vi.fn(async () => undefined),
}))
vi.mock('../streamController', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../streamController')>()
  return { ...actual, maybeAutoTitle: maybeAutoTitleMock }
})
vi.mock('../memoryManager', () => ({
  maybeRunAutoMemorySummary: vi.fn(async () => undefined),
  runMemorySummary: vi.fn(async () => null),
}))

import { useChatStore } from '../useChatStore'
import { useChatTaskStore } from '../chatTaskStore'
import type { Character, Message, Preset } from '../../../shared/types'

function makeCharacter(): Character {
  return {
    id: 'char-1', name: 'Alice', avatar: '', description: '', personality: '',
    scenario: '', firstMessage: '', exampleDialog: '', tags: [], lorebookId: null,
    creator: '', createdAt: 0, updatedAt: 0, alternateGreetings: [],
  }
}

const preset: Preset = {
  id: 'preset-1', name: '预设', description: '', systemPrompt: '', jailbreak: '标题越狱',
  maxContext: 0, temperature: 0.8, topP: 0.95, maxTokens: 0,
  frequencyPenalty: 0, presencePenalty: 0, isBuiltin: false,
}

function messages(): Message[] {
  return [
    { id: 'u1', sessionId: 's1', characterId: 'char-1', role: 'user', content: '你好', images: [], isEditing: false, timestamp: 0 },
    { id: 'a1', sessionId: 's1', characterId: 'char-1', role: 'assistant', content: '你好。', images: [], isEditing: false, timestamp: 1 },
  ] as Message[]
}

function stubChatTask(state: string) {
  ;(window.api as unknown as { chatTask: unknown }).chatTask = {
    start: vi.fn(async () => ({ taskId: 't1' })),
    get: vi.fn(async () => ({
      taskId: 't1', state, sessionId: 's1', characterId: 'char-1',
      lastSequence: 1, accumulatedText: '',
    })),
    onEvent: vi.fn(() => () => {}),
  }
}

async function sendAndSettle(state: string, switchSession = false) {
  stubChatTask(state)
  vi.mocked(window.api.chat.listMessages).mockImplementation(async () => {
    if (switchSession) useChatStore.setState({ currentSessionId: 's2' })
    return messages() as never
  })
  const character = makeCharacter()
  const pending = useChatStore.getState().sendMessage('你好', [], character, preset, [], undefined, 'manual')
  await vi.advanceTimersByTimeAsync(0)
  await vi.advanceTimersByTimeAsync(1000)
  await pending
  return character
}

describe('V2 发送链路自动标题', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    useChatTaskStore.setState({ chatEngineV2: true, activeTask: null, isTaskStreaming: false })
    useChatStore.setState({
      currentSessionId: 's1',
      sessions: [{ id: 's1', characterId: 'char-1', title: '新对话 1', createdAt: 0, updatedAt: 0 } as never],
      messages: [],
      isStreaming: false,
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    delete (window.api as unknown as { chatTask?: unknown }).chatTask
  })

  it('completed 终态：传递当前预设触发标题检查', async () => {
    const character = await sendAndSettle('completed')
    expect(maybeAutoTitleMock).toHaveBeenCalledOnce()
    expect(maybeAutoTitleMock).toHaveBeenCalledWith(
      expect.any(Function), expect.any(Function), character, preset,
    )
  })

  it('failed 终态：不触发标题检查', async () => {
    await sendAndSettle('failed')
    expect(maybeAutoTitleMock).not.toHaveBeenCalled()
  })

  it('completed 但用户已切换会话：不触发标题检查', async () => {
    await sendAndSettle('completed', true)
    expect(maybeAutoTitleMock).not.toHaveBeenCalled()
  })
})
