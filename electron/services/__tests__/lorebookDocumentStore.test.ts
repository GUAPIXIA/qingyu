// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Lorebook } from '../../../shared/types'
import {
  readLorebookDocument,
  readLorebookView,
  saveLorebookDocumentInput,
  saveLorebookView,
} from '../lorebookDocumentStore'

const roots: string[] = []

function tempFile(): string {
  const root = mkdtempSync(join(tmpdir(), 'qingyu-lorebook-v2-'))
  roots.push(root)
  return join(root, 'book.json')
}

function legacy(): Lorebook {
  return {
    id: 'book-1',
    name: '测试世界书',
    description: '重启读取测试',
    enabled: true,
    scanDepth: 4,
    recursiveScanning: true,
    entries: [{
      id: 'entry-1',
      keywords: ['王城'],
      content: '王城是首都。',
      position: 'before_char',
      order: 10,
      probability: 100,
      enabled: true,
      matchMode: 'both',
    }],
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('lorebookDocumentStore', () => {
  it('读取 legacy 只做内存迁移，首次保存才写 canonical v2', () => {
    const file = tempFile()
    writeFileSync(file, JSON.stringify(legacy()), 'utf8')

    const document = readLorebookDocument(file)
    expect(document).toMatchObject({ schema: 'qingyu_lorebook', schemaVersion: 2, revision: 1 })
    expect(JSON.parse(readFileSync(file, 'utf8'))).not.toHaveProperty('schema')

    saveLorebookView(file, readLorebookView(file)!, 1_700_000_000_000)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({
      schema: 'qingyu_lorebook', schemaVersion: 2, revision: 1,
    })
  })

  it('模拟重启后读取 canonical 文件仍返回兼容 Lorebook 视图', () => {
    const file = tempFile()
    saveLorebookView(file, legacy(), 1_700_000_000_000)
    const first = readLorebookView(file)
    const second = readLorebookView(file)
    expect(second).toEqual(first)
    expect(second).toMatchObject({
      id: 'book-1', name: '测试世界书', scanDepth: 4,
      entries: [{ id: 'entry-1', keywords: ['王城'], position: 'before_char' }],
    })
  })

  it('再次保存递增 revision 并保留 createdAt', () => {
    const file = tempFile()
    const first = saveLorebookView(file, legacy(), 1000)
    const edited = { ...readLorebookView(file)!, name: '编辑后' }
    const second = saveLorebookView(file, edited, 2000)
    expect(first).toMatchObject({ revision: 1, createdAt: 1000, updatedAt: 1000 })
    expect(second).toMatchObject({ revision: 2, createdAt: 1000, updatedAt: 2000, name: '编辑后' })
  })

  it('通过 legacy view 保存时保留不可见的 canonical-only 字段', () => {
    const file = tempFile()
    const document = saveLorebookDocumentInput(file, {
      schema: 'qingyu_lorebook', schemaVersion: 2, id: 'book-1', revision: 3,
      name: '测试世界书', description: '', enabled: true,
      defaults: { scanDepth: 4, recursiveScanning: true },
      entries: [{
        id: 'entry-1', enabled: true, title: '来源标题', content: '王城是首都。',
        activation: {
          mode: 'conditional', budgetTier: 'protected', primaryKeys: ['王城'], secondaryKeys: [], aliases: ['首都'],
          keyLogic: 'all', caseSensitive: false, wholeWords: true,
          regex: { enabled: false, flags: 'i' }, retrieval: 'semanticRequired',
        },
        insertion: { kind: 'custom', source: 'vendor.test', value: { slot: 7 } },
        scheduling: {
          order: 10, probability: 100,
          recursion: { exclude: false, prevent: false, minDepth: 0 },
          groups: [
            { name: 'royal', weight: 100, prioritized: true },
            { name: 'capital', weight: 250, prioritized: false },
          ],
          groupScoring: false, ignoreBudget: false,
        },
        foreign: { 'vendor.test': { opaque: true } },
      }],
      foreign: { 'vendor.test': { bookFlag: 1 } },
      createdAt: 1000, updatedAt: 1000,
    }, 1000)
    expect(document.revision).toBe(3)

    const view = readLorebookView(file)!
    view.description = '用户编辑'
    const saved = saveLorebookView(file, view, 2000)
    expect(saved.foreign).toEqual({ 'vendor.test': { bookFlag: 1 } })
    expect(saved.entries[0]).toMatchObject({
      title: '来源标题', foreign: { 'vendor.test': { opaque: true } },
      activation: {
        mode: 'conditional', budgetTier: 'protected', aliases: ['首都'],
        primaryKeys: ['王城'], keyLogic: 'all', retrieval: 'semanticRequired',
      },
      insertion: { kind: 'custom', source: 'vendor.test', value: { slot: 7 } },
      scheduling: {
        groups: [
          { name: 'royal', weight: 100, prioritized: true },
          { name: 'capital', weight: 250, prioritized: false },
        ],
      },
    })
  })

  it('兼容 view 中的显式删除和位置修改会覆盖对应 canonical 字段', () => {
    const file = tempFile()
    saveLorebookDocumentInput(file, {
      schema: 'qingyu_lorebook', schemaVersion: 2, id: 'book-1', revision: 1,
      name: '测试世界书', description: '', enabled: true,
      defaults: { scanDepth: 4, recursiveScanning: true },
      entries: [{
        id: 'entry-1', enabled: true, content: '王城是首都。',
        activation: {
          mode: 'conditional', budgetTier: 'standard', primaryKeys: ['王城'], secondaryKeys: [], aliases: ['首都'],
          keyLogic: 'any', caseSensitive: false, wholeWords: true,
          regex: { enabled: false, flags: 'i' }, retrieval: 'semanticRequired',
        },
        insertion: { kind: 'outlet', name: 'knowledge' },
        scheduling: {
          order: 10, probability: 100,
          recursion: { exclude: false, prevent: false, minDepth: 0 },
          groups: [], groupScoring: false, ignoreBudget: false,
        },
      }],
      createdAt: 1000, updatedAt: 1000,
    }, 1000)

    const view = readLorebookView(file)!
    view.entries[0].keywords = ['王城']
    view.entries[0].position = 'before_char'
    view.entries[0].matchMode = 'keyword'
    const saved = saveLorebookView(file, view, 2000)
    expect(saved.entries[0].activation).toMatchObject({
      primaryKeys: ['王城'], aliases: [], retrieval: 'keyword',
    })
    expect(saved.entries[0].insertion).toEqual({ kind: 'prompt', anchor: 'before_character' })
  })
})
