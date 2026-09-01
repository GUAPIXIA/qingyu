import { describe, expect, it } from 'vitest'
import { tenantKey } from '../src/routing/tenantKey.js'

describe('tenantKey', () => {
  it('keeps the space id in a Redis cluster hash tag', () => {
    expect(tenantKey('00000000-0000-4000-8000-000000000001', 'pc:presence')).toBe('space:{00000000-0000-4000-8000-000000000001}:pc:presence')
  })
  it('rejects untrusted suffixes', () => expect(() => tenantKey('00000000-0000-4000-8000-000000000001', '../other')).toThrow())
})
