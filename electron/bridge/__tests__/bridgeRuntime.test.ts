import { describe, expect, it, vi } from 'vitest'
import { CompositeMobileEventSink } from '../runtime/mobileEventBus'
import { GenerationRegistry } from '../runtime/generationRegistry'

describe('shared mobile runtime primitives', () => {
  it('fans an event out once to LAN and Relay sinks', () => {
    const lan = { publish: vi.fn() }; const relay = { publish: vi.fn() }
    const events = new CompositeMobileEventSink([lan, relay])
    events.publish('session:updated', { sessionId: 's' })
    expect(lan.publish).toHaveBeenCalledTimes(1); expect(relay.publish).toHaveBeenCalledTimes(1)
  })
  it('cancels a generation independently of transports', () => {
    const registry = new GenerationRegistry(); const controller = registry.create('request')
    expect(registry.cancel('request')).toBe(true); expect(controller.signal.aborted).toBe(true)
  })
})
