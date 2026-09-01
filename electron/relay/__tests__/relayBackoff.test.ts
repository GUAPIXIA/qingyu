import { describe, expect, it } from 'vitest'
import { RelayBackoff } from '../relayBackoff'

describe('RelayBackoff', () => {
  it('uses the documented capped sequence without jitter at midpoint', () => {
    const backoff = new RelayBackoff()
    expect(Array.from({ length: 9 }, () => backoff.next(() => 0.5).delayMs)).toEqual([0, 1000, 2000, 4000, 8000, 15000, 30000, 30000, 30000])
  })
  it('resets after connectivity is restored', () => {
    const backoff = new RelayBackoff(); backoff.next(); backoff.next(); backoff.reset()
    expect(backoff.next(() => 0.5)).toEqual({ attempt: 0, delayMs: 0 })
  })
})
