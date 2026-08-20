import type { FactProposal, MemoryFact, MemoryFactChange, MemoryFactRecord } from '../../shared/types'

/**
 * 长记忆结构化解析工具
 *
 * triggerMemorySummary 让模型输出结构化格式：
 *   【摘要】
 *   <摘要文本>
 *   【事实】
 *   1. 事实一
 *   2. 事实二
 * 本模块负责解析该输出，并做兜底（模型不按格式输出时）。
 */

export interface ParsedMemory {
  /** 最近情节的即时状态：场景、地点、进行中的目标等。 */
  currentState: string
  /** 长期时间线摘要；保留 summary 字段以兼容历史会话数据。 */
  summary: string
  facts: string[]
  /** 未包含该段时为 undefined；包含但格式无效时为 null，调用方必须保留旧事实。 */
  factChanges?: MemoryFactChange[] | null
  /** 新格式：模型仅输出语义提案，服务端负责匹配事实 ID。 */
  factProposals?: FactProposal[] | null
}

/** 事实列表上限（防止无限累积） */
export const MAX_MEMORY_FACTS = 30

function parseFactChange(raw: unknown): MemoryFactChange | null {
  if (!raw || typeof raw !== 'object') return null
  const item = raw as Record<string, unknown>
  const action = item.action
  if (action === 'add') {
    const fact = item.fact
    if (!fact || typeof fact !== 'object') return null
    const value = fact as Record<string, unknown>
    if (!['subject', 'predicate', 'value'].every((key) => typeof value[key] === 'string' && value[key].trim())) return null
    const result: NonNullable<MemoryFactChange['fact']> = {
      subject: String(value.subject).trim(),
      predicate: String(value.predicate).trim(),
      value: String(value.value).trim(),
    }
    if (typeof value.importance === 'number') result.importance = value.importance as MemoryFact['importance']
    if (typeof value.confidence === 'number') result.confidence = value.confidence
    return { action, fact: result }
  }
  if (action === 'update') {
    if (typeof item.id !== 'string' || !item.id.trim() || !item.patch || typeof item.patch !== 'object') return null
    const patch = item.patch as Record<string, unknown>
    const result: NonNullable<MemoryFactChange['patch']> = {}
    for (const key of ['subject', 'predicate', 'value'] as const) {
      if (typeof patch[key] === 'string' && patch[key].trim()) result[key] = patch[key].trim()
    }
    if (typeof patch.importance === 'number') result.importance = patch.importance as MemoryFact['importance']
    if (typeof patch.confidence === 'number') result.confidence = patch.confidence
    if (Object.keys(result).length === 0) return null
    return { action, id: item.id.trim(), patch: result }
  }
  if (action === 'deactivate' && typeof item.id === 'string' && item.id.trim()) {
    return { action, id: item.id.trim() }
  }
  return null
}

function parseFactChanges(section: string): MemoryFactChange[] | null {
  const jsonText = section.trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim()
  try {
    const value: unknown = JSON.parse(jsonText)
    if (!Array.isArray(value)) return null
    const changes = value.map(parseFactChange)
    return changes.every((change): change is MemoryFactChange => change !== null) ? changes : null
  } catch {
    return null
  }
}

function parseFactProposal(raw: unknown): FactProposal | null {
  if (!raw || typeof raw !== 'object') return null
  const item = raw as Record<string, unknown>
  if (!['subject', 'predicate', 'value'].every((key) => typeof item[key] === 'string' && item[key].trim())) return null
  if (item.changeType !== 'set' && item.changeType !== 'clear') return null
  const proposal: FactProposal = {
    subject: String(item.subject).trim(),
    predicate: String(item.predicate).trim(),
    value: String(item.value).trim(),
    changeType: item.changeType,
  }
  if (typeof item.scope === 'string' && item.scope.trim()) proposal.scope = item.scope.trim()
  if (typeof item.entityId === 'string' && item.entityId.trim()) proposal.entityId = item.entityId.trim()
  if (typeof item.importance === 'number') proposal.importance = item.importance as FactProposal['importance']
  if (typeof item.confidence === 'number') proposal.confidence = item.confidence
  return proposal
}

function parseFactProposals(section: string): FactProposal[] | null {
  const jsonText = section.trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim()
  try {
    const value: unknown = JSON.parse(jsonText)
    if (!Array.isArray(value)) return null
    const proposals = value.map(parseFactProposal)
    return proposals.every((proposal): proposal is FactProposal => proposal !== null) ? proposals : null
  } catch {
    return null
  }
}

/**
 * 解析模型输出的结构化记忆文本。
 * - 剥离 <thought> 思考标签
 * - 【摘要】段落 → summary
 * - 【事实】段落按行解析为事实列表（自动去掉编号前缀）
 * - 兜底：未匹配到【摘要】时把全文作为摘要；未匹配到【事实】时事实为空
 */
export function parseMemoryResult(text: string): ParsedMemory {
  const cleaned = (text ?? '')
    .replace(/<thought>[\s\S]*?<\/thought>/gi, '')
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .trim()
  if (!cleaned) return { currentState: '', summary: '', facts: [] }

  const currentStateMatch = cleaned.match(/【当前状态】([\s\S]*?)(?=【(?:时间线|摘要|事实|事实变更|事实提案)】|$)/)
  const timelineMatch = cleaned.match(/【时间线】([\s\S]*?)(?=【(?:事实|事实变更|事实提案)】|$)/)
  const summaryMatch = cleaned.match(/【摘要】([\s\S]*?)(?=【(?:事实|事实变更|事实提案)】|$)/)
  const factsMatch = cleaned.match(/【事实】([\s\S]*?)(?=【(?:事实变更|事实提案)】|$)/)
  const factChangesMatch = cleaned.match(/【事实变更】([\s\S]*)$/)
  const factProposalsMatch = cleaned.match(/【事实提案】([\s\S]*)$/)

  const currentState = (currentStateMatch?.[1] ?? '').trim()
  const summary = (timelineMatch?.[1] ?? summaryMatch?.[1] ?? '').trim()
  const facts = (factsMatch?.[1] ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.replace(/^\s*(?:[-*]|\d{1,3}[.、．)）]|[一二三四五六七八九十]+[、.．])\s*/, '').trim())
    .filter((l) => l.length > 0)
    .slice(0, MAX_MEMORY_FACTS)

  const parsed: ParsedMemory = {
    currentState,
    // 兜底：没有【摘要】标记时使用全文（去掉【事实】部分）
    summary: summary || (currentState ? '' : cleaned.replace(/【事实(?:变更|提案)?】[\s\S]*$/, '').trim()),
    facts,
  }
  if (factChangesMatch) parsed.factChanges = parseFactChanges(factChangesMatch[1])
  if (factProposalsMatch) parsed.factProposals = parseFactProposals(factProposalsMatch[1])
  return parsed
}

/** 判断是否为已迁移的结构化事实。 */
export function isMemoryFact(fact: MemoryFactRecord): fact is MemoryFact {
  return typeof fact === 'object' && fact !== null
    && typeof fact.id === 'string'
    && typeof fact.subject === 'string'
    && typeof fact.predicate === 'string'
    && typeof fact.value === 'string'
}

/** 面向提示词和 UI 的稳定事实文本。 */
export function memoryFactToText(fact: MemoryFactRecord): string {
  if (typeof fact === 'string') return fact.trim()
  const subject = fact.subject.trim()
  const predicate = fact.predicate.trim()
  const value = fact.value.trim()
  return predicate ? `${subject}的${predicate}：${value}` : `${subject}：${value}`
}

/** 仅返回当前有效事实的可嵌入文本。 */
export function memoryFactsToTexts(facts: MemoryFactRecord[] | undefined | null): string[] {
  return (facts ?? [])
    .filter((fact) => !isMemoryFact(fact) || fact.status === 'active')
    .map(memoryFactToText)
    .filter(Boolean)
}

function clampImportance(value: unknown): MemoryFact['importance'] {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : 3
  return Math.min(5, Math.max(1, numeric)) as MemoryFact['importance']
}

function clampConfidence(value: unknown): number {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? value : 0.8
  return Math.min(1, Math.max(0, numeric))
}

function stableLegacyId(text: string, index: number): string {
  let hash = 0
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0
  return `legacy-${Math.abs(hash).toString(36)}-${index}`
}

function legacyFactToRecord(text: string, index: number, updatedAt: number): MemoryFact {
  const trimmed = text.trim()
  const match = trimmed.match(/^(.+?)的(.+?)[：:]\s*(.+)$/)
  return {
    id: stableLegacyId(trimmed, index),
    subject: match?.[1]?.trim() || '历史事实',
    predicate: match?.[2]?.trim() || '内容',
    value: match?.[3]?.trim() || trimmed,
    status: 'active',
    importance: 3,
    confidence: 0.7,
    sourceMessageIds: [],
    updatedAt,
  }
}

function normalizeFact(fact: MemoryFactRecord, index: number, updatedAt: number): MemoryFact {
  if (!isMemoryFact(fact)) return legacyFactToRecord(fact, index, updatedAt)
  return {
    ...fact,
    subject: fact.subject.trim(),
    predicate: fact.predicate.trim(),
    value: fact.value.trim(),
    status: fact.status === 'inactive' || fact.status === 'superseded' ? fact.status : 'active',
    importance: clampImportance(fact.importance),
    confidence: clampConfidence(fact.confidence),
    sourceMessageIds: Array.isArray(fact.sourceMessageIds) ? fact.sourceMessageIds.filter(Boolean) : [],
    updatedAt: Number.isFinite(fact.updatedAt) ? fact.updatedAt : updatedAt,
  }
}

function factKey(fact: Pick<MemoryFact, 'subject' | 'predicate' | 'scope' | 'entityId'>): string {
  const normalize = (value: string | undefined) => (value ?? '').trim().toLocaleLowerCase()
  return [normalize(fact.subject), normalize(fact.predicate), normalize(fact.scope), normalize(fact.entityId)].join('|')
}

function withSource(fact: MemoryFact, messageId: string, updatedAt: number): MemoryFact {
  return {
    ...fact,
    sourceMessageIds: messageId && !fact.sourceMessageIds.includes(messageId)
      ? [...fact.sourceMessageIds, messageId]
      : fact.sourceMessageIds,
    updatedAt,
  }
}

/**
 * 应用模型给出的增量事实变更。未知 ID 一律忽略，解析失败由调用方完全保留旧快照。
 * 替代和停用的事实移动到 history，绝不参与后续上下文或向量检索。
 */
export function applyMemoryFactChanges(
  previousFacts: MemoryFactRecord[] | undefined | null,
  previousHistory: MemoryFact[] | undefined | null,
  changes: MemoryFactChange[],
  sourceMessageId: string,
  updatedAt = Date.now(),
): { facts: MemoryFact[]; history: MemoryFact[] } {
  const facts = (previousFacts ?? []).map((fact, index) => normalizeFact(fact, index, updatedAt))
    .filter((fact) => fact.status === 'active')
  const history = (previousHistory ?? []).map((fact, index) => normalizeFact(fact, index, updatedAt))
  const archive = (fact: MemoryFact, status: 'inactive' | 'superseded') => {
    const archived = withSource({
      ...fact,
      id: `${fact.id}:history:${updatedAt}:${history.length}`,
      status,
    }, sourceMessageId, updatedAt)
    history.push(archived)
  }
  const sameKey = (left: MemoryFact, right: Pick<MemoryFact, 'subject' | 'predicate' | 'scope' | 'entityId'>) =>
    factKey(left) === factKey(right)

  changes.forEach((change, index) => {
    if (change.action === 'add' && change.fact) {
      for (let i = facts.length - 1; i >= 0; i--) {
        if (sameKey(facts[i], change.fact)) archive(facts.splice(i, 1)[0], 'superseded')
      }
      facts.push({
        id: `fact-${updatedAt.toString(36)}-${index}`,
        subject: change.fact.subject.trim(),
        predicate: change.fact.predicate.trim(),
        value: change.fact.value.trim(),
        status: 'active',
        importance: clampImportance(change.fact.importance),
        confidence: clampConfidence(change.fact.confidence),
        scope: change.fact.scope?.trim() || undefined,
        entityId: change.fact.entityId?.trim() || undefined,
        sourceMessageIds: sourceMessageId ? [sourceMessageId] : [],
        updatedAt,
      })
      return
    }
    const targetIndex = facts.findIndex((fact) => fact.id === change.id)
    if (targetIndex < 0) return
    const target = facts[targetIndex]
    if (change.action === 'deactivate') {
      archive(target, 'inactive')
      facts.splice(targetIndex, 1)
      return
    }
    if (change.action === 'update' && change.patch) {
      const next = withSource({
        ...target,
        ...change.patch,
        importance: clampImportance(change.patch.importance ?? target.importance),
        confidence: clampConfidence(change.patch.confidence ?? target.confidence),
      }, sourceMessageId, updatedAt)
      if (next.value !== target.value) archive(target, 'superseded')
      for (let i = facts.length - 1; i >= 0; i--) {
        if (i !== targetIndex && sameKey(facts[i], next)) archive(facts.splice(i, 1)[0], 'superseded')
      }
      const nextIndex = facts.findIndex((fact) => fact.id === target.id)
      if (nextIndex >= 0) facts[nextIndex] = next
    }
  })
  return { facts: facts.slice(0, MAX_MEMORY_FACTS), history }
}

/**
 * 将模型的无 ID 语义提案转换为服务端事实变更。匹配键固定为
 * subject + predicate + scope + entityId，模型无法越权修改同名但不同作用域的事实。
 */
export function applyFactProposals(
  previousFacts: MemoryFactRecord[] | undefined | null,
  previousHistory: MemoryFact[] | undefined | null,
  proposals: FactProposal[],
  sourceMessageId: string,
  updatedAt = Date.now(),
): { facts: MemoryFact[]; history: MemoryFact[] } {
  let result = applyMemoryFactChanges(previousFacts, previousHistory, [], sourceMessageId, updatedAt)
  proposals.forEach((proposal) => {
    const target = result.facts.find((fact) => factKey(fact) === factKey(proposal))
    if (proposal.changeType === 'clear') {
      if (target) result = applyMemoryFactChanges(result.facts, result.history, [{ action: 'deactivate', id: target.id }], sourceMessageId, updatedAt)
      return
    }
    const change: MemoryFactChange = target
      ? {
          action: 'update',
          id: target.id,
          patch: {
            value: proposal.value,
            importance: proposal.importance,
            confidence: proposal.confidence,
          },
        }
      : {
          action: 'add',
          fact: {
            subject: proposal.subject,
            predicate: proposal.predicate,
            value: proposal.value,
            scope: proposal.scope,
            entityId: proposal.entityId,
            importance: proposal.importance,
            confidence: proposal.confidence,
          },
        }
    result = applyMemoryFactChanges(result.facts, result.history, [change], sourceMessageId, updatedAt)
  })
  return result
}

/** 30 天线性衰减的最近性分数（0~1） */
export function computeRecencyScore(updatedAt: number | undefined, now = Date.now()): number {
  if (!Number.isFinite(updatedAt) || !updatedAt) return 0.5
  const elapsed = now - (updatedAt as number)
  if (elapsed <= 0) return 1
  const thirtyDays = 30 * 24 * 60 * 60 * 1000
  return Math.max(0, 1 - elapsed / thirtyDays)
}

export interface RankedFact {
  fact: MemoryFactRecord
  score: number
  semantic: number
  recency: number
  importance: number
}

/**
 * 事实检索评分与排序
 * - 字符串事实：score = 0.7*semantic + 0.3*recency (importance 固定 3)
 * - 结构化事实：score = 0.5*semantic + 0.3*recency + 0.2*importance(归一化)
 * - semanticScores 为与 facts 等长的相似度数组（0~1），缺失时视为 0
 * - 降级（vectors 缺失/语义不可用）：semanticScores 为 null/空时，按 importance 降序 + updatedAt 降序
 */
export function scoreAndRankFacts(
  facts: MemoryFactRecord[],
  semanticScores: number[] | null | undefined,
  now = Date.now(),
): RankedFact[] {
  const list = facts ?? []
  const hasSemantic = Array.isArray(semanticScores) && semanticScores.length === list.length && semanticScores.some((s) => s > 0)

  // 降级：无语义分数时按 importance + recency 排序
  if (!hasSemantic) {
    return list
      .map((fact) => {
        const importance = isMemoryFact(fact) ? clampImportance(fact.importance) : 3
        const recency = isMemoryFact(fact) ? computeRecencyScore(fact.updatedAt, now) : 0.5
        const score = importance / 5 * 0.6 + recency * 0.4 // 降级权重：重要性 0.6 + 新近 0.4
        return { fact, score, semantic: 0, recency, importance }
      })
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score
        if (b.importance !== a.importance) return b.importance - a.importance
        const aTime = isMemoryFact(a.fact) ? (a.fact.updatedAt ?? 0) : 0
        const bTime = isMemoryFact(b.fact) ? (b.fact.updatedAt ?? 0) : 0
        return bTime - aTime
      })
  }

  return list
    .map((fact, idx) => {
      const semantic = Math.max(0, Math.min(1, semanticScores![idx] ?? 0))
      const recency = isMemoryFact(fact) ? computeRecencyScore(fact.updatedAt, now) : 0.5
      const importance = isMemoryFact(fact) ? clampImportance(fact.importance) : 3
      const importanceNorm = importance / 5
      const isStructured = isMemoryFact(fact)
      const score = isStructured
        ? semantic * 0.5 + recency * 0.3 + importanceNorm * 0.2
        : semantic * 0.7 + recency * 0.3
      return { fact, score, semantic, recency, importance }
    })
    .sort((a, b) => b.score - a.score)
}

/**
 * 按预算选择事实：按评分降序，单条超限跳过继续（而非停止）
 */
export function selectFactsByBudget(
  ranked: RankedFact[] | MemoryFactRecord[],
  budget: number,
  estimateTokens: (text: string, model?: string) => number,
  model?: string,
): MemoryFactRecord[] {
  const safeBudget = Math.max(0, Math.floor(budget))
  const items: RankedFact[] = Array.isArray(ranked) && ranked.length > 0 && typeof (ranked[0] as RankedFact).fact !== 'undefined'
    ? (ranked as RankedFact[])
    : (ranked as MemoryFactRecord[]).map((fact) => ({ fact, score: 0, semantic: 0, recency: 0, importance: isMemoryFact(fact) ? clampImportance(fact.importance) : 3 }))
  const selected: MemoryFactRecord[] = []
  let remaining = safeBudget
  for (const item of items) {
    if (isMemoryFact(item.fact) && item.fact.status !== 'active') continue
    const tokens = estimateTokens(memoryFactToText(item.fact), model) + 1
    if (tokens > remaining) continue
    selected.push(item.fact)
    remaining -= tokens
  }
  return selected
}

/** 按 Token 预算裁剪文本，始终保留开头的高优先级内容。 */
function truncateMemoryText(
  text: string,
  budget: number,
  estimateTokens: (text: string, model?: string) => number,
  model?: string,
): string {
  let result = text ?? ''
  while (result.length > 0 && estimateTokens(result, model) > budget) {
    result = result.slice(0, Math.max(0, result.length - 100))
  }
  return result
}

/**
 * 分层记忆预算：当前状态优先，其次相关事实，最后才是时间线。
 * 旧会话没有 currentState 时不会为该层预留预算，保持原有摘要可用空间。
 */
export function fitLayeredMemoryBudget(
  currentState: string | undefined | null,
  timeline: string,
  facts: MemoryFactRecord[] | undefined | null,
  budget: number,
  estimateTokens: (text: string, model?: string) => number,
  model?: string,
  semanticScores?: number[] | null,
): { currentState: string; timeline: string; facts: MemoryFactRecord[]; retrievalMode: 'semantic' | 'fallback' } {
  const safeBudget = Math.max(50, Math.floor(budget))
  const stateText = currentState?.trim() ?? ''
  const stateBudget = stateText
    ? Math.min(240, Math.max(30, Math.floor(safeBudget * 0.3)))
    : 0
  const fittedState = stateBudget > 0
    ? truncateMemoryText(stateText, stateBudget, estimateTokens, model)
    : ''
  const remaining = Math.max(0, safeBudget - estimateTokens(fittedState, model))
  // 事实优先于时间线：保留 40% 预算给事实；没有事实时全部空间回流给时间线。
  // 阶段三：检索排序 + 预算跳过（单条超限跳过继续）；透传 semanticScores 到预算层
  const hasSemantic = Array.isArray(semanticScores) && semanticScores.length === (facts ?? []).length && semanticScores.some((s) => s > 0)
  const retrievalMode: 'semantic' | 'fallback' = hasSemantic ? 'semantic' : 'fallback'
  const rankedFacts = scoreAndRankFacts(facts ?? [], semanticScores ?? null).map((r) => r.fact)
  let factsRemaining = Math.max(0, Math.floor(remaining * 0.4))
  const fittedFacts: MemoryFactRecord[] = []
  for (const fact of rankedFacts) {
    if (isMemoryFact(fact) && fact.status !== 'active') continue
    const tokens = estimateTokens(memoryFactToText(fact), model) + 1
    if (tokens > factsRemaining) continue
    fittedFacts.push(fact)
    factsRemaining -= tokens
  }
  const usedFactTokens = fittedFacts.reduce((total, fact) => total + estimateTokens(memoryFactToText(fact), model) + 1, 0)
  const timelineBudget = Math.max(0, remaining - usedFactTokens)
  const fittedTimeline = truncateMemoryText(timeline ?? '', timelineBudget, estimateTokens, model)
  return { currentState: fittedState, timeline: fittedTimeline, facts: fittedFacts, retrievalMode }
}

/**
 * 将事实列表格式化为注入文本。
 * 空列表返回空字符串。
 */
export function formatMemoryFacts(facts: MemoryFactRecord[] | undefined | null): string {
  if (!facts || facts.length === 0) return ''
  return memoryFactsToTexts(facts).map((fact, i) => `${i + 1}. ${fact}`).join('\n')
}

/**
 * @deprecated 已由 fitLayeredMemoryBudget 替代（分层预算 + 检索排序），仅保留兼容旧调用，待清理。
 * 记忆注入预算裁剪：优先保留摘要（占预算 60%），事实按顺序填满剩余预算。
 */
export function fitMemoryBudget(
  summary: string,
  facts: MemoryFactRecord[] | undefined | null,
  budget: number,
  estimateTokens: (text: string, model?: string) => number,
  model?: string,
): { summary: string; facts: MemoryFactRecord[] } {
  const safeBudget = Math.max(50, Math.floor(budget))
  const summaryBudget = Math.max(30, Math.floor(safeBudget * 0.6))

  // 摘要：超过预算时从尾部截断（保持开头信息）
  let s = summary ?? ''
  while (s.length > 50 && estimateTokens(s, model) > summaryBudget) {
    s = s.slice(0, Math.max(50, s.length - 100))
  }

  // 事实：按顺序保留，直到填满剩余预算
  const list = facts ?? []
  let remaining = safeBudget - estimateTokens(s, model)
  const kept: MemoryFactRecord[] = []
  for (const f of list) {
    if (isMemoryFact(f) && f.status !== 'active') continue
    const t = estimateTokens(memoryFactToText(f), model) + 1 // +1 编号开销
    if (t > remaining) break
    kept.push(f)
    remaining -= t
  }
  return { summary: s, facts: kept }
}
