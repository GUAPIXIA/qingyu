// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  listLorebookGoldenFixtures,
  loadLorebookGoldenFixture,
  runLorebookGoldenFixture,
} from './goldenRunner'
import { migrateNativeLorebookV1ToV2 } from '../../../shared/lorebook/migrations/v1-to-v2'
import { compileCanonicalLorebookV2 } from '../../../shared/lorebook/runtime/compile'

describe('阶段 0 世界书当前触发行为 golden', () => {
  const files = listLorebookGoldenFixtures()

  it('固定 fixture 集合完整', () => {
    expect(files).toHaveLength(4)
  })

  it.each(files)('%s', (path) => {
    const fixture = loadLorebookGoldenFixture(path)
    expect(runLorebookGoldenFixture(fixture)).toEqual(fixture.expected)
  })

  it.each(files)('%s 经 native v1 → canonical v2 → 兼容视图后行为等价', (path) => {
    const fixture = loadLorebookGoldenFixture(path)
    const migrated = fixture.input.lorebooks.map((book, index) => compileCanonicalLorebookV2(
      migrateNativeLorebookV1ToV2(book, {
        now: 1_700_000_000_000,
        contentHash: `golden-${index}`,
      }),
    ))
    expect(runLorebookGoldenFixture({
      ...fixture,
      input: { ...fixture.input, lorebooks: migrated },
    })).toEqual(fixture.expected)
  })
})
