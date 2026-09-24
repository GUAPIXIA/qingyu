/**
 * 阶段 7 S7-03：LAN 一次性授权 IPC（同步中心「允许局域网同步」）。
 *
 * 渲染层只拿 QR JSON / 短认证串 / 阶段状态；**不暴露** secret、私钥或派生会话密钥。
 */
import type { IpcMain } from 'electron'
import { syncLanAuthService } from '../domain/syncLanAuth'

export function registerSyncLanIPC(ipcMain: IpcMain): void {
  ipcMain.handle('syncLan:startAuth', (_e, input: { host: string; port: number; fingerprint: string; displayName: string }) =>
    syncLanAuthService.startAuthWindow(input),
  )
  ipcMain.handle('syncLan:status', () => syncLanAuthService.getStatus())
  ipcMain.handle('syncLan:submitPeerHello', (_e, input: { sessionId: string; deviceName: string; androidPublicKey: string }) =>
    syncLanAuthService.submitPeerHello(input),
  )
  ipcMain.handle('syncLan:confirmPeer', (_e, input: { sessionId: string; shortAuth: string }) =>
    syncLanAuthService.confirmPeer(input),
  )
  ipcMain.handle('syncLan:revoke', () => {
    syncLanAuthService.revoke('user')
    return syncLanAuthService.getStatus()
  })
}
