/**
 * V12-08 ToolGate：MCP 工具授权门（实施方案 §4.1 L0-L3）
 *
 * - L0 明确无副作用（time/math）自动允许
 * - L1/L2/L3 逐次确认，经 dialog.showMessageBox
 * - waiting_approval 超时默认拒绝（60s）
 * - 仅保留脱敏预览，不写完整敏感参数到日志
 */
import { classifyToolRisk, requestToolPermission } from '../mcp/toolPermission'
import type { TaskSnapshot } from '../../shared/chat-core/events'

export type GateDecision = 'allow' | 'deny' | 'timeout'

export async function authorizeTool(
  input: { serverName: string; toolName: string; description?: string; args: Record<string, unknown> },
  task: TaskSnapshot,
  timeoutMs = 60_000,
): Promise<GateDecision> {
  const risk = classifyToolRisk(input.toolName, input.description)
  if (risk === 'L0') return 'allow'

  // 带超时的授权（防止 waiting_approval 永久挂起）
  const decision = await Promise.race<GateDecision>([
    requestToolPermission(input).then((ok) => (ok ? 'allow' : 'deny') as GateDecision),
    new Promise<GateDecision>((resolve) => setTimeout(() => resolve('timeout'), timeoutMs)),
  ])

  if (decision === 'timeout') return 'deny'
  return decision
}
