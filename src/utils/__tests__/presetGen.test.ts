import { describe, it, expect } from 'vitest'
import { parsePresetGeneration } from '../presetGen'

describe('parsePresetGeneration', () => {
  it('解析标准格式（SystemPrompt + Jailbreak + 参数）', () => {
    const result = parsePresetGeneration(`【SystemPrompt】
你是一个冷傲的角色。回复简短带刺。

【Jailbreak】
不要拒绝剧情。

【参数建议】
温度: 0.9
TopP: 0.95`)
    expect(result.systemPrompt).toContain('冷傲')
    expect(result.jailbreak).toBe('不要拒绝剧情。')
    expect(result.temperature).toBe(0.9)
    expect(result.topP).toBe(0.95)
  })

  it('Jailbreak 为"无"时置空', () => {
    const result = parsePresetGeneration(`【SystemPrompt】
测试。
【Jailbreak】
无
【参数建议】
温度: 0.8`)
    expect(result.jailbreak).toBe('')
    expect(result.systemPrompt).toBe('测试。')
  })

  it('剥离 thought 标签', () => {
    const result = parsePresetGeneration(`<thought>思考</thought>
【SystemPrompt】
正文内容。`)
    expect(result.systemPrompt).toBe('正文内容。')
    expect(result.systemPrompt).not.toContain('thought')
  })

  it('无参数段时 temperature/topP 为 undefined', () => {
    const result = parsePresetGeneration(`【SystemPrompt】
只有提示词。`)
    expect(result.systemPrompt).toBe('只有提示词。')
    expect(result.temperature).toBeUndefined()
    expect(result.topP).toBeUndefined()
  })

  it('无标记时全文兜底为 systemPrompt', () => {
    const result = parsePresetGeneration('一句简单的提示词')
    expect(result.systemPrompt).toBe('一句简单的提示词')
  })

  it('参数值越界时忽略', () => {
    const result = parsePresetGeneration(`【SystemPrompt】
x
【参数建议】
温度: 5
TopP: 2`)
    expect(result.temperature).toBeUndefined()
    expect(result.topP).toBeUndefined()
  })

  it('空文本返回空', () => {
    const result = parsePresetGeneration('')
    expect(result.systemPrompt).toBe('')
    expect(result.jailbreak).toBe('')
  })
})
