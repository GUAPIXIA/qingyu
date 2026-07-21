/* eslint-disable @typescript-eslint/no-explicit-any */
import type { IpcMain } from 'electron'
import { mcpManager } from '../mcp/manager'
import { safeId } from '../utils/pathGuard'

export function registerMcpIPC(ipcMain: IpcMain): void {
  ipcMain.handle('mcp:listServers', async () => {
    return mcpManager.listServers()
  })

  ipcMain.handle('mcp:listServerStatuses', async () => {
    return mcpManager.listServerStatuses()
  })

  ipcMain.handle('mcp:addServer', async (_e, config: any) => {
    return mcpManager.addServer(config)
  })

  ipcMain.handle('mcp:updateServer', async (_e, id: string, patch: any) => {
    safeId(id)
    mcpManager.updateServer(id, patch)
  })

  ipcMain.handle('mcp:removeServer', async (_e, id: string) => {
    safeId(id)
    await mcpManager.removeServer(id)
  })

  ipcMain.handle('mcp:startServer', async (_e, id: string) => {
    safeId(id)
    await mcpManager.startServer(id)
  })

  ipcMain.handle('mcp:stopServer', async (_e, id: string) => {
    safeId(id)
    await mcpManager.stopServer(id)
  })

  ipcMain.handle('mcp:listTools', async () => {
    return mcpManager.getAllTools()
  })

  ipcMain.handle('mcp:callTool', async (_e, serverId: string, toolName: string, args: any) => {
    safeId(serverId)
    return mcpManager.callTool(serverId, toolName, args)
  })
}
