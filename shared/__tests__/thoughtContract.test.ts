/**
 * 阶段7.2：thought 角色心理语义契约验收（方案 §5.1/§5.3 可单测部分）。
 *
 * 覆盖：提示契约条款完整性、全局叙事第三人称下 thought 归属焦点角色、
 * 群聊 speaker 归属、供应商 reasoning 与角色 thought 的双通道隔离、
 * TTS 不朗读 thought。真实模型评测（"我需要遵守规则"类样本判定）在 §7.4 灰度阶段执行。
 */
import { describe, it, expect } from 'vitest'
import { buildThoughtContractBody, THOUGHT_CONTRACT_CLAUSES } from '../thoughtContract'
import { stripVendorThinking } from '../thoughtMarkup'
import { buildNarrativeModePrompt } from '../narrativeMode'
import { buildRoleplayBlocks } from '../../src/utils/roleplayBlocks'

describe('thought 契约提示（§5.1）', () => {
  it('沉浸模式：每轮必须输出角色第一人称内心独白', () => {
    const prompt = buildThoughtContractBody({ narrativeMode: 'immersive', subjectName: '艾琳' })
    for (const clause of THOUGHT_CONTRACT_CLAUSES) expect(prompt).toContain(clause)
    expect(prompt).toContain('艾琳 自己的“我”')
    expect(prompt).toContain('禁止用旁白/第三人称')
    expect(prompt).toContain('每轮必须输出且只输出一组')
    expect(prompt).not.toContain('可省略')
    // 禁止的元信息词在提示中只以"不得包含"的形式出现（负向约束）
    expect(prompt).toContain('不得包含模型推理')
  })

  it('全局叙事：正文第三人称，thought 仍属焦点角色第一人称', () => {
    const prompt = buildThoughtContractBody({ narrativeMode: 'omniscient', subjectName: '「叶」' })
    expect(prompt).toContain('正文仍保持第三人称叙事')
    expect(prompt).toContain('当前焦点角色「叶」的第一人称内心独白')
    expect(prompt).toContain('必须切换到 「叶」 自己的“我”来思考')
    expect(prompt).toContain('禁止用旁白/第三人称')
    expect(prompt).toContain('每轮必须输出且只输出一组')
    expect(prompt).toContain('不要一次泄露所有人物的隐私想法')
    expect(prompt).toContain('不得包含模型推理')
  })

  it('缺省 subjectName 时仍给出可执行的思考主体，不留下模糊旁白视角', () => {
    const omni = buildThoughtContractBody({ narrativeMode: 'omniscient' })
    expect(omni).toContain('当前对话角色')
    expect(omni).toContain('必须切换到 当前对话角色 自己的“我”来思考')
    const imm = buildThoughtContractBody({ narrativeMode: 'immersive' })
    expect(imm).toContain('该角色 自己的“我”')
  })

  it('群聊与单聊共用同一来源：同参数输出必须逐字一致（防漂移）', () => {
    const single = buildThoughtContractBody({ narrativeMode: 'immersive', subjectName: '艾琳' })
    const group = buildThoughtContractBody({ narrativeMode: 'immersive', subjectName: '艾琳' })
    expect(single).toBe(group)
  })

  it('全局叙事：旁白护栏与 thought 契约拼接后不存在互斥条款', () => {
    // 护栏声明"若其他提示与本约束冲突，以本约束为准"；若护栏仍无条件禁止引号外第一人称，
    // 会把契约要求的焦点角色第一人称 <thought> 压制掉。护栏必须窄口径豁免 thought 块。
    const combined = [
      buildNarrativeModePrompt('omniscient', '林舟', '艾琳'),
      '【内心想法契约】\n' + buildThoughtContractBody({ narrativeMode: 'omniscient', subjectName: '「艾琳」' }),
    ].join('\n\n')

    // 护栏仍要求正文第三人称、且以焦点角色名点名思考主体
    expect(combined).toContain('正文主体必须使用第三人称叙事')
    expect(combined).toContain('当前焦点角色「艾琳」的第一人称内心独白')
    // 护栏豁免在位：引号外第一人称被允许的唯一额外位置就是 <thought> 块
    expect(combined).toContain('或 <thought>...</thought> 块内的角色内心独白')
    expect(combined).toContain('<thought> 内心独白块不受本条限制')
    // 旧无条件措辞不得回归（正是它制造与契约的冲突）
    expect(combined).not.toContain('不能成为回答的叙述视角')
  })
})

describe('reasoning 与 thought 双通道隔离（§5.2）', () => {
  it('清理供应商 reasoning 不得误删合规的角色 <thought>', () => {
    const text = '<thinking>先分析上下文再动笔</thinking>\n<thought>我得保持冷静。</thought>\n她推开窗。'
    const cleaned = stripVendorThinking(text)
    expect(cleaned).not.toContain('先分析上下文')
    expect(cleaned).toContain('<thought>我得保持冷静。</thought>')
  })

  it('不得把供应商 reasoning 包装成 <thought>', () => {
    const reasoningOnly = '<thinking>步骤一：解析人设；步骤二：组织语言</thinking>'
    const cleaned = stripVendorThinking(reasoningOnly)
    expect(cleaned).not.toContain('<thought>')
    expect(cleaned.trim()).toBe('')
  })

  it('跨 chunk 拼接后的 thinking 标签可完整清除（归一化后）', () => {
    // 流式分片可能把一个标签拆两半；拼接后整体清理
    const chunkA = '<think'
    const chunkB = 'ing>内部推理</thi' + 'nking>她笑了笑。'
    const cleaned = stripVendorThinking(chunkA + chunkB)
    expect(cleaned).toBe('她笑了笑。')
  })

  it('TTS/朗读口径：thought 块被剥离，普通正文保留', () => {
    // 与 electron/bridge/ttsHandler.prepareTtsText 同一正则口径（默认 strip）
    const body = '<thought>我的心跳得很快。</thought>\n“我到了。”'
    const forTts = body.replace(/<thought>[\s\S]*?<\/thought>/gi, '').trim()
    expect(forTts).not.toContain('心跳')
    expect(forTts).toContain('“我到了。”')
  })

  it('thought 在语义分块中独立成块且归属正文（不是被丢弃内容）', () => {
    const blocks = buildRoleplayBlocks('<thought>我得保持冷静。</thought>\n她推开窗。')
    expect(blocks[0]).toEqual({ kind: 'thought', text: '我得保持冷静。' })
    expect(blocks[1]).toEqual({ kind: 'narration', text: '她推开窗。' })
  })
})
