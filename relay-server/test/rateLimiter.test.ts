import { describe, expect, it, vi } from 'vitest'
import { RedisRateLimiter } from '../src/security/rateLimiter.js'

describe('RedisRateLimiter', () => {
  it('hashes identifiers and blocks values above the fixed-window limit', async () => {
    const evalFn = vi.fn().mockResolvedValueOnce([1, 900]).mockResolvedValueOnce([9, 812])
    const limiter = new RedisRateLimiter({ eval: evalFn })
    await expect(limiter.consume('pair:ip', '203.0.113.42', 8, 900)).resolves.toEqual({ allowed: true, retryAfterSeconds: 900 })
    await expect(limiter.consume('pair:ip', '203.0.113.42', 8, 900)).resolves.toEqual({ allowed: false, retryAfterSeconds: 812 })
    const key = evalFn.mock.calls[0]?.[2] as string
    expect(key).toMatch(/^rate:pair:ip:[a-f0-9]{64}$/)
    expect(key).not.toContain('203.0.113.42')
  })
})
