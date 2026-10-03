import { createHash, randomUUID } from 'node:crypto'
import type { ChatParams } from '../../../shared/types'

/** OpenCode Go/Zen 按对话路由；仅向官方主机发送会话标识。 */
export function openCodeHeaders(
  baseUrl: string,
  params?: Pick<ChatParams, 'sessionId' | 'observability' | 'requestId'>,
): Record<string, string> {
  try {
    if (new URL(baseUrl).hostname !== 'opencode.ai') return {}
  } catch {
    return {}
  }

  const feature = params?.observability?.featureTask
  // 一次性功能任务独立于主对话路由；其物理重试仍归同一任务。
  // 哈希只公开稳定标识，不把 owner 内容放进供应商请求头。
  const featureRoute = feature
    ? `feature-${createHash('sha256').update(`${feature.logicalSessionId}:${feature.taskId}`).digest('hex')}`
    : params?.observability?.source === 'aux'
      ? `aux-${createHash('sha256').update(params.requestId).digest('hex')}`
      : undefined
  const sessionId = featureRoute || params?.sessionId?.trim()
    || params?.observability?.sessionId?.trim()
    || params?.requestId?.trim()
    || randomUUID()
  return { 'x-opencode-session': sessionId, 'User-Agent': 'qingyu' }
}
