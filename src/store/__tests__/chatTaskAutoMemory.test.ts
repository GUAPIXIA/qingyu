/**
 * V2 发送链路（chatEngineV2，默认开启）的自动长记忆回归测试：
 * 锁住 useChatStore.sendMessage V2 分支的挂接点——任务终态 completed、
 * 消息按落盘内容重载、且用户仍在发起会话时，触发一次 maybeRunAutoMemorySummary；
 * failed 终态或用户已切换会话则不触发。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// memoryManager 整体替换：本文件只验证“是否触发检查”，总结内部逻辑由 memoryManager.test.ts 覆盖
const { maybeRunAutoMemorySummaryMock, runMemorySummaryMock } = vi.hoisted(() => ({
  maybeRunAutoMemorySummaryMock: vi.fn(async () => undefined),
  runMemorySummaryMock: vi.fn(async () => null),
}))
vi.mock('../memoryManager', () => ({
  maybeRunAutoMemorySummary: maybeRunAutoMemorySummaryMock,
  runMemorySummary: runMemorySummaryMock,
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

function makeMessages(count: number): Message[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `m${i}`, sessionId: 's1', characterId: 'char-1',
    role: i % 2 === 0 ? 'user' : 'assistant', content: `消息${i}`,
    images: [], isEditing: false, timestamp: i,
  })) as Message[]
}

/** stub V2 任务通道：start 返回固定 taskId，get 按指定终态应答，onEvent 提供空退订 */
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
  await vi.advanceTimersByTimeAsync(0) // 冲刷动态 import 与 submitChatTask 的 await 链
  await vi.advanceTimersByTimeAsync(1000) // 轮询 tick → 终态 → 重载消息 → 触发检查
  await p
}

describe('V2 发送链路自动长记忆', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    useChatTaskStore.setState({ chatEngineV2: true, activeTask: null, isTaskStreaming: false })
    useChatStore.setState({
      currentSessionId: 's1',
      sessions: [{
        id: 's1', characterId: 'char-1', title: '会话', createdAt: 0, updatedAt: 0,
        memoryEnabled: true, memoryMode: 'auto', autoMemoryInterval: 10,
      } as never],
      messages: [],
      isStreaming: false,
    })
    vi.mocked(window.api.chat.listMessages).mockResolvedValue(makeMessages(12) as never)
  })

  afterEach(() => {
    vi.useRealTimers()
    delete (window.api as unknown as { chatTask?: unknown }).chatTask
  })

  it('completed 终态：重载落盘消息后触发一次自动总结检查', async () => {
    const chatTask = stubChatTask('completed')
    const character = makeCharacter()

    const p = useChatStore.getState().sendMessage('你好', [], character, null, [], undefined, 'manual')
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(1000)
    await p

    // 确认走的是 V2 分支而不是异常回退的 legacy 链路
    expect(chatTask.start).toHaveBeenCalled()
    expect(window.api.chat.listMessages).toHaveBeenCalledWith('char-1', 's1')
    expect(maybeRunAutoMemorySummaryMock).toHaveBeenCalledTimes(1)
    expect(maybeRunAutoMemorySummaryMock).toHaveBeenCalledWith(expect.any(Function), expect.any(Function), character)
    expect(useChatStore.getState().isStreaming).toBe(false)
  })

  it('failed 终态：不触发自动总结检查', async () => {
    stubChatTask('failed')
    await sendAndSettle()
    expect(maybeRunAutoMemorySummaryMock).not.toHaveBeenCalled()
  })

  it('completed 但重载消息前用户已切换会话：不触发，避免用错会话的消息计数', async () => {
    stubChatTask('completed')
    vi.mocked(window.api.chat.listMessages).mockImplementation(async () => {
      useChatStore.setState({ currentSessionId: 's2' })
      return makeMessages(12) as never
    })
    await sendAndSettle()
    expect(maybeRunAutoMemorySummaryMock).not.toHaveBeenCalled()
  })
})
