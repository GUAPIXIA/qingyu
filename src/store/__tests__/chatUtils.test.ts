/**
 * chatUtils 单元测试（friendlyError 错误映射）
 */
import { describe, expect, it } from 'vitest'
import { friendlyError } from '../chatUtils'

describe('friendlyError', () => {
  it('基础映射：401 / 429 / 超时 / 网络', () => {
    expect(friendlyError('HTTP 401 Unauthorized')).toContain('API Key')
    expect(friendlyError('rate limit exceeded')).toContain('频繁')
    expect(friendlyError('request timed out')).toContain('超时')
    expect(friendlyError('fetch failed')).toContain('网络')
  })

  it('模型不存在 / 上下文过长', () => {
    expect(friendlyError('model not found: gpt-5')).toContain('模型不存在')
    expect(friendlyError('context length exceeded')).toContain('上下文过长')
  })

  it('识别「请求包含图片」诊断标记 → 提示检查视觉模型', () => {
    const err = 'OpenAI API 错误 400: {"error":{"message":"Unexpected item type in content."}}。请求包含图片：请确认该模型支持视觉输入（如 gpt-4o、qwen-vl 系列），且网关支持 data URL 图片格式'
    const msg = friendlyError(err)
    expect(msg).toContain('不支持图片输入')
    expect(msg).toContain('qwen-vl')
  })

  it('识别 image + 400/invalid 组合（无标记时）', () => {
    const msg = friendlyError('OpenAI API 错误 400: image is not supported by this model')
    expect(msg).toContain('图片请求被拒绝')
  })

  it('长错误截断', () => {
    const long = 'x'.repeat(200)
    expect(friendlyError(long).length).toBeLessThanOrEqual(103)
  })

  it('空错误返回未知错误', () => {
    expect(friendlyError('')).toBe('未知错误')
  })
})
