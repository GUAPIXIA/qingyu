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

  it('默认组合保留原 active 档的采样与输出预算', () => {
    expect(DEFAULT_CONTINUE_INTENSITY).toBe('active')
    expect(DEFAULT_CONTINUE_LENGTH).toBe('standard')
    expect(CONTINUE_INTENSITY_PARAMS.active).toEqual({ temperature: 0.7 })
    expect(CONTINUE_LENGTH_PARAMS.standard).toEqual({ maxTokens: 1024 })
  })

  it('剧情温度随转折档位单调递增', () => {
    const ordered = CONTINUE_INTENSITY_OPTIONS.map((option) => option.value)
    for (let i = 1; i < ordered.length; i++) {
      expect(CONTINUE_INTENSITY_PARAMS[ordered[i]].temperature)
        .toBeGreaterThan(CONTINUE_INTENSITY_PARAMS[ordered[i - 1]].temperature)
    }
  })

  it('内容长度选项与输出预算独立且单调递增', () => {
    const values: ContinueLength[] = ['brief', 'standard', 'detailed', 'extended']
    expect(CONTINUE_LENGTH_OPTIONS.map((option) => option.value)).toEqual(values)
    for (let i = 1; i < values.length; i++) {
      expect(CONTINUE_LENGTH_PARAMS[values[i]].maxTokens)
        .toBeGreaterThan(CONTINUE_LENGTH_PARAMS[values[i - 1]].maxTokens)
    }
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
    expect(getContinueIntensityLabel('bold')).toBe('强烈转折')
    expect(getContinueLengthLabel('detailed')).toBe('详细')
  })
})
