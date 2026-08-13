/**
 * contextShared 共享工具单元测试（P-8）
 * cropHistory：token 预算裁剪 / 裁剪范围记录
 * applyDepthInserts：at_depth 深度注入（含 depth 0 = 末尾的 off-by-one 修复回归）
 */
import { describe, it, expect } from 'vitest'
import { cropHistory, applyDepthInserts, type DepthInsertItem } from '../contextShared'

function makeMsg(content: string, timestamp: number) {
  return { content, images: [] as string[], timestamp }
}

describe('cropHistory', () => {
  it('未超预算：全部保留，无裁剪信息', () => {
    const msgs = [makeMsg('短消息', 1000), makeMsg('另一条', 2000)]
    const r = cropHistory(msgs, 10, 10000, 'gpt-4o-mini')
    expect(r.recent).toHaveLength(2)
    expect(r.droppedTokens).toBe(0)
    expect(r.droppedEndIndex).toBe(-1)
    expect(r.droppedStartTs).toBe(0)
  })

  it('超预算：保留最新消息，记录裁剪范围', () => {
    const long = '字'.repeat(200) // ≈ 180 tokens
    const msgs = [
      makeMsg(long, 1000),
      makeMsg(long, 2000),
      makeMsg(long, 3000),
      makeMsg('最新的短消息', 4000),
    ]
    // 预算 100：仅最后一条短消息放得下（180 > 100）
    const r = cropHistory(msgs, 10, 100, 'gpt-4o-mini')
    expect(r.recent.map(m => m.content)).toEqual(['最新的短消息'])
    expect(r.droppedTokens).toBeGreaterThan(0)
    expect(r.droppedEndIndex).toBe(2)
    expect(r.droppedStartTs).toBe(1000)
    expect(r.droppedEndTs).toBe(3000)
  })

  it('预算耗尽时返回空历史（全部被裁）', () => {
    const long = '字'.repeat(200)
    const r = cropHistory([makeMsg(long, 1000)], 10, 50, 'gpt-4o-mini')
    expect(r.recent).toHaveLength(0)
    expect(r.droppedEndIndex).toBe(0)
  })

  it('图片按固定估算值计入裁剪', () => {
    const msgs = [
      makeMsg('带图片的消息', 1000),
      makeMsg('最新消息', 2000),
    ]
    msgs[0].images = ['data:image/png;base64,AAA']
    // 预算只够最后一条 + 少量：第一条图片消息（500 tokens 估算）应被裁
    const r = cropHistory(msgs, 0, 200, 'gpt-4o-mini')
    expect(r.recent.map(m => m.content)).toEqual(['最新消息'])
    expect(r.droppedEndIndex).toBe(0)
  })
})

describe('applyDepthInserts', () => {
  const history = ['m1', 'm2', 'm3']
  const item = (content: string, depth: number, order = 100): DepthInsertItem => ({ content, depth, order })

  it('depth 0 注入在对话末尾（最新消息之后）', () => {
    const r = applyDepthInserts(history, [item('末尾注入', 0)], (c) => `S:${c}`)
    expect(r).toEqual(['m1', 'm2', 'm3', 'S:末尾注入'])
  })

  it('depth 1 注入在倒数第二条消息之后', () => {
    const r = applyDepthInserts(history, [item('倒数第二后', 1)], (c) => `S:${c}`)
    expect(r).toEqual(['m1', 'm2', 'S:倒数第二后', 'm3'])
  })

  it('depth 超出历史长度时 clamp 到开头', () => {
    const r = applyDepthInserts(history, [item('超深注入', 99)], (c) => `S:${c}`)
    expect(r).toEqual(['S:超深注入', 'm1', 'm2', 'm3'])
  })

  it('同深度按 order 排序注入', () => {
    const r = applyDepthInserts(history, [item('后注入', 0, 200), item('先注入', 0, 100)], (c) => `S:${c}`)
    expect(r).toEqual(['m1', 'm2', 'm3', 'S:先注入', 'S:后注入'])
  })

  it('无插入项时返回原数组', () => {
    const r = applyDepthInserts(history, [], (c) => `S:${c}`)
    expect(r).toEqual(history)
  })
})
