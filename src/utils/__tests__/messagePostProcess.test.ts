import { describe, it, expect } from 'vitest'
import {
  extractThought,
  stripThought,
  stripThoughtTags,
  mergeConsecutiveMessages,
  stripVendorThinking,
  normalizeRoleplayDialoguePrefixes,
  trimContinuationOverlap,
  trimContinuationSeam,
} from '../messagePostProcess'

describe('extractThought', () => {
  it('removes vendor <thinking> blocks instead of exposing them as role thoughts', () => {
    const result = extractThought('<thinking>about it</thinking>The answer is 42')
    expect(result.thought).toBeNull()
    expect(result.content).toBe('The answer is 42')
    expect(result.isFallback).toBe(false)
  })

  it('extracts content from <thought>...</thought> tags (native tag)', () => {
    const result = extractThought('<thought>my thought</thought>The answer is 42')
    expect(result.thought).toBe('my thought')
    expect(result.content).toBe('The answer is 42')
    expect(result.isFallback).toBe(false)
  })

  it('returns null thought when no tags present', () => {
    const result = extractThought('Just regular content with no tags')
    expect(result.thought).toBeNull()
    expect(result.content).toBe('Just regular content with no tags')
    expect(result.isFallback).toBe(false)
  })

  it('discards <thinking>...</thinking> provider reasoning', () => {
    const result = extractThought('<thinking>deep reasoning here</thinking>Final answer')
    expect(result.thought).toBeNull()
    expect(result.content).toBe('Final answer')
    expect(result.isFallback).toBe(false)
  })

  it('handles multiple thought blocks', () => {
    const result = extractThought('<thought>part1</thought>middle<thought>part2</thought>end')
    expect(result.thought).toBe('part1\n\npart2')
    expect(result.content).toBe('middleend')
    expect(result.isFallback).toBe(false)
  })

  it('discards multiple <thinking> blocks', () => {
    const result = extractThought('<thinking>step1</thinking>text<thinking>step2</thinking>more')
    expect(result.thought).toBeNull()
    expect(result.content).toBe('textmore')
    expect(result.isFallback).toBe(false)
  })

  it('treats text before an orphan closing tag as thought content', () => {
    const result = extractThought('先分析上下文\n</thought>\n最终回复')
    expect(result.thought).toBe('先分析上下文')
    expect(result.content).toBe('最终回复')
    expect(result.content).not.toContain('</thought>')
    expect(result.isFallback).toBe(false)
  })

  it('collects reasoning leaked before an extra closing tag', () => {
    const result = extractThought('<thought>第一段推理</thought>继续推理</thought>正文')
    expect(result.thought).toBe('第一段推理\n\n继续推理')
    expect(result.content).toBe('正文')
  })

  it('handles an unclosed thought block', () => {
    const result = extractThought('正文前缀<thought>尚未闭合的推理')
    expect(result.thought).toBe('尚未闭合的推理')
    expect(result.content).toBe('正文前缀')
  })

  it('handles escaped and whitespace-padded thought tags', () => {
    const result = extractThought('隐藏推理\\</ thought >可见正文')
    expect(result.thought).toBe('隐藏推理')
    expect(result.content).toBe('可见正文')
  })

  it('handles thought tags with attributes', () => {
    const result = extractThought('<thought class="character-inner">我不能让他发现。</thought>答案')
    expect(result.thought).toBe('我不能让他发现。')
    expect(result.content).toBe('答案')
  })

  it('trims whitespace around thought content', () => {
    const result = extractThought('<thought>  spaced thought  </thought>content')
    expect(result.thought).toBe('spaced thought')
  })

  it('is case-insensitive for thought tags', () => {
    const result = extractThought('<THOUGHT>upper case</THOUGHT>content')
    expect(result.thought).toBe('upper case')
  })

  it('returns isFallback=true when content is empty after stripping thought', () => {
    const result = extractThought('<thought>only thinking here</thought>')
    expect(result.thought).toBe('only thinking here')
    expect(result.isFallback).toBe(true)
    // content falls back to the thought text
    expect(result.content).toBe('only thinking here')
  })

  it('returns empty content and null thought for empty string', () => {
    const result = extractThought('')
    expect(result.thought).toBeNull()
    expect(result.content).toBe('')
    expect(result.isFallback).toBe(false)
  })
})

describe('stripThoughtTags', () => {
  it('keeps thought content but removes tags', () => {
    expect(stripThoughtTags('<thought>thinking</thought>result')).toBe('thinkingresult')
  })

  it('does not read vendor <thinking> content aloud', () => {
    expect(stripThoughtTags('<thinking>deep</thinking>answer')).toBe('answer')
  })

  it('keeps plain text unchanged', () => {
    expect(stripThoughtTags('no thoughts here')).toBe('no thoughts here')
  })

  it('keeps content of multiple thought blocks', () => {
    expect(stripThoughtTags('<thought>a</thought>mid<thought>b</thought>end')).toBe('amidbend')
  })

  it('returns empty string for empty input', () => {
    expect(stripThoughtTags('')).toBe('')
  })

  it('handles case-insensitive tags', () => {
    expect(stripThoughtTags('<THOUGHT>upper</THOUGHT>content')).toBe('uppercontent')
  })

  it('removes malformed tag variants while preserving their text', () => {
    expect(stripThoughtTags('thinking\\</ thought >answer')).toBe('thinkinganswer')
  })
})

describe('stripThought', () => {
  it('removes thought tags from content', () => {
    const result = stripThought('<thought>thinking</thought>result')
    expect(result).toBe('result')
  })

  it('removes <thinking> tags from content', () => {
    const result = stripThought('<thinking>deep</thinking>answer')
    expect(result).toBe('answer')
  })

  it('returns original content when no tags', () => {
    const result = stripThought('no thoughts here')
    expect(result).toBe('no thoughts here')
  })

  it('removes multiple thought blocks', () => {
    const result = stripThought('<thought>a</thought>mid<thought>b</thought>end')
    expect(result).toBe('midend')
  })

  it('returns empty string when content is only thought tags', () => {
    const result = stripThought('<thought>only thought</thought>')
    expect(result).toBe('')
  })

  it('handles empty string input', () => {
    const result = stripThought('')
    expect(result).toBe('')
  })

  it('is case-insensitive', () => {
    const result = stripThought('<THOUGHT>upper</THOUGHT>content')
    expect(result).toBe('content')
  })

  it('removes thought content separated by an orphan closing tag', () => {
    expect(stripThought('hidden</thought>visible')).toBe('visible')
  })

  it('removes an unclosed thought block', () => {
    expect(stripThought('visible<thought>hidden')).toBe('visible')
  })
})

describe('stripVendorThinking', () => {
  it('removes <thinking> and <think> blocks', () => {
    expect(stripVendorThinking('<thinking>plan</thinking>answer<think>more planning</think>')).toBe('answer')
  })

  it('removes unclosed vendor thinking blocks', () => {
    expect(stripVendorThinking('answer<thinking class="x">unfinished')).toBe('answer')
  })

  it('leaves <thought> tags unchanged', () => {
    expect(stripVendorThinking('<thought>content</thought>')).toBe(
      '<thought>content</thought>',
    )
  })

  it('handles empty/falsy input', () => {
    expect(stripVendorThinking('')).toBe('')
  })
})

describe('normalizeRoleplayDialoguePrefixes', () => {
  it('代入模式只给独占一行的裸对白补角色名前缀', () => {
    const input = '<thought>“这里是内心引用。”</thought>\n\n*她收起断刃。*\n\n“你终于来了。”\n\n角色：“已有前缀。”'
    expect(normalizeRoleplayDialoguePrefixes(input, '角色', 'immersive')).toBe(
      '<thought>“这里是内心引用。”</thought>\n\n*她收起断刃。*\n\n角色：“你终于来了。”\n\n角色：“已有前缀。”',
    )
  })

  it('全局叙事不自动猜测裸对白的说话人', () => {
    const input = '“谁在那里？”\n\n远处没有回应。'
    expect(normalizeRoleplayDialoguePrefixes(input, '角色', 'omniscient')).toBe(input)
  })

  it('混合叙述或动作星号里的引号保持原样', () => {
    const input = '她只说了“等等”两个字。\n\n*“别动。”她按住门。*'
    expect(normalizeRoleplayDialoguePrefixes(input, '角色', 'immersive')).toBe(input)
  })

  it('R4：行内已含角色名的引号行不重复补前缀', () => {
    const input = '“我没应。”苏晚顿了顿，“喊了两声就没了。”'
    expect(normalizeRoleplayDialoguePrefixes(input, '苏晚', 'immersive')).toBe(input)
  })

  it('R4：不含角色名的裸对白仍补前缀', () => {
    expect(normalizeRoleplayDialoguePrefixes('“说。鞘哪来的。”', '林砚', 'immersive'))
      .toBe('林砚：“说。鞘哪来的。”')
  })

  it('R4：单字角色名按子串匹配跳过，行为固化', () => {
    const input = '“夜晚真安静。”'
    expect(normalizeRoleplayDialoguePrefixes(input, '晚', 'immersive')).toBe(input)
  })
})

describe('mergeConsecutiveMessages', () => {
  it('merges consecutive messages with the same role', () => {
    const input = [
      { role: 'user' as const, content: 'Hello' },
      { role: 'user' as const, content: 'World' },
    ]
    const result = mergeConsecutiveMessages(input)
    expect(result).toHaveLength(1)
    expect(result[0].role).toBe('user')
    expect(result[0].content).toBe('Hello\n\nWorld')
  })

  it('preserves order of different-role messages', () => {
    const input = [
      { role: 'user' as const, content: 'a' },
      { role: 'assistant' as const, content: 'b' },
      { role: 'user' as const, content: 'c' },
    ]
    const result = mergeConsecutiveMessages(input)
    expect(result).toHaveLength(3)
    expect(result[0].role).toBe('user')
    expect(result[0].content).toBe('a')
    expect(result[1].role).toBe('assistant')
    expect(result[1].content).toBe('b')
    expect(result[2].role).toBe('user')
    expect(result[2].content).toBe('c')
  })

  it('merges multiple consecutive same-role messages into one', () => {
    const input = [
      { role: 'user' as const, content: 'a' },
      { role: 'user' as const, content: 'b' },
      { role: 'user' as const, content: 'c' },
    ]
    const result = mergeConsecutiveMessages(input)
    expect(result).toHaveLength(1)
    expect(result[0].content).toBe('a\n\nb\n\nc')
  })

  it('merges consecutive assistant messages', () => {
    const input = [
      { role: 'assistant' as const, content: 'part1' },
      { role: 'assistant' as const, content: 'part2' },
    ]
    const result = mergeConsecutiveMessages(input)
    expect(result).toHaveLength(1)
    expect(result[0].content).toBe('part1\n\npart2')
  })

  it('merges system message into preceding user/assistant message', () => {
    const input = [
      { role: 'user' as const, content: 'question' },
      { role: 'system' as const, content: 'note' },
    ]
    const result = mergeConsecutiveMessages(input)
    expect(result).toHaveLength(1)
    expect(result[0].role).toBe('user')
    expect(result[0].content).toBe('question\n\nnote')
  })

  it('does not mutate the original input array', () => {
    const input = [
      { role: 'user' as const, content: 'a' },
      { role: 'user' as const, content: 'b' },
    ]
    const originalContent = input[0].content
    mergeConsecutiveMessages(input)
    expect(input[0].content).toBe(originalContent)
  })

  it('returns empty array for empty input', () => {
    expect(mergeConsecutiveMessages([])).toEqual([])
  })

  it('returns empty array for null/undefined input', () => {
    expect(mergeConsecutiveMessages(null as any)).toEqual([])
    expect(mergeConsecutiveMessages(undefined as any)).toEqual([])
  })

  it('handles a single message', () => {
    const input = [{ role: 'user' as const, content: 'only one' }]
    const result = mergeConsecutiveMessages(input)
    expect(result).toHaveLength(1)
    expect(result[0].content).toBe('only one')
  })

  it('preserves extra properties on messages', () => {
    const input = [
      { role: 'user' as const, content: 'a', id: 'msg1' },
      { role: 'user' as const, content: 'b', id: 'msg2' },
    ]
    const result = mergeConsecutiveMessages(input)
    expect(result).toHaveLength(1)
    // The first message's extra properties are preserved (shallow copy via spread)
    expect(result[0].id).toBe('msg1')
  })

  it('handles alternating user/assistant with system interleaved', () => {
    const input = [
      { role: 'system' as const, content: 'sys1' },
      { role: 'user' as const, content: 'u1' },
      { role: 'system' as const, content: 'sys2' },
      { role: 'assistant' as const, content: 'a1' },
      { role: 'system' as const, content: 'sys3' },
    ]
    const result = mergeConsecutiveMessages(input)
    // sys1 is first (no preceding message, stays its own entry),
    // u1 is a new role after system (new entry),
    // sys2 merges into preceding u1,
    // a1 is a new role (new entry),
    // sys3 merges into preceding a1.
    expect(result).toHaveLength(3)
    expect(result[0].role).toBe('system')
    expect(result[0].content).toBe('sys1')
    expect(result[1].role).toBe('user')
    expect(result[1].content).toBe('u1\n\nsys2')
    expect(result[2].role).toBe('assistant')
    expect(result[2].content).toBe('a1\n\nsys3')
  })
})

describe('trimContinuationOverlap', () => {
  it('trims overlapping prefix when model repeats the ending (>= 8 chars)', () => {
    const prev = '她握紧了剑柄，转身望向黑暗深处的洞口'
    const next = '转身望向黑暗深处的洞口，一阵冷风涌来'
    expect(trimContinuationOverlap(prev, next)).toBe('，一阵冷风涌来')
  })

  it('prefers the longest overlap', () => {
    const prev = 'abcdefgh abcdefgh'
    const next = 'abcdefgh abcdefgh new content'
    // 整段 17 字符重叠应整体剪掉，而非只剪 8 字符
    expect(trimContinuationOverlap(prev, next)).toBe('new content')
  })

  it('returns next unchanged when overlap is shorter than threshold', () => {
    const prev = '故事的结尾。'
    const next = '尾。然后继续'
    // 重叠仅 2 字符，低于阈值不剪
    expect(trimContinuationOverlap(prev, next)).toBe(next)
  })

  it('returns next unchanged when no overlap', () => {
    expect(trimContinuationOverlap('前文内容在此', '全新的续写内容')).toBe('全新的续写内容')
  })

  it('cleans leading whitespace after trimming', () => {
    const prev = 'The story continues here'
    const next = 'continues here\n\n  A new paragraph begins'
    expect(trimContinuationOverlap(prev, next)).toBe('A new paragraph begins')
  })

  it('handles empty inputs', () => {
    expect(trimContinuationOverlap('', 'next')).toBe('next')
    expect(trimContinuationOverlap('prev', '')).toBe('')
  })

  it('minOverlap=4 时裁掉 4 字重叠（R5 实测复读样本）', () => {
    const prev = '说起来，我今天其实'
    const next = '今天其实去了趟老城区的旧货市场'
    // 默认阈值 8 裁不掉“今天其实”（4 字）
    expect(trimContinuationOverlap(prev, next)).toBe(next)
    expect(trimContinuationOverlap(prev, next, 4)).toBe('去了趟老城区的旧货市场')
  })

  it('minOverlap=4 时低于 4 字的重叠不裁剪', () => {
    const prev = '我去看看楼下的'
    const next = '积水有没有漫上来'
    expect(trimContinuationOverlap(prev, next, 4)).toBe(next)
  })

  it('不传参数时默认阈值仍为 8（自动补尾路径行为不变）', () => {
    const prev = '她握紧剑柄'
    const next = '剑柄上映出冷光'
    // 重叠 2 字，低于默认 8 不剪
    expect(trimContinuationOverlap(prev, next)).toBe(next)
    expect(trimContinuationOverlap(prev, next, 8)).toBe(next)
  })
})

describe('trimContinuationSeam 续写接缝策略（S4）', () => {
  it('4 字复读直接去重（无边界也裁）', () => {
    expect(trimContinuationSeam('他听见门外传来', '门外传来脚步声。')).toBe('脚步声。')
  })

  it('7 字复读去重', () => {
    expect(trimContinuationSeam('走廊尽头那扇门后传来了', '那扇门后传来了低沉的声音。')).toBe('低沉的声音。')
  })

  it('8 字复读去重', () => {
    expect(trimContinuationSeam('他听见身后传来一阵急促的脚步声', '一阵急促的脚步声停在门口。')).toBe('停在门口。')
  })

  it('3 字在标点边界处去重（完整短语重复）', () => {
    expect(trimContinuationSeam('她停下脚步，楼下的', '楼下的灯亮着。')).toBe('灯亮着。')
  })

  it('3 字在词/句边界侧去重（next 侧紧随标点）', () => {
    expect(trimContinuationSeam('他说“明天见', '明天见。”')).toBe('。”')
  })

  it('3 字夹在句中且无边界时不裁，避免误伤常见短语', () => {
    const prev = '他站在楼下的'
    const next = '楼下的灯亮着。'
    // 重叠 3 字但前邻“在”、后邻“灯”，无词/标点边界 → 保留
    expect(trimContinuationSeam(prev, next)).toBe(next)
  })

  it('“你的/他的”等 2 字短语不受影响（低于 3 字下限）', () => {
    const prev = '这不是你的'
    const next = '你的书在这里。'
    expect(trimContinuationSeam(prev, next)).toBe(next)
  })

  it('无重叠与空输入保持不变', () => {
    expect(trimContinuationSeam('她推开门。', '外面在下雨。')).toBe('外面在下雨。')
    expect(trimContinuationSeam('', '续写内容')).toBe('续写内容')
    expect(trimContinuationSeam('前文', '')).toBe('')
  })

  it('剪裁后清理首部空白', () => {
    expect(trimContinuationSeam('她推开门', '推开门 走进房间。')).toBe('走进房间。')
  })
})

