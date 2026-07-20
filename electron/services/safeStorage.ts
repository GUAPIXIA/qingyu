import { safeStorage as electronSafeStorage } from 'electron'
import { join } from 'node:path'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { DIRS } from './storage'

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
    // 不支持加密时明文存储（仅开发环境）
    const data = readCredentialAll()
    data[provider] = `plain:${key}`
    writeCredentialAll(data)
  }
}

/** 读取凭据 */
export function getCredential(provider: string): string | null {
  const data = readCredentialAll()
  const value = data[provider]
  if (!value) return null

  if (value.startsWith('plain:')) {
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
  writeFileSync(path, JSON.stringify(data, null, 2), 'utf-8')
}
