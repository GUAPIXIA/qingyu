import { describe, expect, it } from 'vitest'
import { matchRelayRpc } from '../relayRpcDispatcher'

describe('PC Relay RPC allowlist', () => {
  it('matches the shared Facade routes', () => {
    expect(matchRelayRpc('GET', '/api/v1/sessions/a/messages')).toEqual({ operation: 'messages', sessionId: 'a' })
    expect(matchRelayRpc('POST', '/api/v1/sessions/a/messages')).toEqual({ operation: 'send', sessionId: 'a' })
  })
  it.each(['/api/v1/../settings', '/api/v1%2fsessions', '//evil.test/api'])('rejects path confusion %s', (path) => {
    expect(matchRelayRpc('GET', path)).toBeNull()
  })
})
