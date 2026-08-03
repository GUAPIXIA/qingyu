import { describe, it, expect, vi, beforeEach } from 'vitest'
import { runMemorySummary } from '../memoryManager'
import { useSettingsStore } from '../useSettingsStore'
import { getDefaultSettings } from '../../../shared/defaults'
import { MEMORY_SUMMARY_RECENT, MEMORY_SUMMARY_MIN } from '../chatConstants'
import type { Character, Message, ConnectionProfile } from '../../../shared/types'

function makeCharacter(overrides: Partial<Character> = {}): Character {
  return {
    id: 'char-1', name: 'Alice', avatar: '', description: '', personality: '',
    scenario: '', firstMessage: '', exampleDialog: '', tags: [], lorebookId: null,
    creator: '', createdAt: 0, updatedAt: 0, alternateGreetings: [],
    ...overrides,
  }
}

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'm', sessionId: 's1', characterId: 'char-1', role: 'user',
    content: '你好', images: [], isEditing: false, timestamp: Date.now(),
    ...overrides,
  }
}

const PROFILE: ConnectionProfile = {
  id: 'p1', name: 'profile', provider: 'openai',
  baseUrl: 'https://api.example.com', apiKey: 'sk-test', model: 'gpt-4o', maxContext: 8192,
}

/** 生成足够的消息以满足最少消息数要求 */
function makeMessages(count: number): Message[] {
  return Array.from({ length: count }, (_, i) => makeMessage({
    id: `m${i}`,
    content: `消息内容 ${i}`,
    role: i % 2 === 0 ? 'user' : 'assistant',
    timestamp: Date.now() + i,
  }))
}

/** 捕获 ai.onChunk/onDone/onError 注册的回调，供测试手动触发 */
function captureStreamCallbacks() {
  const callbacks: {
    onChunk?: (data: { requestId: string; text: string }) => void
    onDone?: (requestId: string) => void
    onError?: (data: { requestId: string; error: string }) => void
    chatParams?: { requestId: string }
  } = {}
  ;(window.api.ai as any).onChunk = vi.fn().mockImplementation((cb) => {
    callbacks.onChunk = cb
    return () => {}
  })
  ;(window.api.ai as any).onDone = vi.fn().mockImplementation((cb) => {
    callbacks.onDone = cb
    return () => {}
  })
  ;(window.api.ai as any).onError = vi.fn().mockImplementation((cb) => {
    callbacks.onError = cb
    return () => {}
  })
  ;(window.api.ai as any).chat = vi.fn().mockImplementation((params) => {
    callbacks.chatParams = params
    return Promise.resolve(undefined)
  })
  return callbacks
}

function setupSettings(profileEnabled = true) {
  useSettingsStore.setState({
    settings: {
      ...getDefaultSettings(),
      userName: 'TestUser',
      activeProfileId: profileEnabled ? 'p1' : null,
      connectionProfiles: profileEnabled ? [PROFILE] : [],
      activeModel: 'gpt-4o',
    },
    credentials: {},
    loaded: true,
    _saveTimer: null,
  })
}

function setupChatStoreState(overrides: Record<string, unknown> = {}) {
  return {
    messages: makeMessages(MEMORY_SUMMARY_MIN + 2),
    sessions: [{
      id: 's1',
      characterId: 'char-1',
      title: '会话',
      messageCount: 10,
      memoryEnabled: true,
      memory: '之前的摘要',
      memoryFacts: ['旧事实'],
      createdAt: 0,
      updatedAt: 0,
    }],
    currentSessionId: 's1',
    ...overrides,
  }
}

describe('runMemorySummary 长记忆摘要', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // setup.ts 的默认 mock 缺少这些方法，补充为 spy
    ;(window.api.chat as any).updateMemory = vi.fn().mockResolvedValue(undefined)
    ;(window.api.chat as any).updateSession = vi.fn().mockResolvedValue(undefined)
    ;(window.api.chat as any).listSessions = vi.fn().mockResolvedValue([])
  })

  it('无当前会话时直接返回 null', async () => {
    setupSettings()
    const result = await runMemorySummary(
      (() => setupChatStoreState({ currentSessionId: null })) as any,
      vi.fn() as any,
      makeCharacter(),
    )
    expect(result).toBeNull()
    expect(window.api.ai.chat).not.toHaveBeenCalled()
  })

  it('会话不存在或未启用记忆时返回 null', async () => {
    setupSettings()
    const result = await runMemorySummary(
      (() => setupChatStoreState({ sessions: [] })) as any,
      vi.fn() as any,
      makeCharacter(),
    )
    expect(result).toBeNull()
  })

  it('未配置 API profile 时返回 null', async () => {
    setupSettings(false)
    const result = await runMemorySummary(
      (() => setupChatStoreState()) as any,
      vi.fn() as any,
      makeCharacter(),
    )
    expect(result).toBeNull()
  })

  it('消息不足最少条数时返回 null', async () => {
    setupSettings()
    const result = await runMemorySummary(
      (() => setupChatStoreState({ messages: makeMessages(MEMORY_SUMMARY_MIN - 1) })) as any,
      vi.fn() as any,
      makeCharacter(),
    )
    expect(result).toBeNull()
  })

  it('成功流程：chunk 累积 → onDone 持久化摘要与事实并返回', async () => {
    setupSettings()
    const callbacks = captureStreamCallbacks()
    const set = vi.fn()
    const p = runMemorySummary((() => setupChatStoreState()) as any, set, makeCharacter())

    const requestId = callbacks.chatParams!.requestId
    callbacks.onChunk!({ requestId, text: '【摘要】' })
    callbacks.onChunk!({ requestId, text: '他们去了森林。' })
    callbacks.onChunk!({ requestId, text: '【事实】\n1. 目标是雪山\n2. 带了地图' })
    callbacks.onDone!(requestId)

    const summary = await p
    expect(summary).toBe('他们去了森林。')
    expect(window.api.chat.updateMemory).toHaveBeenCalledWith('char-1', 's1', '他们去了森林。')
    expect(window.api.chat.updateSession).toHaveBeenCalledWith('char-1', 's1', {
      memoryFacts: ['目标是雪山', '带了地图'],
    })
    // 会话列表刷新
    expect(window.api.chat.listSessions).toHaveBeenCalledWith('char-1')
  })

  it('无事实时不调用 updateSession', async () => {
    setupSettings()
    const callbacks = captureStreamCallbacks()
    const p = runMemorySummary((() => setupChatStoreState()) as any, vi.fn(), makeCharacter())

    const requestId = callbacks.chatParams!.requestId
    callbacks.onChunk!({ requestId, text: '【摘要】只有摘要没有事实' })
    callbacks.onDone!(requestId)

    await p
    expect(window.api.chat.updateMemory).toHaveBeenCalled()
    expect(window.api.chat.updateSession).not.toHaveBeenCalled()
  })

  it('onError 流程：设置错误并返回 null', async () => {
    setupSettings()
    const callbacks = captureStreamCallbacks()
    const set = vi.fn()
    const p = runMemorySummary((() => setupChatStoreState()) as any, set, makeCharacter())

    const requestId = callbacks.chatParams!.requestId
    callbacks.onError!({ requestId, error: 'API 500' })

    const result = await p
    expect(result).toBeNull()
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringContaining('AI 服务暂时不可用') }))
  })

  it('chat 调用本身 reject 时设置错误并返回 null', async () => {
    setupSettings()
    ;(window.api.ai as any).chat = vi.fn().mockRejectedValue(new Error('network'))
    const set = vi.fn()
    const result = await runMemorySummary((() => setupChatStoreState()) as any, set, makeCharacter())
    expect(result).toBeNull()
    expect(set).toHaveBeenCalledWith({ error: '长记忆总结请求失败' })
  })

  it('传给 AI 的消息包含系统提示与角色信息', async () => {
    setupSettings()
    const callbacks = captureStreamCallbacks()
    const p = runMemorySummary((() => setupChatStoreState()) as any, vi.fn(), makeCharacter())

    const messages = (callbacks.chatParams as any).messages
    expect(messages).toBeDefined()
    const systemMsg = messages[0]
    expect(systemMsg.role).toBe('system')
    expect(systemMsg.content).toContain('Alice')
    expect(systemMsg.content).toContain('之前的摘要')
    expect(systemMsg.content).toContain('1. 旧事实')
    const userMsg = messages[1]
    expect(userMsg.role).toBe('user')
    expect(userMsg.content).toContain('TestUser')

    callbacks.onDone!(callbacks.chatParams!.requestId)
    await p
  })

  it('系统消息不计入总结范围（过滤 system 角色）', async () => {
    setupSettings()
    const callbacks = captureStreamCallbacks()
    const messages = [
      makeMessage({ role: 'system', content: '系统指令' }),
      ...makeMessages(MEMORY_SUMMARY_MIN),
    ]
    const p = runMemorySummary(
      (() => setupChatStoreState({ messages })) as any,
      vi.fn(),
      makeCharacter(),
    )
    const sent = (callbacks.chatParams as any).messages[1].content
    expect(sent).not.toContain('系统指令')

    callbacks.onDone!(callbacks.chatParams!.requestId)
    await p
  })

  it('仅取最近 MEMORY_SUMMARY_RECENT 条消息', async () => {
    setupSettings()
    const callbacks = captureStreamCallbacks()
    const messages = makeMessages(MEMORY_SUMMARY_RECENT + 10)
    const p = runMemorySummary(
      (() => setupChatStoreState({ messages })) as any,
      vi.fn(),
      makeCharacter(),
    )
    const sent = (callbacks.chatParams as any).messages[1].content
    // 只应包含最后 MEMORY_SUMMARY_RECENT 条
    expect(sent).toContain(`消息内容 ${messages.length - 1}`)
    expect(sent).not.toContain('消息内容 0')

    callbacks.onDone!(callbacks.chatParams!.requestId)
    await p
  })
})
