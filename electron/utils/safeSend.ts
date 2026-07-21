import type { WebContents } from 'electron'

/**
 * 安全地向渲染进程发送 IPC 消息
 * E-02 修复：防止窗口关闭后 webContents.send 抛出 "Object has been destroyed" 错误
 */
export function safeSend(webContents: WebContents, channel: string, ...args: any[]): boolean {
  if (webContents.isDestroyed()) return false
  try {
    webContents.send(channel, ...args)
    return true
  } catch {
    return false
  }
}
