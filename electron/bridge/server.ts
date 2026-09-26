/**
 * 桥接层 HTTP 服务生命周期（方案 §4.2）。
 *
 * - express + /sync/v1 LAN 同步端点（S9-07：旧 /api/v1 伴侣业务面已删除）；
 * - 端口默认 8321，冲突自动递增（最大尝试 +10）；
 * - 默认仅绑定指定局域网接口 IP。
 */
import express, { type Express } from 'express'
import { createServer, type Server } from 'node:http'
import { mountSyncV1 } from './syncRoutes'
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

  constructor() {
    this.app = express()
    this.app.use(express.json({ limit: '10mb' }))
    // S7-04：独立 /sync/v1（LAN 同步会话鉴权，不复用 Bridge JWT / Relay allowlist）
    mountSyncV1(this.app)
    // 兜底 404（旧 /api/v1 伴侣业务面已删除，不再提供）
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
            reject(err)
          })
          server.listen(port, host, () => resolve())
          this.httpServer = server
        })
        if (!this.httpServer) throw new Error('服务器初始化失败')
        log.info('桥接服务已启动', { host, port })
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

  /** 停止 */
  stop(): void {
    this.httpServer?.close()
    this.httpServer = null
    log.info('桥接服务已停止')
  }
}
