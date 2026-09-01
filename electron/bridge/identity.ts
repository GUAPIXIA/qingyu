/**
 * 阶段 D（D-01）：稳定 serverId。
 *
 * 背景：旧 `getMachineFingerprint()` 由 hostname + MAC 哈希得出，换网卡/休眠恢复后
 * 可能变化，导致安卓端无法稳定识别同一台 PC。本模块生成一次随机 UUID 并持久化到
 * 配置目录 `bridgeIdentity.json`，之后恒定不变（跨重启、跨网卡、跨 hostname）：
 *
 * ```json
 * { "serverId": "uuid", "createdAt": 1788000000000, "identityVersion": 1 }
 * ```
 *
 * serverId 只用于稳定识别（QR v2 / mDNS TXT / serverInfo capabilities 协商），
 * 不是秘密；服务器身份安全由 TLS 公钥指纹或配对签名保证。
 * 旧的 getMachineFingerprint() 行为保留（`electron/bridge/index.ts`），二者互不影响。
 */
import { randomUUID, createHash } from 'node:crypto'
import { hostname } from 'node:os'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DIRS } from '../services/storage'
import { createLogger } from '../services/logger'

const log = createLogger('bridge-identity')

export interface BridgeIdentity {
  serverId: string
  createdAt: number
  identityVersion: number
}

const IDENTITY_VERSION = 1

function identityFile(): string {
  return join(DIRS.config(), 'bridgeIdentity.json')
}

/** 进程缓存：首读后恒定（文件被误删也保持本次运行内稳定） */
let cached: BridgeIdentity | null = null

function isValidIdentity(value: unknown): value is BridgeIdentity {
  const id = value as Partial<BridgeIdentity> | null | undefined
  return (
    !!id &&
    typeof id.serverId === 'string' &&
    id.serverId.length >= 8 &&
    typeof id.createdAt === 'number'
  )
}

/**
 * 读取（或首启生成）稳定 serverId 身份。
 * 生成后写入 bridgeIdentity.json；文件损坏/非法时重新生成并覆盖。
 */
export function getBridgeIdentity(): BridgeIdentity {
  if (cached) return cached
  const file = identityFile()
  try {
    if (existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, 'utf-8')) as unknown
      if (isValidIdentity(parsed)) {
        cached = parsed
        return cached
      }
      log.warn('bridgeIdentity.json 内容非法，重新生成 serverId')
    }
  } catch {
    log.warn('bridgeIdentity.json 读取失败，重新生成 serverId')
  }
  const identity: BridgeIdentity = {
    serverId: randomUUID(),
    createdAt: Date.now(),
    identityVersion: IDENTITY_VERSION,
  }
  try {
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, JSON.stringify(identity, null, 2))
  } catch (e) {
    // 写入失败不阻塞：进程内保持缓存值（下次启动再生成）
    log.warn('bridgeIdentity.json 写入失败', { error: (e as Error).message })
  }
  cached = identity
  return cached
}

/** 稳定服务器 ID（uuid）：QR v2 / serverInfo / mDNS TXT 共用 */
export function getServerId(): string {
  return getBridgeIdentity().serverId
}

/** PC 展示名（QR v2 displayName / mDNS）：优先 COMPUTERNAME/HOSTNAME 环境变量，回退 os.hostname */
export function getServerDisplayName(): string {
  const raw = (process.env.COMPUTERNAME || process.env.HOSTNAME || hostname() || 'PC').toString()
  return raw.trim().slice(0, 64) || 'PC'
}

/** serverId 短摘要（日志/配对弹窗展示用，不可逆） */
export function serverIdDigest(): string {
  return createHash('sha256').update(getServerId()).digest('hex').slice(0, 12)
}

/** 测试钩子：清空进程缓存，强制下次重新读盘/生成 */
export function resetBridgeIdentityCache(): void {
  cached = null
}
