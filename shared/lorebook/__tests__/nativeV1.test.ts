// @vitest-environment node
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  NATIVE_LOREBOOK_V1_SCHEMA_ID,
  assertNativeLorebookV1,
  validateNativeLorebookV1,
} from '../nativeV1'

const fixtureRoot = join(__dirname, '../../../tests/lorebook/fixtures/native-v1')

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(fixtureRoot, name), 'utf8'))
}

describe('QingYu native lorebook v1 schema baseline', () => {
  it('最小与全字段 fixture 通过校验', () => {
    for (const name of ['minimal.json', 'full.json']) {
      const result = validateNativeLorebookV1(fixture(name))
      expect(result, name).toMatchObject({ valid: true, issues: [] })
    }
  })

  it('未知字段允许存在，为后续迁移保留前向空间', () => {
    const result = validateNativeLorebookV1(fixture('unknown-extensions.json'))
    expect(result).toMatchObject({ valid: true, issues: [] })
  })

  it('无效 fixture 返回稳定的字段路径与错误类型', () => {
    const result = validateNativeLorebookV1(fixture('invalid.json'))
    expect(result.valid).toBe(false)
    if (result.valid) throw new Error('expected invalid fixture')
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '$.id', code: 'required' }),
      expect.objectContaining({ path: '$.scanDepth', code: 'range' }),
      expect.objectContaining({ path: '$.entries[0].id', code: 'type' }),
      expect.objectContaining({ path: '$.entries[0].keywords', code: 'type' }),
      expect.objectContaining({ path: '$.entries[0].position', code: 'enum' }),
      expect.objectContaining({ path: '$.entries[0].probability', code: 'range' }),
    ]))
  })

  it('assert helper 对无效输入抛出可读错误', () => {
    expect(() => assertNativeLorebookV1(fixture('invalid.json')))
      .toThrow(/\$\.id: 缺少必填字段 id/)
  })

  it('JSON Schema 文档与运行时校验器使用同一 schema id 和顶层必填字段', () => {
    const schemaPath = join(__dirname, '../schemas/native-v1.schema.json')
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as {
      $id: string
      required: string[]
      additionalProperties: boolean
    }
    expect(schema.$id).toBe(NATIVE_LOREBOOK_V1_SCHEMA_ID)
    expect(schema.required).toEqual(['id', 'name', 'description', 'entries', 'enabled', 'scanDepth'])
    expect(schema.additionalProperties).toBe(true)
  })
})

