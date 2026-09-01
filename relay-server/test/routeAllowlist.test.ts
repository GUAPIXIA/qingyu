import { describe, expect, it } from 'vitest'
import { matchAllowedRoute, normalizeBridgePath } from '../src/routing/routeAllowlist.js'

describe('relay bridge allowlist', () => {
  it('allows only explicit MVP routes', () => {
    expect(matchAllowedRoute('GET', '/api/v1/sessions')?.cacheable).toBe(true)
    expect(matchAllowedRoute('POST', '/api/v1/sessions/a/messages')?.queueWhenOffline).toBe(true)
    expect(matchAllowedRoute('DELETE', '/api/v1/sessions/a/messages')).toBeNull()
  })
  it.each(['/api//v1/sessions', '/api/v1/../settings', '/api/v1%2fsessions', 'https://evil.test/'])('rejects unsafe path %s', (path) => {
    expect(() => normalizeBridgePath(path)).toThrow()
  })
})
