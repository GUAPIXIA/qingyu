/**
 * 数据迁移机制单元测试
 *
 * 覆盖：旧数据自动升级、版本号写入、幂等、无迁移域直通、失败不损坏。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/qingyu-migration-test' },
}))

import { migrateData, currentSchemaVersion } from '../migration'
import { readJson, writeJson, DIRS } from '../storage'
import { mkdirSync, rmSync } from 'node:fs'

describe('migration', () => {
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
      expect(migrated.schemaVersion).toBe(2)
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
      expect(migrateData('settings', { schemaVersion: 2, theme: 'dark' })).toBeNull()
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
      expect(migrated.schemaVersion).toBe(2)
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
      expect(raw?.schemaVersion).toBe(2)
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
      expect(migrated?.schemaVersion).toBe(2)
      expect(migrated?.activeProvider).toBe('openai')
      // 回写后磁盘上已带版本号
      const again = readJson<Record<string, unknown>>(file(), 'settings')
      expect(again?.schemaVersion).toBe(2)
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
      expect(currentSchemaVersion('settings')).toBe(2)
      expect(currentSchemaVersion('characters')).toBe(1)
      expect(currentSchemaVersion('lorebooks')).toBe(1)
      expect(currentSchemaVersion('sessions')).toBe(2)
    })
  })
})
