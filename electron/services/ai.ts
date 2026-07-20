import type { IpcMain, WebContents } from 'electron'
import type { ChatParams, ProviderType } from '../../shared/types'

interface AIAdapter {
  chat(
    params: ChatParams,
    onChunk: (text: string) => void,
    signal: AbortSignal
  ): Promise<string>
  listModels(baseUrl: string, apiKey: string): Promise<string[]>
  testConnection(baseUrl: string, apiKey: string): Promise<boolean>
}

// ===================== OpenAI 兼容适配器 =====================
const openaiAdapter: AIAdapter = {
  async chat(params, onChunk, signal) {
    const { baseUrl, apiKey, model, messages, temperature, topP, maxTokens, frequencyPenalty, presencePenalty, stream } = params
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
      throw new Error(`OpenAI API 错误 ${response.status}: ${errText}`)
    }

    if (!stream) {
      const data = await response.json()
      const content = data.choices?.[0]?.message?.content ?? ''
      onChunk(content)
      return content
    }

    // 流式解析
    const reader = response.body?.getReader()
    if (!reader) throw new Error('无法读取响应流')
    const decoder = new TextDecoder()
    let fullText = ''
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed || !trimmed.startsWith('data:')) continue
        const data = trimmed.slice(5).trim()
        if (data === '[DONE]') continue
        try {
          const parsed = JSON.parse(data)
          const delta = parsed.choices?.[0]?.delta?.content ?? ''
          if (delta) {
            fullText += delta
            onChunk(delta)
          }
        } catch {
          // 忽略解析错误
        }
      }
    }
    return fullText
  },

  async listModels(baseUrl, apiKey) {
    const url = `${baseUrl.replace(/\/$/, '')}/models`
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    if (!response.ok) throw new Error(`获取模型列表失败: ${response.status}`)
    const data = await response.json()
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
  async chat(params, onChunk, signal) {
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

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify(body),
      signal,
    })

    if (!response.ok) {
      const errText = await response.text()
      throw new Error(`Claude API 错误 ${response.status}: ${errText}`)
    }

    if (!stream) {
      const data = await response.json()
      const content = data.content?.[0]?.text ?? ''
      onChunk(content)
      return content
    }

    const reader = response.body?.getReader()
    if (!reader) throw new Error('无法读取响应流')
    const decoder = new TextDecoder()
    let fullText = ''
    let buffer = ''

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
        try {
          const parsed = JSON.parse(data)
          if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
            fullText += parsed.delta.text
            onChunk(parsed.delta.text)
          }
        } catch {
          // 忽略
        }
      }
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
    const data = await response.json()
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
  async chat(params, onChunk, signal) {
    const { baseUrl, apiKey, model, messages, temperature, topP, maxTokens, stream } = params
    const action = stream ? 'streamGenerateContent' : 'generateContent'
    const url = `${baseUrl.replace(/\/$/, '')}/v1beta/models/${model}:${action}?key=${apiKey}`

    // 转换为 Gemini 格式
    const systemMsg = messages.find((m) => m.role === 'system')
    const contents = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      }))

    const body: Record<string, unknown> = {
      contents,
      generationConfig: {
        temperature,
        topP,
        maxOutputTokens: maxTokens,
      },
    }
    if (systemMsg) {
      body.systemInstruction = { parts: [{ text: systemMsg.content }] }
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    })

    if (!response.ok) {
      const errText = await response.text()
      throw new Error(`Gemini API 错误 ${response.status}: ${errText}`)
    }

    if (!stream) {
      const data = await response.json()
      const content = data.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
      onChunk(content)
      return content
    }

    const reader = response.body?.getReader()
    if (!reader) throw new Error('无法读取响应流')
    const decoder = new TextDecoder()
    let fullText = ''
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      // Gemini 流式返回 JSON 数组片段
      try {
        const parsed = JSON.parse(`[${buffer}]`)
        for (const item of parsed) {
          const text = item.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
          if (text) {
            fullText += text
            onChunk(text)
          }
        }
        buffer = ''
      } catch {
        // 不完整的 JSON，继续读取
      }
    }
    // 处理剩余 buffer
    if (buffer.trim()) {
      try {
        const parsed = JSON.parse(`[${buffer}]`)
        for (const item of parsed) {
          const text = item.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
          if (text) {
            fullText += text
            onChunk(text)
          }
        }
      } catch {
        // 忽略
      }
    }
    return fullText
  },

  async listModels(baseUrl, _apiKey) {
    const url = `${baseUrl.replace(/\/$/, '')}/v1beta/models`
    const response = await fetch(url)
    if (!response.ok) throw new Error(`获取模型列表失败: ${response.status}`)
    const data = await response.json()
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

// ===================== Ollama 适配器 =====================
const ollamaAdapter: AIAdapter = {
  async chat(params, onChunk, signal) {
    const { baseUrl, model, messages, temperature, topP, stream } = params
    const url = `${baseUrl.replace(/\/$/, '')}/api/chat`

    const body: Record<string, unknown> = {
      model,
      messages,
      options: { temperature, top_p: topP },
      stream,
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
      const data = await response.json()
      const content = data.message?.content ?? ''
      onChunk(content)
      return content
    }

    const reader = response.body?.getReader()
    if (!reader) throw new Error('无法读取响应流')
    const decoder = new TextDecoder()
    let fullText = ''
    let buffer = ''

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
        } catch {
          // 忽略
        }
      }
    }
    return fullText
  },

  async listModels(baseUrl, _apiKey) {
    const url = `${baseUrl.replace(/\/$/, '')}/api/tags`
    const response = await fetch(url)
    if (!response.ok) throw new Error(`获取模型列表失败: ${response.status}`)
    const data = await response.json()
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

    try {
      const adapter = getAdapter(params.provider)
      await adapter.chat(
        params,
        (text) => {
          webContents.send('ai:chunk', { requestId: params.requestId, text })
        },
        controller.signal
      )
      webContents.send('ai:done', params.requestId)
    } catch (e) {
      const err = e as Error
      if (err.name === 'AbortError') {
        webContents.send('ai:done', params.requestId)
      } else {
        webContents.send('ai:error', { requestId: params.requestId, error: err.message })
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
}
