/**
 * 嵌入适配器单元测试
 *
 * 覆盖 OpenAI 兼容 / Ollama 两种嵌入服务的请求构造、响应解析、错误处理。
 * 通过 mock 全局 fetch 驱动，不发起真实网络请求。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

import { embedTexts, testEmbedding, isEmbeddingConfigured, type EmbeddingConfig } from '../embedding'

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function makeConfig(overrides: Partial<EmbeddingConfig> = {}): EmbeddingConfig {
  return {
    provider: 'openai',
    baseUrl: 'https://api.example.com/v1',
    model: 'text-embedding-3-small',
    apiKey: 'sk-test',
    ...overrides,
  }
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('embedTexts - OpenAI 兼容', () => {
  it('请求构造正确（URL / 方法 / 认证头 / body）', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      data: [
        { index: 0, embedding: [0.1, 0.2] },
        { index: 1, embedding: [0.3, 0.4] },
      ],
    }))
    vi.stubGlobal('fetch', fetchMock)

    const vectors = await embedTexts(makeConfig(), ['你好', '世界'])

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.example.com/v1/embeddings')
    expect(init.method).toBe('POST')
    expect(init.headers.Authorization).toBe('Bearer sk-test')
    const body = JSON.parse(init.body)
    expect(body.model).toBe('text-embedding-3-small')
    expect(body.input).toEqual(['你好', '世界'])
    expect(vectors).toEqual([[0.1, 0.2], [0.3, 0.4]])
  })

  it('无 apiKey 时省略 Authorization 头', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: [] }))
    vi.stubGlobal('fetch', fetchMock)

    await embedTexts(makeConfig({ apiKey: '' }), ['测试'])
    const init = fetchMock.mock.calls[0][1]
    expect(init.headers.Authorization).toBeUndefined()
  })

  it('响应按 index 重排（乱序响应）', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      data: [
        { index: 1, embedding: [9, 9] },
        { index: 0, embedding: [1, 1] },
      ],
    })))

    const vectors = await embedTexts(makeConfig(), ['a', 'b'])
    expect(vectors).toEqual([[1, 1], [9, 9]])
  })

  it('HTTP 错误抛出自带状态码的错误', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('invalid key', { status: 401 })))
    await expect(embedTexts(makeConfig(), ['a'])).rejects.toThrow('401')
  })

  it('空输入返回空数组', async () => {
    expect(await embedTexts(makeConfig(), [])).toEqual([])
  })

  it('超长输入被截断', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: [{ index: 0, embedding: [1] }] }))
    vi.stubGlobal('fetch', fetchMock)
    const long = 'x'.repeat(10000)
    await embedTexts(makeConfig(), [long])
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.input[0].length).toBeLessThanOrEqual(8000)
  })
})

describe('embedTexts - Ollama', () => {
  it('请求构造正确（/api/embed，无认证头）', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      embeddings: [[0.5, 0.6], [0.7, 0.8]],
    }))
    vi.stubGlobal('fetch', fetchMock)

    const vectors = await embedTexts(makeConfig({ provider: 'ollama', baseUrl: 'http://localhost:11434', apiKey: '' }), ['你好', '世界'])

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://localhost:11434/api/embed')
    expect(init.headers.Authorization).toBeUndefined()
    const body = JSON.parse(init.body)
    expect(body.model).toBe('text-embedding-3-small')
    expect(body.input).toEqual(['你好', '世界'])
    expect(vectors).toEqual([[0.5, 0.6], [0.7, 0.8]])
  })

  it('单条输入兼容一维数组响应', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ embeddings: [[1, 2]] })))
    const vectors = await embedTexts(makeConfig({ provider: 'ollama', apiKey: '' }), ['单条'])
    expect(vectors).toEqual([[1, 2]])
  })

  it('HTTP 错误抛错', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('model not found', { status: 404 })))
    await expect(embedTexts(makeConfig({ provider: 'ollama', apiKey: '' }), ['a'])).rejects.toThrow('404')
  })
})

describe('testEmbedding', () => {
  it('成功时返回向量维度', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }] })))
    const result = await testEmbedding(makeConfig())
    expect(result).toEqual({ ok: true, dim: 3 })
  })

  it('失败时返回错误信息', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('bad', { status: 500 })))
    const result = await testEmbedding(makeConfig())
    expect(result.ok).toBe(false)
    expect(result.error).toContain('500')
  })
})

describe('isEmbeddingConfigured', () => {
  it('Ollama 无需 apiKey', () => {
    expect(isEmbeddingConfigured({ provider: 'ollama', baseUrl: 'http://localhost:11434', model: 'nomic-embed-text', apiKey: '' })).toBe(true)
  })

  it('OpenAI 兼容需要 apiKey', () => {
    expect(isEmbeddingConfigured({ provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'x', apiKey: '' })).toBe(false)
    expect(isEmbeddingConfigured({ provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'x', apiKey: 'sk-1' })).toBe(true)
  })

  it('缺 baseUrl 或 model 视为未配置', () => {
    expect(isEmbeddingConfigured({ provider: 'ollama', baseUrl: '', model: 'x', apiKey: '' })).toBe(false)
    expect(isEmbeddingConfigured({ provider: 'ollama', baseUrl: 'http://x', model: '', apiKey: '' })).toBe(false)
  })
})

describe('embedTexts - 分批', () => {
  it('超过批次上限时自动分批并合并结果', async () => {
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body)
      const n = body.input.length
      return jsonResponse({ data: Array.from({ length: n }, (_, i) => ({ index: i, embedding: [i] })) })
    })
    vi.stubGlobal('fetch', fetchMock)

    const inputs = Array.from({ length: 70 }, (_, i) => `文本${i}`)
    const vectors = await embedTexts(makeConfig(), inputs)
    expect(fetchMock).toHaveBeenCalledTimes(3) // 32 + 32 + 6
    expect(vectors.length).toBe(70)
    // 第三批（6 条）内部 index 从 0 开始
    expect(vectors[64]).toEqual([0])
    expect(vectors[69]).toEqual([5])
  })
})
