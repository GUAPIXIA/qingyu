// @vitest-environment node
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { normalizeImportedLorebook } from '../../electron/services/lorebookImport'
import { validateNativeLorebookV1 } from '../../shared/lorebook/nativeV1'

interface FixtureCatalogEntry {
  id: string
  path: string
  format: string
  version: string
  kind: 'minimal' | 'full' | 'invalid' | 'unknown_extensions'
  provenance: 'project-regression' | 'spec-derived' | 'source-derived'
  source: string
  expected: {
    importable: boolean
    nativeValid: boolean
    entries: number
    name: string
    unknownFieldPolicy?: 'currently_dropped'
    currentBehavior?: 'salvaged_by_normalizer'
  }
}

interface FixtureCatalog {
  schemaVersion: number
  capturedAt: string
  fixtures: FixtureCatalogEntry[]
}

const fixtureRoot = join(__dirname, 'fixtures')
const catalog = JSON.parse(readFileSync(join(fixtureRoot, 'catalog.json'), 'utf8')) as FixtureCatalog

function load(entry: FixtureCatalogEntry): unknown {
  return JSON.parse(readFileSync(join(fixtureRoot, entry.path), 'utf8'))
}

const FORMAT_SOURCE_KINDS: Record<string, 'native' | 'sillytavern' | 'character_book'> = {
  'qingyu-native-v1': 'native',
  'sillytavern-world-info': 'sillytavern',
  'character-book-v2-v3': 'character_book',
  'lorebook-v3': 'character_book',
}

function normalizeById(id: string) {
  const fixture = catalog.fixtures.find((item) => item.id === id)
  if (!fixture) throw new Error(`fixture 不存在: ${id}`)
  return normalizeImportedLorebook(load(fixture), {
    id: `fixture-${id}`,
    fallbackName: `fallback-${id}`,
    sourceKind: FORMAT_SOURCE_KINDS[fixture.format],
  })
}

const P0_FORMATS = ['character-book-v2-v3', 'lorebook-v3', 'qingyu-native-v1', 'sillytavern-world-info'] as const
const P1_FORMATS = ['agnai-memory-book', 'novelai-lorebook', 'risu-lorebook'] as const

describe('阶段 0 世界书格式 fixture catalog', () => {
  it('每个 P0/P1 格式族都有最小、完整、异常和未知扩展样本', () => {
    const formats = new Map<string, Set<string>>()
    for (const fixture of catalog.fixtures) {
      const kinds = formats.get(fixture.format) ?? new Set<string>()
      kinds.add(fixture.kind)
      formats.set(fixture.format, kinds)
    }

    expect([...formats.keys()].sort()).toEqual([...P0_FORMATS, ...P1_FORMATS].sort())
    for (const [format, kinds] of formats) {
      expect([...kinds].sort(), format).toEqual(['full', 'invalid', 'minimal', 'unknown_extensions'])
    }
  })

  it.each(catalog.fixtures.filter((fixture) => (P0_FORMATS as readonly string[]).includes(fixture.format)))('$id 冻结当前归一化结果', (fixture) => {
    const raw = load(fixture)
    const normalized = normalizeImportedLorebook(raw, {
      id: `fixture-${fixture.id}`,
      fallbackName: `fallback-${fixture.id}`,
      sourceKind: FORMAT_SOURCE_KINDS[fixture.format],
    })

    expect(normalized.name).toBe(fixture.expected.name)
    expect(normalized.entries).toHaveLength(fixture.expected.entries)
    expect(normalized.entries.length > 0).toBe(fixture.expected.importable)
    expect(validateNativeLorebookV1(normalized).valid).toBe(true)

    if (fixture.format === 'qingyu-native-v1') {
      expect(validateNativeLorebookV1(raw).valid).toBe(fixture.expected.nativeValid)
    }

    if (fixture.expected.unknownFieldPolicy === 'currently_dropped') {
      const serialized = JSON.stringify(normalized)
      expect(serialized).not.toMatch(/future(Book|Entry|_book|_entry|_trigger)/)
    }
  })

  it('catalog 中每个样本记录版本、来源且文件路径不逃逸 fixture 根目录', () => {
    for (const fixture of catalog.fixtures) {
      expect(fixture.version).not.toBe('')
      expect(fixture.source).not.toBe('')
      const resolved = join(fixtureRoot, fixture.path)
      expect(dirname(resolved).startsWith(fixtureRoot)).toBe(true)
      expect(() => JSON.parse(readFileSync(resolved, 'utf8'))).not.toThrow()
    }
  })

  it('冻结 P0 全字段样本的高风险映射', () => {
    const native = normalizeById('native-v1-full')
    expect(native).toMatchObject({ scanDepth: 8, recursiveScanning: false, tokenBudget: 2048 })
    expect(native.entries[0]).toMatchObject({
      position: 'at_depth', depth: 2, role: 'system',
      selectiveLogic: 'and_any', matchMode: 'both', priority: 'detail',
      ignoreBudget: true,
    })
    // 阶段 0 已知缺口：以下 native 字段名未被当前统一导入器读取。
    expect(native.entries[0]).toMatchObject({ useGroupScoring: true })
    expect(native.entries[0].inclusionGroups).toBeUndefined()
    expect(native.entries[0].inclusionGroupPrioritized).toBeUndefined()
    expect(native.entries[0].inclusionGroupWeight).toBeUndefined()
    expect(native.entries[0].generationTriggers).toBeUndefined()

    const st = normalizeById('sillytavern-full')
    expect(st).toMatchObject({ scanDepth: 6, recursiveScanning: true })
    expect(st.entries[0]).toMatchObject({
      id: '10', position: 'at_depth', depth: 2, role: 'system',
      priority: 'always', matchMode: 'both', selectiveLogic: 'and_all',
      inclusionGroups: ['王族', '地点'], inclusionGroupPrioritized: true,
    })
    expect(st.entries[1]).toMatchObject({
      id: '11', position: 'at_end', matchMode: 'semantic',
    })

    const characterBook = normalizeById('character-book-full')
    expect(characterBook).toMatchObject({ scanDepth: 6, recursiveScanning: false, tokenBudget: 1024 })
    expect(characterBook.entries[0]).toMatchObject({
      id: 'capital', position: 'at_depth', depth: 3, role: 'user',
      probability: 65, useRegex: true, matchMode: 'both',
      selectiveLogic: 'and_any', ignoreBudget: true,
    })
    expect(characterBook.entries[1]).toMatchObject({ id: 'law', priority: 'always' })

    const v3 = normalizeById('lorebook-v3-full')
    expect(v3).toMatchObject({ scanDepth: 8, recursiveScanning: true, tokenBudget: 2048 })
    expect(v3.entries[0]).toMatchObject({ id: '7', priority: 'always', probability: 90 })
    expect(v3.entries[1]).toMatchObject({ id: '8', enabled: false })
  })

  it('记录当前边界：无效 native 会被归一化器修复，但 v1 validator 拒绝原始输入', () => {
    const fixture = catalog.fixtures.find((item) => item.id === 'native-v1-invalid')!
    expect(validateNativeLorebookV1(load(fixture)).valid).toBe(false)
    expect(validateNativeLorebookV1(normalizeById(fixture.id)).valid).toBe(true)
    expect(fixture.expected.currentBehavior).toBe('salvaged_by_normalizer')
  })
})
