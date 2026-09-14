/**
 * 回复篇幅策略（方案「对话输出弹性约束与稳定收尾」§4.1 / §4.2）。
 *
 * 职责：把"篇幅模式 + 近期对话节奏"解析成一轮回复的字符软区间与硬保护线。
 * 只负责给出提示范围与保护线，不在生成后机械补字、也不做硬截取。
 *
 * 优先级（高 → 低）：
 * 1. 用户本轮明确要求（userIntent，阶段二接入提示注入）
 * 2. 会话级篇幅选择（sessionMode）
 * 3. 预设篇幅提示（presetHint）
 * 4. 最近已完成助手回复的可见字符中位数（auto 基线回归）
 * 5. 默认"适中"基线
 */

import type { ResponseLengthMode, ResponsePolicy } from './types'

interface LengthRange {
  preferredMinChars: number
  preferredMaxChars: number
  hardMaxChars: number
  targetParagraphs: { min: number; max: number }
  maxNewBeats: number
}

/** 简短 / 适中 / 展开的固定正文软区间与硬保护线（方案 §4.1 表） */
export const RESPONSE_LENGTH_RANGES: Record<Exclude<ResponseLengthMode, 'auto'>, LengthRange> = {  brief: {
    preferredMinChars: 40,
    preferredMaxChars: 140,
    hardMaxChars: 260,
    targetParagraphs: { min: 1, max: 2 },
    maxNewBeats: 1,
  },
  balanced: {
    preferredMinChars: 120,
    preferredMaxChars: 360,
    hardMaxChars: 600,
    targetParagraphs: { min: 1, max: 4 },
    maxNewBeats: 1,
  },
  detailed: {
    preferredMinChars: 300,
    preferredMaxChars: 700,
    hardMaxChars: 1100,
    targetParagraphs: { min: 2, max: 6 },
    maxNewBeats: 2,
  },
}

/** 自动模式硬保护线（可见字符）：任何自动目标都不超过该值 */
export const AUTO_HARD_MAX_CHARS = 900
/** 自动模式默认基线：无近期样本时按"适中"回合估计 */
export const AUTO_DEFAULT_BASELINE_CHARS = 240
/** 自动目标（可见字符）的钳制区间 */
export const AUTO_TARGET_MIN_CHARS = 80
export const AUTO_TARGET_MAX_CHARS = 700
/** 自动模式回归基线采样最近 N 条已完成助手回复（方案 §4.2） */
export const AUTO_BASELINE_WINDOW = 5
/** 自动模式的段落数参考区间与推进节拍数 */
export const AUTO_TARGET_PARAGRAPHS: { min: number; max: number } = { min: 1, max: 5 }
export const AUTO_MAX_NEW_BEATS = 1

/** 篇幅模式的界面显示名（预设编辑器 / 会话快捷设置共用） */
export const RESPONSE_LENGTH_LABELS: Record<ResponseLengthMode, string> = {
  auto: '自动',
  brief: '简短',
  balanced: '适中',
  detailed: '展开',
}

/** 可见字符统计口径：剥离思考块与空白（星号/引号等展示符号属正文，计入） */
export function countVisibleChars(text: string): number {
  if (!text) return 0
  return text
    .replace(/<thought>[\s\S]*?<\/thought>/gi, '')
    .replace(/\s+/g, '')
    .length
}

/** 中位数（偶数个取平均并四舍五入）；无有效样本返回 null */
export function median(values: number[]): number | null {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b)
  if (sorted.length === 0) return null
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1
    ? sorted[mid]
    : Math.round((sorted[mid - 1] + sorted[mid]) / 2)
}

/** 可参与可见字符统计的最小消息形状（单聊 Message / 群聊 GroupMessage 均满足） */
export interface VisibleCharsSource {
  role: string
  content?: string | null
}

/** 从历史消息提取最近 N 条已完成助手回复的可见字符数（时间从旧到新无关，仅取样本） */
export function collectRecentAssistantChars(
  messages: VisibleCharsSource[],
  window: number = AUTO_BASELINE_WINDOW,
): number[] {
  const samples: number[] = []
  for (let i = messages.length - 1; i >= 0 && samples.length < window; i--) {
    const msg = messages[i]
    if (!msg || msg.role !== 'assistant' || !msg.content) continue
    samples.push(countVisibleChars(msg.content))
  }
  return samples
}

export interface ResolveResponsePolicyInput {
  /** 会话级篇幅选择（undefined = 未设置） */
  sessionMode?: ResponseLengthMode | null
  /** 预设篇幅提示（undefined = 未设置） */
  presetHint?: ResponseLengthMode | null
  /** 全局默认篇幅偏好（优先级低于会话与预设）。 */
  defaultMode?: ResponseLengthMode | null
  /** 用户本轮明确要求（如"简短回答/详细描写"）；优先级最高 */
  userIntent?: ResponseLengthMode | null
  /** 最近已完成助手回复的可见字符数样本（自动模式基线） */
  recentAssistantVisibleChars?: number[]
  /** 自动模式场景系数：高压短回合 < 1，开场/展开 > 1；默认 1（阶段二接入识别） */
  sceneFactor?: number
}

const VALID_MODES = new Set<ResponseLengthMode>(['auto', 'brief', 'balanced', 'detailed'])

/**
 * S5：用户本轮明确篇幅要求（窄范围词组识别，不做泛化语义猜测）。
 *
 * 只识别明确的指令式词组；普通叙述内容（如“这本书写得很详细”）不触发。
 * 两组合并命中时以“简短”优先（用户在同一句里既说别太长又说展开时，收紧更安全）。
 */
const BRIEF_INTENT_PATTERNS: RegExp[] = [
  /简短|简洁|简明|简要|精简|从简|言简意赅|长话短说/,
  /简单(点|一点)?(说|讲|说说|讲讲)/,
  /(只|就|请|能|可以|能否)(回答|回复|说|讲)(一|1)句/,
  /(回答|回复|说明|概括)(一|1)句(话)?/,
  /(用|以|只|就|请)?(一|1)句话(回答|回复|说明|概括|总结|说完|说清)/,
  /(短|少)(一点|一些|点)(说|写|讲|回答)?/,
  /(别|不要|不用|无需)(写|说|讲)?(太长|太多|那么长|这么长)/,
]

const DETAILED_INTENT_PATTERNS: RegExp[] = [
  /详细(一点|一些|点|地)?(说|讲|写|描写|说明|展开|说说|讲讲)/,
  /写得?详细(一点|一些|点)?/,
  /(更|再)(加)?详细(一点|一些|点|地)?(说|讲|写)?/,
  /(展开|扩写)(一点|一些|来说|说说|讲讲|地|写)/,
  /(详细|具体)(展开|说说|讲讲|描写|说明)/,
  /具体(说|讲)(说|讲讲)?/,
  /多(写|说)(一点|一些|点)/,
  /(描写|写得)?(细致|丰富)(一点|一些|点)/,
  /(写|说|讲)(长|多)(一点|一些)/,
]

/** 识别本轮用户消息中的明确篇幅要求；无明确词组返回 null（回退会话/预设/自动） */
export function detectUserLengthIntent(text: string | null | undefined): ResponseLengthMode | null {
  const value = (text ?? '').trim()
  if (!value) return null
  if (BRIEF_INTENT_PATTERNS.some((pattern) => pattern.test(value))) return 'brief'
  if (DETAILED_INTENT_PATTERNS.some((pattern) => pattern.test(value))) return 'detailed'
  return null
}

/** 场景切换标记：用户明确开启新场景/转场时才放大（其余情况保持默认系数） */
const SCENE_SHIFT_PATTERN = /【\s*(场景|时间|地点|环境|新场景)\s*】|场景切换|转场|换个场景|换个地方|新的场景/

/** 高压即时问答：短问句（去空白后 ≤ 12 字符且以问号结尾） */
function isQuickExchange(text: string): boolean {
  const compact = text.replace(/\s+/g, '')
  return compact.length > 0 && compact.length <= 12 && /[？?]$/.test(compact)
}

/**
 * S5：自动模式的场景系数——只根据确定事件调整。
 * - 明确场景切换：1.25（给出建立新场景的空间）
 * - 首轮开场：1.15
 * - 高压即时问答（短问句）：0.85（收紧为快速回应）
 * - 其余：1
 */
export function resolveSceneFactor(input: { latestUserText?: string | null; hasAssistantReply: boolean }): number {
  const text = (input.latestUserText ?? '').trim()
  if (text && SCENE_SHIFT_PATTERN.test(text)) return 1.25
  if (!input.hasAssistantReply) return 1.15
  if (isQuickExchange(text)) return 0.85
  return 1
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** 解析篇幅模式与来源；无效值一律视为未设置（回退到下一优先级） */
export function resolveResponseLengthMode(
  input: Pick<ResolveResponsePolicyInput, 'sessionMode' | 'presetHint' | 'defaultMode' | 'userIntent'>,
): { mode: ResponseLengthMode; source: ResponsePolicy['source'] } {
  const userIntent = input.userIntent && VALID_MODES.has(input.userIntent) && input.userIntent !== 'auto'
    ? input.userIntent
    : null
  if (userIntent) return { mode: userIntent, source: 'user' }
  if (input.sessionMode && VALID_MODES.has(input.sessionMode) && input.sessionMode !== 'auto') {
    return { mode: input.sessionMode, source: 'session' }
  }
  if (input.presetHint && VALID_MODES.has(input.presetHint) && input.presetHint !== 'auto') {
    return { mode: input.presetHint, source: 'preset' }
  }
  if (input.defaultMode && VALID_MODES.has(input.defaultMode) && input.defaultMode !== 'auto') {
    return { mode: input.defaultMode, source: 'settings' }
  }
  return { mode: 'auto', source: 'auto' }
}

/**
 * 解析一轮回复的篇幅策略。
 * - 非自动模式：使用固定区间（RESPONSE_LENGTH_RANGES）。
 * - 自动模式：baseline = median(recent) || 240；target = clamp(baseline × sceneFactor, 80, 700)；
 *   preferredMin = 0.55·target，preferredMax = 1.35·target，hardMax = min(1.7·preferredMax, 900)。
 */
export function resolveResponsePolicy(input: ResolveResponsePolicyInput): ResponsePolicy {
  const { mode, source } = resolveResponseLengthMode(input)
  if (mode !== 'auto') {
    const range = RESPONSE_LENGTH_RANGES[mode]
    return { mode, source, ...range }
  }

  const baseline = median(input.recentAssistantVisibleChars ?? []) ?? AUTO_DEFAULT_BASELINE_CHARS
  const sceneFactor = clamp(
    input.sceneFactor != null && Number.isFinite(input.sceneFactor) ? input.sceneFactor : 1,
    0.5,
    2,
  )
  const target = clamp(Math.round(baseline * sceneFactor), AUTO_TARGET_MIN_CHARS, AUTO_TARGET_MAX_CHARS)
  const preferredMinChars = Math.round(target * 0.55)
  const preferredMaxChars = Math.round(target * 1.35)
  const hardMaxChars = Math.min(Math.round(preferredMaxChars * 1.7), AUTO_HARD_MAX_CHARS)
  return {
    mode: 'auto',
    source,
    preferredMinChars,
    preferredMaxChars,
    hardMaxChars,
    targetParagraphs: AUTO_TARGET_PARAGRAPHS,
    maxNewBeats: AUTO_MAX_NEW_BEATS,
  }
}
