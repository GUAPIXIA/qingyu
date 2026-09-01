import { app, safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export interface RelayCredentialsFile {
  version: 1; relayBaseUrl: string; spaceId: string; pcDeviceId: string
  encryptedRefreshToken: string; tokenVersion: number; createdAt: number
}
export interface RelayCredentials extends Omit<RelayCredentialsFile, 'encryptedRefreshToken'> { refreshToken: string }

export class RelayCredentialStore {
  private path(): string { return join(app.getPath('userData'), 'relay', 'credentials.json') }
  save(value: Omit<RelayCredentials, 'version' | 'createdAt'>): void {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('安全存储不可用，无法启用服务器连接')
    const file: RelayCredentialsFile = {
      version: 1, relayBaseUrl: value.relayBaseUrl, spaceId: value.spaceId, pcDeviceId: value.pcDeviceId,
      encryptedRefreshToken: safeStorage.encryptString(value.refreshToken).toString('base64'),
      tokenVersion: value.tokenVersion, createdAt: Date.now(),
    }
    const path = this.path(); mkdirSync(dirname(path), { recursive: true }); const temp = `${path}.tmp`
    writeFileSync(temp, JSON.stringify(file, null, 2), { encoding: 'utf8', mode: 0o600 }); renameSync(temp, path)
  }
  load(): RelayCredentials | null {
    if (!safeStorage.isEncryptionAvailable() || !existsSync(this.path())) return null
    try {
      const file = JSON.parse(readFileSync(this.path(), 'utf8')) as RelayCredentialsFile
      if (file.version !== 1) return null
      const { encryptedRefreshToken, ...rest } = file
      return { ...rest, refreshToken: safeStorage.decryptString(Buffer.from(encryptedRefreshToken, 'base64')) }
    } catch { return null }
  }
  clear(): void { try { unlinkSync(this.path()) } catch { /* absent */ } }
}
