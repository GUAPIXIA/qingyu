/**
 * chatWithRetry 观测与结构化完成测试（阶段0观测 + 阶段3契约）：
 * 成功 / 触顶 / 取消 / 网络（有正文降级为完成，无正文报错）/ 重试 各落一条观测记录
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/qingyu-test' },
}))

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}))

const recorded: unknown[] = []
vi.mock('../generationObservation', () => ({
  recordGenerationObservation: vi.fn((obs: unknown) => {
    recorded.push(obs)
  }),
}))

import { chatWithRetry } from '../ai'
import type { AIAdapter, TokenUsageInfo } from '../adapters/types'
import type { AICompletion, ChatParams } from '../../../shared/types'
import type { GenerationObservation } from '../../../shared/generationObservation'

function makeParams(overrides: Partial<ChatParams> = {}): ChatParams {
  return {
    requestId: 'obs-1',
    messages: [{ role: 'user', content: '你好' }],
    provider: 'openai',
    apiKey: 'k',
    baseUrl: 'https://example.invalid/v1',
    model: 'deepseek/deepseek-v4.1-flash',
    temperature: 0.8,
    topP: 0.95,
    maxTokens: 4096,
    frequencyPenalty: 0,
    presencePenalty: 0,
    stream: false,
    observability: { source: 'single', generationType: 'normal', responseLengthMode: 'balanced' },
    ...overrides,
  }
}

function makeAdapter(impl: AIAdapter['chat']): AIAdapter {
  return {
    chat: impl,
    listModels: vi.fn(async () => []),
    testConnection: vi.fn(async () => true),
  } as AIAdapter
}

describe('chatWithRetry 观测记录与结构化完成', () => {
  beforeEach(() => {
    recorded.length = 0
  })

  it('成功：记录 completed + finishReason + usage + 正文，返回 AICompletion', async () => {
    const usage: TokenUsageInfo = { promptTokens: 100, completionTokens: 500, totalTokens: 600, reasoningTokens: 300 }
    const adapter = makeAdapter(async (_params, onChunk, _signal, onUsage) => {
      onChunk('她推开门。')
      onUsage?.(usage)
      return { text: '她推开门。', finishReason: 'stop', usage }
    })

    const result = await chatWithRetry(adapter, makeParams(), () => {}, new AbortController().signal)
    expect(result).toEqual({ text: '她推开门。', finishReason: 'stop', usage })
    expect(recorded).toHaveLength(1)
    const obs = recorded[0] as GenerationObservation
    expect(obs.outcome).toBe('completed')
    expect(obs.finishReason).toBe('stop')
    expect(obs.completionTokens).toBe(500)
    expect(obs.reasoningTokens).toBe(300)
    expect(obs.bodyVisibleChars).toBe(5)
    expect(obs.attempts).toBe(1)
  })

  it('length 完成状态：不再抛错，返回 length 并记录 truncated', async () => {
    const adapter = makeAdapter(async (_params, onChunk) => {
      onChunk('半截正文')
      return { text: '半截正文', finishReason: 'length' }
    })

    const result = await chatWithRetry(adapter, makeParams(), () => {}, new AbortController().signal)
    expect(result.finishReason).toBe('length')
    expect(result.text).toBe('半截正文')
    const obs = recorded[0] as GenerationObservation
    expect(obs.outcome).toBe('truncated')
    expect(obs.finishReason).toBe('length')
  })

  it('网络中断但有正文：降级为 network_error 完成结果，正文不丢失', async () => {
    const adapter = makeAdapter(async (_params, onChunk) => {
      onChunk('已流式产出的部分正文，结尾')
      throw new Error('fetch failed: ECONNRESET')
    })

    const result = await chatWithRetry(adapter, makeParams({ stream: true }), () => {}, new AbortController().signal)
    expect(result.finishReason).toBe('network_error')
    expect(result.text).toContain('部分正文')
    const obs = recorded[0] as GenerationObservation
    expect(obs.outcome).toBe('error')
    expect(obs.finishReason).toBe('network_error')
    expect(obs.bodyVisibleChars).toBeGreaterThan(0)
  })

  it('网络中断且无正文：仍按错误抛出', async () => {
    const adapter = makeAdapter(async () => {
      throw new Error('fetch failed: ECONNREFUSED')
    })

    await expect(chatWithRetry(adapter, makeParams(), () => {}, new AbortController().signal))
      .rejects.toThrow()
    const obs = recorded[0] as GenerationObservation
    expect(obs.outcome).toBe('error')
    expect(obs.finishReason).toBe('network_error')
  })

  it('用户停止（signal 已中止）→ user_cancelled', async () => {
    const controller = new AbortController()
    controller.abort()
    const adapter = makeAdapter(async () => { throw new Error('should not be called') })

    await expect(chatWithRetry(adapter, makeParams(), () => {}, controller.signal))
      .rejects.toThrow()
    expect(recorded).toHaveLength(1)
    const obs = recorded[0] as GenerationObservation
    expect(obs.outcome).toBe('user_cancelled')
    expect(obs.finishReason).toBe('cancelled')
  })

  it('重试后成功：attempts 记录实际尝试次数', async () => {
    let calls = 0
    const adapter = makeAdapter(async (_params, onChunk) => {
      calls++
      if (calls === 1) throw new Error('OpenAI API 错误 500: internal') // 可重试
      onChunk('重试后成功。')
      return { text: '重试后成功。', finishReason: 'stop' } as AICompletion
    })

    const result = await chatWithRetry(adapter, makeParams(), () => {}, new AbortController().signal, 1)
    expect(result.text).toBe('重试后成功。')
    expect(recorded).toHaveLength(1)
    const obs = recorded[0] as GenerationObservation
    expect(obs.attempts).toBe(2)
  })
})
