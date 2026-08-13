/**
 * MCP 页面共享类型（P-8 从 McpPage 拆分）
 */

/** MCP Server 配置 */
export interface McpServerConfig {
  id: string
  name: string
  transport: 'stdio' | 'sse'
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  enabled: boolean
  autoStart: boolean
}

/** MCP Server 运行状态 */
export interface McpServerStatus {
  id: string
  connected: boolean
  toolCount: number
  lastError?: string
}

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

/** 编辑表单临时状态 */
export interface ServerForm {
  name: string
  transport: 'stdio' | 'sse'
  command: string
  args: string // 逗号分隔
  env: string // 每行 KEY=value
  url: string
  autoStart: boolean
}

export const EMPTY_FORM: ServerForm = {
  name: '',
  transport: 'stdio',
  command: '',
  args: '',
  env: '',
  url: '',
  autoStart: true,
}
