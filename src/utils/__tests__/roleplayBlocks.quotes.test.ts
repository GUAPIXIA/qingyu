/**
 * 对白解析回归：四类引号、流式未闭合稳定性、行内 Markdown 前置条件。
 * 覆盖阶段 0/1 验收点；实现未就绪时这些断言会失败。
 */
import { describe, expect, it } from 'vitest'
import {
  parseRoleplayBlocks,
  buildRoleplayBlocks,
  stripOuterQuotes,
  splitQuoteSegments,
  QUOTE_PAIRS,
  type RoleplayBlock,
} from '../roleplayBlocks'

function firstKind(content: string, phase?: 'streaming' | 'final'): string | undefined {
  const blocks = parseRoleplayBlocks(content, phase ? { phase } : {})
  return blocks[0]?.kind
}

describe('四类引号一致识别', () => {
  const samples: Array<[string, string, string]> = [
    ['cjk-curly', '苏晚：“我回来了。”', '我回来了。'],
    ['cjk-corner', '苏晚：「我回来了。」', '我回来了。'],
    ['cjk-double-corner', '苏晚：『我回来了。』', '我回来了。'],
    ['ascii', '苏晚:"我回来了。"', '我回来了。'],
  ]

  it.each(samples)('说话人前缀 + %s 引号 → dialogue', (_name, line, body) => {
    const blocks = buildRoleplayBlocks(line)
    expect(blocks).toEqual([
      {
        kind: 'dialogue',
        text: expect.stringContaining(body) as unknown as string,
        speaker: '苏晚',
      },
    ])
    expect(blocks[0]).toMatchObject({ kind: 'dialogue', speaker: '苏晚' })
  })

  it.each([
    ['“我回来了。”'],
    ['「我回来了。」'],
    ['『我回来了。』'],
    ['"我回来了。"'],
  ])('纯对白 %s → dialogue', (line) => {
    expect(firstKind(line)).toBe('dialogue')
  })

  it('同行旁白+对白 → mixed', () => {
    expect(firstKind('她推开门：“谁在那？”')).toBe('mixed')
    expect(firstKind('她推开门：「谁在那？」')).toBe('mixed')
    expect(firstKind('她推开门：『谁在那？』')).toBe('mixed')
    expect(firstKind('她推开门："谁在那？"')).toBe('mixed')
  })

  it('嵌套引号保持 dialogue，不丢内层', () => {
    const blocks = buildRoleplayBlocks('“他说：“好。””')
    expect(blocks[0]).toMatchObject({ kind: 'dialogue' })
    expect((blocks[0] as { text: string }).text).toBe('“他说：“好。””')
  })

  it('“对白”叙述“对白”整行以引号收尾也不算纯对白', () => {
    const line = '“手机在我枕头那边啦，你自己去拿，我才不要碰。”我小声嘟囔，又补了一句，“上次那是意外。”'
    expect(firstKind(line)).toBe('mixed')
    const blocks = buildRoleplayBlocks(line)
    expect(blocks[0]).toMatchObject({ kind: 'mixed' })
    // 行内两段引号应分别标出，中间叙述保持原文
    expect(splitQuoteSegments(line)).toEqual([
      { text: '“手机在我枕头那边啦，你自己去拿，我才不要碰。”', quoted: true },
      { text: '我小声嘟囔，又补了一句，', quoted: false },
      { text: '“上次那是意外。”', quoted: true },
    ])
  })

  it('说话人 + “对白”叙述“对白”也走 mixed', () => {
    expect(firstKind('苏晚：“走吧。”她顿了顿，“还是算了。”')).toBe('mixed')
  })

  it('未闭合匿名引号行含冒号仍保持 incomplete dialogue（不跳 mixed）', () => {
    const partial = '“她说：你先走'
    expect(firstKind(partial, 'streaming')).toBe('dialogue')
    expect(firstKind(partial, 'final')).toBe('dialogue')
    const blocks = parseRoleplayBlocks(partial, { phase: 'streaming' })
    expect(blocks[0]).toMatchObject({ kind: 'dialogue', complete: false })
  })

  it('ASCII 单引号不再触发对白/混写（避免英文撇号误伤）', () => {
    expect(firstKind("'hello'")).toBe('narration')
    expect(firstKind("it's fine")).toBe('narration')
  })

  it('splitQuoteSegments 嵌套同类引号按深度配对', () => {
    const text = '旁白“他说：“好。””尾'
    expect(splitQuoteSegments(text)).toEqual([
      { text: '旁白', quoted: false },
      { text: '“他说：“好。””', quoted: true },
      { text: '尾', quoted: false },
    ])
  })

  it('多段对白分别成块', () => {
    const blocks = buildRoleplayBlocks('“第一句。”\n苏晚：“第二句。”')
    expect(blocks.map((b) => b.kind)).toEqual(['dialogue', 'dialogue'])
  })

  it('空对白保留为 dialogue', () => {
    const blocks = buildRoleplayBlocks('“”')
    expect(blocks[0]).toMatchObject({ kind: 'dialogue' })
  })
})

describe('未闭合对白：流式与最终态', () => {
  it('streaming：仅有左引号 → dialogue complete:false', () => {
    const blocks = parseRoleplayBlocks('苏晚：“我回来了', { phase: 'streaming' })
    expect(blocks[0]).toMatchObject({ kind: 'dialogue', speaker: '苏晚', complete: false })
    expect((blocks[0] as { text: string }).text).toContain('我回来了')
  })

  it('streaming：纯左引号行也是 dialogue，不先变 narration', () => {
    const partial = '“外面在下雨'
    const closed = '“外面在下雨。”'
    expect(firstKind(partial, 'streaming')).toBe('dialogue')
    expect(firstKind(closed, 'streaming')).toBe('dialogue')
  })

  it('流式闭合前后 block 类型不跳变（仅 complete/正文更新）', () => {
    const snapshots = [
      '苏晚：“我',
      '苏晚：“我回来',
      '苏晚：“我回来了',
      '苏晚：“我回来了。”',
    ]
    const kinds = snapshots.map((s) => firstKind(s, 'streaming'))
    expect(new Set(kinds)).toEqual(new Set(['dialogue']))
    const last = parseRoleplayBlocks(snapshots.at(-1)!, { phase: 'streaming' })
    expect(last[0]).not.toHaveProperty('complete', false)
  })

  it('final：未闭合异常输出不丢失、保持 dialogue incomplete', () => {
    const blocks = parseRoleplayBlocks('苏晚：“我回来了', { phase: 'final' })
    expect(blocks[0]).toMatchObject({ kind: 'dialogue', complete: false })
    expect((blocks[0] as { text: string }).text).toContain('我回来了')
  })

  it('四类引号流式未闭合均保持 dialogue', () => {
    for (const [open] of QUOTE_PAIRS) {
      expect(firstKind(`${open}未闭合`, 'streaming')).toBe('dialogue')
      expect(firstKind(`苏晚:${open}未闭合`, 'streaming')).toBe('dialogue')
    }
  })

  it('闭合后带尾随旁白 → mixed（不是 incomplete dialogue）', () => {
    expect(firstKind('苏晚：“你好。”她挥了挥手。')).toBe('mixed')
    expect(firstKind('“别怕。”她握紧了手。')).toBe('mixed')
  })
})

describe('行内与边界', () => {
  it('引号前后带 Markdown 裁饰不破坏说话人识别（剥离后仍是纯对白）', () => {
    // blocks 路径不解析 Markdown 语法为格式，但正文完整保留
    const blocks = buildRoleplayBlocks('苏晚：“**重点**台词。”')
    expect(blocks[0]).toMatchObject({ kind: 'dialogue', speaker: '苏晚' })
    expect((blocks[0] as { text: string }).text).toContain('**重点**')
  })

  it('Windows / Unix 换行与连续空行', () => {
    const win = '苏晚：“甲。”\r\n\r\n她推开门。\r\n“乙。”'
    const unix = '苏晚：“甲。”\n\n她推开门。\n“乙。”'
    const a = buildRoleplayBlocks(win)
    const b = buildRoleplayBlocks(unix)
    expect(a.map((x) => x.kind)).toEqual(b.map((x) => x.kind))
    expect(a.map((x) => x.kind)).toEqual(['dialogue', 'narration', 'dialogue'])
  })

  it('空对白 / 只有左引号不吞掉输入（可见文本守恒）', () => {
    const pure = parseRoleplayBlocks('“”，以及旁白')
    const text = pure.map((b: RoleplayBlock) => b.text).join('')
    expect(text).toContain('，以及旁白')
    expect(text).toContain('“')
  })
})

describe('stripOuterQuotes / splitQuoteSegments 四类引号', () => {
  it.each([
    ['“我知道。”', '我知道。'],
    ['「走吧。」', '走吧。'],
    ['『序章』', '序章'],
    ['"序章"', '序章'],
    ['“没闭合', '“没闭合'],
  ])('stripOuterQuotes %s → %s', (input, expected) => {
    expect(stripOuterQuotes(input)).toBe(expected)
  })

  it('splitQuoteSegments 识别 ASCII 与 『』', () => {
    expect(splitQuoteSegments('旁白 "对话" 尾')).toEqual([
      { text: '旁白 ', quoted: false },
      { text: '"对话"', quoted: true },
      { text: ' 尾', quoted: false },
    ])
    expect(splitQuoteSegments('旁白『对话』')).toEqual([
      { text: '旁白', quoted: false },
      { text: '『对话』', quoted: true },
    ])
  })
})
