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
      expect(migrated.schemaVersion).toBe(1)
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
      expect(migrateData('settings', { schemaVersion: 1, theme: 'dark' })).toBeNull()
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
      expect(raw?.schemaVersion).toBe(1)
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
      expect(migrated?.schemaVersion).toBe(1)
      expect(migrated?.activeProvider).toBe('openai')
      // 回写后磁盘上已带版本号
      const again = readJson<Record<string, unknown>>(file(), 'settings')
      expect(again?.schemaVersion).toBe(1)
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
      expect(currentSchemaVersion('settings')).toBe(1)
      expect(currentSchemaVersion('characters')).toBe(1)
      expect(currentSchemaVersion('lorebooks')).toBe(1)
      expect(currentSchemaVersion('sessions')).toBe(2)
    })
  })
})
