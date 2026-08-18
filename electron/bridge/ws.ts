/**
 * 桥接层 WebSocket 模块（方案 §4.3 流式协议）。
 *
 * 帧格式：{ event, payload }（与安卓端 WsEnvelope 对齐）：
 * - 服务端 -> 客户端：ai:chunk / ai:done / ai:error / ai:usage / session:updated / connection:heartbeat
 * - 客户端 -> 服务端：ai:stop（停止生成，携带 requestId）/ connection:pong（心跳响应）
 *
 * 鉴权：ws://host:port/ws?token=xxx（JWT 校验，§6.2 仅令牌访问）。
 *
 * 心跳机制：
 * - 服务端每 WS_PING_INTERVAL 发送 connection:heartbeat
 * - 客户端应回复 connection:pong
 * - 超过 WS_PONG_TIMEOUT 未收到 pong，主动断开（防半开连接）
 */
import { createServer } from 'node:http'
import { WebSocketServer, WebSocket } from 'ws'
import { verifyToken, touchDevice } from './auth'
import { createLogger } from '../services/logger'
import { sanitizeApiKey } from '../utils/pathGuard'

const log = createLogger('bridge-ws')

// === 心跳与连接配置 ===
const WS_PING_INTERVAL = 30_000   // ping 间隔（ms）
const WS_PONG_TIMEOUT = 60_000    // pong 超时（ms），超时主动断开
const WS_MAX_CLIENTS = 10         // 最大并发连接数

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
      // 连接数上限
      if (this.clients.size >= WS_MAX_CLIENTS) {
        log.warn('WS 连接数超限，拒绝新连接', { current: this.clients.size, max: WS_MAX_CLIENTS })
        socket.close(1011, 'too many connections')
        return
      }

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

      // 心跳：ping + pong 超时检测
      let lastPongAt = Date.now()
      const heartbeat = setInterval(() => {
        if (socket.readyState !== WebSocket.OPEN) return

        // 检查 pong 超时
        if (Date.now() - lastPongAt > WS_PONG_TIMEOUT) {
          log.warn('WS pong 超时，主动断开', { deviceId: payload.deviceId })
          socket.terminate()
          return
        }

        // 发送 ping
        try {
          socket.send(JSON.stringify({ event: 'connection:heartbeat' }))
        } catch {
          // 发送失败，连接可能已断
        }
      }, WS_PING_INTERVAL)

      socket.on('message', (raw) => {
        try {
          const frame = JSON.parse(raw.toString()) as WsEnvelope
          if (frame.event === 'connection:pong') {
            lastPongAt = Date.now()
            return
          }
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
