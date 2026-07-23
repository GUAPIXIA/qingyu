/**
 * 世界书（Lorebook）工具函数与统一缓存
 *
 * 统一入口，避免 fallback 链在各处重复。
 * 缓存层供 buildContext 同步使用（无需 IPC）。
 */

import type { Character, Lorebook } from '../../shared/types'

// ===================== 工具函数 =====================

/** 从角色获取有效的世界书 ID 列表（处理 boundLorebookIds / lorebookId 兼容） */
export function getEffectiveLorebookIds(character: Character | null | undefined): string[] {
  if (!character) return []
  return character.boundLorebookIds
    ?? (character.lorebookId ? [character.lorebookId] : [])
}

/**
 * 将角色的 legacy lorebookId 迁移到 boundLorebookIds。
 * 纯函数：不执行持久化，调用者自行保存。
 * 如果不需要迁移则返回原对象引用。
 */
export function migrateLorebookId(char: Character): Character {
  if (char.lorebookId && (!char.boundLorebookIds || char.boundLorebookIds.length === 0)) {
    return { ...char, boundLorebookIds: [char.lorebookId] }
  }
  return char
}

// ===================== 统一缓存 =====================

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
