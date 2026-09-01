// @vitest-environment node
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { validateCanonicalLorebookV2 } from '../domain/validation'
import { migrateLorebookDocumentToLatest, LorebookMigrationError } from '../migrations'
import { compileCanonicalLorebookV2 } from '../runtime/compile'

const fixtureRoot = join(__dirname, '../../../tests/lorebook/fixtures/native-v1')

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(fixtureRoot, name), 'utf8'))
}

function migrate(value: unknown) {
  return migrateLorebookDocumentToLatest(value, {
    now: 1_700_000_000_000,
    contentHash: 'fixture-hash',
  })
}

describe('canonical lorebook v2 migration', () => {
  it('native v1 完整字段迁移为分组领域模型', () => {
    const document = migrate(fixture('full.json'))
    expect(validateCanonicalLorebookV2(document).valid).toBe(true)
    expect(document).toMatchObject({
      schema: 'qingyu_lorebook',
      schemaVersion: 2,
      revision: 1,
      id: 'native-full',
      defaults: { scanDepth: 8, recursiveScanning: false, tokenBudget: 2048 },
      source: { adapterId: 'qingyu.native-v1', formatVersion: '1', contentHash: 'fixture-hash' },
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
    })
    expect(document.entries[0]).toMatchObject({
      activation: {
        mode: 'conditional', budgetTier: 'supplemental',
        primaryKeys: ['公主', '/王(城|都)/iu'], secondaryKeys: ['帝国'],
        secondaryLogic: 'and_any', retrieval: 'hybrid',
      },
      insertion: { kind: 'chat', depth: 2, role: 'system' },
      scheduling: {
        recursion: { exclude: true, prevent: true, minDepth: 2 },
        groups: [{ name: 'royal', weight: 150, prioritized: true }],
        generationTriggers: ['normal', 'continue'],
      },
    })
  })

  it('native 未知字段进入 namespaced foreign', () => {
    const document = migrate(fixture('unknown-extensions.json'))
    expect(document.foreign).toEqual({
      'qingyu.native-v1': { futureBookOption: { revision: 2 } },
    })
    expect(document.entries[0].foreign).toEqual({
      'qingyu.native-v1': { futureEntryOption: { mode: 'opaque' } },
    })
  })

  it('兼容编译器恢复现有 Lorebook 运行时字段', () => {
    const view = compileCanonicalLorebookV2(migrate(fixture('full.json')))
    expect(view).toMatchObject({
      id: 'native-full', scanDepth: 8, recursiveScanning: false, tokenBudget: 2048,
    })
    expect(view.entries[0]).toMatchObject({
      position: 'at_depth', depth: 2, role: 'system', priority: 'detail', matchMode: 'both',
      inclusionGroups: ['royal'], inclusionGroupPrioritized: true, inclusionGroupWeight: 150,
      generationTriggers: ['normal', 'continue'],
    })
  })

  it('canonical v2 重复迁移返回同一文档语义', () => {
    const first = migrate(fixture('minimal.json'))
    const second = migrateLorebookDocumentToLatest(first, {
      now: 1_800_000_000_000,
      contentHash: 'should-not-replace',
    })
    expect(second).toEqual(first)
  })

  it('keywordProvenance 经 legacy → canonical → 兼容视图往返保留（阶段4 enrichment）', () => {
    const legacy = fixture('minimal.json') as {
      entries: Array<{ id: string }>
    }
    const provenance = {
      provider: 'openai',
      model: 'gpt-4o',
      generatedAt: 1_770_000_000_000,
      mode: 'enrich' as const,
    }
    const withProvenance = {
      ...legacy,
      entries: legacy.entries.map((entry, index) => ({
        ...entry,
        ...(index === 0 ? { keywordProvenance: { 星陨峡谷: provenance } } : {}),
      })),
    }

    // 保存：legacy 未知字段 → canonical foreign（qingyu.native-v1 命名空间）
    const document = migrate(withProvenance)
    expect(document.entries[0].foreign?.['qingyu.native-v1']).toEqual({
      keywordProvenance: { 星陨峡谷: provenance },
    })

    // 读取：编译回兼容视图时还原到 LoreEntry 顶层
    const view = compileCanonicalLorebookV2(document)
    expect(view.entries[0].keywordProvenance).toEqual({ 星陨峡谷: provenance })

    // 再次保存（视图 → canonical）仍保留：字段不属于 ENTRY_KEYS，继续进 foreign
    const redocument = migrate({ ...withProvenance, entries: view.entries })
    expect(redocument.entries[0].foreign?.['qingyu.native-v1']).toEqual({
      keywordProvenance: { 星陨峡谷: provenance },
    })
  })

  it('compile 还原时丢弃结构非法的 keywordProvenance 记录', () => {
    const legacy = fixture('minimal.json') as {
      entries: Array<{ id: string }>
    }
    const corrupted = {
      ...legacy,
      entries: legacy.entries.map((entry, index) => ({
        ...entry,
        ...(index === 0 ? {
          keywordProvenance: {
            合法词: { provider: 'openai', model: 'gpt-4o', generatedAt: 1, mode: 'localize' },
            缺字段: { provider: 'openai' },
            非对象: 'noise',
          },
        } : {}),
      })),
    }

    const view = compileCanonicalLorebookV2(migrate(corrupted))
    expect(view.entries[0].keywordProvenance).toEqual({
      合法词: { provider: 'openai', model: 'gpt-4o', generatedAt: 1, mode: 'localize' },
    })
  })

  it('canonical v2 校验拒绝损坏的嵌套策略字段', () => {
    const document = migrate(fixture('minimal.json'))
    const damaged = structuredClone(document) as unknown as Record<string, unknown>
    const entries = damaged.entries as Array<Record<string, unknown>>
    const scheduling = entries[0].scheduling as Record<string, unknown>
    scheduling.groups = [{ name: 'broken', weight: -1, prioritized: 'yes' }]
    const insertion = entries[0].insertion as Record<string, unknown>
    insertion.anchor = 'unknown_anchor'

    const result = validateCanonicalLorebookV2(damaged)
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: '$.entries[0].insertion.anchor' }),
        expect.objectContaining({ path: '$.entries[0].scheduling.groups[0].weight' }),
        expect.objectContaining({ path: '$.entries[0].scheduling.groups[0].prioritized' }),
      ]))
    }
  })

  it('无效 native v1 拒绝迁移并携带字段问题', () => {
    expect(() => migrate(fixture('invalid.json'))).toThrow(LorebookMigrationError)
    try {
      migrate(fixture('invalid.json'))
    } catch (error) {
      expect((error as LorebookMigrationError).issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: '$.id' }),
        expect.objectContaining({ path: '$.entries[0].keywords' }),
      ]))
    }
  })
})

describe('canonical v2 runtime compilation', () => {
  it('兼容视图保留完整 insertion/retrieval/source 供阶段 3 执行器使用', () => {
    const document = migrate(fixture('full.json'))
    document.source = {
      ...document.source!,
      adapterId: 'sillytavern.world-info',
      formatVersion: '2026-07',
    }
    document.entries[0].insertion = { kind: 'prompt', anchor: 'authors_note_top' }
    document.entries[0].activation.retrieval = 'semanticRequired'

    const view = compileCanonicalLorebookV2(document)
    expect(view.entries[0].position).toBe('at_end')
    expect(view.entries[0].runtime).toEqual({
      insertion: { kind: 'prompt', anchor: 'authors_note_top' },
      retrieval: 'semanticRequired',
      adapterId: 'sillytavern.world-info',
    })
    expect(view.runtime).toEqual({
      schemaVersion: 2,
      revision: 1,
      adapterId: 'sillytavern.world-info',
      formatVersion: '2026-07',
    })

    const roundTripped = migrate(view)
    expect(roundTripped.entries[0].insertion).toEqual({ kind: 'prompt', anchor: 'authors_note_top' })
    expect(roundTripped.entries[0].activation.retrieval).toBe('semanticRequired')
    expect(roundTripped.entries[0].foreign?.['qingyu.native-v1']).toBeUndefined()
  })
})
