/**
 * 桥接层二期单测：TTS 朗读预处理 + 正则管线（input/output）。
 */
import { describe, expect, it } from 'vitest'
import { preprocessForTts } from '../ttsHandler'
import { applyRegexRules, collectStopStrings, truncateAtStop } from '../../../src/utils/regex'
import type { RegexRule } from '../../../shared/types'

describe('TTS 朗读预处理（对齐渲染层 MessageActionBar）', () => {
  it('默认剥离 thought 块', () => {
    expect(preprocessForTts('<thought>内心想法</thought>你好世界', false)).toBe('你好世界')
  })

  it('开启朗读内心想法时仅去标签保留内容', () => {
    // 对齐渲染层 stripThoughtTags：去标签不插入换行
    expect(preprocessForTts('<thought>内心想法</thought>你好', true)).toBe('内心想法你好')
  })

  it('thinking 标签归一化为 thought 后处理', () => {
    expect(preprocessForTts('<thinking>内心</thinking>正文', false)).toBe('正文')
    expect(preprocessForTts('<thinking>内心</thinking>正文', true)).toContain('内心')
  })

  it('空内容返回空串', () => {
    expect(preprocessForTts('', false)).toBe('')
    expect(preprocessForTts('<thought>仅想法</thought>', false)).toBe('')
  })
})

describe('桥接层正则管线（对齐渲染层 sendMessage）', () => {
  const rules: RegexRule[] = [
    {
      id: 'r1',
      name: '输入替换',
      pattern: '废土',
      replacement: '末日',
      enabled: true,
      scope: 'input',
      stage: 'text',
    },
    {
      id: 'r2',
      name: '输出替换',
      pattern: '废土',
      replacement: '末日',
      enabled: true,
      scope: 'output',
      stage: 'text',
    },
    {
      id: 'r3',
      name: '输出停止',
      pattern: 'x',
      replacement: 'x',
      enabled: true,
      scope: 'output',
      stage: 'text',
      stopStrings: ['END'],
    },
  ]

  it('input 正则：用户消息替换后落盘', () => {
    const result = applyRegexRules('今天废土有沙尘暴', rules, 'input', 'text')
    expect(result.text).toBe('今天末日有沙尘暴')
  })

  it('output 正则：AI 输出变换', () => {
    const result = applyRegexRules('我们到了废土', rules, 'output', 'text')
    expect(result.text).toBe('我们到了末日')
  })

  it('停止字符串：output 命中后截断', () => {
    const stops = collectStopStrings(rules)
    const full = '前面的内容 END 后面的内容'
    const { text } = truncateAtStop(full, stops)
    expect(text).not.toContain('后面的内容')
  })
})
