// UEX-P2-12：会话滚动位置记忆——从会话切走再回来，消息列表恢复到原滚动位置
// 记录：滚动事件同步写入（条目极小，等价 rAF 节流的简化版；天然覆盖「离开会话/切走/卸载」，无卸载时序竞态）
// 恢复：回到该会话且消息加载完成后，Virtuoso initialTopMostItemIndex 顶位粗定位 +
//       scrollerRef 读写 scrollTop 像素细校正（超出最大滚动高度钳制到合法值；不足一屏不处理）
// 存储：内存 Map（LRU 上限 200 条，防膨胀）+ sessionStorage 兜底（刷新后仍可恢复）
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

/** UEX-P2-12：单条滚动记忆（像素 scrollTop 与顶位索引并存，互为兜底） */
export interface ScrollMemoryEntry {
  /** 顶部消息索引（Virtuoso 可见窗口起点） */
  topIndex: number
  /** 滚动容器像素 scrollTop */
  scrollTop: number
  /** 记录时间（调试/排查用） */
  savedAt: number
}

/** UEX-P2-12：滚动容器度量（HTMLElement 结构上满足；单测可传纯对象） */
export interface ScrollMetrics {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

/** UEX-P2-12：内存 Map 条目上限（LRU 淘汰最旧条目，防膨胀） */
export const SCROLL_MEMORY_MAX_ENTRIES = 200

/** UEX-P2-12：sessionStorage 兜底的命名空间（避免与其他项冲突） */
const STORAGE_PREFIX = 'qingyu:'

/** UEX-P2-12：内存缓存（Map 迭代序 = LRU 序：尾部最新，头部最旧） */
const memoryCache = new Map<string, ScrollMemoryEntry>()

/** UEX-P2-12：单聊记忆 key：scroll:{characterId}:{sessionId} */
export function chatScrollKey(characterId: string, sessionId: string): string {
  return `scroll:${characterId}:${sessionId}`
}

/** UEX-P2-12：群聊记忆 key：scroll:group:{groupId}:{sessionId} */
export function groupScrollKey(groupId: string, sessionId: string): string {
  return `scroll:group:${groupId}:${sessionId}`
}

/** UEX-P2-12：sessionStorage 兜底 key */
export function scrollMemoryStorageKey(key: string): string {
  return `${STORAGE_PREFIX}${key}`
}

function readStorage(key: string): ScrollMemoryEntry | null {
  try {
    const raw = sessionStorage.getItem(scrollMemoryStorageKey(key))
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<ScrollMemoryEntry>
    if (typeof parsed?.topIndex !== 'number' || typeof parsed?.scrollTop !== 'number') return null
    return { topIndex: parsed.topIndex, scrollTop: parsed.scrollTop, savedAt: parsed.savedAt ?? 0 }
  } catch {
    // 损坏/非法 JSON：当作无记忆
    return null
  }
}

function writeStorage(key: string, entry: ScrollMemoryEntry): void {
  try {
    sessionStorage.setItem(scrollMemoryStorageKey(key), JSON.stringify(entry))
  } catch {
    // 配额/隐私模式写入失败：内存 Map 仍可用，忽略
  }
}

function removeStorage(key: string): void {
  try {
    sessionStorage.removeItem(scrollMemoryStorageKey(key))
  } catch {
    // ignore
  }
}

/** UEX-P2-12：入队/刷新 LRU 位置后按上限淘汰最旧条目（内存 + sessionStorage 同步清理） */
function touchAndEvict(key: string, entry: ScrollMemoryEntry): void {
  memoryCache.delete(key)
  memoryCache.set(key, entry)
  while (memoryCache.size > SCROLL_MEMORY_MAX_ENTRIES) {
    const oldest = memoryCache.keys().next().value
    if (oldest === undefined) break
    memoryCache.delete(oldest)
    removeStorage(oldest)
  }
}

/** UEX-P2-12：记录滚动位置（内存 Map + sessionStorage 双写，LRU 上限清理） */
export function saveScrollMemory(
  key: string,
  entry: { topIndex: number; scrollTop: number },
): ScrollMemoryEntry {
  const record: ScrollMemoryEntry = {
    topIndex: Math.max(0, Math.round(entry.topIndex)),
    scrollTop: Math.max(0, entry.scrollTop),
    savedAt: Date.now(),
  }
  touchAndEvict(key, record)
  writeStorage(key, record)
  return record
}

/** UEX-P2-12：读取滚动位置（内存 Map 优先，sessionStorage 兜底——刷新后仍可恢复） */
export function loadScrollMemory(key: string): ScrollMemoryEntry | null {
  const cached = memoryCache.get(key)
  if (cached) {
    touchAndEvict(key, cached) // 刷新 LRU 位置
    return cached
  }
  const stored = readStorage(key)
  if (stored) {
    touchAndEvict(key, stored) // 回填内存缓存并刷新 LRU 位置
  }
  return stored
}

/** UEX-P2-12：删除单条记忆（内存 + sessionStorage） */
export function deleteScrollMemory(key: string): void {
  memoryCache.delete(key)
  removeStorage(key)
}

/** UEX-P2-12：清空全部记忆（内存 + sessionStorage；测试/清理用） */
export function clearScrollMemory(): void {
  memoryCache.clear()
  try {
    const keys: string[] = []
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i)
      if (k && k.startsWith(`${STORAGE_PREFIX}scroll:`)) keys.push(k)
    }
    for (const k of keys) sessionStorage.removeItem(k)
  } catch {
    // ignore
  }
}

/** UEX-P2-12：只清内存 Map（保留 sessionStorage）——模拟刷新后从兜底恢复的场景 */
export function clearScrollMemoryCache(): void {
  memoryCache.clear()
}

/** UEX-P2-12：把 scrollTop 钳制到 [0, maxScrollTop]（恢复位置超出当前最大滚动高度时取合法值） */
export function clampScrollTop(scrollTop: number, maxScrollTop: number): number {
  return Math.max(0, Math.min(scrollTop, Math.max(0, maxScrollTop)))
}

/**
 * UEX-P2-12：恢复像素滚动位置。
 * 返回 false 表示未处理（不足一屏/不可滚动，无需恢复）；超出最大滚动高度时钳制到合法值。
 */
export function applyScrollRestore(el: ScrollMetrics, entry: { scrollTop: number }): boolean {
  const maxScrollTop = el.scrollHeight - el.clientHeight
  if (maxScrollTop <= 0) return false // UEX-P2-12：不足一屏不处理
  el.scrollTop = clampScrollTop(entry.scrollTop, maxScrollTop)
  return true
}

/** UEX-P2-12：跨环境调度一帧（jsdom 无 rAF 时回退 setTimeout） */
function scheduleFrame(cb: () => void): void {
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => cb())
  } else {
    setTimeout(cb, 0)
  }
}

/** UEX-P2-12：Virtuoso scrollerRef 可能传 Window（useWindowScroll），此处只认元素滚动容器 */
function asScrollerElement(ref: HTMLElement | Window | null): HTMLElement | null {
  const el = ref as HTMLElement | null
  if (el && typeof el.scrollTop === 'number' && typeof el.addEventListener === 'function') {
    return el
  }
  return null
}

export interface SessionScrollMemoryOptions {
  /** 记忆 key（null = 未选定会话，不启用记忆） */
  key: string | null
  /** 消息加载完成后才恢复（避免把历史位置写到未加载/旧数据的列表上） */
  ready: boolean
}

export interface SessionScrollMemory {
  /** Virtuoso 初始顶位：有记忆恢复到记录索引；无记忆保持现状（999999 = 默认到底） */
  initialTopMostItemIndex: number | { index: number; align: 'start' }
  /** 传给 Virtuoso scrollerRef：记录滚动 + 恢复像素位置 */
  scrollerRef: (el: HTMLElement | Window | null) => void
  /** 传给 Virtuoso rangeChanged：跟踪可见窗口顶位索引 */
  onRangeChanged: (range: { startIndex: number; endIndex: number }) => void
  /** 恢复进行中：供 followOutput 临时关闭自动到底，避免与位置恢复互相拉扯 */
  isRestoring: () => boolean
}

/**
 * UEX-P2-12：会话滚动记忆 hook。
 * 记录与恢复均以「会话 key + 当前滚动容器」为粒度；换容器（= 会话切换重挂载）时顶位索引重新累计。
 */
export function useSessionScrollMemory(options: SessionScrollMemoryOptions): SessionScrollMemory {
  const { key, ready } = options

  // 事件回调随时读取当前 key（事件总发生在会话切换提交之后，取到的即当时会话的 key）
  const keyRef = useRef(key)
  keyRef.current = key
  /** 最近一次可见窗口顶位索引（rangeChanged 跟踪，滚动记录时并入） */
  const topIndexRef = useRef(0)
  const restoringRef = useRef(false)
  const restoredElRef = useRef<HTMLElement | null>(null)
  const scrollerStateRef = useRef<{ el: HTMLElement | null; listener: ((ev: Event) => void) | null }>({
    el: null,
    listener: null,
  })
  // 滚动容器挂载状态：作为恢复 effect 的触发条件（ref 变化不触发渲染）
  const [scrollerEl, setScrollerEl] = useState<HTMLElement | null>(null)

  // UEX-P2-12：进入会话（挂载/切回）时读取一次记忆 → Virtuoso 初始顶位索引；
  // 新会话（无记录）保持现状：999999 = 默认到底
  const initialTopMostItemIndex = useMemo(() => {
    const entry = key ? loadScrollMemory(key) : null
    return entry ? { index: Math.max(0, entry.topIndex), align: 'start' as const } : 999999
  }, [key])

  const handleScroll = useCallback((ev: Event) => {
    const el = ev.currentTarget as HTMLElement | null
    const activeKey = keyRef.current
    if (!el || !activeKey) return
    // UEX-P2-12：滚动即记录（scrollTop + 顶位索引），覆盖离开/卸载场景
    saveScrollMemory(activeKey, { topIndex: topIndexRef.current, scrollTop: el.scrollTop })
  }, [])

  const scrollerRef = useCallback(
    (ref: HTMLElement | Window | null) => {
      const state = scrollerStateRef.current
      if (state.el && state.listener) state.el.removeEventListener('scroll', state.listener)
      const el = asScrollerElement(ref)
      state.el = el
      state.listener = null
      if (el) {
        // UEX-P2-12：换容器即换会话实例，顶位索引重新累计，避免上个会话的值记到新会话
        topIndexRef.current = 0
        el.addEventListener('scroll', handleScroll, { passive: true })
        state.listener = handleScroll
      }
      setScrollerEl(el)
    },
    [handleScroll],
  )

  const onRangeChanged = useCallback((range: { startIndex: number; endIndex: number }) => {
    // UEX-P2-12：仅跟踪顶位索引；写入记忆统一走滚动事件，避免挂载期未定位完成的窗口值污染记忆
    topIndexRef.current = Math.max(0, range.startIndex)
  }, [])

  // UEX-P2-12：回到该会话且消息加载完成后恢复——每个滚动容器只恢复一次（重挂载即重新恢复）
  useEffect(() => {
    if (!key || !ready || !scrollerEl) return
    if (restoredElRef.current === scrollerEl) return
    restoredElRef.current = scrollerEl
    const entry = loadScrollMemory(key)
    if (!entry) return // 新会话（无记录）：保持现状（默认到底）
    restoringRef.current = true
    let cancelled = false
    scheduleFrame(() => {
      if (cancelled) return
      // 像素细校正：不足一屏返回 false 不处理；超出最大滚动高度由 applyScrollRestore 钳制
      applyScrollRestore(scrollerEl, entry)
      restoringRef.current = false
    })
    return () => {
      cancelled = true
      restoringRef.current = false
    }
  }, [key, ready, scrollerEl])

  const isRestoring = useCallback(() => restoringRef.current, [])

  return { initialTopMostItemIndex, scrollerRef, onRangeChanged, isRestoring }
}
