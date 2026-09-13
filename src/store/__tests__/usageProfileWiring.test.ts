/**
 * W1（主计划 §7.3）生产接线验收：
 * 单聊发送路径在构建上下文前预取用量样本，并让样本真正进入 `resolveRequestBudget`
 * （P90×1.2 生效）；回读失败时静默回退静态档案，生成不受影响。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useChatStore } from '../useChatStore'
import { useSettingsStore } from '../useSettingsStore'
import { usePersonaStore } from '../usePersonaStore'
import { getDefaultSettings } from '../../../shared/defaults'
import { streamAIResponse, cleanupActiveStream } from '../streamController'
import { clearUsageProfileCache } from '../usageProfileCache'
import type { Character, Message, ConnectionProfile } from '../../../shared/types'

const MODEL = 'deepseek/deepseek-v4.1-flash'

const PROFILE: ConnectionProfile = {
  id: 'p1',
  name: 'profile',
  provider: 'openai',
  baseUrl: 'https://api.example.com',
  apiKey: 'sk-test',
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

function captureStreamCallbacks() {
  const callbacks: { chatParams?: { requestId: string; maxTokens?: number } } = {}
  ;(window.api.ai as any).onChunk = vi.fn().mockReturnValue(() => {})
  ;(window.api.ai as any).onComplete = vi.fn().mockReturnValue(() => {})
  ;(window.api.ai as any).onError = vi.fn().mockReturnValue(() => {})
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
      activeModel: MODEL,
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

/** 跑一次真实单聊发送，返回实际下发的请求参数 */
async function runSend(): Promise<{ maxTokens: number }> {
  const callbacks = captureStreamCallbacks()
  const promise = streamAIResponse(useChatStore.setState as any, useChatStore.getState as any, {
    aiMessageId: 'ai-msg-1',
    character: createCharacter(),
    preset: null,
    onComplete: vi.fn().mockResolvedValue(undefined),
    onError: vi.fn(),
  })
  await vi.advanceTimersByTimeAsync(0)
  const maxTokens = callbacks.chatParams?.maxTokens
  expect(typeof maxTokens).toBe('number')
  cleanupActiveStream()
  await vi.advanceTimersByTimeAsync(0)
  void promise
  return { maxTokens: maxTokens as number }
}

describe('W1 生产接线：样本进入 resolveRequestBudget', () => {
  beforeEach(() => {
    setupStores()
    vi.clearAllMocks()
    vi.useFakeTimers()
    clearUsageProfileCache()
  })

  afterEach(() => {
    cleanupActiveStream()
    vi.useRealTimers()
  })

  it('单聊请求预算使用回读样本的 P90×1.2，而不是静态档案默认余量', async () => {
    const samples = [3000, 3500, 4000]
    const getProfile = vi.fn().mockResolvedValue({
      sampleCount: 12,
      recentReasoningTokens: samples,
      reasoningP90: 4000,
      bodyVisibleCharsP95: 500,
      reasoningFilledRate: 0.08,
      lowConfidence: false,
      counts: { completed: 10, reasoningFilled: 1, knobRejected: 0, error: 1 },
      lastUpdatedAt: Date.now(),
    })
    ;(window.api.ai as any).getGenerationUsageProfile = getProfile

    const withSamples = await runSend()
    expect(getProfile).toHaveBeenCalledWith({
      provider: 'openai',
      baseUrl: 'https://api.example.com',
      model: MODEL,
    })

    // 对照：回读失败 → 静态档案默认余量 3072（deepseek-v4 档案）
    ;(window.api.ai as any).getGenerationUsageProfile = vi.fn().mockRejectedValue(new Error('read failed'))
    clearUsageProfileCache()
    setupStores()
    const staticFallback = await runSend()

    // P90（样本 < 10 取最大值 4000）× 1.2 = 4800，再被档案上限 4096 钳制：
    // 与静态默认余量 3072 的差值必须原样体现在请求上限上
    const expectedReserve = Math.min(4096, Math.ceil(4000 * 1.2))
    expect(withSamples.maxTokens - staticFallback.maxTokens).toBe(expectedReserve - 3072)
    expect(expectedReserve).toBe(4096)
    expect(staticFallback.maxTokens).toBeGreaterThan(0)
  })

  it('回读失败不阻塞生成：请求照常下发，预算退回档案默认值', async () => {
    ;(window.api.ai as any).getGenerationUsageProfile = vi.fn().mockRejectedValue(new Error('read failed'))
    const sent = await runSend()

    // 与「完全无样本（无接口实现）」一致：退回档案默认余量
    clearUsageProfileCache()
    setupStores()
    ;(window.api.ai as any).getGenerationUsageProfile = vi.fn().mockResolvedValue(null)
    const empty = await runSend()

    expect(sent.maxTokens).toBe(empty.maxTokens)
  })

  it('补尾请求复用同一分桶样本（同步命中缓存，不再单独回读）', async () => {
    const getProfile = vi.fn().mockResolvedValue({
      sampleCount: 8,
      recentReasoningTokens: [1200, 1500],
      reasoningP90: 1500,
      bodyVisibleCharsP95: 300,
      reasoningFilledRate: 0,
      lowConfidence: false,
      counts: { completed: 8, reasoningFilled: 0, knobRejected: 0, error: 0 },
      lastUpdatedAt: Date.now(),
    })
    ;(window.api.ai as any).getGenerationUsageProfile = getProfile
    await runSend()
    const callsAfterMain = getProfile.mock.calls.length
    expect(callsAfterMain).toBe(1)

    const { cachedReasoningSamplesFor } = await import('../usageProfileCache')
    expect(cachedReasoningSamplesFor({
      provider: 'openai',
      baseUrl: 'https://api.example.com',
      model: MODEL,
    })).toEqual([1200, 1500])
  })
})
