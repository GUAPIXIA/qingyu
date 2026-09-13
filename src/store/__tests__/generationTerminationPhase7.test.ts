/**
 * 阶段7.1：统一异常链路验收测试（方案 §4.4）。
 *
 * 覆盖：
 * - 终止状态机（claim 一次性、迟到事件忽略、persisted 幂等）；
 * - 终止协调入口行为矩阵（§4.1）：stop/length/timeout/transport 对同一原始文本
 *   得到一致的稳定边界；错误文案绝不进入正文；补尾只对 provider_length 且每轮至多一次；
 * - 桌面单聊 timeout 后的迟到 chunk/done/error 不产生第二次派发（同一 requestId 最多保存一次）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Character, ConnectionProfile, Message } from '../../../shared/types'
import { getDefaultSettings } from '../../../shared/defaults'
import {
  createGenerationTerminationLatch,
  terminationCauseFromFinishReason,
  effectiveFinishReasonForCause,
  observationTerminationCause,
  terminationPromptWithContent,
  terminationPromptWithoutContent,
} from '../../../shared/generationTermination'
import { finalizeGenerationTerminalResult } from '../generatedReplyPipeline'
import { streamAIResponse, cleanupActiveStream, resetTailRepairFailureCounts } from '../streamController'
import { STREAM_IDLE_TIMEOUT_MS } from '../chatConstants'
import { useChatStore } from '../useChatStore'
import { useSettingsStore } from '../useSettingsStore'
import { usePersonaStore } from '../usePersonaStore'

function makeTerminal(cause: 'provider_stop' | 'provider_length' | 'idle_timeout' | 'transport_error' | 'user_cancel' | 'provider_content_filter' | 'protocol_error', rawText: string) {
  return {
    rawText,
    finishReason: 'unknown' as const,
    terminationCause: cause,
    errorMessage: cause === 'transport_error' ? 'fetch failed' : undefined,
  }
}

describe('终止状态机（§4.3）', () => {
  it('只有 streaming 能进入终止分支；claim 后迟到事件全部被忽略', () => {
    const latch = createGenerationTerminationLatch('req-1')
    expect(latch.acceptsStreamEvent()).toBe(true)
    expect(latch.claim('idle_timeout')).toBe(true)
    // 已进入 finalizing：迟到 done / error / 第二次 timeout 全部失败
    expect(latch.claim('transport_error')).toBe(false)
    expect(latch.claim('user_cancel')).toBe(false)
    expect(latch.acceptsStreamEvent()).toBe(false)
    expect(latch.state).toBe('finalizing')
    expect(latch.claimedCause).toBe('idle_timeout')
    // 落盘后同一请求不得再次终止/保存
    latch.markPersisted()
    expect(latch.state).toBe('persisted')
    expect(latch.claim('provider_stop')).toBe(false)
  })

  it('用户停止直接进入 cancelled，仍可被 markPersisted 收口', () => {
    const latch = createGenerationTerminationLatch('req-2')
    expect(latch.claim('user_cancel')).toBe(true)
    expect(latch.state).toBe('cancelled')
    expect(latch.claim('transport_error')).toBe(false)
    latch.markPersisted()
    expect(latch.state).toBe('persisted')
  })
})

describe('finishReason 与 terminationCause 分离映射（§3.2）', () => {
  it('供应商结束原因映射为应用层终止原因，互不覆盖', () => {
    expect(terminationCauseFromFinishReason('stop')).toBe('provider_stop')
    expect(terminationCauseFromFinishReason('length')).toBe('provider_length')
    expect(terminationCauseFromFinishReason('content_filter')).toBe('provider_content_filter')
    expect(terminationCauseFromFinishReason('tool_calls')).toBe('provider_tool_calls')
    expect(terminationCauseFromFinishReason('cancelled')).toBe('user_cancel')
    expect(terminationCauseFromFinishReason('network_error')).toBe('transport_error')
    expect(terminationCauseFromFinishReason('unknown')).toBe('unknown')
    // terminationCause 不得改写供应商 finishReason 口径
    expect(effectiveFinishReasonForCause('idle_timeout', 'stop')).toBe('network_error')
    expect(effectiveFinishReasonForCause('provider_stop', 'stop')).toBe('stop')
    expect(effectiveFinishReasonForCause('user_cancel', 'cancelled')).toBe('cancelled')
  })
})

/** 阶段8（主计划 W2）：推理挤占成为独立终局，并为降档失败提供可操作兜底文案 */
describe('阶段8 推理门控终局映射（W2）', () => {
  it('推理挤占不再混入 provider_length；普通 length 口径不受影响', () => {
    expect(observationTerminationCause({
      outcome: 'truncated',
      finishReason: 'length',
      errorKind: 'reasoning_budget_exhausted',
    })).toBe('reasoning_gate_exceeded')
    expect(observationTerminationCause({ outcome: 'truncated', finishReason: 'length' }))
      .toBe('provider_length')
    // 其他原因映射保持阶段7 口径
    expect(observationTerminationCause({ outcome: 'error', finishReason: 'unknown', errorKind: 'network' }))
      .toBe('transport_error')
  })

  it('收尾按零正文 length 处理；降档重试仍失败时只有兜底文案可见', () => {
    expect(effectiveFinishReasonForCause('reasoning_gate_exceeded', 'unknown')).toBe('length')
    // 零正文终局没有可保留的部分，不产生"已保留"类提示
    expect(terminationPromptWithContent('reasoning_gate_exceeded')).toBeNull()
    expect(terminationPromptWithoutContent('reasoning_gate_exceeded')).toContain('推理占满输出预算')
    // 上游明确错误文案优先于兜底
    expect(terminationPromptWithoutContent('reasoning_gate_exceeded', '上游原文')).toBe('上游原文')
  })
})

describe('终止协调入口行为矩阵（§4.1）', () => {
  // 同一原始文本：前半为稳定句（≥24 可见字符），尾部为悬空半句
  const RAW = '她推开门，走进这个陌生的房间，指尖拂过积灰的桌面。然后她伸手拿'
  const STABLE = '她推开门，走进这个陌生的房间，指尖拂过积灰的桌面。'

  it('stop、timeout、transport 对同一原始文本得到一致的稳定边界', async () => {
    const results = await Promise.all([
      finalizeGenerationTerminalResult({ terminalResult: makeTerminal('provider_stop', RAW), regexRules: [], characterName: '艾琳' }),
      finalizeGenerationTerminalResult({ terminalResult: makeTerminal('idle_timeout', RAW), regexRules: [], characterName: '艾琳' }),
      finalizeGenerationTerminalResult({ terminalResult: makeTerminal('transport_error', RAW), regexRules: [], characterName: '艾琳' }),
    ])
    expect(results.map((r) => r.content)).toEqual([STABLE, STABLE, STABLE])
    // 错误/超时提示只进 generationError，不拼入 content
    expect(results[1].noticeFields.generationError).toBe('请求超时，已保留完整部分')
    expect(results[2].noticeFields.generationError).toBe('生成中断，已保留完整部分')
    for (const r of results) {
      expect(r.content).not.toContain('超时')
      expect(r.content).not.toContain('中断')
      expect(r.persistable).toBe(true)
    }
    // 正常 stop 无提示
    expect(results[0].noticeFields).toEqual({})
  })

  it('补尾只对 provider_length 开放，且每轮至多一次（§8.1）', async () => {
    const repair = vi.fn(async () => STABLE + '然后她离开了房间。')
    // length：稳定正文 <24 可见字符时触发一次补尾
    const repaired = await finalizeGenerationTerminalResult({
      terminalResult: makeTerminal('provider_length', '她推开门，走进房间。然后她伸手拿'),
      regexRules: [],
      characterName: '艾琳',
      runTailRepair: repair,
    })
    expect(repair).toHaveBeenCalledTimes(1)
    expect(repaired.persistable).toBe(true)
    expect(repaired.notice).toBe('tail_repaired')
    expect(repaired.noticeFields.generationNotice).toBe('已自动补全结尾')

    // timeout / transport / stop / cancel：一律不补尾
    repair.mockClear()
    for (const cause of ['idle_timeout', 'transport_error', 'provider_stop'] as const) {
      await finalizeGenerationTerminalResult({
        terminalResult: makeTerminal(cause, '她推开门，走进房间。然后她伸手拿'),
        regexRules: [],
        characterName: '艾琳',
        runTailRepair: repair,
      })
    }
    expect(repair).not.toHaveBeenCalled()
  })

  it('stop 明确结束但无稳定边界时透传保存，不整条丢弃；timeout 无边界则不落盘', async () => {
    const NO_BOUNDARY = '她推开门走进房间然后继续向前 exploration'
    const stopped = await finalizeGenerationTerminalResult({
      terminalResult: makeTerminal('provider_stop', NO_BOUNDARY),
      regexRules: [],
      characterName: '艾琳',
    })
    expect(stopped.persistable).toBe(true)
    expect(stopped.content).toBe(NO_BOUNDARY)

    const timedOut = await finalizeGenerationTerminalResult({
      terminalResult: makeTerminal('idle_timeout', NO_BOUNDARY),
      regexRules: [],
      characterName: '艾琳',
    })
    // 超时且无稳定边界：不保存半句（矩阵"稳定正文"口径 + §4.4 验收）
    expect(timedOut.persistable).toBe(false)
    expect(timedOut.content).toBe('')
    expect(timedOut.noticeFields.generationError).toBe('请求超时，请重试')
  })

  it('user_cancel 保留用户已经看到的正文并给中性提示', async () => {
    const result = await finalizeGenerationTerminalResult({
      terminalResult: makeTerminal('user_cancel', '用户停止前看到的内'),
      regexRules: [],
      characterName: '艾琳',
    })
    expect(result.persistable).toBe(true)
    expect(result.content).toBe('用户停止前看到的内')
    expect(result.noticeFields.generationNotice).toBe('已停止生成')
    expect(result.noticeFields.generationError).toBeUndefined()
  })

  it('content filter 不补尾、不保存正文，给明确审核提示', async () => {
    const repair = vi.fn(async () => '不应被调用')
    const result = await finalizeGenerationTerminalResult({
      terminalResult: { rawText: '被拦截了一半的内容。', finishReason: 'content_filter', terminationCause: 'provider_content_filter' },
      regexRules: [],
      characterName: '艾琳',
      runTailRepair: repair,
    })
    expect(repair).not.toHaveBeenCalled()
    expect(result.persistable).toBe(false)
    expect(result.content).toBe('')
    expect(result.noticeFields.generationError).toContain('审核')
  })

  it('任意异常且无正文 → 不创建空 AI 消息（persistable=false）', async () => {
    for (const cause of ['transport_error', 'idle_timeout', 'protocol_error', 'user_cancel'] as const) {
      const result = await finalizeGenerationTerminalResult({
        terminalResult: makeTerminal(cause, '   '),
        regexRules: [],
        characterName: '艾琳',
      })
      expect(result.persistable).toBe(false)
      expect(result.content).toBe('')
    }
  })

  it('legacy 管线跳过收尾器，但错误提示仍与正文分离', async () => {
    const result = await finalizeGenerationTerminalResult({
      terminalResult: makeTerminal('idle_timeout', RAW),
      regexRules: [],
      characterName: '艾琳',
      legacy: true,
    })
    // legacy：正文原样透传（不做稳定边界收束）
    expect(result.content).toBe(RAW)
    // 但超时提示不得拼进正文
    expect(result.noticeFields.generationError).toBe('请求超时，已保留完整部分')
    expect(result.content).not.toContain('超时')
  })
})

// ===================== 桌面单聊：迟到事件竞态（§4.3 / §4.4） =====================

const PROFILE: ConnectionProfile = {
  id: 'p1',
  name: 'profile',
  provider: 'openai',
  baseUrl: 'https://api.example.com',
  apiKey: 'sk-test',
  model: 'gpt-4o',
  maxContext: 8192,
}

function createCharacter(overrides: Partial<Character> = {}): Character {
  return {
    id: 'char-1',
    name: 'Alice',
    avatar: '',
    description: '',
    personality: '',
    scenario: '',
    firstMessage: '',
    exampleDialog: '',
    tags: [],
    lorebookId: null,
    creator: '',
    createdAt: 0,
    updatedAt: 0,
    alternateGreetings: [],
    ...overrides,
  }
}

function captureStreamCallbacks() {
  const callbacks: {
    onChunk?: (data: { requestId: string; text: string }) => void
    onComplete?: (payload: { requestId: string; finishReason?: string }) => void
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

function setupStores() {
  usePersonaStore.setState({ personas: [], loaded: true })
  useSettingsStore.setState({
    settings: {
      ...getDefaultSettings(),
      userName: 'TestUser',
      activeProfileId: 'p1',
      connectionProfiles: [PROFILE],
      activeModel: 'gpt-4o',
    },
    credentials: {},
    loaded: true,
    _saveTimer: null,
  })
  useChatStore.setState({
    messages: [{
      id: 'ai-msg-1',
      sessionId: 's1',
      characterId: 'char-1',
      role: 'assistant',
      content: '',
      images: [],
      isEditing: false,
      timestamp: Date.now(),
    } as Message],
    sessions: [],
    currentSessionId: 's1',
    isStreaming: false,
    error: null,
    activePresetId: null,
    activeLorebookIds: [],
    translatingMessages: {},
    showTranslationIds: new Set(),
  })
}

describe('桌面单聊终止状态机：迟到事件与重复落盘（§4.4）', () => {
  beforeEach(() => {
    setupStores()
    resetTailRepairFailureCounts()
    vi.clearAllMocks()
    vi.useFakeTimers()
  })

  afterEach(() => {
    cleanupActiveStream()
    vi.useRealTimers()
  })

  it('timeout 收口后到达的迟到 chunk/done/error 全部被忽略，同一 requestId 只派发一次', async () => {
    const callbacks = captureStreamCallbacks()
    const onComplete = vi.fn().mockResolvedValue(undefined)
    const onError = vi.fn()

    const promise = streamAIResponse(useChatStore.setState as any, useChatStore.getState as any, {
      aiMessageId: 'ai-msg-1',
      character: createCharacter(),
      preset: null,
      onComplete,
      onError,
    })
    await vi.advanceTimersByTimeAsync(0)

    const requestId = callbacks.chatParams!.requestId
    // 收到半句后续期，然后卡死触发空闲超时
    callbacks.onChunk!({ requestId, text: '她推开门，走进这个陌生的房间，指尖拂过积灰的桌面。然后她伸手拿' })
    await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS + 10)
    await vi.advanceTimersByTimeAsync(10)

    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledWith('请求超时，已保留完整部分', expect.objectContaining({
      content: '她推开门，走进这个陌生的房间，指尖拂过积灰的桌面。',
      terminationCause: 'idle_timeout',
    }))
    expect(onComplete).not.toHaveBeenCalled()
    expect(window.api.ai.cancelChat).toHaveBeenCalledWith(requestId, 'timeout')

    // 供应商在超时后才吐出最后一个 chunk / done / error：必须全部被状态机忽略
    callbacks.onChunk!({ requestId, text: '到一半停下。' })
    callbacks.onComplete!({ requestId, finishReason: 'stop' })
    callbacks.onError!({ requestId, error: 'late failure' })
    await vi.advanceTimersByTimeAsync(50)

    expect(onError).toHaveBeenCalledTimes(1)
    expect(onComplete).not.toHaveBeenCalled()
    await promise
  })

  it('done 正常收口后到达的迟到 error 不触发第二次派发', async () => {
    const callbacks = captureStreamCallbacks()
    const onComplete = vi.fn().mockResolvedValue(undefined)
    const onError = vi.fn()

    const promise = streamAIResponse(useChatStore.setState as any, useChatStore.getState as any, {
      aiMessageId: 'ai-msg-1',
      character: createCharacter(),
      preset: null,
      onComplete,
      onError,
    })
    await vi.advanceTimersByTimeAsync(0)

    const requestId = callbacks.chatParams!.requestId
    callbacks.onChunk!({ requestId, text: '她说：“今晚的月色真美。”' })
    callbacks.onComplete!({ requestId, finishReason: 'stop' })
    await vi.advanceTimersByTimeAsync(10)

    expect(onComplete).toHaveBeenCalledTimes(1)
    expect(onComplete.mock.calls[0][1]).toMatchObject({ finishReason: 'stop', terminationCause: 'provider_stop' })

    callbacks.onError!({ requestId, error: 'late failure' })
    await vi.advanceTimersByTimeAsync(10)
    expect(onError).not.toHaveBeenCalled()
    await promise
  })

  it('length 触顶进入收尾：meta 携带 terminationCause=provider_length', async () => {
    const callbacks = captureStreamCallbacks()
    const onComplete = vi.fn().mockResolvedValue(undefined)

    const promise = streamAIResponse(useChatStore.setState as any, useChatStore.getState as any, {
      aiMessageId: 'ai-msg-1',
      character: createCharacter(),
      preset: null,
      onComplete,
    })
    await vi.advanceTimersByTimeAsync(0)

    const requestId = callbacks.chatParams!.requestId
    callbacks.onChunk!({ requestId, text: '她推开门，走进这个陌生的房间，指尖拂过积灰的桌面。然后她伸手拿' })
    callbacks.onComplete!({ requestId, finishReason: 'length' })
    // length 允许一次补尾：测试环境补尾请求无响应，等其 60s 兜底超时按失败处理
    await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS + 100)

    expect(onComplete).toHaveBeenCalledTimes(1)
    const [content, meta] = onComplete.mock.calls[0]
    expect(meta.terminationCause).toBe('provider_length')
    // 触顶收束到稳定句界（补尾请求在测试环境无独立响应 mock，失败时保留稳定前缀）
    expect(content).toBe('她推开门，走进这个陌生的房间，指尖拂过积灰的桌面。')
    await promise
  })

  it('claimUserStop 抢占终止权：迟到 done 不再触碰消息（同一 requestId 最多保存一次）', async () => {
    const { claimUserStop } = await import('../streamController')
    const callbacks = captureStreamCallbacks()
    const onComplete = vi.fn().mockResolvedValue(undefined)
    const onError = vi.fn()

    const promise = streamAIResponse(useChatStore.setState as any, useChatStore.getState as any, {
      aiMessageId: 'ai-msg-1',
      character: createCharacter(),
      preset: null,
      onComplete,
      onError,
    })
    await vi.advanceTimersByTimeAsync(0)

    const requestId = callbacks.chatParams!.requestId
    callbacks.onChunk!({ requestId, text: '用户停止前看到的内' })

    const claimed = claimUserStop()
    expect(claimed).toMatchObject({ requestId, aiMessageId: 'ai-msg-1', content: '用户停止前看到的内' })
    // 重复停止（或停止后再点）不会再次拿到终止权
    expect(claimUserStop()).toBeNull()

    // 主进程取消后迟到的 done（finishReason=cancelled）必须被忽略
    callbacks.onComplete!({ requestId, finishReason: 'cancelled' })
    await vi.advanceTimersByTimeAsync(10)
    expect(onComplete).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
    await promise
  })
})
