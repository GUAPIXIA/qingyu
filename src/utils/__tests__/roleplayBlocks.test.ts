import { describe, expect, it } from 'vitest'
import { buildRoleplayBlocks, stripOuterQuotes, splitQuoteSegments } from '../roleplayBlocks'

describe('buildRoleplayBlocks：确定性分块（方案 §6.1）', () => {
  it('纯对白行 → dialogue（无说话人）', () => {
    const blocks = buildRoleplayBlocks('“你来得正好。”')
    expect(blocks).toEqual([{ kind: 'dialogue', text: '“你来得正好。”' }])
  })

  it('「」引号对白同样识别', () => {
    const blocks = buildRoleplayBlocks('「走吧。」')
    expect(blocks).toEqual([{ kind: 'dialogue', text: '「走吧。」' }])
  })

  it('说话人 + 对白 → dialogue 携带 speaker', () => {
    const blocks = buildRoleplayBlocks('苏晚：“我知道。”')
    expect(blocks).toEqual([{ kind: 'dialogue', text: '“我知道。”', speaker: '苏晚' }])
  })

  it('单字角色名正确解析且不产生重复前缀', () => {
    const blocks = buildRoleplayBlocks('叶：“走吧。”')
    expect(blocks).toEqual([{ kind: 'dialogue', text: '“走吧。”', speaker: '叶' }])
    // 渲染拼接结果只出现一次名字
    const rendered = blocks.map((b) => b.kind === 'dialogue' && b.speaker ? `${b.speaker}：${b.text}` : b.text).join('')
    expect(rendered).toBe('叶：“走吧。”')
    expect(rendered.match(/叶：/g)).toHaveLength(1)
  })

  it('整段 *动作* → narration 并剥离星号（新内容不再要求星号）', () => {
    const blocks = buildRoleplayBlocks('*她把门拉开，示意他进来。*')
    expect(blocks).toEqual([{ kind: 'narration', text: '她把门拉开，示意他进来。' }])
  })

  it('新普通叙述 → narration（无需星号）', () => {
    const blocks = buildRoleplayBlocks('她把门拉开，示意他进来。')
    expect(blocks).toEqual([{ kind: 'narration', text: '她把门拉开，示意他进来。' }])
  })

  it('一行同时含对白与叙述 → mixed，保持原文', () => {
    const line = '苏晚推开门：“谁在那？”'
    const blocks = buildRoleplayBlocks(line)
    expect(blocks).toEqual([{ kind: 'mixed', text: line }])
  })

  it('引号后接叙述 → mixed', () => {
    const line = '“谁在那？”她轻声问。'
    const blocks = buildRoleplayBlocks(line)
    expect(blocks).toEqual([{ kind: 'mixed', text: line }])
  })

  it('<thought> 块 → thought', () => {
    const blocks = buildRoleplayBlocks('<thought>我该不该说出真相？</thought>')
    expect(blocks).toEqual([{ kind: 'thought', text: '我该不该说出真相？' }])
  })

  it('混合排版：对白/动作/叙述/思考各归其类，相邻叙述合并', () => {
    const content = [
      '雨下了整夜。',
      '',
      '*她站在窗前没有开灯。*',
      '',
      '“你还没睡？”',
      '苏晚：“嗯，睡不着。”',
      '<thought>我还是放心不下她。</thought>',
      '她转过身，屋里很安静。',
    ].join('\n')
    const blocks = buildRoleplayBlocks(content)
    expect(blocks).toEqual([
      { kind: 'narration', text: '雨下了整夜。' },
      { kind: 'narration', text: '她站在窗前没有开灯。' },
      { kind: 'dialogue', text: '“你还没睡？”' },
      { kind: 'dialogue', text: '“嗯，睡不着。”', speaker: '苏晚' },
      { kind: 'thought', text: '我还是放心不下她。' },
      { kind: 'narration', text: '她转过身，屋里很安静。' },
    ])
  })

  it('分块不修改原正文（复制/导出仍用原始 content）', () => {
    const content = '*动作* 眉笔 *不应被改写*'
    const before = content
    buildRoleplayBlocks(content)
    expect(content).toBe(before)
  })

  it('空内容返回空数组', () => {
    expect(buildRoleplayBlocks('')).toEqual([])
  })
})

describe('展示层工具：stripOuterQuotes / splitQuoteSegments', () => {
  it('stripOuterQuotes 剥成对中文引号，不成对时原样返回', () => {
    expect(stripOuterQuotes('“我知道。”')).toBe('我知道。')
    expect(stripOuterQuotes('「走吧。」')).toBe('走吧。')
    expect(stripOuterQuotes('『序章』')).toBe('序章')
    expect(stripOuterQuotes('“没闭合')).toBe('“没闭合')
    expect(stripOuterQuotes('普通叙述。')).toBe('普通叙述。')
  })

  it('splitQuoteSegments 把 mixed 行内引号段标出，其余保持原文', () => {
    expect(splitQuoteSegments('苏晚推开门：“谁在那？”')).toEqual([
      { text: '苏晚推开门：', quoted: false },
      { text: '“谁在那？”', quoted: true },
    ])
    expect(splitQuoteSegments('无引号文本')).toEqual([{ text: '无引号文本', quoted: false }])
  })
})
