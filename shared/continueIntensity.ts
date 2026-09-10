import type { ContinueIntensity, ContinueLength } from './types'

/**
 * 输入续写控制项的单一权威定义（仿 shared/narrativeMode.ts）。
 * 剧情转折强度映射推进提示词与 temperature；内容长度映射篇幅提示词与 maxTokens。
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
    label: '平稳延续',
    description: '保持当前走向，不主动加入新事件或转折',
  },
  {
    value: 'steady',
    label: '轻度转折',
    description: '加入小阻碍或新信息，但不改变当前主线',
  },
  {
    value: 'active',
    label: '中度转折',
    description: '引入事件、压力或线索，明显改变当前局势',
  },
  {
    value: 'bold',
    label: '强烈转折',
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
    label: '精简',
    description: '最终内容保持精简，通常为一两句',
  },
  {
    value: 'standard',
    label: '适中',
    description: '最终内容形成一个完整短段落',
  },
  {
    value: 'detailed',
    label: '详细',
    description: '最终内容可展开为两到三个自然段',
  },
  {
    value: 'extended',
    label: '长篇',
    description: '最终内容可充分展开为多个自然段',
  },
]

/** 剧情强度只控制采样创造性，不再隐式改变篇幅。 */
export const CONTINUE_INTENSITY_PARAMS: Record<
  ContinueIntensity,
  { temperature: number }
> = {
  subtle: { temperature: 0.45 },
  steady: { temperature: 0.6 },
  active: { temperature: 0.7 },
  bold: { temperature: 0.85 },
}

/** 内容长度只控制输出预算；standard 保留原 active 档的 1024 token。 */
export const CONTINUE_LENGTH_PARAMS: Record<ContinueLength, { maxTokens: number }> = {
  brief: { maxTokens: 512 },
  standard: { maxTokens: 1024 },
  detailed: { maxTokens: 1536 },
  extended: { maxTokens: 2048 },
}

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
  return CONTINUE_INTENSITY_OPTIONS.find((option) => option.value === intensity)?.label ?? '中度转折'
}

export function getContinueLengthLabel(length: ContinueLength): string {
  return CONTINUE_LENGTH_OPTIONS.find((option) => option.value === length)?.label ?? '适中'
}
