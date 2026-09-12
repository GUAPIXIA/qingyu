/**
 * V2 发送链路（chatEngineV2，默认开启）的“下一步方向”回归测试：
 * 锁住 useChatStore.sendMessage V2 分支的挂接点——任务终态 completed、
 * 消息按落盘内容重载、会话开启方向且存在有效 AI 正文时，为最新一条回复生成方向；
 * failed 终态、开关关闭或用户已切换会话则不生成。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { generateSingleDialogueDirectionsMock } = vi.hoisted(() => ({
  generateSingleDialogueDirectionsMock: vi.fn(async () => []),
}))
vi.mock('../dialogueDirectionRunner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../dialogueDirectionRunner')>()
  return { ...actual, generateSingleDialogueDirections: generateSingleDialogueDirectionsMock }
})
vi.mock('../memoryManager', () => ({
  maybeRunAutoMemorySummary: vi.fn(async () => undefined),
  runMemorySummary: vi.fn(async () => null),
}))

import { useChatStore } from '../useChatStore'
import { useChatTaskStore } from '../chatTaskStore'
import type { Character, Message } from '../../../shared/types'

function makeCharacter(): Character {
  return {
    id: 'char-1', name: 'Alice', avatar: '', description: '', personality: '',
    scenario: '', firstMessage: '', exampleDialog: '', tags: [], lorebookId: null,
    creator: '', createdAt: 0, updatedAt: 0, alternateGreetings: [],
  }
}

function makeMessages(): Message[] {
  return [
    { id: 'u1', sessionId: 's1', characterId: 'char-1', role: 'user', content: '你好', images: [], isEditing: false, timestamp: 0 },
    { id: 'a1', sessionId: 's1', characterId: 'char-1', role: 'assistant', content: '你好，旅行者。', images: [], isEditing: false, timestamp: 1 },
  ] as Message[]
}

function stubChatTask(state: string) {
  const chatTask = {
    start: vi.fn(async () => ({ taskId: 't1' })),
    get: vi.fn(async () => ({
      taskId: 't1', state, sessionId: 's1', characterId: 'char-1',
      lastSequence: 1, accumulatedText: '',
    })),
    onEvent: vi.fn(() => () => {}),
  }
  ;(window.api as unknown as { chatTask: unknown }).chatTask = chatTask
  return chatTask
}

async function sendAndSettle() {
  const p = useChatStore.getState().sendMessage('你好', [], makeCharacter(), null, [], undefined, 'manual')
  await vi.advanceTimersByTimeAsync(0)
  await vi.advanceTimersByTimeAsync(1000)
  await p
}

describe('V2 发送链路下一步方向', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    useChatTaskStore.setState({ chatEngineV2: true, activeTask: null, isTaskStreaming: false })
    useChatStore.setState({
      currentSessionId: 's1',
      sessions: [{
        id: 's1', characterId: 'char-1', title: '会话', createdAt: 0, updatedAt: 0,
        dialogueDirectionsEnabled: true,
      } as never],
      messages: [],
      isStreaming: false,
    })
    vi.mocked(window.api.chat.listMessages).mockResolvedValue(makeMessages() as never)
  })

  afterEach(() => {
    vi.useRealTimers()
    delete (window.api as unknown as { chatTask?: unknown }).chatTask
  })

  it('completed 终态且开关开启：为落盘后的最新 AI 回复生成方向', async () => {
    stubChatTask('completed')
    await sendAndSettle()

    expect(generateSingleDialogueDirectionsMock).toHaveBeenCalledTimes(1)
    expect(generateSingleDialogueDirectionsMock).toHaveBeenCalledWith(
      expect.any(Function), expect.any(Function),
      expect.objectContaining({ messageId: 'a1' }),
    )
  })

  it('开关关闭：不生成方向', async () => {
    stubChatTask('completed')
    useChatStore.setState({
      sessions: [{
        id: 's1', characterId: 'char-1', title: '会话', createdAt: 0, updatedAt: 0,
        dialogueDirectionsEnabled: false,
      } as never],
    })
    await sendAndSettle()
    expect(generateSingleDialogueDirectionsMock).not.toHaveBeenCalled()
  })

  it('failed 终态：不生成方向', async () => {
    stubChatTask('failed')
    await sendAndSettle()
    expect(generateSingleDialogueDirectionsMock).not.toHaveBeenCalled()
  })

  it('completed 但重载前用户已切换会话：不生成方向', async () => {
    stubChatTask('completed')
    vi.mocked(window.api.chat.listMessages).mockImplementation(async () => {
      useChatStore.setState({ currentSessionId: 's2' })
      return makeMessages() as never
    })
    await sendAndSettle()
    expect(generateSingleDialogueDirectionsMock).not.toHaveBeenCalled()
  })
})
