/**
 * 桥接层服务门面（方案 §4.2 / §5.1 / §6）。
 *
 * 职责（S9-07 精简后）：
 * - 生命周期：start/stop/status（默认关闭，设置页显式开启，§6.1）；
 * - 配置持久化：bridgeConfig.json（enabled/host/port/bindIps，§4.2 多网卡）；
 * - 网络候选：os.networkInterfaces() 私有网段 IP 列表（设置页勾选绑定）；
 * - /sync/v1 LAN 同步端点由 BridgeServer 挂载（见 server.ts）。
 *
 * 旧伴侣配对 / 设备管理 / QR 码 / mDNS 广播 / WS 转发已随 /api/v1 一并删除（S9-07 P1-P3）。
 */
import { createHash } from 'node:crypto'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { DIRS } from '../services/storage'
import { BridgeServer } from './server'
import { createLogger } from '../services/logger'
import type { IpcMain } from 'electron'

const log = createLogger('bridge')

/** 桥接配置（持久化） */
export interface BridgeConfig {
  enabled: boolean
  /** 绑定 IP（多网卡候选之一；空 = 127.0.0.1） */
  host: string
  port: number
  /** 候选 IP 列表（供设置页勾选） */
  bindIps: string[]
}

const DEFAULT_CONFIG: BridgeConfig = { enabled: false, host: '', port: 8321, bindIps: [] }

function configFile(): string {
  return join(DIRS.config(), 'bridgeConfig.json')
}

/** 网络候选：私有网段 IPv4（过滤虚拟网卡 VMware/WSL/VPN 等，§4.2） */
export function getNetworkCandidates(): { ip: string; name: string }[] {
  const candidates: { ip: string; name: string }[] = []
  const interfaces = networkInterfaces()
  for (const [name, infos] of Object.entries(interfaces)) {
    if (/vmware|virtual|vethernet|wsl|vpn|loopback|hyper-v|tailscale|zerotier/i.test(name)) continue
    for (const info of infos ?? []) {
      if (info.family !== 'IPv4' || info.internal) continue
      const ip = info.address
      if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip)) {
        candidates.push({ ip, name })
      }
    }
  }
  return candidates
}

/**
 * 解析本次真正可绑定的地址。
 * 已保存地址只有仍属于当前候选网卡时才复用，避免换 Wi-Fi 后因旧 IP 导致 EADDRNOTAVAIL。
 */
export function resolveBridgeHost(
  configuredHost: string,
  candidates: { ip: string; name: string }[],
): string {
  if (configuredHost && candidates.some((candidate) => candidate.ip === configuredHost)) {
    return configuredHost
  }
  return candidates[0]?.ip || '127.0.0.1'
}

/** 本机指纹（hostname + MAC 哈希，稳定且不泄露原值） */
export function getMachineFingerprint(): string {
  const hostname = (process.env.COMPUTERNAME || process.env.HOSTNAME || 'pc').toString()
  const macs = Object.values(networkInterfaces())
    .flat()
    .map((i) => i?.mac ?? '')
    .filter((m) => m && m !== '00:00:00:00:00:00')
    .sort()
    .join(',')
  return createHash('sha256').update(`${hostname}|${macs}`).digest('hex').slice(0, 16)
}

export class BridgeService {
  private server: BridgeServer | null = null
  private config: BridgeConfig = { ...DEFAULT_CONFIG }

  constructor() {
    this.loadConfig()
  }

  // ===== 配置 =====

  private loadConfig(): void {
    try {
      const file = configFile()
      if (existsSync(file)) {
        const saved = JSON.parse(readFileSync(file, 'utf-8')) as Partial<BridgeConfig>
        this.config = { ...DEFAULT_CONFIG, ...saved }
      }
    } catch {
      this.config = { ...DEFAULT_CONFIG }
    }
  }

  private saveConfig(): void {
    writeFileSync(configFile(), JSON.stringify(this.config, null, 2))
  }

  getConfig(): BridgeConfig {
    return { ...this.config, bindIps: getNetworkCandidates().map((c) => c.ip) }
  }

  /** 更新配置（设置页：host/port/enabled） */
  setConfig(partial: Partial<Pick<BridgeConfig, 'enabled' | 'host' | 'port'>>): BridgeConfig {
    if (partial.port !== undefined) {
      const port = Number(partial.port)
      if (!Number.isInteger(port) || port < 1024 || port > 65535) {
        throw new Error('端口需在 1024-65535 之间')
      }
      this.config.port = port
    }
    if (partial.host !== undefined) this.config.host = partial.host
    if (partial.enabled !== undefined) this.config.enabled = partial.enabled
    this.saveConfig()
    return this.getConfig()
  }

  // ===== 生命周期 =====

  isRunning(): boolean {
    return this.server !== null
  }

  getBoundInfo(): { host: string; port: number } | null {
    return this.server
      ? { host: this.config.host || '127.0.0.1', port: this.config.port }
      : null
  }

  async start(): Promise<{ host: string; port: number }> {
    if (this.server) return this.getBoundInfo()!
    const host = resolveBridgeHost(this.config.host, getNetworkCandidates())
    if (host !== this.config.host) {
      this.config.host = host
      this.saveConfig()
    }
    const server = new BridgeServer()
    const handle = await server.start({ host, port: this.config.port })
    this.server = server
    if (handle.port !== this.config.port) {
      this.config.port = handle.port
      this.saveConfig()
    }
    this.config.enabled = true
    this.saveConfig()
    return handle
  }

  stop(): void {
    this.server?.stop()
    this.server = null
    this.config.enabled = false
    this.saveConfig()
    log.info('桥接服务已停用')
  }

  /** 清空配置（"退出时清除"联动） */
  wipeAll(): void {
    this.stop()
    log.info('桥接数据已清空')
  }

  /** 注销（应用退出） */
  dispose(): void {
    this.stop()
  }
}

/** 桥接服务单例（main.ts 挂载） */
export const bridgeService = new BridgeService()

/** 注册桥接 IPC（main.ts 调用；仅保留 /sync/v1 服务生命周期） */
export function registerBridgeIPC(ipcMainInstance: IpcMain): void {
  ipcMainInstance.handle('bridge:status', () => ({
    running: bridgeService.isRunning(),
    config: bridgeService.getConfig(),
    bound: bridgeService.getBoundInfo(),
  }))

  ipcMainInstance.handle('bridge:start', async () => {
    const handle = await bridgeService.start()
    return { ok: true, ...handle }
  })

  ipcMainInstance.handle('bridge:stop', () => {
    bridgeService.stop()
    return { ok: true }
  })

  ipcMainInstance.handle('bridge:config', (_e, partial: unknown) => {
    try {
      return { ok: true, config: bridgeService.setConfig((partial ?? {}) as never) }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMainInstance.handle('bridge:wipeAll', () => {
    bridgeService.wipeAll()
    return { ok: true }
  })
}
