/**
 * 桥接层 mDNS/DNS-SD 广播（方案 §5.1 自动发现锦上添花）。
 *
 * 服务类型 `_qingyu._tcp`（与安卓端 NsdDiscovery 对齐），bonjour-service 纯 JS 实现，
 * 无原生依赖。开启「手机连接」时广播，停止时取消。
 */
import { Bonjour, type Service } from 'bonjour-service'
import { hostname } from 'node:os'
import { createLogger } from '../services/logger'

const log = createLogger('bridge-mdns')

export class MdnsAdvertiser {
  private bonjour: Bonjour | null = null
  private service: Service | null = null

  /** 发布 _qingyu._tcp 服务（幂等：重复调用先取消旧服务） */
  start(port: number): void {
    this.stop()
    try {
      const bonjour = new Bonjour()
      const name = `qingyu-pc-${hostname().replace(/[^a-zA-Z0-9-]/g, '').slice(0, 20) || 'pc'}`
      const service = bonjour.publish({
        name,
        type: 'qingyu',
        protocol: 'tcp',
        port,
        txt: { api: '1', app: 'qingyu' },
      })
      this.bonjour = bonjour
      this.service = service
      log.info('mDNS 广播已启动', { name, type: '_qingyu._tcp', port })
    } catch (e) {
      // mDNS 不可用（网络受限/多播被禁）不阻塞桥接服务
      log.warn('mDNS 广播启动失败', { error: (e as Error).message })
      this.bonjour = null
      this.service = null
    }
  }

  stop(): void {
    try {
      this.service?.stop()
      this.bonjour?.destroy()
    } catch {
      // 忽略
    }
    this.bonjour = null
    this.service = null
  }
}
