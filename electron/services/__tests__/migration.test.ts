/**
 * 数据迁移机制单元测试
 *
 * 覆盖：旧数据自动升级、版本号写入、幂等、无迁移域直通、失败不损坏。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/qingyu-migration-test' },
}))

import { migrateData, currentSchemaVersion, setMigrationCredentialAccess } from '../migration'
import { readJson, writeJson, DIRS } from '../storage'
import { mkdirSync, rmSync } from 'node:fs'

describe('migration', () => {
  beforeEach(() => {
    // settings v2→v3 的旧 provider → profile 迁移需要凭据访问；
    // 默认注册空实现（无旧凭据 → 只有 ollama 会建档案），用例可覆盖注册。
    setMigrationCredentialAccess({ get: () => null, save: () => {} })
  })

  describe('migrateData', () => {
    it('upgrades v0 settings by filling missing default fields', () => {
      // 模拟旧版 settings:缺大量新字段
      const oldSettings = {
        activeProvider: 'openai',
        activeModel: 'gpt-4o-mini',
        theme: 'dark',
      }
      const migrated = migrateData('settings', oldSettings) as Record<string, unknown>
      expect(migrated).not.toBeNull()
      expect(migrated.schemaVersion).toBe(4)
      // 旧字段保留
      expect(migrated.activeProvider).toBe('openai')
      expect(migrated.theme).toBe('dark')
      // 缺失字段补默认值
      expect(migrated.autoScroll).toBe(true)
      expect(migrated.streamOutput).toBe(true)
      expect(migrated.contextCompression).toBeDefined()
      expect(migrated.providers).toBeDefined()
      expect(migrated.semanticTrigger).toBeDefined()
    })

    it('returns null when already at latest version', () => {
      expect(migrateData('settings', { schemaVersion: 4, theme: 'dark' })).toBeNull()
    })

    it('returns null for non-object data', () => {
      expect(migrateData('settings', 'not-an-object')).toBeNull()
      expect(migrateData('settings', null)).toBeNull()
    })

    it('passes through domains without migrations', () => {
      // characters 域暂无迁移,版本 0 视为最新
      expect(migrateData('characters', { name: 'x' })).toBeNull()
    })

    it('sessions: repairs corrupted object-format data back to array', () => {
      // 回归：writeJson 曾把 sessions 数组展开成 { "0": ..., schemaVersion: 1 }
      const corrupted = {
        '0': { id: 's1', title: '会话一' },
        '1': { id: 's2', title: '会话二' },
        schemaVersion: 1,
      }
      const repaired = migrateData('sessions', corrupted)
      expect(Array.isArray(repaired)).toBe(true)
      expect((repaired as unknown[]).length).toBe(2)
      expect((repaired as { id: string }[])[0].id).toBe('s1')
      // 顺序保持数字键序
      expect((repaired as { id: string }[])[1].id).toBe('s2')
    })

    it('sessions: array data passes through idempotently', () => {
      const arr = [{ id: 's1' }, { id: 's2' }]
      expect(migrateData('sessions', arr)).toBeNull()
    })

    it('is idempotent (migrating migrated data returns null)', () => {
      const once = migrateData('settings', { theme: 'dark' })
      expect(migrateData('settings', once)).toBeNull()
    })
  })

  describe('settings v1 → v2（移除 imageGenSize）', () => {
    /** 尺寸节点唯一的经典工作流：EmptyLatentImage 可被唯一定位。 */
    function singleSizeWorkflow(): string {
      return JSON.stringify({
        '1': { class_type: 'CLIPTextEncode', inputs: { text: 'p' } },
        '2': { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512 } },
        '3': {
          class_type: 'KSampler',
          inputs: { steps: 20, positive: ['1', 0], latent_image: ['2', 0] },
        },
        '4': { class_type: 'SaveImage', inputs: { images: ['3', 0] } },
      })
    }

    /** 两个尺寸节点都可到达输出：无法判断应覆盖哪一个。 */
    function ambiguousSizeWorkflow(): string {
      return JSON.stringify({
        '1': { class_type: 'CLIPTextEncode', inputs: { text: 'p' } },
        '2': { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512 } },
        '3': { class_type: 'KSampler', inputs: { steps: 20, positive: ['1', 0], latent_image: ['2', 0] } },
        '4': { class_type: 'EmptySD3LatentImage', inputs: { width: 1024, height: 1024 } },
        '5': { class_type: 'KSampler', inputs: { steps: 20, positive: ['1', 0], latent_image: ['4', 0] } },
        '6': { class_type: 'SaveImage', inputs: { images: ['3', 0] } },
        '7': { class_type: 'SaveImage', inputs: { images: ['5', 0] } },
      })
    }

    function settingsWith(models: unknown[]): Record<string, unknown> {
      return { schemaVersion: 1, imageGenSize: '1024x2048', imageGenModels: models }
    }

    it('尺寸节点唯一时把全局尺寸写入该节点的 overrides，并删除全局字段', () => {
      const migrated = migrateData('settings', settingsWith([
        { id: 'c1', provider: 'comfyui', workflow: singleSizeWorkflow() },
      ])) as Record<string, unknown>

      expect(migrated).not.toBeNull()
      expect(migrated.imageGenSize).toBeUndefined()
      expect(migrated.schemaVersion).toBe(4)
      const models = migrated.imageGenModels as Array<Record<string, unknown>>
      expect(models[0].overrides).toEqual({ '2.width': 1024, '2.height': 2048 })
    })

    it('尺寸节点不唯一时不写 overrides，但仍删除全局字段', () => {
      const migrated = migrateData('settings', settingsWith([
        { id: 'c1', provider: 'comfyui', workflow: ambiguousSizeWorkflow() },
      ])) as Record<string, unknown>

      const models = migrated.imageGenModels as Array<Record<string, unknown>>
      expect(models[0].overrides).toBeUndefined()
      expect(migrated.imageGenSize).toBeUndefined()
    })

    it('保留已有 overrides，仅合并尺寸键', () => {
      const migrated = migrateData('settings', settingsWith([
        {
          id: 'c1',
          provider: 'comfyui',
          workflow: singleSizeWorkflow(),
          overrides: { '3.steps': 6, '2.width': 768 },
        },
      ])) as Record<string, unknown>

      const models = migrated.imageGenModels as Array<Record<string, unknown>>
      expect(models[0].overrides).toEqual({ '3.steps': 6, '2.width': 1024, '2.height': 2048 })
    })

    it('内置工作流（workflow 为空）与非 ComfyUI 配置原样保留', () => {
      const migrated = migrateData('settings', settingsWith([
        { id: 'builtin', provider: 'comfyui', workflow: '', model: 'z_image_turbo.safetensors' },
        { id: 'openai', provider: 'openai', size: '1024x1024' },
      ])) as Record<string, unknown>

      const models = migrated.imageGenModels as Array<Record<string, unknown>>
      expect(models[0].overrides).toBeUndefined()
      expect(models[0].model).toBe('z_image_turbo.safetensors')
      expect(models[1].size).toBe('1024x1024')
      expect(migrated.imageGenSize).toBeUndefined()
    })

    it('工作流无法解析时不抛错，仅丢失全局尺寸', () => {
      const migrated = migrateData('settings', settingsWith([
        { id: 'broken', provider: 'comfyui', workflow: '{ 不是合法 JSON' },
      ])) as Record<string, unknown>

      expect(migrated).not.toBeNull()
      expect(migrated.imageGenSize).toBeUndefined()
      const models = migrated.imageGenModels as Array<Record<string, unknown>>
      expect(models[0].overrides).toBeUndefined()
    })

    it('非法尺寸字符串不写入 overrides', () => {
      const migrated = migrateData('settings', {
        schemaVersion: 1,
        imageGenSize: 'huge',
        imageGenModels: [{ id: 'c1', provider: 'comfyui', workflow: singleSizeWorkflow() }],
      }) as Record<string, unknown>

      const models = migrated.imageGenModels as Array<Record<string, unknown>>
      expect(models[0].overrides).toBeUndefined()
      expect(migrated.imageGenSize).toBeUndefined()
    })

    it('幂等：迁移后的数据再次迁移返回 null', () => {
      const once = migrateData('settings', settingsWith([
        { id: 'c1', provider: 'comfyui', workflow: singleSizeWorkflow() },
      ]))
      expect(migrateData('settings', once)).toBeNull()
    })
  })

  describe('settings v2 → v3（旧单字段配置并链，B2）', () => {
    /** 一份 v2 设置：无连接档案、有旧 providers 与单字段模型配置 */
    function v2Settings(overrides: Record<string, unknown> = {}): Record<string, unknown> {
      return {
        schemaVersion: 2,
        theme: 'dark',
        activeProfileId: null,
        connectionProfiles: [],
        providers: {
          openai: { type: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
          claude: { type: 'claude', baseUrl: 'https://api.anthropic.com', model: 'claude-3-5-sonnet' },
          gemini: { type: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com', model: 'gemini-1.5-flash' },
          ollama: { type: 'ollama', baseUrl: 'http://localhost:11434', model: 'llama3.2' },
        },
        ttsProvider: 'edge',
        ttsVoice: 'zh-CN-Xiaoxiao',
        ttsModel: 'tts-1',
        imageGenModel: 'dall-e-3',
        visionModel: 'gpt-4o-vision',
        authorNote: { enabled: true, text: '旧作者注释' },
        semanticTrigger: { enabled: false },
        ...overrides,
      }
    }

    it('有旧凭据时按 providers 建档案，凭据进 safeStorage 且不落明文', () => {
      const saved: Array<[string, string]> = []
      setMigrationCredentialAccess({
        get: (provider) => (provider === 'openai' ? 'sk-legacy-openai' : null),
        save: (provider, key) => { saved.push([provider, key]) },
      })

      const migrated = migrateData('settings', v2Settings()) as Record<string, unknown>
      expect(migrated).not.toBeNull()
      expect(migrated.schemaVersion).toBe(4)

      const profiles = migrated.connectionProfiles as Array<Record<string, unknown>>
      // openai（有凭据）+ ollama（无凭据也建）两条；cli 缺失的 claude/gemini 不建
      expect(profiles.map((p) => p.provider)).toEqual(['openai', 'ollama'])
      expect(profiles[0].maxContext).toBe(131072)
      expect(profiles[0].baseUrl).toBe('https://api.openai.com/v1')
      // H1：settings 数据中不落明文密钥，凭据写到 safeStorage 的 profile-<id>
      expect(profiles[0].apiKey).toBe('')
      expect(saved).toHaveLength(1)
      expect(saved[0][0]).toBe(`profile-${profiles[0].id}`)
      expect(saved[0][1]).toBe('sk-legacy-openai')
      // 首个档案补位 activeProfileId
      expect(migrated.activeProfileId).toBe(profiles[0].id)
    })

    it('已有 activeProfileId 时不被覆盖', () => {
      const migrated = migrateData('settings', v2Settings({ activeProfileId: 'keep-me' })) as Record<string, unknown>
      expect(migrated.activeProfileId).toBe('keep-me')
    })

    it('单字段模型配置转为数组，废弃字段删除，edge 归一为 system', () => {
      const migrated = migrateData('settings', v2Settings()) as Record<string, unknown>

      const tts = migrated.ttsModels as Array<Record<string, unknown>>
      expect(tts).toHaveLength(1)
      expect(tts[0].provider).toBe('system')
      expect(tts[0].voice).toBe('zh-CN-Xiaoxiao')
      expect(migrated.activeTTSModelId).toBe(tts[0].id)

      const imageGen = migrated.imageGenModels as Array<Record<string, unknown>>
      expect(imageGen).toHaveLength(1)
      expect(imageGen[0].model).toBe('dall-e-3')

      const vision = migrated.visionModels as Array<Record<string, unknown>>
      expect(vision).toHaveLength(1)
      expect(vision[0].model).toBe('gpt-4o-vision')

      for (const key of ['ttsProvider', 'ttsVoice', 'ttsModel', 'imageGenModel', 'visionModel', 'authorNote']) {
        expect(migrated[key]).toBeUndefined()
      }
    })

    it('已有模型数组时保留数组，仅归一 edge', () => {
      const migrated = migrateData('settings', v2Settings({
        ttsModels: [{ id: 't1', provider: 'edge', model: 'm', voice: 'v', apiKey: '', baseUrl: '', enabled: true, order: 0 }],
        imageGenModels: [{ id: 'i1', provider: 'openai', model: 'keep' }],
        visionModels: [{ id: 'v1', model: 'keep-vision', enabled: true, order: 0 }],
      })) as Record<string, unknown>

      expect((migrated.ttsModels as Array<Record<string, unknown>>)[0].provider).toBe('system')
      expect((migrated.imageGenModels as Array<Record<string, unknown>>)[0].model).toBe('keep')
      expect((migrated.visionModels as Array<Record<string, unknown>>)[0].model).toBe('keep-vision')
      expect(migrated.activeImageGenModelId).toBeUndefined()
    })

    it('幂等：迁移结果再次迁移返回 null', () => {
      const once = migrateData('settings', v2Settings())
      expect(once).not.toBeNull()
      expect(migrateData('settings', once)).toBeNull()
    })

    it('凭据访问未注册时推迟迁移（数据不丢，注册后可迁移）', () => {
      setMigrationCredentialAccess(null)
      expect(migrateData('settings', v2Settings())).toBeNull()

      setMigrationCredentialAccess({ get: () => null, save: () => {} })
      const migrated = migrateData('settings', v2Settings()) as Record<string, unknown>
      expect(migrated).not.toBeNull()
      expect(migrated.schemaVersion).toBe(4)
    })
  })

  describe('settings v3 → v4（W10 生成规划语义）', () => {
    it('保留旧数值记录并移除世界书生产比例，不把连接窗口自动升级为能力覆盖', () => {
      const migrated = migrateData('settings', {
        schemaVersion: 3,
        lorebookRatio: 0.5,
        connectionProfiles: [
          { id: 'p1', provider: 'openai', model: 'gpt-4o', maxContext: 128000 },
        ],
      }) as Record<string, unknown>

      expect(migrated.schemaVersion).toBe(4)
      expect(migrated.lorebookRatio).toBeUndefined()
      expect(migrated).toMatchObject({
        defaultResponseLength: 'auto',
        reasoningEffort: 'auto',
        autoTailRepairEnabled: true,
        costReminderEnabled: true,
        reasoningGateEnabled: true,
        generationMigrationV4: {
          legacyLorebookRatio: 0.5,
          legacyProfileMaxContexts: { p1: 128000 },
        },
      })
      expect((migrated.connectionProfiles as Array<Record<string, unknown>>)[0])
        .toMatchObject({ maxContext: 128000, capabilityOverride: { enabled: false } })
    })

    it('保留用户已保存的偏好和显式能力覆盖，迁移后重复运行不变', () => {
      const once = migrateData('settings', {
        schemaVersion: 3,
        defaultResponseLength: 'detailed',
        reasoningEffort: 'low',
        autoTailRepairEnabled: false,
        costReminderEnabled: false,
        reasoningGateEnabled: false,
        connectionProfiles: [{
          id: 'p1', maxContext: 32000,
          capabilityOverride: { enabled: true, contextLimit: 64000, outputLimit: 4096 },
        }],
      }) as Record<string, unknown>
      expect(once).toMatchObject({
        defaultResponseLength: 'detailed',
        reasoningEffort: 'low',
        autoTailRepairEnabled: false,
        costReminderEnabled: false,
        reasoningGateEnabled: false,
      })
      expect((once.connectionProfiles as Array<Record<string, unknown>>)[0])
        .toMatchObject({ capabilityOverride: { enabled: true, contextLimit: 64000, outputLimit: 4096 } })
      expect(migrateData('settings', once)).toBeNull()
    })
  })

  describe('storage integration', () => {
    const file = () => join(DIRS.config(), 'settings.json')
    function join(...parts: string[]): string {
      return parts.join('/')
    }

    beforeEach(() => {
      try { rmSync('/tmp/qingyu-migration-test', { recursive: true, force: true }) } catch { /* ignore */ }
      mkdirSync('/tmp/qingyu-migration-test/data/config', { recursive: true })
    })

    it('writeJson attaches schemaVersion for the domain', () => {
      writeJson(file(), { theme: 'light' }, 'settings')
      const raw = readJson<{ schemaVersion?: number }>(file())
      expect(raw?.schemaVersion).toBe(4)
    })

    it('writeJson without domain does not attach schemaVersion', () => {
      writeJson(file(), { theme: 'light' })
      const raw = readJson<{ schemaVersion?: number }>(file())
      expect(raw?.schemaVersion).toBeUndefined()
    })

    it('readJson migrates old data and persists it back', () => {
      // 写一份无版本号的旧数据
      writeJson(file(), { activeProvider: 'openai' })
      const migrated = readJson<Record<string, unknown>>(file(), 'settings')
      expect(migrated?.schemaVersion).toBe(4)
      expect(migrated?.activeProvider).toBe('openai')
      // 回写后磁盘上已带版本号
      const again = readJson<Record<string, unknown>>(file(), 'settings')
      expect(again?.schemaVersion).toBe(4)
    })

    it('writeJson with array data keeps it an array (regression: sessions corruption)', () => {
      // 回归：数组数据域写读往返必须保持数组，不得被展开成对象
      const sessionsFile = join(DIRS.config(), 'sessions.json')
      const sessions = [
        { id: 's1', title: '会话一' },
        { id: 's2', title: '会话二' },
      ]
      writeJson(sessionsFile, sessions, 'sessions')
      const readBack = readJson<unknown[]>(sessionsFile, 'sessions')
      expect(Array.isArray(readBack)).toBe(true)
      expect((readBack as unknown[]).length).toBe(2)
      expect((readBack as { id: string }[])[0].id).toBe('s1')
    })

    it('readJson repairs corrupted sessions.json on disk and persists it back', () => {
      // 模拟磁盘上已被写坏的 sessions.json
      const sessionsFile = join(DIRS.config(), 'sessions.json')
      const corrupted = {
        '0': { id: 's1', title: '会话一' },
        schemaVersion: 1,
      }
      writeJson(sessionsFile, corrupted) // 无 domain，原样写坏数据
      const repaired = readJson<unknown[]>(sessionsFile, 'sessions')
      expect(Array.isArray(repaired)).toBe(true)
      expect((repaired as unknown[]).length).toBe(1)
      // 已回写修复
      const again = readJson<unknown[]>(sessionsFile, 'sessions')
      expect(Array.isArray(again)).toBe(true)
    })

    it('currentSchemaVersion returns expected values', () => {
      expect(currentSchemaVersion('settings')).toBe(4)
      expect(currentSchemaVersion('characters')).toBe(1)
      expect(currentSchemaVersion('lorebooks')).toBe(1)
      expect(currentSchemaVersion('sessions')).toBe(2)
    })
  })
})
