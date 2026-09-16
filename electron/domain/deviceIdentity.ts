import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export interface DeviceIdentityFile {
  deviceId: string
  createdAt: number
  /** 十进制 UInt64 字符串，无前导零 */
  nextCounter: string
}

const UINT64_MAX = (1n << 64n) - 1n

export function generateDeviceId(): string {
  return `pc-${randomBytes(12).toString('hex')}`
}

export function parseCounter(raw: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) throw new Error(`非法 counter: ${raw}`)
  const v = BigInt(raw)
  if (v > UINT64_MAX) throw new Error(`counter 溢出: ${raw}`)
  return v
}

export function formatCounter(v: bigint): string {
  if (v < 0n || v > UINT64_MAX) throw new RangeError('counter 超出 UInt64')
  return v.toString(10)
}

/**
 * 本地设备身份：持久化 deviceId 与下一个待分配 counter。
 * 备份恢复不得恢复本文件；克隆/重复身份时调用 resetForClone。
 */
export class DeviceIdentityStore {
  constructor(private readonly filePath: string) {}

  loadOrCreate(): DeviceIdentityFile {
    if (existsSync(this.filePath)) {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as DeviceIdentityFile
      parseCounter(parsed.nextCounter)
      if (!parsed.deviceId) throw new Error('deviceId 缺失')
      return parsed
    }
    const created: DeviceIdentityFile = {
      deviceId: generateDeviceId(),
      createdAt: Date.now(),
      nextCounter: '1',
    }
    this.persist(created)
    return created
  }

  /** 备份克隆/疑似重复身份：强制新 deviceId，counter 从 1 重计 */
  resetForClone(): DeviceIdentityFile {
    const created: DeviceIdentityFile = {
      deviceId: generateDeviceId(),
      createdAt: Date.now(),
      nextCounter: '1',
    }
    this.persist(created)
    return created
  }

  /**
   * 在同一受控提交中分配下一个 counter。
   * 调用方必须在业务写与 journal 提交成功后才可丢弃该值；失败应回滚文件（用 checkpoint）。
   */
  allocateCounter(): { identity: DeviceIdentityFile; counter: string } {
    const identity = this.loadOrCreate()
    const cur = parseCounter(identity.nextCounter)
    if (cur > UINT64_MAX) throw new Error('counter 耗尽')
    const allocated = formatCounter(cur)
    const next: DeviceIdentityFile = {
      ...identity,
      nextCounter: formatCounter(cur === UINT64_MAX ? cur : cur + 1n),
    }
    this.persist(next)
    return { identity: next, counter: allocated }
  }

  peek(): DeviceIdentityFile {
    return this.loadOrCreate()
  }

  private persist(value: DeviceIdentityFile): void {
    mkdirSync(dirname(this.filePath), { recursive: true })
    const tmp = this.filePath + '.tmp'
    writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
    writeFileSync(this.filePath, JSON.stringify(value, null, 2), 'utf8')
    try {
      // 清理 tmp
      if (existsSync(tmp)) require('node:fs').unlinkSync(tmp)
    } catch {
      /* ignore */
    }
  }
}

export function defaultIdentityPath(userDataDir: string): string {
  return join(userDataDir, 'data', 'config', 'sync-device-identity.json')
}
