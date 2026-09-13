/**
 * W7（主计划 §5.5 / §7.9）：统一上下文候选与确定性分配器——纯函数，无 IO。
 *
 * 定位：
 * - 现有 `contextBuilder` 的各层预算仍由分散的固定策略决定（长记忆 `min(800, budgetBase*0.1)`、
 *   世界书 30% 与 0.4/0.9 分桶、历史尾部裁剪）；本模块把这些"块"统一描述成 `ContextCandidate`，
 *   用同一套确定性规则做去重、排序与预算选择，供 W8/W9 逐类接管；
 * - **W7 只影子运行**：候选选择结果不参与生产注入，`messages` / `maxTokens` 不受影响；
 * - 相同输入必须得到相同顺序与选择：`tier` → 评分 → `originalOrder` → `id` 四级 tie-break，
 *   避免缓存前缀抖动；
 * - 候选只携带数值元数据与稳定 id，**不携带任何正文、提示词或 URL**，因此影子记录天然不含内容。
 *
 * 职责边界：
 * - 本模块不计算输出预算（`resolveRequestBudget` 是唯一入口），只回答"给定输入预算内保留哪些块"；
 * - 本模块不读写存储：分配结果只影响"本轮是否注入"，持久化记忆永不因本轮分配被删除（§5.5 第 6 条）。
 */

/** 候选分类（主计划 §5.5 的 `ContextCandidate.kind`） */
export type ContextCandidateKind =
  | 'protocol'
  | 'character'
  | 'current-state'
  | 'memory'
  | 'worldbook'
  | 'history'
  | 'example'
  | 'group-state'

/** 全部候选分类（报告与统计按此顺序生成，保证输出稳定） */
export const CONTEXT_CANDIDATE_KINDS: readonly ContextCandidateKind[] = [
  'protocol',
  'character',
  'current-state',
  'memory',
  'worldbook',
  'history',
  'example',
  'group-state',
]

/**
 * 统一上下文候选（主计划 §5.5）。
 * 数值项统一按 0~1 归一化口径使用；`rel×0.35 + rec×0.25 + imp×0.25 + con×0.15` 为块内评分。
 */
export interface ContextCandidate {
  /** 稳定 id（同一逻辑块跨轮保持一致，供排序与去重解释） */
  id: string
  kind: ContextCandidateKind
  estimatedTokens: number
  /** mandatory 块在预算可行时必须保留（协议、当前用户消息、角色核心、当前场景） */
  mandatory: boolean
  /** 稳定前缀块：顺序抖动会破坏供应商前缀缓存 */
  stablePrefix: boolean
  /** 与当前输入的相关度 0~1 */
  relevance: number
  /** 时间近因 0~1 */
  recency: number
  /** 设定/记忆自身重要度 0~1 */
  importance: number
  /** 与最近连续对话的连续性 0~1 */
  continuity: number
  /** 同一键最多保留一项（如同一事实 id、同一世界书条目键） */
  dedupeKey?: string
  /** 原始注入顺序（tie-break，越小越先） */
  originalOrder: number
  /** 只用于解释差异的来源细分（如 `worldbook:before_char`）；不参与排序 */
  origin?: string
}

/** 块内评分权重（合计 1，便于把评分直接理解为 0~1 的可信度） */
export const CANDIDATE_SCORE_WEIGHTS = {
  relevance: 0.35,
  recency: 0.25,
  importance: 0.25,
  continuity: 0.15,
} as const

/**
 * 分类基准优先级（主计划 §5.5 分配顺序的机械表达，数字越小越先保留）：
 * 0 = 协议/角色核心等结构性块（mandatory 亦落在此层）；
 * 1 = 最近连续对话与当前群聊参与者状态；
 * 2 = 当前状态、相关长期事实与高相关世界书；
 * 3 = 示例、低相关记忆、较早原始历史。
 */
export const KIND_BASE_TIER: Record<ContextCandidateKind, number> = {
  protocol: 0,
  character: 0,
  'group-state': 1,
  'current-state': 2,
  memory: 2,
  worldbook: 2,
  history: 3,
  example: 3,
}

/** 结构性块（协议、角色核心）顺位 */
export const TIER_STRUCTURAL = 0
/** 最近连续对话与当前群聊参与者状态顺位 */
export const TIER_RECENT_DIALOGUE = 1
/** 当前状态、相关长期事实、高相关世界书顺位 */
export const TIER_RELEVANT_CONTEXT = 2
/** 示例、低相关记忆、较早原始历史顺位 */
export const TIER_LOW_VALUE = 3

/** 历史消息达到该近因时视为"最近连续对话"（升到第 2 顺位） */
export const RECENT_HISTORY_RECENCY = 0.5

/** 记忆/世界书达到该相关度时视为"高相关"（升到第 3 顺位） */
export const HIGH_RELEVANCE_THRESHOLD = 0.5

/** 归一化 0~1 评分：非有限/负数视为 0，超过 1 截到 1 */
export function normalizeCandidateScore(value: number | null | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0
  return value > 1 ? 1 : value
}

/** 归一化 token 估计：非有限/负数视为 0，其余向上取整 */
export function normalizeCandidateTokens(value: number | null | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0
  return Math.ceil(value)
}

/**
 * 净化候选：数值越界、缺 id、缺 kind 都不再让分配崩溃。
 * `index` 仅用于给缺 id 的候选生成确定性兜底 id（不引入随机性）。
 */
export function normalizeContextCandidate(
  candidate: ContextCandidate,
  index = 0,
): ContextCandidate {
  const kind = (CONTEXT_CANDIDATE_KINDS as readonly string[]).includes(candidate.kind)
    ? candidate.kind
    : 'history'
  const rawId = typeof candidate.id === 'string' ? candidate.id.trim() : ''
  const originalOrder = Number.isFinite(candidate.originalOrder) ? candidate.originalOrder : index
  return {
    ...candidate,
    id: rawId || `candidate#${index}`,
    kind,
    estimatedTokens: normalizeCandidateTokens(candidate.estimatedTokens),
    mandatory: candidate.mandatory === true,
    stablePrefix: candidate.stablePrefix === true,
    relevance: normalizeCandidateScore(candidate.relevance),
    recency: normalizeCandidateScore(candidate.recency),
    importance: normalizeCandidateScore(candidate.importance),
    continuity: normalizeCandidateScore(candidate.continuity),
    originalOrder,
    ...(candidate.dedupeKey ? { dedupeKey: candidate.dedupeKey } : {}),
  }
}

/** 块内评分（0~1，保留 6 位小数消除浮点噪声，保证同分判定稳定） */
export function candidateScore(candidate: ContextCandidate): number {
  const raw =
    normalizeCandidateScore(candidate.relevance) * CANDIDATE_SCORE_WEIGHTS.relevance +
    normalizeCandidateScore(candidate.recency) * CANDIDATE_SCORE_WEIGHTS.recency +
    normalizeCandidateScore(candidate.importance) * CANDIDATE_SCORE_WEIGHTS.importance +
    normalizeCandidateScore(candidate.continuity) * CANDIDATE_SCORE_WEIGHTS.continuity
  return Math.round(raw * 1e6) / 1e6
}

/**
 * 分配顺位：mandatory 恒为 0；历史按近因、记忆/世界书按相关度在同层内升降
 * （§5.5 第 2–4 条："最近连续对话"高于"高相关世界书/长期事实"高于"较早原始历史"）。
 */
export function candidateTier(candidate: ContextCandidate): number {
  if (candidate.mandatory) return TIER_STRUCTURAL
  if (candidate.kind === 'history') {
    return normalizeCandidateScore(candidate.recency) >= RECENT_HISTORY_RECENCY
      ? TIER_RECENT_DIALOGUE
      : TIER_LOW_VALUE
  }
  if (candidate.kind === 'memory' || candidate.kind === 'worldbook') {
    return normalizeCandidateScore(candidate.relevance) >= HIGH_RELEVANCE_THRESHOLD
      ? TIER_RELEVANT_CONTEXT
      : TIER_LOW_VALUE
  }
  return KIND_BASE_TIER[candidate.kind] ?? TIER_LOW_VALUE
}

/**
 * 确定性排序比较器：顺位 → 评分降序 → 原始顺序 → id。
 * 相同输入必得相同顺序；同分不再依赖 Array.sort 的实现细节。
 */
export function compareCandidates(a: ContextCandidate, b: ContextCandidate): number {
  const tierDiff = candidateTier(a) - candidateTier(b)
  if (tierDiff !== 0) return tierDiff
  const scoreDiff = candidateScore(b) - candidateScore(a)
  if (scoreDiff !== 0) return scoreDiff
  if (a.originalOrder !== b.originalOrder) return a.originalOrder - b.originalOrder
  if (a.id === b.id) return 0
  return a.id < b.id ? -1 : 1
}

/** 按确定性顺序返回新数组（不修改入参） */
export function rankCandidates(candidates: readonly ContextCandidate[]): ContextCandidate[] {
  return candidates.map((candidate, index) => normalizeContextCandidate(candidate, index)).sort(compareCandidates)
}

/** 去重结果：同一 `dedupeKey` 只保留排序最靠前的一项 */
export interface CandidateDedupeResult {
  /** 保序的保留集合（按入参顺序） */
  unique: ContextCandidate[]
  /** 被去重掉的候选 id（按确定性顺序，供解释差异） */
  duplicateIds: string[]
}

/** 同一 `dedupeKey` 最多保留一项：保留排序最靠前者，其余计入 `duplicateIds` */
export function dedupeCandidates(candidates: readonly ContextCandidate[]): CandidateDedupeResult {
  const ranked = rankCandidates(candidates)
  const representative = new Map<string, string>()
  const duplicateIds: string[] = []
  for (const candidate of ranked) {
    if (!candidate.dedupeKey) continue
    if (representative.has(candidate.dedupeKey)) {
      duplicateIds.push(candidate.id)
      continue
    }
    representative.set(candidate.dedupeKey, candidate.id)
  }
  const keptIds = new Set(representative.values())
  const unique = ranked
    .filter((candidate) => !candidate.dedupeKey || keptIds.has(candidate.id))
    .sort((a, b) => (a.originalOrder - b.originalOrder) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return { unique, duplicateIds }
}

/** 分类统计（只有数量与 token，不含任何内容） */
export interface ContextKindStat {
  count: number
  tokens: number
  mandatoryCount: number
  selectedCount: number
  selectedTokens: number
  stablePrefixTokens: number
  droppedCount: number
}

export interface ContextAllocationOptions {
  /** 本轮可用于输入内容的预算（通常为既有 `budgetBase`） */
  budgetTokens: number
  /** 已在别处占用、不再参与选择的 token（如图片/工具定义预先计入）；默认 0 */
  reservedTokens?: number
}

export interface ContextAllocationResult {
  /** 入选候选 id（按确定性顺序） */
  selectedIds: string[]
  selected: ContextCandidate[]
  /** 未入选候选 id（按确定性顺序） */
  droppedIds: string[]
  selectedTokens: number
  /** mandatory 块合计 token（预算不可行判定用） */
  mandatoryTokens: number
  /** 有效预算 = budgetTokens − reservedTokens（下限 0） */
  effectiveBudgetTokens: number
  /** 实际选择量超过有效预算（只可能因 mandatory 强制保留） */
  overBudget: boolean
  /** mandatory 单独即超出有效预算：预算不可行，需调用方降级（W9）而非静默截断 */
  mandatoryOverBudget: boolean
  /** 因 `dedupeKey` 重复被丢弃的候选 id */
  dedupedIds: string[]
  /** 入选的稳定前缀块 token（前缀缓存抖动诊断） */
  stablePrefixSelectedTokens: number
  byKind: Record<ContextCandidateKind, ContextKindStat>
}

function emptyKindStats(): Record<ContextCandidateKind, ContextKindStat> {
  const stats = {} as Record<ContextCandidateKind, ContextKindStat>
  for (const kind of CONTEXT_CANDIDATE_KINDS) {
    stats[kind] = {
      count: 0,
      tokens: 0,
      mandatoryCount: 0,
      selectedCount: 0,
      selectedTokens: 0,
      stablePrefixTokens: 0,
      droppedCount: 0,
    }
  }
  return stats
}

export interface ContextCandidateSummary {
  count: number
  tokens: number
  mandatoryCount: number
  stablePrefixTokens: number
  byKind: Record<ContextCandidateKind, ContextKindStat>
}

/** 汇总候选数量与 token（"现有实现选择的块"一侧口径） */
export function summarizeCandidates(candidates: readonly ContextCandidate[]): ContextCandidateSummary {
  const byKind = emptyKindStats()
  let count = 0
  let tokens = 0
  let mandatoryCount = 0
  let stablePrefixTokens = 0
  candidates.forEach((raw, index) => {
    const candidate = normalizeContextCandidate(raw, index)
    const stat = byKind[candidate.kind]
    count += 1
    tokens += candidate.estimatedTokens
    stat.count += 1
    stat.tokens += candidate.estimatedTokens
    if (candidate.mandatory) {
      mandatoryCount += 1
      stat.mandatoryCount += 1
    }
    if (candidate.stablePrefix) stablePrefixTokens += candidate.estimatedTokens
  })
  return { count, tokens, mandatoryCount, stablePrefixTokens, byKind }
}

/**
 * 确定性预算选择（主计划 §7.9 第 2 条）：
 * 1. 净化 → 去重（同 `dedupeKey` 只留最优）→ 确定性排序；
 * 2. mandatory 全量保留（预算不可行也保留，由 `mandatoryOverBudget` 显式暴露）；
 * 3. 其余按顺序"能放下就放"，放不下跳过继续（单块超限不阻塞后续小块）；
 * 4. 结果对预算单调：预算增大只会新增入选块，不会移除已入选的高优先块。
 */
export function allocateContextCandidates(
  candidates: readonly ContextCandidate[],
  options: ContextAllocationOptions,
): ContextAllocationResult {
  const budgetTokens = normalizeCandidateTokens(options.budgetTokens)
  const reservedTokens = normalizeCandidateTokens(options.reservedTokens ?? 0)
  const effectiveBudgetTokens = Math.max(0, budgetTokens - reservedTokens)

  const sanitized = candidates.map((candidate, index) => normalizeContextCandidate(candidate, index))
  const { unique, duplicateIds } = dedupeCandidates(sanitized)
  const ranked = rankCandidates(unique)

  const byKind = emptyKindStats()
  for (const candidate of sanitized) {
    const stat = byKind[candidate.kind]
    stat.count += 1
    stat.tokens += candidate.estimatedTokens
    if (candidate.mandatory) stat.mandatoryCount += 1
  }

  const selected: ContextCandidate[] = []
  let selectedTokens = 0
  for (const candidate of ranked) {
    if (!candidate.mandatory) continue
    selected.push(candidate)
    selectedTokens += candidate.estimatedTokens
  }
  const mandatoryTokens = selectedTokens
  const mandatoryOverBudget = mandatoryTokens > effectiveBudgetTokens
  if (!mandatoryOverBudget) {
    for (const candidate of ranked) {
      if (candidate.mandatory) continue
      if (selectedTokens + candidate.estimatedTokens > effectiveBudgetTokens) continue
      selected.push(candidate)
      selectedTokens += candidate.estimatedTokens
    }
  }
  // mandatory 与其余块的相对顺序已是确定性的，这里统一按确定性顺序输出
  selected.sort(compareCandidates)

  const selectedIdSet = new Set(selected.map((candidate) => candidate.id))
  let stablePrefixSelectedTokens = 0
  for (const candidate of selected) {
    const stat = byKind[candidate.kind]
    stat.selectedCount += 1
    stat.selectedTokens += candidate.estimatedTokens
    if (candidate.stablePrefix) {
      stat.stablePrefixTokens += candidate.estimatedTokens
      stablePrefixSelectedTokens += candidate.estimatedTokens
    }
  }
  for (const kind of CONTEXT_CANDIDATE_KINDS) {
    byKind[kind].droppedCount = byKind[kind].count - byKind[kind].selectedCount
  }

  return {
    selectedIds: selected.map((candidate) => candidate.id),
    selected,
    droppedIds: ranked.filter((candidate) => !selectedIdSet.has(candidate.id)).map((candidate) => candidate.id),
    selectedTokens,
    mandatoryTokens,
    effectiveBudgetTokens,
    overBudget: selectedTokens > effectiveBudgetTokens,
    mandatoryOverBudget,
    dedupedIds: duplicateIds,
    stablePrefixSelectedTokens,
    byKind,
  }
}
