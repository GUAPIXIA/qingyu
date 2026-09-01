// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { CanonicalLorebookDocumentV2, CanonicalLoreEntryV2 } from '../../../shared/lorebook/domain/v2'
import { analyzeLorebookHealth, type LorebookHealthInput } from '../lorebookHealthCheck'

const BASE_ENTRY: Omit<CanonicalLoreEntryV2, 'id'> = {
  enabled: true,
  content: '内容',
  activation: {
    mode: 'conditional', budgetTier: 'standard',
    primaryKeys: ['关键词'], secondaryKeys: [], aliases: [], keyLogic: 'any',
    caseSensitive: false, wholeWords: true,
    regex: { enabled: false, flags: 'i' },
    retrieval: 'keyword',
  },
  insertion: { kind: 'prompt', anchor: 'prompt_end' },
  scheduling: {
    order: 0, probability: 100,
    recursion: { exclude: false, prevent: false, minDepth: 0 },
    groups: [], groupScoring: false, ignoreBudget: false,
  },
}

function makeEntry(patch: Partial<Omit<CanonicalLoreEntryV2, 'activation'>> & {
  id: string
  activation?: Partial<CanonicalLoreEntryV2['activation']>
}): CanonicalLoreEntryV2 {
  const { activation, ...rest } = patch
  return { ...BASE_ENTRY, ...rest, activation: { ...BASE_ENTRY.activation, ...(activation ?? {}) } }
}

function makeBook(entries: CanonicalLoreEntryV2[], id = 'b1', name = '测试书'): { id: string; name: string; document: CanonicalLorebookDocumentV2 } {
  return {
    id,
    name,
    document: {
      schema: 'qingyu_lorebook', schemaVersion: 2, id, revision: 1, name,
      description: '', enabled: true, defaults: { scanDepth: 4, recursiveScanning: true },
      entries, createdAt: 1, updatedAt: 1,
    },
  }
}

const NO_INDEX: LorebookHealthInput = { semanticAvailable: false, indexInfo: {} }

describe('世界书健康检查', () => {
  it('同一本书内重复条目 ID 被报告', () => {
    const report = analyzeLorebookHealth(
      [makeBook([makeEntry({ id: 'dup' }), makeEntry({ id: 'dup', content: '另一条' })])],
      NO_INDEX,
    )
    expect(report.summary.duplicate_id).toBe(1)
    expect(report.issues[0]).toMatchObject({ entryId: 'dup', bookId: 'b1' })
  })

  it('启用的非法正则被报告，合法正则不报', () => {
    const report = analyzeLorebookHealth(
      [makeBook([
        makeEntry({ id: 'bad', activation: { regex: { enabled: true, flags: 'i' }, primaryKeys: ['[未闭合'] } }),
        makeEntry({ id: 'good', activation: { regex: { enabled: true, flags: 'i' }, primaryKeys: ['王城.*'] } }),
      ])],
      NO_INDEX,
    )
    expect(report.summary.invalid_regex).toBe(1)
    expect(report.issues[0].entryId).toBe('bad')
    expect(report.issues[0].detail).toContain('[未闭合')
  })

  it('死条目：无触发条件的关键词条目与无语义服务的 semanticRequired', () => {
    const report = analyzeLorebookHealth(
      [makeBook([
        makeEntry({ id: 'no-keys', activation: { primaryKeys: [] } }),
        makeEntry({ id: 'required', activation: { retrieval: 'semanticRequired' } }),
        makeEntry({ id: 'hybrid-no-keys', activation: { primaryKeys: [], retrieval: 'hybrid' } }),
      ])],
      { ...NO_INDEX, semanticAvailable: false },
    )
    const dead = report.issues.filter((item) => item.kind === 'dead_entry')
    expect(dead.map((item) => item.entryId).sort()).toEqual(['no-keys', 'required'])

    const available = analyzeLorebookHealth(
      [makeBook([makeEntry({ id: 'required', activation: { retrieval: 'semanticRequired' } })])],
      { ...NO_INDEX, semanticAvailable: true },
    )
    expect(available.issues).toHaveLength(0)
  })

  it('无法执行的位置：outlet 与 custom 回退被报告，prompt 位置不报', () => {
    const report = analyzeLorebookHealth(
      [makeBook([
        makeEntry({ id: 'outlet', insertion: { kind: 'outlet', name: 'facts' } }),
        makeEntry({ id: 'custom', insertion: { kind: 'custom', source: 'x', value: 'pos' } }),
        makeEntry({ id: 'prompt', insertion: { kind: 'prompt', anchor: 'authors_note_top' } }),
      ])],
      NO_INDEX,
    )
    expect(report.summary.unexecutable_position).toBe(2)
    expect(report.issues.every((item) => ['outlet', 'custom'].includes(item.entryId!))).toBe(true)
  })

  it('stale 索引与模型不匹配索引被报告', () => {
    const report = analyzeLorebookHealth(
      [makeBook([makeEntry({ id: 'e1' })]), makeBook([makeEntry({ id: 'e2' })], 'b2', '第二本')],
      {
        semanticAvailable: false,
        indexInfo: {
          b1: { staleCount: 3, modelMismatch: false },
          b2: { staleCount: 0, modelMismatch: true },
        },
      },
    )
    expect(report.summary.stale_index).toBe(2)
    expect(report.issues[0].detail).toContain('3 条向量已过期')
    expect(report.issues[1].detail).toContain('不是当前语义配置生成')
  })

  it('干净数据返回 ok 报告', () => {
    const report = analyzeLorebookHealth(
      [makeBook([makeEntry({ id: 'fine' }), makeEntry({ id: 'fine2', activation: { mode: 'constant', primaryKeys: [] } })])],
      { semanticAvailable: false, indexInfo: { b1: { staleCount: 0, modelMismatch: false } } },
    )
    expect(report.ok).toBe(true)
    expect(report.bookCount).toBe(1)
    expect(report.entryCount).toBe(2)
  })
})
