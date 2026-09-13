/**
 * W7 fixture：固定上下文场景（主计划 §7.9 第 5 条 / §9.3 第 1–6 条）。
 *
 * 只描述候选的"分类 + token + 数值评分"，由 `buildCandidates` 组装成真实形状的候选集；
 * **fixture 不含任何正文、提示词、角色卡或世界书内容**——文本只存在于端到端影子测试的
 * 构造数据里，且断言其不会进入影子报告。
 *
 * 预算口径与 `contextBuilder` 的 `budgetBase` 完全一致：
 * `max(floor((maxContext − reservedOutput) × TOKEN_BUDGET_SAFETY), floor(maxContext × 0.25))`。
 */

import { TOKEN_BUDGET_SAFETY } from '../chatConstants'
import { IMAGE_TOKEN_ESTIMATE } from '../tokenCounter'
import type { ContextCandidate, ContextCandidateKind } from '../contextCandidates'

export interface CandidateSpec {
  id: string
  kind: ContextCandidateKind
  tokens: number
  mandatory?: boolean
  stablePrefix?: boolean
  relevance?: number
  recency?: number
  importance?: number
  continuity?: number
  dedupeKey?: string
}

export interface ContextScenarioExpectations {
  /** 预算可行时必须全部入选的候选 id */
  mustSelectIds: string[]
  /** mandatory 合计是否落在预算内（决定"不超预算"断言是否适用） */
  mandatoryFitsBudget: boolean
  /** 至少入选的 token 数（防止分配器过度保守） */
  minSelectedTokens: number
  /** 期望被丢弃的候选 id（严格场景才给） */
  mustDropIds?: string[]
  /** 内容远小于预算时不得填充（selectedTokens 必须显著小于预算） */
  noPadding?: boolean
}

export interface ContextScenario {
  name: string
  description: string
  /** 模型窗口 */
  contextLimit: number
  /** 与 `ChatParams.maxTokens` 同源的输出预留 */
  reservedOutputTokens: number
  candidates: CandidateSpec[]
  expectations: ContextScenarioExpectations
}

/** 与 contextBuilder 的 budgetBase 同口径 */
export function contextBudgetBase(contextLimit: number, reservedOutputTokens: number): number {
  return Math.max(
    Math.floor((contextLimit - reservedOutputTokens) * TOKEN_BUDGET_SAFETY),
    Math.floor(contextLimit * 0.25),
  )
}

/** 规格 → 候选（originalOrder 按数组顺序，保证 fixture 本身确定） */
export function buildCandidates(specs: readonly CandidateSpec[]): ContextCandidate[] {
  return specs.map((spec, index) => ({
    id: spec.id,
    kind: spec.kind,
    estimatedTokens: spec.tokens,
    mandatory: spec.mandatory ?? false,
    stablePrefix: spec.stablePrefix ?? false,
    relevance: spec.relevance ?? 0.5,
    recency: spec.recency ?? 0.5,
    importance: spec.importance ?? 0.5,
    continuity: spec.continuity ?? 0.5,
    ...(spec.dedupeKey ? { dedupeKey: spec.dedupeKey } : {}),
    originalOrder: index,
  }))
}

/** 协议块（mandatory，默认进稳定前缀） */
function protocolSpecs(): CandidateSpec[] {
  return [
    { id: 'protocol:system-prompt', kind: 'protocol', tokens: 140, mandatory: true, stablePrefix: true, relevance: 1, recency: 1, importance: 1, continuity: 1 },
    { id: 'protocol:narrative-mode', kind: 'protocol', tokens: 90, mandatory: true, stablePrefix: true, relevance: 1, recency: 1, importance: 1, continuity: 1 },
    { id: 'protocol:thought-system', kind: 'protocol', tokens: 260, mandatory: true, stablePrefix: true, relevance: 1, recency: 1, importance: 1, continuity: 1 },
    { id: 'protocol:body-format-tail', kind: 'protocol', tokens: 200, mandatory: true, stablePrefix: false, relevance: 1, recency: 1, importance: 1, continuity: 1 },
  ]
}

/**
 * 历史候选：index 0 = 最早，末尾 = 最新（与 `recentMessages` 顺序一致），
 * 近因按距末尾位置归一化，使最近约一半落入第 2 顺位（§5.5 第 2 条）。
 */
function historySpecs(
  prefix: string,
  count: number,
  tokensEach: number,
  overrides: { relevance?: number; recency?: number; importance?: number; continuity?: number } = {},
): CandidateSpec[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}${index}`,
    kind: 'history' as const,
    tokens: tokensEach,
    relevance: overrides.relevance ?? 0.7,
    recency: overrides.recency ?? (count <= 1 ? 1 : (index + 1) / count),
    importance: overrides.importance ?? 0.6,
    continuity: overrides.continuity ?? 0.9,
  }))
}

function worldbookSpec(id: string, tokens: number, relevance: number, importance: number): CandidateSpec {
  return { id, kind: 'worldbook', tokens, relevance, recency: 0.5, importance, continuity: 0.4 }
}

function factSpecs(count: number, tokensEach: number, relevance: number): CandidateSpec[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `memory:fact:${index}`,
    kind: 'memory' as const,
    tokens: tokensEach,
    dedupeKey: `fact:${index}`,
    relevance,
    // importance 递增：序号越大越重要
    importance: count <= 1 ? 0.6 : 0.2 + (0.8 * index) / (count - 1),
    recency: 0.5,
    continuity: 0.4,
  }))
}

/** §9.3-1：8K 小窗口 + 长角色卡 */
const SMALL_WINDOW_LONG_CHARACTER: ContextScenario = {
  name: 'small-window-long-character',
  description: '8K 小窗口 + 超长角色卡：mandatory 必须全保留，较早历史先被丢弃',
  contextLimit: 8192,
  reservedOutputTokens: 1024,
  candidates: [
    ...protocolSpecs(),
    { id: 'character:core', kind: 'character', tokens: 3200, mandatory: true, stablePrefix: true, relevance: 0.9, recency: 1, importance: 1, continuity: 0.9 },
    { id: 'character:user-persona', kind: 'character', tokens: 180, relevance: 0.6, recency: 1, importance: 0.7, continuity: 0.8 },
    worldbookSpec('worldbook:prompt_end', 400, 0.55, 0.6),
    { id: 'example:dialog', kind: 'example', tokens: 500, relevance: 0.5, recency: 1, importance: 0.6, continuity: 0.6 },
    ...historySpecs('history:msg:', 40, 80),
  ],
  expectations: {
    mustSelectIds: [
      'protocol:system-prompt', 'protocol:narrative-mode', 'protocol:thought-system',
      'protocol:body-format-tail', 'character:core',
    ],
    mandatoryFitsBudget: true,
    minSelectedTokens: 6000,
    noPadding: true,
  },
}

/** §9.3-2：64K + 100 轮普通单聊 */
const SINGLE_CHAT_64K_100_TURNS: ContextScenario = {
  name: 'single-chat-64k-100-turns',
  description: '64K + 100 轮普通单聊：内容远小于预算，必须全量注入且不填充',
  contextLimit: 65536,
  reservedOutputTokens: 4000,
  candidates: [
    { id: 'protocol:system-prompt', kind: 'protocol', tokens: 400, mandatory: true, stablePrefix: true, relevance: 1, recency: 1, importance: 1, continuity: 1 },
    { id: 'protocol:thought-system', kind: 'protocol', tokens: 260, mandatory: true, stablePrefix: true, relevance: 1, recency: 1, importance: 1, continuity: 1 },
    { id: 'protocol:body-format-tail', kind: 'protocol', tokens: 200, mandatory: true, relevance: 1, recency: 1, importance: 1, continuity: 1 },
    { id: 'character:core', kind: 'character', tokens: 1200, mandatory: true, stablePrefix: true, relevance: 0.9, recency: 1, importance: 1, continuity: 0.9 },
    { id: 'character:user-persona', kind: 'character', tokens: 200, relevance: 0.6, recency: 1, importance: 0.7, continuity: 0.8 },
    { id: 'memory:current-state', kind: 'current-state', tokens: 200, relevance: 0.9, recency: 1, importance: 0.9, continuity: 0.9 },
    ...factSpecs(20, 30, 0.6),
    { id: 'memory:timeline', kind: 'memory', tokens: 800, relevance: 0.5, recency: 0.8, importance: 0.7, continuity: 0.5 },
    worldbookSpec('worldbook:before_character', 3000, 0.55, 0.8),
    worldbookSpec('worldbook:prompt_end', 1500, 0.55, 0.6),
    ...historySpecs('history:msg:', 100, 60),
    { id: 'example:dialog', kind: 'example', tokens: 700, relevance: 0.5, recency: 1, importance: 0.6, continuity: 0.6 },
  ],
  expectations: {
    mustSelectIds: ['protocol:system-prompt', 'character:core', 'memory:current-state', 'history:msg:0', 'history:msg:99'],
    mandatoryFitsBudget: true,
    minSelectedTokens: 15000,
    noPadding: true,
  },
}

/** §9.3-3：128K + 大世界书 + 长记忆 */
const LOREBOOK_128K_LONG_MEMORY: ContextScenario = {
  name: 'lorebook-128k-long-memory',
  description: '128K + 大世界书 + 长记忆：高相关世界书与长期事实优先于示例与旧历史',
  contextLimit: 131072,
  reservedOutputTokens: 8192,
  candidates: [
    ...protocolSpecs(),
    { id: 'character:core', kind: 'character', tokens: 2000, mandatory: true, stablePrefix: true, relevance: 0.9, recency: 1, importance: 1, continuity: 0.9 },
    { id: 'memory:current-state', kind: 'current-state', tokens: 300, relevance: 0.9, recency: 1, importance: 0.9, continuity: 0.9 },
    ...factSpecs(40, 35, 0.7),
    { id: 'memory:timeline', kind: 'memory', tokens: 3000, relevance: 0.6, recency: 0.8, importance: 0.7, continuity: 0.5 },
    worldbookSpec('worldbook:before_character', 4000, 0.65, 0.8),
    worldbookSpec('worldbook:prompt_end', 2500, 0.6, 0.6),
    worldbookSpec('worldbook:chat_depth', 3000, 0.45, 0.5),
    ...historySpecs('history:msg:', 150, 70),
    { id: 'example:dialog', kind: 'example', tokens: 1200, relevance: 0.5, recency: 1, importance: 0.6, continuity: 0.6 },
  ],
  expectations: {
    mustSelectIds: ['character:core', 'memory:current-state', 'worldbook:before_character', 'history:msg:149'],
    mandatoryFitsBudget: true,
    minSelectedTokens: 25000,
    noPadding: true,
  },
}

/** §9.3-4：1M 窗口 + 100 轮，验证不无条件塞满低价值内容 */
const MILLION_WINDOW_100_TURNS: ContextScenario = {
  name: 'million-window-100-turns',
  description: '1M 窗口 + 100 轮：预算极宽也不填充；预算收紧时低价值尾部先被丢弃',
  contextLimit: 1048576,
  reservedOutputTokens: 8192,
  candidates: [
    ...protocolSpecs(),
    { id: 'character:core', kind: 'character', tokens: 1500, mandatory: true, stablePrefix: true, relevance: 0.9, recency: 1, importance: 1, continuity: 0.9 },
    { id: 'memory:current-state', kind: 'current-state', tokens: 300, relevance: 0.9, recency: 1, importance: 0.9, continuity: 0.9 },
    ...factSpecs(30, 30, 0.7),
    { id: 'memory:timeline', kind: 'memory', tokens: 2000, relevance: 0.6, recency: 0.8, importance: 0.7, continuity: 0.5 },
    worldbookSpec('worldbook:high-relevance', 20000, 0.8, 0.8),
    worldbookSpec('worldbook:low-relevance', 40000, 0.3, 0.3),
    ...historySpecs('history:recent:', 100, 70),
    ...historySpecs('history:old-raw:', 300, 70, { relevance: 0.4, recency: 0.05, importance: 0.4, continuity: 0.2 }),
    { id: 'example:dialog', kind: 'example', tokens: 5000, relevance: 0.5, recency: 1, importance: 0.6, continuity: 0.6 },
  ],
  expectations: {
    mustSelectIds: ['character:core', 'worldbook:high-relevance', 'history:recent:99'],
    mandatoryFitsBudget: true,
    minSelectedTokens: 90000,
    noPadding: true,
  },
}

/** §9.3-5：多角色群聊 */
const GROUP_CHAT_MULTI_CHARACTER: ContextScenario = {
  name: 'group-chat-multi-character',
  description: '多角色群聊：当前参与者状态与本人近期回合优先，他人已完成旧回合最后保留',
  contextLimit: 65536,
  reservedOutputTokens: 3000,
  candidates: [
    { id: 'protocol:group-roster', kind: 'protocol', tokens: 400, mandatory: true, stablePrefix: true, relevance: 1, recency: 1, importance: 1, continuity: 1 },
    { id: 'protocol:group-turn-rules', kind: 'protocol', tokens: 500, mandatory: true, stablePrefix: true, relevance: 1, recency: 1, importance: 1, continuity: 1 },
    { id: 'protocol:system-prompt', kind: 'protocol', tokens: 140, mandatory: true, stablePrefix: true, relevance: 1, recency: 1, importance: 1, continuity: 1 },
    { id: 'group-state:participants', kind: 'group-state', tokens: 250, mandatory: true, relevance: 0.95, recency: 1, importance: 0.9, continuity: 0.95 },
    { id: 'group-state:scene', kind: 'group-state', tokens: 150, relevance: 0.8, recency: 1, importance: 0.7, continuity: 0.9 },
    { id: 'character:core', kind: 'character', tokens: 1200, mandatory: true, stablePrefix: true, relevance: 0.9, recency: 1, importance: 1, continuity: 0.9 },
    ...historySpecs('history:active-speaker:', 6, 90),
    ...historySpecs('history:other-character:', 24, 90, { relevance: 0.4, recency: 0.3, importance: 0.4, continuity: 0.3 }),
    worldbookSpec('worldbook:group-scene', 1500, 0.6, 0.7),
    { id: 'memory:current-state', kind: 'current-state', tokens: 200, relevance: 0.9, recency: 1, importance: 0.9, continuity: 0.9 },
    ...factSpecs(10, 30, 0.6),
  ],
  expectations: {
    mustSelectIds: ['protocol:group-roster', 'group-state:participants', 'history:active-speaker:5'],
    mandatoryFitsBudget: true,
    minSelectedTokens: 5000,
    noPadding: true,
  },
}

/** §9.3-6：图片与工具定义 */
const IMAGES_AND_TOOLS: ContextScenario = {
  name: 'images-and-tools',
  description: '图片与工具定义：工具定义 mandatory 必须保留，低价值图片先被丢弃',
  contextLimit: 16384,
  reservedOutputTokens: 4096,
  candidates: [
    { id: 'protocol:system-prompt', kind: 'protocol', tokens: 140, mandatory: true, stablePrefix: true, relevance: 1, recency: 1, importance: 1, continuity: 1 },
    { id: 'protocol:tool-definitions', kind: 'protocol', tokens: 5000, mandatory: true, stablePrefix: true, relevance: 1, recency: 1, importance: 1, continuity: 1 },
    { id: 'character:core', kind: 'character', tokens: 900, mandatory: true, stablePrefix: true, relevance: 0.9, recency: 1, importance: 1, continuity: 0.9 },
    worldbookSpec('worldbook:prompt_end', 1200, 0.55, 0.6),
    { id: 'example:dialog', kind: 'example', tokens: 500, relevance: 0.5, recency: 1, importance: 0.6, continuity: 0.6 },
    ...historySpecs('history:text:', 10, 60),
    ...Array.from({ length: 12 }, (_, index) => ({
      id: `history:image:${index}`,
      kind: 'history' as const,
      tokens: 60 + IMAGE_TOKEN_ESTIMATE,
      relevance: 0.4,
      recency: 0.2,
      importance: 0.4,
      continuity: 0.3,
    })),
  ],
  expectations: {
    mustSelectIds: ['protocol:tool-definitions', 'protocol:system-prompt', 'character:core'],
    mandatoryFitsBudget: true,
    minSelectedTokens: 8000,
    mustDropIds: ['history:image:6', 'history:image:11'],
  },
}

/** §9.3-7：语义检索不可用 fallback（低相关但高重要度的旧事实仍要按重要度排序） */
const MEMORY_FALLBACK_NO_SEMANTIC: ContextScenario = {
  name: 'memory-fallback-no-semantic',
  description: '语义检索不可用：事实按 importance+recency 的保守相关度参与统一分配',
  contextLimit: 32768,
  reservedOutputTokens: 2000,
  candidates: [
    ...protocolSpecs(),
    { id: 'character:core', kind: 'character', tokens: 800, mandatory: true, stablePrefix: true, relevance: 0.9, recency: 1, importance: 1, continuity: 0.9 },
    { id: 'memory:current-state', kind: 'current-state', tokens: 200, relevance: 0.9, recency: 1, importance: 0.9, continuity: 0.9 },
    ...factSpecs(25, 40, 0.4),
    { id: 'memory:timeline', kind: 'memory', tokens: 1500, relevance: 0.5, recency: 0.8, importance: 0.7, continuity: 0.5 },
    ...historySpecs('history:msg:', 40, 70),
  ],
  expectations: {
    mustSelectIds: ['character:core', 'memory:current-state', 'memory:fact:24'],
    mandatoryFitsBudget: true,
    minSelectedTokens: 3000,
    noPadding: true,
  },
}

/** 全部固定场景（顺序稳定，供参数化用例遍历） */
export const CONTEXT_SCENARIOS: readonly ContextScenario[] = [
  SMALL_WINDOW_LONG_CHARACTER,
  SINGLE_CHAT_64K_100_TURNS,
  LOREBOOK_128K_LONG_MEMORY,
  MILLION_WINDOW_100_TURNS,
  GROUP_CHAT_MULTI_CHARACTER,
  IMAGES_AND_TOOLS,
  MEMORY_FALLBACK_NO_SEMANTIC,
]

export function scenarioByName(name: string): ContextScenario {
  const scenario = CONTEXT_SCENARIOS.find((item) => item.name === name)
  if (!scenario) throw new Error(`未知上下文场景：${name}`)
  return scenario
}
