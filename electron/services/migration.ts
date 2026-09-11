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
import { normalizeComfyWorkflow, analyzeComfyWorkflow } from './comfyWorkflow'

export type DataDomain = 'settings' | 'characters' | 'lorebooks' | 'sessions'

/** 各数据域当前最新版本号 */
const LATEST_VERSION: Record<DataDomain, number> = {
  settings: 2,
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
    {
      from: 1,
      to: 2,
      run: migrateSettingsV1ToV2,
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

/**
 * settings v1 → v2：移除全局 `imageGenSize`，把旧值转换为工作流尺寸节点的覆盖。
 *
 * ComfyUI 配置改为「工作流即事实来源」后，尺寸不再由全局字段决定，
 * 而应写入目标工作流尺寸节点的 `overrides`。
 *
 * 处理规则：
 * 1. 只有 `provider === 'comfyui'` 且带自定义工作流的配置才需要转换。
 * 2. 尺寸节点唯一时写入 `overrides`；不唯一时不自动应用（避免猜错节点）。
 * 3. 内置工作流（workflow 为空）不转换——其尺寸由内置模板决定。
 * 4. 无论是否转换成功，都删除全局字段。
 *
 * 幂等：已无 `imageGenSize` 且 overrides 已就位时结果不变。
 * 不发起网络请求：仅做本地结构分析。
 */
function migrateSettingsV1ToV2(data: unknown): unknown {
  const raw = { ...(data as Record<string, unknown>) }
  const legacySize = raw.imageGenSize
  delete raw.imageGenSize

  if (typeof legacySize !== 'string' || !/^\d{3,4}x\d{3,4}$/.test(legacySize)) return raw
  const [width, height] = legacySize.split('x').map(Number)

  const models = raw.imageGenModels
  if (!Array.isArray(models)) return raw

  raw.imageGenModels = models.map((item) => {
    if (!item || typeof item !== 'object') return item
    const model = { ...(item as Record<string, unknown>) }
    if (model.provider !== 'comfyui') return model

    const workflowJson = typeof model.workflow === 'string' ? model.workflow.trim() : ''
    if (!workflowJson) return model

    try {
      const parsed = JSON.parse(workflowJson) as unknown
      const { workflow } = normalizeComfyWorkflow(parsed)
      const analysis = analyzeComfyWorkflow(workflow)
      // 尺寸节点必须唯一，否则无法判断该覆盖哪一个，交给用户在界面确认。
      const sizeParams = analysis.parameterGroups
        .flatMap((group) => group.parameters)
        .filter((param) => param.type === 'size')
      if (sizeParams.length !== 1) return model

      const target = sizeParams[0]
      const overrides = { ...((model.overrides as Record<string, unknown> | undefined) ?? {}) }
      overrides[target.id] = width
      if (target.pairedInputName) {
        overrides[`${target.nodeId}.${target.pairedInputName}`] = height
      }
      model.overrides = overrides
      return model
    } catch {
      // 工作流无法解析时保留配置原样，仅丢失全局尺寸。
      return model
    }
  })

  return raw
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
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        current = migration.run(current) as any
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
