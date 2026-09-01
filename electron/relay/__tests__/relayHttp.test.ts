import { describe, expect, it } from 'vitest'
import { buildRelayAuthorizedHeaders } from '../relayHttp'

describe('Relay authorized request headers', () => {
  it('does not declare JSON for a request without a body', () => {
    const headers = buildRelayAuthorizedHeaders('access-token', { method: 'POST' })

    expect(headers.get('authorization')).toBe('Bearer access-token')
    expect(headers.has('content-type')).toBe(false)
  })

  it('declares JSON when a body is present', () => {
    const headers = buildRelayAuthorizedHeaders('access-token', {
      method: 'POST',
      body: JSON.stringify({ value: 1 }),
    })

    expect(headers.get('content-type')).toBe('application/json')
  })

  it('preserves an explicitly selected content type', () => {
    const headers = buildRelayAuthorizedHeaders('access-token', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'value',
    })

    expect(headers.get('content-type')).toBe('text/plain')
  })
})
