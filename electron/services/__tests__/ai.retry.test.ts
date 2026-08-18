/**
 * chatWithRetry 错误路径测试
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/qingyu-test' },
}))

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}))

import { chatWithRetry } from '../ai'
import type { ChatParams } from '../../../shared/types'

function makeParams(overrides: Partial<ChatParams> = {}): ChatParams {
  return {
    requestId: 'test-1',
    messages: [{ role: 'user', content: '你好' }],
    provider: 'openai',
    apiKey: 'sk-test',
    baseUrl: 'https://api.example.com/v1',
    model: 'gpt-4o',
    temperature: 0.7,
    topP: 1,
    maxTokens: 1024,
    frequencyPenalty: 0,
    presencePenalty: 0,
    stream: false,
    ...overrides,
  }
}

describe('chatWithRetry', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('成功时只调用一次', async () => {
    const adapter = { chat: vi.fn().mockResolvedValue('ok'), listModels: vi.fn(), testConnection: vi.fn() }
    const result = await chatWithRetry(adapter, makeParams(), vi.fn(), new AbortController().signal, 2)
    expect(result).toBe('ok')
    expect(adapter.chat).toHaveBeenCalledTimes(1)
  })

  it('可重试错误时重试', async () => {
    const adapter = {
      chat: vi.fn()
        .mockRejectedValueOnce(new Error('500 Internal Server Error'))
        .mockResolvedValue('ok'),
      listModels: vi.fn(),
      testConnection: vi.fn(),
    }
    const result = await chatWithRetry(adapter, makeParams({ stream: false }), vi.fn(), new AbortController().signal, 2)
    expect(result).toBe('ok')
    expect(adapter.chat).toHaveBeenCalledTimes(2)
  })

  it('流式请求不重试', async () => {
    const adapter = {
      chat: vi.fn().mockRejectedValue(new Error('500 Internal Server Error')),
      listModels: vi.fn(),
      testConnection: vi.fn(),
    }
    await expect(
      chatWithRetry(adapter, makeParams({ stream: true }), vi.fn(), new AbortController().signal, 2)
    ).rejects.toThrow()
    expect(adapter.chat).toHaveBeenCalledTimes(1)
  })

  it('不可重试错误直接抛出', async () => {
    const adapter = {
      chat: vi.fn().mockRejectedValue(new Error('401 Unauthorized')),
      listModels: vi.fn(),
      testConnection: vi.fn(),
    }
    await expect(
      chatWithRetry(adapter, makeParams(), vi.fn(), new AbortController().signal, 2)
    ).rejects.toThrow('401')
    expect(adapter.chat).toHaveBeenCalledTimes(1)
  })

  it('用户取消不重试', async () => {
    const controller = new AbortController()
    const adapter = {
      chat: vi.fn().mockImplementation(() => {
        controller.abort()
        throw new Error('Aborted')
      }),
      listModels: vi.fn(),
      testConnection: vi.fn(),
    }
    await expect(
      chatWithRetry(adapter, makeParams(), vi.fn(), controller.signal, 2)
    ).rejects.toThrow()
    expect(adapter.chat).toHaveBeenCalledTimes(1)
  })

  it('重试次数耗尽后抛出最后错误', async () => {
    const adapter = {
      chat: vi.fn().mockRejectedValue(new Error('503 Service Unavailable')),
      listModels: vi.fn(),
      testConnection: vi.fn(),
    }
    await expect(
      chatWithRetry(adapter, makeParams({ stream: false }), vi.fn(), new AbortController().signal, 1)
    ).rejects.toThrow('503')
    expect(adapter.chat).toHaveBeenCalledTimes(2) // 初始 + 1 次重试
  })
})
