/**
 * 阶段六：长记忆回归基线 20 条（固定断言，不依赖网络）
 * 类别：人物关系×5 / 时地物×5 / 新事件覆盖×3 / 编辑清理×3 / 超长×4
 */
import { describe, it, expect } from 'vitest'
import { buildMemorySummaryWindow } from '../../utils/memoryWindow'
import { applyFactProposals, fitLayeredMemoryBudget, memoryFactToText, parseMemoryResult } from '../../utils/memory'
import type { MemoryFact } from '../../../shared/types'

function mockEstimate(text: string): number {
  const cjk = (text.match(/[\u4e00-\u9fff]/g) ?? []).length
  return Math.ceil(cjk * 0.9 + (text.length - cjk) * 0.3)
}

function msg(id: string, content: string) {
  return { id, content, role: 'user' as const }
}

describe('memoryRegression baseline 20', () => {
  // ===== 人物关系×5 =====
  it('R01: 关系递进 set 覆盖旧值并归档', () => {
    const cur: MemoryFact = {
      id: 'f1', subject: '林夏', predicate: '与用户的关系', value: '朋友',
      status: 'active', importance: 3, confidence: 0.8, scope: 'session', sourceMessageIds: ['m1'], updatedAt: 1,
    }
    const r = applyFactProposals([cur], [], [{ subject: '林夏', predicate: '与用户的关系', value: '恋人', changeType: 'set', scope: 'session', importance: 5 }], 'm2', 100)
    expect(r.facts[0].value).toBe('恋人')
    expect(r.history[0].status).toBe('superseded')
  })

  it('R02: 同名角色 scope 隔离', () => {
    const a: MemoryFact = { id: 'a', subject: '小明', predicate: '身份', value: '学生', status: 'active', importance: 3, confidence: 0.9, scope: 'session-A', sourceMessageIds: [], updatedAt: 1 }
    const r = applyFactProposals([a], [], [{ subject: '小明', predicate: '身份', value: '老师', changeType: 'set', scope: 'session-B' }], 'm2', 100)
    expect(r.facts).toHaveLength(2)
    expect(r.facts.some(f => f.scope === 'session-A' && f.value === '学生')).toBe(true)
    expect(r.facts.some(f => f.scope === 'session-B' && f.value === '老师')).toBe(true)
  })

  it('R03: clear 使 fact inactive', () => {
    const cur: MemoryFact = { id: 'f', subject: '林夏', predicate: '持有物品', value: '钥匙', status: 'active', importance: 3, confidence: 0.8, sourceMessageIds: [], updatedAt: 1 }
    const r = applyFactProposals([cur], [], [{ subject: '林夏', predicate: '持有物品', value: '钥匙', changeType: 'clear' }], 'm2', 100)
    expect(r.facts).toHaveLength(0)
    expect(r.history[0].status).toBe('inactive')
  })

  it('R04: entityId 区分同名不同角色卡', () => {
    const cur: MemoryFact = { id: 'e1', subject: '艾琳', predicate: '职业', value: '法师', status: 'active', importance: 4, confidence: 0.9, entityId: 'char-1', sourceMessageIds: [], updatedAt: 1 }
    const r = applyFactProposals([cur], [], [{ subject: '艾琳', predicate: '职业', value: '战士', changeType: 'set', entityId: 'char-2' }], 'm2', 100)
    expect(r.facts).toHaveLength(2)
  })

  it('R05: 多提案并发不丢历史', () => {
    const r = applyFactProposals([], [], [
      { subject: 'A', predicate: '所在地', value: '镇', changeType: 'set' },
      { subject: 'B', predicate: '任务', value: '寻宝', changeType: 'set' },
    ], 'm1', 100)
    expect(r.facts).toHaveLength(2)
    expect(r.history).toHaveLength(0)
  })

  // ===== 时地物×5 =====
  it('R06: 地点变更 set 覆盖', () => {
    const cur: MemoryFact = { id: 'loc', subject: '队伍', predicate: '所在地', value: '旅店', status: 'active', importance: 3, confidence: 0.8, sourceMessageIds: [], updatedAt: 1 }
    const r = applyFactProposals([cur], [], [{ subject: '队伍', predicate: '所在地', value: '旧矿坑', changeType: 'set' }], 'm2', 100)
    expect(r.facts[0].value).toBe('旧矿坑')
  })

  it('R07: 时间推进作为事实更新', () => {
    const cur: MemoryFact = { id: 't', subject: '当前', predicate: '时间', value: '夜晚', status: 'active', importance: 2, confidence: 0.8, sourceMessageIds: [], updatedAt: 1 }
    const r = applyFactProposals([cur], [], [{ subject: '当前', predicate: '时间', value: '清晨', changeType: 'set' }], 'm', 2)
    expect(r.facts[0].value).toBe('清晨')
  })

  it('R08: 物品归属转移记录来源', () => {
    const r = applyFactProposals([], [], [{ subject: '艾琳', predicate: '持有物品', value: '地图', changeType: 'set' }], 'msg-123', 100)
    expect(r.facts[0].sourceMessageIds).toEqual(['msg-123'])
    expect(memoryFactToText(r.facts[0])).toBe('艾琳的持有物品：地图')
  })

  it('R09: 任务状态更新保留重要性', () => {
    const cur: MemoryFact = { id: 'q', subject: '主线', predicate: '目标', value: '找钥匙', status: 'active', importance: 5, confidence: 0.9, sourceMessageIds: [], updatedAt: 1 }
    const r = applyFactProposals([cur], [], [{ subject: '主线', predicate: '目标', value: '开宝箱', changeType: 'set', importance: 5 }], 'm', 10)
    expect(r.facts[0].importance).toBe(5)
  })

  it('R10: 分层预算 currentState 优先于 timeline', () => {
    const fitted = fitLayeredMemoryBudget('当前在矿坑', '很长的时间线'.repeat(20), ['事实A'], 100, mockEstimate)
    expect(fitted.currentState).toContain('矿坑')
    expect(fitted.facts).toEqual(['事实A'])
  })

  // ===== 新事件覆盖×3 =====
  it('R11: 新时间线覆盖但事实保留', () => {
    const parsed = parseMemoryResult('【当前状态】在矿坑\n【时间线】新事件：找到宝藏\n【事实提案】\n```json\n[]\n```')
    expect(parsed.currentState).toContain('矿坑')
    expect(parsed.summary).toContain('宝藏')
    expect(parsed.factProposals).toEqual([])
  })

  it('R12: 同键覆盖触发 superseded 归档', () => {
    const cur: MemoryFact = { id: 'k', subject: '林夏', predicate: '状态', value: '受伤', status: 'active', importance: 3, confidence: 0.8, sourceMessageIds: [], updatedAt: 1 }
    const r = applyFactProposals([cur], [], [{ subject: '林夏', predicate: '状态', value: '痊愈', changeType: 'set' }], 'm', 100)
    expect(r.history[0].value).toBe('受伤')
    expect(r.facts[0].value).toBe('痊愈')
  })

  it('R13: 高重要性变更保留旧来源', () => {
    const cur: MemoryFact = { id: 'imp', subject: '钥匙', predicate: '归属', value: '艾琳', status: 'active', importance: 5, confidence: 0.95, sourceMessageIds: ['m1'], updatedAt: 1 }
    const r = applyFactProposals([cur], [], [{ subject: '钥匙', predicate: '归属', value: '用户', changeType: 'set', importance: 5 }], 'm2', 100)
    expect(r.history[0].sourceMessageIds).toContain('m1')
  })

  // ===== 编辑清理×3 =====
  it('R14: 游标后消息被编辑时 pending 包含全部未总结', () => {
    const msgs = [msg('m1', 'a'), msg('m2', 'b'), msg('m3', 'c')]
    const w = buildMemorySummaryWindow(msgs, null, m => m.content, mockEstimate, { tokenBudget: 1000 })
    expect(w.pending).toHaveLength(3)
    expect(w.selected.length).toBeGreaterThan(0)
  })

  it('R15: parseMemoryResult 解析 clear 提案', () => {
    const parsed = parseMemoryResult('【事实提案】\n```json\n[{"subject":"A","predicate":"持有","value":"剑","changeType":"clear"}]\n```')
    expect(parsed.factProposals?.[0].changeType).toBe('clear')
    const r = applyFactProposals([{ id: 'x', subject: 'A', predicate: '持有', value: '剑', status: 'active', importance: 3, confidence: 0.8, sourceMessageIds: [], updatedAt: 1 }], [], parsed.factProposals!, 'm', 10)
    expect(r.facts).toHaveLength(0)
  })

  it('R16: 解析失败时不抛错且 factProposals 为 null', () => {
    const parsed = parseMemoryResult('【事实提案】\n不是 JSON')
    expect(parsed.factProposals).toBeNull()
    expect(parsed.facts).toEqual([])
  })

  // ===== 超长×4 =====
  it('R17: 超长首条 pending 必保留即使超预算', () => {
    const long = '甲'.repeat(500)
    const msgs = [msg('m1', long), msg('m2', '短')]
    const w = buildMemorySummaryWindow(msgs, null, m => m.content, mockEstimate, { tokenBudget: 10 })
    expect(w.selected[0].id).toBe('m1')
    expect(w.processedThroughMessageId).toBe('m1')
  })

  it('R18: overlap 不超过 25% 预算', () => {
    const msgs = [msg('m1', '甲'.repeat(100)), msg('m2', '乙'.repeat(100)), msg('m3', '丙'.repeat(10))]
    const w = buildMemorySummaryWindow(msgs, 'm2', m => m.content, mockEstimate, { tokenBudget: 100, overlapCount: 2 })
    const overlapTokens = w.overlap.reduce((s, m) => s + mockEstimate(m.content), 0)
    expect(overlapTokens).toBeLessThanOrEqual(25)
  })

  it('R19: fitLayered 无 currentState 时预算回流给 timeline', () => {
    const r = fitLayeredMemoryBudget('', '甲'.repeat(80), [], 100, mockEstimate)
    expect(r.currentState).toBe('')
    expect(r.timeline.length).toBeGreaterThan(0)
  })

  it('R20: 未选中 pending 不推进游标', () => {
    const msgs = [msg('m1', '短'), msg('m2', '甲'.repeat(200)), msg('m3', '乙'.repeat(200))]
    const w = buildMemorySummaryWindow(msgs, null, m => m.content, mockEstimate, { tokenBudget: 50 })
    // 首条外后续超限 break，processedThrough 仅到 selected 末尾
    expect(w.selected.at(-1)?.id).toBe(w.processedThroughMessageId)
    expect(w.pending.length).toBeGreaterThan(w.selected.length)
  })
})
