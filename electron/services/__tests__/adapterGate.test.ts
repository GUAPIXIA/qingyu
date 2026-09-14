/**
 * 阶段8.1 / 主计划 W3 验收：适配器统一门控与探测。
 *
 * fake-fetch 请求体快照覆盖每个 knob；400 字段拒绝、假接受（off 仍推理）、
 * 无 usage、用户取消、网络失败均有断言；主进程统一解析（含探测跳过）单独覆盖。
 *
 * 说明：本文件所有请求参数都是测试替身（无真实凭据），fetch 全部被 mock。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/qingyu-gate-test' },
}))

import { chatWithRetry, getAdapter } from '../ai'
import { recordGateProbeSignal, resetGateProbesForTests } from '../gateProbeStore'
import {
  createReasoningRunawayGuard,
  shouldEnableRunawayGuard,
  type AIAdapter,
} from '../adapters/types'
import { MIN_USABLE_BODY_TOKENS } from '../../../shared/modelOutputProfile'
import type { ChatParams } from '../../../shared/types'
import type { ReasoningGateDirective } from '../../../shared/reasoningGate'

/** 测试替身连接参数：不是真实凭据，仅用于构造请求体 */
const PLACEHOLDER_CREDENTIAL = 'unit-test-placeholder'

function makeParams(overrides: Partial<ChatParams> = {}): ChatParams {
  return {
    requestId: 'gate-1',
    messages: [
      { role: 'system', content: '你是角色扮演助手' },
      { role: 'user', content: '你好' },
    ],
    provider: 'openai',
    apiKey: PLACEHOLDER_CREDENTIAL,
    baseUrl: 'https://api.example.com/v1',
    model: 'gpt-4o',
    temperature: 0.7,
    topP: 1,
    maxTokens: 4096,
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

function streamResponse(chunks: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder()
      for (const c of chunks) controller.enqueue(encoder.encode(c))
      controller.close()
    },
  })
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  resetGateProbesForTests()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function bodyOf(callIndex = 0): Record<string, unknown> {
  return JSON.parse(fetchMock.mock.calls[callIndex][1].body)
}

// ===================== OpenAI 兼容：knob → 请求体 =====================

describe('OpenAI 门控映射（knob → 请求体）', () => {
  const okBody = { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }

  function paramsFor(model: string, gate: ReasoningGateDirective): ChatParams {
    return makeParams({
      stream: false,
      model,
      reasoningGate: gate,
      ...(gate.level === 'off' ? { reasoningMode: 'disabled' as const } : {}),
    })
  }

  it('thinking-disable（DeepSeek）：off 下发 thinking:{type:disabled}', async () => {
    fetchMock.mockResolvedValue(jsonResponse(okBody))
    const params = paramsFor('deepseek/deepseek-v4.1-flash', { level: 'off', knob: 'thinking-disable' })
    const result = await getAdapter('openai').chat(params, vi.fn(), new AbortController().signal)
    expect(bodyOf().thinking).toEqual({ type: 'disabled' })
    expect(result.gateProbe).toMatchObject({ knob: 'thinking-disable' })
  })

  it('reasoning-effort（o 系）：off→minimal、low→low；standard/full 不下发（不再硬编码 medium）', async () => {
    fetchMock.mockResolvedValue(jsonResponse(okBody))
    await getAdapter('openai').chat(
      paramsFor('o3-mini', { level: 'off', knob: 'reasoning-effort' }), vi.fn(), new AbortController().signal,
    )
    expect(bodyOf(0).reasoning_effort).toBe('minimal')
    expect(bodyOf(0).temperature).toBeUndefined()

    fetchMock.mockResolvedValue(jsonResponse(okBody))
    await getAdapter('openai').chat(
      paramsFor('o3-mini', { level: 'low', knob: 'reasoning-effort' }), vi.fn(), new AbortController().signal,
    )
    expect(bodyOf(1).reasoning_effort).toBe('low')

    fetchMock.mockResolvedValue(jsonResponse(okBody))
    await getAdapter('openai').chat(
      paramsFor('o3-mini', { level: 'standard', knob: 'reasoning-effort' }), vi.fn(), new AbortController().signal,
    )
    expect(bodyOf(2).reasoning_effort).toBeUndefined()
  })

  it('thinking-budget（Qwen 兼容）：off→enable_thinking:false；low→thinking_budget', async () => {
    fetchMock.mockResolvedValue(jsonResponse(okBody))
    await getAdapter('openai').chat(
      paramsFor('qwen3-32b', { level: 'off', knob: 'thinking-budget' }), vi.fn(), new AbortController().signal,
    )
    expect(bodyOf(0).enable_thinking).toBe(false)

    fetchMock.mockResolvedValue(jsonResponse(okBody))
    await getAdapter('openai').chat(
      paramsFor('qwen3-32b', { level: 'low', knob: 'thinking-budget', tokens: 1024 }), vi.fn(), new AbortController().signal,
    )
    expect(bodyOf(1).thinking_budget).toBe(1024)
  })

  it('400 明确指向字段 → 去参重发一次，并把 knobAccepted=false 写进探测信号', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: { message: 'unknown parameter: thinking' } }, 400))
      .mockResolvedValueOnce(jsonResponse(okBody))
    const params = paramsFor('deepseek/deepseek-v4.1-flash', { level: 'off', knob: 'thinking-disable' })

    const result = await getAdapter('openai').chat(params, vi.fn(), new AbortController().signal)

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(bodyOf(0).thinking).toEqual({ type: 'disabled' })
    expect(bodyOf(1).thinking).toBeUndefined()
    expect(result.gateProbe).toMatchObject({ knob: 'thinking-disable', knobAccepted: false })
  })

  it('400 不指向门控字段 → 不重发、不污染探测（真实错误原样抛出）', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: { message: 'invalid api key' } }, 400))
    const params = paramsFor('deepseek/deepseek-v4.1-flash', { level: 'off', knob: 'thinking-disable' })

    await expect(getAdapter('openai').chat(params, vi.fn(), new AbortController().signal)).rejects.toThrow(/400/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('去参重发仍失败 → 只重发一次并抛真实错误', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: { message: 'unsupported thinking' } }, 400))
      .mockResolvedValueOnce(jsonResponse({ error: { message: 'still bad' } }, 400))
    const params = paramsFor('deepseek/deepseek-v4.1-flash', { level: 'off', knob: 'thinking-disable' })

    await expect(getAdapter('openai').chat(params, vi.fn(), new AbortController().signal))
      .rejects.toThrow(/still bad/)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('网络失败不写任何探测结论（不污染 probe）', async () => {
    fetchMock.mockRejectedValue(new Error('fetch failed: ECONNREFUSED'))
    const params = paramsFor('deepseek/deepseek-v4.1-flash', { level: 'off', knob: 'thinking-disable' })

    const error = await getAdapter('openai').chat(params, vi.fn(), new AbortController().signal)
      .then(() => null).catch((e) => e as Error & { gateProbe?: unknown })
    expect(error?.message).toMatch(/fetch failed/)
    expect(error?.gateProbe).toBeUndefined()
  })

  it('用户取消不写探测结论', async () => {
    const controller = new AbortController()
    fetchMock.mockImplementation(() => {
      controller.abort()
      return Promise.reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }))
    })
    const params = paramsFor('deepseek/deepseek-v4.1-flash', { level: 'off', knob: 'thinking-disable' })

    const error = await getAdapter('openai').chat(params, vi.fn(), controller.signal)
      .then(() => null).catch((e) => e as Error & { gateProbe?: unknown })
    expect(error?.name).toBe('AbortError')
    expect(error?.gateProbe).toBeUndefined()
  })
})

// ===================== 假接受（disableIgnored）与 usage 上报 =====================

describe('假接受探测（off 档仍出现推理）', () => {
  it('流式出现 reasoning_content delta → disableIgnored=true', async () => {
    fetchMock.mockResolvedValue(streamResponse([
      'data: {"choices":[{"delta":{"reasoning_content":"内部思考"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"正文"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ]))
    const params = makeParams({
      stream: true,
      model: 'deepseek/deepseek-v4.1-flash',
      reasoningGate: { level: 'off', knob: 'thinking-disable' },
    })

    const result = await getAdapter('openai').chat(params, vi.fn(), new AbortController().signal)

    expect(result.text).toBe('正文')
    expect(result.gateProbe).toMatchObject({ knob: 'thinking-disable', disableIgnored: true })
  })

  it('非流式 reasoning_content + off → disableIgnored=true', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      choices: [{ message: { content: '正文', reasoning_content: '内部思考' }, finish_reason: 'stop' }],
    }))
    const params = makeParams({
      stream: false,
      model: 'deepseek/deepseek-v4.1-flash',
      reasoningGate: { level: 'off', knob: 'thinking-disable' },
    })

    const result = await getAdapter('openai').chat(params, vi.fn(), new AbortController().signal)
    expect(result.gateProbe).toMatchObject({ disableIgnored: true })
  })

  it('流中发现 disableIgnored → 立刻停用守卫，不再提前中止（方案 A）', async () => {
    // off 档 + knob none：门控无法执行，推理持续流出
    // 方案 A：确认 disableIgnored 后禁用守卫——不再 earlyAbort；
    // 若最终仍无正文，走零输出错误（由上层一次重试兜底），不伪装成 earlyAbort。
    const NL = String.fromCharCode(10)
    const reasoningChunk = 'data: '
      + JSON.stringify({ choices: [{ delta: { reasoning_content: 'think '.repeat(200) } }] })
      + NL + NL
    const doneChunk = 'data: [DONE]' + NL + NL
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const encoder = new TextEncoder()
          for (let i = 0; i < 50; i += 1) {
            if ((init.signal as AbortSignal)?.aborted) break
            controller.enqueue(encoder.encode(reasoningChunk))
            await new Promise((r) => setTimeout(r, 1))
          }
          if ((init.signal as AbortSignal)?.aborted) {
            try {
              controller.error(Object.assign(new Error('Aborted'), { name: 'AbortError' }))
            } catch { /* 已关闭则忽略 */ }
            return
          }
          controller.enqueue(encoder.encode(doneChunk))
          try { controller.close() } catch { /* 忽略 */ }
        },
      })
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    })

    const params = makeParams({
      stream: true,
      model: 'deepseek/deepseek-v4.1-flash',
      maxTokens: 600,
      reasoningGate: { level: 'off', knob: 'none' },
    })
    const result = await getAdapter('openai')
      .chat(params, vi.fn(), new AbortController().signal)
      .then(() => null)
      .catch((e) => e as Error & { gateProbe?: { disableIgnored?: boolean } })

    // 不再是 earlyAbort 结构化终局
    expect(result).not.toBeNull()
    expect((result as { earlyAbort?: boolean } | null)?.earlyAbort).toBeUndefined()
    expect(result?.gateProbe).toMatchObject({ disableIgnored: true })
    expect(String(result?.message ?? '')).toContain('未返回任何内容')
  })

  it('指令 earlyAbort:false（已知 disableIgnored 端点）→ 守卫不启用，即使流中出现推理', async () => {
    const NL = String.fromCharCode(10)
    const chunks = [
      'data: ' + JSON.stringify({ choices: [{ delta: { reasoning_content: 'think '.repeat(400) } }] }) + NL + NL,
      'data: ' + JSON.stringify({ choices: [{ delta: { content: '正文' }, finish_reason: 'stop' }] }) + NL + NL,
      'data: [DONE]' + NL + NL,
    ]
    fetchMock.mockResolvedValue(streamResponse(chunks))

    const params = makeParams({
      stream: true,
      model: 'deepseek/deepseek-v4.1-flash',
      maxTokens: 600,
      reasoningGate: { level: 'off', knob: 'none', earlyAbort: false },
    })
    const result = await getAdapter('openai').chat(params, vi.fn(), new AbortController().signal)

    expect(result.earlyAbort).toBeUndefined()
    expect(result.text).toContain('正文')
    expect(result.gateProbe).toMatchObject({ disableIgnored: true })
  })

  it('主进程对 disableIgnored 端点下发 earlyAbort:false（方案 A 接线）', async () => {
    // 先记录探测：该端点 off 被静默忽略
    recordGateProbeSignal(
      { provider: 'openai', baseUrl: 'https://api.example.com/v1', model: 'deepseek/deepseek-v4.1-flash' },
      { knob: 'none', disableIgnored: true },
    )
    const okBody = { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }
    fetchMock.mockResolvedValue(jsonResponse(okBody))
    const spy = vi.fn(async (params: ChatParams) => ({
      text: 'ok',
      finishReason: 'stop' as const,
      ...(params.reasoningGate ? {} : {}),
    }))
    // 注册 spy 适配器，捕获 dispatch 后的 reasoningGate
    const adapter: AIAdapter = {
      async chat(params, onChunk, signal, onUsage) {
        spy(params)
        onChunk('ok')
        void signal
        void onUsage
        return { text: 'ok', finishReason: 'stop' }
      },
      listModels: async () => [],
      testConnection: async () => true,
    }
    await chatWithRetry(
      adapter,
      makeParams({
        model: 'deepseek/deepseek-v4.1-flash',
        reasoningGate: { level: 'off', knob: 'none' },
      }),
      vi.fn(),
      new AbortController().signal,
      0,
    )
    expect(spy.mock.calls[0][0].reasoningGate).toMatchObject({ earlyAbort: false })
  })

  it('无 reasoning usage 时不写 reportsReasoningUsage（不伪造状态）', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      choices: [{ message: { content: '正文' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }))
    const params = makeParams({ stream: false, reasoningGate: { level: 'low', knob: 'reasoning-effort', tokens: 1024 } })

    const result = await getAdapter('openai').chat(params, vi.fn(), new AbortController().signal)
    expect(result.gateProbe?.reportsReasoningUsage).toBeUndefined()
  })

  it('上报 reasoning usage → reportsReasoningUsage=true', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      choices: [{ message: { content: '正文' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 100, total_tokens: 110, completion_tokens_details: { reasoning_tokens: 80 } },
    }))
    const params = makeParams({ stream: false, reasoningGate: { level: 'low', knob: 'reasoning-effort', tokens: 1024 } })

    const result = await getAdapter('openai').chat(params, vi.fn(), new AbortController().signal)
    expect(result.gateProbe?.reportsReasoningUsage).toBe(true)
  })
})

// ===================== Claude =====================

describe('Claude 门控映射', () => {
  const okBody = { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }

  it('thinking-budget：预算来自门控承诺值并被 requestMaxTokens−正文最小空间 钳制', async () => {
    fetchMock.mockResolvedValue(jsonResponse(okBody))
    const params = makeParams({
      provider: 'claude',
      model: 'claude-4-sonnet',
      stream: false,
      maxTokens: 4096,
      reasoningGate: { level: 'low', knob: 'thinking-budget', tokens: 1024 },
    })

    await getAdapter('claude').chat(params, vi.fn(), new AbortController().signal)

    const body = bodyOf()
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 1024 })
    // 启用思考时温度必须为 1、top_p 移除（Anthropic 约束）
    expect(body.temperature).toBe(1)
    expect(body.top_p).toBeUndefined()
  })

  it('承诺值超过 requestMaxTokens−256 时按上限钳制（不吞正文空间）', async () => {
    fetchMock.mockResolvedValue(jsonResponse(okBody))
    const params = makeParams({
      provider: 'claude',
      model: 'claude-4-sonnet',
      stream: false,
      maxTokens: 1000,
      reasoningGate: { level: 'standard', knob: 'thinking-budget', tokens: 2048 },
    })

    await getAdapter('claude').chat(params, vi.fn(), new AbortController().signal)
    expect(bodyOf().thinking).toEqual({ type: 'enabled', budget_tokens: 1000 - 256 })
  })

  it('off 档不下发 thinking（省略即关闭），保留采样参数', async () => {
    fetchMock.mockResolvedValue(jsonResponse(okBody))
    const params = makeParams({
      provider: 'claude',
      model: 'claude-4-sonnet',
      stream: false,
      reasoningGate: { level: 'off', knob: 'thinking-budget' },
    })

    await getAdapter('claude').chat(params, vi.fn(), new AbortController().signal)
    expect(bodyOf().thinking).toBeUndefined()
    expect(bodyOf().temperature).toBe(0.7)
  })

  it('400 明确指向 thinking → 去参重发一次并记录拒绝', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: { message: 'thinking is not supported for this model' } }, 400))
      .mockResolvedValueOnce(jsonResponse(okBody))
    const params = makeParams({
      provider: 'claude',
      model: 'claude-4-sonnet',
      stream: false,
      maxTokens: 4096,
      reasoningGate: { level: 'low', knob: 'thinking-budget', tokens: 1024 },
    })

    const result = await getAdapter('claude').chat(params, vi.fn(), new AbortController().signal)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(bodyOf(1).thinking).toBeUndefined()
    expect(result.gateProbe).toMatchObject({ knob: 'thinking-budget', knobAccepted: false })
  })
})

// ===================== Gemini =====================

describe('Gemini 门控映射', () => {
  const okBody = { candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] }

  function geminiParams(gate: ReasoningGateDirective, model = 'gemini-2.5-pro'): ChatParams {
    return makeParams({ provider: 'gemini', model, stream: false, reasoningGate: gate })
  }

  it('off → thinkingConfig.thinkingBudget=0；low → 承诺值', async () => {
    fetchMock.mockResolvedValue(jsonResponse(okBody))
    await getAdapter('gemini').chat(geminiParams({ level: 'off', knob: 'gemini-thinking-config' }), vi.fn(), new AbortController().signal)
    expect((bodyOf(0).generationConfig as Record<string, unknown>).thinkingConfig).toEqual({ thinkingBudget: 0 })

    fetchMock.mockResolvedValue(jsonResponse(okBody))
    await getAdapter('gemini').chat(geminiParams({ level: 'low', knob: 'gemini-thinking-config', tokens: 512 }), vi.fn(), new AbortController().signal)
    expect((bodyOf(1).generationConfig as Record<string, unknown>).thinkingConfig).toEqual({ thinkingBudget: 512 })
  })

  it('gemini-3 按 thinkingLevel 映射（无 0 档，取最低档）', async () => {
    fetchMock.mockResolvedValue(jsonResponse(okBody))
    await getAdapter('gemini').chat(
      geminiParams({ level: 'off', knob: 'gemini-thinking-config' }, 'gemini-3-pro'),
      vi.fn(), new AbortController().signal,
    )
    expect((bodyOf().generationConfig as Record<string, unknown>).thinkingConfig).toEqual({ thinkingLevel: 'low' })
  })

  it('standard/full 不下发 thinkingConfig（端点默认，不额外干预）', async () => {
    fetchMock.mockResolvedValue(jsonResponse(okBody))
    await getAdapter('gemini').chat(geminiParams({ level: 'standard', knob: 'gemini-thinking-config' }), vi.fn(), new AbortController().signal)
    expect((bodyOf().generationConfig as Record<string, unknown>).thinkingConfig).toBeUndefined()
  })

  it('400 明确指向 thinkingConfig → 去参重发一次并记录拒绝', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: { message: 'Unknown name "thinkingConfig"' } }, 400))
      .mockResolvedValueOnce(jsonResponse(okBody))

    const result = await getAdapter('gemini').chat(
      geminiParams({ level: 'off', knob: 'gemini-thinking-config' }),
      vi.fn(), new AbortController().signal,
    )
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect((bodyOf(1).generationConfig as Record<string, unknown>).thinkingConfig).toBeUndefined()
    expect(result.gateProbe).toMatchObject({ knob: 'gemini-thinking-config', knobAccepted: false })
  })
})

// ===================== Ollama 与主进程统一解析 =====================

describe('Ollama 与主进程统一解析', () => {
  it('Ollama 无统一门控参数：任何档位都不下发门控字段', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ message: { content: 'ok' }, done: true }))
    const params = makeParams({
      provider: 'ollama',
      model: 'llama3.2',
      baseUrl: 'http://localhost:11434',
      stream: false,
      reasoningGate: { level: 'off', knob: 'none' },
    })

    await getAdapter('ollama').chat(params, vi.fn(), new AbortController().signal)
    const body = bodyOf()
    expect(body.thinking).toBeUndefined()
    expect(body.reasoning_effort).toBeUndefined()
    expect(body.thinking_budget).toBeUndefined()
    expect((body.options as Record<string, unknown> | undefined)?.thinkingConfig).toBeUndefined()
  })

  it('主进程按 GateProbe 跳过被拒 knob，并带上预算承诺值', async () => {
    recordGateProbeSignal(
      { provider: 'openai', baseUrl: 'https://api.example.com/v1', model: 'deepseek/deepseek-v4.1-flash' },
      { knob: 'thinking-disable', knobAccepted: false },
    )
    const calls: ChatParams[] = []
    const stub = {
      chat: vi.fn(async (params: ChatParams) => {
        calls.push(params)
        return { text: 'ok', finishReason: 'stop' as const }
      }),
      listModels: vi.fn(),
      testConnection: vi.fn(),
    } as unknown as AIAdapter

    await chatWithRetry(
      stub,
      makeParams({
        model: 'deepseek/deepseek-v4.1-flash',
        reasoningGate: { level: 'off', knob: 'thinking-disable' },
      }),
      () => {}, new AbortController().signal, 0,
    )

    expect(calls[0].reasoningGate).toMatchObject({ level: 'off', knob: 'reasoning-effort' })
    // 未确认接受该 knob：预算承诺值退化为档案保守余量（deepseek-v4 = 3072）
    expect((calls[0].reasoningGate as ReasoningGateDirective).tokens).toBe(3072)
  })

  it('没有探测记录时不做 knob 跳过，tokens 为保守余量', async () => {
    const calls: ChatParams[] = []
    const stub = {
      chat: vi.fn(async (params: ChatParams) => {
        calls.push(params)
        return { text: 'ok', finishReason: 'stop' as const }
      }),
      listModels: vi.fn(),
      testConnection: vi.fn(),
    } as unknown as AIAdapter

    await chatWithRetry(
      stub,
      makeParams({ model: 'deepseek/deepseek-v4.1-flash', reasoningGate: { level: 'off', knob: 'thinking-disable' } }),
      () => {}, new AbortController().signal, 0,
    )
    expect(calls[0].reasoningGate).toMatchObject({ level: 'off', knob: 'thinking-disable', tokens: 3072 })
  })

  it('未提供门控指令时完全不介入（适配器保持现行行为）', async () => {
    const calls: ChatParams[] = []
    const stub = {
      chat: vi.fn(async (params: ChatParams) => {
        calls.push(params)
        return { text: 'ok', finishReason: 'stop' as const }
      }),
      listModels: vi.fn(),
      testConnection: vi.fn(),
    } as unknown as AIAdapter

    await chatWithRetry(stub, makeParams({ model: 'gpt-4o' }), () => {}, new AbortController().signal, 0)
    expect(calls[0].reasoningGate).toBeUndefined()
  })
})

// G1 取证后修订（2026-09-13）：观测线从"上限 × 0.85"改为"不足正文绝对下限"，语义可证明
describe('推理越线观测线（requestMaxTokens − 正文绝对下限）', () => {
  it('恰好剩 MIN_USABLE_BODY_TOKENS 正文空间时不中止，越过才中止', () => {
    // 估算口径：ASCII 3 字符 ≈ 1 token（estimateReasoningTokens）
    const maxTokens = 1000
    const line = maxTokens - MIN_USABLE_BODY_TOKENS
    const guard = createReasoningRunawayGuard({ enabled: true, requestMaxTokens: maxTokens })
    guard.addReasoning('a'.repeat((line - 1) * 3))
    expect(guard.shouldAbort()).toBe(false)
    guard.addReasoning('a'.repeat(3)) // 达到观测线（剩余正文空间 = MIN_USABLE_BODY_TOKENS）
    expect(guard.shouldAbort()).toBe(true)
  })

  it('正文一旦出现即永久解除中止资格；未启用/已结束时永不中止', () => {
    const enabledGuard = createReasoningRunawayGuard({ enabled: true, requestMaxTokens: 500 })
    enabledGuard.addBody(1)
    enabledGuard.addReasoning('a'.repeat(3000))
    expect(enabledGuard.shouldAbort()).toBe(false)

    const disabledGuard = createReasoningRunawayGuard({ enabled: false, requestMaxTokens: 500 })
    disabledGuard.addReasoning('a'.repeat(3000))
    expect(disabledGuard.shouldAbort()).toBe(false)

    const finishedGuard = createReasoningRunawayGuard({ enabled: true, requestMaxTokens: 500 })
    finishedGuard.markFinished()
    finishedGuard.addReasoning('a'.repeat(3000))
    expect(finishedGuard.shouldAbort()).toBe(false)
  })

  it('预算为 0/非法时观测线为 0：永不中止（防御，不误杀）', () => {
    const guard = createReasoningRunawayGuard({ enabled: true, requestMaxTokens: 0 })
    guard.addReasoning('a'.repeat(3000))
    expect(guard.shouldAbort()).toBe(false)
  })

  it('disable() 后永不中止（方案 A：流中确认 disableIgnored）', () => {
    const guard = createReasoningRunawayGuard({ enabled: true, requestMaxTokens: 500 })
    guard.disable()
    guard.addReasoning('a'.repeat(3000))
    expect(guard.shouldAbort()).toBe(false)
  })
})

describe('shouldEnableRunawayGuard（方案 A）', () => {
  it('off/none 默认允许；earlyAbort:false 禁止；其他档位禁止', () => {
    expect(shouldEnableRunawayGuard({ level: 'off', knob: 'none' })).toBe(true)
    expect(shouldEnableRunawayGuard({ level: 'off', knob: 'thinking-disable' })).toBe(true)
    expect(shouldEnableRunawayGuard({ level: 'standard', knob: 'none' })).toBe(true)
    expect(shouldEnableRunawayGuard({ level: 'off', knob: 'none', earlyAbort: false })).toBe(false)
    expect(shouldEnableRunawayGuard({ level: 'standard', knob: 'thinking-disable' })).toBe(false)
    expect(shouldEnableRunawayGuard(null)).toBe(false)
    expect(shouldEnableRunawayGuard(undefined)).toBe(false)
  })
})
