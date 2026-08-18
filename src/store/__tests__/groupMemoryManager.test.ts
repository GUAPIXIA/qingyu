import { describe, it, expect, vi, beforeEach } from 'vitest'
import { runGroupMemorySummary } from '../groupMemoryManager'
import { useSettingsStore } from '../useSettingsStore'
import { useCharacterStore } from '../useCharacterStore'
import { getDefaultSettings } from '../../../shared/defaults'
import type { GroupChat, GroupMessage, Character, ConnectionProfile } from '../../../shared/types'

function makeCharacter(id: string, name: string): Character {
  return {
    id, name, avatar: '', description: '', personality: '',
    scenario: '', firstMessage: '', exampleDialog: '', tags: [], lorebookId: null,
    creator: '', createdAt: 0, updatedAt: 0, alternateGreetings: [],
  }
}

function makeGroup(overrides: Partial<GroupChat> = {}): GroupChat {
  return {
    id: 'g1', name: '测试群', memberIds: ['c1', 'c2'],
    currentSpeakerIndex: 0, autoMode: false, chatMode: 'polling',
    maxRounds: 3, speakerInterval: 2000, lorebookIds: [],
    presetId: null, systemPrompt: '', createdAt: 0, updatedAt: 0,
    ...overrides,
  }
}

function makeMessage(overrides: Partial<GroupMessage> = {}): GroupMessage {
  return {
    id: 'm', groupId: 'g1', characterId: 'c1', content: '内容',
    images: [], timestamp: Date.now(), round: 1,
    ...overrides,
  }
}

const PROFILE: ConnectionProfile = {
  id: 'p1', name: 'p', provider: 'openai',
  baseUrl: 'https://api.example.com', apiKey: 'sk-test', model: 'gpt-4o', maxContext: 8192,
}

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

function makeState(overrides: Record<string, unknown> = {}) {
  return {
    currentGroup: makeGroup(),
    currentSessionId: 's1',
    messages: Array.from({ length: 6 }, (_, i) => makeMessage({
      id: `m${i}`,
      content: `消息${i}`,
      characterId: i % 2 === 0 ? '__user__' : 'c1',
      timestamp: Date.now() + i,
    })),
    sessions: [{
      id: 's1', groupId: 'g1', title: '会话', messageCount: 6,
      memoryEnabled: true, memory: '旧摘要', memoryFacts: ['旧事实'], createdAt: 0, updatedAt: 0,
    }],
    ...overrides,
  }
}

describe('runGroupMemorySummary 群聊长记忆摘要', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useSettingsStore.setState({
      settings: {
        ...getDefaultSettings(),
        userName: '群主',
        activeProfileId: 'p1',
        connectionProfiles: [PROFILE],
        activeModel: 'gpt-4o',
      },
      credentials: {},
      loaded: true,
      _saveTimer: null,
    })
    useCharacterStore.setState({
      characters: [makeCharacter('c1', '爱丽丝'), makeCharacter('c2', '千夏')],
    })
    ;(window.api.group as any).updateMemory = vi.fn().mockResolvedValue(undefined)
    ;(window.api.group as any).updateSession = vi.fn().mockResolvedValue(undefined)
  })

  it('无当前群聊时直接返回', async () => {
    await runGroupMemorySummary(
      (() => makeState({ currentGroup: null })) as any,
      vi.fn() as any,
    )
    expect(window.api.ai.chat).not.toHaveBeenCalled()
  })

  it('无当前会话时直接返回', async () => {
    await runGroupMemorySummary(
      (() => makeState({ currentSessionId: null })) as any,
      vi.fn() as any,
    )
    expect(window.api.ai.chat).not.toHaveBeenCalled()
  })

  it('未配置 profile 时直接返回', async () => {
    useSettingsStore.setState({ settings: { ...getDefaultSettings(), activeProfileId: null } } as any)
    await runGroupMemorySummary(
      (() => makeState()) as any,
      vi.fn() as any,
    )
    expect(window.api.ai.chat).not.toHaveBeenCalled()
  })

  it('消息不足 4 条时直接返回', async () => {
    await runGroupMemorySummary(
      (() => makeState({ messages: makeMessages(2) })) as any,
      vi.fn() as any,
    )
    expect(window.api.ai.chat).not.toHaveBeenCalled()
  })

  it('成功流程：chunk 累积 → 原子持久化摘要、事实与处理游标', async () => {
    const callbacks = captureStreamCallbacks()
    const set = vi.fn()
    const p = runGroupMemorySummary((() => makeState()) as any, set)

    const requestId = callbacks.chatParams!.requestId
    callbacks.onChunk!({ requestId, text: '【当前状态】众人正在森林边缘休整。\n【时间线】他们在森林重逢' })
    callbacks.onChunk!({ requestId, text: '【事实】\n1. 目的地雪山' })
    callbacks.onDone!(requestId)

    await p
    expect(window.api.group.updateSession).toHaveBeenCalledWith('g1', 's1', {
      memory: '他们在森林重逢',
      memoryCurrentState: '众人正在森林边缘休整。',
      memoryFacts: ['目的地雪山'],
      factsVectors: [],
      factsVectorVersion: 0,
      memoryUpdatedAt: expect.any(Number),
      memoryLastMessageId: 'm5',
      memoryVersion: 1,
    })
    // 本地 sessions 更新
    const sessions = set.mock.calls[0][0].sessions as typeof makeState extends never ? never : { id: string }[]
    const updated = sessions.find((s: { id: string }) => s.id === 's1') as any
    expect(updated.memory).toBe('他们在森林重逢')
    expect(updated.memoryFacts).toEqual(['目的地雪山'])
    expect(updated.memoryUpdatedAt).toBeGreaterThan(0)
  })

  it('系统提示包含群名、成员名与之前的事实', async () => {
    const callbacks = captureStreamCallbacks()
    const p = runGroupMemorySummary((() => makeState()) as any, vi.fn())

    const messages = (callbacks.chatParams as any).messages
    const systemMsg = messages[0]
    expect(systemMsg.content).toContain('测试群')
    expect(systemMsg.content).toContain('爱丽丝、千夏')
    expect(systemMsg.content).toContain('旧摘要')
    expect(systemMsg.content).toContain('1. 旧事实')
    const userMsg = messages[1]
    expect(userMsg.content).toContain('群主: 消息0')
    expect(userMsg.content).toContain('爱丽丝: 消息1')

    callbacks.onDone!(callbacks.chatParams!.requestId)
    await p
  })

  it('群聊仅总结游标之后的消息，并将游标推进到增量末尾', async () => {
    const callbacks = captureStreamCallbacks()
    const messages = Array.from({ length: 8 }, (_, index) => makeMessage({
      id: `m${index}`,
      content: `增量消息${index}`,
      characterId: index % 2 === 0 ? '__user__' : 'c1',
    }))
    const session = { ...makeState().sessions[0], memoryLastMessageId: 'm2' }
    const p = runGroupMemorySummary((() => makeState({ messages, sessions: [session] })) as any, vi.fn())

    const sent = (callbacks.chatParams as any).messages[1].content
    expect(sent).toContain('【待总结的新对话】')
    expect(sent).toContain('增量消息3')
    expect(sent).toContain('增量消息7')
    expect(sent).not.toContain('增量消息0')

    callbacks.onChunk!({ requestId: callbacks.chatParams!.requestId, text: '【摘要】群聊增量摘要\n【事实】\n' })
    callbacks.onDone!(callbacks.chatParams!.requestId)
    await p
    expect(window.api.group.updateSession).toHaveBeenCalledWith('g1', 's1', expect.objectContaining({
      memoryLastMessageId: 'm7',
    }))
  })

  it('chat 调用失败时静默处理（不影响主流程）', async () => {
    ;(window.api.ai as any).chat = vi.fn().mockRejectedValue(new Error('network'))
    await runGroupMemorySummary((() => makeState()) as any, vi.fn())
  })
})

function makeMessages(count: number): GroupMessage[] {
  return Array.from({ length: count }, (_, i) => makeMessage({
    id: `mm${i}`, content: `消息${i}`, timestamp: Date.now() + i,
  }))
}
