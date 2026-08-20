/**
 * 真实 ModelPort（对接 services/ai.ts）
 * 复用现有 AI 适配层（chatWithRetry + provider adapters），提供与 FakeModelPort 一致的 stream 接口
 */
import { getAdapter, chatWithRetry } from '../services/ai'
import type { ModelPort, ModelRequest, ModelCallbacks } from './ports'
import type { ChatParams } from '../../shared/types'

export class RealModelPort implements ModelPort {
  async stream(request: ModelRequest, callbacks: ModelCallbacks, signal: AbortSignal): Promise<{ text: string; usage?: { promptTokens: number; completionTokens: number; totalTokens: number } }> {
    const params: ChatParams = {
      requestId: `real-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      messages: request.messages as ChatParams['messages'],
      provider: request.provider as ChatParams['provider'],
      apiKey: request.apiKey ?? '',
      baseUrl: request.baseUrl ?? '',
      model: request.model,
      temperature: 0.8,
      topP: 0.95,
      maxTokens: 1024,
      frequencyPenalty: 0,
      presencePenalty: 0,
      stream: true,
    }
    // 委托给现有 AI 服务（内部已处理 provider 适配、重试、用量）
    let text = ''
    const onUsage = callbacks.onUsage
    const result = await chatWithRetry(
      getAdapter(params.provider),
      params,
      (chunk) => {
        text += chunk
        callbacks.onChunk(chunk)
      },
      signal,
      1,
      onUsage as (u: { promptTokens: number; completionTokens: number; totalTokens: number }) => void,
    )
    return { text: result ?? text }
  }
}
