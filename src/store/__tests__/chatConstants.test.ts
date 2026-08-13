import { describe, it, expect } from 'vitest'
import { translationMaxTokens } from '../chatConstants'

describe('translationMaxTokens', () => {
  it('短文本取 2048 下限（普通模型均支持，避免固定大值超限）', () => {
    expect(translationMaxTokens('Hello')).toBe(2048)
    expect(translationMaxTokens('你好')).toBe(2048)
    expect(translationMaxTokens('')).toBe(2048)
    // 1000 字符 → 1500 估算 → 低于下限 2048
    expect(translationMaxTokens('a'.repeat(1000))).toBe(2048)
  })

  it('中等文本按输入长度自适应增长', () => {
    // 2000 字符 → 3000 估算
    expect(translationMaxTokens('a'.repeat(2000))).toBe(3000)
    // 3000 字符 → 4500 估算
    expect(translationMaxTokens('a'.repeat(3000))).toBe(4500)
  })

  it('超长文本封顶 8192（为推理模型思考+正文留空间，但不无限放大）', () => {
    expect(translationMaxTokens('a'.repeat(6000))).toBe(8192)
    expect(translationMaxTokens('a'.repeat(50000))).toBe(8192)
  })
})
