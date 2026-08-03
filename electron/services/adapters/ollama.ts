import type { AIAdapter } from './types'
import { normalizeThoughtTags } from './types'
import { applyInstructTemplate } from '../../../src/utils/chatTemplates'
import { toOllamaMessages, collectImages, imageErrorHint } from './vision'

/** NEW-L5：按排序后的键序列化对象，保证同内容不同键序产生相同 key */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']'
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    return '{' + Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',') + '}'
  }
  return JSON.stringify(value)
}

export const ollamaAdapter: AIAdapter = {
  async chat(params, onChunk, signal, onUsage) {
    const { baseUrl, model, temperature, topP, maxTokens,
            frequencyPenalty, presencePenalty, stream } = params

    // Instruct 模板模式：把消息包装为纯文本，走 /api/generate（原始补全接口）
    // 适用场景：本地模型的 chat template 缺失/异常，或需要精确控制包装格式时
    if (params.instructTemplate) {
      const { text, stopSequences } = applyInstructTemplate(params.messages, params.instructTemplate)
      const url = `${baseUrl.replace(/\/$/, '')}/api/generate`

      // Vision 降级：图片收集为附件（/api/generate 同样支持 images 字段），并在提示词中说明
      const images = collectImages(params.messages).map((p) => p.data)
      const imageNote = images.length > 0
        ? `\n\n[用户消息附带 ${images.length} 张图片，已作为附件发送]`
        : ''

      const options: Record<string, unknown> = {
        temperature,
        top_p: topP,
      }
      if (maxTokens && maxTokens > 0) options.num_predict = maxTokens
      if (frequencyPenalty !== undefined) options.frequency_penalty = frequencyPenalty
      if (presencePenalty !== undefined) options.presence_penalty = presencePenalty
      // 模板停止序列
      if (stopSequences.length > 0) options.stop = stopSequences

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model, prompt: text + imageNote, options, stream,
          ...(images.length > 0 ? { images } : {}),
        }),
        signal,
      })

      if (!response.ok) {
        const errText = await response.text()
        throw new Error(`Ollama API 错误 ${response.status}: ${errText}${imageErrorHint(params.messages)}`)
      }

      if (!stream) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const data: any = await response.json()
        const content = data.response ?? ''
        onChunk(content)
        if (onUsage) {
          onUsage({
            promptTokens: data.prompt_eval_count ?? 0,
            completionTokens: data.eval_count ?? 0,
            totalTokens: (data.prompt_eval_count ?? 0) + (data.eval_count ?? 0),
          })
        }
        return normalizeThoughtTags(content)
      }

      // 流式：/api/generate 返回 ndjson，每行 { response, done }
      const reader = response.body?.getReader()
      if (!reader) throw new Error('无法读取响应流')
      const decoder = new TextDecoder()
      let fullText = ''
      let buffer = ''
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
              const delta = parsed.response ?? ''
              if (delta) {
                fullText += delta
                onChunk(delta)
              }
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
      return normalizeThoughtTags(fullText)
    }

    const url = `${baseUrl.replace(/\/$/, '')}/api/chat`

    // Vision：带图片的消息转为 Ollama images 字段（纯 base64）
    const messages = toOllamaMessages(params.messages)

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
      throw new Error(`Ollama API 错误 ${response.status}: ${errText}${imageErrorHint(params.messages)}`)
    }

    if (!stream) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
        return normalizeThoughtTags(content) + '[TOOL_CALL:' + JSON.stringify(toolCalls) + ']'
      }
      return normalizeThoughtTags(content)
    }

    const reader = response.body?.getReader()
    if (!reader) throw new Error('无法读取响应流')
    const decoder = new TextDecoder()
    let fullText = ''
    let buffer = ''
    // C-03 修复：收集流式 tool_calls
    // BUG-27 修复：去重累积而非覆盖——流式分片时可能重复发送完整列表，
    // 也可能增量发送新增调用，覆盖会丢失中间分片
    const streamedToolCalls: { name?: string; input?: unknown; id?: string }[] = []
    const seenToolCallKeys = new Set<string>()

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
          // C-03 修复：收集 tool_calls（去重累积，兼容分片/重复发送）
          if (parsed.message?.tool_calls) {
            for (const tc of parsed.message.tool_calls) {
              // NEW-L5：key 按函数名 + 排序键参数序列化，避免对象键顺序变化导致同一调用被重复累积
              const fn = tc.function
              const key = JSON.stringify({
                name: fn?.name ?? '',
                args: fn?.arguments ? stableStringify(fn.arguments) : null,
              })
              if (seenToolCallKeys.has(key)) continue
              seenToolCallKeys.add(key)
              streamedToolCalls.push(tc)
            }
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
    if (streamedToolCalls.length > 0) {
      return normalizeThoughtTags(fullText) + '[TOOL_CALL:' + JSON.stringify(streamedToolCalls) + ']'
    }
    return normalizeThoughtTags(fullText)
  },

  async listModels(baseUrl, _apiKey) {
    const url = `${baseUrl.replace(/\/$/, '')}/api/tags`
    const response = await fetch(url)
    if (!response.ok) throw new Error(`获取模型列表失败: ${response.status}`)
    const data: { models?: { name: string }[] } = await response.json()
    return (data.models ?? []).map((m: { name: string }) => m.name)
  },

  async testConnection(baseUrl) {
    try {
      await this.listModels(baseUrl, '')
      return true
    } catch {
      return false
    }
  },
}
