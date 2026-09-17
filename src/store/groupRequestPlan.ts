import type { GroupMessage, Preset, ResponseLengthMode, ResponsePolicy } from '../../shared/types'
import type { RequestBudget } from '../../shared/modelOutputProfile'
import { resolveGenerationTaskBudget } from '../../shared/generationTaskBudget'
import {
  countVisibleChars,
  detectUserLengthIntent,
  resolveResponsePolicy,
  resolveSceneFactor,
} from '../../shared/responsePolicy'

export interface GroupRequestPlan {
  responsePolicy: ResponsePolicy
  requestBudget: RequestBudget
  requestMaxTokens: number
  responseIntent: ResponseLengthMode | null
  sceneFactor: number
}

/** 群聊与单聊共享同一套篇幅策略和模型输出预算语义。 */
export function resolveGroupRequestPlan(input: {
  model: string
  messages: GroupMessage[]
  preset?: Preset | null
  /** W1（主计划 §7.3）：该端点/model 的近期推理样本（缺省 = 档案默认余量） */
  reasoningSamples?: number[]
  /** 阶段8（§4.2）：本轮推理门控（缺省 = 不介入） */
  reasoningGate?: import('../../shared/reasoningGate').ResolvedReasoningGate
  defaultResponseLength?: ResponseLengthMode
  profileOverride?: import('../../shared/modelOutputProfile').ModelProfileUserOverride
}): GroupRequestPlan {
  const { model, messages, preset } = input
  const latestUserText = [...messages].reverse()
    .find((message) => message.characterId === '__user__')?.content ?? ''
  const hasAssistantReply = messages.some(
    (message) => message.characterId !== '__user__' && !!message.content?.trim(),
  )
  const responseIntent = detectUserLengthIntent(latestUserText)
  const sceneFactor = resolveSceneFactor({ latestUserText, hasAssistantReply })
  const recentAssistantVisibleChars = messages
    .filter((message) => message.characterId !== '__user__' && !!message.content?.trim())
    .slice(-5)
    .reverse()
    .map((message) => countVisibleChars(message.content))
  const responsePolicy = resolveResponsePolicy({
    presetHint: preset?.responseLengthHint,
    defaultMode: input.defaultResponseLength,
    userIntent: responseIntent,
    sceneFactor,
    recentAssistantVisibleChars,
  })


  const requestBudget = resolveGenerationTaskBudget({
    task: 'group_reply',
    model,
    expectedBodyChars: responsePolicy.hardMaxChars,
    userHardCap: preset?.maxTokens,
    profileOverride: input.profileOverride,
    ...(input.reasoningSamples?.length ? { recentReasoningTokens: input.reasoningSamples } : {}),
    ...(input.reasoningGate ? { reasoningGate: input.reasoningGate } : {}),
  })
  return {
    responsePolicy,
    requestBudget,
    requestMaxTokens: requestBudget.requestMaxTokens,
    responseIntent,
    sceneFactor,
  }
}
