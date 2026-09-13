/**
 * 后台结构化生成任务档案（阶段7 方案 §7.1/§7.2/§7.3）。
 *
 * 区分两类生成任务：
 * - 用户可见生成（单聊、群聊、续写、重生成）：使用主对话篇幅策略（brief/balanced/detailed +
 *   场景系数 + 统一收尾），目标是自然互动、样式完整、可恢复；
 * - 后台结构化生成（长记忆、历史压缩、标题、方向建议）：不得使用"一个互动回合"提示，
 *   也不得复用主对话篇幅档位——目标是完整结构、可解析、低成本。
 *
 * 本模块只提供策略数据与判定，预算换算仍走 shared/modelOutputProfile.resolveRequestBudget
 * （推理型模型用档案/P90 余量，非推理模型不无条件请求大预算）。
 */

export type BackgroundGenerationTask = 'memory' | 'compression' | 'title' | 'direction'

export interface BackgroundGenerationProfile {
  task: BackgroundGenerationTask
  /** 期望正文字符数（预算换算输入，不是硬上限） */
  expectedBodyChars: number
  /**
   * 是否要求完整结构化收尾（如 JSON 代码块闭合、摘要边界完整）。
   * true 时残缺结果必须按任务规则局部保存或丢弃，绝不当作"无内容/无变化"。
   */
  requiresStructuredTail: boolean
  /** 推理余量策略：none = 不预留；model_profile = 按模型能力档案默认/P90 预留 */
  reasoningReservePolicy: 'none' | 'model_profile'
  /** 失败重试策略：structure_only_once = 最多一次"只补结构"的短修复（不重写完整内容） */
  retryPolicy: 'none' | 'structure_only_once'
  /** 触顶（finishReason=length）且结构残缺时的处置 */
  onTruncated: 'discard' | 'keep_partial'
}

/** 各后台任务的固定档案：单聊与群聊共用同一算法，只允许任务体量参数不同 */
export const BACKGROUND_GENERATION_PROFILES: Record<BackgroundGenerationTask, BackgroundGenerationProfile> = {
  memory: {
    task: 'memory',
    expectedBodyChars: 2500,
    requiresStructuredTail: true,
    reasoningReservePolicy: 'model_profile',
    retryPolicy: 'none',
    // 摘要与事实 JSON 分别判断完整性（§7.2）：触顶时摘要完整则保存摘要、
    // 事实提案记为"未更新"，不把残缺 JSON 当作无新增事实
    onTruncated: 'keep_partial',
  },
  compression: {
    task: 'compression',
    expectedBodyChars: 600,
    requiresStructuredTail: false,
    reasoningReservePolicy: 'model_profile',
    retryPolicy: 'none',
    // 历史压缩：有完整摘要边界才保存；失败时原历史不丢（压缩是附加信息）
    onTruncated: 'discard',
  },
  title: {
    task: 'title',
    expectedBodyChars: 20,
    requiresStructuredTail: false,
    reasoningReservePolicy: 'none',
    retryPolicy: 'none',
    // 标题：小预算，触顶直接丢弃结果，不做补尾（保持旧标题）
    onTruncated: 'discard',
  },
  direction: {
    task: 'direction',
    expectedBodyChars: 800,
    requiresStructuredTail: true,
    // 方向请求显式 reasoningMode:'disabled'，不预留推理预算
    reasoningReservePolicy: 'none',
    // 方向建议：结构不完整时最多一次"只补结构"的短修复，不重写完整剧情
    retryPolicy: 'structure_only_once',
    onTruncated: 'discard',
  },
}

/**
 * 结构化收尾完整性判定（后台任务通用）：
 * 摘要类 = 以句末标点收尾的完整文本；JSON 类 = 可解析且通过调用方字段校验。
 * 返回 false 时调用方必须按 onTruncated/retryPolicy 处置，不得静默当作空结果。
 */
export function hasCompleteSummaryTail(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) return false
  return /[。！？…!”’」』）)】》*]$/.test(trimmed)
}
