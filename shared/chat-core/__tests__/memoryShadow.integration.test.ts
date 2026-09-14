/**
 * W8（主计划 §7.10）：动态记忆注入端到端测试（G1 后接管口径）。
 *
 * 关键断言：
 * - 记忆三段仍进入 system；存储只读；
 * - 大预算可超过旧 800 上限；小预算分级让位且不超预算；
 * - `memoryShadow` existing=本轮注入；报告不含正文；
 * - 同一输入重复构建结果稳定。
 */
import { describe, expect, it } from 'vitest'
import type { MemoryFact } from '../../../shared/types'
import type { FactSearchHit } from '../../../shared/ipc-api'
import { buildContextMessagesFromData } from '../contextBuilder'
import { formatMemoryShadowSummary, type MemoryShadowReport } from '../memoryCandidates'
import { makeChat, makeData, makeFact, makeMessage, makePreset } from './contextBuildFixtures'

function makeFacts(count: number): MemoryFact[] {
  return Array.from({ length: count }, (_, index) => makeFact({
    id: `fact-${index}`,
    subject: `主体${index}`,
    predicate: '属性',
    value: `事实值${index}${'内容'.repeat(8)}`,
    importance: ((index % 5) + 1) as MemoryFact['importance'],
    updatedAt: 1000 + index,
  }))
}

function makeTimeline(lines: number): string {
  return Array.from({ length: lines }, (_, index) => `${index + 1}. 第${index + 1}件长期事件${'经过'.repeat(12)}`).join('\n')
}

function makeMemoryData(options: {
  maxContext: number
  facts: MemoryFact[]
  timelineLines: number
  semanticHits?: FactSearchHit[]
  currentState?: string
}) {
  return makeData({
    preset: makePreset({ maxContext: options.maxContext, maxTokens: 1024 }),
    chat: makeChat({
      messages: [
        makeMessage({ id: 'm1', role: 'user', content: '今天废土上有沙尘暴。', timestamp: 1000 }),
        makeMessage({ id: 'm2', role: 'assistant', content: '是的，我们得找个避风处。', timestamp: 2000 }),
        makeMessage({ id: 'm3', role: 'user', content: '那栋大楼看起来安全。', timestamp: 3000 }),
      ],
      sessions: [
        {
          id: 's1',
          characterId: 'char-01',
          title: '废土之旅',
          createdAt: 0,
          updatedAt: 4000,
          memoryEnabled: true,
          memoryMode: 'auto',
          autoMemoryInterval: 10,
          memoryCurrentState: options.currentState ?? `当前状态：${'躲避沙尘暴'.repeat(10)}`,
          memory: makeTimeline(options.timelineLines),
          memoryUpdatedAt: 3500,
          memoryFacts: options.facts,
          messageCount: 3,
          lastMessage: '那栋大楼看起来安全。',
        },
      ],
      semanticFactsHits: options.semanticHits ?? [],
    }),
  })
}

function memoryMarkerTexts(facts: MemoryFact[], timelineLines: number, currentState: string): string[] {
  return [
    currentState,
    ...facts.slice(0, 6).map((fact) => fact.value),
    '第1件长期事件',
    `第${timelineLines}件长期事件`,
  ]
}

describe('W8 记忆影子：不改变生产注入', () => {
  const facts = makeFacts(6)

  it('开启/关闭影子得到完全一致的 messages 与 maxTokens', () => {
    const data = makeMemoryData({ maxContext: 16384, facts, timelineLines: 8 })
    const withShadow = buildContextMessagesFromData(data)
    const withoutShadow = buildContextMessagesFromData(data, { shadow: 'off' })
    expect(withShadow.messages).toEqual(withoutShadow.messages)
    expect(withShadow.requestMaxTokens).toBe(withoutShadow.requestMaxTokens)
    expect(withShadow.lastContextUsage).toEqual(withoutShadow.lastContextUsage)
    expect(withShadow.memoryShadow).toBeDefined()
    expect(withoutShadow.memoryShadow).toBeUndefined()
  })

  it('接管后：状态/事实/时间线仍按候选注入进 system', () => {
    const data = makeMemoryData({ maxContext: 16384, facts, timelineLines: 8 })
    const systemText = buildContextMessagesFromData(data).messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n')
    const session = data.chat.sessions[0]
    expect(systemText).toContain(session.memoryCurrentState!)
    expect(systemText).toContain('【关键事实】')
    expect(systemText).toContain('【对话时间线】')
    expect(systemText).toContain(facts[0].value)
  })

  it('接管后：大预算可注入超过旧 800 上限的记忆量', () => {
    const bigFacts = makeFacts(40)
    const data = makeMemoryData({ maxContext: 200000, facts: bigFacts, timelineLines: 20 })
    const built = buildContextMessagesFromData(data)
    const systemText = built.messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n')
    // 候选注入不再受 min(800, 10%) 硬顶：至少状态与部分事实应完整可见
    expect(systemText).toContain('【当前状态】')
    expect(systemText).toContain(bigFacts[0].value)
    expect(built.memoryShadow!.existing.capTokens).toBeGreaterThan(800)
  })

  it('构建过程不修改输入数据快照（记忆存储只读）', () => {
    const data = makeMemoryData({ maxContext: 16384, facts, timelineLines: 8 })
    const snapshot = JSON.stringify(data)
    buildContextMessagesFromData(data)
    expect(JSON.stringify(data)).toBe(snapshot)
  })

  it('同一份数据重复构建，记忆影子报告稳定', () => {
    const first = buildContextMessagesFromData(makeMemoryData({ maxContext: 16384, facts, timelineLines: 8 })).memoryShadow
    const second = buildContextMessagesFromData(makeMemoryData({ maxContext: 16384, facts, timelineLines: 8 })).memoryShadow
    expect(second).toEqual(first)
  })
})

describe('W8 记忆影子：口径与验收（接管后）', () => {
  it('接管后 cap = budgetBase（统一输入池，无 min(800,10%) 专属上限）', () => {
    const facts = makeFacts(6)
    const built = buildContextMessagesFromData(makeMemoryData({ maxContext: 16384, facts, timelineLines: 8 }))
    const report = built.memoryShadow!
    expect(report.existing.capTokens).toBe(built.lastContextUsage.max)
    expect(report.existing.totalTokens).toBeGreaterThan(0)
    expect(report.retrievalMode).toBe('fallback')
    const sumExisting = report.byLayer.reduce((sum, diff) => sum + diff.existingTokens, 0)
    expect(sumExisting).toBe(report.existing.totalTokens)
    // 接管后 existing=本轮注入、plan=全量候选：delta 表示未注入进全量的差
    expect(report.deltaTokens).toBe(report.candidate.totalTokens - report.existing.totalTokens)
  })

  it('大窗口：注入量可超过旧 800 上限（§7.10 验收，接管后 existing 即候选注入）', () => {
    const facts = makeFacts(60)
    const built = buildContextMessagesFromData(makeMemoryData({
      maxContext: 200000,
      facts,
      timelineLines: 8,
      currentState: `当前状态：${'躲避沙尘暴'.repeat(20)}`,
    }))
    const report = built.memoryShadow!
    expect(report.existing.totalTokens).toBeGreaterThan(800)
    expect(report.existing.capTokens).toBeGreaterThan(800)
    expect(report.candidate.overBudget).toBe(false)
  })

  it('小窗口 + 超量记忆：分级让位、不超预算、不丢 mandatory', () => {
    const facts = makeFacts(200)
    const built = buildContextMessagesFromData(makeMemoryData({ maxContext: 8192, facts, timelineLines: 60 }))
    const report = built.memoryShadow!
    const shadow = built.contextShadow!
    expect(report.degraded).toBe(false)
    expect(report.candidate.overBudget).toBe(false)
    expect(report.candidate.totalTokens).toBeLessThanOrEqual(report.budgetTokens)
    expect(report.candidate.droppedFactCount + report.candidate.droppedTimelineChunkCount).toBeGreaterThan(0)
    // W7 影子同口径：mandatory 在预算可行时不得丢失
    expect(shadow.mandatoryOverBudget).toBe(false)
  })

  it('语义命中驱动：仅命中事实进入既有注入，候选口径标记 semantic', () => {
    const facts = makeFacts(12)
    const hits: FactSearchHit[] = [
      { text: facts[2].value, index: 2, score: 0.9 },
      { text: facts[7].value, index: 7, score: 0.8 },
      { text: facts[11].value, index: 11, score: 0.7 },
    ]
    const data = makeMemoryData({ maxContext: 65536, facts, timelineLines: 4, semanticHits: hits })
    const built = buildContextMessagesFromData(data)
    const systemText = built.messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n')
    expect(systemText).toContain(facts[2].value)
    expect(systemText).not.toContain(facts[0].value)
    const report = built.memoryShadow!
    expect(report.retrievalMode).toBe('semantic')
    expect(report.existing.factCount).toBeLessThanOrEqual(hits.length)
  })

  it('报告与日志串不含记忆正文或事实文本', () => {
    const facts = makeFacts(10)
    const currentState = `当前状态：${'躲避沙尘暴'.repeat(10)}`
    const built = buildContextMessagesFromData(makeMemoryData({
      maxContext: 131072,
      facts,
      timelineLines: 20,
      currentState,
    }))
    const report = built.memoryShadow!
    const serialized = `${JSON.stringify(report)}\n${formatMemoryShadowSummary(report)}`
    for (const marker of memoryMarkerTexts(facts, 20, currentState)) {
      expect(serialized).not.toContain(marker)
    }
    expect(formatMemoryShadowSummary(report)).toContain('mode=memory-shadow')
  })

  it('记忆影子报告不与影子采集器相互影响（同一轮两个报告都存在）', () => {
    const built = buildContextMessagesFromData(makeMemoryData({ maxContext: 16384, facts: makeFacts(6), timelineLines: 8 }))
    expect(built.contextShadow).toBeDefined()
    expect(built.memoryShadow).toBeDefined()
    const memory: MemoryShadowReport = built.memoryShadow!
    expect(memory.candidate.totalTokens).toBeGreaterThanOrEqual(0)
    expect(built.contextShadow!.budgetTokens).toBe(memory.budgetTokens)
  })
})
