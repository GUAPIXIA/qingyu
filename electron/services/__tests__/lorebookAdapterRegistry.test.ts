// @vitest-environment node
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { LorebookFormatAdapter } from '../../../shared/lorebook/adapters/types'
import { compileCanonicalLorebookV2 } from '../../../shared/lorebook/runtime/compile'
import { createCompatibilityReport } from '../lorebookAdapters/report'
import {
  LorebookAdapterError,
  LorebookAdapterRegistry,
  detectLorebookFormats,
  exportLorebookWithAdapter,
  importLorebookWithRegistry,
} from '../lorebookAdapters/registry'

interface CatalogEntry {
  id: string
  path: string
  format: string
  kind: 'minimal' | 'full' | 'invalid' | 'unknown_extensions'
  expected: { importable: boolean }
}

const fixtureRoot = join(__dirname, '../../../tests/lorebook/fixtures')
const catalog = JSON.parse(readFileSync(join(fixtureRoot, 'catalog.json'), 'utf8')) as { fixtures: CatalogEntry[] }

const adapterIds: Record<string, string> = {
  'qingyu-native-v1': 'qingyu.native-v1',
  'sillytavern-world-info': 'sillytavern.world-info',
  'character-book-v2-v3': 'character-card.character-book',
  'lorebook-v3': 'character-card.lorebook-v3',
  'risu-lorebook': 'risu.lorebook',
  'novelai-lorebook': 'novelai.lorebook',
  'agnai-memory-book': 'agnai.memory-book',
}

function load(entry: CatalogEntry): unknown {
  return JSON.parse(readFileSync(join(fixtureRoot, entry.path), 'utf8'))
}

function importFixture(entry: CatalogEntry) {
  return importLorebookWithRegistry(load(entry), {
    id: `adapter-${entry.id}`,
    fallbackName: `fallback-${entry.id}`,
    now: 1_700_000_000_000,
    contentHash: `hash-${entry.id}`,
    file: { fileName: entry.path },
  })
}

describe('Lorebook adapter registry', () => {
  it.each(catalog.fixtures)('$id 检测到预期 P0 adapter', (fixture) => {
    const detections = detectLorebookFormats(load(fixture), { fileName: fixture.path })
    expect(detections[0]).toMatchObject({ adapterId: adapterIds[fixture.format] })
    expect(detections[0].confidence).toBeGreaterThanOrEqual(60)
    expect(detections[0].reasons.length).toBeGreaterThan(0)
  })

  it.each(catalog.fixtures.filter((fixture) => fixture.kind !== 'invalid'))(
    '$id 通过独立 adapter 导入 canonical v2',
    (fixture) => {
      const result = importFixture(fixture)
      expect(result.document).toMatchObject({
        schema: 'qingyu_lorebook', schemaVersion: 2, id: `adapter-${fixture.id}`,
        source: { adapterId: adapterIds[fixture.format] },
      })
      expect(result.detection.adapterId).toBe(adapterIds[fixture.format])
      expect(result.report.status).not.toBe('rejected')
    },
  )

  it.each(catalog.fixtures.filter((fixture) => fixture.kind === 'invalid'))(
    '$id 无效结构被拒绝并返回结构化报告',
    (fixture) => {
      try {
        importFixture(fixture)
        throw new Error('应拒绝无效 fixture')
      } catch (error) {
        expect(error).toBeInstanceOf(LorebookAdapterError)
        const report = (error as LorebookAdapterError).report
        expect(report?.status).toBe('rejected')
        expect(report?.summary.errors).toBeGreaterThan(0)
      }
    },
  )

  it.each(catalog.fixtures.filter((fixture) => fixture.kind === 'unknown_extensions'))(
    '$id 未知字段被报告、保留并合并回同格式导出',
    (fixture) => {
      const imported = importFixture(fixture)
      expect(imported.report.summary.preserved).toBeGreaterThan(0)
      expect(imported.report.summary.dropped).toBe(0)
      expect(imported.report.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'unknown_field', action: 'preserved' }),
      ]))

      const exported = exportLorebookWithAdapter(adapterIds[fixture.format], imported.document)
      expect(JSON.stringify(exported.value)).toMatch(/future(Book|Entry|_book|_entry|_trigger)/)
    },
  )

  it.each(catalog.fixtures.filter((fixture) => fixture.kind === 'full'))(
    '$id 同格式导出再导入后兼容 Lorebook 语义等价',
    (fixture) => {
      const first = importFixture(fixture)
      const exported = exportLorebookWithAdapter(adapterIds[fixture.format], first.document)
      const second = importLorebookWithRegistry(exported.value, {
        id: first.document.id,
        fallbackName: first.document.name,
        now: 1_800_000_000_000,
        contentHash: 'roundtrip',
        file: { fileName: fixture.path },
      })
      expect(compileCanonicalLorebookV2(second.document)).toEqual(compileCanonicalLorebookV2(first.document))
    },
  )

  it('ST AN 位置保留在 canonical，并按运行时锚点精确映射', () => {
    const fixture = catalog.fixtures.find((item) => item.id === 'sillytavern-full')!
    const result = importFixture(fixture)
    expect(result.document.entries[1].insertion).toEqual({ kind: 'prompt', anchor: 'authors_note_top' })
    expect(result.report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'insertion_anchor', action: 'mapped' }),
    ]))
    expect(compileCanonicalLorebookV2(result.document).entries[1].position).toBe('at_end')
  })

  it('ST 0-7 插入位置与 depth role 均先保留领域原意', () => {
    const entries = Object.fromEntries(Array.from({ length: 8 }, (_, position) => [String(position), {
      uid: position,
      key: [`位置${position}`],
      content: `位置 ${position}`,
      position,
      depth: 2,
      role: 2,
      disable: false,
      ...(position === 7 ? { outlet_name: 'custom-outlet' } : {}),
    }]))
    const imported = importLorebookWithRegistry({ name: '位置书', entries }, {
      id: 'positions', fallbackName: '位置书', file: { fileName: 'world-info.json' },
    })
    expect(imported.document.entries.map((entry) => entry.insertion)).toEqual([
      { kind: 'prompt', anchor: 'before_character' },
      { kind: 'prompt', anchor: 'after_character' },
      { kind: 'prompt', anchor: 'authors_note_top' },
      { kind: 'prompt', anchor: 'authors_note_bottom' },
      { kind: 'chat', depth: 2, role: 'assistant' },
      { kind: 'prompt', anchor: 'before_examples' },
      { kind: 'prompt', anchor: 'after_examples' },
      { kind: 'outlet', name: 'custom-outlet' },
    ])
    // 8 个位置中只有 outlet 在运行时无原生插槽回退 prompt_end；AN/examples 已精确渲染
    expect(imported.report.summary.approximated).toBe(1)

    const exported = exportLorebookWithAdapter('sillytavern.world-info', imported.document)
    const roundtrip = importLorebookWithRegistry(exported.value, {
      id: 'positions', fallbackName: '位置书', file: { fileName: 'world-info.json' },
    })
    expect(roundtrip.document.entries.map((entry) => entry.insertion))
      .toEqual(imported.document.entries.map((entry) => entry.insertion))
  })

  it('canonical v2 adapter 以最高置信度识别并保持文档语义', () => {
    const source = importFixture(catalog.fixtures.find((item) => item.id === 'native-v1-minimal')!).document
    const detections = detectLorebookFormats(source, { fileName: 'canonical.json' })
    expect(detections[0]).toMatchObject({ adapterId: 'qingyu.canonical-v2', confidence: 100 })
    const imported = importLorebookWithRegistry(source, { id: 'canonical-copy', fallbackName: 'copy' })
    expect(imported.document).toEqual({ ...source, id: 'canonical-copy' })
    expect(exportLorebookWithAdapter('qingyu.canonical-v2', imported.document).value).toEqual(imported.document)
  })

  it('注册一个新格式只需新增 adapter，不修改 registry 或领域模型', () => {
    const base = importFixture(catalog.fixtures.find((item) => item.id === 'native-v1-minimal')!).document
    const custom: LorebookFormatAdapter = {
      id: 'test.future-format', label: 'Future Format', formatVersion: '1', priority: 1,
      detect: (input) => ({
        adapterId: 'test.future-format', formatLabel: 'Future Format', formatVersion: '1',
        confidence: (input as { future?: boolean })?.future === true ? 100 : 0,
        reasons: ['future=true'], conflicts: [],
      }),
      import: (_input, context) => ({
        document: { ...base, id: context.id ?? base.id },
        report: createCompatibilityReport('test.future-format', 'Future Format', '1'),
      }),
      export: (document) => ({
        value: { future: true, name: document.name },
        report: createCompatibilityReport('test.future-format', 'Future Format', '1'),
      }),
    }
    const registry = new LorebookAdapterRegistry([custom])
    expect(registry.import({ future: true }, { id: 'future-1', fallbackName: 'future' })).toMatchObject({
      document: { id: 'future-1' }, detection: { adapterId: 'test.future-format' },
    })
    registry.unregister('test.future-format')
    expect(() => registry.import({ future: true }, { fallbackName: 'future' })).toThrow('无法识别世界书格式')
  })

  it('Risu multiple 模式保留为 keyLogic=all，constant 条目进入常驻', () => {
    const result = importFixture(catalog.fixtures.find((item) => item.id === 'risu-full')!)
    const [multiple, constant] = result.document.entries
    expect(multiple).toMatchObject({
      sourceId: 'r1',
      title: '多重条件条目',
      activation: { keyLogic: 'all', mode: 'conditional', caseSensitive: true, secondaryKeys: ['夜晚'] },
      scheduling: { order: 5, probability: 80 },
    })
    expect(constant).toMatchObject({
      activation: { mode: 'constant', budgetTier: 'protected' },
      scheduling: { order: -10 },
    })
  })

  it('NovelAI text/forceActivation/priority 映射到 canonical 语义', () => {
    const result = importFixture(catalog.fixtures.find((item) => item.id === 'novelai-full')!)
    const [hybrid, constant] = result.document.entries
    expect(hybrid).toMatchObject({
      sourceId: 201,
      title: '星陨峡谷',
      content: '星陨峡谷每逢秋夜会出现流星雨。',
      activation: { mode: 'conditional', secondaryKeys: ['峡谷'], retrieval: 'hybrid', caseSensitive: false },
      scheduling: { order: 3, probability: 65 },
    })
    expect(constant).toMatchObject({
      sourceId: 202,
      activation: { mode: 'constant', caseSensitive: true, retrieval: 'keyword' },
    })
  })

  it('Agnai name/entry/keywords 映射并保留书名', () => {
    const result = importFixture(catalog.fixtures.find((item) => item.id === 'agnai-full')!)
    expect(result.document).toMatchObject({ name: 'Agnai 完整记忆书', description: '由 Agnai 记忆书导出的完整样本。' })
    const [first, disabled] = result.document.entries
    expect(first).toMatchObject({
      sourceId: 'agn-201',
      title: '星陨峡谷',
      content: '星陨峡谷每逢秋夜会出现流星雨。',
      activation: { primaryKeys: ['星陨峡谷', '峡谷'] },
      scheduling: { order: 3 },
    })
    expect(disabled.enabled).toBe(false)
  })
})

// ===================== 适配器契约补充（方案 §13.1 原缺失三项） =====================

describe('Lorebook adapter contract supplements', () => {
  it.each(catalog.fixtures)('$id 导入（含拒绝路径）不修改原始输入对象', (fixture) => {
    const input = load(fixture)
    const snapshot = JSON.parse(JSON.stringify(input))
    try {
      importLorebookWithRegistry(input, {
        id: `adapter-${fixture.id}`,
        fallbackName: `fallback-${fixture.id}`,
        now: 1_700_000_000_000,
        contentHash: `hash-${fixture.id}`,
        file: { fileName: fixture.path },
      })
    } catch {
      // 拒绝路径同样不允许修改输入
    }
    expect(input).toEqual(snapshot)
  })

  it('恶意输入：超深嵌套被明确拒绝，原型污染键不进入产物也不污染原型', () => {
    let deep: Record<string, unknown> = { leaf: 'x' }
    for (let i = 0; i < 200; i += 1) deep = { nested: deep }
    try {
      importLorebookWithRegistry(deep, { fallbackName: 'deep' })
      throw new Error('超深嵌套应被拒绝')
    } catch (error) {
      expect(error).toBeInstanceOf(LorebookAdapterError)
      expect((error as Error).message).toContain('嵌套深度')
    }

    const malicious = JSON.parse(`{
      "name": "恶意书",
      "entries": [{ "uid": 1, "key": ["a"], "content": "c1", "__proto__": { "polluted": true } }],
      "constructor": { "prototype": { "polluted": true } }
    }`)
    const result = importLorebookWithRegistry(malicious, {
      id: 'malicious-1', fallbackName: '恶意书', file: { fileName: 'world-info.json' },
    })
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(JSON.stringify(result.document)).not.toContain('__proto__')
  })

  it('ID 稳定且重复 source ID 不产生冲突条目 ID', () => {
    const source = {
      name: '重复ID书',
      entries: [
        { uid: 7, key: ['甲'], content: '第一条' },
        { uid: 7, key: ['乙'], content: '第二条' },
      ],
    }
    const options = { id: 'dup-ids', fallbackName: '重复ID书', file: { fileName: 'world-info.json' } }
    const first = importLorebookWithRegistry(source, options)
    const ids = first.document.entries.map((entry) => entry.id)
    expect(ids).toHaveLength(2)
    expect(new Set(ids).size).toBe(2)

    const second = importLorebookWithRegistry(source, options)
    expect(second.document.entries.map((entry) => entry.id)).toEqual(ids)
  })
})
