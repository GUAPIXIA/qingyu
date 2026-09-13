/**
 * Relay 统一错误响应（R3）。
 *
 * `{ error: { code, message, retryable, requestId } }` 这一协议形状此前在
 * app / pairingRoutes / spaceRoutes / bridgeRoutes / auth middleware 多处手抄，
 * 收敛为单一构造点，避免同一类错误在不同路由漂移。
 */
import type { FastifyReply } from 'fastify'

/** relay 协议错误响应体 */
export interface RelayErrorBody {
  error: { code: string; message: string; retryable: boolean; requestId: string }
}

/** 按 relay 协议 error 形状回包；requestId 用于端到端排查 */
export function sendRelayError(
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
  requestId: string,
  retryable = false,
): FastifyReply {
  return reply.code(status).send({ error: { code, message, retryable, requestId } })
}

/** 404 内容不存在（与 app.ts notFoundHandler 同一形状） */
export function notFound(reply: FastifyReply, requestId: string): FastifyReply {
  return sendRelayError(reply, 404, 'RESOURCE_NOT_FOUND', '内容不存在', requestId)
}

/** 401 访问令牌无效/过期 */
export function invalidToken(reply: FastifyReply, requestId: string): FastifyReply {
  return sendRelayError(reply, 401, 'INVALID_TOKEN', '登录已失效，请重新连接', requestId)
}

/** 401 刷新凭据失效 */
export function invalidCredential(reply: FastifyReply, requestId: string): FastifyReply {
  return sendRelayError(reply, 401, 'INVALID_TOKEN', '凭据已失效', requestId)
}

/** 401 配对连接码无效或过期 */
export function invalidTicket(reply: FastifyReply, requestId: string): FastifyReply {
  return sendRelayError(reply, 401, 'PAIR_TICKET_INVALID', '连接码无效或已过期', requestId)
}

/** 429 限流（带 retry-after 秒数） */
export function rateLimited(reply: FastifyReply, requestId: string, retryAfterSeconds: number): FastifyReply {
  return sendRelayError(reply.header('retry-after', String(retryAfterSeconds)), 429, 'RATE_LIMITED', '请稍后再试', requestId, true)
}
