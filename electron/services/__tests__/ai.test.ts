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

import { getAdapter, registerAIIPC, registerAdapter, unregisterAdapter } from '../ai'
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

  it('OpenCode Go kimi-k3：采样参数强制修正（temperature=1 / top_p=0.95）', async () => {
    // 上游约束：kimi-k3 仅允许 temperature=1、top_p=0.95，项目默认 0.3/0.9 会直接 400
    const params = makeParams({ stream: true, model: 'kimi-k3', temperature: 0.3, topP: 0.9 })
    fetchMock.mockResolvedValue(streamResponse([
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
      'data: [DONE]\n',
    ]))

    await getAdapter('openai').chat(params, vi.fn(), new AbortController().signal)

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.model).toBe('kimi-k3')
    expect(body.temperature).toBe(1)
    expect(body.top_p).toBe(0.95)
  })

  it('非 2xx 响应抛出带状态码的错误', async () => {
    const params = makeParams({ stream: false })
    fetchMock.mockResolvedValue(jsonResponse({ error: 'rate limited' }, 429))

    await expect(getAdapter('openai').chat(params, vi.fn(), new AbortController().signal))
      .rejects.toThrow('429')
  })

  it('含图片消息失败时错误附加「请求包含图片」诊断提示', async () => {
    const params = makeParams({
      stream: false,
      messages: [
        { role: 'user', content: '看图', images: ['data:image/png;base64,iVBORw0KGgo='] },
      ],
    })
    fetchMock.mockResolvedValue(jsonResponse({ error: 'Unexpected item type in content.' }, 400))

    await expect(getAdapter('openai').chat(params, vi.fn(), new AbortController().signal))
      .rejects.toThrow('请求包含图片')
  })

  it('无图片消息失败时错误不附带图片诊断', async () => {
    const params = makeParams({ stream: false })
    fetchMock.mockResolvedValue(jsonResponse({ error: 'rate limited' }, 429))

    const err = await getAdapter('openai').chat(params, vi.fn(), new AbortController().signal)
      .catch((e: unknown) => e as Error)
    expect((err as Error).message).not.toContain('请求包含图片')
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

  it('Claude 3.7+ maxTokens=1024（默认）时不启用 thinking（避免 budget=max_tokens 触发 400）', async () => {
    const params = makeParams({ provider: 'claude', model: 'claude-3-7-sonnet', stream: false })
    fetchMock.mockResolvedValue(jsonResponse({ content: [{ type: 'text', text: 'hi' }] }))

    await getAdapter('claude').chat(params, vi.fn(), new AbortController().signal)

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    // H-2 修复：Anthropic 要求 max_tokens > budget_tokens，1024/1024 相等必 400，故禁用
    expect(body.thinking).toBeUndefined()
    expect(body.temperature).toBe(0.7)
  })

  it('Claude 3.7+ maxTokens 充足时启用 thinking 且移除 top_p', async () => {
    const params = makeParams({ provider: 'claude', model: 'claude-3-7-sonnet', maxTokens: 4096, stream: false })
    fetchMock.mockResolvedValue(jsonResponse({ content: [{ type: 'text', text: 'hi' }] }))

    await getAdapter('claude').chat(params, vi.fn(), new AbortController().signal)

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    // budget = min(floor(4096/3), 4096-1024) = min(1365, 3072) = 1365
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 1365 })
    expect(body.temperature).toBe(1)
    // H-2 修复：thinking 模式下 top_p 与 temperature=1 冲突触发 400，必须移除
    expect(body.top_p).toBeUndefined()
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

// ===================== 模型列表与连接测试 =====================

describe('listModels', () => {
  it('OpenAI：GET /models + Bearer 认证 + data[].id 解析', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }] }))

    const models = await getAdapter('openai').listModels('https://api.openai.com/v1', 'sk-key')

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.openai.com/v1/models')
    expect(init.headers).toMatchObject({ Authorization: 'Bearer sk-key' })
    expect(models).toEqual(['gpt-4o', 'gpt-4o-mini'])
  })

  it('Claude：GET /v1/models + x-api-key 头', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [{ id: 'claude-3-5-sonnet' }] }))

    const models = await getAdapter('claude').listModels('https://api.anthropic.com', 'sk-ant')

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.anthropic.com/v1/models')
    expect(init.headers).toMatchObject({ 'x-api-key': 'sk-ant', 'anthropic-version': '2023-06-01' })
    expect(models).toEqual(['claude-3-5-sonnet'])
  })

  it('Gemini：GET /v1beta/models + 过滤 generateContent 模型 + 去 models/ 前缀', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      models: [
        { name: 'models/gemini-2.0-flash', supportedGenerationMethods: ['generateContent', 'embedContent'] },
        { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
      ],
    }))

    const models = await getAdapter('gemini').listModels('https://generativelanguage.googleapis.com', 'sk')

    const [url] = fetchMock.mock.calls[0]
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models')
    // 只保留支持 generateContent 的模型，且去掉 models/ 前缀
    expect(models).toEqual(['gemini-2.0-flash'])
  })

  it('Ollama：GET /api/tags + 无认证头 + models[].name 解析', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ models: [{ name: 'llama3.2:latest' }, { name: 'qwen2.5:7b' }] }))

    const models = await getAdapter('ollama').listModels('http://localhost:11434', '')

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://localhost:11434/api/tags')
    // Ollama 无需认证：fetch 无任何选项（init undefined）
    expect(init).toBeUndefined()
    expect(models).toEqual(['llama3.2:latest', 'qwen2.5:7b'])
  })

  it('非 2xx 响应抛出错误', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'bad key' }, 401))

    await expect(getAdapter('openai').listModels('https://api.openai.com/v1', 'bad'))
      .rejects.toThrow('401')
  })
})

describe('testConnection', () => {
  it('连接成功返回 true 并调用模型列表', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [{ id: 'gpt-4o' }] }))

    const ok = await getAdapter('openai').testConnection('https://api.openai.com/v1', 'sk-key')

    expect(ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('连接失败（网络错误）返回 false 不抛错', async () => {
    fetchMock.mockRejectedValue(new Error('fetch failed: ECONNREFUSED'))

    const ok = await getAdapter('openai').testConnection('http://localhost:9999/v1', 'sk-key')

    expect(ok).toBe(false)
  })

  it('连接失败（401）返回 false 不抛错', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'invalid api key' }, 401))

    const ok = await getAdapter('claude').testConnection('https://api.anthropic.com', 'bad-key')

    expect(ok).toBe(false)
  })
})

// ===================== IPC 层连接测试 =====================

describe('registerAIIPC 连接通道', () => {
  function registerIpc() {
    const registered = new Map<string, (...args: unknown[]) => unknown>()
    const ipcMain = {
      handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
        registered.set(channel, handler)
      }),
    }
    registerAIIPC(ipcMain as unknown as Parameters<typeof registerAIIPC>[0])
    return registered
  }

  it('ai:testConnection 成功返回 models', async () => {
    const registered = registerIpc()
    // testConnection 内部 + handler 会调用两次 listModels，每次需新 Response
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({ data: [{ id: 'gpt-4o' }] })))

    const handler = registered.get('ai:testConnection')!
    const result = await handler({}, { type: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-key' })

    expect(result).toEqual({ success: true, models: ['gpt-4o'] })
  })

  it('ai:testConnection 失败返回 { success: false, error } 不抛异常', async () => {
    const registered = registerIpc()
    fetchMock.mockResolvedValue(jsonResponse({ error: 'invalid key' }, 401))

    const handler = registered.get('ai:testConnection')!
    const result = await handler({}, { type: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'bad' })

    expect(result).toMatchObject({ success: false })
    // testConnection 内部吞掉错误详情（返回 false），handler 返回通用文案
    expect((result as { error: string }).error).toBe('连接失败')
  })

  it('ai:listModels 网络错误返回 { success: false, error }', async () => {
    const registered = registerIpc()
    fetchMock.mockRejectedValue(new Error('fetch failed: ECONNREFUSED'))

    const handler = registered.get('ai:listModels')!
    const result = await handler({}, 'ollama', 'http://localhost:11434', '')

    expect(result).toMatchObject({ success: false })
    expect((result as { error: string }).error).toContain('ECONNREFUSED')
  })
})

// ===================== Ollama Instruct 模板模式 =====================

describe('Ollama Instruct 模板模式（/api/generate）', () => {
  it('启用模板时走 /api/generate + 消息包装 + 停止序列', async () => {
    const params = makeParams({
      provider: 'ollama',
      baseUrl: 'http://localhost:11434',
      stream: false,
      messages: [
        { role: 'system', content: '你是助手' },
        { role: 'user', content: '你好' },
      ],
      instructTemplate: {
        systemPrefix: '<|im_start|>system\n',
        systemSuffix: '<|im_end|>\n',
        userPrefix: '<|im_start|>user\n',
        userSuffix: '<|im_end|>\n',
        assistantPrefix: '<|im_start|>assistant\n',
        assistantSuffix: '<|im_end|>\n',
        stopSequences: ['<|im_end|>', '<|im_start|>'],
        appendAssistantPrefix: true,
      },
    })
    fetchMock.mockResolvedValue(jsonResponse({ response: '你好呀', done: true, prompt_eval_count: 8, eval_count: 3 }))

    const onChunk = vi.fn()
    const onUsage = vi.fn()
    const result = await getAdapter('ollama').chat(params, onChunk, new AbortController().signal, onUsage)

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://localhost:11434/api/generate')
    const body = JSON.parse(init.body)
    // 消息已按 ChatML 包装为纯文本 prompt
    expect(body.prompt).toContain('<|im_start|>system\n你是助手<|im_end|>')
    expect(body.prompt).toContain('<|im_start|>assistant\n') // appendAssistantPrefix
    expect(body.messages).toBeUndefined() // 不使用 messages 数组
    expect(body.options.stop).toEqual(['<|im_end|>', '<|im_start|>'])

    expect(result).toBe('你好呀')
    expect(onChunk).toHaveBeenCalledWith('你好呀')
    expect(onUsage).toHaveBeenCalledWith({ promptTokens: 8, completionTokens: 3, totalTokens: 11 })
  })

  it('模板模式流式：解析 response 字段（非 message.content）', async () => {
    const params = makeParams({
      provider: 'ollama',
      stream: true,
      messages: [{ role: 'user', content: '嗨' }],
      instructTemplate: {
        systemPrefix: '', systemSuffix: '',
        userPrefix: '<|im_start|>user\n', userSuffix: '<|im_end|>\n',
        assistantPrefix: '<|im_start|>assistant\n', assistantSuffix: '<|im_end|>\n',
        stopSequences: ['<|im_end|>'], appendAssistantPrefix: true,
      },
    })
    fetchMock.mockResolvedValue(streamResponse([
      '{"response":"你"}\n{"response":"好"}\n',
      '{"response":"","done":true,"prompt_eval_count":5,"eval_count":2}\n',
    ]))

    const onChunk = vi.fn()
    const onUsage = vi.fn()
    const result = await getAdapter('ollama').chat(params, onChunk, new AbortController().signal, onUsage)

    expect(result).toBe('你好')
    expect(onChunk.mock.calls.flat()).toEqual(['你', '好'])
    expect(onUsage).toHaveBeenCalledWith({ promptTokens: 5, completionTokens: 2, totalTokens: 7 })
  })

  it('未启用模板时仍走 /api/chat messages 路径', async () => {
    const params = makeParams({ provider: 'ollama', baseUrl: 'http://localhost:11434', stream: false })
    fetchMock.mockResolvedValue(jsonResponse({ message: { content: 'hi' } }))

    await getAdapter('ollama').chat(params, vi.fn(), new AbortController().signal)

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://localhost:11434/api/chat')
    expect(JSON.parse(init.body).messages).toBeDefined()
  })
})

describe('适配器注册表（3.1 提供商扩展）', () => {
  it('OpenAI 兼容新提供商复用 openai 适配器（OpenRouter / vLLM / LM Studio / Tabby）', () => {
    for (const p of ['openrouter', 'vllm', 'lmstudio', 'tabby']) {
      expect(getAdapter(p)).toBe(getAdapter('openai'))
    }
  })

  it('未知提供商回退 OpenAI 兼容适配器', () => {
    expect(getAdapter('not-a-provider')).toBe(getAdapter('openai'))
  })

  it('registerAdapter 注册自定义适配器并优先于内置', async () => {
    const custom = {
      chat: vi.fn().mockResolvedValue('custom'),
      listModels: vi.fn().mockResolvedValue(['m1']),
      testConnection: vi.fn().mockResolvedValue(true),
    }
    registerAdapter('myprovider', custom)
    expect(getAdapter('myprovider')).toBe(custom)
    // 覆盖内置
    registerAdapter('openai', custom)
    expect(getAdapter('openai')).toBe(custom)
    // 注销后回退
    unregisterAdapter('myprovider')
    unregisterAdapter('openai')
    expect(getAdapter('myprovider')).toBe(getAdapter('openai'))
  })

  it('OpenRouter 请求走 OpenAI /chat/completions 格式（Bearer 认证）', async () => {
    const params = makeParams({ provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'sk-or-123', stream: false })
    fetchMock.mockResolvedValue(jsonResponse({ choices: [{ message: { content: 'hi' } }] }))

    await getAdapter('openrouter').chat(params, vi.fn(), new AbortController().signal)

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions')
    expect(init.headers.Authorization).toBe('Bearer sk-or-123')
    expect(JSON.parse(init.body).messages).toBeDefined()
  })

  it('vLLM 请求走本地 /v1/chat/completions', async () => {
    const params = makeParams({ provider: 'vllm', baseUrl: 'http://localhost:8000/v1', stream: false })
    fetchMock.mockResolvedValue(jsonResponse({ choices: [{ message: { content: 'hi' } }] }))

    await getAdapter('vllm').chat(params, vi.fn(), new AbortController().signal)

    const [url] = fetchMock.mock.calls[0]
    expect(url).toBe('http://localhost:8000/v1/chat/completions')
  })
})
