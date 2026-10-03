import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatParams, ProviderType } from '../../../shared/types'
import { openaiAdapter } from '../adapters/openai'
import { claudeAdapter } from '../adapters/claude'
import { geminiAdapter } from '../adapters/gemini'

const adapters = { openai: openaiAdapter, claude: claudeAdapter, gemini: geminiAdapter }
const protocols = ['openai', 'claude', 'gemini'] as const
const fetchMock = vi.fn()

function params(overrides: Partial<ChatParams> = {}): ChatParams {
  return {
    requestId: 'req-1', messages: [{ role: 'user', content: 'hello' }],
    provider: 'openai', baseUrl: 'https://opencode.ai/zen/go/v1', apiKey: 'test-key',
    model: 'test-model', temperature: 0.7, topP: 1, maxTokens: 1024,
    frequencyPenalty: 0, presencePenalty: 0, stream: false,
    ...overrides,
  }
}

function response(protocol: typeof protocols[number], stream = false): Response {
  const data = protocol === 'openai'
    ? { choices: [{ message: { content: 'hello' }, delta: { content: 'hello' }, finish_reason: 'stop' }] }
    : protocol === 'claude'
      ? stream
        ? { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hello' } }
        : { content: [{ type: 'text', text: 'hello' }], stop_reason: 'end_turn' }
      : { candidates: [{ content: { parts: [{ text: 'hello' }] }, finishReason: 'STOP' }] }
  return new Response(stream ? `data: ${JSON.stringify(data)}\n\n` : JSON.stringify(data))
}

function sessionHeaders(): string[] {
  return fetchMock.mock.calls.map(([, init]) => new Headers(init.headers).get('x-opencode-session') ?? '')
}

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

describe('OpenCode 会话路由', () => {
  it.each(protocols)('%s：网关要求会话头时，流式和非流式请求均可通过', async (protocol) => {
    for (const stream of [false, true]) {
      fetchMock.mockImplementationOnce(async (_url, init) => {
        if (!new Headers(init.headers).get('x-opencode-session')) {
          return new Response('{"error":{"type":"MissingSessionID"}}', { status: 400 })
        }
        return response(protocol, stream)
      })
      const result = await adapters[protocol].chat(params({
        provider: protocol as ProviderType, stream,
        observability: { source: 'single', sessionId: 'conversation-1' },
      }), vi.fn(), new AbortController().signal)
      expect(result.text).toBe('hello')
    }
    expect(sessionHeaders()).toEqual(['conversation-1', 'conversation-1'])
  })

  it('同一对话的不同请求复用会话 ID，不同对话分别路由', async () => {
    fetchMock.mockImplementation(async () => response('openai'))
    for (const [requestId, sessionId] of [['req-1', 'session-a'], ['req-2', 'session-a'], ['req-3', 'session-b']]) {
      await openaiAdapter.chat(params({ requestId, observability: { source: 'group', sessionId } }), vi.fn(), new AbortController().signal)
    }
    expect(sessionHeaders()).toEqual(['session-a', 'session-a', 'session-b'])
  })

  it('显式路由会话优先于观测元数据', async () => {
    fetchMock.mockResolvedValue(response('openai'))
    await openaiAdapter.chat(params({ sessionId: 'routing-session', observability: { source: 'single', sessionId: 'legacy-session' } }), vi.fn(), new AbortController().signal)
    expect(sessionHeaders()).toEqual(['routing-session'])
  })

  it('无会话的辅助请求以 requestId 路由，去参重试保留同一 ID', async () => {
    fetchMock.mockResolvedValueOnce(new Response('temperature is unsupported', { status: 400 }))
      .mockResolvedValueOnce(response('openai'))
    await openaiAdapter.chat(params(), vi.fn(), new AbortController().signal)
    expect(sessionHeaders()).toEqual(['req-1', 'req-1'])
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).not.toHaveProperty('temperature')
  })

  it.each(protocols)('%s：模型列表和连接测试也发送非空会话头', async (protocol) => {
    fetchMock.mockImplementation(async (_url, init) => {
      if (!new Headers(init.headers).get('x-opencode-session')) return new Response('', { status: 400 })
      return new Response(JSON.stringify(protocol === 'gemini'
        ? { models: [{ name: 'models/test-model', supportedGenerationMethods: ['generateContent'] }] }
        : { data: [{ id: 'test-model' }] }))
    })
    expect(await adapters[protocol].listModels('https://opencode.ai/zen/go/v1', 'test-key')).toEqual(['test-model'])
    expect(await adapters[protocol].testConnection('https://opencode.ai/zen/go/v1', 'test-key')).toBe(true)
    expect(sessionHeaders()).toHaveLength(2)
    expect(sessionHeaders().every(Boolean)).toBe(true)
  })

  it.each([
    'https://api.example.com/v1',
    'https://opencode.ai.example.com/v1',
    'https://example.com/opencode.ai/zen/go/v1',
  ])('其他服务不携带 OpenCode 会话头：%s', async (baseUrl) => {
    fetchMock.mockResolvedValue(response('openai'))
    await openaiAdapter.chat(params({ baseUrl }), vi.fn(), new AbortController().signal)
    expect(new Headers(fetchMock.mock.calls[0][1].headers).has('x-opencode-session')).toBe(false)
  })
})


it.each(protocols)('%s：功能逻辑会话与主对话隔离，内部重试保持功能路由', async protocol => {
  fetchMock.mockImplementation(async () => response(protocol))
  const common = params({ provider: protocol, sessionId: 'main-session', observability: { source: 'aux', taskType: 'direction', sessionId: 'main-session', featureTask: {
    owner: { kind: 'single', characterId: 'c1', sessionId: 'main-session' }, taskId: 'feature-one', logicalSessionId: 'single:c1:main-session:direction', sourceRef: { messages: [], mode: 'message' },
  } } })
  await adapters[protocol].chat(params({ provider: protocol, sessionId: 'main-session' }), vi.fn(), new AbortController().signal)
  await adapters[protocol].chat(common, vi.fn(), new AbortController().signal)
  await adapters[protocol].chat({ ...common, requestId: 'retry-physical-request' }, vi.fn(), new AbortController().signal)
  await adapters[protocol].chat({ ...common, observability: { ...common.observability!, featureTask: { ...common.observability!.featureTask!, logicalSessionId: 'group:g1:main-session:direction' } } }, vi.fn(), new AbortController().signal)
  const headers = sessionHeaders()
  expect(headers[0]).toBe('main-session')
  expect(headers[1]).not.toBe(headers[0])
  expect(headers[2]).toBe(headers[1])
  expect(headers[3]).not.toBe(headers[1])
  expect(headers.every(value => !value.includes('test-key'))).toBe(true)
})
