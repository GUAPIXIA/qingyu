/* eslint-disable @typescript-eslint/no-explicit-any */
import { McpClient } from './client'
import type { McpServerConfig, McpTool, McpToolResult, McpServerStatus } from './types'
import { DIRS, readJson, writeJson } from '../services/storage'
import { join } from 'node:path'
import { nanoid } from 'nanoid'
import { createLogger } from '../services/logger'

const log = createLogger('mcp')
const CONFIG_FILE = join(DIRS.config(), 'mcp-servers.json')

class McpManager {
  private clients = new Map<string, McpClient>()
  private configs: McpServerConfig[] = []

  constructor() {
    this.configs = readJson<McpServerConfig[]>(CONFIG_FILE) ?? []
  }

  listServers(): McpServerConfig[] {
    return this.configs
  }

  listServerStatuses(): McpServerStatus[] {
    return this.configs.map(c => {
      const client = this.clients.get(c.id)
      return {
        id: c.id,
        connected: client?.isConnected() ?? false,
        toolCount: client?.getTools().length ?? 0,
      }
    })
  }

  async addServer(config: Omit<McpServerConfig, 'id'>): Promise<McpServerConfig> {
    const newConfig: McpServerConfig = { ...config, id: nanoid() }
    this.configs.push(newConfig)
    this.saveConfigs()
    if (newConfig.enabled && newConfig.autoStart) {
      try {
        await this.startServer(newConfig.id)
      } catch (err) {
        log.warn(`自动启动 ${newConfig.name} 失败: ${(err as Error).message}`)
      }
    }
    return newConfig
  }

  updateServer(id: string, patch: Partial<McpServerConfig>) {
    const idx = this.configs.findIndex(s => s.id === id)
    if (idx < 0) return
    const wasRunning = this.clients.has(id)
    this.configs[idx] = { ...this.configs[idx], ...patch }
    this.saveConfigs()
    // 如果配置变化且正在运行，重启
    if (wasRunning) {
      this.restartServer(id).catch(() => {})
    }
  }

  async removeServer(id: string) {
    await this.stopServer(id)
    this.configs = this.configs.filter(s => s.id !== id)
    this.saveConfigs()
  }

  async startServer(id: string): Promise<void> {
    const config = this.configs.find(s => s.id === id)
    if (!config) throw new Error(`未找到 server: ${id}`)
    if (this.clients.has(id) && this.clients.get(id)!.isConnected()) return
    if (this.clients.has(id)) {
      await this.stopServer(id)
    }

    const client = new McpClient(config)
    client.on('log', (msg) => log.info(`[${config.name}] ${msg}`))
    client.on('disconnected', () => {
      this.clients.delete(id)
      log.info(`Server ${config.name} 已断开`)
    })
    client.on('error', (err) => {
      log.error(`Server ${config.name} 错误: ${err.message}`)
    })
    await client.connect()
    this.clients.set(id, client)
  }

  async stopServer(id: string): Promise<void> {
    const client = this.clients.get(id)
    if (client) {
      await client.disconnect()
      this.clients.delete(id)
    }
  }

  async restartServer(id: string): Promise<void> {
    await this.stopServer(id)
    await this.startServer(id)
  }

  /** 获取所有已连接 server 的工具列表 */
  getAllTools(): McpTool[] {
    const tools: McpTool[] = []
    for (const client of this.clients.values()) {
      if (client.isConnected()) {
        tools.push(...client.getTools())
      }
    }
    return tools
  }

  /** 调用工具 */
  async callTool(serverId: string, toolName: string, args: Record<string, any>): Promise<McpToolResult> {
    const client = this.clients.get(serverId)
    if (!client || !client.isConnected()) throw new Error(`Server ${serverId} 未连接`)
    return client.callTool(toolName, args)
  }

  /** 根据 toolName 查找对应的 server */
  findToolServer(toolName: string): { serverId: string; tool: McpTool } | null {
    for (const [serverId, client] of this.clients) {
      if (!client.isConnected()) continue
      const tool = client.getTools().find(t => t.name === toolName)
      if (tool) return { serverId, tool }
    }
    return null
  }

  /** 应用启动时自动连接所有 autoStart 的 server */
  async autoStartAll(): Promise<void> {
    for (const config of this.configs) {
      if (config.enabled && config.autoStart) {
        try {
          await this.startServer(config.id)
        } catch (err) {
          log.error(`自动启动 ${config.name} 失败: ${(err as Error).message}`)
        }
      }
    }
  }

  async shutdownAll(): Promise<void> {
    const ids = Array.from(this.clients.keys())
    await Promise.all(ids.map(id => this.stopServer(id)))
  }

  private saveConfigs() {
    writeJson(CONFIG_FILE, this.configs)
  }
}

export const mcpManager = new McpManager()
