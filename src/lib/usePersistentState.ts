import { useCallback, useState, type Dispatch, type SetStateAction } from 'react'

/**
 * 界面选项持久化工具。
 *
 * 用途：用户手动选择过的「界面偏好」（视图模式、排序方式、子标签、展开/折叠集合等）
 * 应当跨重启保留，但它们不属于业务数据，所以放 localStorage 而不是 settings.json。
 * 业务数据/需要随备份迁移的选项仍走 useSettingsStore。
 */

/** 读取 JSON；不存在 / 解析失败 / localStorage 不可用时返回 fallback */
function readJson(key: string, fallback: unknown): unknown {
  try {
    const raw = localStorage.getItem(key)
    if (raw === null) return fallback
    return JSON.parse(raw) as unknown
  } catch {
    return fallback
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* 隐私模式 / 配额不足：仅当前会话生效 */
  }
}

interface PersistentStateOptions<T> {
  /** 校验已存值；返回 false 时回退到 initial（用于标签 key 这类枚举值，避免版本变更后读到脏值） */
  validate?: (value: unknown) => value is T
}

/**
 * 持久化到 localStorage 的 `useState`。
 * 返回的 setter 与 `useState` 完全一致（支持函数式更新）。
 */
export function usePersistentState<T>(
  key: string,
  initial: T | (() => T),
  options?: PersistentStateOptions<T>,
): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => {
    const fallback = typeof initial === 'function' ? (initial as () => T)() : initial
    const stored = readJson(key, undefined)
    if (stored === undefined) return fallback
    if (options?.validate && !options.validate(stored)) return fallback
    return stored as T
  })

  const set = useCallback<Dispatch<SetStateAction<T>>>((action) => {
    setValue((prev) => {
      const next = typeof action === 'function' ? (action as (prev: T) => T)(prev) : action
      writeJson(key, next)
      return next
    })
  }, [key])

  return [value, set]
}

/** localStorage 中集合最多保留的条目数，避免长期使用后无界增长 */
const MAX_PERSISTED_SET_SIZE = 500

/**
 * 持久化的字符串集合（展开/折叠状态等）。
 * 序列化为数组存储，读取时过滤非字符串；写入时只保留最近 500 条。
 */
export function usePersistentSet(
  key: string,
  initial?: Iterable<string>,
): [Set<string>, Dispatch<SetStateAction<Set<string>>>] {
  const [value, setValue] = useState<Set<string>>(() => {
    const stored = readJson(key, undefined)
    if (Array.isArray(stored)) {
      return new Set(stored.filter((item): item is string => typeof item === 'string'))
    }
    return new Set(initial ?? [])
  })

  const set = useCallback<Dispatch<SetStateAction<Set<string>>>>((action) => {
    setValue((prev) => {
      const next = typeof action === 'function' ? (action as (prev: Set<string>) => Set<string>)(prev) : action
      writeJson(key, [...next].slice(-MAX_PERSISTED_SET_SIZE))
      return next
    })
  }, [key])

  return [value, set]
}
