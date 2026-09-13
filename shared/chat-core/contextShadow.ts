/**
 * W7（主计划 §7.9 第 3 条 / §5.5）：`ContextAllocator` 影子运行采集器——无 IO、不含正文。
 *
 * 工作方式：
 * - `contextBuilder` 在**真实注入点**逐块调用 `note(...)`，只把"分类 + token 估算 + 数值评分元数据"
 *   交给采集器；提示词文本用完即弃，不进候选、不进报告；
 * - `collect()` 用同一批候选跑一次 `allocateContextCandidates`，得到"影子选择"，
 *   与"现有实现实际注入的块"做分类 token/数量差异，供 W8/W9 逐类接管时对照；
 * - **结果不参与生产注入**：采集器不持有消息数组，也不返回任何要发给模型的文本，
 *   调用方拿到 `messages` / `maxTokens` 的路径完全不变；
 * - 采集永远不得影响生成：`collect()` 内部兜底，异常时返回 `degraded: true` 的零值报告。
 *
 * 隐私（§4.4）：候选与报告只含 `id` / `kind` / 计数 / 数值评分；
 * `id` 由调用方用稳定标识（消息 id、事实 id、桶名）构造，不携带正文内容。
 */

import {
  CONTEXT_CANDIDATE_KINDS,
  allocateContextCandidates,
  summarizeCandidates,
  type ContextAllocationResult,
  type ContextCandidate,
  type ContextCandidateKind,
} from './contextCandidates'
import { estimateTokens } from './tokenCounter'
/** 影子记录字段（全部为数值/布尔元数据；`text` 仅用于现场估算，不落报告） */
export interface ContextShadowNote {
  /** 现场估算用的注入文本；不进入候选与报告 */
  text?: string
  /** 已知 token 数（图片、工具定义等）；给出时优先于 `text` 估算 */
  tokens?: number
  mandatory?: boolean
  stablePrefix?: boolean
  relevance?: number
  recency?: number
  importance?: number
  continuity?: number
  dedupeKey?: string
  /** 差异解释用来源细分（如 `worldbook:before_character`） */
  origin?: string
}

export interface ContextShadowOptions {
  /** 估算口径模型（与预算同源） */
  model?: string
  /** 本轮输入预算（既有 `budgetBase`）；也可在 `collect()` 时补入 */
  budgetTokens?: number
  /**
   * 现有 `lastContextUsage.used` 口径的数值。
   * 既有实现的上报值不含历史正文 token，这里单独记录以便识别两种口径的差异。
   */
  reportedUsageTokens?: number
}

/** `collect()` 可补入的末段参数（构建末尾才知道的值） */
export interface ContextShadowCollectOptions {
  budgetTokens?: number
  reportedUsageTokens?: number
}

export interface ContextShadowKindDiff {
  kind: ContextCandidateKind
  /** 现有实现实际注入的块数与 token（分类求和，含历史正文与图片） */
  existingCount: number
  existingTokens: number
  /** 影子分配器入选的块数与 token */
  shadowCount: number
  shadowTokens: number
  /** 现有侧 mandatory 块数（影子侧若预算不可行会给出 `mandatoryOverBudget`） */
  mandatoryCount: number
  /** shadowTokens − existingTokens */
  deltaTokens: number
}

export interface ContextShadowReport {
  /** 影子记录版本（观测分段用，避免与后续版本混合比较） */
  mode: 'shadow'
  budgetTokens: number
  effectiveBudgetTokens: number
  /** 现有实现实际注入的块合计 token（分类求和口径） */
  existingTokens: number
  /** 现有 `lastContextUsage.used` 口径；调用方未传时为 null */
  existingReportedTokens: number | null
  /** 影子分配器在预算内的入选 token */
  shadowTokens: number
  /** shadowTokens − existingTokens */
  deltaTokens: number
  /** 影子选择超出有效预算（只可能因 mandatory 强制保留） */
  overBudget: boolean
  /** mandatory 单独即超出有效预算：预算不可行，W9 需按定义降级 */
  mandatoryOverBudget: boolean
  /** 现有实现描述量已经超出预算（历史裁剪前的口径提示） */
  existingOverBudget: boolean
  candidateCount: number
  selectedCount: number
  droppedCount: number
  dedupedCount: number
  stablePrefixSelectedTokens: number
  byKind: ContextShadowKindDiff[]
  /** 采集/选择异常兜底（true 时其余数值为零值，生成不受影响） */
  degraded: boolean
}

export interface ContextShadowCollector {
  /** 记录一个注入块；`id` 必须是稳定标识（不含内容） */
  note(kind: ContextCandidateKind, id: string, note?: ContextShadowNote): void
  /**
   * 直接登记一个已构造好的候选（W8：记忆候选由 `memoryCandidates` 统一构造）。
   * `originalOrder` 以登记顺序为准（保证全局 tie-break 只依赖注入顺序）。
   */
  noteCandidate(candidate: ContextCandidate): void
  /** 已采集的候选数 */
  candidateCount(): number
  /** 已采集的全部候选（只含元数据，不含正文） */
  collectedCandidates(): readonly ContextCandidate[]
  /** 影子选择结果（内部会先 `collect()`；不含正文） */
  selectedCandidates(): readonly ContextCandidate[]
  /**
   * 计算影子选择与差异（幂等；异常时返回 `degraded: true` 的零值报告）。
   * `budgetTokens` / `reportedUsageTokens` 为构建末尾才确定的值，可在此处补入。
   */
  collect(options?: ContextShadowCollectOptions): ContextShadowReport
}

/** 预算归一化：非有限/负数 → 0 */
function normalizeBudget(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

function zeroReport(budgetTokens: number, reportedUsageTokens?: number): ContextShadowReport {
  return {
    mode: 'shadow',
    budgetTokens: normalizeBudget(budgetTokens),
    effectiveBudgetTokens: 0,
    existingTokens: 0,
    existingReportedTokens: typeof reportedUsageTokens === 'number' && Number.isFinite(reportedUsageTokens)
      ? reportedUsageTokens
      : null,
    shadowTokens: 0,
    deltaTokens: 0,
    overBudget: false,
    mandatoryOverBudget: false,
    existingOverBudget: false,
    candidateCount: 0,
    selectedCount: 0,
    droppedCount: 0,
    dedupedCount: 0,
    stablePrefixSelectedTokens: 0,
    byKind: CONTEXT_CANDIDATE_KINDS.map((kind) => ({
      kind,
      existingCount: 0,
      existingTokens: 0,
      shadowCount: 0,
      shadowTokens: 0,
      mandatoryCount: 0,
      deltaTokens: 0,
    })),
    degraded: true,
  }
}

function buildByKindDiff(
  existing: ReturnType<typeof summarizeCandidates>,
  shadow: ContextAllocationResult,
): ContextShadowKindDiff[] {
  return CONTEXT_CANDIDATE_KINDS.map((kind) => {
    const existingStat = existing.byKind[kind]
    const shadowStat = shadow.byKind[kind]
    return {
      kind,
      existingCount: existingStat.count,
      existingTokens: existingStat.tokens,
      shadowCount: shadowStat.selectedCount,
      shadowTokens: shadowStat.selectedTokens,
      mandatoryCount: existingStat.mandatoryCount,
      deltaTokens: shadowStat.selectedTokens - existingStat.tokens,
    }
  })
}

/**
 * 创建影子采集器。同一轮上下文构建创建一个实例，构建结束后调用一次 `collect()`。
 */
export function createContextShadowCollector(options: ContextShadowOptions): ContextShadowCollector {
  const model = options.model
  const initialBudgetTokens = normalizeBudget(options.budgetTokens)
  const initialReportedUsage = options.reportedUsageTokens
  const candidates: ContextCandidate[] = []
  let order = 0
  let collected: ContextShadowReport | null = null
  let allocation: ContextAllocationResult | null = null

  const runCollect = (collectOptions?: ContextShadowCollectOptions): ContextShadowReport => {
    if (collected) return collected
    const budgetTokens = normalizeBudget(collectOptions?.budgetTokens ?? initialBudgetTokens)
    const reported = Number.isFinite(collectOptions?.reportedUsageTokens)
      ? collectOptions?.reportedUsageTokens
      : initialReportedUsage
    try {
      const existing = summarizeCandidates(candidates)
      const shadow = allocateContextCandidates(candidates, { budgetTokens })
      allocation = shadow
      collected = {
        mode: 'shadow',
        budgetTokens,
        effectiveBudgetTokens: shadow.effectiveBudgetTokens,
        existingTokens: existing.tokens,
        existingReportedTokens: typeof reported === 'number' && Number.isFinite(reported) ? reported : null,
        shadowTokens: shadow.selectedTokens,
        deltaTokens: shadow.selectedTokens - existing.tokens,
        overBudget: shadow.overBudget,
        mandatoryOverBudget: shadow.mandatoryOverBudget,
        existingOverBudget: existing.tokens > budgetTokens,
        candidateCount: existing.count,
        selectedCount: shadow.selectedIds.length,
        droppedCount: shadow.droppedIds.length,
        dedupedCount: shadow.dedupedIds.length,
        stablePrefixSelectedTokens: shadow.stablePrefixSelectedTokens,
        byKind: buildByKindDiff(existing, shadow),
        degraded: false,
      }
      return collected
    } catch {
      collected = zeroReport(budgetTokens, typeof reported === 'number' ? reported : undefined)
      return collected
    }
  }

  return {
    note(kind, id, note) {
      if (collected) return
      const safeKind = (CONTEXT_CANDIDATE_KINDS as readonly string[]).includes(kind) ? kind : 'history'
      const rawTokens = note?.tokens
      const estimated = typeof rawTokens === 'number' && Number.isFinite(rawTokens)
        ? rawTokens
        : estimateTokens(note?.text ?? '', model)
      candidates.push({
        id: id?.trim() || `${safeKind}#${order}`,
        kind: safeKind,
        estimatedTokens: estimated,
        mandatory: note?.mandatory === true,
        stablePrefix: note?.stablePrefix === true,
        relevance: note?.relevance ?? 0,
        recency: note?.recency ?? 0,
        importance: note?.importance ?? 0,
        continuity: note?.continuity ?? 0,
        ...(note?.dedupeKey ? { dedupeKey: note.dedupeKey } : {}),
        originalOrder: order,
        ...(note?.origin ? { origin: note.origin } : {}),
      })
      order += 1
    },
    noteCandidate(candidate) {
      if (collected) return
      candidates.push({ ...candidate, originalOrder: order })
      order += 1
    },
    candidateCount() {
      return candidates.length
    },
    collectedCandidates() {
      return candidates
    },
    selectedCandidates() {
      if (!collected) runCollect()
      return allocation ? allocation.selected : []
    },
    collect: runCollect,
  }
}

/**
 * 数值化日志串（不含正文/提示词/URL），供 `logInfo` 使用。
 * 只输出计数与分类 token，便于按 `mode=shadow` 在观测中分段。
 */
export function formatContextShadowSummary(report: ContextShadowReport): string {
  const kinds = report.byKind
    .filter((diff) => diff.existingCount > 0 || diff.shadowCount > 0)
    .map((diff) => `${diff.kind}:${diff.existingTokens}->${diff.shadowTokens}/${diff.existingCount}->${diff.shadowCount}`)
    .join(',')
  return [
    'mode=shadow',
    `budget=${report.budgetTokens}`,
    `existing=${report.existingTokens}`,
    `shadow=${report.shadowTokens}`,
    `delta=${report.deltaTokens}`,
    `over=${report.overBudget ? 1 : 0}`,
    `mandatoryOver=${report.mandatoryOverBudget ? 1 : 0}`,
    `cand=${report.candidateCount}`,
    `sel=${report.selectedCount}`,
    `dedupe=${report.dedupedCount}`,
    `degraded=${report.degraded ? 1 : 0}`,
    `kinds=${kinds || 'none'}`,
  ].join(' ')
}
