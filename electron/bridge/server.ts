/**
 * 桥接层 HTTP 服务生命周期（方案 §4.2）。
 *
 * - express + ws（/ws?token=xxx 鉴权），默认仅绑定指定局域网接口 IP；
 * - 端口默认 8321，冲突自动递增（最大尝试 +10）；
 * - 会话变更通知：注入回调（index.ts 负责广播渲染层 + WS 转发）。
 */
import express, { type Express } from 'express'
import { createServer, type Server } from 'node:http'
import { WsHub } from './ws'
import { buildBridgeRouter, API_VERSION, originGuard } from './routes'
import { buildStaticRouter } from './static'
import { BridgeChatService, type SessionChangedNotifier } from './chatService'
import { createLogger } from '../services/logger'

const log = createLogger('bridge-server')

export interface BridgeServerConfig {
  /** 绑定地址：具体局域网 IP；缺省 127.0.0.1（安全默认，不绑 0.0.0.0） */
  host?: string
  /** 首选端口（默认 8321） */
  port?: number
}

export interface BridgeServerHandle {
  port: number
  host: string
}

export class BridgeServer {
  private app: Express
  private httpServer: Server | null = null
  private hub: WsHub
  private chatService: BridgeChatService

  constructor(
    notifySessionChanged: SessionChangedNotifier,
    onPairRequest: (requestId: string, deviceName: string) => void = () => {},
  ) {
    this.hub = new WsHub()
    this.chatService = new BridgeChatService(this.hub, notifySessionChanged)
    this.app = express()
    this.app.use(express.json({ limit: '10mb' }))
    this.app.use('/api/v1', buildBridgeRouter(this.hub, this.chatService, notifySessionChanged, onPairRequest))
    // H1 修复：/static 媒体路由此前挂在认证路由之外，任何 LAN 主机可无认证读取聊天图片/
    // 角色素材。先挂 originGuard（阻断浏览器跨站 fetch 盗读，PC/安卓原生加载不受影响）；
    // 完整修复（requireAuth + 客户端携带 token）需同步改 PC/安卓图片加载方式，见审计 H1。
    this.app.use('/static', originGuard, buildStaticRouter())
    // 兜底 404
    this.app.use((_req, res) => {
      res.status(404).json({ error: 'not found' })
    })
  }

  /** 启动（端口冲突自动递增） */
  async start(config: BridgeServerConfig = {}): Promise<BridgeServerHandle> {
    const host = config.host ?? '127.0.0.1'
    const preferredPort = config.port ?? 8321

    for (let attempt = 0; attempt < 10; attempt++) {
      const port = preferredPort + attempt
      try {
        await new Promise<void>((resolve, reject) => {
          const server = createServer(this.app)
          server.once('error', (err: NodeJS.ErrnoException) => {
            if (err.code === 'EADDRINUSE') {
              reject(err)
            } else {
              reject(err)
            }
          })
          server.listen(port, host, () => resolve())
          this.httpServer = server
        })
        if (!this.httpServer) throw new Error('服务器初始化失败')
        this.hub.attach(this.httpServer)
        log.info('桥接服务已启动', { host, port, apiVersion: API_VERSION })
        return { host, port }
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code === 'EADDRINUSE') {
          log.warn(`端口 ${port} 被占用，尝试 ${port + 1}`)
          continue
        }
        throw err
      }
    }
    throw new Error('端口冲突：连续 10 个端口均被占用')
  }

  get clientCount(): number {
    return this.hub.clientCount
  }

  /** WS 广播（会话变更转推） */
  broadcast(event: string, payload?: unknown): void {
    this.hub.broadcast(event, payload)
  }

  /** 停止 */
  stop(): void {
    this.hub.close()
    this.httpServer?.close()
    this.httpServer = null
    log.info('桥接服务已停止')
  }
}
