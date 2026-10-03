/**
 * 桌面端 AI 辅助请求适配（阶段 1 从 `shared/chat-core/aiInputHelper.ts` 迁入）。
 *
 * 结构优化目标：shared 纯核心不得访问 `window` / IPC。本模块承载：
 * 订阅（onChunk / onComplete / onError）、取消清理与 `window.api.ai.chat` 请求。
 * 纯逻辑（上下文组装、结果解析、长度评估等）继续留在 `shared/chat-core/aiInputHelper`，
 * 主进程与 Android 侧不依赖本文件。
 */
import type { ChatParams, ProviderType, Preset } from '../../../shared/types'
import type { ReasoningGateDirective } from '../../../shared/reasoningGate'
import { resolveGenerationTaskBudget } from '../../../shared/generationTaskBudget'
import { stripThought } from '../../../shared/chat-core/messagePostProcess'

/** callAiHelper 的依赖（由 hook 侧注入，模块内不接触 React 状态） */
export interface AiHelperCallOptions {
  /** 要发送给模型的完整消息序列。续写依赖最近对话，不能在调用层压缩成首尾两条。 */
  messages: ChatParams['messages']
  temperature?: number
  maxTokens?: number
  onChunk?: (delta: string, full: string) => void
  reasoningGate?: ReasoningGateDirective
  /** 自动预算触顶时允许主进程在端点能力范围内扩大后无损重试。 */
  adaptiveOutputBudget?: ChatParams['adaptiveOutputBudget']
  /** 辅助任务观测分类，用于隔离各任务的历史推理样本。 */
  observability?: ChatParams['observability']
  /** 截断时返回已产出正文（仅限解析器自身可容错的辅助调用） */
  profile: { provider: ProviderType; apiKey: string; baseUrl: string }
  activeModel: string
  preset: Preset | null
  /** 活跃请求 ID 集合（用于组件卸载时统一取消） */
  activeRequestIds: Set<string>
}

/**
 * 发起一次 AI 辅助请求（非流式），返回 AI 生成的完整文本。
 * 注册 chunk/done/error 监听，完成后自清理。
 */
export function callAiHelper(opts: AiHelperCallOptions): Promise<string> {
  const {
    messages,
    temperature,
    maxTokens,
    onChunk,
    reasoningGate,
    adaptiveOutputBudget,
    observability,
    profile,
    activeModel,
    preset,
    activeRequestIds,
  } = opts
  const automaticPlan = maxTokens == null
    ? resolveGenerationTaskBudget({ task: 'generic', model: activeModel, userHardCap: preset?.maxTokens })
    : null
  let result = ''
  const requestId = `ai-helper-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  activeRequestIds.add(requestId)

  return new Promise<string>((resolve, reject) => {
    const cleanup = () => {
      activeRequestIds.delete(requestId)
      unbindChunk(); unbindDone(); unbindError()
    }
    // 辅助调用的结果会进入输入框或下游服务，绝不允许 thought-only 回退。
    const cleanResult = () => stripThought(result)
    const unbindChunk = window.api.ai.onChunk((data) => {
      if (data.requestId !== requestId) return
      result += data.text
      onChunk?.(data.text, cleanResult())
    })
    const unbindDone = window.api.ai.onComplete((payload) => {
      if (payload.requestId !== requestId) return
      cleanup()
      resolve(cleanResult())
    })
    const unbindError = window.api.ai.onError((data) => {
      if (data.requestId !== requestId) return
      cleanup()
      reject(new Error(data.error))
    })

    const params: ChatParams = {
      requestId,
      messages,
      provider: profile.provider,
      apiKey: profile.apiKey,
      baseUrl: profile.baseUrl,
      model: activeModel,
      temperature: temperature ?? preset?.temperature ?? 0.5,
      topP: preset?.topP ?? 0.9,
      maxTokens: maxTokens ?? automaticPlan!.requestMaxTokens,
      frequencyPenalty: preset?.frequencyPenalty ?? 0,
      presencePenalty: preset?.presencePenalty ?? 0,
      stream: false,
      reasoningGate: reasoningGate ?? automaticPlan?.reasoningGate,
      adaptiveOutputBudget: adaptiveOutputBudget ?? automaticPlan?.adaptiveOutputBudget,
      observability,
    }

    window.api.ai.chat(params).catch((err) => {
      cleanup()
      reject(err)
    })
  })
}