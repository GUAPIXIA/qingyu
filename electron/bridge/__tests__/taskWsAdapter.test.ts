/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck
import { describe, it, expect } from 'vitest'
import { attachTaskWsAdapter, handleTaskSubscribe } from '../taskWsAdapter'

function makeHub() {
  const clients = new Set<object>()
  const broadcasts: Array<{ event: string; payload: unknown }> = []
  const hub = {
    clients,
    broadcast(event: string, payload?: unknown) {
      broadcasts.push({ event, payload })
    },
  } as unknown as import('../ws').WsHub & { clients: Set<object>; _broadcasts: typeof broadcasts }
  ;(hub as unknown as { _broadcasts: typeof broadcasts })._broadcasts = broadcasts
  return { hub, clients, broadcasts }
}

describe('taskWsAdapter', () => {
  it('非 task 事件走 rawBroadcast', () => {
    const { hub, broadcasts } = makeHub()
    attachTaskWsAdapter(hub)
    hub.broadcast('session:updated', { sessionId: 's1' })
    expect(broadcasts.length).toBe(1)
    expect(broadcasts[0].event).toBe('session:updated')
  })

  it('task 事件按订阅定向推送', () => {
    const { hub, clients } = makeHub()
    attachTaskWsAdapter(hub)
    const sends: string[] = []
    const sockA: unknown = { send: (s: string) => sends.push('A:' + s), readyState: 1 }
    const sockB: unknown = { send: (s: string) => sends.push('B:' + s), readyState: 1 }
    clients.add(sockA as object)
    clients.add(sockB as object)
    handleTaskSubscribe(sockA as object, { sessionIds: ['s1'], cursors: { 'task-1': 0 } }, hub)
    handleTaskSubscribe(sockB as object, { sessionIds: ['s2'], cursors: {} }, hub)
    hub.broadcast('task:chunk', { taskId: 'task-1', sessionId: 's1', delta: 'hi' })
    expect(sends.length).toBe(1)
    expect(sends[0]).toContain('s1')
    // 未订阅的 s2 不应收到 s1 的事件
    hub.broadcast('task:chunk', { taskId: 'task-2', sessionId: 's2', delta: 'hi2' })
    expect(sends.length).toBe(2)
    expect(sends[1]).toContain('s2')
  })

  it('未订阅的客户端不收到定向事件', () => {
    const { hub, clients } = makeHub()
    attachTaskWsAdapter(hub)
    const sends: string[] = []
    const sock: unknown = { send: (s: string) => sends.push(s), readyState: 1 }
    clients.add(sock as object)
    // 不调用 handleTaskSubscribe
    hub.broadcast('task:chunk', { taskId: 't1', sessionId: 's1', delta: 'x' })
    expect(sends.length).toBe(0)
  })

  it('handleTaskSubscribe 无 hub 附着时安全返回', () => {
    const { hub } = makeHub()
    // 未 attach
    expect(() => handleTaskSubscribe({}, { sessionIds: ['s1'] }, hub)).not.toThrow()
  })

  it('task 事件缺 sessionId 走 rawBroadcast', () => {
    const { hub, broadcasts } = makeHub()
    attachTaskWsAdapter(hub)
    hub.broadcast('task:chunk', { taskId: 't1' } as unknown as { sessionId: string })
    expect(broadcasts.length).toBe(1)
  })
})
