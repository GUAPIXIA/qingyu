/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars */
import type { IpcMain, WebContents } from 'electron'
import type { ChatParams, ProviderType } from '../../shared/types'
import { countTokens, countMessagesTokens } from './tokenizer'
import { createLogger } from './logger'
import { chatWithTools } from './toolLoop'
import { safeSend } from '../utils/safeSend'

import { sanitizeApiKey } from '../utils/pathGuard'

const log = createLogger('ai')

/** 默认请求超时时间（毫秒）- 5 分钟 */
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000

/** 默认重试次数 */
const DEFAULT_RETRY_COUNT = 1

/** 可重试的 HTTP 状态码 */
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504])

interface AIAdapter {
  chat(
    params: ChatParams,
    onChunk: (text: string) => void,
    signal: AbortSignal,
    onUsage?: (usage: { promptTokens: number; completionTokens: number; totalTokens: number }) => void,
  ): Promise<string>
  listModels(baseUrl: string, apiKey: string): Promise<string[]>
  testConnection(baseUrl: string, apiKey: string): Promise<boolean>
}

/** Token 用量信息 */
export interface TokenUsageInfo {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

// ===================== 工具函数 =====================

/** 合并用户 signal 与超时 signal */
function withTimeout(signal: AbortSignal, timeoutMs: number): AbortSignal {
  // 如果用户 signal 已经 abort，直接返回
  if (signal.aborted) return signal
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs)
  // 用户取消时同步取消
  signal.addEventListener('abort', () => {
    clearTimeout(timer)
    controller.abort(signal.reason)
  }, { once: true })
  // 超时后取消
  controller.signal.addEventListener('abort', () => {
    clearTimeout(timer)
  }, { once: true })
  return controller.signal
}

/** 判断错误是否可重试 */
function isRetryableError(err: unknown): boolean {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase()
    // 网络错误、超时、5xx、429 都可重试
    if (msg.includes('timeout') || msg.includes('aborted')) return true
    if (msg.includes('network') || msg.includes('fetch failed')) return true
    if (msg.includes('econnrefused') || msg.includes('econnreset')) return true
    for (const code of RETRYABLE_STATUS) {
      if (msg.includes(`${code}`)) return true
    }
  }
  return false
}

// ===================== OpenAI 兼容适配器 =====================
const openaiAdapter: AIAdapter = {
  async chat(params, onChunk, signal, onUsage) {
    const { baseUrl, apiKey, model, messages, temperature, topP, maxTokens,
            frequencyPenalty, presencePenalty, stream } = params
    const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`

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
      throw new Error(`OpenAI API 错误 ${response.status}: ${sanitizeApiKey(errText)}`)
    }

    if (!stream) {
      const data: any = await response.json()
      const content = data.choices?.[0]?.message?.content ?? ''
      // 处理推理模型的 reasoning_content（DeepSeek-R1 等）
      const reasoning = data.choices?.[0]?.message?.reasoning_content
      const fullContent = reasoning ? `<thought>${reasoning}</thought>\n\n${content}` : content
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
    const streamedToolCalls = new Map<number, { id: string; type: string; function: { name: string; arguments: string } }>()

    try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      // SSE 事件以 \n\n 分隔，但兼容只用 \n 的服务器
      // 按行解析，处理跨 chunk 的 data: 行
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        if (!trimmed.startsWith('data:')) continue
        const data = trimmed.slice(5).trim()
        if (data === '[DONE]') continue
        try {
          const parsed = JSON.parse(data)
          // 解析 usage（最后 chunk）
          if (parsed.usage && onUsage) {
            onUsage({
              promptTokens: parsed.usage.prompt_tokens ?? 0,
              completionTokens: parsed.usage.completion_tokens ?? 0,
              totalTokens: parsed.usage.total_tokens ?? 0,
            })
          }
          const delta = parsed.choices?.[0]?.delta
          if (!delta) continue

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
              const idx = tc.index ?? 0
              if (!streamedToolCalls.has(idx)) {
                streamedToolCalls.set(idx, { id: tc.id || '', type: 'function', function: { name: '', arguments: '' } })
              }
              const existing = streamedToolCalls.get(idx)!
              if (tc.id) existing.id = tc.id
              if (tc.function?.name) existing.function.name += tc.function.name
              if (tc.function?.arguments) existing.function.arguments += tc.function.arguments
            }
          }
        } catch {
          // 忽略解析错误（可能是注释行或心跳）
        }
      }
    }

    // 处理流结束时仍 pending 的推理内容
    if (pendingReasoning) {
      pendingReasoning += '</thought>\n\n'
      fullText += pendingReasoning
      onChunk(pendingReasoning)
    }
    } finally {
      try { reader.releaseLock() } catch { /* ignore */ }
    }

    // C-03 修复：如有 tool_calls，附加标记供 toolLoop 解析
    if (streamedToolCalls.size > 0) {
      const toolCallsArray = Array.from(streamedToolCalls.values())
      return fullText + '[TOOL_CALL:' + JSON.stringify(toolCallsArray) + ']'
    }
    return fullText
  },

  async listModels(baseUrl, apiKey) {
    const url = `${baseUrl.replace(/\/$/, '')}/models`
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    if (!response.ok) throw new Error(`获取模型列表失败: ${response.status}`)
    const data: any = await response.json()
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

// ===================== Claude 适配器 =====================
const claudeAdapter: AIAdapter = {
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
      // tool_choice 转换
      if (params.toolChoice) {
        if (typeof params.toolChoice === 'string') {
          body.tool_choice = params.toolChoice === 'required' ? { type: 'any' } : { type: 'auto' }
        } else {
          body.tool_choice = { type: 'tool', name: params.toolChoice.function?.name || '' }
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
      const data: any = await response.json()
      // Claude 返回 content 数组，可能有 thinking / text / tool_use 三种类型
      const parts = data.content ?? []
      let thinking = ''
      let text = ''
      const rawToolCalls: any[] = []
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
        return content + '[TOOL_CALL:' + JSON.stringify(rawToolCalls) + ']'
      }
      return content
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

    try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        const data = trimmed.slice(5).trim()
        if (!data) continue
        try {
          const parsed = JSON.parse(data)
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
        } catch {
          // 忽略
        }
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
      return fullText + '[TOOL_CALL:' + JSON.stringify(toolCallsArray) + ']'
    }
    return fullText
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
    const data: any = await response.json()
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

// ===================== Gemini 适配器 =====================
const geminiAdapter: AIAdapter = {
  async chat(params, onChunk, signal, onUsage) {
    const { baseUrl, apiKey, model, messages, temperature, topP,
            maxTokens, frequencyPenalty, presencePenalty, stream } = params
    const action = stream ? 'streamGenerateContent' : 'generateContent'
    const url = `${baseUrl.replace(/\/$/, '')}/v1beta/models/${model}:${action}${stream ? '?alt=sse' : ''}`

    // 转换为 Gemini 格式
    const systemMsg = messages.find((m) => m.role === 'system')
    const contents = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      }))

    const generationConfig: Record<string, unknown> = {
      temperature,
      topP,
      maxOutputTokens: maxTokens,
    }
    // 修复 #7: Gemini 支持 frequencyPenalty 和 presencePenalty
    if (frequencyPenalty !== undefined && frequencyPenalty !== 0) {
      generationConfig.frequencyPenalty = frequencyPenalty
    }
    if (presencePenalty !== undefined && presencePenalty !== 0) {
      generationConfig.presencePenalty = presencePenalty
    }

    const body: Record<string, unknown> = {
      contents,
      generationConfig,
    }
    if (systemMsg) {
      body.systemInstruction = { parts: [{ text: systemMsg.content }] }
    }

    // C-03 修复：转换 OpenAI 格式 tools 为 Gemini functionDeclarations 格式
    if (params.tools && params.tools.length > 0) {
      body.tools = [{
        functionDeclarations: params.tools.map(t => ({
          name: t.function.name,
          description: t.function.description,
          parameters: t.function.parameters,
        })),
      }]
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
      signal,
    })

    if (!response.ok) {
      const errText = await response.text()
      throw new Error(`Gemini API 错误 ${response.status}`)
    }

    if (!stream) {
      const data: any = await response.json()
      const parts = data.candidates?.[0]?.content?.parts ?? []
      let text = ''
      const rawToolCalls: any[] = []
      for (const part of parts) {
        if (part.text) text += part.text
        else if (part.functionCall) {
          rawToolCalls.push({
            id: `gemini-${Date.now()}-${rawToolCalls.length}`,
            type: 'function',
            function: { name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args || {}) },
          })
        }
      }
      onChunk(text)
      if (onUsage && data.usageMetadata) {
        onUsage({
          promptTokens: data.usageMetadata.promptTokenCount ?? 0,
          completionTokens: data.usageMetadata.candidatesTokenCount ?? 0,
          totalTokens: data.usageMetadata.totalTokenCount ?? 0,
        })
      }
      // C-03 修复：如有 functionCall，附加标记供 toolLoop 解析
      if (rawToolCalls.length > 0) {
        return text + '[TOOL_CALL:' + JSON.stringify(rawToolCalls) + ']'
      }
      return text
    }

    // 修复 #38: 改进的 Gemini 流式解析
    // Gemini 使用 SSE 时格式与 OpenAI 类似（data: {...}）
    const reader = response.body?.getReader()
    if (!reader) throw new Error('无法读取响应流')
    const decoder = new TextDecoder()
    let fullText = ''
    let buffer = ''

    // 优先按 SSE 格式解析（alt=sse 时）
    const isSSE = response.headers.get('content-type')?.includes('text/event-stream')
    // C-03 修复：收集流式 functionCall
    const geminiFnCalls = new Map<string, { id: string; type: string; function: { name: string; arguments: string } }>()

    try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      if (isSSE) {
        // SSE 格式：按 \n\n 分隔事件，每事件有 data: 行
        const events = buffer.split('\n\n')
        buffer = events.pop() ?? ''
        for (const event of events) {
          const dataLines = event.split('\n').filter(l => l.startsWith('data:'))
          for (const line of dataLines) {
            const data = line.slice(5).trim()
            if (!data) continue
            try {
              const parsed = JSON.parse(data)
              const parts = parsed.candidates?.[0]?.content?.parts ?? []
              for (const part of parts) {
                if (part.text) {
                  fullText += part.text
                  onChunk(part.text)
                } else if (part.functionCall) {
                  const fn = part.functionCall
                  const idx = fn.name || geminiFnCalls.size.toString()
                  geminiFnCalls.set(idx, {
                    id: `gemini-${Date.now()}-${geminiFnCalls.size}`,
                    type: 'function',
                    function: { name: fn.name || '', arguments: JSON.stringify(fn.args || {}) },
                  })
                }
              }
              // 解析 usage（每个 chunk 都可能含 usageMetadata，取最后一次）
              if (parsed.usageMetadata && onUsage) {
                onUsage({
                  promptTokens: parsed.usageMetadata.promptTokenCount ?? 0,
                  completionTokens: parsed.usageMetadata.candidatesTokenCount ?? 0,
                  totalTokens: parsed.usageMetadata.totalTokenCount ?? 0,
                })
              }
            } catch { /* 忽略 */ }
          }
        }
      } else {
        // 非 SSE：Gemini 返回 JSON 数组片段，需要更稳健的解析
        // 尝试逐个解析 JSON 对象
        const parseResult = extractGeminiJsonObjects(buffer)
        buffer = parseResult.remaining
        for (const obj of parseResult.objects) {
          const parts = obj.candidates?.[0]?.content?.parts ?? []
          for (const part of parts) {
            if (part.text) {
              fullText += part.text
              onChunk(part.text)
            } else if (part.functionCall) {
              const fn = part.functionCall
              const idx = fn.name || geminiFnCalls.size.toString()
              geminiFnCalls.set(idx, {
                id: `gemini-${Date.now()}-${geminiFnCalls.size}`,
                type: 'function',
                function: { name: fn.name || '', arguments: JSON.stringify(fn.args || {}) },
              })
            }
          }
          // 解析 usage（取最后一次）
          if (obj.usageMetadata && onUsage) {
            onUsage({
              promptTokens: obj.usageMetadata.promptTokenCount ?? 0,
              completionTokens: obj.usageMetadata.candidatesTokenCount ?? 0,
              totalTokens: obj.usageMetadata.totalTokenCount ?? 0,
            })
          }
        }
      }
    }

    // 处理剩余 buffer
    if (buffer.trim()) {
      const parseResult = extractGeminiJsonObjects(buffer)
      for (const obj of parseResult.objects) {
        const parts = obj.candidates?.[0]?.content?.parts ?? []
        for (const part of parts) {
          if (part.text) {
            fullText += part.text
            onChunk(part.text)
          } else if (part.functionCall) {
            const fn = part.functionCall
            const idx = fn.name || geminiFnCalls.size.toString()
            geminiFnCalls.set(idx, {
              id: `gemini-${Date.now()}-${geminiFnCalls.size}`,
              type: 'function',
              function: { name: fn.name || '', arguments: JSON.stringify(fn.args || {}) },
            })
          }
        }
        // 解析 usage（取最后一次）
        if (obj.usageMetadata && onUsage) {
          onUsage({
            promptTokens: obj.usageMetadata.promptTokenCount ?? 0,
            completionTokens: obj.usageMetadata.candidatesTokenCount ?? 0,
            totalTokens: obj.usageMetadata.totalTokenCount ?? 0,
          })
        }
      }
    }
    } finally {
      try { reader.releaseLock() } catch { /* ignore */ }
    }
    // C-03 修复：如有 functionCall，附加标记供 toolLoop 解析
    if (geminiFnCalls.size > 0) {
      const toolCallsArray = Array.from(geminiFnCalls.values())
      return fullText + '[TOOL_CALL:' + JSON.stringify(toolCallsArray) + ']'
    }
    return fullText
  },

  async listModels(baseUrl, apiKey) {
    const url = `${baseUrl.replace(/\/$/, '')}/v1beta/models`
    const response = await fetch(url)
    if (!response.ok) throw new Error(`获取模型列表失败: ${response.status}`)
    const data: any = await response.json()
    return (data.models ?? [])
      .filter((m: { supportedGenerationMethods?: string[] }) =>
        m.supportedGenerationMethods?.includes('generateContent')
      )
      .map((m: { name: string }) => m.name.replace('models/', ''))
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

/** 从 Gemini 非 SSE 流中提取完整 JSON 对象（修复 JSON 数组片段解析） */
function extractGeminiJsonObjects(buffer: string): { objects: any[]; remaining: string } {
  const objects: any[] = []
  let remaining = buffer
  // Gemini 流式返回是 JSON 对象数组，形如 [{...},{...},...
  // 我们逐字符扫描，匹配 { 和 } 来提取完整对象
  let depth = 0
  let start = -1
  let inString = false
  let escape = false

  for (let i = 0; i < remaining.length; i++) {
    const ch = remaining[i]
    if (escape) {
      escape = false
      continue
    }
    if (ch === '\\' && inString) {
      escape = true
      continue
    }
    if (ch === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (ch === '{') {
      if (depth === 0) start = i
      depth++
    } else if (ch === '}') {
      depth--
      if (depth === 0 && start >= 0) {
        const objStr = remaining.slice(start, i + 1)
        try {
          objects.push(JSON.parse(objStr))
        } catch { /* 忽略解析失败的对象 */ }
        remaining = remaining.slice(i + 1)
        // 重置扫描位置
        i = -1
        start = -1
      }
    }
  }
  return { objects, remaining }
}

// ===================== Ollama 适配器 =====================
const ollamaAdapter: AIAdapter = {
  async chat(params, onChunk, signal, onUsage) {
    const { baseUrl, model, messages, temperature, topP, maxTokens,
            frequencyPenalty, presencePenalty, stream } = params
    const url = `${baseUrl.replace(/\/$/, '')}/api/chat`

    // 修复 #6: 补全采样参数
    const options: Record<string, unknown> = {
      temperature,
      top_p: topP,
    }
    if (maxTokens && maxTokens > 0) options.num_predict = maxTokens
    if (frequencyPenalty !== undefined) options.frequency_penalty = frequencyPenalty
    if (presencePenalty !== undefined) options.presence_penalty = presencePenalty

    const body: Record<string, unknown> = {
      model,
      messages,
      options,
      stream,
    }

    // C-03 修复：Ollama 原生支持 OpenAI 格式 tools
    if (params.tools && params.tools.length > 0) {
      body.tools = params.tools
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    })

    if (!response.ok) {
      const errText = await response.text()
      throw new Error(`Ollama API 错误 ${response.status}: ${errText}`)
    }

    if (!stream) {
      const data: any = await response.json()
      const content = data.message?.content ?? ''
      onChunk(content)
      if (onUsage) {
        onUsage({
          promptTokens: data.prompt_eval_count ?? 0,
          completionTokens: data.eval_count ?? 0,
          totalTokens: (data.prompt_eval_count ?? 0) + (data.eval_count ?? 0),
        })
      }
      // C-03 修复：如有 tool_calls，附加标记供 toolLoop 解析
      const toolCalls = data.message?.tool_calls
      if (toolCalls && toolCalls.length > 0) {
        return content + '[TOOL_CALL:' + JSON.stringify(toolCalls) + ']'
      }
      return content
    }

    const reader = response.body?.getReader()
    if (!reader) throw new Error('无法读取响应流')
    const decoder = new TextDecoder()
    let fullText = ''
    let buffer = ''
    // C-03 修复：收集流式 tool_calls
    let streamedToolCalls: any[] | null = null

    try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const parsed = JSON.parse(line)
          const delta = parsed.message?.content ?? ''
          if (delta) {
            fullText += delta
            onChunk(delta)
          }
          // C-03 修复：收集 tool_calls
          if (parsed.message?.tool_calls) {
            streamedToolCalls = parsed.message.tool_calls
          }
          // 最后一条消息（done: true）含统计信息
          if (parsed.done && parsed.eval_count !== undefined && onUsage) {
            onUsage({
              promptTokens: parsed.prompt_eval_count ?? 0,
              completionTokens: parsed.eval_count ?? 0,
              totalTokens: (parsed.prompt_eval_count ?? 0) + (parsed.eval_count ?? 0),
            })
          }
        } catch {
          // 忽略
        }
      }
    }
    } finally {
      try { reader.releaseLock() } catch { /* ignore */ }
    }
    // C-03 修复：如有 tool_calls，附加标记供 toolLoop 解析
    if (streamedToolCalls && streamedToolCalls.length > 0) {
      return fullText + '[TOOL_CALL:' + JSON.stringify(streamedToolCalls) + ']'
    }
    return fullText
  },

  async listModels(baseUrl, _apiKey) {
    const url = `${baseUrl.replace(/\/$/, '')}/api/tags`
    const response = await fetch(url)
    if (!response.ok) throw new Error(`获取模型列表失败: ${response.status}`)
    const data: any = await response.json()
    return (data.models ?? []).map((m: { name: string }) => m.name)
  },

  async testConnection(baseUrl, _apiKey) {
    try {
      await this.listModels(baseUrl, '')
      return true
    } catch {
      return false
    }
  },
}

// ===================== 适配器工厂 =====================
const adapters: Record<ProviderType, AIAdapter> = {
  openai: openaiAdapter,
  claude: claudeAdapter,
  gemini: geminiAdapter,
  ollama: ollamaAdapter,
}

export function getAdapter(provider: ProviderType): AIAdapter {
  return adapters[provider]
}

// ===================== IPC 注册 =====================
const activeRequests = new Map<string, AbortController>()

/** 带重试的 chat 调用 */
async function chatWithRetry(
  adapter: AIAdapter,
  params: ChatParams,
  onChunk: (text: string) => void,
  signal: AbortSignal,
  retryCount = DEFAULT_RETRY_COUNT,
  onUsage?: (usage: TokenUsageInfo) => void,
): Promise<string> {
  // H-05 修复：流式请求不重试，因为已发送的 chunks 无法撤回，重试会导致内容重复
  const effectiveRetry = params.stream ? 0 : retryCount
  let lastError: unknown
  for (let attempt = 0; attempt <= effectiveRetry; attempt++) {
    if (signal.aborted) throw new Error('Aborted')
    try {
      // 加入超时（与用户 signal 合并）
      const timeoutSignal = withTimeout(signal, DEFAULT_TIMEOUT_MS)
      return await adapter.chat(params, onChunk, timeoutSignal, onUsage)
    } catch (err) {
      lastError = err
      // 用户主动取消不重试
      if (signal.aborted) throw err
      const errName = (err as Error)?.name
      if (errName === 'AbortError' && !signal.aborted) {
        // 是超时 abort，可重试
      }
      // 不可重试的错误直接抛出
      if (!isRetryableError(err)) throw err
      // 最后一次尝试不再等待
      if (attempt === effectiveRetry) throw err
      // 指数退避：500ms, 1000ms, 2000ms...
      const delay = 500 * Math.pow(2, attempt)
      log.warn(`请求失败，${delay}ms 后重试 (${attempt + 1}/${effectiveRetry + 1})`, {
        error: (err as Error).message,
      })
      await new Promise(resolve => setTimeout(resolve, delay))
    }
  }
  throw lastError
}

export function registerAIIPC(ipcMain: IpcMain): void {
  // 获取模型列表
  ipcMain.handle('ai:listModels', async (_event, provider: ProviderType, baseUrl: string, apiKey: string) => {
    try {
      return { success: true, models: await getAdapter(provider).listModels(baseUrl, apiKey) }
    } catch (e) {
      return { success: false, error: (e as Error).message }
    }
  })

  // 测试连接
  ipcMain.handle('ai:testConnection', async (_event, config: { type: ProviderType; baseUrl: string; apiKey: string }) => {
    try {
      const success = await getAdapter(config.type).testConnection(config.baseUrl, config.apiKey)
      if (success) {
        const models = await getAdapter(config.type).listModels(config.baseUrl, config.apiKey)
        return { success: true, models }
      }
      return { success: false, error: '连接失败' }
    } catch (e) {
      return { success: false, error: (e as Error).message }
    }
  })

  // 聊天（流式）
  ipcMain.handle('ai:chat', async (event, params: ChatParams) => {
    const webContents = event.sender as WebContents
    const controller = new AbortController()
    activeRequests.set(params.requestId, controller)

    log.info('AI 请求开始', {
      requestId: params.requestId,
      provider: params.provider,
      model: params.model,
      messageCount: params.messages.length,
    })

    try {
      // C-03 修复：有工具时使用 chatWithTools 循环，否则直接调用适配器
      if (params.tools && params.tools.length > 0) {
        await chatWithTools(
          params,
          (text) => {
            if (!activeRequests.has(params.requestId)) return
            safeSend(webContents, 'ai:chunk', { requestId: params.requestId, text })
          },
          (toolCall) => {
            log.info('工具调用', { requestId: params.requestId, tool: toolCall.name })
            safeSend(webContents, 'ai:toolCall', { requestId: params.requestId, ...toolCall })
          },
          (result) => {
            safeSend(webContents, 'ai:toolResult', { requestId: params.requestId, ...result })
          },
          (usage) => {
            safeSend(webContents, 'ai:usage', { requestId: params.requestId, ...usage })
          },
          controller.signal,
        )
      } else {
        const adapter = getAdapter(params.provider)
        await chatWithRetry(
          adapter,
          params,
          (text) => {
            // 检查请求是否还存在（可能已被取消）
            if (!activeRequests.has(params.requestId)) return
            safeSend(webContents, 'ai:chunk', { requestId: params.requestId, text })
          },
          controller.signal,
          DEFAULT_RETRY_COUNT,
          (usage) => {
            // 发送 usage 事件
            safeSend(webContents, 'ai:usage', { requestId: params.requestId, ...usage })
          },
        )
      }
      log.info('AI 请求完成', { requestId: params.requestId, provider: params.provider, model: params.model })
      safeSend(webContents, 'ai:done', params.requestId)
    } catch (e) {
      const err = e as Error
      if (err.name === 'AbortError' || controller.signal.aborted) {
        log.info('AI 请求被取消', { requestId: params.requestId })
        // 被取消视为 done（前端会重置状态）
        safeSend(webContents, 'ai:done', params.requestId)
      } else {
        log.error('AI 请求失败', { requestId: params.requestId, provider: params.provider, model: params.model, error: err.message })
        safeSend(webContents, 'ai:error', { requestId: params.requestId, error: err.message })
      }
    } finally {
      activeRequests.delete(params.requestId)
    }
  })

  // 取消请求
  ipcMain.handle('ai:cancel', async (_event, requestId: string) => {
    const controller = activeRequests.get(requestId)
    if (controller) {
      controller.abort()
      activeRequests.delete(requestId)
    }
  })

  // Token 计数
  ipcMain.handle('ai:countTokens', async (_event, text: string, model: string) => {
    return countTokens(text, model)
  })

  ipcMain.handle('ai:countMessagesTokens', async (_event, messages: { content: string; role: string }[], model: string) => {
    return countMessagesTokens(messages, model)
  })
}
