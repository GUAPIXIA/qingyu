/**
 * 角色卡 schema 校验单元测试
 */
import { describe, expect, it } from 'vitest'
import { validateCharacterCard, formatValidationErrors } from '../charCardValidator'

describe('validateCharacterCard', () => {
  it('accepts a valid V2 card', () => {
    const result = validateCharacterCard({
      spec: { spec_version: '2.0', name: '测试角色', description: '描述', first_mes: '你好' },
    })
    expect(result.ok).toBe(true)
    expect(result.format).toBe('v2')
    expect(result.errors).toHaveLength(0)
  })

  it('accepts a valid V3 card', () => {
    const result = validateCharacterCard({
      spec: { spec_version: '3.0' },
      data: { name: '角色三', description: '描述', first_mes: '嗨' },
    })
    expect(result.ok).toBe(true)
    expect(result.format).toBe('v3')
  })

  it('accepts a bare card with top-level fields', () => {
    const result = validateCharacterCard({
      name: '裸卡', description: '描述', firstMessage: '你好',
    })
    expect(result.ok).toBe(true)
    expect(result.format).toBe('bare')
  })

  it('rejects card without name', () => {
    const result = validateCharacterCard({ spec: { spec_version: '2.0', description: 'x' } })
    expect(result.ok).toBe(false)
    expect(result.errors.join()).toContain('角色名')
  })

  it('rejects non-object card', () => {
    expect(validateCharacterCard('not-a-card').ok).toBe(false)
    expect(validateCharacterCard(null).ok).toBe(false)
    expect(validateCharacterCard([1, 2]).ok).toBe(false)
  })

  it('rejects wrong-type name', () => {
    const result = validateCharacterCard({ name: 123 })
    expect(result.ok).toBe(false)
    expect(result.errors.join()).toContain('字符串')
  })

  it('rejects wrong-type description', () => {
    const result = validateCharacterCard({ name: 'x', description: ['array'] })
    expect(result.ok).toBe(false)
  })

  it('warns but accepts empty description', () => {
    const result = validateCharacterCard({ name: 'x' })
    expect(result.ok).toBe(true)
    expect(result.warnings.length).toBeGreaterThan(0)
  })

  it('rejects V3 card missing data', () => {
    const result = validateCharacterCard({ spec: { spec_version: '3.0' } })
    expect(result.ok).toBe(false)
    expect(result.errors.join()).toContain('data')
  })

  it('flags unknown format', () => {
    const result = validateCharacterCard({ foo: 'bar' })
    expect(result.ok).toBe(false)
    expect(result.format).toBe('unknown')
  })

  it('formats errors as readable text', () => {
    const result = validateCharacterCard({ foo: 'bar' })
    const text = formatValidationErrors(result)
    expect(text).toContain('角色卡')
  })
})
