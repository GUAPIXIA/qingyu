/**
 * W7（主计划 §7.9 第 3/6 条）：影子运行端到端测试。
 *
 * 关键断言：
 * - 开启/关闭影子得到**完全相同**的 messages 与 requestMaxTokens（影子不得改变行为）；
 * - 报告只含分类计数与 token，不含任何正文/提示词/角色卡/凭据；
 * - 现有注入口径与既有 `lastContextUsage.used` 的差异可解释（历史正文与分类求和口径）；
 * - 采集异常兜底（degraded），绝不抛出到生成链路。
 */
import { describe, expect, it } from 'vitest'
import { buildContextMessagesFromData } from '../contextBuilder'
import { createContextShadowCollector, formatContextShadowSummary, type ContextShadowReport } from '../contextShadow'
import type { ContextCandidateKind } from '../contextCandidates'
// W7/W8 共用 fixture（真实形状的单聊快照；含可识别内容标记用于隐私断言）
import { CONTENT_MARKERS, makeChat, makeCharacter, makeData, makeMessage, makePreset } from './contextBuildFixtures'

/** 报告分类 → 差值表 */
function byKind(report: ContextShadowReport): Map<ContextCandidateKind, ContextShadowReport['byKind'][number]> {
  return new Map(report.byKind.map((diff) => [diff.kind, diff]))
}

describe('W7 影子运行：不改变生产注入', () => {
  it('开启影子与关闭影子得到完全一致的 messages / maxTokens / 用量', () => {
    const data = makeData()
    const withShadow = buildContextMessagesFromData(data)
    const withoutShadow = buildContextMessagesFromData(data, { shadow: 'off' })
    expect(withShadow.messages).toEqual(withoutShadow.messages)
    expect(withShadow.requestMaxTokens).toBe(withoutShadow.requestMaxTokens)
    expect(withShadow.lastContextUsage).toEqual(withoutShadow.lastContextUsage)
    expect(withShadow.contextShadow).toBeDefined()
    expect(withoutShadow.contextShadow).toBeUndefined()
  })

  it('构建过程不修改输入数据快照', () => {
    const data = makeData()
    const snapshot = JSON.stringify(data)
    buildContextMessagesFromData(data)
    expect(JSON.stringify(data)).toBe(snapshot)
  })

  it('同一份数据重复构建，影子报告稳定', () => {
    const first = buildContextMessagesFromData(makeData()).contextShadow
    const second = buildContextMessagesFromData(makeData()).contextShadow
    expect(second).toEqual(first)
  })
})

describe('W7 影子运行：报告口径', () => {
  const built = buildContextMessagesFromData(makeData())
  const report = built.contextShadow!

  it('覆盖协议 / 角色 / 记忆 / 世界书 / 历史，且未降级', () => {
    expect(report.degraded).toBe(false)
    expect(report.candidateCount).toBeGreaterThanOrEqual(12)
    const kinds = byKind(report)
    expect(kinds.get('protocol')!.existingCount).toBeGreaterThanOrEqual(4)
    expect(kinds.get('character')!.existingCount).toBeGreaterThanOrEqual(2)
    expect(kinds.get('current-state')!.existingCount).toBe(1)
    expect(kinds.get('memory')!.existingCount).toBeGreaterThanOrEqual(3)
    expect(kinds.get('worldbook')!.existingCount).toBeGreaterThanOrEqual(1)
    expect(kinds.get('example')!.existingCount).toBe(1)
    expect(kinds.get('history')!.existingCount).toBe(3)
  })

  it('与既有用量口径可对齐：existingReportedTokens 等于 lastContextUsage.used', () => {
    expect(report.existingReportedTokens).toBe(built.lastContextUsage.used)
    expect(report.budgetTokens).toBe(built.lastContextUsage.max)
    // 两种口径的已知差异（差值有界、可解释，见 W7 报告「口径」一节）：
    // 1) 既有 used 不含保留历史正文的 token，影子分类求和包含 → byKind.history.existingTokens > 0；
    // 2) 既有 used 按合并后的 systemContent 整体估算（含【当前状态】等小节标题与连接符），
    //    影子按块分别估算（标题/连接符不计入任何块）→ 影子略低于既有 used。
    expect(byKind(report).get('history')!.existingTokens).toBeGreaterThan(0)
    const reported = report.existingReportedTokens ?? 0
    expect(Math.abs(report.existingTokens - reported)).toBeLessThanOrEqual(Math.max(50, reported * 0.05))
  })

  it('预算可行时不超预算，且分类差值与总量自洽', () => {
    expect(report.mandatoryOverBudget).toBe(false)
    expect(report.overBudget).toBe(false)
    expect(report.shadowTokens).toBeLessThanOrEqual(report.budgetTokens)
    expect(report.deltaTokens).toBe(report.shadowTokens - report.existingTokens)
    const sumExisting = report.byKind.reduce((sum, diff) => sum + diff.existingTokens, 0)
    const sumShadow = report.byKind.reduce((sum, diff) => sum + diff.shadowTokens, 0)
    expect(sumExisting).toBe(report.existingTokens)
    expect(sumShadow).toBe(report.shadowTokens)
    expect(report.selectedCount).toBeGreaterThan(0)
  })

  it('报告与日志串不含正文、提示词、凭据或完整端点', () => {
    const serialized = `${JSON.stringify(report)}\n${formatContextShadowSummary(report)}`
    for (const marker of CONTENT_MARKERS) {
      expect(serialized).not.toContain(marker)
    }
    expect(formatContextShadowSummary(report)).toContain('mode=shadow')
    expect(formatContextShadowSummary(report)).toContain('kinds=')
  })

  it('小窗口 + 长角色卡：裁剪已发生在既有链路，影子不超预算且无强制保留丢失', () => {
    const data = makeData({
      preset: makePreset({ maxContext: 8192, maxTokens: 1024 }),
      character: makeCharacter({ description: '一位来自未来的仿生人'.repeat(200) }),
      chat: makeChat({
        messages: Array.from({ length: 60 }, (_, index) => makeMessage({
          id: `history-${index}`,
          role: index % 2 === 0 ? 'user' : 'assistant',
          content: `第 ${index} 轮：${'废土上又起了沙尘暴，我们继续往北走。'.repeat(20)}`,
          timestamp: 1000 + index,
        })),
      }),
    })
    const small = buildContextMessagesFromData(data)
    const smallReport = small.contextShadow!
    const kinds = byKind(smallReport)
    expect(smallReport.degraded).toBe(false)
    expect(smallReport.mandatoryOverBudget).toBe(false)
    expect(smallReport.overBudget).toBe(false)
    expect(smallReport.shadowTokens).toBeLessThanOrEqual(smallReport.budgetTokens)
    // cropHistory 已按预算裁剪：描述到的历史条数必须少于原始 60 条
    expect(kinds.get('history')!.existingCount).toBeLessThan(60)
    // 影子选择不会多于既有注入（既有实现已把总量压到预算内）
    expect(kinds.get('history')!.shadowTokens).toBeLessThanOrEqual(kinds.get('history')!.existingTokens)
    expect(smallReport.selectedCount).toBeLessThanOrEqual(smallReport.candidateCount)
  })

  it('8K 窗口 + 超长角色卡：mandatory 不可行时显式标记，而不是静默丢协议', () => {
    const data = makeData({
      preset: makePreset({ maxContext: 8192, maxTokens: 1024 }),
      character: makeCharacter({ description: '一位来自未来的仿生人'.repeat(2000) }),
    })
    const report = buildContextMessagesFromData(data).contextShadow!
    const kinds = byKind(report)
    expect(report.degraded).toBe(false)
    expect(report.mandatoryOverBudget).toBe(true)
    expect(report.overBudget).toBe(true)
    // 协议与角色核心仍被"选择"（预算不可行交回上层降级，不在分配器里静默截断）
    expect(kinds.get('protocol')!.mandatoryCount).toBeGreaterThanOrEqual(4)
    expect(kinds.get('character')!.mandatoryCount).toBeGreaterThanOrEqual(1)
    expect(report.shadowTokens).toBeGreaterThan(report.budgetTokens)
  })
})

describe('W7 影子采集器：鲁棒性', () => {
  it('非法数值不抛出，collect 幂等，collect 后的 note 被忽略', () => {
    const collector = createContextShadowCollector({ model: 'gpt-4o-mini' })
    collector.note('history', 'h1', { tokens: Number.NaN })
    collector.note('protocol', 'p1', { text: '这一段必须保留', mandatory: true })
    const report = collector.collect({ budgetTokens: Number.NaN, reportedUsageTokens: Number.NaN })
    expect(report.degraded).toBe(false)
    expect(report.budgetTokens).toBe(0)
    expect(report.existingReportedTokens).toBeNull()
    expect(report.candidateCount).toBe(2)
    collector.note('history', 'ignored', { text: '不应被采集' })
    expect(collector.candidateCount()).toBe(2)
    expect(collector.collect()).toBe(report)
  })

  it('预算不可行时显式标记，不静默截断 mandatory', () => {
    const collector = createContextShadowCollector({ model: 'gpt-4o-mini' })
    collector.note('protocol', 'p1', { text: 'a'.repeat(400), mandatory: true })
    collector.note('history', 'h1', { text: 'b'.repeat(400) })
    const report = collector.collect({ budgetTokens: 10 })
    expect(report.mandatoryOverBudget).toBe(true)
    expect(report.overBudget).toBe(true)
    expect(report.shadowTokens).toBeGreaterThan(0)
  })

  it('未知分类与缺失 id 不抛出，摘要串仍可生成', () => {
    const collector = createContextShadowCollector({})
    collector.note('unknown' as never, '', { text: '内容不落报告' })
    const report = collector.collect({ budgetTokens: 100 })
    expect(report.degraded).toBe(false)
    expect(report.candidateCount).toBe(1)
    expect(formatContextShadowSummary(report)).not.toContain('内容不落报告')
  })
})
