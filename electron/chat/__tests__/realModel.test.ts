/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck
import { describe, it, expect, vi } from 'vitest'

vi.mock('../../services/ai', () => ({
  getAdapter: vi.fn(() => ({ id: 'openai' })),
  chatWithRetry: vi.fn(async (_adapter, _params, onChunk, _signal, _n, onUsage) => {
    onChunk('hello ')
    onChunk('world')
    onUsage?.({ promptTokens: 10, completionTokens: 5, totalTokens: 15 })
    return 'hello world'
  }),
}))

import { RealModelPort } from '../realModel'
import { chatWithRetry } from '../../services/ai'

describe('RealModelPort', () => {
  it('stream 委托 chatWithRetry 并回调 onChunk/onUsage', async () => {
    const port = new RealModelPort()
    const chunks: string[] = []
    let usage: unknown = null
    const result = await port.stream(
      { messages: [{ role: 'user', content: 'hi' }], model: 'gpt-4o-mini', provider: 'openai', maxTokens: 2048, apiKey: 'sk-x', baseUrl: 'https://api.openai.com/v1' },
      { onChunk: (d) => chunks.push(d), onUsage: (u) => (usage = u) },
      new AbortController().signal,
    )
    expect(result.text).toBe('hello world')
    expect(chunks.join('')).toBe('hello world')
    expect(usage).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 })
  })

  it('无 onUsage 回调仍可完成', async () => {
    const port = new RealModelPort()
    const result = await port.stream(
      { messages: [{ role: 'user', content: 'hi' }], model: 'gpt-4o', provider: 'openai', maxTokens: 2048 },
      { onChunk: () => {} },
      new AbortController().signal,
    )
    expect(result.text).toBeTruthy()
  })

  it('使用上下文规划的动态输出预算，不回退为 1024', async () => {
    const port = new RealModelPort()
    await port.stream(
      { messages: [{ role: 'user', content: 'hi' }], model: 'deepseek-v4-pro', provider: 'openai', maxTokens: 4096 },
      { onChunk: () => {} },
      new AbortController().signal,
    )
    expect(vi.mocked(chatWithRetry).mock.calls.at(-1)?.[1]).toMatchObject({ maxTokens: 4096 })
  })
})
