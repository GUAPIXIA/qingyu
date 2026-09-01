import { describe, expect, it } from 'vitest'
import { MetricsRegistry } from '../src/observability/metrics.js'

describe('Prometheus metrics registry', () => {
  it('renders counters, gauges and duration count/sum without sensitive labels', () => {
    const metrics = new MetricsRegistry()
    metrics.inc('relay_pair_attempts_total', { result: 'approved' })
    metrics.set('relay_rpc_inflight', 2)
    metrics.observe('relay_rpc_duration_seconds', 0.25, { operation: 'get:sessions', status: '200' })
    const text = metrics.render()
    expect(text).toContain('relay_pair_attempts_total{result="approved"} 1')
    expect(text).toContain('relay_rpc_inflight 2')
    expect(text).toContain('relay_rpc_duration_seconds_count{operation="get:sessions",status="200"} 1')
    expect(text).toContain('relay_rpc_duration_seconds_sum{operation="get:sessions",status="200"} 0.25')
  })
})
