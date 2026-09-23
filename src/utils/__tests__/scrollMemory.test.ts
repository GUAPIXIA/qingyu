import { beforeEach, describe, expect, it } from 'vitest'
import {
  SCROLL_MEMORY_MAX_ENTRIES,
  applyScrollRestore,
  chatScrollKey,
  clampScrollTop,
  clearScrollMemory,
  clearScrollMemoryCache,
  deleteScrollMemory,
  groupScrollKey,
  loadScrollMemory,
  saveScrollMemory,
  scrollMemoryStorageKey,
  type ScrollMetrics,
} from '../scrollMemory'

/** 伪造滚动容器度量（jsdom 无布局，无法测量真实滚动高度） */
function fakeScroller(metrics: { scrollTop?: number; scrollHeight: number; clientHeight: number }): ScrollMetrics {
  return {
    scrollTop: metrics.scrollTop ?? 0,
    scrollHeight: metrics.scrollHeight,
    clientHeight: metrics.clientHeight,
  }
}

describe('scrollMemory（UEX-P2-12：会话滚动位置记忆）', () => {
  beforeEach(() => {
    clearScrollMemory()
  })

  it('key 规则：单聊 scroll:{characterId}:{sessionId}，群聊 scroll:group:{groupId}:{sessionId}', () => {
    expect(chatScrollKey('char-1', 's1')).toBe('scroll:char-1:s1')
    expect(groupScrollKey('group-1', 's2')).toBe('scroll:group:group-1:s2')
  })

  it('记录后可恢复：同时保存顶位索引与 scrollTop', () => {
    saveScrollMemory(chatScrollKey('char-1', 's1'), { topIndex: 3, scrollTop: 640 })
    const entry = loadScrollMemory(chatScrollKey('char-1', 's1'))
    expect(entry).toMatchObject({ topIndex: 3, scrollTop: 640 })
    expect(typeof entry?.savedAt).toBe('number')
  })

  it('sessionStorage 兜底：内存 Map 清空（模拟刷新）后仍可恢复', () => {
    saveScrollMemory(chatScrollKey('char-1', 's1'), { topIndex: 2, scrollTop: 320 })
    clearScrollMemoryCache()
    expect(loadScrollMemory(chatScrollKey('char-1', 's1'))).toMatchObject({ topIndex: 2, scrollTop: 320 })
  })

  it('sessionStorage 数据损坏时返回 null（不抛异常）', () => {
    sessionStorage.setItem(scrollMemoryStorageKey(chatScrollKey('char-1', 'bad')), 'not-json{{')
    sessionStorage.setItem(scrollMemoryStorageKey(chatScrollKey('char-1', 'bad2')), '{"oops":true}')
    expect(loadScrollMemory(chatScrollKey('char-1', 'bad'))).toBeNull()
    expect(loadScrollMemory(chatScrollKey('char-1', 'bad2'))).toBeNull()
    expect(loadScrollMemory(chatScrollKey('char-1', 'none'))).toBeNull()
  })

  it('钳制：超出最大滚动高度取最大值，负值钳到 0', () => {
    expect(clampScrollTop(5000, 2400)).toBe(2400)
    expect(clampScrollTop(-10, 2400)).toBe(0)
    expect(clampScrollTop(420, 2400)).toBe(420)
  })

  it('恢复：超出当前最大滚动高度时钳制到合法值', () => {
    const el = fakeScroller({ scrollTop: 0, scrollHeight: 3000, clientHeight: 600 })
    expect(applyScrollRestore(el, { scrollTop: 5000 })).toBe(true)
    expect(el.scrollTop).toBe(2400)
  })

  it('恢复：位置合法时原样写回', () => {
    const el = fakeScroller({ scrollTop: 0, scrollHeight: 3000, clientHeight: 600 })
    expect(applyScrollRestore(el, { scrollTop: 420 })).toBe(true)
    expect(el.scrollTop).toBe(420)
  })

  it('不足一屏（不可滚动）不处理', () => {
    const el = fakeScroller({ scrollTop: 0, scrollHeight: 500, clientHeight: 500 })
    expect(applyScrollRestore(el, { scrollTop: 300 })).toBe(false)
    expect(el.scrollTop).toBe(0)
  })

  it('LRU 上限清理：超出 200 条时淘汰最旧条目（内存 + sessionStorage）', () => {
    for (let i = 0; i < SCROLL_MEMORY_MAX_ENTRIES; i++) {
      saveScrollMemory(chatScrollKey('char-1', `s${i}`), { topIndex: i, scrollTop: i })
    }
    saveScrollMemory(chatScrollKey('char-1', 's-new'), { topIndex: 1, scrollTop: 1 })
    // 最旧的 s0 被淘汰（内存与 sessionStorage 兜底同时清理）
    expect(loadScrollMemory(chatScrollKey('char-1', 's0'))).toBeNull()
    expect(sessionStorage.getItem(scrollMemoryStorageKey(chatScrollKey('char-1', 's0')))).toBeNull()
    expect(loadScrollMemory(chatScrollKey('char-1', 's-new'))).toMatchObject({ topIndex: 1, scrollTop: 1 })
  })

  it('LRU 按访问刷新位置：最近读过的条目不被淘汰', () => {
    for (let i = 0; i < SCROLL_MEMORY_MAX_ENTRIES; i++) {
      saveScrollMemory(chatScrollKey('char-1', `s${i}`), { topIndex: i, scrollTop: i })
    }
    // 读 s0 刷新其 LRU 位置 → 淘汰对象变为 s1
    expect(loadScrollMemory(chatScrollKey('char-1', 's0'))).not.toBeNull()
    saveScrollMemory(chatScrollKey('char-1', 's-new'), { topIndex: 9, scrollTop: 9 })
    expect(loadScrollMemory(chatScrollKey('char-1', 's0'))).not.toBeNull()
    expect(loadScrollMemory(chatScrollKey('char-1', 's1'))).toBeNull()
  })

  it('deleteScrollMemory / clearScrollMemory 清除记忆（含 sessionStorage）', () => {
    saveScrollMemory(chatScrollKey('char-1', 's1'), { topIndex: 1, scrollTop: 100 })
    saveScrollMemory(groupScrollKey('group-1', 's2'), { topIndex: 2, scrollTop: 200 })
    deleteScrollMemory(chatScrollKey('char-1', 's1'))
    expect(loadScrollMemory(chatScrollKey('char-1', 's1'))).toBeNull()
    expect(sessionStorage.getItem(scrollMemoryStorageKey(chatScrollKey('char-1', 's1')))).toBeNull()
    expect(loadScrollMemory(groupScrollKey('group-1', 's2'))).not.toBeNull()
    clearScrollMemory()
    expect(loadScrollMemory(groupScrollKey('group-1', 's2'))).toBeNull()
    expect(sessionStorage.getItem(scrollMemoryStorageKey(groupScrollKey('group-1', 's2')))).toBeNull()
  })
})
