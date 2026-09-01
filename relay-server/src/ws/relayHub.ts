import { WebSocketServer, WebSocket } from 'ws'
import type { Server } from 'node:http'
import type { IncomingMessage } from 'node:http'
import type { AccessTokenService, RelayAccessClaims } from '../auth/accessToken.js'
import { decodeFrame, encodeFrame, RelayProtocolError } from './frameCodec.js'
import { PcPresence } from '../routing/pcPresence.js'
import { RpcBroker } from '../routing/rpcBroker.js'
import { RELAY_FRAME_TYPES, relayFrame, type RelayBridgeEventPayload, type RelayRpcResponsePayload } from '../../../shared/relayProtocol.js'
import type { MetricsRegistry } from '../observability/metrics.js'

export class RelayHub {
  readonly presence = new PcPresence()
  readonly broker: RpcBroker
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 })
  private readonly android = new Map<string, Map<string, Set<WebSocket>>>()
  private readonly socketsByDevice = new Map<string, Set<WebSocket>>()
  private cacheHandler?: (spaceId: string, payload: unknown) => Promise<void>
  private pcReadyHandler?: (spaceId: string, socket: WebSocket) => Promise<void>

  constructor(private readonly tokens: AccessTokenService, private readonly validate?: (claims: RelayAccessClaims) => Promise<boolean>, private readonly metrics?: MetricsRegistry) {
    this.broker = new RpcBroker(metrics)
  }

  attach(server: Server): void {
    server.on('upgrade', (request, socket, head) => {
      const path = new URL(request.url ?? '/', 'http://relay.invalid').pathname
      const expectedRole = path === '/relay/v1/ws/pc' ? 'pc' : path === '/relay/v1/ws/android' ? 'android' : null
      if (!expectedRole) { socket.destroy(); return }
      this.authorize(request, expectedRole).then((claims) => {
        this.wss.handleUpgrade(request, socket, head, (ws) => this.connected(ws, claims))
      }).catch(() => { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy() })
    })
  }

  private async authorize(request: IncomingMessage, role: 'pc' | 'android'): Promise<RelayAccessClaims> {
    const header = request.headers.authorization ?? ''
    if (!header.startsWith('Bearer ')) throw new Error('unauthorized')
    const claims = await this.tokens.verify(header.slice(7))
    if (claims.role !== role) throw new Error('role mismatch')
    if (this.validate && !(await this.validate(claims))) throw new Error('device revoked')
    return claims
  }

  private connected(socket: WebSocket, claims: RelayAccessClaims): void {
    this.metrics?.inc('relay_ws_connections', { role: claims.role })
    const deviceSockets = this.socketsByDevice.get(claims.sub) ?? new Set<WebSocket>()
    deviceSockets.add(socket); this.socketsByDevice.set(claims.sub, deviceSockets)
    if (claims.role === 'pc') this.presence.set(claims.sid, socket)
    else {
      const devices = this.android.get(claims.sid) ?? new Map<string, Set<WebSocket>>()
      const sockets = devices.get(claims.sub) ?? new Set<WebSocket>()
      sockets.add(socket); devices.set(claims.sub, sockets); this.android.set(claims.sid, devices)
    }
    this.metrics?.set('relay_pc_online_spaces', this.presence.count())
    let lastPong = Date.now()
    const heartbeat = setInterval(() => {
      if (Date.now() - lastPong > 75_000) { socket.terminate(); return }
      if (socket.readyState === WebSocket.OPEN) socket.send(encodeFrame(relayFrame('connection:ping')))
    }, 25_000)
    socket.on('message', (raw) => {
      try {
        const frame = decodeFrame(Buffer.from(raw as Buffer))
        if (!RELAY_FRAME_TYPES.has(frame.type)) return
        if (frame.type === 'connection:pong') { lastPong = Date.now(); return }
        if (claims.role === 'pc' && frame.type === 'pc:hello') {
          socket.send(encodeFrame(relayFrame('pc:ready', { acceptedAt: Date.now() })))
          void this.pcReadyHandler?.(claims.sid, socket)
          return
        }
        if (claims.role === 'pc' && (frame.type === 'cache:snapshot' || frame.type === 'cache:delta')) {
          void this.cacheHandler?.(claims.sid, frame.payload).then(() => socket.send(encodeFrame(relayFrame('cache:accepted', { acceptedAt: Date.now() }))))
          return
        }
        if (claims.role === 'pc' && (frame.type === 'rpc:response' || frame.type === 'rpc:error')) {
          this.broker.accept(claims.sid, frame as typeof frame & { payload?: RelayRpcResponsePayload }); return
        }
        if (claims.role === 'pc' && frame.type === 'bridge:event') this.forwardEvent(claims.sid, frame.payload as RelayBridgeEventPayload)
      } catch (error) {
        const protocol = error instanceof RelayProtocolError ? error : new RelayProtocolError('invalid frame', 1007)
        socket.close(protocol.closeCode, protocol.message)
      }
    })
    socket.on('close', () => {
      clearInterval(heartbeat)
      const byDevice = this.socketsByDevice.get(claims.sub); byDevice?.delete(socket); if (!byDevice?.size) this.socketsByDevice.delete(claims.sub)
      if (claims.role === 'pc') this.presence.remove(claims.sid, socket)
      else {
        const devices = this.android.get(claims.sid); const sockets = devices?.get(claims.sub)
        sockets?.delete(socket); if (!sockets?.size) devices?.delete(claims.sub); if (!devices?.size) this.android.delete(claims.sid)
      }
      this.metrics?.inc('relay_ws_connections', { role: claims.role }, -1)
      this.metrics?.set('relay_pc_online_spaces', this.presence.count())
    })
  }

  private forwardEvent(spaceId: string, payload: RelayBridgeEventPayload): void {
    const frame = encodeFrame(relayFrame('bridge:event', payload))
    for (const [deviceId, sockets] of this.android.get(spaceId) ?? []) {
      if (payload.targetDeviceId && payload.targetDeviceId !== deviceId) continue
      for (const socket of sockets) if (socket.readyState === WebSocket.OPEN) socket.send(frame)
    }
  }

  publishAndroidEvent(spaceId: string, event: string, data: unknown, targetDeviceId?: string): void {
    this.forwardEvent(spaceId, { eventSeq: Date.now(), event, data, targetDeviceId })
  }

  sendToPc(spaceId: string, type: string, payload: unknown): boolean {
    const socket = this.presence.get(spaceId)
    if (!socket) return false
    socket.send(encodeFrame(relayFrame(type, payload)))
    return true
  }

  disconnectDevice(deviceId: string): void {
    for (const socket of this.socketsByDevice.get(deviceId) ?? []) socket.close(4401, 'device revoked')
    this.socketsByDevice.delete(deviceId)
  }

  setCacheHandler(handler: (spaceId: string, payload: unknown) => Promise<void>): void { this.cacheHandler = handler }
  setPcReadyHandler(handler: (spaceId: string, socket: WebSocket) => Promise<void>): void { this.pcReadyHandler = handler }
}
