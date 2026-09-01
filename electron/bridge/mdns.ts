/**
 * 桥接层 mDNS/DNS-SD 广播（方案 §5.1 自动发现锦上添花；阶段 D-04 扩展 TXT）。
 *
 * 服务类型 `_qingyu._tcp`（与安卓端 NsdDiscovery 对齐），bonjour-service 纯 JS 实现，
 * 无原生依赖。开启「手机连接」时广播，停止时取消。
 *
 * D-04：TXT 字段广播 serverId / apiVersion / pairVersion / tls / displayName，
 * 安卓发现后按 serverId 合并多地址（同一 PC 多网卡/双频 Wi-Fi 去重）。
 */
import { Bonjour, type Service } from 'bonjour-service'
import { hostname } from 'node:os'
import { createLogger } from '../services/logger'
import { API_VERSION, PAIR_VERSION, TLS_ENABLED } from './protocol'
import { getServerId, getServerDisplayName } from './identity'

const log = createLogger('bridge-mdns')

export interface MdnsTxtData {
  serverId: string
  apiVersion: string
  pairVersion: string
  tls: string
  displayName: string
}

/** 构造 D-04 TXT 记录（纯函数，便于单测） */
export function buildMdnsTxt(
  serverId: string,
  apiVersion: number,
  pairVersion: number,
  tls: boolean,
  displayName: string,
): MdnsTxtData {
  return {
    serverId,
    apiVersion: String(apiVersion),
    pairVersion: String(pairVersion),
    tls: tls ? '1' : '0',
    displayName,
  }
}

export class MdnsAdvertiser {
  private bonjour: Bonjour | null = null
  private service: Service | null = null

  /** 发布 _qingyu._tcp 服务（幂等：重复调用先取消旧服务） */
  start(port: number): void {
    this.stop()
    try {
      const bonjour = new Bonjour()
      const name = `qingyu-pc-${hostname().replace(/[^a-zA-Z0-9-]/g, '').slice(0, 20) || 'pc'}`
      const txt = buildMdnsTxt(getServerId(), API_VERSION, PAIR_VERSION, TLS_ENABLED, getServerDisplayName())
      const service = bonjour.publish({
        name,
        type: 'qingyu',
        protocol: 'tcp',
        port,
        txt: { api: '1', app: 'qingyu', ...txt },
      })
      this.bonjour = bonjour
      this.service = service
      log.info('mDNS 广播已启动', { name, type: '_qingyu._tcp', port, serverId: txt.serverId })
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
