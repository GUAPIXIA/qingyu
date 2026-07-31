import { describe, it, expect } from 'vitest'
import {
  safeRegExp,
  ruleMatchesScope,
  ruleMatchesStage,
  ruleTriggers,
  applyRuleOnce,
  applyRegexRules,
  findStopIndex,
  truncateAtStop,
  collectStopStrings,
} from '../regex'
import type { RegexRule } from '../../../shared/types'

function makeRule(overrides: Partial<RegexRule> = {}): RegexRule {
  return {
    id: 'r1',
    name: '测试规则',
    pattern: 'foo',
    replacement: 'bar',
    flags: 'g',
    enabled: true,
    scope: 'both',
    ...overrides,
  }
}

describe('safeRegExp', () => {
  it('合法正则创建成功', () => {
    expect(safeRegExp('a+b', 'gi')).toBeInstanceOf(RegExp)
  })

  it('非法正则返回 null', () => {
    expect(safeRegExp('(unclosed')).toBeNull()
  })

  it('超长模式返回 null（ReDoS 防护）', () => {
    expect(safeRegExp('a'.repeat(600))).toBeNull()
  })

  it('空模式返回 null', () => {
    expect(safeRegExp('')).toBeNull()
  })
})

describe('ruleMatchesScope', () => {
  it('both 同时匹配 input 和 output', () => {
    expect(ruleMatchesScope(makeRule({ scope: 'both' }), 'input')).toBe(true)
    expect(ruleMatchesScope(makeRule({ scope: 'both' }), 'output')).toBe(true)
  })

  it('指定 scope 只匹配对应方向', () => {
    expect(ruleMatchesScope(makeRule({ scope: 'input' }), 'input')).toBe(true)
    expect(ruleMatchesScope(makeRule({ scope: 'input' }), 'output')).toBe(false)
  })
})

describe('ruleMatchesStage', () => {
  it('text 规则在 text 阶段生效（input/output 均可）', () => {
    expect(ruleMatchesStage(makeRule({ stage: 'text' }), 'input', 'text')).toBe(true)
    expect(ruleMatchesStage(makeRule({ stage: 'text' }), 'output', 'text')).toBe(true)
  })

  it('markdown 规则仅 output 的 markdown 阶段生效', () => {
    expect(ruleMatchesStage(makeRule({ stage: 'markdown' }), 'output', 'markdown')).toBe(true)
    expect(ruleMatchesStage(makeRule({ stage: 'markdown' }), 'input', 'text')).toBe(false)
    expect(ruleMatchesStage(makeRule({ stage: 'markdown' }), 'output', 'text')).toBe(false)
    expect(ruleMatchesStage(makeRule({ stage: 'markdown' }), 'input', 'markdown')).toBe(false)
  })

  it('stage 缺省视为 text', () => {
    expect(ruleMatchesStage(makeRule({ stage: undefined }), 'output', 'text')).toBe(true)
    expect(ruleMatchesStage(makeRule({ stage: undefined }), 'output', 'markdown')).toBe(false)
  })
})

describe('ruleTriggers', () => {
  it('无触发器总是执行', () => {
    expect(ruleTriggers(makeRule(), '任意文本')).toBe(true)
  })

  it('匹配触发正则才执行', () => {
    const rule = makeRule({ triggerPattern: '\\*\\*', triggerFlags: 'i' })
    expect(ruleTriggers(rule, '这是 **粗体**')).toBe(true)
    expect(ruleTriggers(rule, '普通文本')).toBe(false)
  })

  it('非法触发正则不执行', () => {
    expect(ruleTriggers(makeRule({ triggerPattern: '(' }), '文本')).toBe(false)
  })
})

describe('applyRuleOnce', () => {
  it('执行替换', () => {
    const r = applyRuleOnce('foo foo', makeRule())
    expect(r.text).toBe('bar bar')
    expect(r.replaced).toBe(true)
  })

  it('未命中不替换', () => {
    const r = applyRuleOnce('nothing here', makeRule())
    expect(r.text).toBe('nothing here')
    expect(r.replaced).toBe(false)
  })

  it('触发器不满足时跳过', () => {
    const rule = makeRule({ triggerPattern: 'xyz' })
    expect(applyRuleOnce('foo', rule).replaced).toBe(false)
  })

  it('禁用规则跳过', () => {
    expect(applyRuleOnce('foo', makeRule({ enabled: false })).replaced).toBe(false)
  })

  it('非法模式跳过', () => {
    expect(applyRuleOnce('foo', makeRule({ pattern: '(' })).replaced).toBe(false)
  })

  it('支持 $1 捕获组替换', () => {
    const rule = makeRule({ pattern: '(foo) (bar)', replacement: '$2-$1' })
    expect(applyRuleOnce('foo bar', rule).text).toBe('bar-foo')
  })
})

describe('applyRegexRules', () => {
  it('按 scope 过滤规则', () => {
    const rules = [
      makeRule({ id: 'in', scope: 'input', pattern: 'a', replacement: 'A' }),
      makeRule({ id: 'out', scope: 'output', pattern: 'b', replacement: 'B' }),
    ]
    expect(applyRegexRules('ab', rules, 'input', 'text').text).toBe('Ab')
    expect(applyRegexRules('ab', rules, 'output', 'text').text).toBe('aB')
  })

  it('按阶段链式应用（text 后 markdown）', () => {
    const rules = [
      makeRule({ id: 't', stage: 'text', pattern: 'foo', replacement: '**粗**' }),
      makeRule({ id: 'm', stage: 'markdown', pattern: '\\*\\*', replacement: '__' }),
    ]
    // output：text 规则生成 **粗**，markdown 规则再转 __
    expect(applyRegexRules('foo', rules, 'output', 'text').text).toBe('**粗**')
    const afterMd = applyRegexRules('**粗**', rules, 'output', 'markdown')
    expect(afterMd.text).toBe('__粗__')
    // markdown 规则在 input 不生效
    expect(applyRegexRules('foo', rules, 'input', 'text').text).toBe('**粗**')
  })

  it('统计 applied 与 matched', () => {
    const rules = [
      makeRule({ id: 'a', pattern: 'x', replacement: 'y' }),
      makeRule({ id: 'b', pattern: 'zzz', replacement: 'q' }),
    ]
    const r = applyRegexRules('x x', rules, 'output', 'text')
    expect(r.applied).toBe(2)
    expect(r.matched).toBe(1)
    expect(r.text).toBe('y y')
  })

  it('空文本或空规则快速返回', () => {
    expect(applyRegexRules('', [makeRule()], 'output', 'text')).toEqual({ text: '', applied: 0, matched: 0 })
    expect(applyRegexRules('abc', [], 'output', 'text')).toEqual({ text: 'abc', applied: 0, matched: 0 })
  })
})

describe('findStopIndex / truncateAtStop', () => {
  it('找到第一个停止字符串位置', () => {
    expect(findStopIndex('hello 【END】 world', ['【END】', '<|endoftext|>'])).toBe(6)
    expect(findStopIndex('a<|endoftext|>b', ['【END】', '<|endoftext|>'])).toBe(1)
  })

  it('多个停止字符串取最早命中', () => {
    expect(findStopIndex('x<|endoftext|>y【END】z', ['【END】', '<|endoftext|>'])).toBe(1)
  })

  it('未命中返回 -1', () => {
    expect(findStopIndex('普通文本', ['【END】'])).toBe(-1)
    expect(findStopIndex('', ['a'])).toBe(-1)
    expect(findStopIndex('abc', [])).toBe(-1)
  })

  it('truncateAtStop 截断到停止位置并去尾空白', () => {
    const r = truncateAtStop('你好世界【END】剩余内容', ['【END】'])
    expect(r.stopped).toBe(true)
    expect(r.text).toBe('你好世界')
  })

  it('未命中原样返回', () => {
    const r = truncateAtStop('正常输出', ['【END】'])
    expect(r.stopped).toBe(false)
    expect(r.text).toBe('正常输出')
  })
})

describe('collectStopStrings', () => {
  it('收集启用 output 规则的停止字符串（去空去重）', () => {
    const rules = [
      makeRule({ id: 'a', scope: 'output', stopStrings: ['【END】', '<end>'] }),
      makeRule({ id: 'b', scope: 'both', stopStrings: ['【END】'] }),
      makeRule({ id: 'c', scope: 'input', stopStrings: ['xxx'] }),
      makeRule({ id: 'd', scope: 'output', stopStrings: ['', '  '] }),
      makeRule({ id: 'e', scope: 'output', enabled: false, stopStrings: ['disabled'] }),
    ]
    expect(collectStopStrings(rules)).toEqual(['【END】', '<end>'])
  })

  it('markdown 阶段规则不参与流式停止', () => {
    const rules = [makeRule({ id: 'a', scope: 'output', stage: 'markdown', stopStrings: ['x'] })]
    expect(collectStopStrings(rules)).toEqual([])
  })
})
