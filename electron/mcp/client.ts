/* eslint-disable @typescript-eslint/no-explicit-any */
import { spawn, ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import type { McpTool, McpToolResult, McpServerConfig } from './types'
import { createLogger } from '../services/logger'

const log = createLogger('mcp-client')

/**
 * MCP 客户端：与单个 MCP server 通信
 * 实现 JSON-RPC 2.0 over stdio
 * 协议参考：https://spec.modelcontextprotocol.io/
 */
export class McpClient extends EventEmitter {
  private process: ChildProcess | null = null
  private requestId = 0
  private pendingRequests = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>()
  private tools: McpTool[] = []
  private initialized = false

  constructor(private config: McpServerConfig) {
    super()
  }

  async connect(): Promise<void> {
    if (this.initialized) return
    if (this.config.transport === 'stdio') {
      if (!this.config.command) throw new Error('stdio 模式需要 command')
      this.process = spawn(this.config.command, this.config.args ?? [], {
        env: { ...process.env, ...this.config.env },
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
      })
      this.setupStdioHandlers()
    } else {
      throw new Error('SSE transport 暂未实现')
    }

    // 初始化握手
    try {
      await this.sendRequest('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: '轻Tavern', version: '0.2.0' },
      }, 10000)
      await this.sendNotification('notifications/initialized', {})
      // 加载工具列表
      const result = await this.sendRequest('tools/list', {}, 10000)
      this.tools = (result.tools ?? []).map((t: any) => ({ ...t, serverId: this.config.id }))
      this.initialized = true
      this.emit('connected')
      log.info(`MCP server ${this.config.name} 已连接，工具数: ${this.tools.length}`)
    } catch (err) {
      this.cleanup()
      throw err
    }
  }

  private setupStdioHandlers() {
    if (!this.process) return
    let buffer = ''
    this.process.stdout?.on('data', (chunk) => {
      buffer += chunk.toString()
      // JSON-RPC 消息以换行分隔
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const msg = JSON.parse(line)
          this.handleMessage(msg)
        } catch { /* 忽略非 JSON */ }
      }
    })
    this.process.stderr?.on('data', (chunk) => {
      this.emit('log', chunk.toString())
    })
    this.process.on('error', (err) => {
      log.error(`MCP server ${this.config.name} 进程错误`, { error: err.message })
      this.emit('error', err)
    })
    this.process.on('exit', (code) => {
      log.info(`MCP server ${this.config.name} 退出，code=${code}`)
      this.initialized = false
      this.emit('disconnected', code)
    })
  }

  private handleMessage(msg: any) {
    if (msg.id !== undefined && this.pendingRequests.has(msg.id)) {
      const { resolve, reject, timer } = this.pendingRequests.get(msg.id)!
      this.pendingRequests.delete(msg.id)
      clearTimeout(timer)
      if (msg.error) reject(new Error(msg.error.message ?? 'Unknown error'))
      else resolve(msg.result)
    }
    if (msg.method === 'notifications/tools/list_changed') {
      this.refreshTools().catch(() => {})
    }
  }

  private sendRequest(method: string, params: any, timeoutMs = 30000): Promise<any> {
    const id = ++this.requestId
    const msg = { jsonrpc: '2.0', id, method, params }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id)
          reject(new Error(`请求超时: ${method}`))
        }
      }, timeoutMs)
      this.pendingRequests.set(id, { resolve, reject, timer })
      try {
        this.process?.stdin?.write(JSON.stringify(msg) + '\n')
      } catch (err) {
        clearTimeout(timer)
        this.pendingRequests.delete(id)
        reject(new Error(`写入失败: ${(err as Error).message}`))
      }
    })
  }

  private sendNotification(method: string, params: any): Promise<void> {
    const msg = { jsonrpc: '2.0', method, params }
    return new Promise((resolve, reject) => {
      try {
        this.process?.stdin?.write(JSON.stringify(msg) + '\n')
        resolve()
      } catch (err) {
        reject(new Error(`写入失败: ${(err as Error).message}`))
      }
    })
  }

  async callTool(name: string, args: Record<string, any>): Promise<McpToolResult> {
    if (!this.initialized) throw new Error('Server 未连接')
    const result = await this.sendRequest('tools/call', { name, arguments: args }, 60000)
    return result as McpToolResult
  }

  getTools(): McpTool[] {
    return this.tools
  }

  private async refreshTools() {
    try {
      const result = await this.sendRequest('tools/list', {}, 10000)
      this.tools = (result.tools ?? []).map((t: any) => ({ ...t, serverId: this.config.id }))
      this.emit('toolsChanged')
    } catch (err) {
      log.warn(`刷新工具列表失败: ${(err as Error).message}`)
    }
  }

  private cleanup() {
    if (this.process) {
      try { this.process.kill() } catch { /* ignore */ }
      this.process = null
    }
    // 拒绝所有 pending 请求
    for (const { reject, timer } of this.pendingRequests.values()) {
      clearTimeout(timer)
      reject(new Error('连接已断开'))
    }
    this.pendingRequests.clear()
    this.initialized = false
  }

  async disconnect() {
    this.cleanup()
  }

  isConnected() {
    return this.initialized
  }
}
