import type { RelayRpcRequestPayload, RelayRpcResponsePayload } from '../../shared/relayProtocol'
import type { MobileFacade } from '../bridge/runtime/mobileFacade'
import { safeId } from '../utils/pathGuard'

type Match = { operation: 'serverInfo' | 'characters' | 'sessions' | 'messages' | 'send' | 'swipe' | 'translate' | 'settings'; sessionId?: string }

function withoutUnsupportedMedia(message: Record<string, unknown>): Record<string, unknown> {
  const images = Array.isArray(message.images) ? message.images : []
  return images.length ? { ...message, images: [], mediaUnavailable: true } : message
}

export function matchRelayRpc(method: string, path: string): Match | null {
  if (!path.startsWith('/') || /%2f|%5c|\.\.|\/\//i.test(path)) return null
  let decoded: string
  try { decoded = decodeURIComponent(path) } catch { return null }
  if (method === 'GET' && decoded === '/api/v1/server/info') return { operation: 'serverInfo' }
  if (method === 'GET' && decoded === '/api/v1/characters') return { operation: 'characters' }
  if (method === 'GET' && decoded === '/api/v1/sessions') return { operation: 'sessions' }
  if (method === 'GET' && decoded === '/api/v1/settings/snapshot') return { operation: 'settings' }
  const match = decoded.match(/^\/api\/v1\/sessions\/([^/]+)\/(messages|swipe|translate)$/)
  if (!match) return null
  const sessionId = safeId(match[1]!)
  if (match[2] === 'messages') return { operation: method === 'GET' ? 'messages' : method === 'POST' ? 'send' : 'messages', sessionId }
  if (match[2] === 'swipe' && method === 'POST') return { operation: 'swipe', sessionId }
  if (match[2] === 'translate' && method === 'POST') return { operation: 'translate', sessionId }
  return null
}

export class RelayRpcDispatcher {
  constructor(private readonly facade: MobileFacade) {}
  async dispatch(request: RelayRpcRequestPayload): Promise<RelayRpcResponsePayload> {
    if (request.deadlineAt <= Date.now()) return this.error(504, 'RPC_TIMEOUT', 'Relay 请求已超时')
    const route = matchRelayRpc(request.method, request.path)
    if (!route) return this.error(404, 'RESOURCE_NOT_FOUND', '内容不存在')
    const query = request.query
    const one = (name: string) => Array.isArray(query[name]) ? query[name]![0] : query[name]
    const context = { requestId: request.commandId, sourceDeviceId: request.sourceDeviceId }
    try {
      let body: unknown
      if (route.operation === 'serverInfo') body = await this.facade.serverInfo()
      else if (route.operation === 'characters') body = await this.facade.listCharacters()
      else if (route.operation === 'sessions') body = await this.facade.listSessions()
      else if (route.operation === 'settings') body = await this.facade.settingsSnapshot()
      else if (route.operation === 'messages') {
        const page = await this.facade.listMessages({ sessionId: route.sessionId!, characterId: one('characterId'), beforeId: one('beforeId'), limit: Number(one('limit')) || undefined })
        body = { ...page, messages: page.messages.map(withoutUnsupportedMedia) }
      }
      else if (route.operation === 'send') {
        const input = request.body as { content?: string; replyToId?: string; images?: string[] }
        if (!input || typeof input.content !== 'string' || !input.content.trim()) return this.error(400, 'INVALID_REQUEST', '缺少 content')
        if (input.images?.length) return this.error(415, 'MEDIA_UNSUPPORTED', '服务器连接暂不支持发送媒体')
        body = withoutUnsupportedMedia(await this.facade.sendMessage({ sessionId: route.sessionId!, content: input.content.trim(), replyToId: input.replyToId, images: [] }, context))
      } else if (route.operation === 'swipe') body = withoutUnsupportedMedia(await this.facade.swipe({ sessionId: route.sessionId!, messageId: safeId(one('messageId') ?? ''), direction: Number(one('direction')) || 0 }, context))
      else body = await this.facade.translate({ sessionId: route.sessionId!, messageId: safeId(one('messageId') ?? '') }, context)
      return { status: 200, headers: { 'content-type': 'application/json' }, body }
    } catch (error) { return this.error(500, 'PC_ERROR', (error as Error).message) }
  }
  async cancel(requestId: string, sourceDeviceId?: string): Promise<void> { await this.facade.stop(requestId, { requestId, sourceDeviceId }) }
  private error(status: number, code: string, message: string): RelayRpcResponsePayload { return { status, headers: { 'content-type': 'application/json' }, body: { error: { code, message, retryable: status >= 500 } } } }
}
