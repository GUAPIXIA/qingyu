import { BrowserWindow, dialog, safeStorage, type IpcMain } from 'electron'
import { createHash } from 'node:crypto'
import { bridgeService } from '../bridge/index'
import { getMachineFingerprint } from '../bridge/index'
import { normalizeRelayBaseUrl, readRelayConfig, writeRelayConfig } from './relayConfig'
import { RelayCredentialStore, type RelayCredentials } from './relayCredentialStore'
import { RelayAgent, type RelayStatus } from './relayAgent'
import { RelayRpcDispatcher } from './relayRpcDispatcher'
import type { RelayPairingQr } from '../../shared/relayProtocol'
import { RelayCachePublisher } from './relayCachePublisher'
import { RelaySingleFlight } from './relaySingleFlight'
import { buildRelayAuthorizedHeaders } from './relayHttp'

interface TokenResponse { spaceId: string; deviceId: string; accessToken: string; accessTokenExpiresAt: number; refreshToken: string; tokenVersion: number }

export class RelayService {
  private readonly store = new RelayCredentialStore()
  private readonly runtime = bridgeService.getRuntime()
  private readonly agent = new RelayAgent(null, new RelayRpcDispatcher(this.runtime.facade))
  private detachSink = this.runtime.events.add(this.agent)
  private readonly cachePublisher = new RelayCachePublisher(this.runtime.facade, (type, payload) => this.agent.sendFrame(type, payload))
  private detachCacheSink = this.runtime.events.add(this.cachePublisher)
  private config = readRelayConfig()
  private refreshTimer: NodeJS.Timeout | null = null
  private currentAccess: { token: string; expiresAt: number } | null = null
  private readonly refreshFlight = new RelaySingleFlight<TokenResponse>()

  constructor() {
    this.agent.onStatus((status) => {
      for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.send('relay:statusChanged', status)
    })
    this.agent.onPairRequest((request) => {
      for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.send('relay:pairRequest', request)
      const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows().find((win) => !win.isDestroyed())
      const options = {
        type: 'question' as const,
        title: '服务器连接审批',
        message: `允许“${request.deviceName}”连接此轻语空间吗？`,
        detail: '请确认这是你正在操作的手机。连接码将在审批后立即失效。',
        buttons: ['允许', '拒绝'], defaultId: 0, cancelId: 1, noLink: true,
      }
      const prompt = parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options)
      void prompt.then(({ response }) => response === 0 ? this.approvePair(request.requestId) : this.rejectPair(request.requestId)).catch(() => {})
    })
    this.agent.onOnline(() => { void this.cachePublisher.publishSnapshot().catch(() => {}) })
  }

  status(): RelayStatus { return this.agent.status }
  async restore(): Promise<void> {
    if (!this.config.enabled) return
    const credentials = this.store.load()
    if (!credentials) return
    try {
      const token = await this.refreshSingleFlight(credentials.relayBaseUrl, credentials.refreshToken)
      this.applyTokens(credentials.relayBaseUrl, token)
      await this.agent.start()
    } catch { /* status remains NeedsAuth on explicit retry */ }
  }

  async enable(baseUrlInput: string): Promise<{ ok: boolean; error?: string }> {
    try {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('安全存储不可用，无法启用 Relay')
      const baseUrl = normalizeRelayBaseUrl(baseUrlInput)
      const existing = this.store.load()
      if (existing?.relayBaseUrl === baseUrl) {
        try {
          const token = await this.refreshSingleFlight(baseUrl, existing.refreshToken)
          this.applyTokens(baseUrl, token)
          this.config = { enabled: true, baseUrl }; writeRelayConfig(this.config)
          await this.agent.start()
          return { ok: true }
        } catch {
          this.store.clear()
          this.currentAccess = null
        }
      }
      const response = await fetch(`${baseUrl}/relay/v1/spaces/register-pc`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: process.env.COMPUTERNAME || '轻语 PC', fingerprint: createHash('sha256').update(getMachineFingerprint()).digest('hex') }),
      })
      if (!response.ok) throw new Error(`Relay 注册失败 (${response.status})`)
      const token = await response.json() as TokenResponse
      this.applyTokens(baseUrl, token)
      this.config = { enabled: true, baseUrl }; writeRelayConfig(this.config)
      await this.agent.start()
      return { ok: true }
    } catch (error) { return { ok: false, error: (error as Error).message } }
  }

  async disable(): Promise<{ ok: boolean }> {
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    this.refreshTimer = null
    this.currentAccess = null
    await this.agent.stop(); this.config = { ...this.config, enabled: false }; writeRelayConfig(this.config); return { ok: true }
  }
  async retry(): Promise<{ ok: boolean; error?: string }> {
    try { await this.restore(); return { ok: true } } catch (error) { return { ok: false, error: (error as Error).message } }
  }
  async createPairTicket(): Promise<RelayPairingQr> {
    const response = await this.authorized('/relay/v1/pair-tickets', { method: 'POST' })
    if (!response.ok) throw new Error(`创建服务器配对码失败 (${response.status})`)
    return response.json() as Promise<RelayPairingQr>
  }
  async listDevices(): Promise<unknown[]> { const response = await this.authorized('/relay/v1/devices'); return response.ok ? response.json() as Promise<unknown[]> : [] }
  async revokeDevice(deviceId: string): Promise<{ ok: boolean }> { const response = await this.authorized(`/relay/v1/devices/${encodeURIComponent(deviceId)}`, { method: 'DELETE' }); return { ok: response.ok } }
  async approvePair(requestId: string): Promise<{ ok: boolean }> { const response = await this.authorized(`/relay/v1/pair-requests/${encodeURIComponent(requestId)}/approve`, { method: 'POST' }); return { ok: response.ok } }
  async rejectPair(requestId: string): Promise<{ ok: boolean }> { const response = await this.authorized(`/relay/v1/pair-requests/${encodeURIComponent(requestId)}/reject`, { method: 'POST' }); return { ok: response.ok } }
  async clearCache(): Promise<{ ok: boolean }> { const response = await this.authorized('/relay/v1/spaces/current/cache', { method: 'DELETE' }); return { ok: response.ok } }
  async shutdown(): Promise<void> {
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    this.refreshTimer = null
    await Promise.race([this.agent.stop(), new Promise<void>((resolve) => setTimeout(resolve, 1_000))])
  }
  dispose(): void { void this.shutdown(); this.detachSink(); this.detachCacheSink(); this.cachePublisher.dispose(); this.detachSink = () => {}; this.detachCacheSink = () => {} }

  private applyTokens(baseUrl: string, token: TokenResponse): void {
    this.store.save({ relayBaseUrl: baseUrl, spaceId: token.spaceId, pcDeviceId: token.deviceId, refreshToken: token.refreshToken, tokenVersion: token.tokenVersion })
    this.agent.setCredentials({ baseUrl, spaceId: token.spaceId, deviceId: token.deviceId, accessToken: token.accessToken, accessTokenExpiresAt: token.accessTokenExpiresAt })
    this.currentAccess = { token: token.accessToken, expiresAt: token.accessTokenExpiresAt }
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    const delay = Math.max(1_000, token.accessTokenExpiresAt - Date.now() - 120_000)
    this.refreshTimer = setTimeout(() => {
      const credentials = this.store.load()
      if (!credentials) return
      void this.refreshSingleFlight(credentials.relayBaseUrl, credentials.refreshToken)
        .then((next) => this.applyTokens(credentials.relayBaseUrl, next))
        .catch(() => {})
    }, delay)
  }
  private async refresh(baseUrl: string, refreshToken: string): Promise<TokenResponse> {
    const response = await fetch(`${baseUrl}/relay/v1/tokens/refresh`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refreshToken }) })
    if (!response.ok) throw new Error('Relay 凭据已失效')
    return response.json() as Promise<TokenResponse>
  }
  private refreshSingleFlight(baseUrl: string, refreshToken: string): Promise<TokenResponse> {
    return this.refreshFlight.run(() => this.refresh(baseUrl, refreshToken))
  }
  private async accessToken(credentials: RelayCredentials): Promise<string> {
    if (this.currentAccess && this.currentAccess.expiresAt - Date.now() > 120_000) return this.currentAccess.token
    const next = await this.refreshSingleFlight(credentials.relayBaseUrl, credentials.refreshToken)
    this.applyTokens(credentials.relayBaseUrl, next)
    return next.accessToken
  }
  private async authorized(path: string, init?: RequestInit): Promise<Response> {
    const credentials = this.store.load(); if (!credentials) throw new Error('Relay 尚未注册')
    const accessToken = await this.accessToken(credentials)
    return fetch(`${credentials.relayBaseUrl}${path}`, { ...init, headers: buildRelayAuthorizedHeaders(accessToken, init) })
  }
}

export const relayService = new RelayService()

export function registerRelayIPC(ipcMain: IpcMain): void {
  ipcMain.handle('relay:status', () => relayService.status())
  ipcMain.handle('relay:enable', (_event, baseUrl: string) => relayService.enable(baseUrl))
  ipcMain.handle('relay:disable', () => relayService.disable())
  ipcMain.handle('relay:retry', () => relayService.retry())
  ipcMain.handle('relay:createPairTicket', () => relayService.createPairTicket())
  ipcMain.handle('relay:listDevices', () => relayService.listDevices())
  ipcMain.handle('relay:revokeDevice', (_event, id: string) => relayService.revokeDevice(id))
  ipcMain.handle('relay:approvePair', (_event, id: string) => relayService.approvePair(id))
  ipcMain.handle('relay:rejectPair', (_event, id: string) => relayService.rejectPair(id))
  ipcMain.handle('relay:clearCache', () => relayService.clearCache())
}
