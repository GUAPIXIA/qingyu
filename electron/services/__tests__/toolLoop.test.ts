/**
 * toolLoop 工具调用单元测试（P-8 补充）
 * 覆盖：callToolWithTimeout 超时 + chatWithTools 主循环（无工具直通 / 工具调用回传 / 中止传播）
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/qingyu-test' },
}))

// mock MCP 管理器与适配器注册表（toolLoop 通过 getAdapter 获取适配器）
// vi.hoisted 保证 mock 工厂与测试体引用同一对象（工厂在 import 前执行）
const mcpMock = vi.hoisted(() => ({
  getAllTools: vi.fn(() => []),
  findToolServer: vi.fn(),
  callTool: vi.fn(),
}))
vi.mock('../../mcp/manager', () => ({ mcpManager: mcpMock }))

const adapterMock = vi.hoisted(() => ({ chat: vi.fn() }))
vi.mock('../ai', () => ({
  getAdapter: vi.fn(() => adapterMock),
}))

import { callToolWithTimeout, chatWithTools } from '../toolLoop'
import type { ChatParams } from '../../../shared/types'

function makeParams(overrides: Partial<ChatParams> = {}): ChatParams {
  return {
    requestId: 'req-1',
    provider: 'openai',
    model: 'gpt-4o',
    apiKey: 'sk-test',
    baseUrl: 'https://api.example.com',
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '帮我查一下' },
    ],
    temperature: 0.8,
    topP: 0.95,
    maxTokens: 1024,
    frequencyPenalty: 0,
    presencePenalty: 0,
    stream: true,
    ...overrides,
  }
}

describe('callToolWithTimeout', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('正常完成时返回结果', async () => {
    const result = await callToolWithTimeout(async () => 'ok', 1000)
    expect(result).toBe('ok')
  })

  it('工具挂起超过时限时抛出超时错误', async () => {
    vi.useFakeTimers()
    const pending = callToolWithTimeout(
      () => new Promise(() => { /* 永不 resolve */ }),
      100,
    )
    const assertion = expect(pending).rejects.toThrow('工具调用超时')
    await vi.advanceTimersByTimeAsync(101)
    await assertion
  })

  it('失败时向上抛出原始错误', async () => {
    await expect(
      callToolWithTimeout(async () => { throw new Error('tool boom') }, 1000),
    ).rejects.toThrow('tool boom')
  })
})

describe('chatWithTools 主循环', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('无工具调用：文本直通返回', async () => {
    adapterMock.chat.mockImplementation(async (_params, onChunk) => {
      onChunk('你')
      onChunk('好')
      return '你好'
    })
    const onChunk = vi.fn()
    const onToolCall = vi.fn()

    const result = await chatWithTools(makeParams(), onChunk, onToolCall, vi.fn())

    expect(result).toBe('你好')
    expect(onChunk).toHaveBeenCalledWith('你')
    expect(onChunk).toHaveBeenCalledWith('好')
    expect(onToolCall).not.toHaveBeenCalled()
    // 传给适配器的 messages 未被工具消息污染
    const passedParams = adapterMock.chat.mock.calls[0][0] as ChatParams
    expect(passedParams.messages).toHaveLength(2)
  })

  it('含工具调用标记：执行工具并回传结果继续循环', async () => {
    mcpMock.getAllTools.mockReturnValue([{ name: 'search', description: '', inputSchema: {} }] as never)
    mcpMock.findToolServer.mockReturnValue({ serverId: 'srv-1' })
    mcpMock.callTool.mockResolvedValue({
      content: [{ type: 'text', text: '搜索结果123' }],
      isError: false,
    })

    // 第一轮：请求工具；第二轮：返回最终答案
    adapterMock.chat
      .mockImplementationOnce(async (_params, onChunk) => {
        onChunk('让我查一下')
        return '让我查一下[TOOL_CALL:[{"id":"tc-1","function":{"name":"search","arguments":"{\\"q\\":\\"天气\\"}"}}]]'
      })
      .mockImplementationOnce(async (_params, onChunk) => {
        onChunk('查询结果如下')
        return '查询结果如下'
      })

    const onToolCall = vi.fn()
    const onToolResult = vi.fn()
    const onChunk = vi.fn()

    const result = await chatWithTools(makeParams(), onChunk, onToolCall, onToolResult)

    expect(result).toBe('查询结果如下')
    // 工具调用通知
    expect(onToolCall).toHaveBeenCalledWith({ id: 'tc-1', name: 'search', args: { q: '天气' } })
    expect(onToolResult).toHaveBeenCalledWith({ id: 'tc-1', content: '搜索结果123', isError: false })
    // 第二轮传给适配器的 messages 包含 assistant tool_calls 与 tool 结果
    const secondParams = adapterMock.chat.mock.calls[1][0] as ChatParams
    const toolMsgs = secondParams.messages.filter((m: { role: string }) => m.role === 'tool')
    expect(toolMsgs).toHaveLength(1)
    expect(toolMsgs[0]).toMatchObject({ content: '搜索结果123', tool_call_id: 'tc-1' })
    const assistantMsg = secondParams.messages.find((m: { role: string }) => m.role === 'assistant')
    expect(assistantMsg).toMatchObject({ content: '让我查一下' })
    expect((assistantMsg as { tool_calls?: unknown[] }).tool_calls).toHaveLength(1)
  })

  it('工具未找到：以错误结果回传并继续循环', async () => {
    mcpMock.getAllTools.mockReturnValue([{ name: 'ghost', description: '', inputSchema: {} }] as never)
    mcpMock.findToolServer.mockReturnValue(undefined)

    adapterMock.chat
      .mockImplementationOnce(async () => '[TOOL_CALL:[{"id":"tc-1","function":{"name":"ghost","arguments":"{}"}}]]')
      .mockImplementationOnce(async () => '最终回答')

    const onToolResult = vi.fn()
    const result = await chatWithTools(makeParams(), vi.fn(), vi.fn(), onToolResult)

    expect(result).toBe('最终回答')
    expect(onToolResult).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'tc-1', isError: true }),
    )
    // 错误信息回传为 tool 消息
    const secondParams = adapterMock.chat.mock.calls[1][0] as ChatParams
    const toolMsg = secondParams.messages.find((m: { role: string }) => m.role === 'tool') as { content: string }
    expect(toolMsg.content).toContain('错误')
  })

  it('中止信号：循环开始时抛出 Aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      chatWithTools(makeParams(), vi.fn(), vi.fn(), vi.fn(), undefined, controller.signal),
    ).rejects.toThrow('Aborted')
    expect(adapterMock.chat).not.toHaveBeenCalled()
  })
})
