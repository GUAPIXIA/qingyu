/**
 * W4（主计划 §7.6）单聊降档恢复验收：
 * - 空正文 + 推理挤占 → 降一档恢复一次（复用同一上下文快照，仅重算预算）；
 * - 有正文的 length 不整条重生成；用户停止不恢复；
 * - 两次均失败只派发一次最终错误，并记录会话熔断事实（提示只展示一次）。
 *
 * 说明：本文件所有请求参数都是测试替身（无真实凭据）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useChatStore } from '../useChatStore'
import { useSettingsStore } from '../useSettingsStore'
import { usePersonaStore } from '../usePersonaStore'
import { getDefaultSettings } from '../../../shared/defaults'
import { streamAIResponse, cleanupActiveStream } from '../streamController'
import { nextRecoveryLevel, resolveEmptyOutputRecovery, GATE_RECOVERY_MAX_BODY_CHARS } from '../gateRecovery'
import {
  isGateBreakerTripped,
  resetReasoningGateStateForTests,
} from '../reasoningGateState'
import { clearUsageProfileCache } from '../usageProfileCache'
import type { Character, Message, ConnectionProfile } from '../../../shared/types'

const MODEL = 'o3-mini' // 推理档案 + 非 deepseek-v4：主对话起步档 standard，可降档

/** 测试替身连接参数：不是真实凭据 */
const PLACEHOLDER_CREDENTIAL = 'unit-test-placeholder'

const PROFILE: ConnectionProfile = {
  id: 'p1',
  name: 'profile',
  provider: 'openai',
  baseUrl: 'https://api.example.com',
  apiKey: PLACEHOLDER_CREDENTIAL,
  model: MODEL,
  maxContext: 128000,
}

function createCharacter(): Character {
  return {
    id: 'char-1', name: 'Alice', avatar: '', description: '', personality: '',
    scenario: '', firstMessage: '', exampleDialog: '', tags: [], lorebookId: null,
    creator: '', createdAt: 0, updatedAt: 0, alternateGreetings: [],
  }
}

interface CapturedStream {
  chatParams: Array<{ requestId: string; maxTokens?: number; reasoningGate?: { level?: string }; stream?: boolean }>
  emitChunk: (index: number, text: string) => void
  complete: (index: number, payload: Record<string, unknown>) => void
  /** G1 收口：模拟主进程 ai:error（携带结构化 errorKind） */
  fail: (index: number, payload: { error: string; errorKind?: string }) => void
}

/** 捕获每一次物理请求的监听器（按注册顺序），供逐个驱动 */
function captureStreams(): CapturedStream {
  const chatParams: CapturedStream['chatParams'] = []
  const chunkCbs: Array<(d: { requestId: string; text: string }) => void> = []
  const doneCbs: Array<(p: Record<string, unknown>) => void> = []
  const errorCbs: Array<(d: { requestId: string; error: string; errorKind?: string }) => void> = []
  ;(window.api.ai as any).onChunk = vi.fn((cb) => { chunkCbs.push(cb); return () => {} })
  ;(window.api.ai as any).onComplete = vi.fn((cb) => { doneCbs.push(cb); return () => {} })
  ;(window.api.ai as any).onError = vi.fn((cb) => { errorCbs.push(cb); return () => {} })
  ;(window.api.ai as any).chat = vi.fn(async (params: any) => { chatParams.push(params) })
  return {
    chatParams,
    emitChunk: (index, text) => chunkCbs[index]?.({ requestId: chatParams[index].requestId, text }),
    complete: (index, payload) => doneCbs[index]?.({ requestId: chatParams[index].requestId, ...payload }),
    fail: (index, payload) => errorCbs[index]?.({ requestId: chatParams[index].requestId, ...payload }),
  }
}

function setupStores() {
  usePersonaStore.setState({ personas: [], loaded: true })
  useSettingsStore.setState({
    settings: {
      ...getDefaultSettings(),
      userName: 'TestUser',
      activeProfileId: 'p1',
      connectionProfiles: [PROFILE],
      activeModel: MODEL,
      // 阶段8 灰度开关：本次验收在开启状态下执行（默认关闭）
      reasoningGateEnabled: true,
    },
    credentials: {},
    loaded: true,
    _saveTimer: null,
  })
  useChatStore.setState({
    messages: [
      {
        id: 'u1', sessionId: 's1', characterId: 'char-1', role: 'user',
        content: '我们继续前进。', images: [], isEditing: false, timestamp: Date.now(),
      } as Message,
      {
        id: 'ai-msg-1', sessionId: 's1', characterId: 'char-1', role: 'assistant',
        content: '', images: [], isEditing: false, timestamp: Date.now(),
      } as Message,
    ],
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

function startStream(onComplete = vi.fn().mockResolvedValue(undefined), onError = vi.fn()) {
  const promise = streamAIResponse(useChatStore.setState as any, useChatStore.getState as any, {
    aiMessageId: 'ai-msg-1',
    character: createCharacter(),
    preset: null,
    onComplete,
    onError,
  })
  return { promise, onComplete, onError }
}

describe('降档恢复判定（纯函数）', () => {
  const base = { finishReason: 'length' as const, rawText: '', currentLevel: 'standard' as const, recoveryUsed: false }

  it('结构化终局 reasoning_gate_exceeded → 降到下一档', () => {
    expect(nextRecoveryLevel({ ...base, terminationCause: 'reasoning_gate_exceeded' })).toBe('low')
    expect(nextRecoveryLevel({ ...base, currentLevel: 'low', terminationCause: 'reasoning_gate_exceeded' })).toBe('off')
    expect(nextRecoveryLevel({ ...base, currentLevel: 'off', terminationCause: 'reasoning_gate_exceeded' })).toBeNull()
  })

  it('正文达到保留线不恢复；不足保留线且推理占比 ≥ 0.9 才恢复', () => {
    const longBody = '她推开门，走进这个陌生的房间，指尖拂过积灰的桌面。'
    expect(nextRecoveryLevel({ ...base, rawText: longBody })).toBeNull()
    expect(nextRecoveryLevel({ ...base, rawText: '短句'.repeat(GATE_RECOVERY_MAX_BODY_CHARS) })).toBeNull()
    expect(nextRecoveryLevel({
      ...base,
      rawText: '半句',
      usage: { completionTokens: 3000, reasoningTokens: 2900 },
    })).toBe('low')
    expect(nextRecoveryLevel({
      ...base,
      rawText: '半句',
      usage: { completionTokens: 3000, reasoningTokens: 1000 },
    })).toBeNull()
  })

  it('无 usage 时只有正文为空才恢复；用户停止/非 length 不恢复；已恢复过不再恢复', () => {
    expect(nextRecoveryLevel({ ...base, rawText: '' })).toBe('low')
    expect(nextRecoveryLevel({ ...base, rawText: '半句' })).toBeNull()
    expect(nextRecoveryLevel({ ...base, finishReason: 'cancelled', terminationCause: 'user_cancel' })).toBeNull()
    expect(nextRecoveryLevel({ ...base, finishReason: 'stop' })).toBeNull()
    expect(nextRecoveryLevel({ ...base, terminationCause: 'reasoning_gate_exceeded', recoveryUsed: true })).toBeNull()
    // 未使用门控（开关关闭）时不介入
    expect(nextRecoveryLevel({ ...base, terminationCause: 'reasoning_gate_exceeded', currentLevel: undefined })).toBeNull()
  })
})

describe('单聊降档恢复（生产路径）', () => {
  beforeEach(() => {
    setupStores()
    vi.clearAllMocks()
    vi.useFakeTimers()
    clearUsageProfileCache()
    resetReasoningGateStateForTests()
  })

  afterEach(() => {
    cleanupActiveStream()
    vi.useRealTimers()
  })

  it('提前中止（空正文）→ 降一档重发同一请求，成功后只派发一次 onComplete', async () => {
    const streams = captureStreams()
    const { promise, onComplete, onError } = startStream()
    await vi.advanceTimersByTimeAsync(0)

    // 第一次物理请求：推理越线，主进程下发结构化终局（正文为空）
    expect(streams.chatParams).toHaveLength(1)
    expect(streams.chatParams[0].reasoningGate?.level).toBe('standard')
    streams.complete(0, { finishReason: 'length', terminationCause: 'reasoning_gate_exceeded', earlyAbort: true })
    await vi.advanceTimersByTimeAsync(0)

    // 第二次物理请求：档位降为 low、换新 requestId、复用同一消息
    expect(streams.chatParams).toHaveLength(2)
    expect(streams.chatParams[1].reasoningGate?.level).toBe('low')
    expect(streams.chatParams[1].requestId).not.toBe(streams.chatParams[0].requestId)
    streams.emitChunk(1, '她推开门，走进这个陌生的房间，指尖拂过积灰的桌面。')
    streams.complete(1, { finishReason: 'stop' })
    await vi.advanceTimersByTimeAsync(10)
    await promise

    expect(onComplete).toHaveBeenCalledTimes(1)
    expect(onComplete.mock.calls[0][0]).toBe('她推开门，走进这个陌生的房间，指尖拂过积灰的桌面。')
    expect(onError).not.toHaveBeenCalled()
  })

  it('有正文的 length 不整条重生成（流式主请求只有一次）', async () => {
    const streams = captureStreams()
    const { promise, onComplete } = startStream()
    await vi.advanceTimersByTimeAsync(0)

    streams.emitChunk(0, '她推开门，走进这个陌生的房间，指尖拂过积灰的桌面。然后她伸手拿')
    streams.complete(0, { finishReason: 'length', usage: { completionTokens: 2000, reasoningTokens: 300 } })
    // length 允许一次短补尾（非流式），等其 60s 兜底超时按失败处理
    await vi.advanceTimersByTimeAsync(60_000 + 100)
    await promise

    expect(streams.chatParams.filter((p) => p.stream !== false)).toHaveLength(1)
    expect(onComplete).toHaveBeenCalledTimes(1)
    expect(onComplete.mock.calls[0][0]).toBe('她推开门，走进这个陌生的房间，指尖拂过积灰的桌面。')
  })

  it('用户停止不恢复（不产生第二次流式请求）', async () => {
    const streams = captureStreams()
    const { promise, onError } = startStream()
    await vi.advanceTimersByTimeAsync(0)

    streams.emitChunk(0, '用户停止前看到的内')
    streams.complete(0, { finishReason: 'cancelled' })
    await vi.advanceTimersByTimeAsync(10)
    await promise

    expect(streams.chatParams.filter((p) => p.stream !== false)).toHaveLength(1)
    expect(onError).not.toHaveBeenCalled()
  })

  it('两次均失败 → 只派发一次最终错误；连续两轮后熔断并从 low 起步，提示只展示一次', async () => {
    const scope = { provider: 'openai', baseUrl: 'https://api.example.com', model: MODEL }
    const failBoth = async (streams: CapturedStream, promise: Promise<void>) => {
      streams.complete(0, { finishReason: 'length', terminationCause: 'reasoning_gate_exceeded', earlyAbort: true })
      await vi.advanceTimersByTimeAsync(0)
      streams.complete(1, { finishReason: 'length', terminationCause: 'reasoning_gate_exceeded', earlyAbort: true })
      await vi.advanceTimersByTimeAsync(10)
      await promise
    }

    // 第一轮：两次都提前中止 → 1 次降档失败，未熔断、无熔断提示
    let streams = captureStreams()
    let run = startStream()
    await vi.advanceTimersByTimeAsync(0)
    await failBoth(streams, run.promise)
    expect(run.onComplete).not.toHaveBeenCalled()
    expect(run.onError).toHaveBeenCalledTimes(1)
    expect(String(run.onError.mock.calls[0][0])).not.toContain('更低思考强度')
    expect(isGateBreakerTripped(scope)).toBe(false)

    // 第二轮：再次失败 → 熔断，最终错误只提示一次
    cleanupActiveStream()
    setupStores()
    streams = captureStreams()
    run = startStream()
    await vi.advanceTimersByTimeAsync(0)
    await failBoth(streams, run.promise)
    expect(run.onError).toHaveBeenCalledTimes(1)
    expect(String(run.onError.mock.calls[0][0])).toContain('更低思考强度')
    expect(isGateBreakerTripped(scope)).toBe(true)

    // 第三轮：熔断后起步档直接为 low（不再从 standard 试）
    cleanupActiveStream()
    setupStores()
    streams = captureStreams()
    run = startStream()
    await vi.advanceTimersByTimeAsync(0)
    expect(streams.chatParams[0].reasoningGate?.level).toBe('low')
    await failBoth(streams, run.promise)
    // 提示已展示过，不再重复
    expect(String(run.onError.mock.calls[0][0])).not.toContain('更低思考强度')
  })
})

describe('零输出一次恢复判定（G1 收口，纯函数）', () => {
  const base = { errorKind: 'empty_output', rawText: '', recoveryUsed: false }

  it('零输出 + off（无更低档位）→ 同档重试，不标记为降档', () => {
    expect(resolveEmptyOutputRecovery({ ...base, currentLevel: 'off' })).toEqual({ downgrade: false, level: 'off' })
  })

  it('推理预算耗尽 + 有更低档位 → 降档；已是 off → 同档重试', () => {
    expect(resolveEmptyOutputRecovery({ ...base, errorKind: 'reasoning_budget_exhausted', currentLevel: 'standard' }))
      .toEqual({ level: 'low', downgrade: true })
    expect(resolveEmptyOutputRecovery({ ...base, errorKind: 'reasoning_budget_exhausted', currentLevel: 'off' }))
      .toEqual({ downgrade: false, level: 'off' })
  })

  it('未使用门控（kill switch 关闭）→ 同档重试且不带门控指令', () => {
    expect(resolveEmptyOutputRecovery({ ...base, currentLevel: undefined })).toEqual({ downgrade: false })
  })

  it('已有正文绝不整条重生成；仅 thought 不算正文', () => {
    expect(resolveEmptyOutputRecovery({ ...base, rawText: '半句正文', currentLevel: 'off' })).toBeNull()
    expect(resolveEmptyOutputRecovery({ ...base, rawText: '<thought>只有心理活动</thought>', currentLevel: 'off' }))
      .toEqual({ downgrade: false, level: 'off' })
  })

  it('已恢复过一次不再恢复；非零输出分类不介入', () => {
    expect(resolveEmptyOutputRecovery({ ...base, currentLevel: 'off', recoveryUsed: true })).toBeNull()
    for (const errorKind of ['network', 'timeout', 'content_filter', 'length_limit', 'api', undefined]) {
      expect(resolveEmptyOutputRecovery({ ...base, errorKind, currentLevel: 'off' })).toBeNull()
    }
  })
})

describe('单聊零输出一次恢复（生产路径，G1 收口）', () => {
  beforeEach(() => {
    setupStores()
    vi.clearAllMocks()
    vi.useFakeTimers()
    clearUsageProfileCache()
    resetReasoningGateStateForTests()
  })

  afterEach(() => {
    cleanupActiveStream()
    vi.useRealTimers()
  })

  const EMPTY_ERROR = '模型未返回任何内容，请重试或检查模型是否可用'

  it('主进程分类为空输出 → 同档重发一次，成功后只派发一次 onComplete', async () => {
    const streams = captureStreams()
    const { promise, onComplete, onError } = startStream()
    await vi.advanceTimersByTimeAsync(0)

    expect(streams.chatParams).toHaveLength(1)
    expect(streams.chatParams[0].reasoningGate?.level).toBe('standard')
    streams.fail(0, { error: EMPTY_ERROR, errorKind: 'empty_output' })
    await vi.advanceTimersByTimeAsync(0)

    // 第二次物理请求：同档（standard）、新 requestId、复用同一份消息
    expect(streams.chatParams).toHaveLength(2)
    expect(streams.chatParams[1].reasoningGate?.level).toBe('standard')
    expect(streams.chatParams[1].requestId).not.toBe(streams.chatParams[0].requestId)

    streams.emitChunk(1, '她推开门，走进这个陌生的房间。')
    streams.complete(1, { finishReason: 'stop' })
    await vi.advanceTimersByTimeAsync(10)
    await promise

    expect(onComplete).toHaveBeenCalledTimes(1)
    expect(onError).not.toHaveBeenCalled()
  })

  it('推理预算耗尽 → 降到下一档重发（与降档恢复同一路径）', async () => {
    const streams = captureStreams()
    const { promise } = startStream()
    await vi.advanceTimersByTimeAsync(0)

    streams.fail(0, { error: '推理已占满模型输出硬上限，未留下正文空间。', errorKind: 'reasoning_budget_exhausted' })
    await vi.advanceTimersByTimeAsync(0)

    expect(streams.chatParams).toHaveLength(2)
    expect(streams.chatParams[1].reasoningGate?.level).toBe('low')
    streams.emitChunk(1, '她推开门。')
    streams.complete(1, { finishReason: 'stop' })
    await vi.advanceTimersByTimeAsync(10)
    await promise
  })

  it('两次零输出 → 只派发一次最终错误，不无限重试', async () => {
    const streams = captureStreams()
    const { promise, onComplete, onError } = startStream()
    await vi.advanceTimersByTimeAsync(0)

    streams.fail(0, { error: EMPTY_ERROR, errorKind: 'empty_output' })
    await vi.advanceTimersByTimeAsync(0)
    expect(streams.chatParams).toHaveLength(2)

    streams.fail(1, { error: EMPTY_ERROR, errorKind: 'empty_output' })
    await vi.advanceTimersByTimeAsync(10)
    await promise

    expect(streams.chatParams).toHaveLength(2)
    expect(onComplete).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledTimes(1)
  })

  it('已有正文时不整条重生成（走既有收口，保留部分正文）', async () => {
    const streams = captureStreams()
    const { promise, onError } = startStream()
    await vi.advanceTimersByTimeAsync(0)

    streams.emitChunk(0, '用户已经看到的半截正文')
    streams.fail(0, { error: EMPTY_ERROR, errorKind: 'empty_output' })
    await vi.advanceTimersByTimeAsync(10)
    await promise

    // 关键：不重发（有正文绝不整条重生成，§4.3）；错误出口照旧派发一次
    expect(streams.chatParams).toHaveLength(1)
    expect(onError).toHaveBeenCalledTimes(1)
  })

  it('旧端缺 errorKind（或传输/审核类分类）→ 保持原行为，不重试', async () => {
    for (const errorKind of [undefined, 'network', 'content_filter']) {
      cleanupActiveStream()
      setupStores()
      const streams = captureStreams()
      const { promise, onError } = startStream()
      await vi.advanceTimersByTimeAsync(0)
      streams.fail(0, { error: '生成中断，请重试', ...(errorKind ? { errorKind } : {}) })
      await vi.advanceTimersByTimeAsync(10)
      await promise
      expect(streams.chatParams).toHaveLength(1)
      expect(onError).toHaveBeenCalledTimes(1)
    }
  })
})
