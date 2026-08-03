import type { IpcMain, WebContents } from 'electron'
import type { ChatParams, ProviderType } from '../../shared/types'
import { countTokens, countMessagesTokens } from './tokenizer'
import { createLogger } from './logger'
import { chatWithTools } from './toolLoop'
import { safeSend } from '../utils/safeSend'
import type { AIAdapter, TokenUsageInfo } from './adapters/types'
import { DEFAULT_TIMEOUT_MS, DEFAULT_RETRY_COUNT, isRetryableError, withTimeout } from './adapters/types'
import { openaiAdapter } from './adapters/openai'
import { claudeAdapter } from './adapters/claude'
import { geminiAdapter } from './adapters/gemini'
import { ollamaAdapter } from './adapters/ollama'

const log = createLogger('ai')

// ===================== 适配器注册表 =====================

/**
 * 内置适配器表。
 * OpenRouter / vLLM / LM Studio / TabbyAPI 均为 OpenAI 兼容协议，复用 openaiAdapter；
 * 未来需要特化时（如 vLLM extra_body）替换为独立实现即可。
 */
const builtinAdapters: Record<ProviderType, AIAdapter> = {
  openai: openaiAdapter,
  claude: claudeAdapter,
  gemini: geminiAdapter,
  ollama: ollamaAdapter,
  openrouter: openaiAdapter,
  vllm: openaiAdapter,
  lmstudio: openaiAdapter,
  tabby: openaiAdapter,
  deepseek: openaiAdapter,
  groq: openaiAdapter,
  siliconflow: openaiAdapter,
}

/** 可注册适配器表（为阶段 4 扩展系统铺路：第三方 provider 可注册自定义适配器） */
const adapterRegistry = new Map<string, AIAdapter>()

/** 注册自定义 provider 适配器（覆盖内置同名项） */
export function registerAdapter(provider: string, adapter: AIAdapter): void {
  adapterRegistry.set(provider.toLowerCase(), adapter)
}

/** 注销自定义 provider 适配器 */
export function unregisterAdapter(provider: string): void {
  adapterRegistry.delete(provider.toLowerCase())
}

/** 获取适配器：自定义优先，内置次之，未知 provider 回退 OpenAI 兼容 */
export function getAdapter(provider: string): AIAdapter {
  const custom = adapterRegistry.get(provider.toLowerCase())
  if (custom) return custom
  return builtinAdapters[provider as ProviderType] ?? openaiAdapter
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
      const { signal: timeoutSignal, cleanup } = withTimeout(signal, DEFAULT_TIMEOUT_MS)
      try {
        return await adapter.chat(params, onChunk, timeoutSignal, onUsage)
      } finally {
        // BUG-11：请求正常完成/异常退出时清理超时 timer
        cleanup()
      }
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