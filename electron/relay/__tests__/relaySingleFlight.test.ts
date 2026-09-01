import { describe, expect, it, vi } from 'vitest'
import { RelaySingleFlight } from '../relaySingleFlight'

describe('Relay refresh single-flight', () => {
  it('shares one refresh across concurrent callers and opens the next round after completion', async () => {
    const flight = new RelaySingleFlight<string>()
    let resolve!: (value: string) => void
    const factory = vi.fn(() => new Promise<string>((done) => { resolve = done }))
    const first = flight.run(factory); const second = flight.run(factory)
    expect(factory).toHaveBeenCalledTimes(1)
    resolve('token-1')
    await expect(Promise.all([first, second])).resolves.toEqual(['token-1', 'token-1'])
    await Promise.resolve()
    const nextFactory = vi.fn(async () => 'token-2')
    await expect(flight.run(nextFactory)).resolves.toBe('token-2')
    expect(factory).toHaveBeenCalledTimes(1)
    expect(nextFactory).toHaveBeenCalledTimes(1)
  })
})
