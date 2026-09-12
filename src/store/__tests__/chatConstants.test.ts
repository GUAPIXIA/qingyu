import { describe, expect, it } from 'vitest'
import { DEFAULT_LOREBOOK_SCAN_DEPTH, resolveLorebookScanDepth, translationMaxTokens } from '../chatConstants'

describe('resolveLorebookScanDepth', () => {
  it('显式配置允许低于默认扫描深度', () => {
    expect(resolveLorebookScanDepth([2, 4])).toBe(4)
  })

  it('显式 0 表示初始轮不扫描聊天消息', () => {
    expect(resolveLorebookScanDepth([undefined, 0, Number.NaN])).toBe(0)
  })

  it('完全没有有效配置时回退默认值', () => {
    expect(resolveLorebookScanDepth([undefined, Number.NaN])).toBe(DEFAULT_LOREBOOK_SCAN_DEPTH)
  })
})

describe('translationMaxTokens', () => {
  it('DeepSeek V4 短文本也保留足够空间给正文', () => {
    expect(translationMaxTokens('Hello world', 'deepseek-v4.1-flash')).toBeGreaterThanOrEqual(4096)
  })

  it('普通模型继续使用较小的短文本预算', () => {
    expect(translationMaxTokens('Hello world', 'gpt-4o')).toBe(2048)
  })
})
