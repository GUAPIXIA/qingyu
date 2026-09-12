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

    const lowerModel = model.toLowerCase()
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

    // DeepSeek V4 默认可能进入高强度思考。续写、润色、生图提示词等辅助请求
    // 只需要最终正文，显式关闭思考可避免推理内容占满输出预算或泄漏到业务结果。
    if (params.reasoningMode === 'disabled' && lowerModel.includes('deepseek-v4')) {
      body.thinking = { type: 'disabled' }
    }

    // C-03 修复：传递工具定义给 API
    if (params.tools && params.tools.length > 0) {
      body.tools = params.tools
      if (params.toolChoice) body.tool_choice = params.toolChoice
    }

    // L-01 修复：推理模型支持 — 用词边界正则避免误匹配（如 gpt-3.5-turbo-1106 含 "o1"）
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

    const sendRequest = () => fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    })

    let response = await sendRequest()
    if (!response.ok) {
      const errText = await response.text()
      // 聚合代理未必透传 DeepSeek 的 thinking 扩展参数。仅当 400 明确指出
      // thinking 不受支持时去掉该字段重试，避免吞掉其他真实请求错误。
      const thinkingUnsupported = response.status === 400
        && body.thinking !== undefined
        && /thinking/i.test(errText)
      if (thinkingUnsupported) {
        delete body.thinking
        response = await sendRequest()
      } else {
        throw new Error(`OpenAI API 错误 ${response.status}: ${sanitizeApiKey(errText)}${imageErrorHint(params.messages)}`)
      }
    }

    if (!response.ok) {
      const errText = await response.text()
      throw new Error(`OpenAI API 错误 ${response.status}: ${sanitizeApiKey(errText)}${imageErrorHint(params.messages)}`)
    }

    if (!stream) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data: any = await response.json()
      const choice = data.choices?.[0]
      const content = choice?.message?.content ?? ''
      // 处理推理模型思考内容：DeepSeek 系为 reasoning_content，OpenRouter 统一字段为 reasoning
      // 调用方明确关闭推理时，即使聚合端忽略 thinking 参数仍不把内部规划混入业务正文。
      const reasoning = params.reasoningMode === 'disabled'
        ? undefined
        : choice?.message?.reasoning_content
          ?? (typeof choice?.message?.reasoning === 'string' ? choice.message.reasoning : undefined)
      let fullContent = reasoning ? `<thought>${reasoning}</thought>\n\n${content}` : content
      // B-05 修复：归一化内容中可能含有的 <thinking> 标签
      fullContent = normalizeThoughtTags(fullContent)
      // 解析 usage（即使正文为空也记录，保留 token 消耗统计）
      if (onUsage && data.usage) {
        onUsage({
          promptTokens: data.usage.prompt_tokens ?? 0,
          completionTokens: data.usage.completion_tokens ?? 0,
          totalTokens: data.usage.total_tokens ?? 0,
        })
      }
      // C-03 修复：检测 tool_calls 并附加标记供 toolLoop 解析
      const toolCalls = choice?.message?.tool_calls
      if (toolCalls && toolCalls.length > 0) {
        onChunk(fullContent)
        return fullContent + '[TOOL_CALL:' + JSON.stringify(toolCalls) + ']'
      }
      if (!fullContent.trim()) {
        // 上游 200 但消息体为空（审核拦截 / 思考未透出 / 上游异常）：
        // 此前被静默当作成功，表现为“请求完成却是空内容”，现在显式报错。
        throw new Error(
          choice?.finish_reason === 'content_filter'
            ? '模型响应被上游内容审核拦截（content_filter），请调整对话内容或更换模型'
            : '模型未返回任何内容，请重试或检查模型是否可用',
        )
      }
      onChunk(fullContent)
      return fullContent
    }

    // 流式解析（修复 SSE 分隔符：使用更稳健的行解析）
    const reader = response.body?.getReader()
    if (!reader) throw new Error('无法读取响应流')
    const decoder = new TextDecoder()
    let fullText = ''
    let buffer = ''
    let pendingReasoning = ''
    // 流级观测：上游常把错误/审核结果塞进 SSE 事件体而不是 HTTP 状态码，
    // 此前被静默忽略，表现为“请求完成但内容全空”（长记忆/续写无内容）。
    const STREAM_ERROR_FLAG = '__openaiStreamError'
    let sawAnyDelta = false
    let finishReason: string | null = null
    // C-03 修复：收集流式 tool_calls delta
    // BUG-14 修复：key 不再默认 0——index 缺失时优先用 id 关联，再退化为自增键，避免互相覆盖
    const streamedToolCalls = new Map<string, { id: string; type: string; function: { name: string; arguments: string } }>()

    // BUG-29：解析单个 SSE 事件（多 data: 行已合并为 data）
    // 合并后的多行 JSON 解析失败时，回退逐行解析以兼容仅用 \n 分隔的非标准服务器
    const processOpenAIEvent = (rawData: string) => {
      const data = rawData.trim()
      if (!data || data === '[DONE]') return
      const handleParsed = (parsed: ReturnType<typeof JSON.parse>) => {
        // 流内错误事件（OpenRouter 等代理会把上游错误作为 data 事件下发）：必须透出
        if (parsed && typeof parsed === 'object' && parsed.error) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const raw: any = parsed.error
          const msg = typeof raw === 'string' ? raw : (raw?.message || JSON.stringify(raw))
          const err = new Error(`模型流式返回错误：${msg}`) as Error & Record<string, unknown>
          err[STREAM_ERROR_FLAG] = true
          throw err
        }
        // 解析 usage（最后 chunk）
        if (parsed.usage && onUsage) {
          onUsage({
            promptTokens: parsed.usage.prompt_tokens ?? 0,
            completionTokens: parsed.usage.completion_tokens ?? 0,
            totalTokens: parsed.usage.total_tokens ?? 0,
          })
        }
        const choice = parsed.choices?.[0]
        if (choice?.finish_reason) finishReason = choice.finish_reason
        const delta = choice?.delta
        if (!delta) return

        // 处理推理内容：DeepSeek-R1 / Qwen-QwQ 为 reasoning_content，OpenRouter 统一字段为 reasoning
        const reasoningDelta = params.reasoningMode === 'disabled'
          ? undefined
          : delta.reasoning_content
            ?? (typeof delta.reasoning === 'string' ? delta.reasoning : undefined)
        if (reasoningDelta) {
          sawAnyDelta = true
          if (!pendingReasoning) {
            pendingReasoning = '<thought>'
          }
          pendingReasoning += reasoningDelta
        }

        // 正常内容
        if (delta.content) {
          sawAnyDelta = true
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
      } catch (err) {
        // 流内错误必须中止整个解析；其余解析失败才走逐行回退
        if ((err as Error & Record<string, unknown>)?.[STREAM_ERROR_FLAG]) throw err
        for (const line of data.split('\n')) {
          try { handleParsed(JSON.parse(line)) }
          catch (inner) {
            if ((inner as Error & Record<string, unknown>)?.[STREAM_ERROR_FLAG]) throw inner
            /* 忽略解析错误（可能是注释行或心跳） */
          }
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

    // 零输出防御：流正常结束但没有任何 content/推理增量（流内错误已在上方抛出，
    // 剩下的是审核拦截、上游异常提前终止等）。此前按“成功但空内容”静默返回，
    // 长记忆/续写表现为“完成却无内容”，现在转为明确错误供上层展示真实原因。
    if (!sawAnyDelta && streamedToolCalls.size === 0) {
      throw new Error(
        finishReason === 'content_filter'
          ? '模型响应被上游内容审核拦截（content_filter），请调整对话内容或更换模型'
          : '模型未返回任何内容，请重试或检查模型是否可用',
      )
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
