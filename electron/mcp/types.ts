/* eslint-disable @typescript-eslint/no-explicit-any */

/** MCP 工具定义 */
export interface McpTool {
  serverId: string
  name: string
  description: string
  inputSchema: {
    type: 'object'
    properties: Record<string, {
      type: string
      description?: string
      enum?: string[]
    }>
    required?: string[]
  }
}

/** MCP Server 配置 */
export interface McpServerConfig {
  id: string
  name: string
  /** 传输方式 */
  transport: 'stdio' | 'sse'
  /** stdio: 命令和参数；sse: URL */
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  /** 是否启用 */
  enabled: boolean
  /** 自动启动 */
  autoStart: boolean
}

/** MCP 调用结果 */
export interface McpToolResult {
  content: Array<{
    type: 'text' | 'image' | 'resource'
    text?: string
    data?: string  // base64
    mimeType?: string
  }>
  isError?: boolean
}

/** Server 状态信息 */
export interface McpServerStatus {
  id: string
  connected: boolean
  toolCount: number
  lastError?: string
}
