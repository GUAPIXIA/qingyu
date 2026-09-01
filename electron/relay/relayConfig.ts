import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export interface RelayConfig { enabled: boolean; baseUrl: string }
const DEFAULT_CONFIG: RelayConfig = { enabled: false, baseUrl: '' }

function path(): string { return join(app.getPath('userData'), 'relay', 'config.json') }
export function readRelayConfig(): RelayConfig {
  try { return { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(path(), 'utf8')) as Partial<RelayConfig> } } catch { return { ...DEFAULT_CONFIG } }
}
export function writeRelayConfig(config: RelayConfig): void {
  const file = path(); mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.tmp`; writeFileSync(temp, JSON.stringify(config, null, 2), { encoding: 'utf8', mode: 0o600 }); renameSync(temp, file)
}
export function clearRelayConfig(): void { if (!existsSync(path())) writeRelayConfig(DEFAULT_CONFIG); else writeRelayConfig(DEFAULT_CONFIG) }

export function normalizeRelayBaseUrl(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Relay 地址必须是不含账号、查询或片段的 HTTPS 地址')
  url.pathname = url.pathname.replace(/\/+$/, '')
  return url.toString().replace(/\/$/, '')
}
