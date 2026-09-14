import { describe, expect, it } from 'vitest'
import { normalizeImportedPreset, normalizePreset } from '../../../shared/preset'

describe('normalizePreset', () => {
  it('为旧预设补齐默认字段并保留可选设置', () => {
    expect(normalizePreset({ id: ' legacy ', name: ' 旧预设 ' })).toMatchObject({
      id: 'legacy',
      name: '旧预设',
      temperature: 0.8,
      topP: 0.95,
      maxTokens: 0,
      maxContext: 0,
      isBuiltin: false,
    })
  })

  it('钳制无效采样参数，避免传入提供商适配器', () => {
    const preset = normalizePreset({
      id: 'p1',
      name: '测试',
      temperature: 99,
      topP: 0,
      maxTokens: -20,
      maxContext: Number.NaN,
      frequencyPenalty: -9,
      presencePenalty: 9,
    })
    expect(preset).toMatchObject({
      temperature: 2,
      topP: 0.01,
      maxTokens: 0,
      maxContext: 0,
      frequencyPenalty: -2,
      presencePenalty: 2,
    })
  })

  it('模型输出硬上限 0 表示自动并在保存/导入后保持', () => {
    expect(normalizePreset({ id: 'auto', name: '自动预算', maxTokens: 0 }).maxTokens).toBe(0)
  })

  it('只有内置旧快捷值映射为篇幅偏好，并区分用户保存的硬上限', () => {
    expect(normalizePreset({ id: 'short', name: '短', maxTokens: 512, isBuiltin: true }))
      .toMatchObject({ responseLengthHint: 'brief', maxTokens: 512 })
    expect(normalizePreset({ id: 'normal', name: '中', maxTokens: 1024, isBuiltin: true }))
      .toMatchObject({ responseLengthHint: 'balanced', maxTokens: 1024 })
    expect(normalizePreset({ id: 'long', name: '长', maxTokens: 4096, isBuiltin: true }))
      .toMatchObject({ responseLengthHint: 'detailed', maxTokens: 4096 })
    expect(normalizePreset({ id: 'user', name: '用户旧预设', maxTokens: 4096, isBuiltin: false }))
      .toMatchObject({ responseLengthHint: 'auto', maxTokens: 4096 })
  })

  it('拒绝缺少 ID 或名称的数据', () => {
    expect(() => normalizePreset({ name: '无 ID' })).toThrow('预设 ID 不能为空')
    expect(() => normalizePreset({ id: 'p1' })).toThrow('预设名称不能为空')
  })
})

describe('normalizeImportedPreset', () => {
  it('兼容标准蛇形字段，并使用文件名补齐名称', () => {
    const result = normalizeImportedPreset({
      temperature: 0.75,
      top_p: 0.99,
      frequency_penalty: 1.1,
      presence_penalty: 1.1,
      main_prompt: '扮演 {{char}}，与 {{user}} 对话',
      jailbreak_prompt: '保持角色身份',
    }, { id: 'imported-1', fallbackName: 'Deepseek_V3_Preset_通用轻量版' })

    expect(result).toMatchObject({
      sourceFormat: 'standard',
      unsupportedFields: [],
      preset: {
        id: 'imported-1',
        name: 'Deepseek_V3_Preset_通用轻量版',
        systemPrompt: '扮演 {{char}}，与 {{user}} 对话',
        jailbreak: '保持角色身份',
        temperature: 0.75,
        topP: 0.99,
        frequencyPenalty: 1.1,
        presencePenalty: 1.1,
        isBuiltin: false,
      },
    })
  })

  it('保留原生字段优先级，并报告无法应用的字段', () => {
    const result = normalizeImportedPreset({
      name: '混合预设',
      systemPrompt: '原生提示词',
      main_prompt: '标准提示词',
      top_k: 49,
      min_p: 1,
      assistant_prefill: '',
    }, { id: 'imported-2', fallbackName: '文件名' })

    expect(result.preset.systemPrompt).toBe('原生提示词')
    expect(result.unsupportedFields).toEqual(['assistant_prefill', 'min_p', 'top_k'])
  })

  it('继续支持项目原生格式', () => {
    const result = normalizeImportedPreset({
      name: '原生预设',
      systemPrompt: '原生内容',
      topP: 0.8,
    }, { id: 'imported-3', fallbackName: '文件名' })

    expect(result.sourceFormat).toBe('qingyu')
    expect(result.preset).toMatchObject({ name: '原生预设', systemPrompt: '原生内容', topP: 0.8 })
    expect(result.unsupportedFields).toEqual([])
  })
})
