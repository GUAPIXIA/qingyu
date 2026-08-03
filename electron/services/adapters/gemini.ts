import type { AIAdapter } from './types'
import { normalizeThoughtTags } from './types'
import { parseImageDataUrl, imageErrorHint } from './vision'

export const geminiAdapter: AIAdapter = {  async chat(params, onChunk, signal, onUsage) {
    const { baseUrl, apiKey, model, temperature, topP,
            maxTokens, frequencyPenalty, presencePenalty, stream } = params
    const action = stream ? 'streamGenerateContent' : 'generateContent'
    const url = `${baseUrl.replace(/\/$/, '')}/v1beta/models/${model}:${action}${stream ? '?alt=sse' : ''}`

    // 转换为 Gemini 格式
    const systemMsg = params.messages.find((m) => m.role === 'system')
    const contents = params.messages
      .filter((m) => m.role !== 'system')
      .map((m) => {
        const parts: Record<string, unknown>[] = [{ text: m.content }]
        // Vision：图片转为 inline_data（Gemini 要求纯 base64 + mime_type）
        for (const u of m.images ?? []) {
          const p = parseImageDataUrl(u)
          if (p) parts.push({ inline_data: { mime_type: p.mimeType, data: p.data } })
        }
        return {
          role: m.role === 'assistant' ? 'model' : 'user',
          parts,
        }
      })

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
      await response.text()
      throw new Error(`Gemini API 错误 ${response.status}${imageErrorHint(params.messages)}`)
    }

    if (!stream) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data: any = await response.json()
      const parts = data.candidates?.[0]?.content?.parts ?? []
      let text = ''
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rawToolCalls: any[] = []
      for (const part of parts) {
        if (part.text) text += part.text
        else if (part.functionCall) {
          rawToolCalls.push({
            id: `gemini-${nextGeminiCallId()}`,
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
        return normalizeThoughtTags(text) + '[TOOL_CALL:' + JSON.stringify(rawToolCalls) + ']'
      }
      return normalizeThoughtTags(text)
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
                  const idx = `gemini-fn-${nextGeminiCallId()}`
                  geminiFnCalls.set(idx, {
                    id: `gemini-${nextGeminiCallId()}`,
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
              const idx = `gemini-fn-${nextGeminiCallId()}`
              geminiFnCalls.set(idx, {
                id: `gemini-${nextGeminiCallId()}`,
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
            const idx = `gemini-fn-${nextGeminiCallId()}`
            geminiFnCalls.set(idx, {
              id: `gemini-${nextGeminiCallId()}`,
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
      return normalizeThoughtTags(fullText) + '[TOOL_CALL:' + JSON.stringify(toolCallsArray) + ']'
    }
    return normalizeThoughtTags(fullText)
  },

  async listModels(baseUrl, apiKey) {
    const url = `${baseUrl.replace(/\/$/, '')}/v1beta/models`
    // NEW-L4 修复：部分 Gemini 兼容代理要求鉴权头，带上 API Key
    const response = await fetch(url, {
      headers: apiKey ? { 'x-goog-api-key': apiKey } : undefined,
    })
    if (!response.ok) throw new Error(`获取模型列表失败: ${response.status}`)
    const data: { models?: { supportedGenerationMethods?: string[]; name: string }[] } = await response.json()
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

/**
 * BUG-04 修复：Gemini tool call ID 生成器
 * 使用单调递增计数器替代 Date.now()，避免同一毫秒内多个 functionCall 的 ID 冲突
 */
let geminiCallCounter = 0
function nextGeminiCallId(): number {
  return ++geminiCallCounter
}

/** 从 Gemini 非 SSE 流中提取完整 JSON 对象（修复 JSON 数组片段解析） */
function extractGeminiJsonObjects(buffer: string): { objects: any[]; remaining: string } { // eslint-disable-line @typescript-eslint/no-explicit-any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const objects: any[] = []
  // BUG-15 修复：单遍扫描，不再重置索引（原实现每提取一个对象就回到起点重扫，O(n²)）
  let depth = 0
  let start = -1
  let inString = false
  let escape = false
  let consumed = 0

  for (let i = 0; i < buffer.length; i++) {
    const ch = buffer[i]
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
        const objStr = buffer.slice(start, i + 1)
        try {
          objects.push(JSON.parse(objStr))
        } catch { /* 忽略解析失败的对象 */ }
        consumed = i + 1
        start = -1
        depth = 0
        inString = false
        escape = false
      }
    }
  }
  return { objects, remaining: buffer.slice(consumed) }
}
