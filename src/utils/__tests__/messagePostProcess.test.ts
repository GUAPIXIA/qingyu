import { describe, it, expect } from 'vitest'
import {
  extractThought,
  stripThought,
  mergeConsecutiveMessages,
  normalizeThoughtTags,
} from '../messagePostProcess'

describe('extractThought', () => {
  it('extracts content from <thought>...</thought> tags', () => {
    const result = extractThought('<thinking>about it</thinking>The answer is 42')
    // normalizeThoughtTags converts <thinking> to <thought>
    expect(result.thought).toBe('about it')
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

  it('handles <thinking>...</thinking> tags (DeepSeek-R1 compatibility)', () => {
    const result = extractThought('<thinking>deep reasoning here</thinking>Final answer')
    expect(result.thought).toBe('deep reasoning here')
    expect(result.content).toBe('Final answer')
    expect(result.isFallback).toBe(false)
  })

  it('handles multiple thought blocks', () => {
    const result = extractThought('<thought>part1</thought>middle<thought>part2</thought>end')
    expect(result.thought).toBe('part1\n\npart2')
    expect(result.content).toBe('middleend')
    expect(result.isFallback).toBe(false)
  })

  it('handles multiple <thinking> blocks', () => {
    const result = extractThought('<thinking>step1</thinking>text<thinking>step2</thinking>more')
    expect(result.thought).toBe('step1\n\nstep2')
    expect(result.isFallback).toBe(false)
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
})

describe('normalizeThoughtTags', () => {
  it('converts <thinking> to <thought>', () => {
    expect(normalizeThoughtTags('<thinking>content</thinking>')).toBe(
      '<thought>content</thought>',
    )
  })

  it('converts <thinking> with attributes to <thought>', () => {
    expect(normalizeThoughtTags('<thinking class="x">content</thinking>')).toBe(
      '<thought class="x">content</thought>',
    )
  })

  it('leaves <thought> tags unchanged', () => {
    expect(normalizeThoughtTags('<thought>content</thought>')).toBe(
      '<thought>content</thought>',
    )
  })

  it('handles empty/falsy input', () => {
    expect(normalizeThoughtTags('')).toBe('')
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
