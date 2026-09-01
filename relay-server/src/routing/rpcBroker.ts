import { randomUUID } from 'node:crypto'
import type { WebSocket } from 'ws'
import { encodeFrame } from '../ws/frameCodec.js'
import type { RelayFrame, RelayRpcRequestPayload, RelayRpcResponsePayload } from '../../../shared/relayProtocol.js'
import type { MetricsRegistry } from '../observability/metrics.js'

interface Pending { resolve: (value: RelayRpcResponsePayload) => void; reject: (error: Error) => void; timer: NodeJS.Timeout; spaceId: string; startedAt: number; operation: string }

export class RpcBroker {
  private readonly pending = new Map<string, Pending>()
  private readonly inflightBySpace = new Map<string, number>()
  constructor(private readonly metrics?: MetricsRegistry) {}

  request(spaceId: string, pc: WebSocket, payload: RelayRpcRequestPayload, timeoutMs = 60_000): Promise<RelayRpcResponsePayload> {
    const inflight = this.inflightBySpace.get(spaceId) ?? 0
    if (inflight >= 16) return Promise.reject(new Error('RATE_LIMITED'))
    const requestId = randomUUID()
    this.inflightBySpace.set(spaceId, inflight + 1)
    this.updateInflightMetric()
    const frame: RelayFrame<RelayRpcRequestPayload> = { v: 1, type: 'rpc:request', id: requestId, sentAt: Date.now(), payload }
    return new Promise((resolve, reject) => {
      const startedAt = Date.now(); const operation = `${payload.method.toLowerCase()}:${payload.path.split('/').slice(0, 5).join('/')}`
      const timer = setTimeout(() => { this.observe(requestId, 'timeout'); this.finish(requestId); reject(new Error('RPC_TIMEOUT')) }, timeoutMs)
      this.pending.set(requestId, { resolve, reject, timer, spaceId, startedAt, operation })
      try { pc.send(encodeFrame(frame)) } catch (error) { this.finish(requestId); reject(error) }
    })
  }

  accept(spaceId: string, frame: RelayFrame<RelayRpcResponsePayload>): boolean {
    if (!frame.replyTo) return false
    const pending = this.pending.get(frame.replyTo)
    if (!pending || pending.spaceId !== spaceId) return false
    this.observe(frame.replyTo, String(frame.payload?.status ?? 500))
    this.finish(frame.replyTo)
    pending.resolve(frame.payload ?? { status: 500, headers: {}, body: { error: 'empty response' } })
    return true
  }

  private finish(requestId: string): void {
    const pending = this.pending.get(requestId)
    if (!pending) return
    clearTimeout(pending.timer); this.pending.delete(requestId)
    this.inflightBySpace.set(pending.spaceId, Math.max(0, (this.inflightBySpace.get(pending.spaceId) ?? 1) - 1))
    this.updateInflightMetric()
  }

  private observe(requestId: string, status: string): void {
    const pending = this.pending.get(requestId); if (!pending) return
    this.metrics?.observe('relay_rpc_duration_seconds', (Date.now() - pending.startedAt) / 1000, { operation: pending.operation, status })
  }

  private updateInflightMetric(): void {
    this.metrics?.set('relay_rpc_inflight', [...this.inflightBySpace.values()].reduce((sum, value) => sum + value, 0))
  }
}
