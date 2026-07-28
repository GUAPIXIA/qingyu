import type { IpcMain } from 'electron'
import { mcpManager } from '../mcp/manager'
import { safeId } from '../utils/pathGuard'
import { safeHandle } from '../utils/safeHandle'
import type { McpServerConfig } from '../../shared/types'

export function registerMcpIPC(ipcMain: IpcMain): void {
  safeHandle(ipcMain, 'mcp:listServers', async () => {
    return mcpManager.listServers()
  })

  safeHandle(ipcMain, 'mcp:listServerStatuses', async () => {
    return mcpManager.listServerStatuses()
  })

  safeHandle(ipcMain, 'mcp:addServer', async (_e, config: Omit<McpServerConfig, 'id'>) => {
    return mcpManager.addServer(config)
  })

  safeHandle(ipcMain, 'mcp:updateServer', async (_e, id: string, patch: Partial<McpServerConfig>) => {
    safeId(id)
    return mcpManager.updateServer(id, patch)
  })

  safeHandle(ipcMain, 'mcp:removeServer', async (_e, id: string) => {
    safeId(id)
    await mcpManager.removeServer(id)
  })

  safeHandle(ipcMain, 'mcp:startServer', async (_e, id: string) => {
    safeId(id)
    await mcpManager.startServer(id)
  })

  safeHandle(ipcMain, 'mcp:stopServer', async (_e, id: string) => {
    safeId(id)
    await mcpManager.stopServer(id)
  })

  safeHandle(ipcMain, 'mcp:listTools', async () => {
    return mcpManager.getAllTools()
  })

  safeHandle(ipcMain, 'mcp:callTool', async (_e, serverId: string, toolName: string, args: Record<string, unknown>) => {
    safeId(serverId)
    return mcpManager.callTool(serverId, toolName, args)
  })
}
