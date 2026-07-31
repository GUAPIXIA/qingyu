/**
 * AI 适配层单元测试
 *
 * 覆盖 4 个 provider 的：请求构造、非流式响应解析、流式响应解析、错误处理。
 * 通过 mock 全局 fetch 驱动，不发起真实网络请求。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

// electron 运行时依赖 mock（storage.ts 使用 app.getPath）
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/qingyu-test' },
}))

import { getAdapter } from '../ai'
import type { ChatParams } from '../../../shared/types'

// ===================== 工具函数 =====================

function makeParams(overrides: Partial<ChatParams> = {}): ChatParams {
  return {
    requestId: 'test-1',
    messages: [
      { role: 'system', content: '你是角色扮演助手' },
      { role: 'user', content: '你好' },
    ],
    provider: 'openai',
    apiKey: 'sk-test-key',
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

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** 构造流式 SSE 响应（chunks 为 UTF-8 字节块，可模拟跨 chunk 边界） */
function streamResponse(chunks: string[], contentType = 'text/event-stream'): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder()
      for (const c of chunks) controller.enqueue(encoder.encode(c))
      controller.close()
    },
  })
  return new Response(stream, { status: 200, headers: { 'content-type': contentType } })
}

const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// ===================== OpenAI 适配器 =====================

describe('OpenAI 适配器', () => {
  it('请求构造：URL / headers / body 正确', async () => {
    const params = makeParams({ stream: false })
    fetchMock.mockResolvedValue(jsonResponse({ choices: [{ message: { content: 'hi' } }] }))

    await getAdapter('openai').chat(params, vi.fn(), new AbortController().signal)

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.example.com/v1/chat/completions')
    expect(init.headers).toMatchObject({ Authorization: 'Bearer sk-test-key' })
    const body = JSON.parse(init.body)
    expect(body).toMatchObject({
      model: 'gpt-4o',
      temperature: 0.7,
      top_p: 1,
      max_tokens: 1024,
      stream: false,
      messages: expect.any(Array),
    })
  })

  it('非流式：解析 content 并回调 onChunk / onUsage', async () => {
    const params = makeParams({ stream: false })
    fetchMock.mockResolvedValue(jsonResponse({
      choices: [{ message: { content: '你好，世界' } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }))

    const onChunk = vi.fn()
    const onUsage = vi.fn()
    const result = await getAdapter('openai').chat(params, onChunk, new AbortController().signal, onUsage)

    expect(result).toBe('你好，世界')
    expect(onChunk).toHaveBeenCalledWith('你好，世界')
    expect(onUsage).toHaveBeenCalledWith({ promptTokens: 10, completionTokens: 5, totalTokens: 15 })
  })

  it('非流式：reasoning_content 包装为 thought 标签', async () => {
    const params = makeParams({ stream: false, model: 'deepseek-r1' })
    fetchMock.mockResolvedValue(jsonResponse({
      choices: [{ message: { content: '回答', reasoning_content: '思考过程' } }],
    }))

    const result = await getAdapter('openai').chat(params, vi.fn(), new AbortController().signal)
    expect(result).toBe('<thought>思考过程</thought>\n\n回答')
  })

  it('非流式：tool_calls 附加 [TOOL_CALL] 标记', async () => {
    const params = makeParams({ stream: false })
    fetchMock.mockResolvedValue(jsonResponse({
      choices: [{
        message: {
          content: '',
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"北京"}' } }],
        },
      }],
    }))

    const result = await getAdapter('openai').chat(params, vi.fn(), new AbortController().signal)
    expect(result).toContain('[TOOL_CALL:')
    expect(result).toContain('get_weather')
  })

  it('流式：SSE 分块解析，支持跨 chunk 的 data 行', async () => {
    const params = makeParams({ stream: true })
    // 模拟跨 chunk 边界：第一个 chunk 只有半个 data 行
    fetchMock.mockResolvedValue(streamResponse([
      'data: {"choices":[{"delta":{"content":"你"}}]}\ndata: {"choices":[{"de',
      'lta":{"content":"好"}}]}\n\ndata: [DONE]\n',
    ]))

    const onChunk = vi.fn()
    const result = await getAdapter('openai').chat(params, onChunk, new AbortController().signal)

    expect(result).toBe('你好')
    expect(onChunk.mock.calls.flat()).toEqual(['你', '好'])
  })

  it('流式：reasoning_content 先收集后闭合', async () => {
    const params = makeParams({ stream: true })
    fetchMock.mockResolvedValue(streamResponse([
      'data: {"choices":[{"delta":{"reasoning_content":"思考"}}]}\n\n',
      'data: {"choices":[{"delta":{"reasoning_content":"完毕"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"正文"}}]}\n\n',
      'data: [DONE]\n',
    ]))

    const onChunk = vi.fn()
    const result = await getAdapter('openai').chat(params, onChunk, new AbortController().signal)

    expect(result).toBe('<thought>思考完毕</thought>\n\n正文')
    // 推理内容作为完整块一次性输出
    expect(onChunk).toHaveBeenCalledWith('<thought>思考完毕</thought>\n\n')
    expect(onChunk).toHaveBeenCalledWith('正文')
  })

  it('流式：收集 tool_calls delta 并附加标记', async () => {
    const params = makeParams({ stream: true })
    // 用 JSON.stringify 构造事件，避免手写转义错误
    const e1 = 'data: ' + JSON.stringify({
      choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'get_', arguments: '{"ci' } }] } }],
    }) + '\n\n'
    const e2 = 'data: ' + JSON.stringify({
      choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ty":"北京"}' } }] } }],
    }) + '\n\n'
    fetchMock.mockResolvedValue(streamResponse([e1 + e2 + 'data: [DONE]\n']))

    const result = await getAdapter('openai').chat(params, vi.fn(), new AbortController().signal)
    expect(result).toContain('[TOOL_CALL:')
    expect(result).toContain('get_')
    expect(result).toContain('北京')
    // 合并后的 arguments 应为完整 JSON
    const toolCallJson = result.match(/\[TOOL_CALL:(.*)\]/)?.[1]
    expect(toolCallJson).toBeDefined()
    const calls = JSON.parse(toolCallJson!)
    expect(calls[0].function.arguments).toBe('{"city":"北京"}')
  })

  it('流式：解析 usage（最后 chunk）', async () => {
    const params = makeParams({ stream: true })
    fetchMock.mockResolvedValue(streamResponse([
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}\n\n',
      'data: [DONE]\n',
    ]))

    const onUsage = vi.fn()
    await getAdapter('openai').chat(params, vi.fn(), new AbortController().signal, onUsage)
    expect(onUsage).toHaveBeenCalledWith({ promptTokens: 5, completionTokens: 2, totalTokens: 7 })
  })

  it('推理模型（o1 系列）剔除 temperature / top_p 并设置 reasoning_effort', async () => {
    const params = makeParams({ stream: false, model: 'o1-mini' })
    fetchMock.mockResolvedValue(jsonResponse({ choices: [{ message: { content: 'ok' } }] }))

    await getAdapter('openai').chat(params, vi.fn(), new AbortController().signal)

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.temperature).toBeUndefined()
    expect(body.top_p).toBeUndefined()
    expect(body.frequency_penalty).toBeUndefined()
    expect(body.reasoning_effort).toBe('medium')
  })

  it('非 2xx 响应抛出带状态码的错误', async () => {
    const params = makeParams({ stream: false })
    fetchMock.mockResolvedValue(jsonResponse({ error: 'rate limited' }, 429))

    await expect(getAdapter('openai').chat(params, vi.fn(), new AbortController().signal))
      .rejects.toThrow('429')
  })
})

// ===================== Claude 适配器 =====================

describe('Claude 适配器', () => {
  it('请求构造：system 单独提取、x-api-key header、API 版本头', async () => {
    const params = makeParams({ provider: 'claude', baseUrl: 'https://api.anthropic.com', stream: false })
    fetchMock.mockResolvedValue(jsonResponse({ content: [{ type: 'text', text: 'hi' }] }))

    await getAdapter('claude').chat(params, vi.fn(), new AbortController().signal)

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.anthropic.com/v1/messages')
    expect(init.headers).toMatchObject({
      'x-api-key': 'sk-test-key',
      'anthropic-version': '2023-06-01',
    })
    const body = JSON.parse(init.body)
    expect(body.system).toBe('你是角色扮演助手')
    // system 消息不应出现在 messages 中
    expect(body.messages.every((m: { role: string }) => m.role !== 'system')).toBe(true)
  })

  it('请求构造：OpenAI 格式 tools 转为 Claude 格式', async () => {
    const params = makeParams({
      provider: 'claude',
      stream: false,
      tools: [{
        type: 'function',
        function: { name: 'get_weather', description: '查询天气', parameters: { type: 'object' } },
      }],
      toolChoice: 'required',
    })
    fetchMock.mockResolvedValue(jsonResponse({ content: [{ type: 'text', text: 'hi' }] }))

    await getAdapter('claude').chat(params, vi.fn(), new AbortController().signal)

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.tools[0]).toEqual({
      name: 'get_weather',
      description: '查询天气',
      input_schema: { type: 'object' },
    })
    expect(body.tool_choice).toEqual({ type: 'any' })
  })

  it('非流式：thinking / text / tool_use 混合解析', async () => {
    const params = makeParams({ provider: 'claude', stream: false })
    fetchMock.mockResolvedValue(jsonResponse({
      content: [
        { type: 'thinking', thinking: '推理中' },
        { type: 'text', text: '最终回答' },
        { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: '北京' } },
      ],
      usage: { input_tokens: 10, output_tokens: 5 },
    }))

    const onUsage = vi.fn()
    const result = await getAdapter('claude').chat(params, vi.fn(), new AbortController().signal, onUsage)

    expect(result).toContain('<thought>推理中</thought>\n\n最终回答')
    expect(result).toContain('[TOOL_CALL:')
    expect(result).toContain('get_weather')
    expect(onUsage).toHaveBeenCalledWith({ promptTokens: 10, completionTokens: 5, totalTokens: 15 })
  })

  it('Claude 3.7+ 启用 thinking 且强制 temperature=1', async () => {
    const params = makeParams({ provider: 'claude', model: 'claude-3-7-sonnet', stream: false })
    fetchMock.mockResolvedValue(jsonResponse({ content: [{ type: 'text', text: 'hi' }] }))

    await getAdapter('claude').chat(params, vi.fn(), new AbortController().signal)

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 1024 })
    expect(body.temperature).toBe(1)
  })
})

// ===================== Gemini 适配器 =====================

describe('Gemini 适配器', () => {
  it('请求构造：x-goog-api-key、systemInstruction、generateContent 端点', async () => {
    const params = makeParams({
      provider: 'gemini',
      baseUrl: 'https://generativelanguage.googleapis.com',
      model: 'gemini-2.0-flash',
      stream: false,
    })
    fetchMock.mockResolvedValue(jsonResponse({ candidates: [{ content: { parts: [{ text: 'hi' }] } }] }))

    await getAdapter('gemini').chat(params, vi.fn(), new AbortController().signal)

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent')
    expect(init.headers).toMatchObject({ 'x-goog-api-key': 'sk-test-key' })
    const body = JSON.parse(init.body)
    expect(body.systemInstruction).toEqual({ parts: [{ text: '你是角色扮演助手' }] })
    // assistant → model 角色转换
    expect(body.contents[0].role).toBe('user')
  })

  it('非流式：functionCall 解析为 tool_calls', async () => {
    const params = makeParams({
      provider: 'gemini',
      model: 'gemini-2.0-flash',
      stream: false,
    })
    fetchMock.mockResolvedValue(jsonResponse({
      candidates: [{
        content: {
          parts: [
            { functionCall: { name: 'get_weather', args: { city: '北京' } } },
          ],
        },
      }],
    }))

    const result = await getAdapter('gemini').chat(params, vi.fn(), new AbortController().signal)
    expect(result).toContain('[TOOL_CALL:')
    expect(result).toContain('get_weather')
  })
})

// ===================== Ollama 适配器 =====================

describe('Ollama 适配器', () => {
  it('请求构造：/api/chat、无 Authorization 头、options 参数', async () => {
    const params = makeParams({ provider: 'ollama', baseUrl: 'http://localhost:11434', stream: false })
    fetchMock.mockResolvedValue(jsonResponse({ message: { content: 'hi' } }))

    await getAdapter('ollama').chat(params, vi.fn(), new AbortController().signal)

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://localhost:11434/api/chat')
    expect(init.headers).not.toHaveProperty('Authorization')
    const body = JSON.parse(init.body)
    expect(body.options).toMatchObject({ temperature: 0.7, top_p: 1, num_predict: 1024 })
  })

  it('流式：ndjson 行解析 + done 消息的 usage', async () => {
    const params = makeParams({ provider: 'ollama', stream: true })
    // Ollama 流式是逐行 JSON（非 SSE data: 前缀）
    fetchMock.mockResolvedValue(streamResponse([
      '{"message":{"content":"你"}}\n{"message":{"content":"好"}}\n',
      '{"message":{"content":""},"done":true,"prompt_eval_count":8,"eval_count":3}\n',
    ]))

    const onChunk = vi.fn()
    const onUsage = vi.fn()
    const result = await getAdapter('ollama').chat(params, onChunk, new AbortController().signal, onUsage)

    expect(result).toBe('你好')
    expect(onChunk.mock.calls.flat()).toEqual(['你', '好'])
    expect(onUsage).toHaveBeenCalledWith({ promptTokens: 8, completionTokens: 3, totalTokens: 11 })
  })

  it('非 2xx 响应抛出带响应体的错误', async () => {
    const params = makeParams({ provider: 'ollama', stream: false })
    fetchMock.mockResolvedValue(jsonResponse({ error: 'model not found' }, 404))

    await expect(getAdapter('ollama').chat(params, vi.fn(), new AbortController().signal))
      .rejects.toThrow('404')
  })
})
