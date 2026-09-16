import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  assertPayloadWithinLimit,
  bumpDot,
  canonicalJson,
  compareVectors,
  encodeTime,
  formatCounter,
  mergeVectors,
  parseCounter,
  planBlobChunks,
  ulid,
} from '../syncBaseline'

const FIXTURE_DIR = join(__dirname, '../fixtures/cross-platform/baseline')

describe('phase0 syncBaseline spike', () => {
  it('canonicalJson 键序稳定且丢弃 undefined', () => {
    const a = canonicalJson({ b: 1, a: 2, c: undefined as unknown as number })
    const b = canonicalJson({ c: undefined as unknown as number, a: 2, b: 1 })
    expect(a).toBe(b)
    expect(a).toBe('{"a":2,"b":1}')
  })

  it('canonicalJson 处理负零、转义与数字边界', () => {
    expect(canonicalJson(-0)).toBe('0')
    expect(canonicalJson(1e-7)).toBe('1e-7')
    expect(canonicalJson('q"\\\n')).toBe(JSON.stringify('q"\\\n'))
    expect(canonicalJson(Number.MAX_SAFE_INTEGER)).toBe('9007199254740991')
    expect(canonicalJson({ '𝕌': 'x' })).toBe('{"' + '𝕌' + '":"x"}')
  })

  it('ULID 时间单调可排序', () => {
    const r = new Uint8Array(10).fill(1)
    const t1 = encodeTime(1789550000000)
    const t2 = encodeTime(1789550000001)
    expect(t1 < t2).toBe(true)
    expect(ulid(1789550000000, r) < ulid(1789550000001, r)).toBe(true)
    expect(ulid(1789550000000, r)).toHaveLength(26)
  })

  it('版本向量 counter 字符串解析与比较', () => {
    expect(parseCounter('0')).toBe(0n)
    expect(formatCounter(18446744073709551615n)).toBe('18446744073709551615')
    expect(() => parseCounter('01')).toThrow()
    expect(() => parseCounter('18446744073709551616')).toThrow()

    const a = { pc_a: '12', android_b: '4' }
    const b = { pc_a: '12', android_b: '5' }
    expect(compareVectors(a, b)).toBe('b')
    expect(compareVectors(a, a)).toBe('equal')
    expect(compareVectors({ pc_a: '3' }, { android_b: '1' })).toBe('concurrent')
    expect(compareVectors({ pc_a: '3', android_b: '0' }, { pc_a: '1', android_b: '1' })).toBe('concurrent')
    expect(mergeVectors({ pc_a: '3' }, { pc_a: '1', android_b: '1' })).toEqual({
      pc_a: '3',
      android_b: '1',
    })
    expect(bumpDot({ pc_a: '1' }, 'pc_a')).toEqual({ pc_a: '2' })
  })

  it('2MiB payload 上限与分块计划', () => {
    const ok = 'x'.repeat(1024)
    expect(() => assertPayloadWithinLimit(ok)).not.toThrow()
    const tooBig = Buffer.alloc(2 * 1024 * 1024 + 1, 32).toString('utf8')
    expect(() => assertPayloadWithinLimit(tooBig)).toThrow(/2MiB/)

    const plans = planBlobChunks(2 * 1024 * 1024 + 1, 1024 * 1024)
    expect(plans).toHaveLength(3)
    expect(plans[2].plainLength).toBe(1)
    expect(plans.reduce((s, p) => s + p.plainLength, 0)).toBe(2 * 1024 * 1024 + 1)
  })

  it('golden fixture 可读取且无高熵密钥模式', () => {
    const manifest = JSON.parse(readFileSync(join(FIXTURE_DIR, 'manifest.json'), 'utf8'))
    expect(manifest.fixtureRevision).toMatch(/^2026-09-16-phase0\./)

    const cardV2 = JSON.parse(
      readFileSync(join(FIXTURE_DIR, 'characters/character-card-v2-embedded-lorebook.json'), 'utf8'),
    )
    expect(cardV2.spec).toBe('chara_card_v2')
    expect(cardV2.character_book.entries.length).toBeGreaterThan(0)

    const texts: string[] = []
    const walkFiles = [
      'characters/character-card-v1.json',
      'sessions/single-chat/session-1-message.json',
      'sessions/group-chat/group-modes.json',
      'lorebooks/canonical-v2-mixed-triggers.json',
      'presets-personas-quickreplies-regex/bundle.json',
      'memory/summary-facts-vector-degrade.json',
      'corruption/invalid-and-orphan.json',
    ]
    for (const rel of walkFiles) {
      texts.push(readFileSync(join(FIXTURE_DIR, rel), 'utf8'))
    }
    const joined = texts.join('\n')
    expect(joined).not.toMatch(/-----BEGIN (RSA |OPENSSH |EC )?PRIVATE KEY-----/)
    expect(joined).not.toMatch(/\bsk-[A-Za-z0-9]{20,}/)
    expect(joined).not.toMatch(/\bghp_[A-Za-z0-9]{20,}/)
    expect(joined).not.toMatch(/"apiKey"\s*:\s*"[^"]+"/)
  })
})
