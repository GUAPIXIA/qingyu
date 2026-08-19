import { dialog } from 'electron'
import { createLogger } from '../services/logger'

const log = createLogger('mcp-permission')

export type ToolRiskLevel = 'L0' | 'L1' | 'L2' | 'L3'

export function classifyToolRisk(name: string, description = ''): ToolRiskLevel {
  const value = `${name} ${description}`.toLowerCase()
  if (/shell|exec|process|terminal|delete|remove|write[_ -]?file|filesystem/.test(value)) return 'L3'
  if (/send|post|create|update|modify|upload|publish|message|task/.test(value)) return 'L2'
  if (/time|date|math|calculate|calculator/.test(value)) return 'L0'
  return 'L1'
}

/** MCP 模型工具调用的主进程确认门；仅 L0 明确无副作用工具可自动执行。 */
export async function requestToolPermission(input: {
  serverName: string
  toolName: string
  description?: string
  args: Record<string, unknown>
}): Promise<boolean> {
  const risk = classifyToolRisk(input.toolName, input.description)
  if (risk === 'L0') {
    log.info('自动允许无副作用工具', { server: input.serverName, tool: input.toolName, risk })
    return true
  }
  const detail = JSON.stringify(input.args, null, 2)
  const result = await dialog.showMessageBox({
    type: 'warning',
    title: 'MCP 工具调用确认',
    message: `${input.serverName} 请求执行 ${input.toolName}`,
    detail: `风险等级：${risk}\n\n完整参数：\n${detail}`,
    buttons: ['拒绝', '仅本次允许'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  })
  const allowed = result.response === 1
  log.info('MCP 工具授权决定', { server: input.serverName, tool: input.toolName, risk, allowed })
  return allowed
}
