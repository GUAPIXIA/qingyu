/**
 * VisionRouter 单元测试（B1 后：解析逻辑在 shared/chat-core/visionModel，配置由调用方传入）
 */
import { describe, it, expect } from 'vitest'
import { routeVision } from '../visionRouter'

const FALLBACK = { provider: 'openai', model: 'gpt-4o-mini' }
const IMG = [{ role: 'user', content: 'hi', images: ['data:xxx'] }]
const TEXT = [{ role: 'user', content: 'hi' }]

describe('VisionRouter', () => {
  it('含图且有识图模型 → 走 vision，连接字段回退 Profile', () => {
    const r = routeVision(IMG, FALLBACK, { model: 'gpt-4o' }, { provider: 'deepseek', baseUrl: 'https://api.deepseek.com/v1' })
    expect(r.via).toBe('vision')
    expect(r.model).toBe('gpt-4o')
    expect(r.provider).toBe('deepseek')
  })

  it('含图但未配置识图模型 → 走 profile', () => {
    const r = routeVision(IMG, FALLBACK, null, null)
    expect(r.via).toBe('profile')
    expect(r.model).toBe('gpt-4o-mini')
  })

  it('识图模型 model 为空 → 走 profile', () => {
    const r = routeVision(IMG, FALLBACK, { model: '' }, null)
    expect(r.via).toBe('profile')
  })

  it('无图 → 走 profile（即使配置了识图模型）', () => {
    const r = routeVision(TEXT, FALLBACK, { model: 'gpt-4o' }, null)
    expect(r.via).toBe('profile')
    expect(r.model).toBe('gpt-4o-mini')
  })
})
