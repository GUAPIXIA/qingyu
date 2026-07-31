import { describe, it, expect } from 'vitest'
import { parseMemoryResult, formatMemoryFacts, fitMemoryBudget, MAX_MEMORY_FACTS } from '../memory'

/** 模拟启发式估算：每字符约 0.3 token（中文更密） */
function mockEstimate(text: string): number {
  const cjk = (text.match(/[\u4e00-\u9fff]/g) ?? []).length
  return Math.ceil(cjk * 0.9 + (text.length - cjk) * 0.3)
}

describe('parseMemoryResult', () => {
  it('解析标准格式（摘要 + 事实）', () => {
    const text = `【摘要】
两人在森林中相遇，约定一起寻找失踪的妹妹。

【事实】
1. 主角的妹妹叫小美
2. 约定在月落镇集合
3. 蓝宝石是开启密室的钥匙`
    const parsed = parseMemoryResult(text)
    expect(parsed.summary).toContain('森林')
    expect(parsed.facts).toEqual(['主角的妹妹叫小美', '约定在月落镇集合', '蓝宝石是开启密室的钥匙'])
  })

  it('剥离 <thought> 思考标签', () => {
    const text = `<thought>让我想想</thought>
【摘要】
主角受伤了。
【事实】
1. 主角左臂骨折`
    const parsed = parseMemoryResult(text)
    expect(parsed.summary).not.toContain('thought')
    expect(parsed.summary).toContain('受伤')
    expect(parsed.facts).toEqual(['主角左臂骨折'])
  })

  it('事实支持不同编号格式（中文数字、无编号、-）', () => {
    const text = `【摘要】
测试。
【事实】
一、中文数字事实
- 横线事实
直接无编号的事实`
    const parsed = parseMemoryResult(text)
    expect(parsed.facts).toEqual(['中文数字事实', '横线事实', '直接无编号的事实'])
  })

  it('无【摘要】标记时兜底使用全文（去掉事实部分）', () => {
    const text = `今天天气很好。
【事实】
1. 天是蓝的`
    const parsed = parseMemoryResult(text)
    expect(parsed.summary).toBe('今天天气很好。')
    expect(parsed.facts).toEqual(['天是蓝的'])
  })

  it('无【事实】部分时事实为空', () => {
    const parsed = parseMemoryResult('【摘要】\n只有摘要')
    expect(parsed.summary).toBe('只有摘要')
    expect(parsed.facts).toEqual([])
  })

  it('完全无结构文本作为摘要返回', () => {
    const parsed = parseMemoryResult('一句话总结')
    expect(parsed.summary).toBe('一句话总结')
    expect(parsed.facts).toEqual([])
  })

  it('空文本返回空结果', () => {
    expect(parseMemoryResult('')).toEqual({ summary: '', facts: [] })
    expect(parseMemoryResult('  ')).toEqual({ summary: '', facts: [] })
  })

  it('事实超过上限时截断', () => {
    const facts = Array.from({ length: 50 }, (_, i) => `事实${i + 1}`)
    const text = `【摘要】\n摘要\n【事实】\n${facts.map((f, i) => `${i + 1}. ${f}`).join('\n')}`
    const parsed = parseMemoryResult(text)
    expect(parsed.facts.length).toBe(MAX_MEMORY_FACTS)
  })
})

describe('formatMemoryFacts', () => {
  it('格式化事实列表为编号文本', () => {
    expect(formatMemoryFacts(['甲', '乙'])).toBe('1. 甲\n2. 乙')
  })

  it('空列表返回空字符串', () => {
    expect(formatMemoryFacts([])).toBe('')
    expect(formatMemoryFacts(undefined)).toBe('')
    expect(formatMemoryFacts(null)).toBe('')
  })
})

describe('fitMemoryBudget', () => {
  it('预算充足时保留全部内容', () => {
    const r = fitMemoryBudget('简短摘要', ['事实A', '事实B'], 1000, mockEstimate)
    expect(r.summary).toBe('简短摘要')
    expect(r.facts).toEqual(['事实A', '事实B'])
  })

  it('预算紧张时按序丢弃超预算事实', () => {
    // 预算 100：摘要 '摘' ≈ 1 token，剩余 99；事实1 约 91 token 保留，剩余 8；事实2 超限被丢弃
    const r = fitMemoryBudget('摘', ['甲'.repeat(100), '乙'.repeat(50)], 100, mockEstimate)
    expect(r.summary).toBe('摘')
    expect(r.facts).toEqual(['甲'.repeat(100)])
  })

  it('摘要超预算时从尾部截断', () => {
    const longSummary = '甲'.repeat(200) // 约 180 token
    const r = fitMemoryBudget(longSummary, [], 100, mockEstimate)
    expect(r.summary.length).toBeLessThan(200)
    expect(mockEstimate(r.summary)).toBeLessThanOrEqual(70) // 60% 预算 + 截断余量
  })

  it('空摘要和空事实返回空', () => {
    const r = fitMemoryBudget('', [], 100, mockEstimate)
    expect(r.summary).toBe('')
    expect(r.facts).toEqual([])
  })

  it('事实按序 break：首条超限则停止（不跳过后面的短事实）', () => {
    // 预算 60：摘要 1 token，剩余 59；事实1 约 91 token 超限 → 直接 break，后面的短事实也不保留
    const r = fitMemoryBudget('摘', ['甲'.repeat(100), '短事实'], 60, mockEstimate)
    expect(r.facts).toEqual([])
  })
})
