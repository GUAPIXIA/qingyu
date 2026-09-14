/**
 * W9（主计划 §7.11）：世界书/历史/审计影子端到端测试。
 *
 * 关键断言：
 * - 开启/关闭影子得到完全相同的 messages 与 maxTokens（生产注入不变）；
 * - 世界书影子使用逐条评分（always→mandatory），报告不含正文；
 * - 历史降级与输入审计随 BuildResult 返回且不参与注入决策；
 * - 同一输入重复构建结果稳定。
 */
import { describe, expect, it } from 'vitest'
import { buildContextMessagesFromData } from '../contextBuilder'
import type { Lorebook } from '../../../shared/types'
import {
  CONTENT_MARKERS,
  makeCharacter,
  makeChat,
  makeData,
  makeLorebook,
  makeMessage,
  makePreset,
  makeSettings,
} from './contextBuildFixtures'

/** 含 always 条目的世界书 fixture（验证 §7.11 第 2 条 always→mandatory 影子） */
function makeWorldbookWithAlways(id: string, name: string): Lorebook {
  return {
    ...makeLorebook(id, name),
    entries: [
      {
        id: `${id}-always`,
        keywords: [],
        content: `${name}常驻设定正文标记`,
        position: 'before_char',
        order: 0,
        probability: 100,
        enabled: true,
        priority: 'always',
      },
      {
        id: `${id}-cond`,
        keywords: ['废土', 'wasteland'],
        content: `${name}条件设定内容`,
        position: 'before_char',
        order: 1,
        probability: 100,
        enabled: true,
        priority: 'conditional',
      },
      {
        id: `${id}-depth`,
        keywords: ['关键事件'],
        content: `${name}的 at_depth 注入内容`,
        position: 'at_depth',
        depth: 1,
        order: 2,
        probability: 100,
        enabled: true,
      },
    ],
  }
}

describe('W9 影子：不改变生产注入', () => {
  it('开启/关闭影子得到完全一致的 messages / maxTokens / 用量', () => {
    const data = makeData()
    const withShadow = buildContextMessagesFromData(data)
    const withoutShadow = buildContextMessagesFromData(data, { shadow: 'off' })
    expect(withShadow.messages).toEqual(withoutShadow.messages)
    expect(withShadow.requestMaxTokens).toBe(withoutShadow.requestMaxTokens)
    expect(withShadow.lastContextUsage).toEqual(withoutShadow.lastContextUsage)
    expect(withShadow.worldbookShadow).toBeDefined()
    expect(withoutShadow.worldbookShadow).toBeUndefined()
    expect(withoutShadow.historyDegradation).toBeUndefined()
    expect(withoutShadow.inputAudit).toBeUndefined()
  })

  it('构建过程不修改输入数据快照', () => {
    const data = makeData({
      lorebooks: [makeWorldbookWithAlways('lb-a', '废土世界观')],
      chat: makeChat({ activeLorebookIds: ['lb-a'] }),
    })
    const snapshot = JSON.stringify(data)
    buildContextMessagesFromData(data)
    expect(JSON.stringify(data)).toBe(snapshot)
  })

  it('同一份数据重复构建，W9 报告稳定', () => {
    const data = makeData({
      lorebooks: [makeWorldbookWithAlways('lb-a', '废土世界观')],
      chat: makeChat({ activeLorebookIds: ['lb-a'] }),
    })
    const first = buildContextMessagesFromData(data)
    const second = buildContextMessagesFromData(data)
    expect(second.worldbookShadow).toEqual(first.worldbookShadow)
    expect(second.historyDegradation).toEqual(first.historyDegradation)
    expect(second.inputAudit).toEqual(first.inputAudit)
  })
})

describe('W9 世界书影子：逐条评分与 always', () => {
  const data = makeData({
    lorebooks: [makeWorldbookWithAlways('lb-a', '废土世界观')],
    chat: makeChat({ activeLorebookIds: ['lb-a'] }),
  })
  const built = buildContextMessagesFromData(data)
  const report = built.worldbookShadow!

  it('世界书影子存在且未降级', () => {
    expect(report).toBeDefined()
    expect(report.mode).toBe('worldbook-shadow')
    expect(report.degraded).toBe(false)
    expect(report.legacyCapTokens).toBeGreaterThan(0)
  })

  it('always 条目进入 mandatory 候选（至少 1 条）', () => {
    expect(report.candidate.alwaysMandatoryCount).toBeGreaterThanOrEqual(1)
    // 预算可行时 always 应全部入选
    expect(report.candidate.mandatoryOverBudget).toBe(false)
    expect(report.candidate.alwaysSelectedCount).toBe(report.candidate.alwaysMandatoryCount)
  })

  it('既有注入仍含 always 正文（生产路径未改）', () => {
    const systemText = built.messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n')
    expect(systemText).toContain('废土世界观常驻设定正文标记')
  })

  it('报告与日志不含世界书正文', () => {
    const serialized = JSON.stringify(report)
    expect(serialized).not.toContain('废土世界观常驻设定正文标记')
    expect(serialized).not.toContain(CONTENT_MARKERS[0] ?? 'never')
    // 允许包含 key id
    expect(JSON.stringify({ keys: true })).not.toContain('正文')
  })
})

describe('W9 历史降级与输入审计', () => {
  it('短会话：历史全保留，无摘要替代；输入审计为估算口径', () => {
    const built = buildContextMessagesFromData(makeData())
    const history = built.historyDegradation!
    expect(history.degraded).toBe(false)
    expect(history.candidate.keptRawCount).toBe(3)
    expect(history.candidate.summaryReplacedCount).toBe(0)
    expect(history.candidate.droppedRawCount).toBe(0)

    const audit = built.inputAudit!
    expect(audit.accountingConfidence).toBe('estimated')
    expect(audit.serializedViewMissing).toBe(true)
    expect(audit.remainingReallocations).toBe(1)
    expect(audit.inputTokens).toBeGreaterThan(0)
  })

  it('小窗口触发裁剪：无摘要时 drop-raw，messages 仍按既有 crop 输出', () => {
    const data = makeData({
      preset: makePreset({ maxContext: 2048, maxTokens: 256 }),
      settings: { settings: makeSettings(), profile: null },
      chat: makeChat({
        messages: [
          makeMessage({ id: 'm1', role: 'user', content: '很久以前发生了很多事情。'.repeat(60), timestamp: 1000 }),
          makeMessage({ id: 'm2', role: 'assistant', content: '是的，我们继续走。'.repeat(50), timestamp: 2000 }),
          makeMessage({ id: 'm3', role: 'user', content: '现在这一条应该保留。', timestamp: 3000 }),
        ],
      }),
    })
    const withShadow = buildContextMessagesFromData(data)
    const withoutShadow = buildContextMessagesFromData(data, { shadow: 'off' })
    expect(withShadow.messages).toEqual(withoutShadow.messages)
    const history = withShadow.historyDegradation!
    expect(history.degraded).toBe(false)
    expect(history.existing.droppedCount + history.existing.keptCount).toBe(3)
    // 有裁剪时应有 drop 或 summary 之一
    expect(
      history.candidate.droppedRawCount + history.candidate.summaryReplacedCount,
    ).toBeGreaterThan(0)
  })

  it('带压缩摘要且覆盖裁剪范围：影子侧 replace-with-summary', () => {
    const data = makeData({
      preset: makePreset({ maxContext: 2048, maxTokens: 256 }),
      settings: { settings: makeSettings(), profile: null },
      chat: makeChat({
        messages: [
          makeMessage({ id: 'm1', role: 'user', content: '很久以前发生了很多事情。'.repeat(60), timestamp: 1000 }),
          makeMessage({ id: 'm2', role: 'assistant', content: '是的，我们继续走。'.repeat(50), timestamp: 2000 }),
          makeMessage({ id: 'm3', role: 'user', content: '现在这一条应该保留。', timestamp: 3000 }),
        ],
        sessions: [
          {
            id: 's1',
            characterId: 'char-01',
            title: '废土之旅',
            createdAt: 0,
            updatedAt: 4000,
            memoryEnabled: false,
            memoryMode: 'auto',
            autoMemoryInterval: 10,
            memory: '',
            memoryUpdatedAt: 3500,
            compressedSummary: '早期摘要：两人进入废土城市并躲避沙尘暴。',
            compressedRange: { startTs: 0, endTs: 2500 },
            messageCount: 3,
            lastMessage: '现在这一条应该保留。',
          },
        ],
      }),
    })
    const built = buildContextMessagesFromData(data)
    const history = built.historyDegradation!
    expect(history.existing.droppedCount).toBeGreaterThan(0)
    expect(history.candidate.summaryReplacedCount).toBeGreaterThan(0)
    expect(history.candidate.droppedRawCount).toBe(0)
    // 生产路径：有裁剪且覆盖时仍注入摘要（既有行为）
    const allText = built.messages.map((m) => m.content).join('\n')
    expect(allText).toContain('早期摘要')
  })
})
