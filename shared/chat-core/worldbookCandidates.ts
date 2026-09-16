/**
 * W9（主计划 §7.11）：世界书条目 → 统一候选，交给 W7 分配器做"统一剩余预算"竞争——纯函数，无 IO。
 *
 * 本期（W9 影子）只做到"候选化 + 影子对照"：
 * - 生产注入仍由 `executeLorebookRuntime` 的分桶瀑布（30% 固定比例 + always 40% 硬上限）决定；
 * - 本模块结果进入影子报告，作为 G1 通过后"世界书层接管"的决策证据；
 * - **always → mandatory**：常驻条目在预算可行时必须保留（§7.11 第 2 条）；
 * - 评分直接复用统一运行时的 `score`（关键词+语义+实体+近因），不新建第二套评分；
 * - 候选只携带 key / 枚举 / 计数 / 数值，不携带正文（§4.4）。
 */

import {
  allocateContextCandidates,
  type ContextAllocationResult,
  type ContextCandidate,
} from './contextCandidates'
import type { LorebookScoredEntrySnapshot } from './lorebook'

/** always 条目的重要度（候选层升到"相关上下文"顺位） */
export const WORLDBOOK_ALWAYS_IMPORTANCE = 0.9
/** conditional 条目的基础重要度 */
export const WORLDBOOK_CONDITIONAL_IMPORTANCE = 0.55
/** detail 条目的基础重要度 */
export const WORLDBOOK_DETAIL_IMPORTANCE = 0.35

/**
 * 评分归一到 0~1：统一 score 权重和为 1（keyword/semantic/entity/recency），
 * 超界截到 1，缺失按 0。
 */
export function normalizeWorldbookScore(score: number | null | undefined): number {
  if (typeof score !== 'number' || !Number.isFinite(score) || score <= 0) return 0
  return score > 1 ? 1 : score
}

/** 位置 → 渲染锚点 origin（差异解释用；at_depth 带 depth） */
export function worldbookOrigin(snapshot: Pick<LorebookScoredEntrySnapshot, 'position' | 'depth'>): string {
  switch (snapshot.position) {
    case 'before_char': return 'worldbook:before_character'
    case 'after_char': return 'worldbook:after_character'
    case 'at_depth': return `worldbook:chat_depth:${snapshot.depth ?? 0}`
    case 'at_end':
    default: return 'worldbook:prompt_end'
  }
}

/** 既有实现实际注入的统计（分桶口径） */
export interface WorldbookInjectionStats {
  /** 既有保留条目数 */
  keptCount: number
  keptTokens: number
  /** 既有被预算/书级丢弃条目数 */
  droppedCount: number
  droppedTokens: number
  /** always 被截断条目数 */
  alwaysDropped: number
  /** 既有实现使用的世界书专属预算（固定比例） */
  legacyCapTokens: number
  keptAlwaysCount: number
  keptConditionalCount: number
  keptDetailCount: number
  alwaysKeptTokens: number
  conditionalKeptTokens: number
  detailKeptTokens: number
  /** 以 summary 替代全文注入的条目数 */
  summaryFallbackCount: number
}

export interface WorldbookCandidateSet {
  candidates: ContextCandidate[]
  /** 候选 id → 原条目 key */
  keyByCandidateId: Record<string, string>
  /** 候选 id → 优先级（分层差异解释） */
  priorityByCandidateId: Record<string, 'always' | 'conditional' | 'detail'>
  described: {
    totalCount: number
    totalTokens: number
    alwaysCount: number
    alwaysTokens: number
    conditionalCount: number
    detailCount: number
  }
}

/**
 * 世界书条目 → 候选集合（确定性）：
 * - always → `mandatory: true`（§7.11 第 2 条）；
 * - relevance 直接复用统一 score；importance 按优先级分层；
 * - 丢弃条目也进入候选（"既有没注入 vs 影子会不会选"是接管对照的核心）。
 */
export function buildWorldbookCandidateSet(
  snapshots: readonly LorebookScoredEntrySnapshot[] | null | undefined,
): WorldbookCandidateSet {
  const candidates: ContextCandidate[] = []
  const keyByCandidateId: Record<string, string> = {}
  const priorityByCandidateId: Record<string, 'always' | 'conditional' | 'detail'> = {}
  let alwaysCount = 0
  let alwaysTokens = 0
  let conditionalCount = 0
  let detailCount = 0
  let totalTokens = 0

  const list = Array.isArray(snapshots) ? snapshots : []
  // 与运行时一致的稳定顺序：order 升序 → key
  const ordered = [...list].sort(
    (a, b) => (a.order - b.order) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  )

  ordered.forEach((snapshot, index) => {
    if (!snapshot?.key) return
    const tokens = Math.max(0, Math.floor(Number.isFinite(snapshot.tokens) ? snapshot.tokens : 0))
    if (tokens <= 0 && !snapshot.ignoreBudget) return
    const priority = snapshot.priority ?? 'conditional'
    const mandatory = priority === 'always'
    const importance = priority === 'always'
      ? WORLDBOOK_ALWAYS_IMPORTANCE
      : priority === 'detail'
        ? WORLDBOOK_DETAIL_IMPORTANCE
        : WORLDBOOK_CONDITIONAL_IMPORTANCE
    const id = `worldbook:${snapshot.key}`
    keyByCandidateId[id] = snapshot.key
    priorityByCandidateId[id] = priority
    candidates.push({
      id,
      kind: 'worldbook',
      estimatedTokens: tokens,
      mandatory,
      // 世界书 before/after_character 与 prompt_end 进入 system 稳定前缀；
      // at_depth 插在历史中间，不进稳定前缀。
      stablePrefix: snapshot.position !== 'at_depth',
      relevance: normalizeWorldbookScore(snapshot.score),
      recency: 0.5,
      importance,
      continuity: priority === 'always' ? 0.7 : 0.45,
      dedupeKey: `lore:${snapshot.key}`,
      originalOrder: index,
      origin: worldbookOrigin(snapshot),
    })
    totalTokens += tokens
    if (mandatory) {
      alwaysCount += 1
      alwaysTokens += tokens
    } else if (priority === 'detail') {
      detailCount += 1
    } else {
      conditionalCount += 1
    }
  })

  return {
    candidates,
    keyByCandidateId,
    priorityByCandidateId,
    described: {
      totalCount: candidates.length,
      totalTokens,
      alwaysCount,
      alwaysTokens,
      conditionalCount,
      detailCount,
    },
  }
}

/** 从运行时快照汇总"既有实现实际注入"一侧 */
export function summarizeWorldbookInjection(
  snapshots: readonly LorebookScoredEntrySnapshot[] | null | undefined,
  legacyCapTokens: number,
): WorldbookInjectionStats {
  const list = Array.isArray(snapshots) ? snapshots : []
  const stats: WorldbookInjectionStats = {
    keptCount: 0,
    keptTokens: 0,
    droppedCount: 0,
    droppedTokens: 0,
    alwaysDropped: 0,
    legacyCapTokens: Math.max(0, Math.floor(legacyCapTokens)),
    keptAlwaysCount: 0,
    keptConditionalCount: 0,
    keptDetailCount: 0,
    alwaysKeptTokens: 0,
    conditionalKeptTokens: 0,
    detailKeptTokens: 0,
    summaryFallbackCount: 0,
  }
  for (const snapshot of list) {
    const tokens = Math.max(0, Math.floor(Number.isFinite(snapshot.tokens) ? snapshot.tokens : 0))
    if (snapshot.kept) {
      stats.keptCount += 1
      stats.keptTokens += tokens
      if (snapshot.priority === 'always') {
        stats.keptAlwaysCount += 1
        stats.alwaysKeptTokens += tokens
      } else if (snapshot.priority === 'detail') {
        stats.keptDetailCount += 1
        stats.detailKeptTokens += tokens
      } else {
        stats.keptConditionalCount += 1
        stats.conditionalKeptTokens += tokens
      }
      if (snapshot.usedSummary) stats.summaryFallbackCount += 1
    } else {
      stats.droppedCount += 1
      stats.droppedTokens += tokens
      if (snapshot.priority === 'always') stats.alwaysDropped += 1
    }
  }
  return stats
}

export interface WorldbookLayerDiff {
  priority: 'always' | 'conditional' | 'detail'
  existingCount: number
  existingTokens: number
  candidateCount: number
  candidateTokens: number
  candidateDroppedCount: number
}

export interface WorldbookShadowReport {
  mode: 'worldbook-shadow'
  budgetTokens: number
  /** 既有世界书专属预算（固定比例） */
  legacyCapTokens: number
  existing: WorldbookInjectionStats
  candidate: {
    selectedCount: number
    selectedTokens: number
    droppedCount: number
    alwaysMandatoryCount: number
    alwaysSelectedCount: number
    alwaysDroppedCount: number
    overBudget: boolean
    mandatoryOverBudget: boolean
  }
  /** candidate.selectedTokens − existing.keptTokens */
  deltaTokens: number
  /** 候选侧突破既有世界书专属上限（统一池竞争的预期差异） */
  exceedsLegacyCap: boolean
  byPriority: WorldbookLayerDiff[]
  /** 采集/选择异常兜底 */
  degraded: boolean
}

function degradedWorldbookShadow(
  existing: WorldbookInjectionStats,
  budgetTokens: number,
): WorldbookShadowReport {
  return {
    mode: 'worldbook-shadow',
    budgetTokens: Math.max(0, Math.floor(Number.isFinite(budgetTokens) ? budgetTokens : 0)),
    legacyCapTokens: existing.legacyCapTokens,
    existing,
    candidate: {
      selectedCount: 0,
      selectedTokens: 0,
      droppedCount: 0,
      alwaysMandatoryCount: 0,
      alwaysSelectedCount: 0,
      alwaysDroppedCount: 0,
      overBudget: false,
      mandatoryOverBudget: false,
    },
    deltaTokens: -existing.keptTokens,
    exceedsLegacyCap: false,
    byPriority: [
      { priority: 'always', existingCount: existing.keptAlwaysCount, existingTokens: existing.alwaysKeptTokens, candidateCount: 0, candidateTokens: 0, candidateDroppedCount: 0 },
      { priority: 'conditional', existingCount: existing.keptConditionalCount, existingTokens: existing.conditionalKeptTokens, candidateCount: 0, candidateTokens: 0, candidateDroppedCount: 0 },
      { priority: 'detail', existingCount: existing.keptDetailCount, existingTokens: existing.detailKeptTokens, candidateCount: 0, candidateTokens: 0, candidateDroppedCount: 0 },
    ],
    degraded: true,
  }
}

/**
 * 世界书专项影子报告：既有固定比例注入 vs 候选统一预算选择。
 * 竞争对手（协议/角色/记忆/历史/示例）由调用方传入，使差异可解释到"统一池"口径。
 */
export function buildWorldbookShadowReport(input: {
  plan: WorldbookCandidateSet
  existing: WorldbookInjectionStats
  budgetTokens: number
  competitors?: readonly ContextCandidate[]
}): WorldbookShadowReport {
  try {
    const { plan, existing } = input
    const competitors = input.competitors ?? []
    const allocation: ContextAllocationResult = allocateContextCandidates(
      [...plan.candidates, ...competitors],
      { budgetTokens: input.budgetTokens },
    )
    let selectedCount = 0
    let selectedTokens = 0
    let droppedCount = 0
    let alwaysSelectedCount = 0
    let alwaysDroppedCount = 0
    const byPriorityPriority = ['always', 'conditional', 'detail'] as const
    const selectedIdSet = new Set(allocation.selectedIds)
    const byPriority = byPriorityPriority.map((priority) => {
      const layer = plan.candidates.filter(
        (candidate) => plan.priorityByCandidateId[candidate.id] === priority,
      )
      let candidateTokens = 0
      let candidateDroppedCount = 0
      for (const candidate of layer) {
        if (selectedIdSet.has(candidate.id)) {
          candidateTokens += candidate.estimatedTokens
        } else {
          candidateDroppedCount += 1
        }
      }
      const existingCount = priority === 'always'
        ? existing.keptAlwaysCount
        : priority === 'detail'
          ? existing.keptDetailCount
          : existing.keptConditionalCount
      const existingTokens = priority === 'always'
        ? existing.alwaysKeptTokens
        : priority === 'detail'
          ? existing.detailKeptTokens
          : existing.conditionalKeptTokens
      return {
        priority,
        existingCount,
        existingTokens,
        candidateCount: layer.length,
        candidateTokens,
        candidateDroppedCount,
      }
    })
    for (const candidate of allocation.selected) {
      if (!plan.keyByCandidateId[candidate.id]) continue
      selectedCount += 1
      selectedTokens += candidate.estimatedTokens
      if (candidate.mandatory) alwaysSelectedCount += 1
    }
    for (const candidate of plan.candidates) {
      if (selectedIdSet.has(candidate.id)) continue
      droppedCount += 1
      if (candidate.mandatory) alwaysDroppedCount += 1
    }
    return {
      mode: 'worldbook-shadow',
      budgetTokens: allocation.effectiveBudgetTokens,
      legacyCapTokens: existing.legacyCapTokens,
      existing,
      candidate: {
        selectedCount,
        selectedTokens,
        droppedCount,
        alwaysMandatoryCount: plan.described.alwaysCount,
        alwaysSelectedCount,
        alwaysDroppedCount,
        overBudget: allocation.overBudget,
        mandatoryOverBudget: allocation.mandatoryOverBudget,
      },
      deltaTokens: selectedTokens - existing.keptTokens,
      exceedsLegacyCap: selectedTokens > existing.legacyCapTokens,
      byPriority,
      degraded: false,
    }
  } catch {
    return degradedWorldbookShadow(input.existing, input.budgetTokens)
  }
}

/** 数值化日志串（不含正文/条目内容/提示词） */
export function formatWorldbookShadowSummary(report: WorldbookShadowReport): string {
  const layers = report.byPriority
    .map((diff) => `${diff.priority}:${diff.existingTokens}->${diff.candidateTokens}/${diff.existingCount}->${diff.candidateCount}`)
    .join(',')
  return [
    'mode=worldbook-shadow',
    `budget=${report.budgetTokens}`,
    `cap=${report.legacyCapTokens}`,
    `existing=${report.existing.keptTokens}`,
    `candidate=${report.candidate.selectedTokens}`,
    `delta=${report.deltaTokens}`,
    `exceedsCap=${report.exceedsLegacyCap ? 1 : 0}`,
    `alwaysSel=${report.candidate.alwaysSelectedCount}/${report.candidate.alwaysMandatoryCount}`,
    `alwaysDrop=${report.candidate.alwaysDroppedCount}`,
    `mandatoryOver=${report.candidate.mandatoryOverBudget ? 1 : 0}`,
    `degraded=${report.degraded ? 1 : 0}`,
    `layers=${layers}`,
  ].join(' ')
}
