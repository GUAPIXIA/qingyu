import { describe, it, expect, vi, beforeEach } from 'vitest'
import { runMemorySummary } from '../memoryManager'
import { useSettingsStore } from '../useSettingsStore'
import { getDefaultSettings } from '../../../shared/defaults'
import { MEMORY_SUMMARY_MIN } from '../chatConstants'
import { resolveRequestBudget } from '../../../shared/modelOutputProfile'
import type { Character, Message, ConnectionProfile, MemoryFact } from '../../../shared/types'

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

/** 捕获 ai.onChunk/onComplete/onError 注册的回调，供测试手动触发 */
function captureStreamCallbacks() {
  const callbacks: {
    onChunk?: (data: { requestId: string; text: string }) => void
    onComplete?: (payload: { requestId: string; finishReason?: string }) => void
    /** 测试简写：以 finishReason='stop' 触发一次正常完成 */
    onDone?: (requestId: string) => void
    onError?: (data: { requestId: string; error: string }) => void
    chatParams?: { requestId: string }
  } = {}
  ;(window.api.ai as any).onChunk = vi.fn().mockImplementation((cb) => {
    callbacks.onChunk = cb
    return () => {}
  })
  ;(window.api.ai as any).onComplete = vi.fn().mockImplementation((cb) => {
    callbacks.onComplete = cb
    return () => {}
  })
  callbacks.onDone = (requestId: string) => callbacks.onComplete?.({ requestId, finishReason: 'stop' })
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
    ;(window.api.chat as any).updateSessionIfMemoryVersion = vi.fn().mockResolvedValue({ applied: true, currentVersion: 1 })
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

  it('成功流程：chunk 累积 → 原子持久化摘要、事实与处理游标', async () => {
    setupSettings()
    const callbacks = captureStreamCallbacks()
    const set = vi.fn()
    const p = runMemorySummary((() => setupChatStoreState()) as any, set, makeCharacter())

    const requestId = callbacks.chatParams!.requestId
    callbacks.onChunk!({ requestId, text: '【当前状态】他们正在森林里寻找雪山入口。\n【时间线】' })
    callbacks.onChunk!({ requestId, text: '他们去了森林。' })
    callbacks.onChunk!({ requestId, text: '【事实】\n1. 目标是雪山\n2. 带了地图' })
    callbacks.onDone!(requestId)

    const summary = await p
    expect(summary).toBe('他们去了森林。')
    expect(window.api.chat.updateSessionIfMemoryVersion).toHaveBeenCalledWith('char-1', 's1', 0, {
      memory: '他们去了森林。',
      memoryCurrentState: '他们正在森林里寻找雪山入口。',
      memoryFacts: ['目标是雪山', '带了地图'],
      factsVectors: [],
      factsVectorVersion: 0,
      memoryUpdatedAt: expect.any(Number),
      memoryLastMessageId: 'm5',
      memoryVersion: 1,
    })
    // 会话列表刷新
    expect(window.api.chat.listSessions).toHaveBeenCalledWith('char-1')
  })

  it('模型漏掉事实段时保留已有事实，避免解析异常误删', async () => {
    setupSettings()
    const callbacks = captureStreamCallbacks()
    const p = runMemorySummary((() => setupChatStoreState()) as any, vi.fn(), makeCharacter())

    const requestId = callbacks.chatParams!.requestId
    callbacks.onChunk!({ requestId, text: '【摘要】只有摘要没有事实' })
    callbacks.onDone!(requestId)

    await p
    expect(window.api.chat.updateSessionIfMemoryVersion).toHaveBeenCalledWith('char-1', 's1', 0, expect.objectContaining({
      memory: '只有摘要没有事实',
      memoryCurrentState: '',
      memoryFacts: ['旧事实'],
      memoryFactParseFailureCount: 1,
      memoryFactRetryAfterVersion: 1,
    }))
  })

  it('无 ID 的事实提案由服务端匹配并应用', async () => {
    setupSettings()
    const callbacks = captureStreamCallbacks()
    const existing: MemoryFact = {
      id: 'fact-relation', subject: '艾琳', predicate: '与用户的关系', value: '朋友',
      status: 'active', importance: 3, confidence: 0.8, sourceMessageIds: [], updatedAt: 1,
    }
    const state = setupChatStoreState({ sessions: [{ ...setupChatStoreState().sessions[0], memoryFacts: [existing] }] })
    const p = runMemorySummary((() => state) as any, vi.fn(), makeCharacter())

    callbacks.onChunk!({ requestId: callbacks.chatParams!.requestId, text: '【时间线】艾琳确认恋人关系。\n【事实提案】\n```json\n[{"subject":"艾琳","predicate":"与用户的关系","value":"恋人","changeType":"set","importance":5}]\n```' })
    callbacks.onDone!(callbacks.chatParams!.requestId)

    await p
    expect(window.api.chat.updateSessionIfMemoryVersion).toHaveBeenCalledWith('char-1', 's1', 0, expect.objectContaining({
      memoryFacts: [expect.objectContaining({ id: 'fact-relation', value: '恋人', importance: 5 })],
      memoryFactHistory: [expect.objectContaining({ value: '朋友', status: 'superseded' })],
      memoryFactParseFailureCount: 0,
    }))
  })

  it('结构化变更按 ID 更新事实，并保留可追溯字段', async () => {
    setupSettings()
    const callbacks = captureStreamCallbacks()
    const existing: MemoryFact = {
      id: 'fact-location', subject: '艾琳', predicate: '所在地', value: '月落镇',
      status: 'active', importance: 3, confidence: 0.8, sourceMessageIds: ['m0'], updatedAt: 1,
    }
    const state = setupChatStoreState({ sessions: [{ ...setupChatStoreState().sessions[0], memoryFacts: [existing] }] })
    const p = runMemorySummary((() => state) as any, vi.fn(), makeCharacter())

    callbacks.onChunk!({ requestId: callbacks.chatParams!.requestId, text: '【时间线】艾琳前往旧矿坑。\n【事实变更】\n```json\n[{"action":"update","id":"fact-location","patch":{"value":"旧矿坑","importance":5,"confidence":0.95}}]\n```' })
    callbacks.onDone!(callbacks.chatParams!.requestId)

    await p
    expect(window.api.chat.updateSessionIfMemoryVersion).toHaveBeenCalledWith('char-1', 's1', 0, expect.objectContaining({
      memoryFacts: [expect.objectContaining({ id: 'fact-location', value: '旧矿坑', status: 'active', importance: 5, sourceMessageIds: ['m0', 'm5'] })],
      memoryFactHistory: [expect.objectContaining({ value: '月落镇', status: 'superseded', sourceMessageIds: ['m0', 'm5'] })],
    }))
  })

  it('结构化事实变更格式无效时保留旧事实', async () => {
    setupSettings()
    const callbacks = captureStreamCallbacks()
    const p = runMemorySummary((() => setupChatStoreState()) as any, vi.fn(), makeCharacter())

    callbacks.onChunk!({ requestId: callbacks.chatParams!.requestId, text: '【摘要】新的摘要\n【事实变更】\nnot json' })
    callbacks.onDone!(callbacks.chatParams!.requestId)

    await p
    expect(window.api.chat.updateSessionIfMemoryVersion).toHaveBeenCalledWith('char-1', 's1', 0, expect.objectContaining({
      memoryFacts: ['旧事实'],
    }))
  })

  it('成功的空事实结果会原子清空旧事实和旧向量，并记录处理游标', async () => {
    setupSettings()
    const callbacks = captureStreamCallbacks()
    const p = runMemorySummary((() => setupChatStoreState()) as any, vi.fn(), makeCharacter())

    const requestId = callbacks.chatParams!.requestId
    callbacks.onChunk!({ requestId, text: '【摘要】新的情节摘要。\n【事实】\n' })
    callbacks.onDone!(requestId)

    await p
    expect(window.api.chat.updateSessionIfMemoryVersion).toHaveBeenCalledWith('char-1', 's1', 0, expect.objectContaining({
      memory: '新的情节摘要。',
      memoryCurrentState: '',
      memoryFacts: [],
      factsVectors: [],
      factsVectorVersion: 0,
      memoryLastMessageId: 'm5',
      memoryVersion: 1,
    }))
    expect(window.api.chat.updateMemory).not.toHaveBeenCalled()
  })

  it('推理模型只返回思考块时给出可见失败反馈，不静默跳过', async () => {
    setupSettings()
    const callbacks = captureStreamCallbacks()
    const set = vi.fn()
    const p = runMemorySummary((() => setupChatStoreState()) as any, set, makeCharacter())

    const requestId = callbacks.chatParams!.requestId
    callbacks.onChunk!({ requestId, text: '<thought>用户要求总结对话。我需要先梳理剧情……（思考过程耗尽了输出预算）</thought>' })
    callbacks.onDone!(requestId)

    const result = await p
    expect(result).toBeNull()
    expect(window.api.chat.updateSessionIfMemoryVersion).not.toHaveBeenCalled()
    expect(set).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.stringContaining('未产出可解析内容'),
    }))
  })

  it('S3：长记忆输出预算接入模型能力档案，不再固定 6144/8192', async () => {
    setupSettings()
    const callbacks = captureStreamCallbacks()
    const p = runMemorySummary((() => setupChatStoreState()) as any, vi.fn(), makeCharacter())
    // 非推理模型：正文预算（2500 字硬保护线） + 协议余量，请求上限低于通用安全上限 8192
    const expected = resolveRequestBudget({ model: 'gpt-4o', hardMaxChars: 2500 })
    expect(expected.reasoningReserve).toBe(192)
    expect((callbacks.chatParams as any).maxTokens).toBe(expected.requestMaxTokens)
    expect((callbacks.chatParams as any).maxTokens).toBeLessThan(8192)
    // R1-A：撞上限时返回已产出正文，由 parseMemoryResult 容错缺段
    // 阶段3/6：length 不再抛错，allowTruncatedOutput 字段已从契约移除
    expect((callbacks.chatParams as any).allowTruncatedOutput).toBeUndefined()
    callbacks.onDone!(callbacks.chatParams!.requestId)
    await p
  })

  it('S3：推理共享预算模型按档案获得独立推理余量', async () => {
    setupSettings()
    useSettingsStore.setState((state) => ({
      settings: { ...state.settings, activeModel: 'deepseek-v4' },
    }))
    const callbacks = captureStreamCallbacks()
    const p = runMemorySummary((() => setupChatStoreState()) as any, vi.fn(), makeCharacter())
    const expected = resolveRequestBudget({ model: 'deepseek-v4', hardMaxChars: 2500 })
    expect(expected.reasoningReserve).toBe(3072)
    expect((callbacks.chatParams as any).model).toBe('deepseek-v4')
    expect((callbacks.chatParams as any).maxTokens).toBe(expected.requestMaxTokens)
    callbacks.onDone!(callbacks.chatParams!.requestId)
    await p
  })

  it('S3：finishReason=length 且事实提案被截断时仍保存摘要', async () => {
    setupSettings()
    const callbacks = captureStreamCallbacks()
    const p = runMemorySummary((() => setupChatStoreState()) as any, vi.fn(), makeCharacter())

    const requestId = callbacks.chatParams!.requestId
    callbacks.onChunk!({ requestId, text: '【时间线】他们抵达山脚。\n【事实提案】\n```json\n[{"subject":"艾' })
    callbacks.onComplete!({ requestId, finishReason: 'length' })

    await p
    // 摘要与游标照常提交，事实提案部分保持旧值（不静默当作完整成功，另有日志区分）
    expect(window.api.chat.updateSessionIfMemoryVersion).toHaveBeenCalledWith('char-1', 's1', 0, expect.objectContaining({
      memory: '他们抵达山脚。',
      memoryLastMessageId: 'm5',
    }))
  })

  it('模型只输出【当前状态】时保留旧时间线，仍提交状态与游标', async () => {
    setupSettings()
    const callbacks = captureStreamCallbacks()
    const p = runMemorySummary((() => setupChatStoreState()) as any, vi.fn(), makeCharacter())

    const requestId = callbacks.chatParams!.requestId
    callbacks.onChunk!({ requestId, text: '【当前状态】卧室僵持中，Aiko急于接电话。\n【事实提案】\n```json\n[]\n```' })
    callbacks.onDone!(requestId)

    const result = await p
    // 部分成功：返回当前状态文本供调用方判定“总结完成”
    expect(result).toBe('卧室僵持中，Aiko急于接电话。')
    expect(window.api.chat.updateSessionIfMemoryVersion).toHaveBeenCalledWith('char-1', 's1', 0, expect.objectContaining({
      memory: '之前的摘要',
      memoryCurrentState: '卧室僵持中，Aiko急于接电话。',
      memoryLastMessageId: 'm5',
      memoryVersion: 1,
    }))
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
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ error: '长记忆总结请求失败' }))
  })

  it('提交时版本已变化则丢弃旧摘要并返回 null', async () => {
    setupSettings()
    const callbacks = captureStreamCallbacks()
    ;(window.api.chat as any).updateSessionIfMemoryVersion = vi.fn().mockResolvedValue({ applied: false, currentVersion: 2 })
    const set = vi.fn()
    const p = runMemorySummary((() => setupChatStoreState()) as any, set, makeCharacter())

    callbacks.onChunk!({ requestId: callbacks.chatParams!.requestId, text: '【摘要】过期摘要\n【事实】\n' })
    callbacks.onDone!(callbacks.chatParams!.requestId)

    await expect(p).resolves.toBeNull()
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringContaining('旧摘要未写入') }))
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
    expect(systemMsg.content).toContain('“之前的当前状态”是过期快照')
    expect(systemMsg.content).toContain('只把【待总结的新对话】中首次确立或明确改变的内容作为本轮新增事件')
    expect(systemMsg.content).toContain('【已总结内容，仅作衔接】不得再次当作新事件')
    expect(systemMsg.content).toContain('准确保留行动发起者、承诺者、受托者和对象')
    expect(systemMsg.content).toContain('以新信息为准并删除冲突旧表述')
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

  it('仅总结游标之后的消息，并将游标推进到本次增量末尾', async () => {
    setupSettings()
    const callbacks = captureStreamCallbacks()
    const messages = makeMessages(8)
    const session = {
      ...setupChatStoreState().sessions[0],
      memoryLastMessageId: 'm2',
    }
    const p = runMemorySummary(
      (() => setupChatStoreState({ messages, sessions: [session] })) as any,
      vi.fn(),
      makeCharacter(),
    )
    const sent = (callbacks.chatParams as any).messages[1].content
    expect(sent).toContain('【待总结的新对话】')
    expect(sent).toContain('消息内容 3')
    expect(sent).toContain('消息内容 7')
    expect(sent).not.toContain('消息内容 0')

    callbacks.onChunk!({ requestId: callbacks.chatParams!.requestId, text: '【摘要】增量摘要\n【事实】\n' })
    callbacks.onDone!(callbacks.chatParams!.requestId)
    await p
    expect(window.api.chat.updateSessionIfMemoryVersion).toHaveBeenCalledWith('char-1', 's1', 0, expect.objectContaining({
      memoryLastMessageId: 'm7',
    }))
  })

  it('Token 预算截断后只推进到实际发送给模型的消息', async () => {
    setupSettings()
    const callbacks = captureStreamCallbacks()
    const messages = Array.from({ length: MEMORY_SUMMARY_MIN }, (_, index) => makeMessage({
      id: `large-${index}`,
      content: `消息-${index}-${'长'.repeat(4000)}`,
    }))
    const p = runMemorySummary(
      (() => setupChatStoreState({ messages })) as any,
      vi.fn(),
      makeCharacter(),
    )
    const sent = (callbacks.chatParams as any).messages[1].content
    expect(sent).toContain('消息-0-')
    expect(sent).not.toContain('消息-1-')

    callbacks.onChunk!({ requestId: callbacks.chatParams!.requestId, text: '【摘要】首条长消息摘要\n【事实】\n' })
    callbacks.onDone!(callbacks.chatParams!.requestId)
    await p
    expect(window.api.chat.updateSessionIfMemoryVersion).toHaveBeenCalledWith('char-1', 's1', 0, expect.objectContaining({
      memoryLastMessageId: 'large-0',
    }))
  })
})
