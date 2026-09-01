import { WebSocket } from 'ws'

export class PcPresence {
  private readonly sockets = new Map<string, WebSocket>()
  set(spaceId: string, socket: WebSocket): void {
    this.sockets.get(spaceId)?.close(4409, 'pc replaced')
    this.sockets.set(spaceId, socket)
  }
  get(spaceId: string): WebSocket | undefined {
    const socket = this.sockets.get(spaceId)
    return socket?.readyState === WebSocket.OPEN ? socket : undefined
  }
  remove(spaceId: string, socket: WebSocket): void { if (this.sockets.get(spaceId) === socket) this.sockets.delete(spaceId) }
  count(): number { return this.sockets.size }
}
