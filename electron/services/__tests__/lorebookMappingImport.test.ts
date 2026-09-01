// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { guessMappingTemplate, isMappingTemplate, resolveMappingPath } from '../../../shared/lorebook/adapters/mapping'
import { importLorebookWithMappingTemplate } from '../lorebookAdapters/mappingImport'
import type { LorebookMappingTemplate } from '../../../shared/lorebook/adapters/mapping'

const template: LorebookMappingTemplate = {
  id: 't1',
  name: '测试模板',
  createdAt: 1,
  updatedAt: 1,
  entriesPath: 'data.book.entries',
  namePath: 'data.book.title',
  fields: { keys: 'key', content: 'entry', title: 'name', enabled: 'on', constant: 'always' },
}

describe('映射向导模板', () => {
  it('guessMappingTemplate 从常见形状猜出条目容器与关键字段', () => {
    const guessed = guessMappingTemplate({
      data: { book: { entries: [{ key: ['a'], entry: '内容', name: '标题' }] } },
    }, '猜测')
    expect(guessed).toMatchObject({ entriesPath: 'data.book.entries', fields: { keys: 'key', content: 'entry', title: 'name' } })
    expect(guessMappingTemplate({ unrelated: true })).toBeNull()
  })

  it('resolveMappingPath 支持点分路径并拒绝危险键', () => {
    expect(resolveMappingPath({ a: { b: [1, 2] } }, 'a.b.1')).toBe(2)
    expect(resolveMappingPath({ a: {} }, '__proto__.x')).toBeUndefined()
    expect(resolveMappingPath({ a: 1 }, '')).toEqual({ a: 1 })
  })

  it('isMappingTemplate 校验必填路径', () => {
    expect(isMappingTemplate(template)).toBe(true)
    expect(isMappingTemplate({ ...template, fields: { ...template.fields, content: '' } })).toBe(false)
  })

  it('按模板搬运字段并保留未映射字段', () => {
    const raw = {
      data: {
        book: {
          title: 'fork 世界书',
          entries: [
            { key: '星陨峡谷', entry: '峡谷正文', name: '峡谷', on: true, always: false, customField: { deep: 1 } },
            { key: '常驻', entry: '常驻正文', name: '常驻', on: true, always: true },
          ],
        },
      },
    }
    const result = importLorebookWithMappingTemplate(raw, template, {
      id: 'mapped-1', fallbackName: 'fallback', now: 1_700_000_000_000, contentHash: 'hash',
    })
    expect(result.summary.rejected).toBe(0)
    expect(result.document).toMatchObject({
      name: 'fork 世界书',
      source: { adapterId: 'mapping.t1' },
    })
    const [first, second] = result.document.entries
    expect(first).toMatchObject({
      title: '峡谷',
      content: '峡谷正文',
      enabled: true,
      activation: { primaryKeys: ['星陨峡谷'], mode: 'conditional' },
    })
    // 未映射字段保留在 mapping 命名空间
    expect(first.foreign?.['qingyu.mapping']).toEqual({ source: { customField: { deep: 1 } } })
    expect(second.activation.mode).toBe('constant')
    expect(second.foreign?.['qingyu.mapping']).toBeUndefined()
  })

  it('条目路径不是数组或包含非对象时生成拒绝报告', () => {
    const notArray = importLorebookWithMappingTemplate({ data: {} }, template, { fallbackName: 'f' })
    expect(notArray.summary.rejected).toBeGreaterThan(0)
    expect(notArray.document.entries).toHaveLength(0)

    const invalid = importLorebookWithMappingTemplate(
      { data: { book: { entries: [{ key: 'a', entry: 'x' }, 42] } } },
      template,
      { fallbackName: 'f' },
    )
    expect(invalid.summary.rejected).toBeGreaterThan(0)
    expect(invalid.issues.some((item) => item.code === 'mapping_invalid_entries')).toBe(true)
  })

  it('模板缺失字段按 warning 计入 dropped，不阻断导入', () => {
    const result = importLorebookWithMappingTemplate(
      { data: { book: { title: '书', entries: [{ key: 'a', entry: 'x' }] } } },
      template,
      { fallbackName: 'f' },
    )
    expect(result.summary.dropped).toBeGreaterThan(0)
    expect(result.document.entries).toHaveLength(1)
  })
})
