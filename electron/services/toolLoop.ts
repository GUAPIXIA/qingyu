/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * 工具调用循环
 * 当 AI 返回 tool_calls 时，自动调用对应工具并将结果回传给 AI
 * C-03 修复：适配器现在通过 [TOOL_CALL:json] 标记返回 tool_calls
 */
import type { ChatParams } from '../../shared/types'
import { mcpManager } from '../mcp/manager'
import { getAdapter } from './ai'
import { createLogger } from './logger'

const log = createLogger('toolLoop')

/** 工具调用循环最大轮数（防止无限循环） */
const MAX_TOOL_ROUNDS = 10

/** 单次 MCP 工具调用超时（毫秒） */
const TOOL_CALL_TIMEOUT_MS = 60000

/** 带超时的工具调用（防止工具永久挂起） */
export async function callToolWithTimeout<T>(fn: () => Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`工具调用超时（${Math.round(ms / 1000)} 秒）`)), ms)
  })
  try {
    return await Promise.race([fn(), timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * 带工具调用循环的 chat
 * 当 AI 返回 tool_calls 时：
 * 1. 调用对应工具
 * 2. 将结果作为 tool 角色消息追加
 * 3. 再次调用 AI
 * 4. 循环直到 AI 不再请求工具
 */
export async function chatWithTools(
  params: ChatParams,
  onChunk: (text: string) => void,
  onToolCall: (toolCall: { id: string; name: string; args: any }) => void,
  onToolResult: (result: { id: string; content: string; isError: boolean }) => void,
  onUsage?: (usage: { promptTokens: number; completionTokens: number; totalTokens: number }) => void,
  signal?: AbortSignal,
): Promise<string> {
  const adapter = getAdapter(params.provider)
  const tools = mcpManager.getAllTools()

  // 构造 OpenAI 格式的 tools
  const openaiTools = tools.map(t => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema as object,
    },
  }))

  // 复制 messages 以便追加 tool 消息
  const messages: any[] = [...params.messages]
  // BUG-02 修复：fullText 只在最后一轮累积——每轮开始时重置，
  // 避免中间轮次的 assistant 文本（如“让我查一下...”）被拼进最终结果
  let fullText = ''

  // BUG-12 修复：无外部 signal 时创建可追踪的 AbortController，
  // 保留引用以便中止时取消循环
  const fallbackController = new AbortController()
  const effectiveSignal = signal ?? fallbackController.signal

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    if (effectiveSignal.aborted) throw new Error('Aborted')
    // 每轮开始时重置，仅保留当前轮文本
    fullText = ''

    const roundParams: ChatParams = {
      ...params,
      tools: openaiTools,
      toolChoice: 'auto',
      messages,
    }

    // 普通文本 chunk 直接透传
    const toolCallsAdapter = (text: string) => {
      if (text && !text.startsWith('[TOOL_CALL]')) {
        fullText += text
        onChunk(text)
      }
    }

    // 调用适配器
    const result = await adapter.chat(
      roundParams,
      toolCallsAdapter,
      effectiveSignal,
      onUsage,
    )

    // 中止检查：取消后不再继续下一轮
    if (effectiveSignal.aborted) throw new Error('Aborted')

    // 检查 result 是否含 tool_calls 标记
    const toolCallMatch = result.match(/\[TOOL_CALL:(.*)\]\s*$/)
    if (!toolCallMatch) {
      // 没有工具调用，结束循环
      return fullText || result
    }

    // 解析 tool_calls
    let toolCalls: Array<{ id: string; function?: { name: string; arguments: string }; name?: string; args?: any }>
    try {
      const toolCallsData = JSON.parse(toolCallMatch[1])
      toolCalls = Array.isArray(toolCallsData) ? toolCallsData : [toolCallsData]
    } catch {
      return fullText || result
    }

    // 将 assistant 的 tool_calls 加入 messages
    // BUG-28 修复：content 用空字符串而非 null，兼容部分对 null 严格校验的 provider
    messages.push({
      role: 'assistant',
      content: result.replace(/\[TOOL_CALL:.*\]\s*$/, '').trim() || '',
      tool_calls: toolCalls.map(tc => ({
        id: tc.id,
        type: 'function',
        function: {
          name: tc.function?.name ?? tc.name ?? '',
          arguments: tc.function?.arguments ?? JSON.stringify(tc.args ?? {}),
        },
      })),
    })

    // 执行每个工具调用
    // BUG-03 修复：每轮工具调用前检查中止状态，取消后不再执行剩余工具
    for (const tc of toolCalls) {
      if (effectiveSignal.aborted) throw new Error('Aborted')
      const name = tc.function?.name ?? tc.name ?? ''
      const argsStr = tc.function?.arguments ?? JSON.stringify(tc.args ?? {})
      let args: any = {}
      try { args = JSON.parse(argsStr) } catch { /* keep empty */ }

      const toolCallInfo = { id: tc.id, name, args }
      onToolCall(toolCallInfo)

      try {
        const serverInfo = mcpManager.findToolServer(name)
        if (!serverInfo) throw new Error(`工具 ${name} 未找到`)
        // 修复：工具调用加超时，防止 MCP 工具永久挂起阻塞整个对话流
        const mcpResult = await callToolWithTimeout(
          () => mcpManager.callTool(serverInfo.serverId, name, args),
          TOOL_CALL_TIMEOUT_MS,
        )
        const resultText = mcpResult.content
          .filter((c: any) => c.type === 'text')
          .map((c: any) => c.text)
          .join('\n')
        onToolResult({ id: tc.id, content: resultText, isError: mcpResult.isError ?? false })
        messages.push({
          role: 'tool',
          content: resultText,
          tool_call_id: tc.id,
          name,
        })
      } catch (err) {
        const errMsg = (err as Error).message
        onToolResult({ id: tc.id, content: `错误: ${errMsg}`, isError: true })
        messages.push({
          role: 'tool',
          content: `错误: ${errMsg}`,
          tool_call_id: tc.id,
          name,
        })
      }
    }
    // 继续下一轮
  }

  log.warn(`工具调用循环达到上限 ${MAX_TOOL_ROUNDS}`)
  return fullText
}
