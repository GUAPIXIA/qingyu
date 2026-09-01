// ===================== 共享常量（单聊 / 群聊 store 通用） =====================

/** 流式更新节流时间（毫秒）- 避免每个 chunk 都触发重渲染 */
/** 流式 flush 节流间隔（ms）：80ms 兼顾跟手感与 Markdown 重解析开销（每秒 ~12 次） */
export const STREAM_THROTTLE_MS = 80

/** 默认世界书扫描深度（最近 N 条消息） */
export const DEFAULT_LOREBOOK_SCAN_DEPTH = 10

/** 解析激活世界书扫描深度；存在显式配置时允许低于默认值。 */
export function resolveLorebookScanDepth(
  depths: Array<number | null | undefined>,
  fallback: number = DEFAULT_LOREBOOK_SCAN_DEPTH,
): number {
  const valid = depths.filter((depth): depth is number =>
    typeof depth === 'number' && Number.isFinite(depth) && depth >= 0)
  return valid.length > 0 ? Math.max(...valid) : fallback
}

/** 语义触发扫描文本的 token 上限（大上下文下扩大语义判断范围） */
export const SEMANTIC_SCAN_MAX_TOKENS = 4000

/** 世界书 token 预算占上下文预算（budgetBase）的默认比例 */
export const DEFAULT_LOREBOOK_RATIO = 0.3

/**
 * 世界书优先级分桶的累积预算上限（瀑布式：额度自上而下流动，低段未用完的自动留给高段）。
 * - always：常驻段自身的硬上限，保护 conditional/detail 不被常驻条目挤占；
 * - alwaysPlusConditional：常驻+条件段的累计上限，仅本轮有 detail 条目触发时生效
 *   （否则 conditional 可用满全额，旧世界书行为精确一致）。
 */
export const LOREBOOK_PRIORITY_BUDGET = {
  always: 0.4,
  alwaysPlusConditional: 0.9,
} as const

/**
 * 世界书统一评分权重（阶段二B）：关键词命中 / 语义相似度 / 实体命中 / 近因加权。
 * keywordHits 与 semanticScore 均归一化到 0-1；entity / recency 为 0-1 布尔加成。
 */
export const LOREBOOK_SCORE_WEIGHTS = {
  keyword: 0.35,
  semantic: 0.35,
  entity: 0.15,
  recency: 0.15,
} as const

/** 最近多少轮内触发过的世界书条目获得 recency 加权 */
export const LOREBOOK_RECENCY_WINDOW = 5

/** 启发式 token 估算的安全余量系数（吸收估算误差，替代精确计数） */
export const TOKEN_BUDGET_SAFETY = 0.95

/** 输出预留兜底值（preset.maxTokens 缺省时） */
export const DEFAULT_RESERVED_OUTPUT = 1024

/** 翻译输出 token 预算：按输入长度自适应
 *  输出量 ≈ 输入量（中英互译），但推理模型的思考（reasoning）会额外占用输出预算，
 *  因此预留 2048 下限（普通模型基本都支持）与 8192 上限（推理模型思考+正文）。
 *  固定大值会超出部分模型输出上限导致 400 错误，短文本也会不必要地放大超限风险。 */
export function translationMaxTokens(inputText: string): number {
  // 字符→token 粗估：英文约 4 字符/token，中文约 1 字符/token，取 1.5 系数偏保守
  const estimatedOutput = Math.ceil(inputText.length * 1.5)
  return Math.min(8192, Math.max(2048, estimatedOutput))
}

/** 图片消息的 token 估算（每张） */
export const IMAGE_TOKEN_ESTIMATE = 200

/** 长记忆摘要默认取最近消息数 */
export const MEMORY_SUMMARY_RECENT = 20

/** 长记忆摘要最少消息数 */
export const MEMORY_SUMMARY_MIN = 4

/**
 * 流式空闲超时：超过该时长未收到任何 chunk 则视为卡死并中断。
 * 每次收到 chunk 都会续期（空闲计时），对慢推理模型也公平。
 */
export const STREAM_IDLE_TIMEOUT_MS = 60 * 1000
