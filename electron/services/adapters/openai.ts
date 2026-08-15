import type { AIAdapter } from './types'
import { normalizeThoughtTags } from './types'
import { sanitizeApiKey } from '../../utils/pathGuard'
import { toOpenAIContent, imageErrorHint } from './vision'

export const openaiAdapter: AIAdapter = {
  async chat(params, onChunk, signal, onUsage) {
    const { baseUrl, apiKey, model, temperature, topP, maxTokens,
            frequencyPenalty, presencePenalty, stream } = params
    const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`

    // Vision：带图片的消息转换为 content 数组格式（无图片消息保持字符串，兼容非视觉服务）
    const messages = toOpenAIContent(params.messages)

    const body: Record<string, unknown> = {
      model,
      messages,
      temperature,
      top_p: topP,
      max_tokens: maxTokens,
      frequency_penalty: frequencyPenalty,
      presence_penalty: presencePenalty,
      stream,
    }

    // C-03 修复：传递工具定义给 API
    if (params.tools && params.tools.length > 0) {
      body.tools = params.tools
      if (params.toolChoice) body.tool_choice = params.toolChoice
    }

    // L-01 修复：推理模型支持 — 用词边界正则避免误匹配（如 gpt-3.5-turbo-1106 含 "o1"）
    const lowerModel = model.toLowerCase()
    if (/\bo[134](?:-mini)?\b/.test(lowerModel) || lowerModel.includes('deepseek-r1')) {
      // OpenAI o 系列不支持 temperature/top_p 等参数
      delete body.temperature
      delete body.top_p
      delete body.frequency_penalty
      delete body.presence_penalty
      body.reasoning_effort = 'medium'
    }

    // OpenCode Go 上游约束：kimi-k3 采样参数固定（temperature 仅允许 1、top_p 仅允许 0.95），
    // 不修正会直接 400（invalid temperature / invalid top_p），已全量实测确认
    if (model === 'kimi-k3' || model.endsWith('/kimi-k3')) {
      body.temperature = 1
      body.top_p = 0.95
    }

    // 流式请求时请求 usage 信息
    if (stream) {
      body.stream_options = { include_usage: true }
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    })

    if (!response.ok) {
      const errText = await response.text()
      throw new Error(`OpenAI API 错误 ${response.status}: ${sanitizeApiKey(errText)}${imageErrorHint(params.messages)}`)
    }

    if (!stream) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data: any = await response.json()
      const content = data.choices?.[0]?.message?.content ?? ''
      // 处理推理模型的 reasoning_content（DeepSeek-R1 等）
      const reasoning = data.choices?.[0]?.message?.reasoning_content
      let fullContent = reasoning ? `<thought>${reasoning}</thought>\n\n${content}` : content
      // B-05 修复：归一化内容中可能含有的 <thinking> 标签
      fullContent = normalizeThoughtTags(fullContent)
      onChunk(fullContent)
      // 解析 usage
      if (onUsage && data.usage) {
        onUsage({
          promptTokens: data.usage.prompt_tokens ?? 0,
          completionTokens: data.usage.completion_tokens ?? 0,
          totalTokens: data.usage.total_tokens ?? 0,
        })
      }
      // C-03 修复：检测 tool_calls 并附加标记供 toolLoop 解析
      const toolCalls = data.choices?.[0]?.message?.tool_calls
      if (toolCalls && toolCalls.length > 0) {
        return fullContent + '[TOOL_CALL:' + JSON.stringify(toolCalls) + ']'
      }
      return fullContent
    }

    // 流式解析（修复 SSE 分隔符：使用更稳健的行解析）
    const reader = response.body?.getReader()
    if (!reader) throw new Error('无法读取响应流')
    const decoder = new TextDecoder()
    let fullText = ''
    let buffer = ''
    let pendingReasoning = ''
    // C-03 修复：收集流式 tool_calls delta
    // BUG-14 修复：key 不再默认 0——index 缺失时优先用 id 关联，再退化为自增键，避免互相覆盖
    const streamedToolCalls = new Map<string, { id: string; type: string; function: { name: string; arguments: string } }>()

    // BUG-29：解析单个 SSE 事件（多 data: 行已合并为 data）
    // 合并后的多行 JSON 解析失败时，回退逐行解析以兼容仅用 \n 分隔的非标准服务器
    const processOpenAIEvent = (rawData: string) => {
      const data = rawData.trim()
      if (!data || data === '[DONE]') return
      const handleParsed = (parsed: ReturnType<typeof JSON.parse>) => {
        // 解析 usage（最后 chunk）
        if (parsed.usage && onUsage) {
          onUsage({
            promptTokens: parsed.usage.prompt_tokens ?? 0,
            completionTokens: parsed.usage.completion_tokens ?? 0,
            totalTokens: parsed.usage.total_tokens ?? 0,
          })
        }
        const delta = parsed.choices?.[0]?.delta
        if (!delta) return

        // 处理推理内容（DeepSeek-R1, Qwen-QwQ 等）
        if (delta.reasoning_content) {
          if (!pendingReasoning) {
            pendingReasoning = '<thought>'
          }
          pendingReasoning += delta.reasoning_content
        }

        // 正常内容
        if (delta.content) {
          // 如果之前有推理内容未闭合，先闭合
          if (pendingReasoning) {
            pendingReasoning += '</thought>\n\n'
            fullText += pendingReasoning
            onChunk(pendingReasoning)
            pendingReasoning = ''
          }
          fullText += delta.content
          onChunk(delta.content)
        }

        // C-03 修复：收集流式 tool_calls delta
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            // BUG-14：index 缺失时优先用 id 关联同一 tool call，再退化为自增键
            let key: string
            if (tc.index !== undefined) {
              key = String(tc.index)
            } else if (tc.id) {
              // M-4 修复：无 index 时统一用 id 关联（此前先查"id 已存在"再退化为 n:size，
              // 同一 tool call 的后续 chunk 因 size 增长生成新键，被拆散成多个残缺条目）
              key = `id:${tc.id}`
            } else {
              key = `n:${streamedToolCalls.size}`
            }
            if (!streamedToolCalls.has(key)) {
              streamedToolCalls.set(key, { id: tc.id || '', type: 'function', function: { name: '', arguments: '' } })
            }
            const existing = streamedToolCalls.get(key)!
            if (tc.id) existing.id = tc.id
            // name 取首次出现（兼容每 chunk 重复发送完整 name 的实现，避免重复拼接）
            if (tc.function?.name && !existing.function.name) existing.function.name = tc.function.name
            if (tc.function?.arguments) existing.function.arguments += tc.function.arguments
          }
        }
      }
      try {
        handleParsed(JSON.parse(data))
      } catch {
        for (const line of data.split('\n')) {
          try { handleParsed(JSON.parse(line)) } catch { /* 忽略解析错误（可能是注释行或心跳） */ }
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
        processOpenAIEvent(dataLines.map(l => l.trim().slice(5).trim()).join('\n'))
      }
    }

    // 处理流结束时仍 pending 的推理内容
    if (pendingReasoning) {
      pendingReasoning += '</thought>\n\n'
      fullText += pendingReasoning
      onChunk(pendingReasoning)
    }
    // 处理剩余 buffer
    if (buffer.trim()) {
      const dataLines = buffer.split(/\r?\n/).filter(l => l.trim().startsWith('data:'))
      if (dataLines.length > 0) {
        processOpenAIEvent(dataLines.map(l => l.trim().slice(5).trim()).join('\n'))
      }
    }
    } finally {
      try { reader.releaseLock() } catch { /* ignore */ }
    }

    // C-03 修复：如有 tool_calls，附加标记供 toolLoop 解析
    if (streamedToolCalls.size > 0) {
      const toolCallsArray = Array.from(streamedToolCalls.values())
      return normalizeThoughtTags(fullText) + '[TOOL_CALL:' + JSON.stringify(toolCallsArray) + ']'
    }
    return normalizeThoughtTags(fullText)
  },

  async listModels(baseUrl, apiKey) {
    const url = `${baseUrl.replace(/\/$/, '')}/models`
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    if (!response.ok) throw new Error(`获取模型列表失败: ${response.status}`)
    const data = (await response.json()) as { data?: { id: string }[] }
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
