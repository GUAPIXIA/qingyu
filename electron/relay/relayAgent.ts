import { app } from 'electron'
import { WebSocket } from 'ws'
import { randomUUID } from 'node:crypto'
import type { MobileEventSink } from '../bridge/runtime/mobileEventBus'
import type { RelayFrame, RelayRpcRequestPayload } from '../../shared/relayProtocol'
import { decodeRelayFrame, relayFrame } from './relayProtocol'
import { RelayBackoff } from './relayBackoff'
import { RelayRpcDispatcher } from './relayRpcDispatcher'
import { createLogger } from '../services/logger'

export type RelayStatus =
  | { state: 'Disabled' }
  | { state: 'Registering' | 'Connecting' | 'Online' | 'NeedsAuth' | 'ServiceUnavailable'; baseUrl: string; spaceId?: string }
  | { state: 'Reconnecting'; baseUrl: string; spaceId?: string; attempt: number; nextAt: number }

export interface RelayAgentCredentials { baseUrl: string; spaceId: string; deviceId: string; accessToken: string; accessTokenExpiresAt: number }

const log = createLogger('relay-agent')
export class RelayAgent implements MobileEventSink {
  private socket: WebSocket | null = null
  private statusValue: RelayStatus = { state: 'Disabled' }
  private readonly backoff = new RelayBackoff()
  private reconnectTimer: NodeJS.Timeout | null = null
  private stopping = false
  private listeners = new Set<(status: RelayStatus) => void>()
  private pairListeners = new Set<(request: { requestId: string; deviceName: string; expiresAt: number }) => void>()
  private onlineListeners = new Set<() => void>()
  constructor(private credentials: RelayAgentCredentials | null, private readonly dispatcher: RelayRpcDispatcher) {}
  get status(): RelayStatus { return this.statusValue }
  onStatus(listener: (status: RelayStatus) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  onPairRequest(listener: (request: { requestId: string; deviceName: string; expiresAt: number }) => void): () => void { this.pairListeners.add(listener); return () => this.pairListeners.delete(listener) }
  onOnline(listener: () => void): () => void { this.onlineListeners.add(listener); return () => this.onlineListeners.delete(listener) }
  setCredentials(credentials: RelayAgentCredentials): void { this.credentials = credentials }
  async start(): Promise<void> { this.stopping = false; this.backoff.reset(); await this.connect() }
  async stop(): Promise<void> {
    this.stopping = true; if (this.reconnectTimer) clearTimeout(this.reconnectTimer); this.reconnectTimer = null
    this.socket?.close(1000, 'app shutdown'); this.socket = null; this.setStatus({ state: 'Disabled' })
  }
  publish(event: string, payload?: unknown, targetDeviceId?: string): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return
    this.socket.send(JSON.stringify(relayFrame('bridge:event', { eventSeq: 0, event, data: payload, targetDeviceId })))
  }
  sendFrame(type: string, payload?: unknown): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(relayFrame(type, payload, randomUUID())))
  }
  private async connect(): Promise<void> {
    const credential = this.credentials
    if (!credential) { this.setStatus({ state: 'NeedsAuth', baseUrl: '' }); return }
    this.setStatus({ state: 'Connecting', baseUrl: credential.baseUrl, spaceId: credential.spaceId })
    const url = new URL('/relay/v1/ws/pc', credential.baseUrl); url.protocol = 'wss:'
    const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${credential.accessToken}` }, maxPayload: 256 * 1024 })
    this.socket = socket
    socket.on('open', () => {
      this.backoff.reset(); this.setStatus({ state: 'Online', baseUrl: credential.baseUrl, spaceId: credential.spaceId })
      socket.send(JSON.stringify(relayFrame('pc:hello', { deviceId: credential.deviceId, appVersion: app.getVersion(), protocolVersion: 1, capabilities: ['relay.rpc'] }, randomUUID())))
      for (const listener of this.onlineListeners) listener()
    })
    socket.on('message', (raw) => { this.handleFrame(decodeRelayFrame(Buffer.from(raw as Buffer))).catch((error) => log.warn('Relay 帧处理失败', { error: (error as Error).message })) })
    socket.on('close', (code) => { if (this.socket === socket) this.socket = null; if (this.stopping) return; if (code === 4001 || code === 4401 || code === 4403) { this.setStatus({ state: 'NeedsAuth', baseUrl: credential.baseUrl, spaceId: credential.spaceId }); return } this.scheduleReconnect() })
    socket.on('error', () => { /* close drives retry */ })
  }
  private async handleFrame(frame: RelayFrame): Promise<void> {
    if (frame.type === 'connection:ping') { this.socket?.send(JSON.stringify(relayFrame('connection:pong', undefined, randomUUID()))); return }
    if (frame.type === 'rpc:cancel') { const requestId = (frame.payload as { requestId?: string })?.requestId; if (requestId) await this.dispatcher.cancel(requestId); return }
    if (frame.type === 'pair:requested') {
      const request = frame.payload as { requestId?: string; deviceName?: string; expiresAt?: number }
      if (request.requestId && request.deviceName) for (const listener of this.pairListeners) listener({ requestId: request.requestId, deviceName: request.deviceName, expiresAt: request.expiresAt ?? Date.now() + 300_000 })
      return
    }
    if (frame.type !== 'rpc:request' || !frame.id) return
    const response = await this.dispatcher.dispatch(frame.payload as RelayRpcRequestPayload)
    this.socket?.send(JSON.stringify({ v: 1, type: 'rpc:response', id: randomUUID(), replyTo: frame.id, sentAt: Date.now(), payload: response } satisfies RelayFrame))
  }
  private scheduleReconnect(): void {
    const next = this.backoff.next(); const credential = this.credentials; if (!credential) return
    const nextAt = Date.now() + next.delayMs
    this.setStatus({ state: 'Reconnecting', baseUrl: credential.baseUrl, spaceId: credential.spaceId, attempt: next.attempt, nextAt })
    this.reconnectTimer = setTimeout(() => this.connect().catch(() => this.scheduleReconnect()), next.delayMs)
  }
  private setStatus(status: RelayStatus): void { this.statusValue = status; for (const listener of this.listeners) listener(status) }
}
