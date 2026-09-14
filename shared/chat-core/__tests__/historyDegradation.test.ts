/**
 * W9（主计划 §7.11 第 4–5 条）：历史分级降级与输入审计接线测试。
 *
 * 覆盖：摘要优先替代旧原文、未覆盖才 drop-raw、与 cropHistory 口径对齐、
 * 估算审计视图无正文、超限只报告一次重分配额度。
 */
import { describe, expect, it } from 'vitest'
import {
  auditMessagesAsSerializedInput,
  buildSerializedInputViewFromMessages,
  formatHistoryDegradationSummary,
  planHistoryDegradation,
} from '../historyDegradation'
import { TOKEN_BUDGET_SAFETY } from '../chatConstants'
import { MAX_INPUT_REALLOCATIONS } from '../inputAudit'
import type { ContextMessage } from '../chatTypes'

function msg(id: string, content: string, timestamp: number, role: 'user' | 'assistant' = 'user') {
  return { id, role, content, timestamp }
}

describe('W9 历史分级降级', () => {
  const messages = [
    msg('m1', '很早以前的一段很长的对话内容需要被裁剪掉'.repeat(6), 1000),
    msg('m2', '中间的一段对话也会被裁掉'.repeat(6), 2000, 'assistant'),
    msg('m3', '最近保留的一条消息', 3000),
  ]

  it('无摘要时：被裁剪范围直接 drop-raw', () => {
    const plan = planHistoryDegradation({
      messages,
      usedTokens: 0,
      budgetTokens: 20,
      model: 'gpt-4o-mini',
      compressedSummary: null,
      compressedRange: null,
    })
    expect(plan.degraded).toBe(false)
    expect(plan.candidate.summaryReplacedCount).toBe(0)
    expect(plan.candidate.droppedRawCount).toBeGreaterThan(0)
    expect(plan.items.some((item) => item.action === 'drop-raw')).toBe(true)
    expect(plan.items.some((item) => item.action === 'keep-raw')).toBe(true)
  })

  it('摘要覆盖被裁剪时间范围时：先用摘要替代，不 drop 原文', () => {
    const plan = planHistoryDegradation({
      messages,
      usedTokens: 0,
      budgetTokens: 20,
      model: 'gpt-4o-mini',
      compressedSummary: '早期对话摘要：两人进入废土城市。',
      compressedRange: { startTs: 0, endTs: 2500 },
    })
    expect(plan.candidate.droppedRawCount).toBe(0)
    expect(plan.candidate.summaryReplacedCount).toBeGreaterThan(0)
    expect(plan.candidate.summaryTokens).toBeGreaterThan(0)
    expect(plan.items.some((item) => item.action === 'replace-with-summary' && item.coveredBySummary)).toBe(true)
    expect(plan.items.some((item) => item.action === 'drop-raw')).toBe(false)
  })

  it('摘要未覆盖时间范围时：仍 drop-raw，不误用摘要', () => {
    const plan = planHistoryDegradation({
      messages,
      usedTokens: 0,
      budgetTokens: 20,
      model: 'gpt-4o-mini',
      compressedSummary: '只覆盖了更早的一段',
      compressedRange: { startTs: 0, endTs: 500 },
    })
    expect(plan.candidate.summaryReplacedCount).toBe(0)
    expect(plan.candidate.droppedRawCount).toBeGreaterThan(0)
  })

  it('复用调用方 crop 结果时与重算一致（口径对齐）', () => {
    const common = {
      messages,
      usedTokens: 0,
      budgetTokens: 80,
      model: 'gpt-4o-mini',
      compressedSummary: '摘要覆盖 m1-m2',
      compressedRange: { startTs: 1000, endTs: 2000 },
    }
    const plan = planHistoryDegradation(common)
    expect(plan.existing.keptCount + plan.existing.droppedCount).toBe(messages.length)
    expect(plan.deltaTokens).toBe(0)
  })

  it('预算足够时全部 keep-raw，无摘要替代', () => {
    const plan = planHistoryDegradation({
      messages,
      usedTokens: 0,
      budgetTokens: 100000,
      model: 'gpt-4o-mini',
      compressedSummary: '摘要',
      compressedRange: { startTs: 0, endTs: 99999 },
    })
    expect(plan.candidate.keptRawCount).toBe(3)
    expect(plan.candidate.summaryReplacedCount).toBe(0)
    expect(plan.items.every((item) => item.action === 'keep-raw')).toBe(true)
  })

  it('日志串不含消息正文', () => {
    const plan = planHistoryDegradation({
      messages: [msg('m1', '机密历史正文标记', 1000)],
      usedTokens: 0,
      budgetTokens: 1,
      model: 'gpt-4o-mini',
      compressedSummary: null,
      compressedRange: null,
    })
    const summary = formatHistoryDegradationSummary(plan)
    expect(summary).toContain('mode=history-degradation')
    expect(summary).not.toContain('机密历史正文标记')
  })
})

describe('W9 序列化后输入审计接线', () => {
  const messages: ContextMessage[] = [
    { role: 'system', content: '系统提示一段较长的内容用于估算 token 数量' },
    { role: 'user', content: '用户消息' },
    { role: 'assistant', content: '助手回复' },
  ]

  it('从 messages 构建估算视图：serialized=false，精度 estimated', () => {
    const view = buildSerializedInputViewFromMessages(messages, {
      provider: 'openai',
      model: 'gpt-4o-mini',
    })
    expect(view.serialized).toBe(false)
    expect(view.parts).toHaveLength(3)
    expect(view.parts.every((part) => part.confidence === 'estimated')).toBe(true)
    expect(view.parts.every((part) => part.tokens > 0)).toBe(true)
    // 视图不含正文字段
    expect(JSON.stringify(view)).not.toContain('系统提示')
  })

  it('审计合计 = 输入 + 输出预留 + 协议余量；超限只报告一次重分配额度', () => {
    const audit = auditMessagesAsSerializedInput(messages, {
      provider: 'openai',
      model: 'gpt-4o-mini',
      reservedOutputTokens: 1024,
      contextLimit: 2048,
    })
    expect(audit.remainingReallocations).toBe(MAX_INPUT_REALLOCATIONS)
    expect(audit.accountingConfidence).toBe('estimated')
    expect(audit.serializedViewMissing).toBe(true)
    expect(audit.totalTokens).toBe(
      audit.inputTokens + audit.reservedOutputTokens + audit.protocolSafetyTokens,
    )
    expect(audit.protocolSafetyTokens).toBe(Math.ceil(2048 * (1 - TOKEN_BUDGET_SAFETY)))
  })

  it('窗口过小则 overBudget=true，但仍返回完整审计（不裁剪）', () => {
    const audit = auditMessagesAsSerializedInput(messages, {
      provider: 'openai',
      model: 'gpt-4o-mini',
      reservedOutputTokens: 512,
      contextLimit: 64,
    })
    expect(audit.overBudget).toBe(true)
    expect(audit.byRole.length).toBeGreaterThan(0)
  })
})
