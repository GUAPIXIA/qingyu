/**
 * W8（主计划 §7.10）：长记忆三层（当前状态 / 结构化事实 / 时间线）→ 统一候选，交给 W7 的确定性分配器
 * 做"按剩余输入空间与相关性"的动态分配——纯函数，无 IO，不含任何存储写入。
 *
 * 本期（W8）只做到"候选化 + 影子对照"：
 * - 生产注入仍由 `fitLayeredMemoryBudget` 决定（既有固定上限 `min(800, budgetBase*0.1)`），
 *   本模块结果进入影子报告，作为 G1 通过后"记忆层接管"的决策证据；
 * - `fitLayeredMemoryBudget` 保留为对照与回滚路径（§7.10 第 2 条）；
 * - **不设新的全局上限**：记忆候选只在统一输入预算内与其他块竞争，不再有 800 / 10% 的记忆专属上限；
 * - 只读不写：候选、选择与报告都不触碰会话存储，任何失败都不删除记忆（§7.10 第 5 条）；
 * - 事实评分**复用官方 `scoreAndRankFacts`**，语义检索不可用时自然落入 importance+recency+confidence
 *   的既有回退口径（§7.10 第 4 条），不新建第二套事实排序规则。
 *
 * 隐私（§4.4）：候选与报告只含 id / 枚举 / 计数 / 数值；时间线与事实文本只在现场 token 估算中使用，
 * 不进入候选、不进入报告、不进入日志。
 */

import {
  allocateContextCandidates,
  summarizeCandidates,
  type ContextAllocationResult,
  type ContextCandidate,
} from './contextCandidates'
import {
  isMemoryFact,
  memoryFactToText,
  scoreAndRankFacts,
} from './memory'
import type { MemoryFactRecord } from '../types'
import { estimateTokens } from './tokenCounter'

/** 记忆层（候选映射的三个来源） */
export type MemoryLayerKind = 'current-state' | 'fact' | 'timeline'

/** 事实检索口径：语义在场 / 回退到 importance+recency+confidence */
export type MemoryRetrievalMode = 'semantic' | 'fallback'

/** 时间线单块目标 token（贪心装填上限） */
export const MEMORY_TIMELINE_TARGET_CHUNK_TOKENS = 90
/** 时间线单块硬上限：超过则按句子再切，避免"一条超长事件"变成全有或全无的块 */
export const MEMORY_TIMELINE_MAX_CHUNK_TOKENS = 180
/** 时间线候选条数上限：超出部分并进最早的一块（保留文本，只减少候选数量） */
export const MEMORY_TIMELINE_MAX_CHUNKS = 48

/** 当前状态候选评分：当前状态是"必须优先于低价值记忆"的层（§5.5 第 3 条） */
export const MEMORY_STATE_SCORES = {
  relevance: 0.9,
  recency: 1,
  importance: 0.9,
  continuity: 0.9,
} as const

/** 时间线候选评分：相关度固定进入"相关上下文"顺位，块内按近因排序（新事件先保留） */
export const MEMORY_TIMELINE_RELEVANCE = 0.6
/** 时间线候选重要度 */
export const MEMORY_TIMELINE_IMPORTANCE = 0.6
/** 事实候选连续性（与最近对话的衔接强度低于原始历史） */
export const MEMORY_FACT_CONTINUITY = 0.4

export interface TimelineChunk {
  /** 稳定 id：`memory:timeline:<index>`（不含内容） */
  id: string
  index: number
  text: string
  tokens: number
}

/**
 * 时间线 → 有序候选块（纯函数、确定性）：
 * 1. 按行切分（记忆总结要求"最多 8 条按时间顺序排列的简短事件"）；
 * 2. 超过 `MEMORY_TIMELINE_MAX_CHUNK_TOKENS` 的长行按句号类标点再切，尽量装到目标大小；
 * 3. 相邻小块贪心合并到目标大小，避免碎块；
 * 4. 条数超过上限时把最早的若干块并成一块（保留文本，只减少候选数量）。
 */
export function splitTimelineIntoChunks(
  timeline: string | null | undefined,
  model?: string,
): TimelineChunk[] {
  const text = (timeline ?? '').replace(/\r\n/g, '\n').trim()
  if (!text) return []

  const segments = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

  const packed: string[] = []
  let buffer: string[] = []
  let bufferTokens = 0
  const flush = (): void => {
    if (buffer.length > 0) {
      packed.push(buffer.join('\n'))
      buffer = []
      bufferTokens = 0
    }
  }

  for (const segment of segments) {
    const segmentTokens = estimateTokens(segment, model)
    if (segmentTokens > MEMORY_TIMELINE_MAX_CHUNK_TOKENS) {
      flush()
      for (const piece of packSentences(segment, model)) packed.push(piece)
      continue
    }
    if (bufferTokens > 0 && bufferTokens + segmentTokens > MEMORY_TIMELINE_TARGET_CHUNK_TOKENS) flush()
    buffer.push(segment)
    bufferTokens += segmentTokens
  }
  flush()

  if (packed.length > MEMORY_TIMELINE_MAX_CHUNKS) {
    const overflow = packed.length - MEMORY_TIMELINE_MAX_CHUNKS + 1
    packed.splice(0, overflow, packed.slice(0, overflow).join('\n'))
  }

  return packed.map((chunkText, index) => ({
    id: `memory:timeline:${index}`,
    index,
    text: chunkText,
    tokens: estimateTokens(chunkText, model),
  }))
}

/** 按句末标点切句（不依赖正则 lookbehind，保证各端一致） */
function splitSentences(text: string): string[] {
  const terminators = '。！？；!?;…\n'
  const out: string[] = []
  let current = ''
  for (const char of text) {
    if (char === '\n') {
      if (current.trim()) out.push(current.trim())
      current = ''
      continue
    }
    current += char
    if (terminators.includes(char)) {
      const trimmed = current.trim()
      if (trimmed) out.push(trimmed)
      current = ''
    }
  }
  if (current.trim()) out.push(current.trim())
  return out
}

/** 句子贪心装填到目标大小（保持原顺序与原文） */
function packSentences(text: string, model?: string): string[] {
  const sentences = splitSentences(text)
  if (sentences.length <= 1) return [text.trim()].filter(Boolean)
  const pieces: string[] = []
  let buffer = ''
  let bufferTokens = 0
  for (const sentence of sentences) {
    const tokens = estimateTokens(sentence, model)
    if (bufferTokens > 0 && bufferTokens + tokens > MEMORY_TIMELINE_TARGET_CHUNK_TOKENS) {
      pieces.push(buffer)
      buffer = ''
      bufferTokens = 0
    }
    buffer += sentence
    bufferTokens += tokens
  }
  if (buffer) pieces.push(buffer)
  return pieces
}

export interface MemoryCandidateInput {
  currentState?: string | null
  timeline?: string | null
  /** 待注入的事实（语义命中或全量，与 `semanticScores` 等长） */
  facts?: MemoryFactRecord[] | null
  /** 与 `facts` 等长的语义相似度；缺失/全 0 时走回退口径 */
  semanticScores?: number[] | null
  model?: string
}

export interface MemoryLayerTotals {
  count: number
  tokens: number
}

export interface MemoryCandidateSet {
  candidates: ContextCandidate[]
  /** 候选 id → 记忆层（供影子报告与接管时分层取回） */
  layerByCandidateId: Record<string, MemoryLayerKind>
  retrievalMode: MemoryRetrievalMode
  /** 未被分配截断前的描述量（"简单话题可少注入"的对照基线） */
  described: {
    stateTokens: number
    factCount: number
    factTokens: number
    timelineChunkCount: number
    timelineTokens: number
    totalTokens: number
  }
}

/** 结构化事实的稳定 id；旧字符串事实用位置 id（不把内容写进 id） */
function factCandidateId(fact: MemoryFactRecord, index: number): string {
  return isMemoryFact(fact) ? fact.id : `legacy-${index}`
}

/**
 * 三层 → 候选集合（确定性）：
 * - 当前状态：单块，评分固定为"相关上下文"顺位中的最高档；
 * - 事实：逐条候选，`relevance` 直接复用 `scoreAndRankFacts` 的官方评分（语义在场含语义项，
 *   缺失时为 importance+recency+confidence 回退分），非 active 事实不参与；
 * - 时间线：按行/句切成有序候选，块内按近因排序（新事件先保留）。
 */
export function buildMemoryCandidateSet(input: MemoryCandidateInput): MemoryCandidateSet {
  const model = input.model
  const candidates: ContextCandidate[] = []
  const layerByCandidateId: Record<string, MemoryLayerKind> = {}

  const stateText = (input.currentState ?? '').trim()
  if (stateText) {
    const tokens = estimateTokens(stateText, model)
    candidates.push({
      id: 'memory:current-state',
      kind: 'current-state',
      estimatedTokens: tokens,
      mandatory: false,
      stablePrefix: false,
      relevance: MEMORY_STATE_SCORES.relevance,
      recency: MEMORY_STATE_SCORES.recency,
      importance: MEMORY_STATE_SCORES.importance,
      continuity: MEMORY_STATE_SCORES.continuity,
      dedupeKey: 'memory:state',
      originalOrder: 0,
      origin: 'memory:state',
    })
    layerByCandidateId['memory:current-state'] = 'current-state'
  }

  const facts = input.facts ?? []
  const semanticScores = input.semanticScores ?? null
  const hasSemantic = Array.isArray(semanticScores)
    && semanticScores.length === facts.length
    && semanticScores.some((score) => score > 0)
  const retrievalMode: MemoryRetrievalMode = hasSemantic ? 'semantic' : 'fallback'
  // 官方评分是唯一事实排序来源；这里只做"评分结果 → 原始下标"的稳定回填（重复字符串事实互不串位）
  const ranked = scoreAndRankFacts(facts, semanticScores)
  const consumed = new Set<number>()
  let factTokens = 0
  for (const entry of ranked) {
    if (isMemoryFact(entry.fact) && entry.fact.status !== 'active') continue
    let index = -1
    for (let i = 0; i < facts.length; i++) {
      if (consumed.has(i)) continue
      if (facts[i] === entry.fact) { index = i; break }
    }
    if (index < 0) continue
    consumed.add(index)
    const candidateId = factCandidateId(entry.fact, index)
    const text = memoryFactToText(entry.fact)
    if (!text) continue
    const tokens = estimateTokens(text, model)
    factTokens += tokens
    candidates.push({
      id: `memory:fact:${candidateId}`,
      kind: 'memory',
      estimatedTokens: tokens,
      mandatory: false,
      stablePrefix: false,
      relevance: entry.score,
      recency: entry.recency,
      importance: Math.min(1, Math.max(0, entry.importance / 5)),
      continuity: MEMORY_FACT_CONTINUITY,
      dedupeKey: `fact:${candidateId}`,
      originalOrder: candidates.length,
      origin: `memory:fact:${retrievalMode}`,
    })
    layerByCandidateId[`memory:fact:${candidateId}`] = 'fact'
  }

  const chunks = splitTimelineIntoChunks(input.timeline, model)
  let timelineTokens = 0
  chunks.forEach((chunk, position) => {
    const recency = chunks.length <= 1 ? 1 : (position + 1) / chunks.length
    timelineTokens += chunk.tokens
    candidates.push({
      id: chunk.id,
      kind: 'memory',
      estimatedTokens: chunk.tokens,
      mandatory: false,
      stablePrefix: false,
      relevance: MEMORY_TIMELINE_RELEVANCE,
      recency,
      importance: MEMORY_TIMELINE_IMPORTANCE,
      continuity: 0.3 + 0.4 * recency,
      dedupeKey: `timeline:${chunk.index}`,
      originalOrder: candidates.length,
      origin: 'memory:timeline',
    })
    layerByCandidateId[chunk.id] = 'timeline'
  })

  const stateTokens = stateText ? estimateTokens(stateText, model) : 0
  const factCount = candidates.filter((candidate) => layerByCandidateId[candidate.id] === 'fact').length
  return {
    candidates,
    layerByCandidateId,
    retrievalMode,
    described: {
      stateTokens,
      factCount,
      factTokens,
      timelineChunkCount: chunks.length,
      timelineTokens,
      totalTokens: stateTokens + factTokens + timelineTokens,
    },
  }
}

/** 既有实现（`fitLayeredMemoryBudget`）本轮实际注入的记忆统计 */
export interface MemoryInjectionStats {
  /** 既有实现的记忆专属上限（候选侧没有这个上限） */
  capTokens: number
  stateTokens: number
  factCount: number
  factTokens: number
  timelineChunkCount: number
  timelineTokens: number
  totalTokens: number
  retrievalMode: MemoryRetrievalMode
}

export interface MemoryLayerSelection {
  /** 该层入选块数与 token */
  selected: MemoryLayerTotals
  /** 该层被分配截断（本轮不注入）的块数——不是删除，存储不变 */
  dropped: number
}

export interface MemoryCandidateSelection {
  budgetTokens: number
  selectedTokens: number
  byLayer: Record<MemoryLayerKind, MemoryLayerSelection>
  overBudget: boolean
  /** 记忆块在全局竞争中的对手（协议/角色/世界书/历史/示例） */
  competitor: {
    describedTokens: number
    selectedTokens: number
    deltaTokens: number
  }
}

function emptyLayerSelection(): Record<MemoryLayerKind, MemoryLayerSelection> {
  return {
    'current-state': { selected: { count: 0, tokens: 0 }, dropped: 0 },
    fact: { selected: { count: 0, tokens: 0 }, dropped: 0 },
    timeline: { selected: { count: 0, tokens: 0 }, dropped: 0 },
  }
}

/**
 * 记忆候选与对手块在同一预算内竞争（§5.5 分配顺序由 W7 分配器保证）：
 * 报告"哪一层保留了多少、被截断多少、是否因 mandatory 而超预算"。
 */
export function selectMemoryCandidates(
  plan: MemoryCandidateSet,
  options: { budgetTokens: number; competitors?: readonly ContextCandidate[] },
): MemoryCandidateSelection {
  const competitors = options.competitors ?? []
  const allocation: ContextAllocationResult = allocateContextCandidates(
    [...plan.candidates, ...competitors],
    { budgetTokens: options.budgetTokens },
  )
  const byLayer = emptyLayerSelection()
  let selectedTokens = 0
  for (const candidate of allocation.selected) {
    const layer = plan.layerByCandidateId[candidate.id]
    if (!layer) continue
    byLayer[layer].selected.count += 1
    byLayer[layer].selected.tokens += candidate.estimatedTokens
    selectedTokens += candidate.estimatedTokens
  }
  byLayer['current-state'].dropped = plan.described.stateTokens > 0 && byLayer['current-state'].selected.count === 0 ? 1 : 0
  byLayer.fact.dropped = Math.max(0, plan.described.factCount - byLayer.fact.selected.count)
  byLayer.timeline.dropped = Math.max(0, plan.described.timelineChunkCount - byLayer.timeline.selected.count)

  const competitorSummary = summarizeCandidates(competitors)
  const competitorSelectedTokens = Math.max(0, allocation.selectedTokens - selectedTokens)
  return {
    budgetTokens: allocation.effectiveBudgetTokens,
    selectedTokens,
    byLayer,
    overBudget: allocation.overBudget,
    competitor: {
      describedTokens: competitorSummary.tokens,
      selectedTokens: competitorSelectedTokens,
      deltaTokens: competitorSelectedTokens - competitorSummary.tokens,
    },
  }
}

export interface MemoryLayerDiff {
  layer: MemoryLayerKind
  existingCount: number
  existingTokens: number
  candidateCount: number
  candidateTokens: number
  candidateDroppedCount: number
}

export interface MemoryShadowReport {
  mode: 'memory-shadow'
  budgetTokens: number
  /** 既有实现的记忆上限（`min(800, budgetBase*0.1)` 的实际取值） */
  legacyCapTokens: number
  retrievalMode: MemoryRetrievalMode
  existing: MemoryInjectionStats
  candidate: Omit<MemoryInjectionStats, 'capTokens'> & {
    droppedFactCount: number
    droppedTimelineChunkCount: number
    overBudget: boolean
  }
  /** candidate.totalTokens − existing.totalTokens */
  deltaTokens: number
  /** §7.10 验收：候选侧是否突破既有的 800 口径上限 */
  exceedsLegacyCap: boolean
  competitor: MemoryCandidateSelection['competitor']
  byLayer: MemoryLayerDiff[]
  /** 采集/选择异常兜底（true 时数值为零值，生成不受影响） */
  degraded: boolean
}

/**
 * 分配失败时的兜底报告：**既有口径原样保留**（它不依赖分配），候选侧归零并标记 `degraded`。
 * 生成链路的注入仍来自既有实现，因此"失败退回原选择"是结构性的，不靠这里的数值。
 */
function degradedMemoryShadow(existing: MemoryInjectionStats, budgetTokens: number): MemoryShadowReport {
  return {
    mode: 'memory-shadow',
    budgetTokens: Math.max(0, Math.floor(Number.isFinite(budgetTokens) ? budgetTokens : 0)),
    legacyCapTokens: Math.max(0, Math.floor(existing.capTokens)),
    retrievalMode: existing.retrievalMode,
    existing,
    candidate: {
      stateTokens: 0,
      factCount: 0,
      factTokens: 0,
      timelineChunkCount: 0,
      timelineTokens: 0,
      totalTokens: 0,
      retrievalMode: existing.retrievalMode,
      droppedFactCount: 0,
      droppedTimelineChunkCount: 0,
      overBudget: false,
    },
    deltaTokens: -existing.totalTokens,
    exceedsLegacyCap: false,
    competitor: { describedTokens: 0, selectedTokens: 0, deltaTokens: 0 },
    byLayer: [
      { layer: 'current-state', existingCount: existing.stateTokens > 0 ? 1 : 0, existingTokens: existing.stateTokens, candidateCount: 0, candidateTokens: 0, candidateDroppedCount: 0 },
      { layer: 'fact', existingCount: existing.factCount, existingTokens: existing.factTokens, candidateCount: 0, candidateTokens: 0, candidateDroppedCount: 0 },
      { layer: 'timeline', existingCount: existing.timelineChunkCount, existingTokens: existing.timelineTokens, candidateCount: 0, candidateTokens: 0, candidateDroppedCount: 0 },
    ],
    degraded: true,
  }
}

/**
 * 记忆专项影子报告（§7.10 验收的取证口径）：
 * 既有实现（固定 800/10% 上限 + 层内截断）与"候选动态分配"在同一输入、同一预算下的分层差异。
 */
export function buildMemoryShadowReport(input: {
  plan: MemoryCandidateSet
  existing: MemoryInjectionStats
  budgetTokens: number
  competitors?: readonly ContextCandidate[]
}): MemoryShadowReport {
  try {
    const { plan, existing } = input
    const selection = selectMemoryCandidates(plan, {
      budgetTokens: input.budgetTokens,
      ...(input.competitors ? { competitors: input.competitors } : {}),
    })
    const candidateTotal = selection.selectedTokens
    return {
      mode: 'memory-shadow',
      budgetTokens: selection.budgetTokens,
      legacyCapTokens: existing.capTokens,
      retrievalMode: plan.retrievalMode,
      existing,
      candidate: {
        stateTokens: selection.byLayer['current-state'].selected.tokens,
        factCount: selection.byLayer.fact.selected.count,
        factTokens: selection.byLayer.fact.selected.tokens,
        timelineChunkCount: selection.byLayer.timeline.selected.count,
        timelineTokens: selection.byLayer.timeline.selected.tokens,
        totalTokens: candidateTotal,
        retrievalMode: plan.retrievalMode,
        droppedFactCount: selection.byLayer.fact.dropped,
        droppedTimelineChunkCount: selection.byLayer.timeline.dropped,
        overBudget: selection.overBudget,
      },
      deltaTokens: candidateTotal - existing.totalTokens,
      exceedsLegacyCap: candidateTotal > existing.capTokens,
      competitor: selection.competitor,
      byLayer: [
        {
          layer: 'current-state',
          existingCount: existing.stateTokens > 0 ? 1 : 0,
          existingTokens: existing.stateTokens,
          candidateCount: selection.byLayer['current-state'].selected.count,
          candidateTokens: selection.byLayer['current-state'].selected.tokens,
          candidateDroppedCount: selection.byLayer['current-state'].dropped,
        },
        {
          layer: 'fact',
          existingCount: existing.factCount,
          existingTokens: existing.factTokens,
          candidateCount: selection.byLayer.fact.selected.count,
          candidateTokens: selection.byLayer.fact.selected.tokens,
          candidateDroppedCount: selection.byLayer.fact.dropped,
        },
        {
          layer: 'timeline',
          existingCount: existing.timelineChunkCount,
          existingTokens: existing.timelineTokens,
          candidateCount: selection.byLayer.timeline.selected.count,
          candidateTokens: selection.byLayer.timeline.selected.tokens,
          candidateDroppedCount: selection.byLayer.timeline.dropped,
        },
      ],
      degraded: false,
    }
  } catch {
    return degradedMemoryShadow(input.existing, input.budgetTokens)
  }
}

/** 数值化日志串（不含正文/事实文本/提示词） */
export function formatMemoryShadowSummary(report: MemoryShadowReport): string {
  const layers = report.byLayer
    .map((diff) => `${diff.layer}:${diff.existingTokens}->${diff.candidateTokens}/${diff.existingCount}->${diff.candidateCount}`)
    .join(',')
  return [
    'mode=memory-shadow',
    `budget=${report.budgetTokens}`,
    `cap=${report.legacyCapTokens}`,
    `existing=${report.existing.totalTokens}`,
    `candidate=${report.candidate.totalTokens}`,
    `delta=${report.deltaTokens}`,
    `exceedsCap=${report.exceedsLegacyCap ? 1 : 0}`,
    `droppedFacts=${report.candidate.droppedFactCount}`,
    `droppedTimeline=${report.candidate.droppedTimelineChunkCount}`,
    `retrieval=${report.retrievalMode}`,
    `degraded=${report.degraded ? 1 : 0}`,
    `layers=${layers}`,
  ].join(' ')
}
