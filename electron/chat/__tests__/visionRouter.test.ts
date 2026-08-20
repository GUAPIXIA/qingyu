import { describe, it, expect, vi } from 'vitest'

vi.mock('../../../src/utils/visionModel', () => ({
  resolveVisionModel: vi.fn((msgs: Array<{ images?: string[] }>) => {
    const hasImage = msgs.some((m) => (m.images?.length ?? 0) > 0)
    return hasImage ? { provider: 'openai', model: 'gpt-4o', apiKey: 'sk-v', baseUrl: 'https://api.openai.com/v1' } : null
  }),
}))

import { routeVision } from '../visionRouter'

describe('VisionRouter', () => {
  it('含图走 vision', () => {
    const r = routeVision([{ role: 'user', content: 'hi', images: ['data:xxx'] }], { provider: 'openai', model: 'gpt-4o-mini' })
    expect(r.via).toBe('vision')
    expect(r.model).toBe('gpt-4o')
  })
  it('无图走 profile', () => {
    const r = routeVision([{ role: 'user', content: 'hi' }], { provider: 'openai', model: 'gpt-4o-mini' })
    expect(r.via).toBe('profile')
    expect(r.model).toBe('gpt-4o-mini')
  })
})
