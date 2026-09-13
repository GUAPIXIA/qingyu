import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Character, Message } from '../../../shared/types'
import {
  generateSingleDialogueDirections,
  persistSingleDirections,
  generateGroupDialogueDirections,
  cancelDialogueDirectionRequests,
  refreshSingleDialogueDirections,
  clearSessionDialogueDirections,
} from '../dialogueDirectionRunner'
import { useSettingsStore } from '../useSettingsStore'
import type { ChatState } from '../chatTypes'
import { BACKGROUND_GENERATION_PROFILES } from '../../../shared/backgroundGeneration'
import {
  BODY_RESERVE_MULTIPLIER,
  BODY_RESERVE_OVERHEAD_TOKENS,
  PROTOCOL_RESERVE_TOKENS,
} from '../../../shared/modelOutputProfile'
import { isGateBreakerTripped, resetReasoningGateStateForTests } from '../reasoningGateState'

/** 与 shared/__tests__/dialogueDirections.test.ts 保持同一组合法样例。 */
const DIRECTIONS = [
  { id: 'safe', label: '追问封锁原因', content: '先不与守卫冲突，试着追问港口突然封锁的原因。', tendency: 'safe' },
  { id: 'explore', label: '寻找其他入口', content: '暂时离开正门，沿港口外围查看是否存在无人值守的通道。', tendency: 'explore' },
  { id: 'risky', label: '冒险直接闯关', content: '趁守卫注意力被分散时尝试突破封锁，承担立即暴露的风险。', tendency: 'risky' },
] as const

function makeCharacter(): Character {
  return {
    id: 'char-1', name: '艾莉丝', avatar: '', description: '港口守卫队长',
    personality: '', scenario: '', firstMessage: '', exampleDialog: '', tags: [],
    lorebookId: null, creator: '', createdAt: 0, updatedAt: 0, alternateGreetings: [],
  }
}

function makeMessages(): Message[] {
  return [
    { id: 'u1', sessionId: 's1', characterId: 'char-1', role: 'user', content: '港口发生了什么？', images: [], isEditing: false, timestamp: 1 },
    { id: 'a1', sessionId: 's1', characterId: 'char-1', role: 'assistant', content: '港口已经封锁，任何人都不能通过。', images: [], isEditing: false, timestamp: 2, narrativeMode: 'immersive' },
  ]
}

/** 构造一个带 set/get 的最小 store 替身。 */
function makeStore(messages: Message[]) {
  const state = {
    messages,
    sessions: [{ id: 's1', characterId: 'char-1', narrativeMode: 'immersive', memoryCurrentState: '北门封锁' }],
  } as unknown as ChatState
  const set = vi.fn((partial: Partial<ChatState> | ((s: ChatState) => Partial<ChatState>)) => {
    const next = typeof partial === 'function' ? partial(state) : partial
    Object.assign(state, next)
  })
  const get = () => state
  return { set: set as unknown as Parameters<typeof generateSingleDialogueDirections>[0], get, raw: state }
}

function stubAiText(texts: string[], finishReason: import('../../../shared/types').AIFinishReason = 'stop') {
  let index = 0
  let onChunkCb: ((data: { requestId: string; text: string }) => void) | undefined
  let onCompleteCb: ((payload: import('../../../shared/ipc-api').AIDonePayload) => void) | undefined
  // 监听器在 chat() 之前注册，因此先捕获回调，由 chat 的实现驱动完成
  vi.mocked(window.api.ai.onChunk).mockImplementation((callback) => {
    onChunkCb = callback
    return vi.fn()
  })
  // 方向请求用 onComplete 获取 finishReason（触顶按结构不完整丢弃）
  vi.mocked(window.api.ai.onComplete).mockImplementation((callback) => {
    onCompleteCb = callback
    return vi.fn()
  })
  vi.mocked(window.api.ai.onError).mockReturnValue(vi.fn())
  vi.mocked(window.api.ai.chat).mockImplementation(async (params) => {
    const payload = texts[Math.min(index, texts.length - 1)]
    index += 1
    queueMicrotask(() => {
      onChunkCb?.({ requestId: params.requestId, text: payload })
      onCompleteCb?.({ requestId: params.requestId, finishReason })
    })
  })
}

/** 逐次返回不同文本与 finishReason 的桩：推理挤占 fixture 需要每次调用不同结局。 */
function stubAiSequence(
  steps: Array<{ text: string; finishReason?: import('../../../shared/types').AIFinishReason }>,
) {
  let index = 0
  let onChunkCb: ((data: { requestId: string; text: string }) => void) | undefined
  let onCompleteCb: ((payload: import('../../../shared/ipc-api').AIDonePayload) => void) | undefined
  vi.mocked(window.api.ai.onChunk).mockImplementation((callback) => {
    onChunkCb = callback
    return vi.fn()
  })
  vi.mocked(window.api.ai.onComplete).mockImplementation((callback) => {
    onCompleteCb = callback
    return vi.fn()
  })
  vi.mocked(window.api.ai.onError).mockReturnValue(vi.fn())
  vi.mocked(window.api.ai.chat).mockImplementation(async (params) => {
    const step = steps[Math.min(index, steps.length - 1)]
    index += 1
    queueMicrotask(() => {
      // 推理吃满时没有任何 chunk（正文为空），只有触顶结束事件
      if (step.text) onChunkCb?.({ requestId: params.requestId, text: step.text })
      onCompleteCb?.({ requestId: params.requestId, finishReason: step.finishReason ?? 'stop' })
    })
  })
}

describe('dialogueDirectionRunner', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // 方向请求走 getActiveProfile；测试里注入一个可用连接
    useSettingsStore.setState((state) => ({
      settings: {
        ...state.settings,
        userName: '林舟',
        activeProfileId: 'p1',
        connectionProfiles: [{
          id: 'p1', name: '测试', provider: 'openai', apiKey: 'sk-test',
          baseUrl: 'https://api.example.com', model: 'test-model',
        }] as never,
      },
    }))
  })

  it('合法输出写回消息并持久化', async () => {
    stubAiText([`<directions>${JSON.stringify(DIRECTIONS)}</directions>`])
    const { set, get, raw } = makeStore(makeMessages())

    const result = await generateSingleDialogueDirections(set, get, { messageId: 'a1', character: makeCharacter() })

    expect(result).toHaveLength(3)
    expect(raw.messages[1].dialogueDirections).toHaveLength(3)
    expect(raw.messages[1].dialogueDirectionsGeneratedAt).toBeTypeOf('number')
    expect(window.api.chat.saveMessage).toHaveBeenCalledWith(expect.objectContaining({ id: 'a1' }))
  })

  it('结构非法时重试一次并接受第二次结果', async () => {
    stubAiText(['不是 JSON', `<directions>${JSON.stringify(DIRECTIONS)}</directions>`])
    const { set, get, raw } = makeStore(makeMessages())

    const result = await generateSingleDialogueDirections(set, get, { messageId: 'a1', character: makeCharacter() })

    expect(window.api.ai.chat).toHaveBeenCalledTimes(2)
    expect(result).toHaveLength(3)
    expect(raw.messages[1].dialogueDirections).toHaveLength(3)
  })

  it('两次都非法时放弃，不写入任何方向', async () => {
    stubAiText(['不是 JSON', '仍然不是 JSON'])
    const { set, get, raw } = makeStore(makeMessages())

    const result = await generateSingleDialogueDirections(set, get, { messageId: 'a1', character: makeCharacter() })

    expect(window.api.ai.chat).toHaveBeenCalledTimes(2)
    expect(result).toHaveLength(0)
    expect(raw.messages[1].dialogueDirections).toBeUndefined()
    expect(window.api.chat.saveMessage).not.toHaveBeenCalled()
  })

  it('不可用的消息（用户消息 / 空正文）不发起请求', async () => {
    stubAiText([`<directions>${JSON.stringify(DIRECTIONS)}</directions>`])
    const { set, get } = makeStore(makeMessages())

    expect(await generateSingleDialogueDirections(set, get, { messageId: 'u1', character: makeCharacter() })).toHaveLength(0)
    expect(await generateSingleDialogueDirections(set, get, { messageId: 'missing', character: makeCharacter() })).toHaveLength(0)
    expect(window.api.ai.chat).not.toHaveBeenCalled()
  })

  it('请求期间正文被替换时丢弃过期结果', async () => {
    let onChunkCb: ((data: { requestId: string; text: string }) => void) | undefined
    let onCompleteCb: ((payload: import('../../../shared/ipc-api').AIDonePayload) => void) | undefined
    let requestId = ''
    vi.mocked(window.api.ai.onChunk).mockImplementation((callback) => {
      onChunkCb = callback
      return vi.fn()
    })
    vi.mocked(window.api.ai.onComplete).mockImplementation((callback) => {
      onCompleteCb = callback
      return vi.fn()
    })
    vi.mocked(window.api.ai.onError).mockReturnValue(vi.fn())
    vi.mocked(window.api.ai.chat).mockImplementation(async (params) => {
      requestId = params.requestId
    })
    const { set, get, raw } = makeStore(makeMessages())

    const pending = generateSingleDialogueDirections(set, get, { messageId: 'a1', character: makeCharacter() })
    await Promise.resolve()
    // 模型返回了合法方向，但正文在请求期间被替换（重生成）
    onChunkCb?.({ requestId, text: `<directions>${JSON.stringify(DIRECTIONS)}</directions>` })
    raw.messages[1] = { ...raw.messages[1], content: '' }
    onCompleteCb?.({ requestId, finishReason: 'stop' })

    await pending
    expect(raw.messages[1].dialogueDirections).toBeUndefined()
    expect(window.api.chat.saveMessage).not.toHaveBeenCalled()
  })

  it('取消在途请求后不再写入结果', async () => {
    let onChunkCb: ((data: { requestId: string; text: string }) => void) | undefined
    let onCompleteCb: ((payload: import('../../../shared/ipc-api').AIDonePayload) => void) | undefined
    let requestId = ''
    vi.mocked(window.api.ai.onChunk).mockImplementation((callback) => {
      onChunkCb = callback
      return vi.fn()
    })
    vi.mocked(window.api.ai.onComplete).mockImplementation((callback) => {
      onCompleteCb = callback
      return vi.fn()
    })
    vi.mocked(window.api.ai.onError).mockReturnValue(vi.fn())
    vi.mocked(window.api.ai.chat).mockImplementation(async (params) => {
      requestId = params.requestId
    })
    const { set, get, raw } = makeStore(makeMessages())

    const pending = generateSingleDialogueDirections(set, get, { messageId: 'a1', character: makeCharacter() })
    await Promise.resolve()
    onChunkCb?.({ requestId, text: `<directions>${JSON.stringify(DIRECTIONS)}</directions>` })
    cancelDialogueDirectionRequests(['a1'])
    expect(window.api.ai.cancelChat).toHaveBeenCalledWith(requestId)
    onCompleteCb?.({ requestId, finishReason: 'stop' })

    await pending
    expect(raw.messages[1].dialogueDirections).toBeUndefined()
    expect(window.api.chat.saveMessage).not.toHaveBeenCalled()
  })

  it('persistSingleDirections 对已删除的消息安全返回', async () => {
    const { set, get } = makeStore(makeMessages())
    await expect(persistSingleDirections(set, get, 'missing', [...DIRECTIONS])).resolves.toBeUndefined()
    expect(window.api.chat.saveMessage).not.toHaveBeenCalled()
  })
})

describe('用户发送后清空上一轮方向', () => {
  const WITH_DIRECTIONS = [
    { id: 'm1', sessionId: 's1', characterId: 'char-1', role: 'assistant', content: '港口已经封锁。',
      images: [], isEditing: false, timestamp: 1, dialogueDirections: [...DIRECTIONS], dialogueDirectionsGeneratedAt: 111 },
    { id: 'm2', sessionId: 's1', characterId: 'char-1', role: 'assistant', content: '守卫正在逼近。',
      images: [], isEditing: false, timestamp: 2, dialogueDirections: [...DIRECTIONS], dialogueDirectionsGeneratedAt: 222 },
    { id: 'other', sessionId: 's2', characterId: 'char-1', role: 'assistant', content: '别的会话。',
      images: [], isEditing: false, timestamp: 3, dialogueDirections: [...DIRECTIONS] },
  ]

  beforeEach(() => {
    vi.clearAllMocks()
    useSettingsStore.setState((state) => ({
      settings: {
        ...state.settings,
        userName: '林舟',
        activeProfileId: 'p1',
        connectionProfiles: [{
          id: 'p1', name: '测试', provider: 'openai', apiKey: 'sk-test',
          baseUrl: 'https://api.example.com', model: 'test-model',
        }] as never,
      },
    }))
  })

  function makeSessionStore(messages: Message[]) {
    const state = {
      messages,
      currentSessionId: 's1',
      sessions: [{ id: 's1', characterId: 'char-1', narrativeMode: 'immersive' }],
    } as unknown as ChatState
    const set = vi.fn((partial: Partial<ChatState> | ((s: ChatState) => Partial<ChatState>)) => {
      const next = typeof partial === 'function' ? partial(state) : partial
      Object.assign(state, next)
    })
    return { set: set as never, get: () => state, raw: state }
  }

  it('清空本会话全部方向，保留其他会话', async () => {
    const { set, get, raw } = makeSessionStore(WITH_DIRECTIONS as Message[])

    await clearSessionDialogueDirections(set, get, 's1')

    expect((raw.messages[0] as { dialogueDirections?: unknown }).dialogueDirections).toBeUndefined()
    expect((raw.messages[0] as { dialogueDirectionsGeneratedAt?: number }).dialogueDirectionsGeneratedAt).toBeUndefined()
    expect((raw.messages[1] as { dialogueDirections?: unknown }).dialogueDirections).toBeUndefined()
    expect((raw.messages[2] as { dialogueDirections?: unknown }).dialogueDirections).toHaveLength(3)
  })

  it('清空结果落盘，避免重载后方向复现', async () => {
    const { set, get } = makeSessionStore(WITH_DIRECTIONS as Message[])

    await clearSessionDialogueDirections(set, get, 's1')

    const saved = vi.mocked(window.api.chat.saveMessage).mock.calls.map((c) => c[0] as { id: string; dialogueDirections?: unknown })
    expect(saved.map((m) => m.id).sort()).toEqual(['m1', 'm2'])
    expect(saved.every((m) => m.dialogueDirections === undefined)).toBe(true)
  })

  it('没有方向时不写盘（避免无谓 IO）', async () => {
    const noDirections = WITH_DIRECTIONS.map(({ dialogueDirections, dialogueDirectionsGeneratedAt, ...rest }) => {
      void dialogueDirections; void dialogueDirectionsGeneratedAt
      return rest
    })
    const { set, get } = makeSessionStore(noDirections as Message[])

    await clearSessionDialogueDirections(set, get, 's1')

    expect(window.api.chat.saveMessage).not.toHaveBeenCalled()
  })

  it('清空时取消在途方向请求，防止响应回写已清空的消息', async () => {
    let onCompleteCb: ((payload: import('../../../shared/ipc-api').AIDonePayload) => void) | undefined
    const issued: string[] = []
    vi.mocked(window.api.ai.onChunk).mockImplementation(() => vi.fn())
    vi.mocked(window.api.ai.onError).mockReturnValue(vi.fn())
    vi.mocked(window.api.ai.onComplete).mockImplementation((callback) => {
      onCompleteCb = callback
      return vi.fn()
    })
    vi.mocked(window.api.ai.chat).mockImplementation(async (params) => { issued.push(params.requestId) })

    const { set, get, raw } = makeSessionStore([{ ...WITH_DIRECTIONS[0] }] as Message[])

    const pending = generateSingleDialogueDirections(set, get, { messageId: 'm1', character: makeCharacter() })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const requestId = issued[0]
    expect(issued.length).toBe(1) // 前置条件：在途请求已发出且被追踪

    await clearSessionDialogueDirections(set, get, 's1')
    expect(vi.mocked(window.api.ai.cancelChat).mock.calls.map((c) => c[0])).toContain(requestId)

    onCompleteCb?.({ requestId, finishReason: 'stop' })
    await pending
    // 响应到达后不应把方向写回
    expect((raw.messages[0] as { dialogueDirections?: unknown }).dialogueDirections).toBeUndefined()
  })
})

describe('方向视角跟随当前会话模式', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useSettingsStore.setState((state) => ({
      settings: {
        ...state.settings,
        userName: '林舟',
        activeProfileId: 'p1',
        connectionProfiles: [{
          id: 'p1', name: '测试', provider: 'openai', apiKey: 'sk-test',
          baseUrl: 'https://api.example.com', model: 'test-model',
        }] as never,
      },
    }))
  })

  function makeModeStore() {
    const messages = [
      { id: 'u1', sessionId: 's1', characterId: 'char-1', role: 'user', content: '港口发生了什么？', images: [], isEditing: false, timestamp: 1 },
      // 消息快照停留在 immersive，而会话已切到 omniscient
      { id: 'a1', sessionId: 's1', characterId: 'char-1', role: 'assistant', content: '港口已经封锁，任何人都不能通过。', images: [], isEditing: false, timestamp: 2, narrativeMode: 'immersive' },
    ]
    const state = {
      messages,
      sessions: [{ id: 's1', characterId: 'char-1', narrativeMode: 'omniscient', dialogueDirectionsEnabled: true }],
      currentSessionId: 's1',
    } as unknown as ChatState
    const set = vi.fn((partial: Partial<ChatState> | ((s: ChatState) => Partial<ChatState>)) => {
      const next = typeof partial === 'function' ? partial(state) : partial
      Object.assign(state, next)
    })
    return { set: set as never, get: () => state, raw: state }
  }

  it('会话模式与消息快照不一致时，以会话模式生成（切到全局叙事用旁白视角）', async () => {
    stubAiText([`<directions>${JSON.stringify(DIRECTIONS)}</directions>`])
    const { set, get } = makeModeStore()

    await generateSingleDialogueDirections(set, get, { messageId: 'a1', character: makeCharacter() })

    const systemPrompt = vi.mocked(window.api.ai.chat).mock.calls[0][0].messages[0].content as string
    expect(systemPrompt).toContain('旁白')
    expect(systemPrompt).toContain('第三人称')
  })

  it('切回代入模式后按角色视角生成', async () => {
    stubAiText([`<directions>${JSON.stringify(DIRECTIONS)}</directions>`])
    const { set, get, raw } = makeModeStore()
    // 会话切回 immersive；消息快照仍为 immersive
    ;(raw.sessions as Array<{ narrativeMode?: string }>)[0].narrativeMode = 'immersive'

    await generateSingleDialogueDirections(set, get, { messageId: 'a1', character: makeCharacter() })

    const systemPrompt = vi.mocked(window.api.ai.chat).mock.calls[0][0].messages[0].content as string
    expect(systemPrompt).toContain('玩家角色')
    expect(systemPrompt).not.toContain('第三人称')
  })
})

describe('切换叙事模式后刷新方向', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useSettingsStore.setState((state) => ({
      settings: {
        ...state.settings,
        userName: '林舟',
        activeProfileId: 'p1',
        connectionProfiles: [{
          id: 'p1', name: '测试', provider: 'openai', apiKey: 'sk-test',
          baseUrl: 'https://api.example.com', model: 'test-model',
        }] as never,
      },
    }))
  })

  function makeRefreshStore(opts: { enabled: boolean; hasDirections: boolean }) {
    const older = {
      id: 'a-old', sessionId: 's1', characterId: 'char-1', role: 'assistant', content: '更早的回复。',
      images: [], isEditing: false, timestamp: 1, narrativeMode: 'immersive',
      dialogueDirections: [...DIRECTIONS],
    }
    const latest = {
      id: 'a1', sessionId: 's1', characterId: 'char-1', role: 'assistant', content: '港口已经封锁，任何人都不能通过。',
      images: [], isEditing: false, timestamp: 2, narrativeMode: 'immersive',
      ...(opts.hasDirections ? { dialogueDirections: [...DIRECTIONS] } : {}),
    }
    const state = {
      messages: [older, latest],
      sessions: [{ id: 's1', characterId: 'char-1', narrativeMode: 'omniscient', dialogueDirectionsEnabled: opts.enabled }],
      currentSessionId: 's1',
    } as unknown as ChatState
    const set = vi.fn((partial: Partial<ChatState> | ((s: ChatState) => Partial<ChatState>)) => {
      const next = typeof partial === 'function' ? partial(state) : partial
      Object.assign(state, next)
    })
    return { set: set as never, get: () => state, raw: state }
  }

  it('只为最新一条已有方向的消息重新生成，不动历史方向', async () => {
    stubAiText([`<directions>${JSON.stringify(DIRECTIONS)}</directions>`])
    const { set, get, raw } = makeRefreshStore({ enabled: true, hasDirections: true })

    await refreshSingleDialogueDirections(set, get, { character: makeCharacter() })

    // 只请求一次，且针对最新消息
    expect(window.api.ai.chat).toHaveBeenCalledTimes(1)
    const params = vi.mocked(window.api.ai.chat).mock.calls[0][0]
    expect(params.messages[0].content).toContain('第三人称')
    expect(window.api.chat.saveMessage).toHaveBeenCalledWith(expect.objectContaining({ id: 'a1' }))
    // 历史消息方向未被改写
    expect((raw.messages[0] as { dialogueDirectionsGeneratedAt?: number }).dialogueDirectionsGeneratedAt).toBeUndefined()
  })

  it('开关关闭时不刷新', async () => {
    stubAiText([`<directions>${JSON.stringify(DIRECTIONS)}</directions>`])
    const { set, get } = makeRefreshStore({ enabled: false, hasDirections: true })

    await refreshSingleDialogueDirections(set, get, { character: makeCharacter() })
    expect(window.api.ai.chat).not.toHaveBeenCalled()
  })

  it('最新消息没有方向时不刷新（下一轮回复自然使用新模式）', async () => {
    stubAiText([`<directions>${JSON.stringify(DIRECTIONS)}</directions>`])
    const { set, get } = makeRefreshStore({ enabled: true, hasDirections: false })

    await refreshSingleDialogueDirections(set, get, { character: makeCharacter() })
    expect(window.api.ai.chat).not.toHaveBeenCalled()
  })

  it('刷新时先取消在途请求，避免被“同一消息去重”挡掉', async () => {
    const { set, get } = makeRefreshStore({ enabled: true, hasDirections: true })
    // 按序配对监听器与请求：注册顺序与 chat() 调用顺序一致
    const chunkCallbacks: Array<(data: { requestId: string; text: string }) => void> = []
    const completeCallbacks: Array<(payload: import('../../../shared/ipc-api').AIDonePayload) => void> = []
    const issued: string[] = []
    vi.mocked(window.api.ai.onError).mockReturnValue(vi.fn())
    vi.mocked(window.api.ai.onChunk).mockImplementation((callback) => {
      chunkCallbacks.push(callback)
      return vi.fn()
    })
    vi.mocked(window.api.ai.onComplete).mockImplementation((callback) => {
      completeCallbacks.push(callback)
      return vi.fn()
    })
    vi.mocked(window.api.ai.chat).mockImplementation(async (params) => { issued.push(params.requestId) })
    /** 让第 index 次请求返回合法方向并结束（必须给 chunk，否则视为解析失败会重试）。 */
    const settle = async (index: number) => {
      await new Promise((resolve) => setTimeout(resolve, 0))
      const requestId = issued[index]
      chunkCallbacks[index]?.({ requestId, text: `<directions>${JSON.stringify(DIRECTIONS)}</directions>` })
      completeCallbacks[index]?.({ requestId, finishReason: 'stop' })
    }

    // 先发起一次生成（在途），再触发刷新
    const first = generateSingleDialogueDirections(set, get, { messageId: 'a1', character: makeCharacter() })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const firstRequestId = issued[0]

    const refresh = refreshSingleDialogueDirections(set, get, { character: makeCharacter() })
    await new Promise((resolve) => setTimeout(resolve, 0))

    // 在途请求被取消，且刷新确实发起了第二次请求（未被“同一消息去重”挡掉）
    expect(vi.mocked(window.api.ai.cancelChat).mock.calls.map((c) => c[0])).toContain(firstRequestId)
    expect(issued.length).toBe(2)

    await settle(0)
    await settle(1)
    await first
    await refresh
  })
})

describe('群聊方向生成', () => {
  function makeGroupStore(messages: Array<Record<string, unknown>>) {
    const state = {
      messages,
      sessions: [{ id: 'gs1', groupId: 'g1', narrativeMode: 'immersive', memoryCurrentState: '北门封锁' }],
      currentGroup: { id: 'g1' },
      currentSessionId: 'gs1',
    } as unknown as Parameters<typeof generateGroupDialogueDirections>[1] extends () => infer T ? T : never
    const set = vi.fn((partial: unknown) => {
      const next = typeof partial === 'function' ? (partial as (s: unknown) => object)(state) : partial
      Object.assign(state, next as object)
    })
    return { set, get: () => state, raw: state }
  }

  function makeGroupMessages() {
    return [
      { id: 'gu1', groupId: 'g1', characterId: '__user__', content: '大家怎么看？', images: [], timestamp: 1, round: 1 },
      { id: 'ga1', groupId: 'g1', characterId: 'char-1', content: '港口已经封锁，任何人都不能通过。', images: [], timestamp: 2, round: 2, narrativeMode: 'immersive' },
    ]
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('为有效角色回复生成方向并持久化到群聊消息', async () => {
    stubAiText([`<directions>${JSON.stringify(DIRECTIONS)}</directions>`])
    const { set, get, raw } = makeGroupStore(makeGroupMessages())

    const result = await generateGroupDialogueDirections(
      set as never, get as never,
      { messageId: 'ga1', character: makeCharacter(), userName: '林舟' },
    )

    expect(result).toHaveLength(3)
    expect((raw.messages[1] as { dialogueDirections?: unknown[] }).dialogueDirections).toHaveLength(3)
    expect(window.api.group.saveMessage).toHaveBeenCalledWith('g1', 'gs1', expect.objectContaining({ id: 'ga1' }))
  })

  it('用户消息与空正文不生成方向', async () => {
    stubAiText([`<directions>${JSON.stringify(DIRECTIONS)}</directions>`])
    const { set, get } = makeGroupStore(makeGroupMessages())

    expect(await generateGroupDialogueDirections(set as never, get as never, { messageId: 'gu1', character: makeCharacter(), userName: '林舟' })).toHaveLength(0)
    expect(await generateGroupDialogueDirections(set as never, get as never, { messageId: 'missing', character: makeCharacter(), userName: '林舟' })).toHaveLength(0)
    expect(window.api.ai.chat).not.toHaveBeenCalled()
  })

  it('结构非法时重试一次，两次失败则放弃', async () => {
    stubAiText(['不是 JSON', '仍然不是 JSON'])
    const { set, get, raw } = makeGroupStore(makeGroupMessages())

    const result = await generateGroupDialogueDirections(
      set as never, get as never,
      { messageId: 'ga1', character: makeCharacter(), userName: '林舟' },
    )

    expect(window.api.ai.chat).toHaveBeenCalledTimes(2)
    expect(result).toHaveLength(0)
    expect((raw.messages[1] as { dialogueDirections?: unknown[] }).dialogueDirections).toBeUndefined()
  })

  it('取消后不再写入群聊方向', async () => {
    let onChunkCb: ((data: { requestId: string; text: string }) => void) | undefined
    let onCompleteCb: ((payload: import('../../../shared/ipc-api').AIDonePayload) => void) | undefined
    let requestId = ''
    vi.mocked(window.api.ai.onChunk).mockImplementation((callback) => {
      onChunkCb = callback
      return vi.fn()
    })
    vi.mocked(window.api.ai.onComplete).mockImplementation((callback) => {
      onCompleteCb = callback
      return vi.fn()
    })
    vi.mocked(window.api.ai.onError).mockReturnValue(vi.fn())
    vi.mocked(window.api.ai.chat).mockImplementation(async (params) => {
      requestId = params.requestId
    })
    const { set, get, raw } = makeGroupStore(makeGroupMessages())

    const pending = generateGroupDialogueDirections(
      set as never, get as never,
      { messageId: 'ga1', character: makeCharacter(), userName: '林舟' },
    )
    await Promise.resolve()
    onChunkCb?.({ requestId, text: `<directions>${JSON.stringify(DIRECTIONS)}</directions>` })
    cancelDialogueDirectionRequests(['ga1'])
    onCompleteCb?.({ requestId, finishReason: 'stop' })

    await pending
    expect((raw.messages[1] as { dialogueDirections?: unknown[] }).dialogueDirections).toBeUndefined()
    expect(window.api.group.saveMessage).not.toHaveBeenCalled()
  })
})

/**
 * W4（主计划 §7.6）：方向任务已从 1536 直连收编为「后台档案 + 统一预算 + off 门控」，
 * 推理挤占（length + 零正文）走一次降档重试；每个逻辑请求最多 2 次物理调用。
 * （W0 冻结的旧基线用例已在本次显式改写，不是悄悄漂移。）
 */
describe('方向任务推理挤占恢复与统一预算（W4）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useSettingsStore.setState((state) => ({
      settings: {
        ...state.settings,
        userName: '林舟',
        activeProfileId: 'p1',
        activeModel: 'test-model',
        connectionProfiles: [{
          id: 'p1', name: '测试', provider: 'openai', apiKey: 'sk-test',
          baseUrl: 'https://api.example.com', model: 'test-model',
        }] as never,
      },
    }))
  })

  it('推理吃满（length + 正文为空）→ 一次降档重试（复用同一 prompt），第二次合法即接受', async () => {
    stubAiSequence([
      { text: '', finishReason: 'length' },
      { text: `<directions>${JSON.stringify(DIRECTIONS)}</directions>`, finishReason: 'stop' },
    ])
    const { set, get, raw } = makeStore(makeMessages())

    const result = await generateSingleDialogueDirections(set, get, { messageId: 'a1', character: makeCharacter() })

    expect(window.api.ai.chat).toHaveBeenCalledTimes(2)
    expect(result).toHaveLength(3)
    expect(raw.messages[1].dialogueDirections).toHaveLength(3)
    // 降档重试复用同一 prompt 快照（不再插入"结构不合法"修复提示）
    const firstSystem = vi.mocked(window.api.ai.chat).mock.calls[0][0].messages[0].content
    const retrySystem = vi.mocked(window.api.ai.chat).mock.calls[1][0].messages[0].content
    expect(retrySystem).toBe(firstSystem)
    // 第二次请求标记为降档重试，便于观测归属
    expect(vi.mocked(window.api.ai.chat).mock.calls[1][0].observability).toMatchObject({
      source: 'aux',
      taskType: 'direction',
      downgradeRetry: true,
    })
  })

  it('两次都被推理吃满 → 放弃且不落盘，总物理调用不超过 2', async () => {
    stubAiSequence([
      { text: '', finishReason: 'length' },
      { text: '', finishReason: 'length' },
    ])
    const { set, get, raw } = makeStore(makeMessages())

    const result = await generateSingleDialogueDirections(set, get, { messageId: 'a1', character: makeCharacter() })

    expect(window.api.ai.chat).toHaveBeenCalledTimes(2)
    expect(result).toHaveLength(0)
    expect(raw.messages[1].dialogueDirections).toBeUndefined()
    expect(window.api.chat.saveMessage).not.toHaveBeenCalled()
  })

  it('第一次推理吃满、第二次非空但结构非法 → 不再发起第三次请求', async () => {
    stubAiSequence([
      { text: '', finishReason: 'length' },
      { text: '仍然不是合法结构', finishReason: 'stop' },
    ])
    const { set, get, raw } = makeStore(makeMessages())

    const result = await generateSingleDialogueDirections(set, get, { messageId: 'a1', character: makeCharacter() })

    expect(window.api.ai.chat).toHaveBeenCalledTimes(2)
    expect(result).toHaveLength(0)
    expect(raw.messages[1].dialogueDirections).toBeUndefined()
  })

  it('预算收编：后台 direction 档案 + resolveRequestBudget + off 门控（不再直连 1536）', async () => {
    stubAiText([`<directions>${JSON.stringify(DIRECTIONS)}</directions>`])
    const { set, get } = makeStore(makeMessages())

    await generateSingleDialogueDirections(set, get, { messageId: 'a1', character: makeCharacter() })

    const params = vi.mocked(window.api.ai.chat).mock.calls[0][0]
    const expectedBody = Math.ceil(
      BACKGROUND_GENERATION_PROFILES.direction.expectedBodyChars * BODY_RESERVE_MULTIPLIER,
    ) + BODY_RESERVE_OVERHEAD_TOKENS
    // test-model 无推理档案：off 门控在未探测端点取保守余量（协议余量 192）
    expect(params.maxTokens).toBe(expectedBody + PROTOCOL_RESERVE_TOKENS)
    expect(params.maxTokens).not.toBe(1536)
    expect(params.reasoningGate).toMatchObject({ level: 'off' })
    // 旧适配器回退字段保留（门控在场时适配器优先消费 reasoningGate）
    expect(params.reasoningMode).toBe('disabled')
    expect(params.stream).toBe(false)
    expect(params.observability).toMatchObject({ source: 'aux', taskType: 'direction' })
  })

  it('两次都推理挤占 → 总调用 2 次、不落盘；连续两轮失败才熔断且不污染主对话', async () => {
    resetReasoningGateStateForTests()
    const scope = { provider: 'openai', baseUrl: 'https://api.example.com', model: 'test-model' }
    const directionScope = { ...scope, task: 'direction' }

    // 第 1 轮：两次物理调用都挤占 → 记录 1 次降档失败，尚未熔断
    stubAiSequence([
      { text: '', finishReason: 'length' },
      { text: '', finishReason: 'length' },
    ])
    let store = makeStore(makeMessages())
    let result = await generateSingleDialogueDirections(store.set, store.get, { messageId: 'a1', character: makeCharacter() })
    expect(window.api.ai.chat).toHaveBeenCalledTimes(2)
    expect(result).toHaveLength(0)
    expect(store.raw.messages[1].dialogueDirections).toBeUndefined()
    expect(isGateBreakerTripped(directionScope)).toBe(false)

    // 第 2 轮：再次两次失败 → 该任务域熔断
    vi.mocked(window.api.ai.chat).mockClear()
    stubAiSequence([
      { text: '', finishReason: 'length' },
      { text: '', finishReason: 'length' },
    ])
    store = makeStore(makeMessages())
    await generateSingleDialogueDirections(store.set, store.get, { messageId: 'a1', character: makeCharacter() })
    expect(window.api.ai.chat).toHaveBeenCalledTimes(2)
    expect(isGateBreakerTripped(directionScope)).toBe(true)
    // 主对话作用域不受方向失败影响（起步档不被无故降低）
    expect(isGateBreakerTripped(scope)).toBe(false)
  })
})
