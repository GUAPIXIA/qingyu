import { describe, it, expect } from 'vitest'
import { getEffectiveQuickReplies, findQuickReplyByHotkey, createQuickReply } from '../quickReply'
import type { QuickReply, QuickReplyStore } from '../../../shared/types'

function makeQr(overrides: Partial<QuickReply> = {}): QuickReply {
  return {
    id: Math.random().toString(36).slice(2, 10),
    label: '测试',
    content: '你好',
    action: 'text',
    sendWithAI: true,
    order: 0,
    enabled: true,
    ...overrides,
  }
}

describe('getEffectiveQuickReplies', () => {
  it('合并全局 + 角色专属并按 order 排序', () => {
    const store: QuickReplyStore = {
      global: [makeQr({ id: 'g1', order: 2 }), makeQr({ id: 'g2', order: 1 })],
      byCharacter: { c1: [makeQr({ id: 'c1-1', order: 0 })] },
    }
    const result = getEffectiveQuickReplies(store, 'c1')
    expect(result.map((q) => q.id)).toEqual(['c1-1', 'g2', 'g1'])
  })

  it('未传入角色时仅返回全局', () => {
    const store: QuickReplyStore = {
      global: [makeQr({ id: 'g1' })],
      byCharacter: { c1: [makeQr({ id: 'c1-1' })] },
    }
    expect(getEffectiveQuickReplies(store, null).map((q) => q.id)).toEqual(['g1'])
    expect(getEffectiveQuickReplies(store, undefined).map((q) => q.id)).toEqual(['g1'])
  })

  it('过滤禁用项', () => {
    const store: QuickReplyStore = {
      global: [makeQr({ id: 'on', enabled: true }), makeQr({ id: 'off', enabled: false })],
      byCharacter: {},
    }
    expect(getEffectiveQuickReplies(store, 'c1').map((q) => q.id)).toEqual(['on'])
  })

  it('空 store 返回空数组', () => {
    expect(getEffectiveQuickReplies({ global: [], byCharacter: {} }, 'c1')).toEqual([])
  })
})

describe('findQuickReplyByHotkey', () => {
  it('按快捷键查找', () => {
    const replies = [makeQr({ id: 'a', hotkey: 1 }), makeQr({ id: 'b', hotkey: 3 })]
    expect(findQuickReplyByHotkey(replies, 3)?.id).toBe('b')
    expect(findQuickReplyByHotkey(replies, 2)).toBeUndefined()
  })

  it('无快捷键项不匹配', () => {
    expect(findQuickReplyByHotkey([makeQr({ id: 'a' })], 1)).toBeUndefined()
  })
})

describe('createQuickReply', () => {
  it('创建默认快捷回复', () => {
    const qr = createQuickReply()
    expect(qr.id).toBeTruthy()
    expect(qr.action).toBe('text')
    expect(qr.sendWithAI).toBe(true)
    expect(qr.enabled).toBe(true)
  })

  it('合并部分字段', () => {
    const qr = createQuickReply({ label: '早安', action: 'command', command: '/help', hotkey: 2 })
    expect(qr.label).toBe('早安')
    expect(qr.action).toBe('command')
    expect(qr.command).toBe('/help')
    expect(qr.hotkey).toBe(2)
  })
})
