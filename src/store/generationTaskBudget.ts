import type { ConnectionProfile } from '../../shared/types'
import {
  resolveGenerationTaskBudget,
  type GenerationTask,
  type GenerationTaskBudget,
} from '../../shared/generationTaskBudget'
import { enabledProfileOverride } from '../../shared/modelOutputProfile'
import { cachedReasoningSamplesFor, prefetchUsageProfile } from './usageProfileCache'

export async function resolveRendererGenerationTaskBudget(input: {
  profile: Pick<ConnectionProfile, 'provider' | 'baseUrl' | 'model' | 'capabilityOverride'>
  model: string
  task: GenerationTask
  inputChars?: number
  expectedBodyChars?: number
  userHardCap?: number | null
  usageTaskType?: string
}): Promise<GenerationTaskBudget> {
  const usageKey = usageKeyOf(input)
  await prefetchUsageProfile(usageKey)
  return resolveWithCachedSamples(input, usageKey)
}

type RendererTaskBudgetInput = Parameters<typeof resolveRendererGenerationTaskBudget>[0]

function usageKeyOf(input: RendererTaskBudgetInput) {
  return {
    provider: input.profile.provider,
    baseUrl: input.profile.baseUrl,
    model: input.model,
    ...(input.usageTaskType ? { taskType: input.usageTaskType } : {}),
  }
}

/**
 * 必须同步发请求的交互入口使用：立即复用已缓存样本，同时后台刷新下一轮样本。
 * 数值规划仍只走 shared 的统一任务入口。
 */
export function resolveCachedRendererGenerationTaskBudget(input: RendererTaskBudgetInput): GenerationTaskBudget {
  const usageKey = usageKeyOf(input)
  void prefetchUsageProfile(usageKey)
  return resolveWithCachedSamples(input, usageKey)
}

function resolveWithCachedSamples(input: RendererTaskBudgetInput, usageKey: ReturnType<typeof usageKeyOf>): GenerationTaskBudget {
  const samples = cachedReasoningSamplesFor(usageKey)
  return resolveGenerationTaskBudget({
    task: input.task,
    model: input.model,
    inputChars: input.inputChars,
    expectedBodyChars: input.expectedBodyChars,
    userHardCap: input.userHardCap,
    profileOverride: enabledProfileOverride(input.profile.capabilityOverride),
    ...(samples ? { recentReasoningTokens: samples } : {}),
  })
}
