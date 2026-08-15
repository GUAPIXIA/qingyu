/**
 * 桥接层认证模块（方案 §5.1 配对流程 + §6 安全设计）。
 *
 * - 配对码：一次性 + 5 分钟有效（内存态），扫码只完成"交换配对码"，
 *   长期令牌必须经 PC 端人工确认后签发（防局域网抢扫）；
 * - 令牌：HMAC-SHA256 签名（复用 server/app 的 HS256 思路，不引入 jsonwebtoken
 *   依赖，Node crypto 实现），密钥经 safeStorage 加密持久化；
 * - 设备：devices.json 持久化（deviceId -> 名称/指纹/时间），PC 端可吊销。
 */
import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto'
import { join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { DIRS, readJson, writeJson } from '../services/storage'
import { saveCredential, getCredential, isEncryptionAvailable } from '../services/safeStorage'
import { createLogger } from '../services/logger'
import { safeId } from '../utils/pathGuard'

const log = createLogger('bridge-auth')

// ===================== 配置与常量 =====================

const PAIR_CODE_TTL_MS = 5 * 60 * 1000
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 天
const SECRET_CREDENTIAL_KEY = 'bridge-jwt-secret'

function bridgeDir(): string {
  const dir = join(DIRS.config(), 'bridge')
  mkdirSync(dir, { recursive: true })
  return dir
}

function devicesFile(): string {
  return join(bridgeDir(), 'devices.json')
}

/** 设备记录 */
export interface BridgeDevice {
  deviceId: string
  name: string
  fingerprint: string
  createdAt: number
  lastSeen: number
}

/** 测试/密钥轮换用：清内存缓存（下次调用重新读取持久化密钥） */
export function resetJwtSecretCache(): void {
  cachedSecret = null
}

/** 待审批配对请求（PC 端人工确认后签发） */
export interface PendingPair {
  requestId: string
  deviceName: string
  deviceFingerprint: string
  pairingCode: string
  createdAt: number
  /** 挂起的审批 Promise（POST /auth/pair 阻塞等待，≤60s） */
  resolve: (approved: boolean) => void
  settled: boolean
}

// ===================== 密钥 =====================

let cachedSecret: Buffer | null = null

/**
 * 获取/创建 JWT 签名密钥（safeStorage 加密持久化，重启后保持稳定）。
 * 读取顺序：加密凭据 -> plain: 前缀凭据（降级环境）-> 明文文件（兼容旧数据）-> 新生成。
 * 修复：此前降级路径只写明文文件不读，重启后 secret 变化导致全部已签发 token 失效（安卓端 401）。
 */
export function getJwtSecret(): Buffer {
  if (cachedSecret) return cachedSecret

  // 1) 加密凭据（含 plain: 降级格式，经 safeStorage.getCredential 统一读取）
  const existing = getCredential(SECRET_CREDENTIAL_KEY)
  if (existing) {
    cachedSecret = Buffer.from(existing, 'base64')
    return cachedSecret
  }

  // 2) 明文文件（兼容早期降级版本数据）
  const plainPath = join(bridgeDir(), 'secret')
  if (existsSync(plainPath)) {
    try {
      cachedSecret = Buffer.from(readFileSync(plainPath, 'utf-8').trim(), 'base64')
      return cachedSecret
    } catch {
      // 文件损坏：重新生成
    }
  }

  // 3) 生成新密钥（优先 safeStorage 加密；降级写 plain: 前缀凭据 + 明文文件双保险）
  const secret = randomBytes(32)
  const encoded = secret.toString('base64')
  if (isEncryptionAvailable()) {
    try {
      saveCredential(SECRET_CREDENTIAL_KEY, encoded)
    } catch {
      writePlainCredential(encoded)
    }
  } else {
    writePlainCredential(encoded)
  }
  // 明文文件兜底（与 plain: 凭据共存，任一可读）
  try {
    writeFileSync(plainPath, encoded, { mode: 0o600 })
  } catch {
    // 忽略
  }
  cachedSecret = secret
  log.warn('已生成新 JWT 密钥（先前无持久化密钥）')
  return secret
}

/** 降级：以 plain: 前缀写入凭据文件（safeStorage.getCredential 可读） */
function writePlainCredential(encoded: string): void {
  try {
    const credFile = join(DIRS.config(), 'credentials.json')
    const creds = readJson<Record<string, string>>(credFile, 'settings') ?? {}
    creds[SECRET_CREDENTIAL_KEY] = 'plain:' + encoded
    writeJson(credFile, creds, 'settings')
    log.warn('safeStorage 不可用，JWT 密钥降级为明文存储（受限环境）')
  } catch (e) {
    log.warn('降级密钥写入失败', { error: (e as Error).message })
  }
}

// ===================== 令牌（HMAC-SHA256） =====================

/** 令牌载荷 */
export interface TokenPayload {
  deviceId: string
  /** 签发时间（ms） */
  iat: number
  /** 过期时间（ms） */
  exp: number
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function sign(data: string, secret: Buffer): string {
  return createHmac('sha256', secret).update(data).digest('base64url')
}

/** 签发长期设备令牌（JWT 风格：header.payload.signature） */
export function signToken(deviceId: string, ttlMs = TOKEN_TTL_MS): string {
  const payload: TokenPayload = {
    deviceId,
    iat: Date.now(),
    exp: Date.now() + ttlMs,
  }
  const header = base64url(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })))
  const body = base64url(Buffer.from(JSON.stringify(payload)))
  const signature = sign(`${header}.${body}`, getJwtSecret())
  return `${header}.${body}.${signature}`
}

/** 校验令牌，返回载荷；无效/过期返回 null */
export function verifyToken(token: string): TokenPayload | null {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const [header, body, signature] = parts
    const expected = sign(`${header}.${body}`, getJwtSecret())
    const expectedBuf = Buffer.from(expected)
    const actualBuf = Buffer.from(signature)
    if (expectedBuf.length !== actualBuf.length || !timingSafeEqual(expectedBuf, actualBuf)) {
      return null
    }
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as TokenPayload
    if (typeof payload.deviceId !== 'string' || typeof payload.exp !== 'number') return null
    if (payload.exp < Date.now()) return null
    return payload
  } catch {
    return null
  }
}

// ===================== 配对码 =====================

/** 配对码 -> 有效期（内存态，一次性） */
const pairingCodes = new Map<string, { expiresAt: number; used: boolean }>()

/** 生成一次性配对码（5 分钟有效） */
export function generatePairingCode(): string {
  // 清理过期码
  const now = Date.now()
  for (const [code, entry] of pairingCodes) {
    if (entry.expiresAt < now) pairingCodes.delete(code)
  }
  const code = randomBytes(8).toString('hex')
  pairingCodes.set(code, { expiresAt: now + PAIR_CODE_TTL_MS, used: false })
  log.info('已生成配对码（5 分钟有效）')
  return code
}

/** 校验并消费配对码（一次性） */
export function consumePairingCode(code: string): boolean {
  const entry = pairingCodes.get(code)
  if (!entry) return false
  pairingCodes.delete(code)
  return !entry.used && entry.expiresAt >= Date.now()
}

/** 配对码是否仍有效（未消费且未过期） */
export function isPairingCodeValid(code: string): boolean {
  const entry = pairingCodes.get(code)
  return !!entry && !entry.used && entry.expiresAt >= Date.now()
}

/** 作废指定配对码（重新生成时清理旧码，防旧码仍可扫码） */
export function revokePairingCode(code: string): void {
  pairingCodes.delete(code)
}

// ===================== 设备管理 =====================

function loadDevices(): BridgeDevice[] {
  const file = devicesFile()
  if (!existsSync(file)) return []
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as BridgeDevice[]
  } catch {
    return []
  }
}

function saveDevices(devices: BridgeDevice[]): void {
  writeFileSync(devicesFile(), JSON.stringify(devices, null, 2))
}

export function listDevices(): BridgeDevice[] {
  return loadDevices()
}

/** 设备是否存在（按指纹或 id） */
export function findDevice(fingerprint: string): BridgeDevice | null {
  return loadDevices().find((d) => d.fingerprint === fingerprint) ?? null
}

/** 登记设备（配对成功后） */
export function registerDevice(name: string, fingerprint: string): BridgeDevice {
  const deviceId = safeId(`dev-${randomBytes(6).toString('hex')}`)
  const device: BridgeDevice = {
    deviceId,
    name,
    fingerprint,
    createdAt: Date.now(),
    lastSeen: Date.now(),
  }
  const devices = loadDevices().filter((d) => d.fingerprint !== fingerprint)
  devices.push(device)
  saveDevices(devices)
  log.info('设备已登记', { deviceId, name })
  return device
}

/** 更新设备最后活跃时间 */
export function touchDevice(deviceId: string): void {
  const devices = loadDevices()
  const device = devices.find((d) => d.deviceId === deviceId)
  if (device) {
    device.lastSeen = Date.now()
    saveDevices(devices)
  }
}

/** PC 端吊销设备 */
export function revokeDevice(deviceId: string): boolean {
  const devices = loadDevices()
  const next = devices.filter((d) => d.deviceId !== deviceId)
  if (next.length === devices.length) return false
  saveDevices(next)
  log.info('设备已吊销', { deviceId })
  return true
}

/** 清空全部设备（"退出时清除"联动） */
export function wipeDevices(): void {
  const file = devicesFile()
  if (existsSync(file)) rmSync(file)
  pairingCodes.clear()
  cachedSecret = null
}

// ===================== 待审批队列 =====================

const pendingPairs = new Map<string, PendingPair>()

/** 登记一个待审批配对请求，返回 requestId */
export function enqueuePendingPair(deviceName: string, deviceFingerprint: string, pairingCode: string): PendingPair {
  const requestId = randomBytes(6).toString('hex')
  const pair: PendingPair = {
    requestId,
    deviceName,
    deviceFingerprint,
    pairingCode,
    createdAt: Date.now(),
    resolve: () => {},
    settled: false,
  }
  pendingPairs.set(requestId, pair)
  return pair
}

/** 按 requestId 取待审批请求 */
export function getPendingPair(requestId: string): PendingPair | null {
  return pendingPairs.get(requestId) ?? null
}

/** 批准/拒绝配对（PC 端人工确认后调用；返回 null 表示请求不存在/已处理） */
export function settlePair(requestId: string, approved: boolean): boolean {
  const pair = pendingPairs.get(requestId)
  if (!pair || pair.settled) return false
  // settled 状态由 settlePair 统一管理（resolve 可能被调用方覆盖，不能依赖其内部副作用）
  pair.settled = true
  pendingPairs.delete(requestId)
  pair.resolve(approved)
  return true
}
