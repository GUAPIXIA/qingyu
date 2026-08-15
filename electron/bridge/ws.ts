/**
 * 桥接层 WebSocket 模块（方案 §4.3 流式协议）。
 *
 * 帧格式：{ event, payload }（与安卓端 WsEnvelope 对齐）：
 * - 服务端 -> 客户端：ai:chunk / ai:done / ai:error / ai:usage / session:updated / connection:heartbeat
 * - 客户端 -> 服务端：ai:stop（停止生成，携带 requestId）
 *
 * 鉴权：ws://host:port/ws?token=xxx（JWT 校验，§6.2 仅令牌访问）。
 */
import { createServer } from 'node:http'
import { WebSocketServer, WebSocket } from 'ws'
import { verifyToken, touchDevice } from './auth'
import { createLogger } from '../services/logger'
import { sanitizeApiKey } from '../utils/pathGuard'

const log = createLogger('bridge-ws')

export interface WsEnvelope {
  event: string
  payload?: unknown
}

/** 活跃请求的取消句柄：requestId -> AbortController（客户端 ai:stop 驱动） */
export const activeChatControllers = new Map<string, AbortController>()

export class WsHub {
  private wss: WebSocketServer | null = null
  private readonly clients = new Set<WebSocket>()

  /** 挂载到 HTTP server */
  attach(server: ReturnType<typeof createServer>, path = '/ws'): void {
    this.wss = new WebSocketServer({ server, path })
    this.wss.on('connection', (socket, request) => {
      // token 校验（query 参数）
      const url = new URL(request.url ?? '', 'http://localhost')
      const token = url.searchParams.get('token') ?? ''
      const payload = verifyToken(token)
      if (!payload) {
        socket.close(4001, 'unauthorized')
        return
      }
      touchDevice(payload.deviceId)
      this.clients.add(socket)
      log.info('设备已连接', { deviceId: payload.deviceId, clients: this.clients.size })

      // 心跳（服务端主动，客户端可忽略）
      const heartbeat = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ event: 'connection:heartbeat' }))
        }
      }, 30_000)

      socket.on('message', (raw) => {
        try {
          const frame = JSON.parse(raw.toString()) as WsEnvelope
          if (frame.event === 'ai:stop' && typeof frame.payload === 'object' && frame.payload !== null) {
            const requestId = (frame.payload as { requestId?: string }).requestId
            if (requestId) {
              activeChatControllers.get(requestId)?.abort()
              activeChatControllers.delete(requestId)
              log.info('客户端请求停止生成', { requestId })
            }
          }
        } catch { /* 忽略非法帧 */ }
      })

      socket.on('close', () => {
        clearInterval(heartbeat)
        this.clients.delete(socket)
        log.info('设备断开', { clients: this.clients.size })
      })
      socket.on('error', (err) => {
        log.warn('WS 错误', { error: sanitizeApiKey(err.message) })
      })
    })
  }

  /** 广播事件给全部已连接设备 */
  broadcast(event: string, payload?: unknown): void {
    const frame = JSON.stringify({ event, payload } satisfies WsEnvelope)
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.send(frame)
        } catch (err) {
          log.warn('WS 推送失败', { error: (err as Error).message })
        }
      }
    }
  }

  get clientCount(): number {
    return this.clients.size
  }

  close(): void {
    for (const client of this.clients) {
      client.terminate()
    }
    this.clients.clear()
    this.wss?.close()
    this.wss = null
  }
}
