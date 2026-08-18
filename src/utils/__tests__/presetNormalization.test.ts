import { describe, expect, it } from 'vitest'
import { normalizePreset } from '../../../shared/preset'

describe('normalizePreset', () => {
  it('为旧预设补齐默认字段并保留可选设置', () => {
    expect(normalizePreset({ id: ' legacy ', name: ' 旧预设 ' })).toMatchObject({
      id: 'legacy',
      name: '旧预设',
      temperature: 0.8,
      topP: 0.95,
      maxTokens: 1024,
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
      maxTokens: 1,
      maxContext: 0,
      frequencyPenalty: -2,
      presencePenalty: 2,
    })
  })

  it('拒绝缺少 ID 或名称的数据', () => {
    expect(() => normalizePreset({ name: '无 ID' })).toThrow('预设 ID 不能为空')
    expect(() => normalizePreset({ id: 'p1' })).toThrow('预设名称不能为空')
  })
})
