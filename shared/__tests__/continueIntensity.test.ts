import { describe, it, expect } from 'vitest'
import {
  CONTINUE_INTENSITY_OPTIONS,
  CONTINUE_INTENSITY_PARAMS,
  CONTINUE_LENGTH_OPTIONS,
  CONTINUE_LENGTH_PARAMS,
  DEFAULT_CONTINUE_INTENSITY,
  DEFAULT_CONTINUE_LENGTH,
  isContinueIntensity,
  isContinueLength,
  resolveContinueIntensity,
  resolveContinueLength,
  getContinueIntensityLabel,
  getContinueLengthLabel,
} from '../continueIntensity'
import type { ContinueIntensity, ContinueLength } from '../types'

describe('continueIntensity', () => {
  it('剧情转折选项顺序与温度参数覆盖全部档位', () => {
    const values: ContinueIntensity[] = ['subtle', 'steady', 'active', 'bold']
    expect(CONTINUE_INTENSITY_OPTIONS.map((option) => option.value)).toEqual(values)
    for (const value of values) {
      expect(CONTINUE_INTENSITY_PARAMS[value]).toBeDefined()
    }
  })

  it('默认档位保持稳定，温度收窄到 0.45–0.75', () => {
    expect(DEFAULT_CONTINUE_INTENSITY).toBe('active')
    expect(DEFAULT_CONTINUE_LENGTH).toBe('standard')
    expect(CONTINUE_INTENSITY_PARAMS.active).toEqual({ temperature: 0.65 })
    expect(CONTINUE_LENGTH_PARAMS.standard).toEqual({
      minChars: 80, maxChars: 180, structure: '形成 1 个完整自然段',
    })
    const temps = CONTINUE_INTENSITY_OPTIONS.map((option) => CONTINUE_INTENSITY_PARAMS[option.value].temperature)
    expect(Math.min(...temps)).toBeGreaterThanOrEqual(0.45)
    expect(Math.max(...temps)).toBeLessThanOrEqual(0.75)
  })

  it('剧情温度随转折档位单调递增', () => {
    const ordered = CONTINUE_INTENSITY_OPTIONS.map((option) => option.value)
    for (let i = 1; i < ordered.length; i++) {
      expect(CONTINUE_INTENSITY_PARAMS[ordered[i]].temperature)
        .toBeGreaterThan(CONTINUE_INTENSITY_PARAMS[ordered[i - 1]].temperature)
    }
  })

  it('内容长度选项只描述字数区间，不再携带各自的输出预算', () => {
    const values: ContinueLength[] = ['brief', 'standard', 'detailed', 'extended']
    expect(CONTINUE_LENGTH_OPTIONS.map((option) => option.value)).toEqual(values)
    for (const value of values) {
      expect(CONTINUE_LENGTH_PARAMS[value]).not.toHaveProperty('maxTokens')
    }
  })

  it('字数区间随档位单调递增且互不重叠', () => {
    const values: ContinueLength[] = ['brief', 'standard', 'detailed', 'extended']
    for (const value of values) {
      const params = CONTINUE_LENGTH_PARAMS[value]
      expect(params.minChars).toBeGreaterThan(0)
      expect(params.maxChars).toBeGreaterThan(params.minChars)
      expect(params.structure.length).toBeGreaterThan(0)
    }
    for (let i = 1; i < values.length; i++) {
      expect(CONTINUE_LENGTH_PARAMS[values[i]].minChars)
        .toBeGreaterThan(CONTINUE_LENGTH_PARAMS[values[i - 1]].maxChars)
    }
  })

  it('长度档位说明包含区间与结构目标', () => {
    const brief = CONTINUE_LENGTH_OPTIONS.find((option) => option.value === 'brief')
    expect(brief?.description).toContain('20–60')
    const extended = CONTINUE_LENGTH_OPTIONS.find((option) => option.value === 'extended')
    expect(extended?.description).toContain('500–900')
  })

  it('非法值与空值回退到默认档', () => {
    expect(isContinueIntensity('subtle')).toBe(true)
    expect(isContinueIntensity('extreme')).toBe(false)
    expect(isContinueIntensity(undefined)).toBe(false)
    expect(resolveContinueIntensity()).toBe(DEFAULT_CONTINUE_INTENSITY)
    expect(resolveContinueIntensity(undefined, 'bold')).toBe('bold')
    expect(resolveContinueIntensity('garbage', null, 'steady')).toBe('steady')
    expect(resolveContinueIntensity('garbage')).toBe(DEFAULT_CONTINUE_INTENSITY)
    expect(isContinueLength('brief')).toBe(true)
    expect(isContinueLength('huge')).toBe(false)
    expect(resolveContinueLength(undefined, 'extended')).toBe('extended')
    expect(resolveContinueLength('garbage')).toBe(DEFAULT_CONTINUE_LENGTH)
  })

  it('标签查询命中中文档位名', () => {
    expect(getContinueIntensityLabel('bold')).toBe('剧变')
    expect(getContinueLengthLabel('detailed')).toBe('展开')
    expect(getContinueIntensityLabel('active')).toBe('转折')
    expect(getContinueLengthLabel('standard')).toBe('小段')
  })
})
