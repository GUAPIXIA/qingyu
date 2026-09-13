import type { GroupMessage, Preset, ResponseLengthMode, ResponsePolicy } from '../../shared/types'
import type { RequestBudget } from '../../shared/modelOutputProfile'
import {
  getModelOutputProfile,
  resolveRequestBudget,
  resolveUserHardCap,
} from '../../shared/modelOutputProfile'
import {
  countVisibleChars,
  detectUserLengthIntent,
  resolveResponsePolicy,
  resolveSceneFactor,
} from '../../shared/responsePolicy'
import { DEFAULT_RESERVED_OUTPUT } from './chatConstants'

export interface GroupRequestPlan {
  responsePolicy: ResponsePolicy
  requestBudget: RequestBudget
  requestMaxTokens: number
  responseIntent: ResponseLengthMode | null
  sceneFactor: number
  pipelineLegacy: boolean
}

/** 群聊与单聊共享同一套篇幅策略和模型输出预算语义。 */
export function resolveGroupRequestPlan(input: {
  model: string
  messages: GroupMessage[]
  preset?: Preset | null
  pipelineLegacy?: boolean
}): GroupRequestPlan {
  const { model, messages, preset } = input
  const pipelineLegacy = input.pipelineLegacy === true
  const latestUserText = [...messages].reverse()
    .find((message) => message.characterId === '__user__')?.content ?? ''
  const hasAssistantReply = messages.some(
    (message) => message.characterId !== '__user__' && !!message.content?.trim(),
  )
  const responseIntent = pipelineLegacy ? null : detectUserLengthIntent(latestUserText)
  const sceneFactor = pipelineLegacy
    ? 1
    : resolveSceneFactor({ latestUserText, hasAssistantReply })
  const recentAssistantVisibleChars = messages
    .filter((message) => message.characterId !== '__user__' && !!message.content?.trim())
    .slice(-5)
    .reverse()
    .map((message) => countVisibleChars(message.content))
  const responsePolicy = resolveResponsePolicy({
    presetHint: preset?.responseLengthHint,
    userIntent: responseIntent,
    sceneFactor,
    recentAssistantVisibleChars,
  })

  if (pipelineLegacy) {
    const requestMaxTokens = resolveUserHardCap(preset?.maxTokens) ?? DEFAULT_RESERVED_OUTPUT
    return {
      responsePolicy,
      requestBudget: {
        model,
        profile: getModelOutputProfile(model),
        bodyReserve: 0,
        reasoningReserve: 0,
        minimumViableOutputTokens: 0,
        requestMaxTokens,
      },
      requestMaxTokens,
      responseIntent,
      sceneFactor,
      pipelineLegacy,
    }
  }

  const requestBudget = resolveRequestBudget({
    model,
    hardMaxChars: responsePolicy.hardMaxChars,
    userHardCap: preset?.maxTokens,
  })
  return {
    responsePolicy,
    requestBudget,
    requestMaxTokens: requestBudget.requestMaxTokens,
    responseIntent,
    sceneFactor,
    pipelineLegacy,
  }
}
