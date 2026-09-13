import { describe, expect, it } from 'vitest'
import { splitMentionSegments } from '../mentionHighlight'

describe('splitMentionSegments @提及纯文本分段（S7）', () => {
  it('切出提及片段与普通片段', () => {
    expect(splitMentionSegments('“@爱丽丝 你也来。”', ['爱丽丝'])).toEqual([
      { text: '“', mention: false },
      { text: '@爱丽丝', mention: true },
      { text: ' 你也来。”', mention: false },
    ])
  })

  it('无匹配时返回单一片段（保持原文不变）', () => {
    expect(splitMentionSegments('普通文本', ['爱丽丝'])).toEqual([{ text: '普通文本', mention: false }])
    expect(splitMentionSegments('@不存在', ['爱丽丝'])).toEqual([{ text: '@不存在', mention: false }])
  })

  it('名称按长度降序匹配，避免短名抢占', () => {
    const segments = splitMentionSegments('@千夏 和 @千', ['千', '千夏'])
    expect(segments.filter((s) => s.mention).map((s) => s.text)).toEqual(['@千夏', '@千'])
  })

  it('名称中的正则特殊字符按字面量处理', () => {
    expect(splitMentionSegments('@A+B 你好', ['A+B'])).toEqual([
      { text: '@A+B', mention: true },
      { text: ' 你好', mention: false },
    ])
  })

  it('多个提及与空输入', () => {
    expect(splitMentionSegments('@甲 @乙', ['甲', '乙']).filter((s) => s.mention)).toHaveLength(2)
    expect(splitMentionSegments('', ['甲'])).toEqual([])
    expect(splitMentionSegments('甲', [])).toEqual([{ text: '甲', mention: false }])
  })
})
