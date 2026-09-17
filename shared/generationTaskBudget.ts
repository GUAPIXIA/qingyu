import {
  resolveRequestBudget,
  resolveUserHardCap,
  type ModelProfileUserOverride,
  type RequestBudget,
} from './modelOutputProfile'
import {
  resolveReasoningGate,
  type ReasoningGateLevel,
  type ResolvedReasoningGate,
} from './reasoningGate'

export type GenerationTask =
  | 'main'
  | 'translation'
  | 'continuation'
  | 'tail_repair'
  | 'polish'
  | 'memory'
  | 'compression'
  | 'title'
  | 'direction'
  | 'character_expand'
  | 'character_field'
  | 'greeting'
  | 'preset_draft'
  | 'image_prompt'
  | 'image_prompt_translation'
  | 'lorebook_keywords'
  | 'group_reply'
  | 'generic'

const TASK_BODY_DEFAULTS: Record<GenerationTask, number> = {
  main: 600,
  translation: 256,
  continuation: 180,
  tail_repair: 200,
  polish: 600,
  memory: 2500,
  compression: 600,
  title: 20,
  direction: 800,
  character_expand: 1800,
  character_field: 800,
  greeting: 900,
  preset_draft: 900,
  image_prompt: 1200,
  image_prompt_translation: 256,
  lorebook_keywords: 600,
  group_reply: 600,
  generic: 600,
}

export interface GenerationTaskBudgetInput {
  task: GenerationTask
  model: string
  inputChars?: number
  expectedBodyChars?: number
  userHardCap?: number | null
  recentReasoningTokens?: number[]
  profileOverride?: ModelProfileUserOverride
  reasoningGate?: ResolvedReasoningGate
  reasoningLevel?: ReasoningGateLevel
}

export interface GenerationTaskBudget extends RequestBudget {
  task: GenerationTask
  expectedBodyChars: number
  reasoningGate: ResolvedReasoningGate
  /** 自动模式失败后可逐次扩容；显式用户硬上限不会生成此指令。 */
  adaptiveOutputBudget?: AdaptiveOutputBudget
}

export interface AdaptiveOutputBudget {
  /** 当前端点允许的输出能力顶点；扩容永不越过它。 */
  ceilingTokens: number
  /** 本任务需要保留的正文空间，用于按实际推理压力推导下一档。 */
  bodyReserveTokens: number
}

/**
 * 自动预算触顶后的下一次请求上限。
 * 按当前预算、正文体量和本次实际推理消耗动态增长，不使用任务/模型专属固定 token。
 * 返回 null 表示已经到达端点能力上限，不能继续扩大。
 */
export function expandAdaptiveOutputBudget(input: {
  currentMaxTokens: number
  budget: AdaptiveOutputBudget
  observedReasoningTokens?: number
}): number | null {
  const current = Math.max(1, Math.floor(input.currentMaxTokens))
  const ceiling = Math.max(1, Math.floor(input.budget.ceilingTokens))
  if (current >= ceiling) return null

  const body = Math.max(0, Math.floor(input.budget.bodyReserveTokens))
  const observedReasoning = Number.isFinite(input.observedReasoningTokens)
    ? Math.max(0, Math.floor(input.observedReasoningTokens as number))
    : 0
  // 至少扩大一个“当前窗口”，同时保证已观测推理后仍留有完整正文空间。
  const growthTarget = current + Math.max(current, body)
  const observedTarget = observedReasoning + body
  const next = Math.min(ceiling, Math.max(current + 1, growthTarget, observedTarget))
  return next > current ? next : null
}

export function resolveGenerationTaskBodyChars(input: Pick<GenerationTaskBudgetInput, 'task' | 'inputChars' | 'expectedBodyChars'>): number {
  if (Number.isFinite(input.expectedBodyChars) && (input.expectedBodyChars as number) > 0) {
    return Math.ceil(input.expectedBodyChars as number)
  }
  const inputChars = Number.isFinite(input.inputChars) && (input.inputChars as number) > 0
    ? Math.ceil(input.inputChars as number)
    : 0
  if (input.task === 'translation' || input.task === 'image_prompt_translation') {
    return Math.max(TASK_BODY_DEFAULTS[input.task], Math.ceil(inputChars * 1.5))
  }
  if (input.task === 'polish') {
    return Math.max(256, Math.ceil(inputChars * 1.1))
  }
  return TASK_BODY_DEFAULTS[input.task]
}

/** 所有文本生成任务的唯一预算入口：任务只描述正文体量，模型名不决定 token 数值。 */
export function resolveGenerationTaskBudget(input: GenerationTaskBudgetInput): GenerationTaskBudget {
  const expectedBodyChars = resolveGenerationTaskBodyChars(input)
  const reasoningGate = input.reasoningGate ?? resolveReasoningGate({
    model: input.model,
    requestedLevel: input.reasoningLevel ?? (input.task === 'main' ? 'standard' : 'off'),
    enabled: true,
    ...(input.recentReasoningTokens?.length
      ? { recentReasoningTokens: input.recentReasoningTokens }
      : {}),
  })
  const budget = resolveRequestBudget({
    model: input.model,
    hardMaxChars: expectedBodyChars,
    userHardCap: input.userHardCap,
    profileOverride: input.profileOverride,
    ...(input.recentReasoningTokens?.length
      ? { recentReasoningTokens: input.recentReasoningTokens }
      : {}),
    reasoningGate,
  })
  const adaptiveOutputBudget = resolveUserHardCap(input.userHardCap) == null
    && budget.requestMaxTokens < budget.profile.outputLimit
    ? {
        ceilingTokens: budget.profile.outputLimit,
        bodyReserveTokens: budget.bodyReserve,
      }
    : undefined
  return {
    ...budget,
    task: input.task,
    expectedBodyChars,
    reasoningGate,
    ...(adaptiveOutputBudget ? { adaptiveOutputBudget } : {}),
  }
}
