/**
 * 桌面世界书缓存与 IPC 加载（阶段 1 从 `shared/chat-core/lorebook.ts` 迁入）。
 *
 * 结构优化目标：界面缓存与 IPC 数据加载归 `src/features/lorebook`；
 * 纯领域匹配、预算与缓存键计算继续留在 shared/chat-core。
 * 本模块是渲染层模块级缓存（按活跃世界书 ID 维护），主进程与 Android 不引用。
 */
import type { Lorebook } from '../../../shared/types'

const _cache = new Map<string, Lorebook>()

export const lorebookCache = {
  get(id: string): Lorebook | undefined {
    return _cache.get(id)
  },

  getAll(ids: string[]): Lorebook[] {
    return ids.map(id => _cache.get(id)).filter(Boolean) as Lorebook[]
  },

  set(id: string, lb: Lorebook): void {
    _cache.set(id, lb)
  },

  setAll(lbs: Lorebook[]): void {
    for (const lb of lbs) _cache.set(lb.id, lb)
  },

  delete(id: string): void {
    _cache.delete(id)
  },

  clear(): void {
    _cache.clear()
  },

  /** 批量加载：从 IPC 获取世界书列表并更新缓存。返回匹配 ids 的 Lorebook[]。 */
  async refresh(ids: string[]): Promise<Lorebook[]> {
    const all = await window.api.lorebook.list()
    // 清理不再活跃的条目
    for (const [cachedId] of _cache) {
      if (!ids.includes(cachedId)) _cache.delete(cachedId)
    }
    // 仅缓存需要的
    for (const id of ids) {
      const lb = all.find(b => b.id === id)
      if (lb) _cache.set(lb.id, lb)
    }
    return ids.map(id => _cache.get(id)).filter(Boolean) as Lorebook[]
  },
}