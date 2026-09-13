import { describe, it, expect } from 'vitest'
import { analyzeTextClosure, countVisibleCharacters, isCompleteSentence, tailSample, trimToSentenceBoundary } from '../textMetrics'

describe('textMetrics', () => {
  describe('countVisibleCharacters', () => {
    it('忽略空白并按码点计数', () => {
      expect(countVisibleCharacters('你好 世界')).toBe(4)
      expect(countVisibleCharacters(' a\nb\tc ')).toBe(3)
      expect(countVisibleCharacters('')).toBe(0)
    })

    it('emoji 与代理对按单个字符计', () => {
      expect(countVisibleCharacters('🙂🙂')).toBe(2)
    })
  })

  describe('isCompleteSentence', () => {
    it('句末标点收尾视为完整', () => {
      expect(isCompleteSentence('港口已经封锁。')).toBe(true)
      expect(isCompleteSentence('你要走了吗？')).toBe(true)
      expect(isCompleteSentence('别动！')).toBe(true)
      expect(isCompleteSentence('然后呢…')).toBe(true)
    })

    it('剥离结尾引号与括号后再判定', () => {
      expect(isCompleteSentence('她说：“走吧。”')).toBe(true)
      expect(isCompleteSentence('（他离开了。）')).toBe(true)
      expect(isCompleteSentence('“真的吗？”')).toBe(true)
    })

    it('悬空结尾一律判为不完整（识别截断）', () => {
      expect(isCompleteSentence('他推开门，')).toBe(false)
      expect(isCompleteSentence('她转身走向')).toBe(false)
      expect(isCompleteSentence('因为')).toBe(false)
      expect(isCompleteSentence('“你还没说完')).toBe(false)
      expect(isCompleteSentence('')).toBe(false)
    })
  })

  describe('trimToSentenceBoundary', () => {
    it('在可见字符上限内收束到最后一个完整句', () => {
      const text = '第一句话在这里结束。第二句话稍微长一些也结束了。第三句还没写完'
      const trimmed = trimToSentenceBoundary(text, { minChars: 5, maxChars: 30 })
      expect(trimmed).toBe('第一句话在这里结束。第二句话稍微长一些也结束了。')
    })

    it('收束结果低于下限时返回 undefined（交由压缩修复）', () => {
      const text = '短句。后面这段非常长而且没有句号收尾'
      expect(trimToSentenceBoundary(text, { minChars: 20, maxChars: 40 })).toBeUndefined()
    })

    it('没有句边界时返回 undefined', () => {
      expect(trimToSentenceBoundary('完全没有标点的一段话', { minChars: 1, maxChars: 50 })).toBeUndefined()
    })

    it('忽略空白后仍在区间内即可接受', () => {
      // 每句「X。」为 2 个可见字符：上限 11 字时最多容纳 5 句
      const text = '甲。乙。丙。丁。戊。己。庚。辛。'
      const trimmed = trimToSentenceBoundary(text, { minChars: 3, maxChars: 11 })
      expect(trimmed).toBe('甲。乙。丙。丁。戊。')
      expect(countVisibleCharacters(trimmed!)).toBe(10)
    })
  })

  describe('analyzeTextClosure（阶段0未闭合格式率口径）', () => {
    it('完整正文通过', () => {
      const text = '她推开门。*环视四周*\n\n“谁在那？”'
      expect(analyzeTextClosure(text)).toMatchObject({
        balancedQuotes: true,
        balancedAsterisks: true,
        closedThought: true,
        unclosed: false,
      })
    })

    it('未闭合中文引号判为不闭合', () => {
      const d = analyzeTextClosure('她说：“你还没说完')
      expect(d.balancedQuotes).toBe(false)
      expect(d.unclosed).toBe(true)
    })

    it('悬空单个星号判为不闭合', () => {
      expect(analyzeTextClosure('她推开门，*动作只写了一半').balancedAsterisks).toBe(false)
    })

    it('未闭合 <thought> 判为不闭合；完整 thought 通过', () => {
      expect(analyzeTextClosure('<thought>心理活动没闭合').closedThought).toBe(false)
      expect(analyzeTextClosure('<thought>已闭合。</thought>\n\n正文继续。').closedThought).toBe(true)
    })

    it('空文本视为全部闭合', () => {
      expect(analyzeTextClosure('').unclosed).toBe(false)
    })
  })

  describe('tailSample', () => {
    it('压缩空白并截取尾部（按码点）', () => {
      expect(tailSample('你好  世界')).toBe('你好 世界')
      expect(tailSample('一'.repeat(100), 10)).toBe('一'.repeat(10))
      expect(tailSample('')).toBe('')
    })
  })
})
