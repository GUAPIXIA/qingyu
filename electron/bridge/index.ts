/**
 * 桥接层服务门面（方案 §4.2 / §5.1 / §6）。
 *
 * 职责：
 * - 生命周期：start/stop/status（默认关闭，设置页显式开启，§6.1）；
 * - 配置持久化：bridgeConfig.json（enabled/host/port/bindIps，§4.2 多网卡）；
 * - 网络候选：os.networkInterfaces() 私有网段 IP 列表（设置页勾选绑定）；
 * - 配对：二维码数据（配对码 + host + port）、审批确认（渲染层弹窗 -> approve/reject）；
 * - 事件：会话变更 -> 渲染层广播 + WS 转发。
 */
import { randomBytes, createHash } from 'node:crypto'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { BrowserWindow } from 'electron'
import { DIRS } from '../services/storage'
import { IPC_EVENTS } from '../../shared/ipc-channels'
import { BridgeServer } from './server'
import { MdnsAdvertiser } from './mdns'
import { API_VERSION, SERVER_CAPABILITIES, PAIR_CODE_TTL_SEC, TLS_ENABLED } from './protocol'
import { getServerId, getServerDisplayName } from './identity'
import { buildPairingQrV2, buildPairingQrLegacy, type PairingQrEndpoint } from '../../shared/pairingQr'
import { subscribeSettingsChanges } from '../services/settingsChangeBus'
import type { PairingInfo } from '../../shared/ipc-api'
import {
  generatePairingCode,
  listDevices,
  revokeDevice,
  settlePair,
  getPendingPair,
  wipeDevices,
  isPairingCodeValid,
  getPairingCodeExpiry,
  revokePairingCode,
  getJwtSecret,
} from './auth'
import { createLogger } from '../services/logger'
import { safeId } from '../utils/pathGuard'
import type { IpcMain } from 'electron'
import { BridgeRuntime } from './runtime/bridgeRuntime'

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
    // 虚拟交换机/VPN 地址通常无法被同一局域网中的手机直接访问。
    if (/vmware|virtual|vethernet|wsl|vpn|loopback|hyper-v|tailscale|zerotier/i.test(name)) continue
    for (const info of infos ?? []) {
      if (info.family !== 'IPv4' || info.internal) continue
      const ip = info.address
      // 仅私有网段
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

/**
 * C-04 防回环判定：change bus 事件是否应由桥接层再次广播到 WS。
 * - 'pc' 来源（PC UI 保存）：需要转发，让手机感知；
 * - 'android:<id>' 来源：安卓 PATCH 已在桥接路径广播过（写一次、广播一次），
 *   再转发会造成事件回显/无限循环，必须跳过。
 */
export function shouldBroadcastSettingsToWs(source: 'pc' | `android:${string}`): boolean {
  return source === 'pc'
}

/** 本机指纹（二维码校验用；hostname + MAC 哈希，稳定且不泄露原值） */
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
  private mdns: MdnsAdvertiser | null = null
  private config: BridgeConfig = { ...DEFAULT_CONFIG }
  /** 当前生效的配对码（二维码内容） */
  private pairingCode = ''
  private readonly runtime: BridgeRuntime

  /** 会话变更通知：广播渲染层 + WS（由本服务统一转发） */
  private onSessionChanged = (sessionId: string, change: string): void => {
    const payload = { sessionId, change }
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed() && win.webContents) {
        win.webContents.send(IPC_EVENTS.sessionUpdated, payload)
      }
    }
    this.server?.broadcast('session:updated', payload)
  }

  constructor() {
    this.runtime = new BridgeRuntime(this.onSessionChanged)
    this.loadConfig()
    // C-04：PC UI 保存设置（settings:save IPC）-> change bus -> WS settings:updated。
    // 防回环：安卓来源事件由桥接 PATCH 路径直接广播，此处不重复转发
    //（写一次、广播一次——避免 Android 来源的 PATCH 再触发一轮 PC 侧通知）。
    subscribeSettingsChanges((event) => {
      if (!shouldBroadcastSettingsToWs(event.source)) return
      this.server?.broadcast('settings:updated', {
        revision: event.revision,
        changedFields: event.changedFields,
        sourceDeviceId: 'pc',
      })
    })
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

  getBoundInfo(): { host: string; port: number; clientCount: number } | null {
    return this.server
      ? { host: this.config.host || '127.0.0.1', port: this.config.port, clientCount: this.server.clientCount }
      : null
  }

  async start(): Promise<{ host: string; port: number }> {
    if (this.server) return this.getBoundInfo()!
    // 启动前验证/迁移安全密钥；生产环境 safeStorage 不可用时直接拒绝开放局域网端口。
    getJwtSecret()
    const host = resolveBridgeHost(this.config.host, getNetworkCandidates())
    // 网卡地址可能在应用运行期间变化；把自动恢复后的地址持久化并用于二维码。
    if (host !== this.config.host) {
      this.config.host = host
      this.saveConfig()
    }
    // 配对审批 -> 通知渲染层弹窗（方案 §5.1 PC 侧人工确认）
    const onPairRequest = (requestId: string, deviceName: string): void => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed() && win.webContents) {
          win.webContents.send('bridge:pairRequest', { requestId, deviceName })
        }
      }
    }
    const server = new BridgeServer(this.onSessionChanged, onPairRequest, this.runtime)
    const handle = await server.start({ host, port: this.config.port })
    this.server = server
    // mDNS 自动发现广播（_qingyu._tcp，锦上添花；失败不阻塞）
    this.mdns = new MdnsAdvertiser()
    this.mdns.start(handle.port)
    // 生效端口回写配置
    if (handle.port !== this.config.port) {
      this.config.port = handle.port
      this.saveConfig()
    }
    this.config.enabled = true
    this.saveConfig()
    return handle
  }

  stop(): void {
    this.mdns?.stop()
    this.mdns = null
    this.server?.stop()
    this.server = null
    this.config.enabled = false
    this.saveConfig()
    log.info('桥接服务已停用')
  }

  /**
   * 获取配对信息（QR v2 数据源；阶段 D-02）。
   * regenerate=true 强制生成新配对码；否则复用当前码，但当前码已消费/过期时自动重生成。
   * 旧字段 host/port/fingerprint/expiresInSec 逐字节保持兼容；
   * serverId/capabilities/expiresAt/endpoints 为 v2 增量（旧渲染层/客户端忽略即可）。
   */
  getPairingInfo(regenerate = false): PairingInfo {
    const invalid = this.pairingCode && !isPairingCodeValid(this.pairingCode)
    if (regenerate || !this.pairingCode || invalid) {
      // 强制重新生成时先作废旧码（防旧码仍可扫码配对）
      if (this.pairingCode && regenerate) {
        revokePairingCode(this.pairingCode)
      }
      this.pairingCode = generatePairingCode()
      log.info(regenerate ? '已重新生成配对码' : '已生成新配对码')
    }
    // host 优先取绑定网卡，其次第一个局域网候选 IP（避免扫码连到 127.0.0.1）
    const candidates = getNetworkCandidates()
    const host = resolveBridgeHost(this.config.host, candidates)
    const security: PairingQrEndpoint['security'] = TLS_ENABLED ? 'TLS' : 'LOCAL_CLEARTEXT'
    const endpoints: PairingQrEndpoint[] = [{ host, port: this.config.port, security }]
    // 多网卡时附带其余候选地址（安卓端可按可达性择优重试）
    for (const candidate of candidates) {
      if (candidate.ip !== host) {
        endpoints.push({ host: candidate.ip, port: this.config.port, security })
      }
    }
    const expiresAt = getPairingCodeExpiry(this.pairingCode) ?? Date.now() + PAIR_CODE_TTL_SEC * 1000
    return {
      host,
      port: this.config.port,
      fingerprint: this.pairingCode,
      expiresInSec: Math.max(0, Math.round((expiresAt - Date.now()) / 1000)),
      serverId: getServerId(),
      displayName: getServerDisplayName(),
      apiVersion: API_VERSION,
      // QR v2 能力集合与 /server/info 一致（安卓端扫码即可协商，无需先拉 info）
      capabilities: [...SERVER_CAPABILITIES],
      expiresAt,
      endpoints,
    }
  }

  // ===== 设备管理 =====

  /**
   * 生成配对二维码载荷 JSON（D-02）。
   * mode='v2'（默认）：QR v2（serverId/capabilities/expiresAt/endpoints/certificatePin:null）；
   * mode='legacy'：旧格式 {host,port,fingerprint}（旧 Android 至少一个发布周期兼容）。
   * 两种模式的配对码同为当前一次性 pairingCode，扫码后走同一 POST /auth/pair。
   */
  getPairingQrPayload(mode: 'v2' | 'legacy' = 'v2'): string {
    const info = this.getPairingInfo()
    if (mode === 'legacy') {
      return JSON.stringify(buildPairingQrLegacy(info.host, info.port, info.fingerprint))
    }
    return JSON.stringify(buildPairingQrV2({
      serverId: info.serverId ?? getServerId(),
      displayName: info.displayName ?? getServerDisplayName(),
      apiVersion: info.apiVersion ?? API_VERSION,
      capabilities: info.capabilities ?? [...SERVER_CAPABILITIES],
      pairingCode: info.fingerprint,
      expiresAt: info.expiresAt ?? Date.now() + PAIR_CODE_TTL_SEC * 1000,
      endpoints: info.endpoints ?? [{ host: info.host, port: info.port, security: TLS_ENABLED ? 'TLS' : 'LOCAL_CLEARTEXT' }],
    }))
  }

  listDevices() {
    return listDevices()
  }

  revokeDevice(deviceId: string): boolean {
    const safeDeviceId = safeId(deviceId)
    const revoked = revokeDevice(safeDeviceId)
    if (revoked) this.server?.disconnectDevice(safeDeviceId)
    return revoked
  }

  /** 审批配对（渲染层弹窗确认后调用） */
  approvePair(requestId: string): boolean {
    return settlePair(requestId, true)
  }

  rejectPair(requestId: string): boolean {
    return settlePair(requestId, false)
  }

  /** 清空全部设备与配对码（"退出时清除"联动） */
  wipeAll(): void {
    this.stop()
    wipeDevices()
    this.pairingCode = ''
    log.info('桥接数据已清空')
  }

  /** 转发渲染层上报的会话变更到 WS（主进程 session:changed 处理调用） */
  broadcastSessionChange(sessionId: string, change: string): void {
    this.server?.broadcast('session:updated', { sessionId, change })
  }

  /** 注销（应用退出） */
  dispose(): void {
    this.stop()
    this.runtime.dispose()
  }

  /** LAN 与 Relay 共用的唯一移动业务运行时。 */
  getRuntime(): BridgeRuntime {
    return this.runtime
  }
}

/** 桥接服务单例（main.ts 挂载） */
export const bridgeService = new BridgeService()

/** 注册桥接 IPC（main.ts 调用；设置页「手机连接」面板消费） */
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

  ipcMainInstance.handle('bridge:pairingInfo', (_e, regenerate?: boolean) =>
    bridgeService.getPairingInfo(regenerate === true))

  // QR v2 载荷生成（mode='legacy' 输出旧格式；渲染层按用户"旧版兼容"切换调用）
  ipcMainInstance.handle('bridge:pairingQrPayload', (_e, mode?: 'v2' | 'legacy') =>
    bridgeService.getPairingQrPayload(mode === 'legacy' ? 'legacy' : 'v2'))

  ipcMainInstance.handle('bridge:listDevices', () => bridgeService.listDevices())

  ipcMainInstance.handle('bridge:revokeDevice', (_e, deviceId: string) => {
    return { ok: bridgeService.revokeDevice(deviceId) }
  })

  ipcMainInstance.handle('bridge:approvePair', (_e, requestId: string) => {
    const pair = getPendingPair(requestId)
    if (!pair) return { ok: false, error: '配对请求不存在或已处理' }
    bridgeService.approvePair(requestId)
    return { ok: true, device: { requestId, deviceName: pair.deviceName, deviceFingerprint: pair.deviceFingerprint } }
  })

  ipcMainInstance.handle('bridge:rejectPair', (_e, requestId: string) => {
    bridgeService.rejectPair(requestId)
    return { ok: true }
  })

  ipcMainInstance.handle('bridge:wipeAll', () => {
    bridgeService.wipeAll()
    return { ok: true }
  })

  // 配对审批请求 -> 通知渲染层弹窗（方案 §5.1 PC 侧人工确认）
  ipcMainInstance.on('bridge:pairRequested', (_e, requestId: string, deviceName: string) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed() && win.webContents) {
        win.webContents.send('bridge:pairRequest', { requestId, deviceName })
      }
    }
  })
}

/** 生成随机 requestId（内部） */
export function makeRequestId(): string {
  return randomBytes(6).toString('hex')
}
