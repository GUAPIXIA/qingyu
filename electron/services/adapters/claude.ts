import type { AIAdapter } from './types'
import { normalizeThoughtTags } from './types'
import { sanitizeApiKey } from '../../utils/pathGuard'

export const claudeAdapter: AIAdapter = {
  async chat(params, onChunk, signal, onUsage) {
    const { baseUrl, apiKey, model, messages, temperature, topP, maxTokens, stream } = params
    const url = `${baseUrl.replace(/\/$/, '')}/v1/messages`

    // Claude 要求 system 单独传
    const systemMsg = messages.find((m) => m.role === 'system')
    const chatMessages = messages.filter((m) => m.role !== 'system')

    const body: Record<string, unknown> = {
      model,
      max_tokens: maxTokens || 4096,
      temperature,
      top_p: topP,
      messages: chatMessages,
      stream,
    }
    if (systemMsg) body.system = systemMsg.content

    // C-03 修复：转换 OpenAI 格式 tools 为 Claude 格式
    if (params.tools && params.tools.length > 0) {
      body.tools = params.tools.map(t => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters,
      }))
      // BUG-13 修复：tool_choice 转换
      if (params.toolChoice) {
        if (typeof params.toolChoice === 'string') {
          if (params.toolChoice === 'none') {
            // Claude 不支持 'none'：移除 tools 字段等价于禁用工具调用
            delete body.tools
          } else {
            body.tool_choice = params.toolChoice === 'required' ? { type: 'any' } : { type: 'auto' }
          }
        } else if (params.toolChoice.function?.name) {
          // 对象格式但 name 为空时不发送 tool_choice（避免 { type: 'tool', name: '' } 报错）
          body.tool_choice = { type: 'tool', name: params.toolChoice.function.name }
        }
      }
    }

    // Claude 3.7 / Claude 4 扩展思考支持
    const lowerModel = model.toLowerCase()
    if ((lowerModel.includes('claude-3-7') || lowerModel.includes('claude-4') ||
         lowerModel.includes('claude-3.7')) && !lowerModel.includes('haiku')) {
      // 思考预算为 max_tokens 的 1/3，最低 1024
      const thinkingBudget = Math.max(1024, Math.floor((maxTokens || 4096) / 3))
      body.thinking = { type: 'enabled', budget_tokens: thinkingBudget }
      // 启用思考时 temperature 必须为 1
      body.temperature = 1
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        // API 版本（可定期更新）
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify(body),
      signal,
    })

    if (!response.ok) {
      const errText = await response.text()
      throw new Error(`Claude API 错误 ${response.status}: ${sanitizeApiKey(errText)}`)
    }

    if (!stream) {
      const data: { content?: { type: string; thinking?: string; text?: string; input?: unknown; name?: string; id?: string }[] } = await response.json()
      // Claude 返回 content 数组，可能有 thinking / text / tool_use 三种类型
      const parts = data.content ?? []
      let thinking = ''
      let text = ''
      const rawToolCalls: { name?: string; input?: unknown; id?: string }[] = []
      for (const part of parts) {
        if (part.type === 'thinking') thinking += part.thinking
        else if (part.type === 'text') text += part.text
        else if (part.type === 'tool_use') {
          rawToolCalls.push({
            id: part.id,
            type: 'function',
            function: { name: part.name, arguments: JSON.stringify(part.input) },
          })
        }
      }
      const content = thinking ? `<thought>${thinking}</thought>\n\n${text}` : text
      onChunk(content)
      if (onUsage && data.usage) {
        onUsage({
          promptTokens: data.usage.input_tokens ?? 0,
          completionTokens: data.usage.output_tokens ?? 0,
          totalTokens: (data.usage.input_tokens ?? 0) + (data.usage.output_tokens ?? 0),
        })
      }
      // C-03 修复：如有 tool_use，附加标记供 toolLoop 解析
      if (rawToolCalls.length > 0) {
        return normalizeThoughtTags(content) + '[TOOL_CALL:' + JSON.stringify(rawToolCalls) + ']'
      }
      return normalizeThoughtTags(content)
    }

    const reader = response.body?.getReader()
    if (!reader) throw new Error('无法读取响应流')
    const decoder = new TextDecoder()
    let fullText = ''
    let buffer = ''
    let pendingThought = ''
    let claudeInputTokens = 0
    let claudeOutputTokens = 0
    // C-03 修复：收集流式 tool_use delta
    const streamedToolCalls = new Map<number, { id: string; type: string; function: { name: string; arguments: string } }>()

    // BUG-29：解析单个 SSE 事件（多 data: 行已合并为 data）
    // 合并后的多行 JSON 解析失败时，回退逐行解析以兼容仅用 \n 分隔的非标准服务器
    const processClaudeEvent = (rawData: string) => {
      const data = rawData.trim()
      if (!data) return
      const handleParsed = (parsed: ReturnType<typeof JSON.parse>) => {
        // message_start 事件含 input_tokens
        if (parsed.type === 'message_start' && parsed.message?.usage) {
          claudeInputTokens = parsed.message.usage.input_tokens ?? 0
        }
        // thinking / tool_use 块开始
        else if (parsed.type === 'content_block_start') {
          if (parsed.content_block?.type === 'thinking') {
            pendingThought = '<thought>'
          } else if (parsed.content_block?.type === 'tool_use') {
            const idx = parsed.index ?? 0
            streamedToolCalls.set(idx, {
              id: parsed.content_block.id || '',
              type: 'function',
              function: { name: parsed.content_block.name || '', arguments: '' },
            })
          }
        } else if (parsed.type === 'content_block_delta') {
          // thinking delta
          if (parsed.delta?.type === 'thinking_delta' && parsed.delta.thinking) {
            pendingThought += parsed.delta.thinking
          }
          // 文本 delta
          else if (parsed.delta?.type === 'text_delta' && parsed.delta.text) {
            if (pendingThought) {
              pendingThought += '</thought>\n\n'
              fullText += pendingThought
              onChunk(pendingThought)
              pendingThought = ''
            }
            fullText += parsed.delta.text
            onChunk(parsed.delta.text)
          }
          // C-03 修复：tool_use input_json delta
          else if (parsed.delta?.type === 'input_json_delta' && parsed.delta.partial_json) {
            const idx = parsed.index ?? 0
            const existing = streamedToolCalls.get(idx)
            if (existing) existing.function.arguments += parsed.delta.partial_json
          }
        } else if (parsed.type === 'content_block_stop' && pendingThought) {
          pendingThought += '</thought>\n\n'
          fullText += pendingThought
          onChunk(pendingThought)
          pendingThought = ''
        }
        // message_delta 事件含 output_tokens，是最后一个事件
        else if (parsed.type === 'message_delta' && parsed.usage) {
          claudeOutputTokens = parsed.usage.output_tokens ?? 0
          if (onUsage) {
            onUsage({
              promptTokens: claudeInputTokens,
              completionTokens: claudeOutputTokens,
              totalTokens: claudeInputTokens + claudeOutputTokens,
            })
          }
        }
      }
      try {
        handleParsed(JSON.parse(data))
      } catch {
        for (const line of data.split('\n')) {
          try { handleParsed(JSON.parse(line)) } catch { /* 忽略 */ }
        }
      }
    }

    try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      // BUG-29 修复：按 SSE 事件（空行分隔）解析，事件内多行 data: 合并后再解析；
      // 合并失败时回退逐行解析，兼容仅用 \n 分隔的非标准服务器
      const events = buffer.split(/\r?\n\r?\n/)
      buffer = events.pop() ?? ''
      for (const event of events) {
        const dataLines = event.split(/\r?\n/).filter(l => l.trim().startsWith('data:'))
        if (dataLines.length === 0) continue
        processClaudeEvent(dataLines.map(l => l.trim().slice(5).trim()).join('\n'))
      }
    }
    // 处理剩余 buffer
    if (buffer.trim()) {
      const dataLines = buffer.split(/\r?\n/).filter(l => l.trim().startsWith('data:'))
      if (dataLines.length > 0) {
        processClaudeEvent(dataLines.map(l => l.trim().slice(5).trim()).join('\n'))
      }
    }
    // 处理剩余 pending
    if (pendingThought) {
      pendingThought += '</thought>\n\n'
      fullText += pendingThought
      onChunk(pendingThought)
    }
    } finally {
      try { reader.releaseLock() } catch { /* ignore */ }
    }
    // C-03 修复：如有 tool_use，附加标记供 toolLoop 解析
    if (streamedToolCalls.size > 0) {
      const toolCallsArray = Array.from(streamedToolCalls.values())
      return normalizeThoughtTags(fullText) + '[TOOL_CALL:' + JSON.stringify(toolCallsArray) + ']'
    }
    return normalizeThoughtTags(fullText)
  },

  async listModels(baseUrl, apiKey) {
    const url = `${baseUrl.replace(/\/$/, '')}/v1/models`
    const response = await fetch(url, {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
    })
    if (!response.ok) throw new Error(`获取模型列表失败: ${response.status}`)
    const data: { data?: { id: string }[] } = await response.json()
    return (data.data ?? []).map((m: { id: string }) => m.id)
  },

  async testConnection(baseUrl, apiKey) {
    try {
      await this.listModels(baseUrl, apiKey)
      return true
    } catch {
      return false
    }
  },
}
