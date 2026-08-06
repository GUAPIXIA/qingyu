import { McpClient } from './client'
import type { McpServerConfig, McpTool, McpToolResult, McpServerStatus } from '../../shared/types'
import { DIRS, readJson, writeJson } from '../services/storage'
import { join } from 'node:path'
import { nanoid } from 'nanoid'
import { createLogger } from '../services/logger'

const log = createLogger('mcp')
const CONFIG_FILE = join(DIRS.config(), 'mcp-servers.json')

// ===================== MCP server 配置安全校验 =====================
// N2 修复：mcp:addServer / mcp:updateServer 曾接受任意 command/args/env 直接 spawn，
// 恶意配置可执行任意命令。此处增加解释器黑名单、内联执行参数、相对路径、
// 危险环境变量与长度限制，降低"渲染层被诱导添加恶意配置"的 RCE 风险。
const BLOCKED_INTERPRETER_RE = /(^|[\\/])(cmd(\.exe)?|powershell(\.exe)?|pwsh(\.exe)?|bash|sh|zsh|dash|ksh|fish|node|nodejs|python|python[0-9.]*|deno|bun|perl|ruby|php|wscript|cscript|mshta)(\.exe)?$/i
const BLOCKED_INLINE_ARGS = new Set(['-c', '/c', '-command', '-e', '-eval', '-execute', '-enc', '-encodedcommand', '--eval', '-k'])
const BLOCKED_ENV_KEYS = new Set(['LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'NODE_OPTIONS', 'NODE_PATH', 'PYTHONPATH', 'PERL5LIB', 'RUBYLIB', 'PYTHONSTARTUP', 'BASH_ENV', 'ENV'])

function validateCommand(command: unknown): void {
  if (typeof command !== 'string' || command.trim() === '') {
    throw new Error('MCP server 命令不能为空')
  }
  if (command.length > 512) {
    throw new Error('MCP server 命令过长（>512 字符）')
  }
  if (BLOCKED_INTERPRETER_RE.test(command)) {
    throw new Error(`MCP server 命令不允许使用解释器: ${command}`)
  }
  // 含路径分隔符时必须为绝对路径（防止 ./evil.sh / ..\x 等相对路径）
  if ((command.includes('/') || command.includes('\\')) && !command.startsWith('/') && !/^[a-zA-Z]:[\\/]/.test(command)) {
    throw new Error('MCP server 命令含路径时必须为绝对路径')
  }
}

function validateArgs(args: unknown): void {
  if (args === undefined) return
  if (!Array.isArray(args) || args.length > 32) {
    throw new Error('MCP server args 必须为数组且不超过 32 项')
  }
  for (const a of args) {
    if (typeof a !== 'string') throw new Error('MCP server args 必须全部为字符串')
    if (a.length > 1024) throw new Error('MCP server 参数过长（>1024 字符）')
    if (BLOCKED_INLINE_ARGS.has(a.toLowerCase())) {
      throw new Error(`MCP server 参数不允许内联执行: ${a}`)
    }
  }
}

function validateEnv(env: unknown): void {
  if (env === undefined) return
  if (typeof env !== 'object' || env === null || Array.isArray(env)) {
    throw new Error('MCP server env 必须为对象')
  }
  const entries = Object.entries(env as Record<string, unknown>)
  if (entries.length > 32) throw new Error('MCP server env 条目过多（>32）')
  for (const [k, v] of entries) {
    if (k.length > 128 || typeof v !== 'string' || v.length > 1024) {
      throw new Error('MCP server env 键/值过长')
    }
    if (BLOCKED_ENV_KEYS.has(k.toUpperCase())) {
      throw new Error(`MCP server env 不允许设置 ${k}`)
    }
  }
}

/** 校验 MCP server 配置（新增与更新均需通过，只校验出现的字段） */
export function validateServerConfig(config: Partial<McpServerConfig>): void {
  if (config.name !== undefined && (typeof config.name !== 'string' || config.name.length === 0 || config.name.length > 100)) {
    throw new Error('MCP server 名称无效')
  }
  if (config.transport !== undefined && config.transport !== 'stdio' && config.transport !== 'sse') {
    throw new Error('MCP server transport 无效')
  }
  if (config.command !== undefined) validateCommand(config.command)
  if (config.args !== undefined) validateArgs(config.args)
  if (config.env !== undefined) validateEnv(config.env)
  if (config.url !== undefined && (typeof config.url !== 'string' || !/^https?:\/\//.test(config.url))) {
    throw new Error('MCP server URL 必须是 http(s) 链接')
  }
}

class McpManager {
  private clients = new Map<string, McpClient>()
  private configs: McpServerConfig[] = []
  /** N24 修复：正在启动中的 server id（并发 start 去重） */
  private starting = new Set<string>()

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
    validateServerConfig(config)
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
    validateServerConfig(patch)
    const idx = this.configs.findIndex(s => s.id === id)
    if (idx < 0) return
    const wasRunning = this.clients.has(id)
    this.configs[idx] = { ...this.configs[idx], ...patch }
    this.saveConfigs()
    // 如果配置变化且正在运行，重启
    if (wasRunning) {
      this.restartServer(id).catch((e) => log.error('Server 重启失败', { error: (e as Error).message }))
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
    // N24 修复：并发启动去重（避免同一 server 被并发 start 时重复 spawn）
    if (this.starting.has(id)) return
    if (this.clients.has(id) && this.clients.get(id)!.isConnected()) return
    if (this.clients.has(id)) {
      await this.stopServer(id)
    }
    this.starting.add(id)
    try {
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
    } finally {
      this.starting.delete(id)
    }
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
  async callTool(serverId: string, toolName: string, args: Record<string, unknown>): Promise<McpToolResult> {
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
    // 修复：allSettled 避免单个 server 关闭失败阻塞/影响其他 server
    await Promise.allSettled(ids.map(id => this.stopServer(id)))
  }

  private saveConfigs() {
    writeJson(CONFIG_FILE, this.configs)
  }
}

export const mcpManager = new McpManager()
