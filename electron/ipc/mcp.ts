import type { IpcMain } from 'electron'
import { mcpManager } from '../mcp/manager'
import { safeId } from '../utils/pathGuard'
import { safeHandle } from '../utils/safeHandle'
import type { McpServerConfig } from '../../shared/types'
import { app } from 'electron'
import { ensureSyncDomain, journalPutIfEnabled, journalDeleteIfEnabled } from '../domain/syncDomainService'
import { createLogger } from '../services/logger'

const log = createLogger('mcp-ipc')

function journalMcpPublic(server: McpServerConfig): void {
  try {
    ensureSyncDomain(app.getPath('userData'))
    // 仅公共配置；env 敏感值不同步（总方案 §6.1）
    journalPutIfEnabled({
      domain: 'mcp_public_config',
      entityType: 'mcp_public_config',
      entityId: server.id,
      payload: {
        name: server.name,
        transport: server.transport,
        enabled: server.enabled,
      },
    })
  } catch (err) {
    log.warn('mcp journal 失败', { err: String(err) })
  }
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
    journalMcpPublic(created)
    return created
  })

  safeHandle(ipcMain, 'mcp:updateServer', async (_e, id: string, patch: Partial<McpServerConfig>) => {
    safeId(id)
    mcpManager.updateServer(id, patch)
    const updated = mcpManager.listServers().find((s) => s.id === id)
    if (updated != null) journalMcpPublic(updated)
    return updated
  })

  safeHandle(ipcMain, 'mcp:removeServer', async (_e, id: string) => {
    safeId(id)
    await mcpManager.removeServer(id)
    try {
      ensureSyncDomain(app.getPath('userData'))
      journalDeleteIfEnabled({ domain: 'mcp_public_config', entityType: 'mcp_public_config', entityId: id })
    } catch (err) {
      log.warn('mcp delete journal 失败', { err: String(err) })
    }
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
