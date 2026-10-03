/**
 * 真实 ModelPort（对接 services/ai.ts）
 * 复用现有 AI 适配层（chatWithRetry + provider adapters），提供与 FakeModelPort 一致的 stream 接口
 */
import { getAdapter, chatWithRetry } from '../services/ai'
import type { ModelPort, ModelRequest, ModelCallbacks } from './ports'
import type { ChatParams } from '../../shared/types'
import { classifyFailureOutcome } from '../../shared/generationObservation'

export class RealModelPort implements ModelPort {
  async stream(request: ModelRequest, callbacks: ModelCallbacks, signal: AbortSignal): Promise<import('./ports').ModelResult> {
    const params: ChatParams = {
      requestId: `real-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      sessionId: request.sessionId,
      messages: request.messages as ChatParams['messages'],
      provider: request.provider as ChatParams['provider'],
      apiKey: request.apiKey ?? '',
      baseUrl: request.baseUrl ?? '',
      model: request.model,
      temperature: 0.8,
      topP: 0.95,
      maxTokens: request.maxTokens,
      frequencyPenalty: 0,
      presencePenalty: 0,
      stream: true,
    }
    // 委托给现有 AI 服务（内部已处理 provider 适配、重试、用量；阶段3返回 AICompletion）
    let text = ''
    const onUsage = callbacks.onUsage
    const run = () => chatWithRetry(
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
    let completion: Awaited<ReturnType<typeof chatWithRetry>>
    try {
      completion = await run()
    } catch (error) {
      const failure = classifyFailureOutcome(error, { signalAborted: signal.aborted })
      // 新任务链路不经过 renderer 的 gateRecovery。空响应且尚未外发
      // 任何 chunk 时，同一上下文原样恢复一次；有正文或其他错误均不重发。
      if (signal.aborted || text || failure.errorKind !== 'empty_output') throw error
      completion = await run()
    }
    return { text: completion.text || text, finishReason: completion.finishReason }
  }
}
