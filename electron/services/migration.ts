/**
 * 数据迁移机制
 *
 * 每个数据域(settings / characters / lorebooks / sessions)维护一个版本号。
 * 数据结构变更时：bump 该域 LATEST_VERSION，并注册 from → to 的迁移函数。
 * 读取旧数据时自动按版本链升级，写入时自动带上当前版本。
 *
 * 原则：
 * - 迁移函数必须幂等（重复执行结果一致）
 * - 迁移失败不影响读取（返回原数据，避免数据丢失）
 * - 只向前迁移，不回滚
 */

import { getDefaultSettings } from '../../shared/defaults'
import type { Settings } from '../../shared/types'

export type DataDomain = 'settings' | 'characters' | 'lorebooks' | 'sessions'

/** 各数据域当前最新版本号 */
const LATEST_VERSION: Record<DataDomain, number> = {
  settings: 1,
  characters: 1,
  lorebooks: 1,
  sessions: 2,
}

interface Migration {
  from: number
  to: number
  run: (data: unknown) => unknown
}

/** 迁移注册表：数据结构变更时在此追加迁移函数并 bump LATEST_VERSION */
const MIGRATIONS: Record<DataDomain, Migration[]> = {
  settings: [
    {
      from: 0,
      to: 1,
      run: migrateSettingsV0ToV1,
    },
  ],
  characters: [],
  lorebooks: [],
  sessions: [
    {
      from: 0,
      to: 2,
      run: migrateSessionsObjectToArray,
    },
    {
      from: 1,
      to: 2,
      run: migrateSessionsObjectToArray,
    },
  ],
}

/**
 * sessions v1 损坏修复：sessions.json 曾被 writeJson 错误展开为对象格式
 * （{ "0": {...}, "1": {...}, schemaVersion: 1 }），恢复为数组。
 * 幂等：已是数组时原样返回。
 */
function migrateSessionsObjectToArray(data: unknown): unknown {
  if (Array.isArray(data)) return data
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>
    const items = Object.keys(obj)
      .filter((k) => k !== 'schemaVersion')
      .sort((a, b) => Number(a) - Number(b))
      .map((k) => obj[k])
    return items
  }
  return data
}

/** 读取旧 settings 时补齐缺失的顶层字段默认值（旧版没有的字段用默认配置填充） */
function migrateSettingsV0ToV1(data: unknown): unknown {
  const raw = (data ?? {}) as Partial<Settings>
  const defaults = getDefaultSettings()
  const merged: Record<string, unknown> = {}
  for (const [key, defValue] of Object.entries(defaults)) {
    merged[key] = raw[key as keyof Settings] === undefined ? defValue : raw[key as keyof Settings]
  }
  return merged
}

/** 获取某数据域的当前版本号（写入时使用） */
export function currentSchemaVersion(domain: DataDomain): number {
  return LATEST_VERSION[domain]
}

/** 读取数据的 schemaVersion（无版本字段视为 0） */
function readVersion(data: unknown): number {
  if (data && typeof data === 'object' && 'schemaVersion' in data) {
    const v = (data as { schemaVersion?: unknown }).schemaVersion
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v
  }
  return 0
}

/**
 * 按版本链迁移数据。无变化或迁移失败时返回 null（调用方保留原数据）。
 * @returns 迁移后的新数据；无需迁移或迁移失败返回 null
 */
export function migrateData<T>(domain: DataDomain, data: unknown): T | null {
  if (!data || typeof data !== 'object') return null
  const latest = LATEST_VERSION[domain]
  let version = readVersion(data)
  if (version >= latest) return null

  let current = data
  // 按 from 版本号排序的迁移链（版本必须严格递增）
  const chain = [...MIGRATIONS[domain]].sort((a, b) => a.from - b.from)
  for (const migration of chain) {
    if (version === migration.from) {
      try {
        current = migration.run(current)
        version = migration.to
      } catch {
        // 迁移失败：保留原数据，避免数据损坏
        return null
      }
    }
  }
  if (version >= latest) {
    // 附加当前版本号（数组数据域无法附加字段）
    if (Array.isArray(current)) {
      // 迁移函数幂等且返回原引用时视为无需变更，避免每次读取都触发回写
      return current === data ? null : (current as T)
    }
    return { ...(current as object), schemaVersion: latest } as T
  }
  return null
}
