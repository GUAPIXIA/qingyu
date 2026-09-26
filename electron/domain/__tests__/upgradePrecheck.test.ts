import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runUpgradePrecheck } from '../upgradePrecheck'

function seedUserData(root: string): void {
  mkdirSync(join(root, 'data', 'config'), { recursive: true })
  mkdirSync(join(root, 'data', 'characters'), { recursive: true })
  mkdirSync(join(root, 'data', 'media'), { recursive: true })
  mkdirSync(join(root, 'data', 'chats', 'c1'), { recursive: true })
  writeFileSync(
    join(root, 'data', 'config', 'settings.json'),
    JSON.stringify({ theme: 'dark', connectionProfiles: [] }),
    'utf8',
  )
  writeFileSync(
    join(root, 'data', 'characters', 'a.json'),
    JSON.stringify({ id: 'char-a', name: 'A' }),
    'utf8',
  )
  writeFileSync(join(root, 'data', 'chats', 'c1', 'sessions.json'), JSON.stringify([{ id: 's1' }]), 'utf8')
  writeFileSync(join(root, 'data', 'chats', 'c1', 's1.jsonl'), `${JSON.stringify({ id: 'm1' })}\n`, 'utf8')
}

describe('S9-01 升级预检', () => {
  it('空间充足 + 干净数据 → ok，无 block', () => {
    const root = mkdtempSync(join(tmpdir(), 's9-precheck-'))
    seedUserData(root)
    const report = runUpgradePrecheck(root, {
      freeDiskBytes: () => 2 * 1024 * 1024 * 1024,
      requiredBytes: 512 * 1024 * 1024,
      now: 1,
    })
    expect(report.ok).toBe(true)
    expect(report.items.filter((i) => i.severity === 'block')).toEqual([])
    expect(report.freeBytes).toBe(2 * 1024 * 1024 * 1024)
  })

  it('空间不足 → block', () => {
    const root = mkdtempSync(join(tmpdir(), 's9-precheck-'))
    seedUserData(root)
    const report = runUpgradePrecheck(root, {
      freeDiskBytes: () => 1024,
      requiredBytes: 512 * 1024 * 1024,
    })
    expect(report.ok).toBe(false)
    expect(report.items.some((i) => i.kind === 'disk_space' && i.severity === 'block')).toBe(true)
  })

  it('损坏 JSON 与重复 ID 会被报告', () => {
    const root = mkdtempSync(join(tmpdir(), 's9-precheck-'))
    seedUserData(root)
    writeFileSync(join(root, 'data', 'characters', 'bad.json'), '{not-json', 'utf8')
    writeFileSync(
      join(root, 'data', 'characters', 'dup.json'),
      JSON.stringify({ id: 'char-a', name: 'Dup' }),
      'utf8',
    )
    const report = runUpgradePrecheck(root, { freeDiskBytes: () => 1e12 })
    expect(report.items.some((i) => i.kind === 'corrupt_json')).toBe(true)
    expect(report.items.some((i) => i.kind === 'duplicate_id')).toBe(true)
    expect(report.ok).toBe(false)
  })

  it('损坏 JSONL 会报告 warn', () => {
    const root = mkdtempSync(join(tmpdir(), 's9-precheck-'))
    seedUserData(root)
    writeFileSync(join(root, 'data', 'chats', 'c1', 'broken.jsonl'), 'not-json\n', 'utf8')
    const report = runUpgradePrecheck(root, { freeDiskBytes: () => 1e12 })
    expect(report.items.some((i) => i.kind === 'corrupt_jsonl' && i.severity === 'warn')).toBe(true)
    // warn 不阻断 ok
    expect(report.ok).toBe(true)
  })

  it('孤儿媒体会报告且不 block', () => {
    const root = mkdtempSync(join(tmpdir(), 's9-precheck-'))
    seedUserData(root)
    writeFileSync(join(root, 'data', 'media', 'orphan.png'), 'x', 'utf8')
    const report = runUpgradePrecheck(root, { freeDiskBytes: () => 1e12 })
    expect(report.items.some((i) => i.kind === 'orphan_media')).toBe(true)
    expect(report.ok).toBe(true)
  })

  it('settings.json 损坏 → schema block', () => {
    const root = mkdtempSync(join(tmpdir(), 's9-precheck-'))
    seedUserData(root)
    writeFileSync(join(root, 'data', 'config', 'settings.json'), '[]', 'utf8')
    const report = runUpgradePrecheck(root, { freeDiskBytes: () => 1e12 })
    expect(report.items.some((i) => i.kind === 'schema_mismatch' && i.severity === 'block')).toBe(true)
    expect(report.ok).toBe(false)
  })

  it('无法探测空间时 info 不 block', () => {
    const root = mkdtempSync(join(tmpdir(), 's9-precheck-'))
    seedUserData(root)
    const report = runUpgradePrecheck(root, { freeDiskBytes: () => null })
    expect(report.freeBytes).toBeNull()
    expect(report.ok).toBe(true)
    expect(report.items.some((i) => i.kind === 'disk_space' && i.severity === 'info')).toBe(true)
  })
})
