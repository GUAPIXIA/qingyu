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
import { nanoid } from 'nanoid'
import { normalizeComfyWorkflow, analyzeComfyWorkflow } from './comfyWorkflow'
import { createLogger } from './logger'

const log = createLogger('migration')

export type DataDomain = 'settings' | 'characters' | 'lorebooks' | 'sessions'

/** 各数据域当前最新版本号 */
const LATEST_VERSION: Record<DataDomain, number> = {
  settings: 3,
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
    {
      from: 2,
      to: 3,
      run: migrateSettingsV2ToV3,
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

/** 读取旧 settings 时补齐缺失的顶层字段默认值（旧版没有的字段用默认配置填充）。
 *  从 defaults 移出字段（如 activeProvider）后仍原样透传旧键——迁移不得丢数据。 */
function migrateSettingsV0ToV1(data: unknown): unknown {
  const raw = { ...(data ?? {}) } as Record<string, unknown>
  const defaults = getDefaultSettings()
  for (const [key, defValue] of Object.entries(defaults)) {
    if (raw[key as keyof Settings] === undefined) raw[key as keyof Settings] = defValue
  }
  return raw
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
 * 3. 无工作流快照（workflow 为空）的配置不转换。
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

// ===================== 迁移链的凭据访问（settings v2 → v3） =====================

/**
 * settings v2→v3 的旧 provider → connectionProfiles 迁移需要读旧凭据、
 * 并把新档案的凭据写回 safeStorage。这里用注入而非直接 import：
 * safeStorage → storage → migration 会形成循环依赖。
 * 主进程在 electron/ipc/settings.ts 加载时注册；未注册时该迁移推迟
 * （抛错 → migrateData 返回 null → 下次读取重试），避免凭据丢失。
 */
export interface MigrationCredentialAccess {
  get(provider: string): string | null
  save(provider: string, key: string): void
}

let credentialAccess: MigrationCredentialAccess | null = null

/** 注册/清除迁移链的凭据访问实现（传 null 恢复未注册态） */
export function setMigrationCredentialAccess(access: MigrationCredentialAccess | null): void {
  credentialAccess = access
}

/**
 * settings v2 → v3：旧版单字段模型配置收敛（原渲染层启动探测迁移并链，B2）。
 *
 * 处理内容（与迁移前渲染层行为一致，幂等）：
 * 1. connectionProfiles 为空且存在旧 providers 配置时，按旧凭据创建连接档案；
 *    凭据迁到 safeStorage 的 `profile-<id>`，settings.json 不落明文（H1）；
 * 2. ttsProvider/ttsVoice/ttsModel、imageGenModel、visionModel 单字段 → 模型数组；
 * 3. 删除已废弃字段 ttsProvider / ttsVoice / ttsModel / visionModel / imageGenModel / authorNote；
 * 4. 存量 TTS provider 'edge' 统一为 'system'。
 *
 * 幂等：迁移后的数据再次执行不改动任何字段（数组已存在、废弃字段已删除）。
 */
function migrateSettingsV2ToV3(data: unknown): unknown {
  const raw = { ...(data as Record<string, unknown>) }

  // 1) 旧 providers → connectionProfiles（凭据依赖 safeStorage；未注册访问时推迟整个迁移）
  const providers = raw.providers
  const profiles = Array.isArray(raw.connectionProfiles) ? raw.connectionProfiles : []
  if (profiles.length === 0 && providers && typeof providers === 'object') {
    if (!credentialAccess) {
      throw new Error('settings v2→v3 迁移需要凭据访问：等待主进程注册后重试')
    }
    const defaultMaxContext: Record<string, number> = { openai: 131072, claude: 200000, gemini: 1048576, ollama: 8192 }
    const names: Record<string, string> = { openai: 'OpenAI', claude: 'Claude', gemini: 'Gemini', ollama: 'Ollama' }
    const nextProfiles: Array<Record<string, unknown>> = []
    for (const provider of ['openai', 'claude', 'gemini', 'ollama']) {
      const cfg = (providers as Record<string, unknown>)[provider]
      if (!cfg || typeof cfg !== 'object') continue
      const key = credentialAccess.get(provider) ?? ''
      // 与迁移前渲染层一致：无凭据且非 ollama 的 provider 不建档案
      if (!key && provider !== 'ollama') continue
      const id = nanoid()
      if (key) {
        try {
          credentialAccess.save(`profile-${id}`, key)
        } catch (e) {
          // 加密不可用时保留旧凭据（仍在 credentials.json 的 provider 名下），档案先建为空 key
          log.warn('旧 provider 凭据迁移进 safeStorage 失败，档案将不含密钥', { provider, error: (e as Error).message })
        }
      }
      nextProfiles.push({
        id,
        name: names[provider] ?? provider,
        provider,
        baseUrl: (cfg as { baseUrl?: unknown }).baseUrl ?? '',
        model: (cfg as { model?: unknown }).model ?? '',
        apiKey: '',
        maxContext: defaultMaxContext[provider] ?? 8192,
      })
    }
    if (nextProfiles.length > 0) {
      raw.connectionProfiles = nextProfiles
      if (!raw.activeProfileId) raw.activeProfileId = nextProfiles[0].id
    }
  }

  const legacy = raw as {
    ttsProvider?: unknown
    ttsVoice?: unknown
    ttsModel?: unknown
    visionModel?: unknown
    imageGenModel?: unknown
  }

  // 2) TTS 单字段 → 数组；存量 'edge' → 'system'
  const ttsModels = raw.ttsModels
  if (!Array.isArray(ttsModels) || ttsModels.length === 0) {
    if (typeof legacy.ttsModel === 'string' || typeof legacy.ttsProvider === 'string') {
      const id = nanoid()
      raw.ttsModels = [{
        id,
        name: '默认 TTS',
        // 旧值 edge 迁移为 system（3.2-A：系统语音引擎）
        provider: legacy.ttsProvider === 'openai' ? 'openai' : 'system',
        model: typeof legacy.ttsModel === 'string' ? legacy.ttsModel : 'tts-1',
        voice: typeof legacy.ttsVoice === 'string' ? legacy.ttsVoice : '',
        apiKey: '',
        baseUrl: 'https://api.openai.com/v1',
        enabled: true,
        order: 0,
      }]
      raw.activeTTSModelId = id
    } else {
      raw.ttsModels = []
    }
  } else {
    raw.ttsModels = ttsModels.map((model) =>
      model && typeof model === 'object' && (model as { provider?: unknown }).provider === 'edge'
        ? { ...(model as Record<string, unknown>), provider: 'system' }
        : model,
    )
  }

  // 3) 生图单字段 → 数组
  const imageGenModels = raw.imageGenModels
  if (!Array.isArray(imageGenModels) || imageGenModels.length === 0) {
    if (typeof legacy.imageGenModel === 'string' && legacy.imageGenModel) {
      const id = nanoid()
      raw.imageGenModels = [{
        id,
        name: '默认生图',
        provider: 'openai',
        model: legacy.imageGenModel,
        apiKey: '',
        baseUrl: '',
        size: '1024x1024',
        quality: 'standard',
        enabled: true,
        order: 0,
      }]
      raw.activeImageGenModelId = id
    } else {
      raw.imageGenModels = []
    }
  }

  // 4) 识图单字段 → 数组
  const visionModels = raw.visionModels
  if (!Array.isArray(visionModels) || visionModels.length === 0) {
    if (typeof legacy.visionModel === 'string' && legacy.visionModel) {
      const id = nanoid()
      raw.visionModels = [{
        id,
        name: '默认识图',
        model: legacy.visionModel,
        enabled: true,
        order: 0,
      }]
      raw.activeVisionModelId = id
    } else {
      raw.visionModels = []
    }
  }

  // 5) 删除废弃字段
  delete raw.ttsProvider
  delete raw.ttsVoice
  delete raw.ttsModel
  delete raw.visionModel
  delete raw.imageGenModel
  delete raw.authorNote

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
