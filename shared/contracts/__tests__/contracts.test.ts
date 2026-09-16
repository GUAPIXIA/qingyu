import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { canonicalize, contentHash, type CanonicalJsonValue } from '../canonical-json'
import {
  bumpDot,
  compareVectors,
  formatCounter,
  parseCounter,
  UINT64_MAX,
  vectorFromPairs,
} from '../version-vector'
import { makeEnvelope, tombstoneEnvelope, isPseudoConflict } from '../sync-envelope'
import { checkDependencyAgainstFences } from '../conflict'
import { MigrationRegistry } from '../migrations'

describe('contracts canonical json', () => {
  it('键序稳定、丢 undefined、负零、禁止非有限数', () => {
    expect(canonicalize({ b: 1, a: 2, c: undefined as never })).toBe('{"a":2,"b":1}')
    expect(canonicalize(-0)).toBe('0')
    expect(canonicalize(1e21)).toBe('1e+21')
    expect(() => canonicalize(Number.NaN)).toThrow()
    expect(() => canonicalize(Number.POSITIVE_INFINITY)).toThrow()
  })

  it('contentHash 格式稳定', () => {
    const h = contentHash({ name: 'x', n: 1 })
    expect(h).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(contentHash({ n: 1, name: 'x' })).toBe(h)
  })
})

describe('version vector', () => {
  it('counter 十进制字符串与上限', () => {
    expect(parseCounter('0')).toBe(0n)
    expect(formatCounter(UINT64_MAX)).toBe('18446744073709551615')
    expect(() => parseCounter('01')).toThrow()
    expect(() => parseCounter('18446744073709551616')).toThrow()
  })

  it('比较关系与合并', () => {
    const a = vectorFromPairs([['pc', '3']])
    const b = vectorFromPairs([['pc', '3'], ['and', '1']])
    expect(compareVectors(a, b)).toBe('dominated')
    expect(compareVectors(b, a)).toBe('dominates')
    expect(compareVectors(a, a)).toBe('equal')
    expect(compareVectors(vectorFromPairs([['pc', '1']]), vectorFromPairs([['and', '1']]))).toBe('concurrent')
    expect(bumpDot(a, 'pc').vector).toEqual({ pc: '4' })
    expect(bumpDot(a, 'pc').dot).toEqual({ deviceId: 'pc', counter: '4' })
  })

  it('交换律/幂等/支配传递性属性（构造样例）', () => {
    const x = vectorFromPairs([['a', '2'], ['b', '1']])
    const y = vectorFromPairs([['a', '1'], ['c', '4']])
    const z = vectorFromPairs([['a', '5'], ['b', '1']])
    const z2 = vectorFromPairs([['a', '5'], ['b', '1'], ['c', '4']])
    expect(compareVectors(x, y)).toBe('concurrent')
    expect(compareVectors(y, x)).toBe('concurrent')
    expect(compareVectors(x, x)).toBe('equal')
    expect(compareVectors(z, x)).toBe('dominates')
    expect(compareVectors(z2, y)).toBe('dominates')
    expect(compareVectors(z2, z)).toBe('dominates')
  })
})

describe('sync envelope & conflict', () => {
  it('makeEnvelope 写 dot 与 hash；tombstone 清空 payload hash', () => {
    const env = makeEnvelope({
      entityType: 'character',
      entityId: 'c1',
      payload: { name: 'A' },
      deviceId: 'android_b',
      previousVersion: { pc_a: '1' },
    })
    expect(env.dot).toEqual({ deviceId: 'android_b', counter: '1' })
    expect(env.version).toEqual({ pc_a: '1', android_b: '1' })
    const tomb = tombstoneEnvelope(env, 'android_b')
    expect(tomb.deleted).toBe(true)
    expect(tomb.payload).toEqual({})
    expect(tomb.dot.counter).toBe('2')
  })

  it('伪冲突与依赖 fence', () => {
    const l = makeEnvelope({ entityType: 'message', entityId: 'm1', payload: { content: 'x' }, deviceId: 'a' })
    const r = makeEnvelope({
      entityType: 'message',
      entityId: 'm1',
      payload: { content: 'x' },
      deviceId: 'b',
      previousVersion: { a: '0' },
    })
    // both start from empty then bump own — concurrent same hash
    expect(l.contentHash).toBe(r.contentHash)
    expect(isPseudoConflict(l, r)).toBe(true)

    const parent = makeEnvelope({
      entityType: 'session',
      entityId: 's1',
      payload: {},
      deviceId: 'a',
      aggregate: { type: 'session', id: 's1' },
    })
    const fenceEnv = tombstoneEnvelope(parent, 'a')
    const child = makeEnvelope({
      entityType: 'message',
      entityId: 'm9',
      payload: { content: 'y' },
      deviceId: 'b',
      parentId: 's1',
      references: ['s1'],
    })
    const check = checkDependencyAgainstFences(child, [
      {
        aggregateType: 'session',
        aggregateId: 's1',
        deletedAt: fenceEnv.updatedAt,
        fenceVersion: fenceEnv.version,
      },
    ])
    expect(check.ok).toBe(false)
  })
})

describe('migration registry', () => {
  it('只允许 N→N+1 并可连续迁移', () => {
    const r = new MigrationRegistry()
    r.register({
      entityType: 'character',
      from: 1,
      to: 2,
      migrate: (p: any) => ({ ...p, schema: 2, name: p.name ?? p.n }),
    })
    r.register({
      entityType: 'character',
      from: 2,
      to: 3,
      migrate: (p: any) => ({ ...p, schema: 3 }),
    })
    const out = r.migrateTo<any>('character', { n: 'Z' }, 1, 3)
    expect(out.schema).toBe(3)
    expect(out.name).toBe('Z')
    expect(() => r.register({ entityType: 'character', from: 1, to: 3, migrate: (p) => p })).toThrow()
    expect(() => r.migrateTo('character', {}, 3, 1)).toThrow(/降级/)
    expect(() => r.migrateTo('character', {}, 1, 5)).toThrow(/缺少迁移步骤/)
  })
})

describe('canonical golden fixtures', () => {
  const cases = JSON.parse(
    readFileSync(join(__dirname, '../fixtures/canonical/golden-cases.json'), 'utf8'),
  ) as Array<{ id: string; value: CanonicalJsonValue; canonical: string }>

  it.each(cases.map((c) => [c.id, c] as const))('golden %s', (_id, c) => {
    expect(canonicalize(c.value)).toBe(c.canonical)
  })
})

describe('sensitive field scan on valid settings fixture', () => {
  it('settings_public fixture 无密钥字段', () => {
    const valid = JSON.parse(
      readFileSync(join(__dirname, '../fixtures/valid/payloads.json'), 'utf8'),
    ) as Array<{ name: string; payload: Record<string, unknown> }>
    const settings = valid.find((v) => v.name === 'settings-public-ok')!
    for (const forbidden of ['apiKey', 'token', 'spaceKey', 'password', 'secret']) {
      expect(String(JSON.stringify(settings.payload)).includes(forbidden)).toBe(false)
    }
  })
})
