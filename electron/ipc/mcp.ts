import type { IpcMain } from 'electron'
import { join } from 'node:path'
import { mcpManager } from '../mcp/manager'
import { safeId } from '../utils/pathGuard'
import { safeHandle } from '../utils/safeHandle'
import type { McpServerConfig } from '../../shared/types'
import { DIRS } from '../services/storage'
import { writeThroughDomain, deleteThroughDomain } from '../domain/syncDomainService'


/** MCP 服务器配置由 mcpManager 持有；这里把同一文件内容纳入事务，避免只记 journal 的假事务 */
function mcpConfigFile(): string {
  return join(DIRS.config(), 'mcp-servers.json')
}

/**
 * mcp_public_config 写入口（S2-04）：仅公共字段进 payload，
 * env / headers / command 等敏感值不同步（总方案 §6.1、§3.3）。
 */
function commitMcpPublic(server: McpServerConfig): void {
  const servers = mcpManager.listServers()
  writeThroughDomain({
    domain: 'mcp_public_config',
    entityType: 'mcp_public_config',
    entityId: server.id,
    payload: {
      name: server.name,
      transport: server.transport,
      enabled: server.enabled,
    },
    schemaVersion: 1,
    files: [{ path: mcpConfigFile(), content: JSON.stringify(servers, null, 2) }],
  })
}

function commitMcpDelete(id: string): void {
  const servers = mcpManager.listServers()
  deleteThroughDomain({
    domain: 'mcp_public_config',
    entityType: 'mcp_public_config',
    entityId: id,
    files: [{ path: mcpConfigFile(), content: JSON.stringify(servers, null, 2) }],
  })
}

export function registerMcpIPC(ipcMain: IpcMain): void {
  safeHandle(ipcMain, 'mcp:listServers', async () => {
    return mcpManager.listServers()
  })

  safeHandle(ipcMain, 'mcp:listServerStatuses', async () => {
    return mcpManager.listServerStatuses()
  })

  safeHandle(ipcMain, 'mcp:addServer', async (_e, config: Omit<McpServerConfig, 'id'>) => {
    const created = await mcpManager.addServer(config)
    commitMcpPublic(created)
    return created
  })

  safeHandle(ipcMain, 'mcp:updateServer', async (_e, id: string, patch: Partial<McpServerConfig>) => {
    safeId(id)
    mcpManager.updateServer(id, patch)
    const updated = mcpManager.listServers().find((s) => s.id === id)
    if (updated != null) commitMcpPublic(updated)
    return updated
  })

  safeHandle(ipcMain, 'mcp:removeServer', async (_e, id: string) => {
    safeId(id)
    await mcpManager.removeServer(id)
    commitMcpDelete(id)
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
