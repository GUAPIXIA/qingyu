import { safeStorage as electronSafeStorage } from 'electron'
import { join } from 'node:path'
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from 'node:fs'
import { DIRS } from './storage'
import { createLogger } from './logger'

/** 凭据是否可用加密 */
export function isEncryptionAvailable(): boolean {
  return electronSafeStorage.isEncryptionAvailable()
}

/** 加密保存凭据 */
export function saveCredential(provider: string, key: string): void {
  if (!key) {
    // 空字符串则删除
    const path = getCredentialPath()
    if (existsSync(path)) {
      const data = readCredentialAll()
      delete data[provider]
      writeCredentialAll(data)
    }
    return
  }

  if (isEncryptionAvailable()) {
    const encrypted = electronSafeStorage.encryptString(key)
    const data = readCredentialAll()
    data[provider] = encrypted.toString('base64')
    writeCredentialAll(data)
  } else {
    // 不支持加密时拒绝保存（避免明文泄露）
    throw new Error('安全存储不可用：无法加密保存凭据。请确保运行在受支持的桌面环境中。')
  }
}

/** 读取凭据 */
export function getCredential(provider: string): string | null {
  const data = readCredentialAll()
  const value = data[provider]
  if (!value) return null

  if (value.startsWith('plain:')) {
    // 警告：该凭据以明文存储（加密不可用时回退，或旧版本数据），应尽快重新保存以启用加密
    try {
      const logger = createLogger('safeStorage')
      logger.warn('检测到明文存储的凭据（plain:），建议重新保存以启用加密', { provider })
    } catch { /* 忽略 */ }
    return value.slice(6)
  }

  if (isEncryptionAvailable()) {
    try {
      const buffer = Buffer.from(value, 'base64')
      return electronSafeStorage.decryptString(buffer)
    } catch {
      return null
    }
  }
  return null
}

function getCredentialPath(): string {
  return join(DIRS.config(), 'credentials.json')
}

function readCredentialAll(): Record<string, string> {
  const path = getCredentialPath()
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, 'utf-8'))
  } catch {
    return {}
  }
}

function writeCredentialAll(data: Record<string, string>): void {
  const path = getCredentialPath()
  mkdirSync(join(path, '..'), { recursive: true })
  // 原子写入：temp + rename，防止崩溃导致凭据文件损坏
  const tmpPath = path + '.tmp'
  writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8')
  try {
    renameSync(tmpPath, path)
  } catch (err) {
    try { unlinkSync(tmpPath) } catch { /* ignore */ }
    throw err
  }
}
