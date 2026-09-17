import type { ContinueIntensity, ContinueLength } from './types'

/**
 * 输入续写控制项的单一权威定义（仿 shared/narrativeMode.ts）。
 * 剧情变化映射推进提示词与 temperature；续写长度映射“本次新增内容”的字数区间与 maxTokens。
 *
 * 两个维度职责不可互换：剧情变化决定“发生多大的变化”，续写长度决定“本次增加多少文字”。
 */

export const DEFAULT_CONTINUE_INTENSITY: ContinueIntensity = 'active'
export const DEFAULT_CONTINUE_LENGTH: ContinueLength = 'standard'

export const CONTINUE_INTENSITY_OPTIONS: ReadonlyArray<{
  value: ContinueIntensity
  label: string
  description: string
}> = [
  {
    value: 'subtle',
    label: '延续',
    description: '保持当前走向，不主动加入新事件或转折',
  },
  {
    value: 'steady',
    label: '波澜',
    description: '加入小阻碍或新信息，但不改变当前主线',
  },
  {
    value: 'active',
    label: '转折',
    description: '引入事件、压力或线索，明显改变当前局势',
  },
  {
    value: 'bold',
    label: '剧变',
    description: '允许重大转折、场景切换或新的冲突线',
  },
]

export const CONTINUE_LENGTH_OPTIONS: ReadonlyArray<{
  value: ContinueLength
  label: string
  description: string
}> = [
  {
    value: 'brief',
    label: '短句',
    description: '预计新增 20–60 字 · 1–2 句',
  },
  {
    value: 'standard',
    label: '小段',
    description: '预计新增 80–180 字 · 1 个完整自然段',
  },
  {
    value: 'detailed',
    label: '展开',
    description: '预计新增 220–420 字 · 2–3 个自然段',
  },
  {
    value: 'extended',
    label: '长篇',
    description: '预计新增 500–900 字 · 4–6 个自然段',
  },
]

/**
 * 剧情变化只控制推进幅度与采样创造性，不隐式改变篇幅。
 * 温度收窄到 0.45–0.75：过高会同时增加新支线、新人物与解释性细节，使续写长度更难预测。
 */
export const CONTINUE_INTENSITY_PARAMS: Record<
  ContinueIntensity,
  { temperature: number }
> = {
  subtle: { temperature: 0.45 },
  steady: { temperature: 0.55 },
  active: { temperature: 0.65 },
  bold: { temperature: 0.75 },
}

/**
 * 续写长度只控制“本次新增内容”的目标区间，不改变剧情推进幅度。
 * minChars/maxChars 是给模型的字数指令，也是生成后校验的依据；
 * 它不承担输出上限的职责——输出预算由统一任务预算器按正文目标与实测推理量换算。
 */
export const CONTINUE_LENGTH_PARAMS: Record<ContinueLength, {
  minChars: number
  maxChars: number
  /** 结构目标，直接进入提示词与界面说明 */
  structure: string
}> = {
  brief: { minChars: 20, maxChars: 60, structure: '1–2 句' },
  standard: { minChars: 80, maxChars: 180, structure: '形成 1 个完整自然段' },
  detailed: { minChars: 220, maxChars: 420, structure: '形成 2–3 个自然段' },
  extended: { minChars: 500, maxChars: 900, structure: '形成 4–6 个自然段' },
}

/**
 * 续写请求的输出上限：只作失控兜底，不承担长度控制职责。
 *
 * 长度由提示词的字数指令 + 生成后校验负责；这个上限只防止模型彻底跑飞。
 * 必须给足的原因（2026-09-11 实机实测）：
 *
 * 1. **推理内容与正文共享同一份输出预算**。多数聚合端点忽略 `thinking: disabled`
 *    （实测 `deepseek-v4.1-flash` 在显式关闭后仍返回 reasoning_content），
 *    实测推理可占 167–3479 token。预算偏紧时推理会把预算吃光，正文为空——
 *    这正是“续写未返回有效的中文正文”的真实成因，与“中文 2 token/字”无关。
 * 2. 最大档 900 字折合约 1800 token，加上推理与标签包裹，
 *    实测单次请求完成量可达约 3900 token。
 *
 * 故取值需覆盖“较长推理 + 最大档正文”，并留出余量（由 continueIntensity.test.ts
 * 的不变量断言约束）。上限是封顶而非预扣，给足不增加成本。
 */

/**
 * 长度校验阈值（方案 §6.5）。
 * - acceptLowerRatio：低于下限但达到下限该比例且句意完整时可接受，不为凑字数重试
 * - repairCeilingRatio：超过上限该比例才直接压缩；上限的 100%–120% 先尝试句边界收束
 * - softLowerRatio / softUpperRatio：修复一次后的宽容范围，超出即放弃并保留原文
 */
export const CONTINUE_LENGTH_TOLERANCE = {
  acceptLowerRatio: 0.8,
  repairCeilingRatio: 1.2,
  softLowerRatio: 0.6,
  softUpperRatio: 1.5,
} as const

export function isContinueIntensity(value: unknown): value is ContinueIntensity {
  return value === 'subtle' || value === 'steady' || value === 'active' || value === 'bold'
}

/** 从高到低解析默认值；非法值与空值会被跳过。 */
export function resolveContinueIntensity(...candidates: unknown[]): ContinueIntensity {
  return candidates.find(isContinueIntensity) ?? DEFAULT_CONTINUE_INTENSITY
}

export function isContinueLength(value: unknown): value is ContinueLength {
  return value === 'brief' || value === 'standard' || value === 'detailed' || value === 'extended'
}

export function resolveContinueLength(...candidates: unknown[]): ContinueLength {
  return candidates.find(isContinueLength) ?? DEFAULT_CONTINUE_LENGTH
}

export function getContinueIntensityLabel(intensity: ContinueIntensity): string {
  return CONTINUE_INTENSITY_OPTIONS.find((option) => option.value === intensity)?.label ?? '转折'
}

export function getContinueLengthLabel(length: ContinueLength): string {
  return CONTINUE_LENGTH_OPTIONS.find((option) => option.value === length)?.label ?? '小段'
}
