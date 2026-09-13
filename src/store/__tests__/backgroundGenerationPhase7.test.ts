/**
 * 阶段7.3：后台任务档案、补尾治理与观测最小化验收。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  BACKGROUND_GENERATION_PROFILES,
  hasCompleteSummaryTail,
} from '../../../shared/backgroundGeneration'
import { observationTerminationCause } from '../../../shared/generationTermination'
import { buildGenerationObservation } from '../../../shared/generationObservation'
import type { ChatParams } from '../../../shared/types'
import type { FinalizedAssistantOutput } from '../../../shared/assistantOutputFinalizer'
import {
  attemptTailRepair,
  abortActiveTailRepair,
  getTailRepairFailureCount,
  resetTailRepairFailureCounts,
} from '../streamController'
import { useSettingsStore } from '../useSettingsStore'
import { getDefaultSettings } from '../../../shared/defaults'
import type { Character } from '../../../shared/types'

describe('BackgroundGenerationProfile（§7.1）', () => {
  it('后台任务不复用主对话篇幅档位', () => {
    const tasks = ['memory', 'compression', 'title', 'direction'] as const
    for (const task of tasks) {
      const profile = BACKGROUND_GENERATION_PROFILES[task]
      expect(profile.task).toBe(task)
      expect(profile.expectedBodyChars).toBeGreaterThan(0)
    }
    // 长记忆要求结构化收尾且触顶时保留部分结果（摘要完整、事实记为未更新）
    expect(BACKGROUND_GENERATION_PROFILES.memory.requiresStructuredTail).toBe(true)
    expect(BACKGROUND_GENERATION_PROFILES.memory.onTruncated).toBe('keep_partial')
    // 压缩/标题/方向：结构残缺即丢弃
    expect(BACKGROUND_GENERATION_PROFILES.compression.onTruncated).toBe('discard')
    expect(BACKGROUND_GENERATION_PROFILES.title.onTruncated).toBe('discard')
    expect(BACKGROUND_GENERATION_PROFILES.title.reasoningReservePolicy).toBe('none')
    // 方向：最多一次"只补结构"的短修复
    expect(BACKGROUND_GENERATION_PROFILES.direction.retryPolicy).toBe('structure_only_once')
  })

  it('摘要边界完整性判定：完整句尾通过，半句拒绝', () => {
    expect(hasCompleteSummaryTail('他们达成了共识。')).toBe(true)
    expect(hasCompleteSummaryTail('“没问题！”')).toBe(true)
    expect(hasCompleteSummaryTail('他们达成了共')).toBe(false)
    expect(hasCompleteSummaryTail('   ')).toBe(false)
  })
})

describe('观测 terminationCause 推导与最小化（§9.1）', () => {
  it('应用层终止原因与供应商 finishReason 分离推导', () => {
    expect(observationTerminationCause({ outcome: 'completed', finishReason: 'stop' })).toBe('provider_stop')
    expect(observationTerminationCause({ outcome: 'truncated', finishReason: 'length' })).toBe('provider_length')
    expect(observationTerminationCause({ outcome: 'user_cancelled', finishReason: 'cancelled', errorKind: 'aborted' })).toBe('user_cancel')
    expect(observationTerminationCause({ outcome: 'error', finishReason: 'unknown', errorKind: 'timeout' })).toBe('idle_timeout')
    expect(observationTerminationCause({ outcome: 'error', finishReason: 'unknown', errorKind: 'network' })).toBe('transport_error')
    expect(observationTerminationCause({ outcome: 'error', finishReason: 'unknown', errorKind: 'aborted', cancelReason: 'timeout' })).toBe('idle_timeout')
    expect(observationTerminationCause({ outcome: 'error', finishReason: 'content_filter', errorKind: 'content_filter' })).toBe('provider_content_filter')
  })

  it('观测记录携带 taskType/terminationCause，但默认不写入正文与提示词', () => {
    const params: ChatParams = {
      requestId: 'req-bg-1',
      messages: [{ role: 'user', content: '机密提示词与世界书内容绝不应出现在观测日志' }],
      provider: 'openai',
      apiKey: 'k',
      baseUrl: 'u',
      model: 'gpt-4o',
      temperature: 0.3,
      topP: 0.9,
      maxTokens: 600,
      frequencyPenalty: 0,
      presencePenalty: 0,
      stream: false,
      observability: { source: 'aux', taskType: 'compression', sessionId: 's1' },
    }
    const obs = buildGenerationObservation(params, {
      startedAt: 0,
      finishedAt: 100,
      text: '这是压缩摘要正文。',
      outcome: 'completed',
      finishReason: 'stop',
      terminationCause: 'provider_stop',
      attempts: 1,
    })
    expect(obs.taskType).toBe('compression')
    expect(obs.terminationCause).toBe('provider_stop')
    // §9.1：默认不保存完整提示词/世界书/角色卡——记录只有长度、token 与枚举分类
    const serialized = JSON.stringify(obs)
    expect(serialized).not.toContain('机密提示词')
    expect(serialized).not.toContain('绝不应出现在观测日志')
  })
})

describe('补尾成本与取消治理（§8.1）', () => {
  const character = {
    id: 'char-1', name: 'Alice', avatar: '', description: '', personality: '', scenario: '',
    firstMessage: '', exampleDialog: '', tags: [], lorebookId: null, creator: '',
    createdAt: 0, updatedAt: 0, alternateGreetings: [],
  } as Character

  const finalized: FinalizedAssistantOutput = {
    content: '',
    status: 'needs_tail_repair',
    repairContext: '她推开门，走进房间。然后她伸手',
    diagnostics: { completeSentence: false, balancedQuotes: true, balancedMarkup: true, visibleChars: 0 },
  }

  let captured: { chatParams?: ChatParams }

  beforeEach(() => {
    resetTailRepairFailureCounts()
    captured = {}
    useSettingsStore.setState({
      settings: {
        ...getDefaultSettings(),
        activeProfileId: 'p1',
        connectionProfiles: [{
          id: 'p1', name: 'p', provider: 'openai', baseUrl: 'https://api.example.com',
          apiKey: 'sk-test', model: 'gpt-4o',
        }] as never,
        activeModel: 'gpt-4o',
      },
      credentials: {}, loaded: true, _saveTimer: null,
    })
    ;(window.api.ai as any).onChunk = vi.fn(() => () => {})
    ;(window.api.ai as any).onComplete = vi.fn(() => () => {})
    ;(window.api.ai as any).onError = vi.fn(() => () => {})
    ;(window.api.ai as any).chat = vi.fn().mockImplementation((params: ChatParams) => {
      captured.chatParams = params
      // 模拟补尾无响应（由 60s 兜底超时按失败处理）
      return Promise.resolve(undefined)
    })
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('补尾请求不重新发送完整世界书与长历史（只带 repairContext）', async () => {
    const promise = attemptTailRepair({ finalized, character, model: 'gpt-4o' })
    // 60s 兜底超时 → 失败
    await vi.advanceTimersByTimeAsync(61_000)
    await promise
    const messages = captured.chatParams!.messages
    expect(messages).toHaveLength(2)
    expect(messages[1].content).toContain('她推开门')
    expect(JSON.stringify(messages)).not.toContain('世界书')
  })

  it('同一模型连续补尾失败两次后，本次会话关闭自动补尾（不再发起请求）', async () => {
    for (let i = 0; i < 2; i++) {
      const promise = attemptTailRepair({ finalized, character, model: 'gpt-4o' })
      await vi.advanceTimersByTimeAsync(61_000)
      expect(await promise).toBeNull()
    }
    expect(getTailRepairFailureCount('gpt-4o')).toBe(2)
    vi.mocked(window.api.ai.chat).mockClear()

    const blocked = attemptTailRepair({ finalized, character, model: 'gpt-4o' })
    expect(await blocked).toBeNull()
    expect(window.api.ai.chat).not.toHaveBeenCalled()
  })

  it('补尾期间用户取消：立即结束并保留稳定前缀口径（返回 null，且不计失败）', async () => {
    const promise = attemptTailRepair({ finalized, character, model: 'gpt-4o' })
    await vi.advanceTimersByTimeAsync(10)
    expect(abortActiveTailRepair()).toBe(true)
    expect(await promise).toBeNull()
    expect(getTailRepairFailureCount('gpt-4o')).toBe(0)
    // 再次取消（无在途补尾）返回 false
    expect(abortActiveTailRepair()).toBe(false)
  })
})
