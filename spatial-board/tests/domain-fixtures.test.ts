/**
 * 领域校验器对 fixtures/invalid 的拒绝测试（§17.1-12）。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  hasErrors,
  validateWorld,
  migrateWorldDocument,
  type SpatialWorldDocumentV1,
} from '@qingyu/spatial-core'

function loadInvalid(name: string): SpatialWorldDocumentV1 {
  const raw = JSON.parse(
    readFileSync(join(__dirname, '..', 'fixtures', 'invalid', name), 'utf8')
  )
  const migrated = migrateWorldDocument(raw)
  if (!migrated.ok) throw new Error(migrated.message)
  return migrated.value
}

function loadValid(name: string): SpatialWorldDocumentV1 {
  const raw = JSON.parse(
    readFileSync(join(__dirname, '..', 'fixtures', name), 'utf8')
  )
  const migrated = migrateWorldDocument(raw)
  if (!migrated.ok) throw new Error(migrated.message)
  return migrated.value
}

describe('领域校验拒绝 invalid fixtures', () => {
  it('circular-parent：循环父子被拒', () => {
    const world = loadInvalid('circular-parent.json')
    const issues = validateWorld(world)
    expect(hasErrors(issues)).toBe(true)
    expect(issues.some((i) => i.code === 'cycle_detected')).toBe(true)
  })

  it('dangling-child-board：悬空子画板被拒', () => {
    const world = loadInvalid('dangling-child-board.json')
    const issues = validateWorld(world)
    expect(hasErrors(issues)).toBe(true)
    expect(issues.some((i) => i.code === 'dangling_child_board')).toBe(true)
  })

  it('cross-kind-distance：跨类型距离被拒', () => {
    const world = loadInvalid('cross-kind-distance.json')
    const issues = validateWorld(world)
    expect(hasErrors(issues)).toBe(true)
    expect(issues.some((i) => i.code === 'cross_kind_distance')).toBe(true)
  })

  it('cross-board-distance：跨画板距离被拒', () => {
    const world = loadInvalid('cross-board-distance.json')
    const issues = validateWorld(world)
    expect(hasErrors(issues)).toBe(true)
    expect(
      issues.some(
        (i) => i.code === 'cross_board_distance' || i.code === 'distance_board_mismatch'
      )
    ).toBe(true)
  })
})

describe('正例 fixtures 通过领域校验', () => {
  it('city-home', () => {
    const world = loadValid('city-home.json')
    const issues = validateWorld(world)
    expect(hasErrors(issues)).toBe(false)
  })

  it('planet-system', () => {
    const world = loadValid('planet-system.json')
    const issues = validateWorld(world)
    expect(hasErrors(issues)).toBe(false)
  })
})
