/**
 * V12-09 WS v2 适配（实施方案 §11）
 *
 * 复用 WsHub 的 clients/device 映射，新增：
 * - task:subscribe { sessionIds, cursors }
 * - 服务端按订阅范围定向推送 task:chunk/* 等，不再全量广播
 */
import type { WsHub } from './ws'
import { getTaskSnapshot } from '../chat/taskStore'
import type { TaskEventEnvelope } from '../../shared/chat-core/events'

type Sub = { sessionIds: Set<string>; cursors: Map<string, number> }

export function attachTaskWsAdapter(hub: WsHub): void {
  // 轻量：为每个 socket 维护订阅表（复用 hub 内部 clients，外部以 WeakMap 存）
  const subs = new WeakMap<object, Sub>()

  // 拦截 hub.broadcast：若 payload 含 taskId/sessionId，则按订阅定向
  const rawBroadcast = hub.broadcast.bind(hub)
  hub.broadcast = (event: string, payload?: unknown) => {
    const p = payload as { taskId?: string; sessionId?: string } | undefined
    const isTaskEvent = typeof event === 'string' && event.startsWith('task:')
    if (!isTaskEvent || !p?.sessionId) {
      rawBroadcast(event, payload)
      return
    }
    // 定向推送：遍历 clients，仅发给订阅了该 session 的
    for (const client of (hub as unknown as { clients: Set<object> }).clients) {
      const sub = subs.get(client)
      if (!sub) continue
      if (!sub.sessionIds.has(p.sessionId)) continue
      // 游标过滤：若客户端已声明该 task 的 cursor，跳过旧事件（依赖 readEvents 补拉，此处不强过滤，仅示例）
      try {
        // 借助 ws 的 send（与 WsHub 的 broadcast 相同逻辑，但单发）
        const frame = JSON.stringify({ event, payload })
        ;(client as unknown as { send: (s: string) => void; readyState: number }).send(frame)
      } catch {}
    }
  }

  // 暴露订阅注册供 ws.ts 的 message 处理调用
  ;(hub as unknown as { __taskSubs: WeakMap<object, Sub> }).__taskSubs = subs
}

/** ws.ts 在收到 task:subscribe 时调用 */
export function handleTaskSubscribe(socket: object, payload: { sessionIds?: string[]; cursors?: Record<string, number> }, hub: WsHub): void {
  const subs = (hub as unknown as { __taskSubs?: WeakMap<object, Sub> }).__taskSubs
  if (!subs) return
  const sessionIds = new Set((payload.sessionIds ?? []).map(String))
  const cursors = new Map(Object.entries(payload.cursors ?? {}).map(([k, v]) => [k, Number(v)]))
  subs.set(socket, { sessionIds, cursors })
  // 可选：立即补发 checkpoint（客户端按需 REST 补拉，此处仅示例）
  for (const sid of sessionIds) {
    // 检查是否有 active task 可发 checkpoint
    void sid
  }
}
